"""Per-product service levels for UC2: criticality class -> z-score override.

    python -m engines.uc2.service_levels                 # dry run: prints the mapping, writes nothing
    python -m engines.uc2.service_levels --apply         # writes the overrides into uc2_settings
    python -m engines.uc2.service_levels --csv reports/service_levels.csv   # the full table for review

Reads product (read-only) and the "service_levels" block of shared_config.json: each product's
category (and, for inhalers and nebules, its productclassification) maps to a class, and each
class to a service level and z-score. --apply writes one product-scoped override per product
through UC2's own uc2_set_service_level function (uc2-3.3), which uc2_compute_parameters
already honours; the audit trigger logs every change. Rerun after the mapping changes.

Only uc2_settings (and, through its trigger, uc2_settings_history) is written: UC2's own tables.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from collections import Counter
from pathlib import Path

from scripts.sim import db

REPO_ROOT = db.REPO_ROOT


def classify(product: dict, cfg: dict) -> str:
    by_form = cfg.get("by_classification", {})
    form = (product.get("productclassification") or "").upper()
    if form in by_form:
        return by_form[form]
    return cfg["by_category"].get(product["category"], cfg.get("default_class", "Essential"))


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true", help="write the overrides (default: dry run)")
    ap.add_argument("--csv", default=None, help="write the per-product table to this file")
    a = ap.parse_args(argv)

    cfg = json.loads((REPO_ROOT / "shared_config.json").read_text(encoding="utf-8")).get("service_levels")
    if not cfg:
        print("  shared_config.json has no service_levels block")
        return 1
    classes = cfg["classes"]

    with db.connect(read_only=not a.apply) as conn:
        print(f"  database host: {db.host()}")
        rows = conn.execute("SELECT productid, productname, category, productclassification FROM product "
                            "WHERE status IS NULL OR status <> 'Discontinued' ORDER BY productid").fetchall()
        products = [dict(productid=r[0], name=r[1], category=r[2], productclassification=r[3]) for r in rows]
        table = []
        for p in products:
            cls = classify(p, cfg)
            if cls not in classes:
                print(f"  class {cls!r} for {p['productid']} has no z-score in the config")
                return 1
            table.append(dict(p, cls=cls, service_level=classes[cls]["service_level"], z=classes[cls]["z"]))

        counts = Counter(t["cls"] for t in table)
        print(f"  {len(table):,} products -> " + ", ".join(
            f"{k} {counts[k]:,} ({classes[k]['service_level']:.1%}, z {classes[k]['z']})" for k in classes))
        unknown = sorted({t["category"] for t in table} - set(cfg["by_category"]))
        if unknown:
            print(f"  categories not in the mapping (given the default class {cfg.get('default_class')}): "
                  + ", ".join(unknown))

        if a.csv:
            out = Path(a.csv)
            out.parent.mkdir(parents=True, exist_ok=True)
            with open(out, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["productid", "productname", "category", "productclassification", "class",
                            "service_level", "z"])
                for t in table:
                    w.writerow([t["productid"], t["name"], t["category"], t["productclassification"], t["cls"],
                                t["service_level"], t["z"]])
            print(f"  written: {out}")

        if not a.apply:
            print("  dry run: nothing written. Add --apply to write the overrides into uc2_settings.")
            return 0

        version = conn.execute("SELECT public.uc2_schema_version()").fetchone()[0]
        if version < "uc2-3.3":
            print(f"  UC2 is at {version}; run python -m engines.uc2.migrate first (needs uc2-3.3)")
            conn.rollback()
            return 1
        with conn.cursor() as cur:
            cur.executemany("SELECT public.uc2_set_service_level(%s, %s, %s, %s)",
                            [(t["productid"], t["z"], f"{t['cls']}: {t['service_level']:.1%} service level",
                              "service_levels") for t in table])
        conn.commit()
        print(f"  written: {len(table):,} product-scoped z overrides in uc2_settings. "
              "Run python -m engines.uc2.replenishment --rebuild --direct to recompute the policy.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
