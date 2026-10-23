"""
engines/uc1/arm.py
==================
UC1 - Association Rule Mining (FP-Growth) stage.

Called by engines/run_all.py, which expects run() -> StageResult.

What it mines
-------------
HOSPITAL REQUESTS, not CW -> SW orders. Each row of stocktransfer is one
request a hospital made to its subsidiary warehouse (SW); its lines in
stocktransferline are the products it asked for. One request = one basket.

Why not orders: once UC2 places the CW -> SW orders, an order basket only
says "these SKUs hit their reorder point on the same day" -- mining it would
rediscover UC2's own behaviour (a self-fulfilling loop). Hospital requests
are real demand, which UC2 cannot influence.

Flow
----
1. Read the request lines ONCE (stocktransfer JOIN stocktransferline),
   keeping the SW each request came from, limited to the most recent
   LOOKBACK_DAYS of data.
2. Mine the GLOBAL scope (all SWs together) -> stored under WH001, used
   as the network-wide label.
3. Mine EACH SW separately -> stored under its own WHnnn id.
4. Write everything in ONE transaction: insert the modelrun, then for
   each scope delete that label's old rules (antecedents cascade) and
   bulk-insert the new ones.

Metrics note: support/confidence/lift are relative to the baskets they
were mined from. A WH002 rule's support is the fraction of WH002's
requests. Compare evidence volume via ordercount (= number of requests
mined), not support.

Scale note: with ~2,000 products and ~12 lines per request, even a strong
pair is on well under 1% of requests, and a weak one has single-digit
confidence. Thresholds below are set for that. Strength is graded on lift
and confidence, not support.

Connection (backend only, NEVER in client/):
    DATABASE_URL in .env.local  (same as the other engines), or the older
    SUPABASE_DB_HOST / _PORT / _NAME / _USER / _PASSWORD variables.
    This stage DELETES and rewrites productrelationship, so check which
    database .env.local points at before running it.
"""

from __future__ import annotations

import inspect
import os
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from mlxtend.frequent_patterns import association_rules, fpgrowth
from scipy.sparse import csr_matrix

# arm.py -> uc1 -> engines -> FYP_Medflow (repo root for this project)
ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env.local"

loaded = load_dotenv(ENV_FILE, override=True)
if not loaded:
    raise FileNotFoundError(f".env.local not found or empty at: {ENV_FILE}")

from engines.result import StageResult  # noqa: E402


# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------
CENTRAL_WAREHOUSE_ID = "WH001"   # label for the AGGREGATED (network) rule set
LOOKBACK_DAYS = 90               # most recent N days of requests; None = all history

# Thresholds (team research, Oct 2026): Dewi, Utami & Dharma (2025) and Kamsu-Foguem,
# Rigal & Mauget (2016) for support 0.02 / confidence 0.50; Wang et al. (2012) and Lai et al.
# (2022) for lift 1.2. These are the GATES every rule must pass. Strength is then graded by
# confidence (reliability) and support (popularity); lift stays a gate, not a ranking factor.
# The same gates and bands are in scripts/sim/sim_config.json (bundles.bands) and are what the
# simulator's planted bundles are sized to, so score_uc1 can check UC1 against ground truth.
MIN_SUPPORT_MINE = 0.02          # minimum itemset support for FP-Growth
BASELINE_SUPPORT = 0.02          # rule support >= 0.02
BASELINE_CONFIDENCE = 0.50       # confidence >= 0.50
BASELINE_LIFT = 1.20             # lift >= 1.20 (not a coincidence)
MIN_PAIR_COUNT = 20              # a rule needs at least this many requests with all its items
MAX_ITEMSET_LEN = 4              # itemsets of up to 4 products (rules with 1-3 antecedents)

# Strength bands: Strong = confidence >= 0.70 and support >= 0.05; Moderate = confidence >= 0.60
# and support >= 0.03; Weak = passes the gates only.
STRONG_BAND = (0.70, 0.05)       # (min confidence, min support)
MODERATE_BAND = (0.60, 0.03)

RULE_SOURCE = "FP-GROWTH"
RUN_TYPE = "Association Rule Mining"
ALGORITHM_VERSION = "FP-GROWTH-3.0-gated"
INSERT_PAGE = 1000               # bulk-insert chunk size
FETCH_CHUNK = 200_000            # rows per fetch from the database


