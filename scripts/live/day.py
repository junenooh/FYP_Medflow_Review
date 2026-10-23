"""Run ONE live simulated day on top of the loaded history, reordering with UC2's policy.

    python -m scripts.live.day                                # the day after the ledger ends
    python -m scripts.live.day --spike 2.5 --warehouse WH002  # a busier day at WH002 (demo)
    python -m scripts.live.day --dry-run                      # work it all out, write nothing

The same day as the simulator (scripts/sim/generate.py) except that the 23:30 review uses
UC2's derived reorder point / order-up-to level (uc2_policy_parameters) instead of the
subsidiaries' own mis-sized levels:

  08:00        orders that are due arrive at the subsidiaries
               -> inventory receipt rows (orderid set), order Fulfilled on this day
  all day      hospital requests on the hourly profile, served from stock in request order
               -> stocktransfer + stocktransferline (sales packs)
  23:00        the day's hand-outs -> one inventory row per product, going down
  (UC2)        python -m engines.uc2.replenishment --direct: consumption + policy as of today
  23:30        REORDER CHECK per subsidiary and SKU: position = on hand + on its way;
               if position <= UC2 reorder point: order (UC2 order-up-to level - position),
               rounded to WHOLE CARTONS (nearest to the gap, never fewer than it takes to clear
               the reorder point, at least one) -> one order per subsidiary: orders + orderline
               COMPANION ORDERS (the can-order rule, (s, c, S)): for every UC1 rule of this
               subsidiary whose antecedents are ALL among tonight's triggers, the consequent joins
               the same order if its position is at or below its can-order level:
                 Strong    reorder point + 100% of its safety stock
                 Moderate  reorder point +  50% of its safety stock
                 Weak      never
               It is ordered up to its order-up-to level, in cartons. Companion lines carry a
               'C' suffix on their orderlineid (PO-WH002-20261015-0012C) so the UC2 page can show
               them as companions; nothing else in the schema changes.
  23:45        Central draws each shipped product from its bins, earliest expiry first (FEFO),
               one inventory row per bin touched, then tops every touched bin back up to full
               (supplier, instant) -> WH001 inventory rows, same bins as always

Each run advances exactly one day: the day after the last day in the inventory ledger. If a
run stopped after the hand-outs (e.g. the UC2 refresh failed), the next run finishes that
day's reorder check instead of starting a new day.

Demand comes from data/sim/<profile>/ground_truth.json (the same rates, bundles, warehouse
multipliers and hospitals as the history), seeded by the day, so a rerun of the same day on
the same data gives the same requests.

Tables written: inventory, stocktransfer, stocktransferline, orders, orderline -- all on the
product owner's list (scripts/sim/db.py). Nothing is truncated, dropped or altered. Each
write is one transaction that re-checks the table rules and fingerprints the protected
tables before it commits. A delivery's arrival day is not stored, so open orders arrive after
a lead time drawn from the configured distribution, fixed per order id.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import subprocess
import sys
import time
from collections import defaultdict

import numpy as np

from scripts.sim import db
from scripts.sim.generate import cartonise
from scripts.sim.load import SQL_CHECKS, fingerprint

LIVE_TABLES = ("inventory", "stocktransfer", "stocktransferline", "orders", "orderline")
assert set(LIVE_TABLES) <= db.ALLOWED, "the live day may only write tables listed in db.py"
CHECKED = db.UNTOUCHED_TABLES + db.OUTPUT_TABLES + db.NOT_NEEDED_TABLES   # UC2 may write its own

INV_COLS = ("inventoryid", "warehouseid", "productid", "qtyonhand", "expirydate", "datereceived",
            "inventorystatus", "lastupdated", "orderid", "binid")
ST_COLS = ("transferid", "transferdate", "sourcewarehouseid", "siteid", "status")
STL_COLS = ("transferlineid", "transferid", "productid", "qtyrequested", "qtyissued")
OL_COLS = ("orderlineid", "orderid", "productid", "qtyordered")


def table(name: str) -> str:
    if name not in LIVE_TABLES:
        raise RuntimeError(f"refusing to write {name!r}: not a live-day table")
    return f'public."{name}"'


def copy_rows(conn, name: str, cols, rows) -> int:
    if not rows:
        return 0
    with conn.cursor() as cur:
        with cur.copy(f"COPY {table(name)} ({', '.join(cols)}) FROM STDIN") as cp:
            for row in rows:
                cp.write_row(row)
    return len(rows)


class Model:
    """The demand model of the history, rebuilt from ground_truth.json."""

    def __init__(self, truth: dict):
        P = truth["products"]
        self.pid = [p["productid"] for p in P]
        self.index = {p: i for i, p in enumerate(self.pid)}
        self.lam_ind = np.array([p["own_lines_per_day_at_1x"] for p in P], dtype=float)
        self.qbar = np.array([p["packs_per_line_mean"] for p in P], dtype=float)
        self.shape = 1.0 / np.array([p["line_cv"] for p in P], dtype=float) ** 2
        self.carton = np.array([p["packs_per_carton"] for p in P], dtype=np.int64)
        self.shelf = np.array([720] * len(P), dtype=np.int64)                 # set from product below
        self.cap = np.array([p["cartons_per_bin"] * p["packs_per_carton"] for p in P], dtype=np.int64)
        self.bundles = [{"idx": np.array([self.index[m] for m in b["members"]]),
                         "rate": b["events_per_day_at_1x"], "p": b["p_include"]} for b in truth["bundles"]]
        whs = truth["warehouses"]
        self.whs = [w["id"] for w in whs]
        mult = np.array([w["demand_multiplier"] for w in whs], dtype=float)
        x = float(truth["multiplier_lines_exponent"])
        self.mult_lines, self.mult_qty = mult ** x, mult ** (1.0 - x)
        self.sites = [w["hospitals"] for w in whs]
        site_rng = np.random.default_rng([int(truth["seed"]), 4])     # as in generate.py
        self.site_w = []
        for ids in self.sites:
            wts = site_rng.uniform(0.5, 1.5, len(ids))
            self.site_w.append(wts / wts.sum())
        self.dow = np.array(truth["day_of_week"], dtype=float)
        hw = np.array(truth["hour_weights"], dtype=float)
        self.hour_p = hw / hw.sum()
        self.mean_lines = float(truth["mean_lines_per_request"])
        self.p_max = float(truth["max_daily_request_prob"])
        self.lt_days = list(truth["lead_time"]["days"])
        self.lt_cum = np.cumsum(truth["lead_time"]["probs"])
        self.times = truth["times"]

    def lead(self, orderid: str) -> int:
        u = int(hashlib.sha256(orderid.encode()).hexdigest()[:8], 16) / 2 ** 32
        return int(self.lt_days[min(int(np.searchsorted(self.lt_cum, u, side="right")), len(self.lt_days) - 1)])

    def requests(self, rng, wi: int, factor: float):
        n = len(self.pid)
        expected = self.lam_ind * self.mult_lines[wi] * factor
        trials = np.maximum(1, np.ceil(expected / self.p_max)).astype(np.int64)
        cnt = rng.binomial(trials, expected / trials)
        sku = np.repeat(np.arange(n), cnt)

        def qty_for(s):
            extra = np.maximum(self.qbar[s] * self.mult_qty[wi] - 1.0, 0.01)
            return 1 + rng.poisson(rng.gamma(self.shape[s], extra / self.shape[s])).astype(np.int64)

        qty = qty_for(sku)
        b_sku, b_evt, n_evt = [], [], 0
        for b in self.bundles:
            for _ in range(rng.poisson(b["rate"] * self.mult_lines[wi] * factor)):
                inc = b["idx"][rng.random(b["idx"].size) < b["p"]]
                if inc.size:
                    b_sku.append(inc)
                    b_evt.append(np.full(inc.size, n_evt))
                    n_evt += 1
        b_sku = np.concatenate(b_sku) if b_sku else np.zeros(0, dtype=np.int64)
        b_evt = np.concatenate(b_evt) if b_evt else np.zeros(0, dtype=np.int64)
        total = sku.size + b_sku.size
        if not total:
            return None
        n_req = max(1, int(round(total / self.mean_lines)))
        req = np.concatenate([rng.integers(n_req, size=sku.size), rng.integers(n_req, size=max(n_evt, 1))[b_evt]])
        all_sku = np.concatenate([sku, b_sku])
        all_qty = np.concatenate([qty, qty_for(b_sku)])
        key, inv = np.unique(req * n + all_sku, return_inverse=True)
        l_qty = np.bincount(inv, weights=all_qty).astype(np.int64)
        return key // n, key % n, l_qty, n_req


def ts(day, hour, tz):
    minutes = min(int(round(hour * 60)), 23 * 60 + 59)
    return f"{day.isoformat()}T{minutes // 60:02d}:{minutes % 60:02d}:00{tz}"


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profile", default="full", help="whose ground_truth.json to use (default full)")
    ap.add_argument("--spike", type=float, default=1.0, help="demand factor for this day (default 1.0)")
    ap.add_argument("--warehouse", default=None, help="apply --spike to this subsidiary only")
    ap.add_argument("--dry-run", action="store_true", help="work everything out, write nothing")
    ap.add_argument("--skip-uc2", action="store_true",
                    help="do not refresh UC2 before the reorder check (uses the current policy)")
    a = ap.parse_args(argv)

    truth_path = db.REPO_ROOT / "data" / "sim" / a.profile / "ground_truth.json"
    if not truth_path.exists():
        print(f"  {truth_path} not found -- run python -m scripts.sim.generate --profile {a.profile}")
        return 1
    truth = json.loads(truth_path.read_text(encoding="utf-8"))
    if "own_lines_per_day_at_1x" not in truth["products"][0]:
        print("  this ground truth was made by an older simulator -- regenerate and reload")
        return 1
    m = Model(truth)
    if a.warehouse and a.warehouse not in m.whs:
        print(f"  --warehouse must be one of {', '.join(m.whs)}")
        return 2
    cw = truth["central_warehouse"]
    tz = "+08:00"
    status = "Available"
    n, nw = len(m.pid), len(m.whs)
    widx = {w: i for i, w in enumerate(m.whs)}
    T = m.times

    print(f"  database host: {db.host()}{'   (DRY RUN: nothing will be written)' if a.dry_run else ''}")
    conn = db.connect(read_only=False)
    try:
        conn.execute("SET statement_timeout = 0")
        inv_d = f"({db.ts_expr(conn, 'inventory', 'lastupdated')})::date"
        last = conn.execute(f"SELECT max({inv_d}) FROM inventory WHERE warehouseid <> %s", (cw,)).fetchone()[0]
        if last is None:
            print("  the inventory ledger is empty -- load the history first (scripts.sim.load)")
            return 1
        resume = conn.execute("SELECT count(*) FROM orders WHERE orderdate = %s", (last,)).fetchone()[0] == 0
        day = last if resume else last + dt.timedelta(days=1)
        ymd = f"{day:%Y%m%d}"
        shelf = dict(conn.execute("SELECT productid, shelflife_days FROM product WHERE productid = ANY(%s)", (m.pid,)))
        for i, p in enumerate(m.pid):
            m.shelf[i] = int(shelf.get(p) or 720)
        conn.commit()

        def state():
            """Latest balance per subsidiary x SKU, Central's bins, and the open (Processing) orders."""
            oh = np.zeros((nw, n), dtype=np.int64)
            recv = [[day] * n for _ in range(nw)]
            bins = defaultdict(list)                      # product index -> [bin dicts]
            for w, p, q, r, e, b in conn.execute(f"""
                    SELECT DISTINCT ON (warehouseid, productid, coalesce(binid, '')) warehouseid, productid,
                           qtyonhand, datereceived, expirydate, binid
                    FROM inventory ORDER BY warehouseid, productid, coalesce(binid, ''), lastupdated DESC, inventoryid DESC"""):
                if p not in m.index:
                    continue
                i = m.index[p]
                if w == cw:
                    bins[i].append({"bin": b, "qty": int(q), "recv": r, "exp": e})
                elif w in widx:
                    oh[widx[w], i] = q
                    recv[widx[w]][i] = r
            for i in bins:
                bins[i].sort(key=lambda b: b["bin"])
                for j, b in enumerate(bins[i], 1):
                    b["seq"] = j
            open_orders = defaultdict(lambda: {"lines": []})
            for oid, w, od, p, q in conn.execute("""
                    SELECT o.orderid, o.warehouseid, o.orderdate, l.productid, l.qtyordered
                    FROM orders o JOIN orderline l USING (orderid)
                    WHERE o.status = 'Processing' ORDER BY o.orderdate, o.orderid, l.orderlineid"""):
                if w in widx and p in m.index:
                    open_orders[oid].update(w=w, orderdate=od)
                    open_orders[oid]["lines"].append((p, int(q)))
            return oh, recv, bins, open_orders

        t0 = time.time()
        # ======================= 08:00 arrivals + daytime hand-outs ====================
        if resume:
            print(f"  {day} already has its hand-outs but no reorder check -- finishing that day")
        else:
            print(f"  simulating {day} (the ledger ended {last})")
            before = fingerprint(conn, CHECKED)
            oh, recv, _bins, open_orders = state()
            inv_rows, st_rows, stl_rows = [], [], []

            due = sorted((o["w"], oid) for oid, o in open_orders.items()
                         if o["orderdate"] + dt.timedelta(days=m.lead(oid)) <= day)
            k_of = defaultdict(int)
            for w, oid in due:
                wi = widx[w]
                k_of[w] += 1
                k = k_of[w]
                for p, q in open_orders[oid]["lines"]:
                    i = m.index[p]
                    oh[wi, i] += q
                    recv[wi][i] = day
                    inv_rows.append((f"INV-{w}-{p}-{ymd}-R{k}", w, p, int(oh[wi, i]),
                                     day + dt.timedelta(days=int(m.shelf[i])), day, status,
                                     ts(day, T["arrivals"] + (k - 1) / 60, tz), oid, None))
                conn.execute(f"UPDATE {table('orders')} SET status = 'Fulfilled', fulfilmentdate = %s "
                             "WHERE orderid = %s AND status = 'Processing'", (day, oid))
            print(f"    08:00 arrivals: {len(due)} orders delivered" +
                  (f" ({', '.join(oid for _, oid in due)})" if due else ""))

            rng = np.random.default_rng([int(truth["seed"]), 3, day.toordinal()])
            f = m.dow[day.weekday()]
            for wi, w in enumerate(m.whs):
                factor = f * (a.spike if (a.warehouse in (None, w)) else 1.0)
                drawn = m.requests(rng, wi, factor)
                if drawn is None:
                    continue
                l_req, l_sku, l_qty, n_req = drawn
                hours = np.sort(rng.choice(24, size=n_req, p=m.hour_p) + rng.random(n_req))
                site_of = rng.choice(len(m.sites[wi]), p=m.site_w[wi], size=n_req)
                requested = np.bincount(l_sku, weights=l_qty, minlength=n).astype(np.int64)
                l_iss = l_qty.copy()
                for s in np.nonzero(requested > oh[wi])[0]:
                    li = np.nonzero(l_sku == s)[0]
                    before_q = np.cumsum(l_qty[li]) - l_qty[li]
                    l_iss[li] = np.clip(oh[wi, s] - before_q, 0, l_qty[li])
                issued = np.bincount(l_sku, weights=l_iss, minlength=n).astype(np.int64)
                oh[wi] -= issued
                used = np.unique(l_req)
                tid = {int(r): f"TR-{w}-{ymd}-{k:05d}" for k, r in enumerate(used.tolist(), 1)}
                st_rows += [(tid[r], ts(day, float(hours[r]), tz), w, m.sites[wi][int(site_of[r])], "Completed")
                            for r in used.tolist()]
                line_no = np.arange(l_req.size) - np.searchsorted(l_req, l_req, "left") + 1
                stl_rows += [(f"{tid[r]}-{j:03d}", tid[r], m.pid[s], int(q), int(iq))
                             for r, j, s, q, iq in zip(l_req.tolist(), line_no.tolist(), l_sku.tolist(),
                                                       l_qty.tolist(), l_iss.tolist())]
                for i in np.nonzero(issued)[0].tolist():
                    p = m.pid[i]
                    inv_rows.append((f"INV-{w}-{p}-{ymd}-I", w, p, int(oh[wi, i]),
                                     recv[wi][i] + dt.timedelta(days=int(m.shelf[i])), recv[wi][i], status,
                                     ts(day, T["handout_booking"], tz), None, None))
                fill = issued.sum() / max(requested.sum(), 1)
                spike = f"  (demand x{a.spike:g})" if factor != f else ""
                print(f"    {w}: {used.size:,} hospital requests, {l_req.size:,} lines, "
                      f"{int(requested.sum()):,} packs asked, fill {fill:.1%}{spike}")

            copy_rows(conn, "stocktransfer", ST_COLS, st_rows)
            copy_rows(conn, "stocktransferline", STL_COLS, stl_rows)
            copy_rows(conn, "inventory", INV_COLS, inv_rows)
            if not finish_transaction(conn, truth, before, a.dry_run, "arrivals + hand-outs"):
                return 1

        # ======================= UC2 refresh ===========================================
        if a.dry_run or a.skip_uc2:
            print("  UC2 refresh skipped" + (" (dry run)" if a.dry_run else "") +
                  " -- the reorder check uses the current UC2 policy")
        else:
            print("  refreshing UC2 (python -m engines.uc2.replenishment --direct) ...")
            done = subprocess.run([sys.executable, "-m", "engines.uc2.replenishment", "--direct"],
                                  cwd=db.REPO_ROOT, capture_output=True, text=True)
            for line in [x for x in done.stdout.splitlines() if "as of" in x or "UC2:" in x][-2:]:
                print(f"    {line.strip()}")
            if done.returncode != 0:
                print(done.stdout[-1500:], done.stderr[-1500:], sep="\n")
                print(f"  UC2 refresh FAILED -- the hand-outs for {day} are saved. Fix it and run "
                      "python -m scripts.live.day again: it finishes this day's reorder check.")
                return 1

        # ======================= 23:30 reorder check on UC2's policy =====================
        before = fingerprint(conn, CHECKED)
        oh, recv, bins, open_orders = state()
        policy, asof = {}, None
        for w, p, rop, oul, ss, a_of in conn.execute(
                "SELECT warehouseid, productid, reorderpoint, orderuptolevel, safetystock, asofdate "
                "FROM uc2_policy_parameters"):
            if w in widx and p in m.index:
                policy[(widx[w], m.index[p])] = (int(rop), int(oul), float(ss or 0))
                asof = a_of
        rules = companion_rules(conn, m.whs, cw)
        if not policy:
            print("  no UC2 policy rows -- run python -m engines.uc2.replenishment --rebuild --direct first")
            conn.rollback()
            return 1
        if asof != day:
            print(f"  note: the UC2 policy is as of {asof}, not {day}")
        transit = np.zeros((nw, n), dtype=np.int64)
        for o in open_orders.values():
            for p, q in o["lines"]:
                transit[widx[o["w"]], m.index[p]] += q

        dispatch = np.zeros(n, dtype=np.int64)
        order_rows, ol_rows, inv_rows = [], [], []
        print(f"    23:30 reorder check (UC2 reorder point / order-up-to level, as of {asof}):")
        for wi, w in enumerate(m.whs):
            trig, gaps = [], []
            for i in range(n):
                rop, oul, _ss = policy.get((wi, i), (None, None, None))
                if rop is None:
                    continue
                pos = int(oh[wi, i] + transit[wi, i])
                if pos <= rop and oul - pos > 0:
                    trig.append(i)
                    gaps.append(oul - pos)
            if not trig:
                print(f"      {w}: nothing at or below its reorder point")
                continue
            # companions: the can-order rule on this subsidiary's UC1 rules
            trig_set = {m.pid[i] for i in trig}
            comp: dict[int, tuple[str, list[str]]] = {}
            for ants, cons, strength in rules.get(w, []):
                if cons in trig_set or cons not in m.index or not ants <= trig_set:
                    continue
                i = m.index[cons]
                rop, oul, ss = policy.get((wi, i), (None, None, None))
                if rop is None:
                    continue
                pos = int(oh[wi, i] + transit[wi, i])
                share = CAN_ORDER_SHARE[strength]
                if pos <= rop + share * ss and oul - pos > 0 and (i not in comp or strength == "Strong"):
                    comp[i] = (strength, sorted(ants))
            idx = np.array(trig + sorted(comp))
            pos = oh[wi, idx] + transit[wi, idx]
            rop_v = np.array([policy[(wi, i)][0] for i in idx])
            gap_v = np.array([policy[(wi, i)][1] for i in idx], dtype=float) - pos
            cartons = cartonise(gap_v, pos, rop_v, m.carton[idx])
            units = cartons * m.carton[idx]
            oid = f"PO-{w}-{ymd}"
            order_rows.append((oid, w, day, None, "Processing"))
            ol_rows += [(f"{oid}-{k:04d}{'C' if i in comp else ''}", oid, m.pid[i], int(q))
                        for k, (i, q) in enumerate(zip(idx.tolist(), units.tolist()), 1)]
            dispatch[idx] += units
            n_strong = sum(1 for v in comp.values() if v[0] == "Strong")
            print(f"      {w}: {len(trig)} SKUs at or below the reorder point"
                  + (f" + {len(comp)} companions ({n_strong} Strong, {len(comp) - n_strong} Moderate)" if comp else "")
                  + f" -> {oid} ({idx.size} lines, {int(units.sum()):,} packs in {int(cartons.sum()):,} cartons)")

        topups, cross_docked = 0, 0
        for i in np.nonzero(dispatch)[0].tolist():         # Central: FEFO draw, then top-up
            need = int(dispatch[i])
            touched = []
            for b in sorted(bins.get(i, []), key=lambda b: (b["exp"], b["seq"])):
                if need <= 0:
                    break
                take = min(b["qty"], need)
                if take <= 0:
                    continue
                b["qty"] -= take
                need -= take
                touched.append(b)
                inv_rows.append((f"INV-{cw}-{m.pid[i]}-{ymd}-D{b['seq']}", cw, m.pid[i], int(b["qty"]), b["exp"],
                                 b["recv"], status, ts(day, T["central"], tz), None, b["bin"]))
            if need > 0:                                    # more than the bins hold: straight from the supplier
                cross_docked += need
            for b in touched:
                b["qty"], b["recv"] = int(m.cap[i]), day
                b["exp"] = day + dt.timedelta(days=int(m.shelf[i]))
                inv_rows.append((f"INV-{cw}-{m.pid[i]}-{ymd}-S{b['seq']}", cw, m.pid[i], int(b["qty"]), b["exp"],
                                 b["recv"], status, ts(day, T["central"] + 5 / 60, tz), None, b["bin"]))
                topups += 1
        if dispatch.any():
            print(f"      {cw}: ships {int(dispatch.sum()):,} packs tonight; {topups} bins topped back up"
                  + (f"; {cross_docked:,} packs beyond what the bins hold came straight from the supplier (cross-docked)"
                     if cross_docked else ""))

        with conn.cursor() as cur:
            cur.executemany(f"INSERT INTO {table('orders')} (orderid, warehouseid, orderdate, fulfilmentdate, status) "
                            "VALUES (%s, %s, %s, %s, %s)", order_rows)
        copy_rows(conn, "orderline", OL_COLS, ol_rows)
        copy_rows(conn, "inventory", INV_COLS, inv_rows)
        if not finish_transaction(conn, truth, before, a.dry_run, "reorder check"):
            return 1
        if a.dry_run:
            conn.rollback()
    finally:
        conn.close()

    print(f"\n  {day} done ({time.time() - t0:,.0f}s)." + ("" if a.dry_run else " Hard-refresh the UC2 page to see it."))
    return 0


