"""
engines/uc1/arm.py
==================
UC1 - Association Rule Mining (FP-Growth) stage.

Called by engines/run_all.py, which expects run() -> StageResult.

Flow
----
1. Read every fulfilled order line ONCE (orders JOIN orderline), keeping
   orders.warehouseid so the population can be partitioned in memory.
2. Mine the GLOBAL scope (all orders) -> stored under WH001. This is the
   central warehouse's full picking history, used by UC3 slotting.
3. Mine EACH destination warehouse separately -> stored under its own
   WHnnn id. Used by UC2 for site-level companion SKUs and by the
   frontend warehouse dropdown.
4. Write everything in ONE transaction: insert the modelrun, then for
   each scope delete that label's old rules (antecedents cascade) and
   bulk-insert the new ones.

Metrics note: support/confidence/lift are always relative to the basket
population they were mined from. A WH002 rule's support is the fraction
of WH002's orders, not of all orders - that is the correct reading for a
per-site rule. Compare evidence volume via ordercount, not support.

IMPORTANT: orders.warehouseid is the DESTINATION (where stock is going
TO). WH001 is the central warehouse and is always the SOURCE, so no
order ever carries warehouseid = 'WH001'. WH001 is therefore used purely
as the LABEL for the aggregated rule set.

Connection (env vars; backend only, NEVER in client/):
    SUPABASE_DB_HOST      <ref>.supabase.co  (or the pooler host)
    SUPABASE_DB_PORT      5432               (direct) / 6543 (pooler)
    SUPABASE_DB_NAME      postgres
    SUPABASE_DB_USER      postgres           (or pooler user)
    SUPABASE_DB_PASSWORD  <your db password>
"""

from __future__ import annotations

import os
import uuid
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd
import psycopg2
import psycopg2.extras
from dotenv import load_dotenv
from mlxtend.frequent_patterns import fpgrowth, association_rules

# arm.py -> uc1 -> engines -> FYP_Medflow (repo root for this project)
ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = ROOT / ".env.local"

loaded = load_dotenv(ENV_FILE)
if not loaded:
    raise FileNotFoundError(f".env.local not found or empty at: {ENV_FILE}")

from engines.result import StageResult


# ------------------------------------------------------------------
# Config
# ------------------------------------------------------------------
CENTRAL_WAREHOUSE_ID = "WH001"   # label for the AGGREGATED rule set
FILTER_STATUS = "Fulfilled"      # set to None to mine ALL statuses

MIN_SUPPORT_MINE = 0.02          # mine loose ...
BASELINE_SUPPORT = 0.03          # ... filter tight
BASELINE_CONFIDENCE = 0.50
BASELINE_LIFT = 1.20

SUPPORT_BANDS = (0.08, 0.04)     # (strong, moderate); else weak
CONFIDENCE_BANDS = (0.55, 0.50)
LIFT_BANDS = (1.50, 1.20)

RULE_SOURCE = "FP-GROWTH"
RUN_TYPE = "Association Rule Mining"
ALGORITHM_VERSION = "FP-GROWTH-1.0"
INSERT_PAGE = 1000               # bulk-insert chunk size


# ------------------------------------------------------------------
# Connection
# ------------------------------------------------------------------
def get_connection():
    return psycopg2.connect(
        host=os.environ["SUPABASE_DB_HOST"],
        port=os.environ.get("SUPABASE_DB_PORT", "6543"),
        dbname=os.environ.get("SUPABASE_DB_NAME", "postgres"),
        user=os.environ["SUPABASE_DB_USER"],
        password=os.environ["SUPABASE_DB_PASSWORD"],
        sslmode="require",
    )


# ------------------------------------------------------------------
# 1. Extract (one query, warehouseid retained for partitioning)
# ------------------------------------------------------------------
def load_transactions(conn, status=FILTER_STATUS, destination_warehouse_id=None):
    """
    Return [orderid, productid, warehouseid] for fulfilled orders.

    Fetched once and partitioned in memory rather than issuing one query
    per warehouse. destination_warehouse_id restricts to a single site
    (used only for a manual single-scope debug run).
    """
    sql = """
        SELECT ol.orderid, ol.productid, o.warehouseid
        FROM orderline ol
        JOIN orders o ON o.orderid = ol.orderid
    """
    where, params = [], []

    if destination_warehouse_id is not None:
        where.append("o.warehouseid = %s")
        params.append(destination_warehouse_id)
    if status is not None:
        where.append("o.status = %s")
        params.append(status)

    if where:
        sql += " WHERE " + " AND ".join(where)

    with conn.cursor() as cur:
        cur.execute(sql, params)
        rows = cur.fetchall()

    return pd.DataFrame(rows, columns=["orderid", "productid", "warehouseid"])


# ------------------------------------------------------------------
# 2. Baskets + mine + classify
# ------------------------------------------------------------------
def build_basket_matrix(txns):
    """One-hot basket matrix; drops orders with fewer than 2 products."""
    pairs = txns.drop_duplicates(["orderid", "productid"])
    onehot = (
        pairs.assign(present=1)
        .pivot_table(index="orderid", columns="productid",
                     values="present", fill_value=0)
        .astype(bool)
    )
    return onehot[onehot.sum(axis=1) >= 2]


