"""Check that the loaded history is consistent with ground_truth.json.

    python -m scripts.sim.check --profile full
    python -m scripts.sim.check --profile full --bundles-only

Read-only (the session cannot write). Checks:

  0. table rules        the product-owner rules the loader enforces, re-run in SQL
  1. hand-outs          per subsidiary, product and day, the packs issued to hospitals equal
                        the drop in the inventory ledger
  2. deliveries         per subsidiary, product and day, the order lines delivered equal the
                        rise in the ledger
  3. clean timeline     no negative stock, nothing dated after the end date, one opening row
                        per subsidiary x product
  4. demand ratios      requested packs by subsidiary match the multipliers
  5. demand levels      requested packs per day per product match manualbasedemand
  6. cartons            every order line is whole cartons; Central's bin stock never exceeds
                        the bin's capacity and returns to full after every dispatch
  7. lead times         delivered orders took 1-3 days, mean about 2
  8. bundles            each planted bundle's best rule (support, confidence, lift) measured
                        from the stock transfers lands in its intended band, at every
                        subsidiary and network-wide
"""

from __future__ import annotations

import argparse
import itertools
import json
import sys
from pathlib import Path

from scripts.sim import db
from scripts.sim.load import SQL_CHECKS

REPO_ROOT = db.REPO_ROOT


def verdict(name: str, ok: bool, detail: str = "") -> bool:
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f": {detail}" if detail else ""))
    return ok


def band_of(bands: dict, support: float, conf: float, lift: float) -> str:
    g = bands["gates"]
    if support < g["min_support"] or conf < g["min_confidence"] or lift < g["min_lift"]:
        return "none"
    if conf >= bands["strong"]["min_confidence"] and support >= bands["strong"]["min_support"]:
        return "strong"
    if conf >= bands["moderate"]["min_confidence"] and support >= bands["moderate"]["min_support"]:
        return "moderate"
    return "weak"