CAN_ORDER_SHARE = {"Strong": 1.0, "Moderate": 0.5}      # of the companion's safety stock, above its ROP


def companion_rules(conn, whs, cw) -> dict[str, list]:
    """UC1's Strong and Moderate rules per subsidiary, latest run: [(antecedent set, consequent, strength)].

    A subsidiary with no rules of its own falls back to the network set (labelled with the central id).
    """
    rows = conn.execute("""
        SELECT pr.warehouseid, pr.consequent_productid, pr.strength,
               array_agg(pa.antecedent_productid)
        FROM productrelationship pr
        JOIN productrelationshipantecedent pa USING (relationshipid)
        WHERE pr.strength IN ('Strong', 'Moderate')
          AND pr.runid = (SELECT m.runid FROM productrelationship p2 JOIN modelrun m USING (runid)
                          ORDER BY m.generatedate DESC LIMIT 1)
        GROUP BY 1, 2, 3, pr.relationshipid""").fetchall()
    by: dict[str, list] = defaultdict(list)
    for w, cons, strength, ants in rows:
        by[w].append((set(ants), cons, strength))
    return {w: by.get(w) or by.get(cw, []) for w in whs}


def finish_transaction(conn, truth: dict, before: dict, dry_run: bool, what: str) -> bool:
    """Re-check the table rules and the protected tables; commit, or roll back on any failure."""
    params = {"ids": [p["productid"] for p in truth["products"]], "cw": truth["central_warehouse"]}
    broken = [name for name, sql in SQL_CHECKS if conn.execute(sql, params).fetchone()[0]]
    after = fingerprint(conn, CHECKED)
    changed = [t for t in before if before[t] != after.get(t)]
    if broken or changed:
        conn.rollback()
        print(f"  ROLLED BACK the {what}: " + "; ".join(
            ([f"rules broken: {', '.join(broken)}"] if broken else []) +
            ([f"protected tables changed: {', '.join(changed)}"] if changed else [])))
        return False
    if dry_run:
        print(f"    ({what}: checks pass; dry run, so nothing is kept)")
        return True
    conn.commit()
    print(f"    {what}: committed (table rules hold, protected tables unchanged)")
    return True


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
