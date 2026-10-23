"""Load simulated CSVs into the MedFlow database -- ONLY the tables the simulator owns.

    python -m scripts.sim.load --profile full                                  # dry run (default)
    python -m scripts.sim.load --profile full --apply --confirm-host <host>    # really load

Uses DATABASE_URL from .env.local (or the older SUPABASE_DB_* values).

What it may do (scripts/sim/db.py has the lists):
  replace       warehouseproduct, orders, orderline, inventory, stocktransfer,
                stocktransferline   -- TRUNCATE (no CASCADE) and COPY the CSVs in
  empty         consumption, uc2_policy_parameters -- derived; UC2 rebuilds them
  insert only   site -- new hospitals only, existing rows are never changed
Never touched: aisle bin product rack shelf storage user_roles warehouse zone,
layoutrecommendation, modelrun, productrelationship(+antecedent), uc2_settings,
uc2_settings_history, demand, replenishmentrecommendation, and everything else.
No DROP, CREATE, ALTER or CASCADE on any of your tables.

DRY RUN (default) -- reads only, writes nothing. It checks that:
  * the target tables exist and have every column the CSVs carry
  * no table outside the replace/empty set has a foreign key into it
  * product ids are exactly MED0001..MED{n} and exist in product
  * warehouses exist with the right roles; orders only go to subsidiaries
  * WH001 inventory rows each name an ACTIVE WH001 bin; a bin holds ONE product (a product
    may hold several bins); the bin is in the zone its velocity class belongs to; the stock
    in a bin never exceeds what the bin can hold (carton size and weight against the bin
    table AS IT IS); subsidiary rows have binid NULL
  * order quantities are whole cartons (storage.shippingcasepack)
  * delivery rows point at their order; every hospital exists or is new
and prints what would be deleted and inserted, and the database size before/after.

--apply -- everything above, then in ONE transaction: fingerprint the protected tables,
TRUNCATE the replace/empty set, insert new sites, COPY the CSVs, re-check the rules in SQL,
fingerprint again (must be identical) and COMMIT. Any failure rolls back.
--confirm-host must name the database host, so a load can never land on the wrong project.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import sys
import time
from collections import defaultdict
from pathlib import Path

from scripts.sim import db
from scripts.sim.generate import LOAD_ORDER, REPO_ROOT, TABLE_COLUMNS
from scripts.sim.masters import Bin, cartons_per_bin


def q(table: str) -> str:
    """Quote a table name -- and refuse any table the loader is not allowed to write."""
    if table not in db.ALLOWED:
        raise RuntimeError(f"refusing to write {table!r}: not in scripts/sim/db.py's allowed tables")
    return f'public."{table}"'


def read_csv_checks(data: Path, truth: dict) -> tuple[list[str], dict[str, int]]:
    """Stream every CSV once and check the rules that need no database. -> (problems, row counts)."""
    problems: list[str] = []
    counts: dict[str, int] = {}
    lo, hi = truth["product_range"]
    prod = {p["productid"]: p for p in truth["products"]}
    cw = truth["central_warehouse"]
    subs = {w["id"] for w in truth["warehouses"]}
    used_products: set[str] = set()
    used_sites: set[str] = set()
    bin_owner: dict[str, str] = {}
    bin_max: dict[str, int] = defaultdict(int)
    cw_products: set[str] = set()
    bad: dict[str, int] = defaultdict(int)

    for t in LOAD_ORDER:
        with open(data / f"{t}.csv", encoding="utf-8", newline="") as f:
            r = csv.reader(f)
            header = next(r)
            if tuple(header) != TABLE_COLUMNS[t]:
                problems.append(f"{t}.csv columns {header} != expected {list(TABLE_COLUMNS[t])}")
                continue
            col = {c: i for i, c in enumerate(header)}
            n = 0
            for row in r:
                n += 1
                if "productid" in col:
                    used_products.add(row[col["productid"]])
                if t == "inventory":
                    w, b, p = row[col["warehouseid"]], row[col["binid"]], row[col["productid"]]
                    if w == cw:
                        cw_products.add(p)
                        if not b:
                            bad["WH001 inventory rows without a bin"] += 1
                        else:
                            if bin_owner.setdefault(b, p) != p:
                                bad["bins holding more than one product"] += 1
                            bin_max[b] = max(bin_max[b], int(row[col["qtyonhand"]]))
                    elif b:
                        bad["subsidiary inventory rows with a bin"] += 1
                    if w != cw and w not in subs:
                        bad["inventory rows for an unknown warehouse"] += 1
                elif t == "orderline":
                    p, qty = row[col["productid"]], int(row[col["qtyordered"]])
                    pack = prod.get(p, {}).get("packs_per_carton", 1)
                    if qty <= 0 or qty % pack:
                        bad["order lines that are not whole cartons"] += 1
                elif t == "orders" and row[col["warehouseid"]] not in subs:
                    bad["orders not for a subsidiary warehouse"] += 1
                elif t == "warehouseproduct" and row[col["warehouseid"]] not in subs | {cw}:
                    bad["warehouseproduct rows for an unknown warehouse"] += 1
                elif t == "stocktransfer":
                    if row[col["sourcewarehouseid"]] not in subs:
                        bad["stocktransfer rows not from a subsidiary warehouse"] += 1
                    used_sites.add(row[col["siteid"]])
            counts[t] = n

    outside = sorted(used_products - set(prod))
    if outside:
        problems.append(f"product ids outside {lo}-{hi}: {', '.join(outside[:5])}" + (" ..." if len(outside) > 5 else ""))
    missing_cw = set(prod) - cw_products
    if missing_cw:
        problems.append(f"{len(missing_cw)} products have no WH001 inventory row")
    problems += [f"{v:,} {k}" for k, v in bad.items()]
    expected = truth.get("realised", {}).get("rows", {})
    short = [f"{t} {counts.get(t, 0):,}/{expected[t]:,}" for t in LOAD_ORDER
             if t in expected and counts.get(t) != expected[t]]
    if short:
        problems.append("CSV row counts differ from what generate wrote (interrupted run?): " + ", ".join(short))
    truth["_used_sites"] = used_sites
    truth["_bin_owner"] = bin_owner
    truth["_bin_max"] = dict(bin_max)
    return problems, counts


def db_checks(conn, truth: dict, data: Path) -> list[str]:
    """Schema and master checks against the live database (read-only queries)."""
    problems: list[str] = []
    targets = list(LOAD_ORDER) + list(db.EMPTIED_TABLES)
    cols: dict[str, set[str]] = defaultdict(set)
    for t, c in conn.execute("""SELECT table_name, column_name FROM information_schema.columns
                                WHERE table_schema = 'public' AND table_name = ANY(%s)""", (targets,)):
        cols[t].add(c)
    for t in targets:
        if t not in cols:
            problems.append(f"table {t} does not exist")
        elif t in TABLE_COLUMNS and not set(TABLE_COLUMNS[t]) <= cols[t]:
            problems.append(f"table {t} is missing columns {sorted(set(TABLE_COLUMNS[t]) - cols[t])}")
    if problems:
        return problems

    regs = [f"public.{t}" for t in db.TRUNCATE_SET]
    for src, dst, name in conn.execute("""SELECT c.conrelid::regclass::text, c.confrelid::regclass::text, c.conname
                                          FROM pg_constraint c WHERE c.contype = 'f'
                                            AND c.confrelid = ANY(%s::regclass[])
                                            AND NOT (c.conrelid = ANY(%s::regclass[]))""", (regs, regs)):
        problems.append(f"{src} has a foreign key ({name}) into {dst}; the truncate would be refused -- "
                        "the table lists in scripts/sim/db.py need updating first")

    prod = {p["productid"]: p for p in truth["products"]}
    ids = list(prod)
    have = {r[0] for r in conn.execute("SELECT productid FROM product WHERE productid = ANY(%s)", (ids,))}
    if len(have) != len(ids):
        problems.append(f"{len(ids) - len(have)} product ids are missing from the product table")

    roles = dict(conn.execute("SELECT warehouseid, warehouserole FROM warehouse").fetchall())
    cw = truth["central_warehouse"]
    if roles.get(cw) != "CENTRAL":
        problems.append(f"{cw} is not CENTRAL in the warehouse table")
    for w in truth["warehouses"]:
        if roles.get(w["id"]) != "SUBSIDIARY":
            problems.append(f"{w['id']} is not SUBSIDIARY in the warehouse table")

    # bins: exist, ACTIVE, in the right zone, and big enough for what the CSV puts in them
    bins = {r[0]: Bin(r[0], r[0].split("-")[0], float(r[1] or 0), float(r[2] or 0), float(r[3] or 0), float(r[4] or 0))
            for r in conn.execute("SELECT binid, lengthcm, widthcm, heightcm, maxweightkg FROM bin "
                                  "WHERE warehouseid = %s AND upper(status) = 'ACTIVE'", (cw,))}
    stor = {r[0]: r for r in conn.execute(
        'SELECT productid, shippingcasepack, "Length_mm", "Width_mm", "Height_mm", casegrossweight_kg '
        'FROM storage WHERE productid = ANY(%s)', (ids,))}
    zone_of = truth["central"]["zone_by_class"]
    not_there, wrong_zone, too_full, examples = 0, 0, 0, []
    for b, p in truth["_bin_owner"].items():
        if b not in bins:
            not_there += 1
            continue
        if bins[b].zoneid != zone_of.get(prod[p]["tier"]):
            wrong_zone += 1
        s = stor.get(p)
        if s:
            spec = {"case_l_cm": float(s[2] or 0) / 10, "case_w_cm": float(s[3] or 0) / 10,
                    "case_h_cm": float(s[4] or 0) / 10, "case_kg": float(s[5] or 0)}
            cap = cartons_per_bin(spec, bins[b]) * int(s[1] or 1)
            if truth["_bin_max"].get(b, 0) > cap:
                too_full += 1
                if len(examples) < 2:
                    examples.append(f"{b} holds up to {truth['_bin_max'][b]:,} packs of {p}, "
                                    f"the bin table allows {cap:,} ({bins[b].max_weight_kg:g} kg limit)")
    if not_there:
        problems.append(f"{not_there} WH001 bins in the CSV are not ACTIVE {cw} bins")
    if wrong_zone:
        problems.append(f"{wrong_zone} bins are outside the zone of their product's velocity class")
    if too_full:
        problems.append(f"{too_full} bins would hold more than the bin table allows, e.g. {'; '.join(examples)} "
                        "-- the data was generated with a higher bin weight limit than the table has")

    existing = dict(conn.execute("SELECT siteid, warehouseid FROM site").fetchall())
    new_sites = {}
    with open(data / "site.csv", encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            new_sites[row["siteid"]] = row["warehouseid"]
            if row["siteid"] in existing and existing[row["siteid"]] != row["warehouseid"]:
                problems.append(f"site {row['siteid']} exists for {existing[row['siteid']]}, CSV says {row['warehouseid']}")
    unknown = sorted(truth["_used_sites"] - set(existing) - set(new_sites))
    if unknown:
        problems.append(f"{len(unknown)} hospitals in stocktransfer.csv exist neither in site nor in site.csv, "
                        f"e.g. {unknown[0]}")
    return problems


def fingerprint(conn, tables) -> dict[str, tuple[int, str]]:
    """Row count + content hash of each table, to prove it was not changed."""
    out = {}
    present = {r[0] for r in conn.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'")}
    for t in tables:
        if t in present:
            out[t] = conn.execute(f"SELECT count(*), md5(coalesce(string_agg(md5(x::text), '' "
                                  f"ORDER BY md5(x::text)), '')) FROM public.\"{t}\" x").fetchone()
    return out


SQL_CHECKS = [
    ("product ids in range",
     "SELECT count(*) FROM (SELECT productid FROM inventory UNION SELECT productid FROM orderline "
     "UNION SELECT productid FROM stocktransferline UNION SELECT productid FROM warehouseproduct) x "
     "WHERE NOT (productid = ANY(%(ids)s))"),
    ("WH001 rows have a WH001 bin",
     "SELECT count(*) FROM inventory i LEFT JOIN bin b ON b.binid = i.binid AND b.warehouseid = i.warehouseid "
     "WHERE i.warehouseid = %(cw)s AND b.binid IS NULL"),
    ("a bin holds one product",
     "SELECT count(*) FROM (SELECT binid FROM inventory WHERE warehouseid = %(cw)s "
     "GROUP BY binid HAVING count(DISTINCT productid) <> 1) x"),
    ("bin stock within the bin's weight and volume",
     "SELECT count(*) FROM (SELECT i.binid, i.productid, max(i.qtyonhand) AS q FROM inventory i "
     "WHERE i.warehouseid = %(cw)s GROUP BY 1, 2) m JOIN bin b ON b.binid = m.binid "
     "JOIN storage s ON s.productid = m.productid "
     "WHERE ceil(m.q::numeric / s.shippingcasepack) * s.casegrossweight_kg > b.maxweightkg + 1e-6 "
     "   OR ceil(m.q::numeric / s.shippingcasepack) * s.\"Length_mm\" * s.\"Width_mm\" * s.\"Height_mm\" / 1000.0 "
     "      > b.capacityvolume + 1e-6"),
    ("subsidiary rows have binid NULL",
     "SELECT count(*) FROM inventory WHERE warehouseid <> %(cw)s AND binid IS NOT NULL"),
    ("orders only to subsidiaries",
     "SELECT count(*) FROM orders o JOIN warehouse w USING (warehouseid) WHERE w.warehouserole <> 'SUBSIDIARY'"),
    ("order lines are whole cartons",
     "SELECT count(*) FROM orderline l JOIN storage s USING (productid) "
     "WHERE l.qtyordered <= 0 OR l.qtyordered %% s.shippingcasepack <> 0"),
    ("delivery rows point at their order",
     "SELECT count(*) FROM inventory i LEFT JOIN orders o USING (orderid) "
     "WHERE i.orderid IS NOT NULL AND (o.orderid IS NULL OR o.warehouseid <> i.warehouseid)"),
]


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profile", default="full")
    ap.add_argument("--data", default=None, help="default: data/sim/<profile>")
    ap.add_argument("--apply", action="store_true", help="really load (default is a dry run)")
    ap.add_argument("--confirm-host", default=None, help="required with --apply: the database host")
    a = ap.parse_args(argv)

    data = Path(a.data) if a.data else REPO_ROOT / "data" / "sim" / a.profile
    missing = [t for t in LOAD_ORDER if not (data / f"{t}.csv").exists()]
    if missing or not (data / "ground_truth.json").exists():
        print(f"  {data} is incomplete ({', '.join(missing) or 'ground_truth.json'}) -- run scripts.sim.generate first")
        return 1
    truth = json.loads((data / "ground_truth.json").read_text(encoding="utf-8"))
    if "cw_bins" not in truth["products"][0]:
        print("  this data was made by an older simulator -- regenerate it with scripts.sim.generate")
        return 1
    host = db.host()
    print(f"  database host: {host}")
    print(f"  data: {data}  ({truth['n_skus']:,} products {truth['product_range'][0]}-{truth['product_range'][1]}, "
          f"{truth['days']} days to {truth['end_date']})")
    if a.apply and a.confirm_host != host:
        print(f"  REFUSING: --apply needs --confirm-host {host}")
        return 1

    t0 = time.time()
    print("\n  checking the CSVs ...")
    problems, counts = read_csv_checks(data, truth)

    with db.connect(read_only=not a.apply) as conn:
        print("  checking the database ...")
        problems += db_checks(conn, truth, data)
        if any("does not exist" in p or "missing columns" in p for p in problems):
            print("\n  PROBLEMS -- nothing was written:")
            for p in problems:
                print(f"    - {p}")
            return 1

        sizes = dict(conn.execute("""SELECT relname, pg_total_relation_size(c.oid) FROM pg_class c
                                     JOIN pg_namespace n ON n.oid = c.relnamespace
                                     WHERE n.nspname = 'public' AND relname = ANY(%s)""", (list(db.TRUNCATE_SET),)))
        rows_now = {t: conn.execute(f'SELECT count(*) FROM public."{t}"').fetchone()[0]
                    for t in db.TRUNCATE_SET + db.INSERT_ONLY_TABLES}
        db_size = conn.execute("SELECT pg_database_size(current_database())").fetchone()[0]
        csv_bytes = sum((data / f"{t}.csv").stat().st_size for t in LOAD_ORDER)
        est = db_size - sum(sizes.values()) + 2.6 * csv_bytes   # tables + indexes ~ 2.6x the CSV (measured)

        print(f"\n  {'table':<24}{'rows now':>14}{'after load':>14}   action")
        for t in db.TRUNCATE_SET + db.INSERT_ONLY_TABLES:
            action = ("replace" if t in db.WRITE_TABLES else "empty (UC2 rebuilds)" if t in db.EMPTIED_TABLES
                      else "insert new only")
            after = (counts.get(t, 0) if t in db.WRITE_TABLES else 0 if t in db.EMPTIED_TABLES
                     else rows_now[t] + counts.get(t, 0))
            print(f"  {t:<24}{rows_now[t]:>14,}{after:>14,}   {action}")
        print("  every other table: not touched")
        print(f"\n  database size now {db_size / 1e6:,.0f} MB; after load roughly {est / 1e6:,.0f} MB "
              "(check your Supabase plan's limit)")

        if problems:
            print("\n  PROBLEMS -- nothing was written:")
            for p in problems:
                print(f"    - {p}")
            return 1
        print(f"\n  all checks passed ({time.time() - t0:,.0f}s)")

        if not a.apply:
            print("  dry run: nothing was written. To load:\n"
                  f"    python -m scripts.sim.load --profile {truth['profile']} --apply --confirm-host {host}")
            return 0

        # ---------------- apply: one transaction --------------------------------
        conn.execute("SET LOCAL statement_timeout = 0")
        conn.execute("SET LOCAL lock_timeout = '60s'")
        print("\n  fingerprinting protected tables ...")
        before = fingerprint(conn, db.PROTECTED)
        print("  truncating: " + ", ".join(db.TRUNCATE_SET))
        conn.execute("TRUNCATE TABLE " + ", ".join(q(t) for t in db.TRUNCATE_SET))   # no CASCADE

        for t in LOAD_ORDER:
            cols = ", ".join(TABLE_COLUMNS[t])
            t1 = time.time()
            with open(data / f"{t}.csv", "rb") as f, conn.cursor() as cur:
                if t in db.INSERT_ONLY_TABLES:
                    cur.execute(f"CREATE TEMP TABLE _new_{t} (LIKE {q(t)}) ON COMMIT DROP")
                    with cur.copy(f"COPY _new_{t} ({cols}) FROM STDIN WITH (FORMAT csv, HEADER true)") as cp:
                        while chunk := f.read(1 << 20):
                            cp.write(chunk)
                    cur.execute(f"INSERT INTO {q(t)} ({cols}) SELECT {cols} FROM _new_{t} ON CONFLICT DO NOTHING")
                else:
                    with cur.copy(f"COPY {q(t)} ({cols}) FROM STDIN WITH (FORMAT csv, HEADER true)") as cp:
                        while chunk := f.read(1 << 20):
                            cp.write(chunk)
                n = cur.rowcount
            print(f"    {t:<18} {n:>12,} rows  ({time.time() - t1:,.1f}s)")

        print("  re-checking the rules in SQL ...")
        params = {"ids": [p["productid"] for p in truth["products"]], "cw": truth["central_warehouse"]}
        failed = []
        for name, sql in SQL_CHECKS:
            k = conn.execute(sql, params).fetchone()[0]
            print(f"    [{'PASS' if k == 0 else 'FAIL'}] {name}" + (f": {k:,} violations" if k else ""))
            if k:
                failed.append(name)
        after = fingerprint(conn, db.PROTECTED)
        changed = [t for t in before if before[t] != after.get(t)]
        print(f"    [{'PASS' if not changed else 'FAIL'}] protected tables unchanged ({len(before)} checked)"
              + (f": CHANGED {', '.join(changed)}" if changed else ""))
        if failed or changed:
            conn.rollback()
            print("\n  ROLLED BACK -- the database is exactly as it was")
            return 1
        conn.commit()

    with db.connect(read_only=False) as conn:
        conn.autocommit = True
        for t in db.TRUNCATE_SET:
            conn.execute(f"ANALYZE {q(t)}")
    print(f"\n  loaded and committed ({time.time() - t0:,.0f}s).")
    print(f"  next: python -m scripts.sim.check --profile {truth['profile']}, "
          "python -m engines.uc2.service_levels, then python -m engines.uc2.replenishment --rebuild --direct")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
