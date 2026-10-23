"""Score UC1's rules against the bundles the simulator planted.

    python -m scripts.sim.score_uc1 --profile full
    python -m scripts.sim.score_uc1 --profile full --scope WH002 --show-false 20

Read-only. Takes the rules UC1 wrote to productrelationship (latest run, antecedents from
productrelationshipantecedent) and compares them with "bundles" in ground_truth.json:

  found      a planted bundle with at least one rule whose items all belong to it
  band       the band of that bundle's best rule by the agreed grading
             (gates: support >= 0.02, confidence >= 0.50, lift >= 1.20; Strong: confidence >= 0.70
             and support >= 0.05; Moderate: confidence >= 0.60 and support >= 0.03; Weak: the gates)
             against the band the bundle was planted for; "below" bundles should NOT be found
  false      a rule whose items are not all from one planted bundle (want: none)

Per scope (WH001 = network, WH002-WH006 = each subsidiary warehouse). UC1's own strength
label is shown alongside, so the two gradings can be compared.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict

from scripts.sim import db
from scripts.sim.check import band_of

REPO_ROOT = db.REPO_ROOT


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profile", default="full")
    ap.add_argument("--scope", default=None, help="only this scope, e.g. WH001 or WH002 (default: all)")
    ap.add_argument("--show-false", type=int, default=10, help="false rules to list per scope")
    a = ap.parse_args(argv)

    truth = json.loads((REPO_ROOT / "data" / "sim" / a.profile / "ground_truth.json").read_text())
    names = {p["productid"]: p["name"] for p in truth["products"]}
    bundles = {b["id"]: b for b in truth["bundles"]}
    member_sets = {b["id"]: set(b["members"]) for b in truth["bundles"]}
    bands = truth["bands"]

    with db.connect(read_only=True) as conn:
        run = conn.execute("""SELECT pr.runid, m.parametersignature, m.generatedate
                              FROM productrelationship pr JOIN modelrun m USING (runid)
                              ORDER BY m.generatedate DESC LIMIT 1""").fetchone()
        if not run:
            print("  no UC1 rules in productrelationship -- run UC1 first")
            return 1
        runid, sig, when = run
        print(f"  UC1 run {runid} at {when:%Y-%m-%d %H:%M}\n  settings: {sig}\n")
        rows = conn.execute("""
            SELECT pr.warehouseid, pr.relationshipid, pr.consequent_productid, pr.support, pr.confidence,
                   pr.lift, pr.strength, array_agg(pa.antecedent_productid ORDER BY pa.antecedent_productid)
            FROM productrelationship pr
            JOIN productrelationshipantecedent pa USING (relationshipid)
            WHERE pr.runid = %s GROUP BY 1, 2, 3, 4, 5, 6, 7""", (runid,)).fetchall()

    by_scope: dict[str, list] = defaultdict(list)
    for w, rid, cons, sup, conf, lift, strength, ants in rows:
        by_scope[w].append(dict(items=set(ants) | {cons}, ants=ants, cons=cons, support=float(sup or 0),
                                confidence=float(conf or 0), lift=float(lift or 0), uc1_strength=strength))

    summary = []
    for scope in sorted(by_scope):
        if a.scope and scope != a.scope:
            continue
        rules = by_scope[scope]
        best: dict[str, dict] = {}
        false = []
        for r in rules:
            home = [bid for bid, ms in member_sets.items() if r["items"] <= ms]
            if not home:
                false.append(r)
                continue
            bid = home[0]
            got = band_of(bands, r["support"], r["confidence"], r["lift"])
            cur = best.get(bid)
            if cur is None or (r["confidence"], r["support"]) > (cur["confidence"], cur["support"]):
                best[bid] = dict(r, got=got)
        label = "network" if scope == truth["central_warehouse"] else "warehouse"
        ok = sum(1 for bid, b in bundles.items()
                 if (b["band"] == "below" and bid not in best) or (bid in best and best[bid]["got"] == b["band"]))
        print(f"  {scope} ({label}): {len(rules)} rules | bundles as planted {ok}/{len(bundles)} | false rules {len(false)}")
        for bid, b in bundles.items():
            if bid in best:
                r = best[bid]
                mark = "ok  " if r["got"] == b["band"] else "band"
                print(f"    {bid} {b['band']:<8} {mark} {'+'.join(names.get(x, x)[:18] for x in r['ants'])} -> "
                      f"{names.get(r['cons'], r['cons'])[:18]}: sup {r['support']:.3f} conf {r['confidence']:.2f} "
                      f"lift {r['lift']:.1f} => {r['got']} (UC1 says {r['uc1_strength']})")
            else:
                print(f"    {bid} {b['band']:<8} {'ok   not found, as intended' if b['band'] == 'below' else 'MISSED'}")
        for r in false[:a.show_false]:
            print(f"    FALSE: {'+'.join(names.get(x, x)[:18] for x in r['ants'])} -> {names.get(r['cons'], r['cons'])[:18]}"
                  f" (sup {r['support']:.3f}, conf {r['confidence']:.2f}, lift {r['lift']:.1f}, {r['uc1_strength']})")
        if len(false) > a.show_false:
            print(f"    ... {len(false) - a.show_false} more false rules")
        summary.append((scope, len(rules), ok, len(false)))

    print("\n  summary        rules   bundles as planted   false rules")
    for scope, n, ok, nf in summary:
        print(f"    {scope:<8} {n:>8}   {ok:>6}/{len(bundles):<10}   {nf:>6}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
