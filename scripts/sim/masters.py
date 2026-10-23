"""The master data the simulator builds on -- READ ONLY.

The simulator never invents products, packaging, warehouses, bins or hospitals. It reads
them from the database (product, storage, warehouse, bin, zone, shelf, site) and generates
activity against those real ids. Nothing here writes anything.

Two sources:
    from the database      masters.from_db(...)       (default)
    from CSV exports       masters.from_export(dir)   (a db_export/ folder plus
                           product_rows.csv / storage_rows.csv / zone_rows.csv; offline tests)
"""

from __future__ import annotations

import csv
import itertools
import math
from dataclasses import dataclass, field
from pathlib import Path

from scripts.sim import db


@dataclass
class Bin:
    binid: str
    zoneid: str
    length_cm: float
    width_cm: float
    height_cm: float
    max_weight_kg: float


@dataclass
class Masters:
    products: list[dict]                  # the required ids, in order (see _norm_product)
    warehouses: dict[str, str]            # warehouseid -> warehouserole
    cw_bins: list[Bin]                    # ACTIVE bins of the central warehouse, in id order
    sites: dict[str, list[dict]] = field(default_factory=dict)   # SW id -> its sites
    shelf_limits: dict = field(default_factory=dict)             # distinct shelf maxweightkg -> count
    source: str = ""

    def bins_by_zone(self) -> dict[str, list[Bin]]:
        out: dict[str, list[Bin]] = {}
        for b in self.cw_bins:
            out.setdefault(b.zoneid, []).append(b)
        return out