def mine_rules(
    basket_matrix,
    min_support=MIN_SUPPORT_MINE,
    baseline_support=BASELINE_SUPPORT,
    baseline_confidence=BASELINE_CONFIDENCE,
    baseline_lift=BASELINE_LIFT,
):
    """
    FP-Growth + rule generation + baseline filter.

    Metrics are relative to the basket_matrix passed in, so the SAME
    function serves both the global scope and each per-warehouse scope.
    Thresholds are arguments so a scope can later use stricter values
    without duplicating this logic.
    """
    if basket_matrix.empty:
        return pd.DataFrame()

    frequent = fpgrowth(basket_matrix, min_support=min_support,
                        use_colnames=True)
    if frequent.empty:
        return pd.DataFrame()

    rules = association_rules(frequent, metric="lift")
    if rules.empty:
        return pd.DataFrame()

    return rules[
        (rules["support"] >= baseline_support)
        & (rules["confidence"] >= baseline_confidence)
        & (rules["lift"] >= baseline_lift)
        & (rules["consequents"].apply(len) == 1)   # schema: 1 consequent
    ].copy()


def _band(v, strong, moderate):
    return 2 if v >= strong else 1 if v >= moderate else 0


def classify(support, confidence, lift):
    score = min(_band(support, *SUPPORT_BANDS),
                _band(confidence, *CONFIDENCE_BANDS),
                _band(lift, *LIFT_BANDS))
    return {2: "Strong", 1: "Moderate", 0: "Weak"}[score]


# ------------------------------------------------------------------
# 3. Transform rules -> rows
# ------------------------------------------------------------------
def rules_to_rows(rules, warehouse_id, run_id, order_count):
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
            int(order_count), RULE_SOURCE, today, run_id,
        ))
        ant_rows.extend((rid, a) for a in antecedents)
    return pr_rows, ant_rows


def mine_scope(txns, label_warehouse_id, run_id):
    """
    Mine ONE population and shape it into database rows.

    Returns (label, pr_rows, ant_rows, order_count, basket_count).
    """
    order_count = int(txns["orderid"].nunique())
    baskets = build_basket_matrix(txns)

    if baskets.empty:
        return label_warehouse_id, [], [], order_count, 0

    rules = mine_rules(baskets)
    if rules.empty:
        return label_warehouse_id, [], [], order_count, len(baskets)

    pr_rows, ant_rows = rules_to_rows(
        rules, label_warehouse_id, run_id, order_count)
    return label_warehouse_id, pr_rows, ant_rows, order_count, len(baskets)


# ------------------------------------------------------------------
# 4. Load (all scopes in ONE transaction)
# ------------------------------------------------------------------
def write_all_scopes(conn, scopes, run_id):
    """
    One transaction for the whole refresh: insert the modelrun, then for
    every scope replace that label's rules. Either the entire refresh
    lands or none of it does, so the site never reads a half-written mix
    of old and new rule sets.

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
                    f"min_support={MIN_SUPPORT_MINE};"
                    f"support>={BASELINE_SUPPORT};"
                    f"confidence>={BASELINE_CONFIDENCE};"
                    f"lift>={BASELINE_LIFT};"
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
def run(destination_warehouse_id=None):
    """
    Mine association rules for EVERY scope in a single run.

    Default (destination_warehouse_id=None):
        - the aggregated rule set across all fulfilled orders, stored
          under warehouseid = WH001
        - one rule set per destination warehouse, stored under its own
          WHnnn id

    Every warehouse is mined regardless of how many orders it has. Thin
    sites simply produce few (or zero) rules; ordercount on each row
    records how many orders that rule set was derived from, so the UI
    can show the evidence behind a rule.

    destination_warehouse_id="WHnnn" restricts the run to that single
    site (manual debugging; the aggregate is not touched).
    """
    run_id = str(uuid.uuid4())
    conn = get_connection()

    try:
        txns = load_transactions(
            conn,
            status=FILTER_STATUS,
            destination_warehouse_id=destination_warehouse_id,
        )

        if txns.empty:
            target = destination_warehouse_id or "all warehouses"
            return StageResult(
                name="UC1",
                runid=run_id,
                status="failed",
                error=f"No order lines found for {target} "
                      f"(status={FILTER_STATUS}).",
            )

        total_orders = int(txns["orderid"].nunique())
        scopes, notes = [], []

        if destination_warehouse_id is None:
            # Scope 1: the aggregate, labelled WH001.
            scopes.append(mine_scope(txns, CENTRAL_WAREHOUSE_ID, run_id))

            # Scopes 2..n: one per destination warehouse.
            for wh, sub in txns.groupby("warehouseid", sort=True):
                scopes.append(mine_scope(sub, wh, run_id))
        else:
            # Single-site debug run.
            scopes.append(
                mine_scope(txns, destination_warehouse_id, run_id))

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
            input_rows=total_orders,
            output_rows=total_rules,
            error="; ".join(notes) or None,
        )
    finally:
        conn.close()


if __name__ == "__main__":
    #   python -m engines.uc1.arm            -> aggregate + every warehouse
    #   python -m engines.uc1.arm WH002      -> that one site only (debug)
    import sys

    dest = sys.argv[1] if len(sys.argv) > 1 else None
    result = run(dest)
    print(f"{result.name}: {result.status} runid={result.runid} "
          f"in={result.input_rows} out={result.output_rows}")
    if result.error:
        print(f"  {result.error}")
    raise SystemExit(0 if result.ok else 1)