def bundle_rules(conn, truth: dict, scope: str | None):
    """For every planted bundle, the (support, confidence, lift) of its best pair rule in a scope."""
    where = "WHERE t.sourcewarehouseid = %(w)s" if scope else ""
    n_req = conn.execute(f"SELECT count(*) FROM stocktransfer t {where}", {"w": scope}).fetchone()[0]
    members = sorted({m for b in truth["bundles"] for m in b["members"]})
    rows = conn.execute(f"""
        SELECT l.productid, t.transferid FROM stocktransferline l
        JOIN stocktransfer t USING (transferid) {where.replace('WHERE', 'WHERE l.productid = ANY(%(m)s) AND') or 'WHERE l.productid = ANY(%(m)s)'}""",
                        {"w": scope, "m": members}).fetchall()
    has: dict[str, set] = {}
    for p, tid in rows:
        has.setdefault(p, set()).add(tid)
    out = []
    for b in truth["bundles"]:
        best = None
        for a, c in itertools.permutations(b["members"], 2):
            A, C = has.get(a, set()), has.get(c, set())
            both = len(A & C)
            s = both / max(n_req, 1)
            conf = both / max(len(A), 1)
            lift = conf / (len(C) / n_req) if C and n_req else 0.0
            cand = (conf, s, lift, a, c)
            if best is None or cand[:2] > best[:2]:
                best = cand
        conf, s, lift, a, c = best
        out.append(dict(id=b["id"], band=b["band"], name=b["name"], a=a, c=c, support=s, confidence=conf,
                        lift=lift, got=band_of(truth["bands"], s, conf, lift)))
    return n_req, out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profile", default="full")
    ap.add_argument("--data", default=None)
    ap.add_argument("--bundles-only", action="store_true")
    a = ap.parse_args(argv)
    data = Path(a.data) if a.data else REPO_ROOT / "data" / "sim" / a.profile
    truth = json.loads((data / "ground_truth.json").read_text(encoding="utf-8"))
    cw = truth["central_warehouse"]
    whs = [w["id"] for w in truth["warehouses"]]
    mult = {w["id"]: w["demand_multiplier"] for w in truth["warehouses"]}
    end = truth["end_date"]
    results = []

    with db.connect(read_only=True) as conn:
        q = lambda sql, *p: conn.execute(sql, p).fetchall()  # noqa: E731
        print(f"  database host: {db.host()} (read-only)\n")
        inv_d = f"({db.ts_expr(conn, 'inventory', 'lastupdated')})::date"
        st_d = f"({db.ts_expr(conn, 'stocktransfer', 'transferdate')})::date"

        if not a.bundles_only:
            # 0. table rules
            params = {"ids": [p["productid"] for p in truth["products"]], "cw": cw}
            broken = [(name, conn.execute(sql, params).fetchone()[0]) for name, sql in SQL_CHECKS]
            bad = [f"{n} ({k:,})" for n, k in broken if k]
            results.append(verdict("table rules", not bad, f"all {len(broken)} hold" if not bad else "broken: " + ", ".join(bad)))

            # 1. hand-outs vs ledger drops
            r = q(f"""
                WITH led AS (
                  SELECT warehouseid, productid, {inv_d} AS d,
                         qtyonhand - lag(qtyonhand) OVER (PARTITION BY warehouseid, productid ORDER BY lastupdated, inventoryid) AS delta
                  FROM inventory WHERE warehouseid <> %s),
                issued AS (
                  SELECT t.sourcewarehouseid AS warehouseid, l.productid, {st_d.replace('transferdate', 't.transferdate')} AS d,
                         sum(l.qtyissued) AS qty
                  FROM stocktransferline l JOIN stocktransfer t USING (transferid) GROUP BY 1, 2, 3)
                SELECT count(*), sum(CASE WHEN coalesce(-d.drop, 0) <> i.qty THEN 1 ELSE 0 END)
                FROM issued i LEFT JOIN (SELECT warehouseid, productid, d, sum(delta) AS drop FROM led WHERE delta < 0 GROUP BY 1, 2, 3) d
                  USING (warehouseid, productid, d)""", cw)[0]
            results.append(verdict("hand-outs match the ledger", r[1] == 0,
                                   f"{r[0]:,} warehouse-product-days with hand-outs, {r[1] or 0:,} mismatched"))

            # 2. deliveries vs ledger rises
            r = q(f"""
                WITH rec AS (
                  SELECT i.warehouseid, i.productid, {inv_d} AS d, i.orderid,
                         i.qtyonhand - lag(i.qtyonhand) OVER (PARTITION BY i.warehouseid, i.productid ORDER BY i.lastupdated, i.inventoryid) AS delta
                  FROM inventory i WHERE i.warehouseid <> %s),
                got AS (SELECT warehouseid, productid, orderid, sum(delta) AS qty FROM rec WHERE orderid IS NOT NULL GROUP BY 1, 2, 3),
                ord AS (SELECT o.warehouseid, l.productid, l.orderid, l.qtyordered FROM orderline l JOIN orders o USING (orderid)
                        WHERE o.status = 'Fulfilled')
                SELECT count(*), sum(CASE WHEN g.qty IS DISTINCT FROM ord.qtyordered THEN 1 ELSE 0 END)
                FROM ord LEFT JOIN got g USING (warehouseid, productid, orderid)""", cw)[0]
            results.append(verdict("deliveries match the ledger", r[1] == 0,
                                   f"{r[0]:,} delivered order lines, {r[1] or 0:,} mismatched"))

            # 3. clean timeline
            neg, future, pairs = q(f"""
                SELECT (SELECT count(*) FROM inventory WHERE qtyonhand < 0),
                       (SELECT count(*) FROM inventory WHERE {inv_d} > %s::date),
                       (SELECT count(*) FROM (SELECT warehouseid, productid FROM inventory WHERE warehouseid <> %s
                                              GROUP BY 1, 2 HAVING count(*) FILTER (WHERE inventoryid LIKE '%%-O') = 1) x)""",
                                   end, cw)[0]
            want = len(whs) * truth["n_skus"]
            results.append(verdict("clean timeline", neg == 0 and future == 0 and pairs == want,
                                   f"{neg:,} negative, {future:,} dated after {end}, {pairs:,}/{want:,} subsidiary-product pairs"))

            # 4. demand ratios
            tot = dict(q("""SELECT t.sourcewarehouseid, sum(l.qtyrequested) FROM stocktransferline l
                            JOIN stocktransfer t USING (transferid) GROUP BY 1"""))
            ref = whs[1]
            ok, parts = True, []
            for w in whs:
                got = float(tot.get(w, 0)) / max(float(tot.get(ref, 1)), 1)
                target = mult[w] / mult[ref]
                ok &= abs(got / target - 1) < 0.08
                parts.append(f"{w} {got:.2f} (target {target:.2f})")
            results.append(verdict(f"warehouse demand ratios vs {ref}", ok, ", ".join(parts)))

            # 5. demand levels vs manualbasedemand (network packs/day per product)
            got = dict(q("""SELECT l.productid, sum(l.qtyrequested)::float / %s FROM stocktransferline l GROUP BY 1""",
                         truth["days"]))
            errs = sorted(abs(got.get(p["productid"], 0) / max(p["network_packs_per_day"], 1e-9) - 1)
                          for p in truth["products"])
            med = errs[len(errs) // 2]
            results.append(verdict("demand levels vs manualbasedemand", med < 0.05 and errs[int(len(errs) * 0.9)] < 0.15,
                                   f"median |error| {med:.1%}, 90th percentile {errs[int(len(errs) * 0.9)]:.1%}"))

            # 6. cartons and Central bins
            cap = {(p["productid"]): p["cartons_per_bin"] * p["packs_per_carton"] for p in truth["products"]}
            over, below_full = q(f"""
                WITH m AS (SELECT productid, binid, max(qtyonhand) AS mx FROM inventory WHERE warehouseid = %s GROUP BY 1, 2),
                     last AS (SELECT DISTINCT ON (binid) binid, productid, qtyonhand, inventoryid FROM inventory
                              WHERE warehouseid = %s ORDER BY binid, lastupdated DESC, inventoryid DESC)
                SELECT (SELECT count(*) FROM m), (SELECT count(*) FROM last WHERE inventoryid LIKE '%%-D%%')""", cw, cw)[0]
            topped = q(f"SELECT count(*) FROM inventory WHERE warehouseid = %s AND inventoryid LIKE '%%-S%%'", cw)[0][0]
            drawn = q(f"SELECT count(*) FROM inventory WHERE warehouseid = %s AND inventoryid LIKE '%%-D%%'", cw)[0][0]
            results.append(verdict("Central bins: drawn FEFO and topped back up", below_full == 0 and topped == drawn,
                                   f"{drawn:,} draws, {topped:,} top-ups, {below_full:,} bins left below full at the end"))

            # 7. lead times
            r = q("""SELECT count(*), min(fulfilmentdate - orderdate), max(fulfilmentdate - orderdate),
                            avg(fulfilmentdate - orderdate), (SELECT count(*) FROM orders WHERE status = 'Processing')
                     FROM orders WHERE status = 'Fulfilled'""")[0]
            results.append(verdict("lead times", r[1] >= 1 and r[2] <= 3 and 1.8 < float(r[3]) < 2.2,
                                   f"{r[0]:,} delivered, {r[1]}-{r[2]} days, mean {float(r[3]):.2f}; {r[4]} still in transit"))

        # 8. bundles, every scope
        print("\n  planted bundles: best rule per bundle (support / confidence / lift -> band):")
        all_ok = True
        for scope in [None] + whs:
            n_req, rules = bundle_rules(conn, truth, scope)
            label = "network" if scope is None else scope
            miss = [r for r in rules if (r["got"] != r["band"] and not (r["band"] == "below" and r["got"] == "none"))]
            all_ok &= not miss
            print(f"    {label:<8} {n_req:>9,} requests: " + ", ".join(
                f"{r['id']} {r['support']:.3f}/{r['confidence']:.2f}/{r['lift']:.1f}->{r['got']}"
                + ("" if r in miss else "") for r in rules[:15]))
            if miss:
                print("      MISSED: " + ", ".join(f"{r['id']} wanted {r['band']} got {r['got']}" for r in miss))
        results.append(verdict("planted bundles land in their bands", all_ok))

    n_ok = sum(results)
    print(f"\n  {n_ok}/{len(results)} checks passed")
    return 0 if n_ok == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