def cartons_per_bin(p: dict, b: Bin) -> int:
    """How many of this product's cartons fit in this bin: by size (any orientation) and by weight."""
    dims = (p["case_l_cm"], p["case_w_cm"], p["case_h_cm"])
    by_size = 0
    for a, bb, c in itertools.permutations(dims):
        if a <= 0 or bb <= 0 or c <= 0:
            continue
        by_size = max(by_size, int(b.length_cm // a) * int(b.width_cm // bb) * int(b.height_cm // c))
    by_weight = int(b.max_weight_kg // p["case_kg"]) if p["case_kg"] > 0 else by_size
    return max(0, min(by_size, by_weight))


def _norm_product(r: dict, s: dict) -> dict:
    """Merge a product row with its storage row into the fields the simulator uses."""
    def f(key, default=0.0):
        v = s.get(key)
        return float(v) if v not in (None, "") else default
    return {
        "productid": r["productid"], "name": r["productname"], "category": r["category"],
        "classification": r.get("productclassification", ""), "tier": r["velocityclass"],
        "annual_units": float(r["manualbasedemand"] or 0), "unitcostsgd": float(r["unitcostsgd"] or 0),
        "shelflife_days": int(float(r["shelflife_days"] or 720)), "status": r.get("status", ""),
        "pack_units": max(1, int(float(s["salespackqty"] or 1))),         # dosage units per sales pack
        "packs_per_carton": max(1, int(float(s["shippingcasepack"] or 1))),
        "case_l_cm": f("Length_mm") / 10, "case_w_cm": f("Width_mm") / 10, "case_h_cm": f("Height_mm") / 10,
        "case_kg": f("casegrossweight_kg"),
    }


def _check(m: Masters, want_ids: list[str], central: str, subsidiaries: list[str]) -> Masters:
    have = {p["productid"] for p in m.products}
    missing = sorted(set(want_ids) - have)
    if missing:
        raise SystemExit(f"  product/storage tables are missing {len(missing)} of the required ids, "
                         f"e.g. {', '.join(missing[:5])}")
    if m.warehouses.get(central) != "CENTRAL":
        raise SystemExit(f"  {central} is not the CENTRAL warehouse in the warehouse table")
    bad = [w for w in subsidiaries if m.warehouses.get(w) != "SUBSIDIARY"]
    if bad:
        raise SystemExit(f"  not SUBSIDIARY warehouses in the warehouse table: {', '.join(bad)}")
    if not m.cw_bins:
        raise SystemExit(f"  {central} has no ACTIVE bins")
    return m


def from_db(want_ids: list[str], central: str, subsidiaries: list[str]) -> Masters:
    with db.connect(read_only=True) as conn:
        prod_cols = ("productid", "productname", "category", "productclassification", "velocityclass",
                     "manualbasedemand", "unitcostsgd", "shelflife_days", "status")
        prods = {r[0]: dict(zip(prod_cols, r)) for r in conn.execute(
            f"SELECT {', '.join(prod_cols)} FROM product WHERE productid = ANY(%s)", (want_ids,))}
        st_cols = ("productid", "salespackqty", "shippingcasepack", "Length_mm", "Width_mm", "Height_mm",
                   "casegrossweight_kg")
        stor = {r[0]: dict(zip(st_cols, r)) for r in conn.execute(
            'SELECT productid, salespackqty, shippingcasepack, "Length_mm", "Width_mm", "Height_mm", '
            'casegrossweight_kg FROM storage WHERE productid = ANY(%s)', (want_ids,))}
        products = [_norm_product(prods[i], stor[i]) for i in want_ids if i in prods and i in stor]
        whs = dict(conn.execute("SELECT warehouseid, warehouserole FROM warehouse").fetchall())
        bins = [Bin(b, z, float(l or 0), float(w or 0), float(h or 0), float(mw or 0))
                for b, z, l, w, h, mw in conn.execute(
                    """SELECT binid, split_part(binid, '-', 1), lengthcm, widthcm, heightcm, maxweightkg
                       FROM bin WHERE warehouseid = %s AND upper(status) = 'ACTIVE' ORDER BY binid""", (central,))]
        shelf = dict(conn.execute("SELECT maxweightkg, count(*) FROM shelf WHERE warehouseid = %s GROUP BY 1",
                                  (central,)).fetchall())
        sites: dict[str, list[dict]] = {}
        for sid, name, addr, w in conn.execute(
                "SELECT siteid, sitename, address, warehouseid FROM site ORDER BY siteid"):
            sites.setdefault(w, []).append({"siteid": sid, "sitename": name, "address": addr})
        conn.rollback()
    m = Masters(products, whs, bins, sites, shelf, f"database {db.host()}")
    return _check(m, want_ids, central, subsidiaries)


def from_export(folder: Path, want_ids: list[str], central: str, subsidiaries: list[str]) -> Masters:
    def rows(name):
        with open(folder / name, encoding="utf-8-sig", newline="") as f:
            return list(csv.DictReader(f))
    want = set(want_ids)
    prods = {r["productid"]: r for r in rows("product_rows.csv") if r["productid"] in want}
    stor = {r["productid"]: r for r in rows("storage_rows.csv") if r["productid"] in want}
    products = [_norm_product(prods[i], stor[i]) for i in want_ids if i in prods and i in stor]
    whs = {r["warehouseid"]: r["warehouserole"] for r in rows("08_warehouses.csv")}
    bins = sorted((Bin(r["binid"], r["binid"].split("-")[0], float(r["lengthcm"] or 0), float(r["widthcm"] or 0),
                       float(r["heightcm"] or 0), float(r["maxweightkg"] or 0))
                   for r in rows("09_bins.csv")
                   if r["warehouseid"] == central and r["status"].upper() == "ACTIVE"), key=lambda b: b.binid)
    sites: dict[str, list[dict]] = {}
    for r in sorted(rows("07_sites.csv"), key=lambda r: r["siteid"]):
        sites.setdefault(r["warehouseid"], []).append(
            {"siteid": r["siteid"], "sitename": r["sitename"], "address": r["address"]})
    m = Masters(products, whs, bins, sites, {}, f"export {folder}")
    return _check(m, want_ids, central, subsidiaries)