# ------------------------------------------------------------------
# Connection
# ------------------------------------------------------------------
def get_connection():
    dsn = (os.getenv("DATABASE_URL") or "").strip()
    if dsn:
        return psycopg2.connect(dsn)
    return psycopg2.connect(
        host=os.environ["SUPABASE_DB_HOST"],
        port=os.environ.get("SUPABASE_DB_PORT", "6543"),
        dbname=os.environ.get("SUPABASE_DB_NAME", "postgres"),
        user=os.environ["SUPABASE_DB_USER"],
        password=os.environ["SUPABASE_DB_PASSWORD"],
        sslmode="require",
    )


# ------------------------------------------------------------------
# 1. Extract (one query, SW retained for partitioning)
# ------------------------------------------------------------------
def load_transactions(conn, source_warehouse_id=None, lookback_days=LOOKBACK_DAYS):
    """
    Return [orderid, productid, warehouseid] -- one row per request line.

    orderid     = stocktransfer.transferid (the basket; name kept so the
                  rest of the pipeline is unchanged)
    warehouseid = the SW that served the request

    The lookback window is counted back from the LATEST request in the
    table, not from today, so simulated data with a fixed end date works.
    source_warehouse_id restricts to a single SW (manual debug run).
    """
    sql = """
        SELECT l.transferid, l.productid, t.sourcewarehouseid
        FROM stocktransferline l
        JOIN stocktransfer t USING (transferid)
    """
    where, params = [], []
    if source_warehouse_id is not None:
        where.append("t.sourcewarehouseid = %s")
        params.append(source_warehouse_id)
    if lookback_days is not None:
        where.append("t.transferdate > (SELECT max(transferdate) FROM stocktransfer)"
                     " - %s * interval '1 day'")
        params.append(int(lookback_days))
    if where:
        sql += " WHERE " + " AND ".join(where)

    cols = ["orderid", "productid", "warehouseid"]
    chunks = []
    # server-side cursor: stream the rows instead of holding them all twice
    with conn.cursor(name="uc1_lines") as cur:
        cur.itersize = FETCH_CHUNK
        cur.execute(sql, params)
        while True:
            rows = cur.fetchmany(FETCH_CHUNK)
            if not rows:
                break
            chunks.append(pd.DataFrame(rows, columns=cols).astype("category"))
    if not chunks:
        return pd.DataFrame(columns=cols)
    txns = pd.concat(chunks, ignore_index=True)
    return txns.astype(str).astype("category") if len(chunks) > 1 else txns


# ------------------------------------------------------------------
# 2. Baskets + mine + classify
# ------------------------------------------------------------------
def build_basket_matrix(txns):
    """
    Sparse one-hot basket matrix (requests x products); drops requests with
    fewer than 2 products. Sparse because a dense 1.8M x 2,000 table would
    not fit in memory.
    """
    pairs = txns[["orderid", "productid"]].drop_duplicates()
    pairs = pairs[pairs.groupby("orderid", observed=True)["productid"].transform("size") >= 2]
    if pairs.empty:
        return pd.DataFrame()
    r = pairs["orderid"].astype(str).astype("category")
    c = pairs["productid"].astype(str).astype("category")
    m = csr_matrix((np.ones(len(pairs), dtype=bool), (r.cat.codes, c.cat.codes)),
                   shape=(len(r.cat.categories), len(c.cat.categories)))
    return pd.DataFrame.sparse.from_spmatrix(m, index=r.cat.categories,
                                             columns=list(c.cat.categories))


def _association_rules(frequent, n_baskets, min_lift):
    # mlxtend >= 0.23.2 wants the number of baskets; older versions don't take it
    if "num_itemsets" in inspect.signature(association_rules).parameters:
        return association_rules(frequent, num_itemsets=n_baskets,
                                 metric="lift", min_threshold=min_lift)
    return association_rules(frequent, metric="lift", min_threshold=min_lift)


def mine_rules(
    basket_matrix,
    min_support=MIN_SUPPORT_MINE,
    baseline_support=BASELINE_SUPPORT,
    baseline_confidence=BASELINE_CONFIDENCE,
    baseline_lift=BASELINE_LIFT,
    max_len=MAX_ITEMSET_LEN,
    min_pair_count=MIN_PAIR_COUNT,
):
    """
    FP-Growth + rule generation + baseline filter.

    Metrics are relative to the basket_matrix passed in, so the SAME
    function serves both the global scope and each per-warehouse scope.
    """
    if basket_matrix.empty:
        return pd.DataFrame()

    # never accept a rule seen on fewer than min_pair_count requests
    floor = min_pair_count / len(basket_matrix)
    min_support = max(min_support, floor)
    baseline_support = max(baseline_support, floor)

    frequent = fpgrowth(basket_matrix, min_support=min_support,
                        use_colnames=True, max_len=max_len)
    if frequent.empty or frequent["itemsets"].apply(len).max() < 2:
        return pd.DataFrame()

    rules = _association_rules(frequent, len(basket_matrix), baseline_lift)
    if rules.empty:
        return pd.DataFrame()

    return rules[
        (rules["support"] >= baseline_support)
        & (rules["confidence"] >= baseline_confidence)
        & (rules["lift"] >= baseline_lift)
        & (rules["consequents"].apply(len) == 1)   # schema: 1 consequent
    ].copy()


def classify(support, confidence, lift):
    """Strong / Moderate by confidence and support; Weak = passes the gates only. Lift is a gate."""
    if confidence >= STRONG_BAND[0] and support >= STRONG_BAND[1]:
        return "Strong"
    if confidence >= MODERATE_BAND[0] and support >= MODERATE_BAND[1]:
        return "Moderate"
    return "Weak"


# ------------------------------------------------------------------
# 3. Transform rules -> rows
# ------------------------------------------------------------------
def rules_to_rows(rules, warehouse_id, run_id, basket_count):
    pr_rows, ant_rows = [], []
    today = date.today()
    for _, r in rules.iterrows():
        antecedents = sorted(r["antecedents"])
        consequent = next(iter(r["consequents"]))
        rid = str(uuid.uuid4())
        pr_rows.append((
            rid, warehouse_id, consequent,
            len(antecedents) + 1,
            float(r["support"]), float(r["confidence"]), float(r["lift"]),
            classify(r["support"], r["confidence"], r["lift"]),
            int(basket_count), RULE_SOURCE, today, run_id,
        ))
        ant_rows.extend((rid, a) for a in antecedents)
    return pr_rows, ant_rows


def mine_scope(txns, label_warehouse_id, run_id):
    """
    Mine ONE population and shape it into database rows.

    Returns (label, pr_rows, ant_rows, request_count, basket_count).
    """
    request_count = int(txns["orderid"].nunique())
    baskets = build_basket_matrix(txns)

    if baskets.empty:
        return label_warehouse_id, [], [], request_count, 0

    rules = mine_rules(baskets)
    if rules.empty:
        return label_warehouse_id, [], [], request_count, len(baskets)

    pr_rows, ant_rows = rules_to_rows(rules, label_warehouse_id, run_id, len(baskets))
    return label_warehouse_id, pr_rows, ant_rows, request_count, len(baskets)


# ------------------------------------------------------------------
# 4. Load (all scopes in ONE transaction)
# ------------------------------------------------------------------
def write_all_scopes(conn, scopes, run_id):
    """
    One transaction for the whole refresh: insert the modelrun, then for
    every scope replace that label's rules. Either the entire refresh
    lands or none of it does.

    scopes: list of (label_warehouse_id, pr_rows, ant_rows)
    """
    with conn:                                   # transaction boundary
        with conn.cursor() as cur:
            # modelrun first: productrelationship.runid -> modelrun.runid
            cur.execute(
                "INSERT INTO modelrun "
                "(runid, runtype, generatedate, algorithmversion, "
                "parametersignature) "
                "VALUES (%s, %s, %s, %s, %s) "
                "ON CONFLICT (runid) DO NOTHING",
                (
                    run_id,
                    RUN_TYPE,
                    datetime.now(timezone.utc),
                    ALGORITHM_VERSION,
                    f"source=stocktransfer;lookback_days={LOOKBACK_DAYS};"
                    f"min_support={MIN_SUPPORT_MINE};"
                    f"support>={BASELINE_SUPPORT};"
                    f"confidence>={BASELINE_CONFIDENCE};"
                    f"lift>={BASELINE_LIFT};min_pair_count={MIN_PAIR_COUNT};"
                    f"max_len={MAX_ITEMSET_LEN};"
                    f"strong=conf>={STRONG_BAND[0]}&sup>={STRONG_BAND[1]};"
                    f"moderate=conf>={MODERATE_BAND[0]}&sup>={MODERATE_BAND[1]};"
                    f"scopes={len(scopes)}",
                ),
            )

            for label, pr_rows, ant_rows in scopes:
                # Replace this label's rules; antecedents cascade-delete.
                cur.execute(
                    "DELETE FROM productrelationship WHERE warehouseid = %s",
                    (label,),
                )

                if pr_rows:
                    psycopg2.extras.execute_values(
                        cur,
                        "INSERT INTO productrelationship ("
                        "relationshipid, warehouseid, consequent_productid, "
                        "itemsetsize, support, confidence, lift, strength, "
                        "ordercount, rulesource, lastupdated, runid) VALUES %s",
                        pr_rows, page_size=INSERT_PAGE,
                    )

                if ant_rows:
                    psycopg2.extras.execute_values(
                        cur,
                        "INSERT INTO productrelationshipantecedent ("
                        "relationshipid, antecedent_productid) VALUES %s",
                        ant_rows, page_size=INSERT_PAGE,
                    )


# ------------------------------------------------------------------
# Entry point (framework contract)
# ------------------------------------------------------------------
def run(source_warehouse_id=None):
    """
    Mine association rules for EVERY scope in a single run.

    Default (source_warehouse_id=None):
        - the network rule set across all SWs' hospital requests, stored
          under warehouseid = WH001
        - one rule set per SW, stored under its own WHnnn id

    source_warehouse_id="WHnnn" restricts the run to that single SW
    (manual debugging; the network rule set is not touched).
    """
    run_id = str(uuid.uuid4())
    conn = get_connection()

    try:
        txns = load_transactions(conn, source_warehouse_id=source_warehouse_id)

        if txns.empty:
            target = source_warehouse_id or "all warehouses"
            return StageResult(
                name="UC1",
                runid=run_id,
                status="failed",
                error=f"No hospital request lines found for {target} "
                      f"(stocktransfer / stocktransferline).",
            )

        total_requests = int(txns["orderid"].nunique())
        scopes, notes = [], []

        if source_warehouse_id is None:
            # Scope 1: the whole network, labelled WH001.
            scopes.append(mine_scope(txns, CENTRAL_WAREHOUSE_ID, run_id))
            print(f"  {CENTRAL_WAREHOUSE_ID} (network): {scopes[-1][4]:,} requests, "
                  f"{len(scopes[-1][1]):,} rules")

            # Scopes 2..n: one per SW.
            for wh, sub in txns.groupby("warehouseid", sort=True, observed=True):
                scopes.append(mine_scope(sub, str(wh), run_id))
                print(f"  {wh}: {scopes[-1][4]:,} requests, {len(scopes[-1][1]):,} rules")
        else:
            scopes.append(mine_scope(txns, source_warehouse_id, run_id))

        write_all_scopes(
            conn,
            [(label, pr, ant) for label, pr, ant, _, _ in scopes],
            run_id,
        )

        total_rules = sum(len(pr) for _, pr, _, _, _ in scopes)
        empty_scopes = [label for label, pr, _, _, _ in scopes if not pr]
        if empty_scopes:
            notes.append(
                f"{len(empty_scopes)} scope(s) produced no rules: "
                f"{', '.join(empty_scopes)}."
            )

        return StageResult(
            name="UC1",
            runid=run_id,
            status="success",
            input_rows=total_requests,
            output_rows=total_rules,
            error="; ".join(notes) or None,
        )
    finally:
        conn.close()


if __name__ == "__main__":
    #   python -m engines.uc1.arm            -> network + every SW
    #   python -m engines.uc1.arm WH002      -> that one SW only (debug)
    import sys

    src = sys.argv[1] if len(sys.argv) > 1 else None
    result = run(src)
    print(f"{result.name}: {result.status} runid={result.runid} "
          f"in={result.input_rows} out={result.output_rows}")
    if result.error:
        print(f"  {result.error}")
    raise SystemExit(0 if result.ok else 1)