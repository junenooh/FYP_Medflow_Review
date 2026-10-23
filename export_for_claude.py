"""Bundle the MedFlow repo + read-only database checks into one zip for Claude.

    python export_for_claude.py              # repo files + database query results
    python export_for_claude.py --no-db      # repo files only
    python export_for_claude.py --max-mb 2   # skip files bigger than 2 MB (default 5)

Put this file in the repo root and run it from there.

What it does
  1. Connects with DATABASE_URL from .env.local (or the older SUPABASE_DB_* values)
     and runs every query inside ONE read-only transaction that is rolled back at
     the end, so nothing can be written. Each result is saved as a CSV in the zip
     under db_export/.
  2. Zips the repo, leaving out .env* files, key files, generated simulator data
     (data/), virtualenvs, node_modules, .git, caches and other zips.
  3. Scans every text file it would include for anything that looks like a
     credential (Supabase JWT keys, sb_secret_ keys, non-local connection strings
     with a password). Those files are LEFT OUT and listed, so you can check them.

Credentials are only read on your machine. Nothing from .env.local goes into the zip.
"""

from __future__ import annotations

import argparse
import csv
import io
import os
import re
import sys
import zipfile
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent

EXCLUDE_DIRS = {
    ".git", "node_modules", ".venv", "venv", "env", "__pycache__", ".pytest_cache",
    ".mypy_cache", ".ruff_cache", ".next", ".turbo", ".idea", ".vscode", "dist", "build",
    ".temp", ".branches",
}
EXCLUDE_TOP_DIRS = {"data"}            # data/sim = generated simulator output (up to GBs)
EXCLUDE_SUFFIXES = {".zip", ".pyc", ".pyo", ".sqlite", ".db", ".dump", ".bak"}
KEY_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".crt"}
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}

JWT_RE = re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}")
SB_SECRET_RE = re.compile(r"sb_secret_[A-Za-z0-9_-]{10,}")
CONN_RE = re.compile(r"postgres(?:ql)?://[^:\s/@]+:([^@\s]+)@([^:/\s?\"']+)")

# --------------------------------------------------------------------------
# Read-only queries. Each becomes db_export/<name>.csv
# --------------------------------------------------------------------------
QUERIES = {
    "01_columns": """
        select table_name, column_name, data_type, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public'
        order by table_name, ordinal_position""",

    "02_constraints": """
        select conrelid::regclass::text as table_name, conname as constraint_name,
               case contype when 'p' then 'PRIMARY KEY' when 'f' then 'FOREIGN KEY'
                            when 'u' then 'UNIQUE' when 'c' then 'CHECK'
                            else contype::text end as type,
               pg_get_constraintdef(oid) as definition
        from pg_constraint
        where connamespace = 'public'::regnamespace
        order by 1, 3, 2""",

    "03_indexes": """
        select tablename, indexname, indexdef
        from pg_indexes
        where schemaname = 'public'
        order by 1, 2""",

    "04_trigger_functions": """
        select distinct c.relname as table_name, t.tgname as trigger_name,
               p.proname as function_name, pg_get_functiondef(p.oid) as definition
        from pg_trigger t
        join pg_class c on c.oid = t.tgrelid
        join pg_proc p on p.oid = t.tgfoid
        where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
        order by 1, 2""",

    "05_checks": """
        select 'warehouses' as check_name,
               string_agg(warehouseid::text, ', ' order by warehouseid) as result
        from warehouse
        union all
        select 'bins per warehouse', string_agg(w || ': ' || c, ', ' order by w)
        from (select coalesce(warehouseid::text, 'NULL') w, count(*)::text c
              from bin group by 1) x
        union all
        select 'zones / aisles / racks / shelves',
               (select count(*) from zone)::text || ' / ' || (select count(*) from aisle)
               || ' / ' || (select count(*) from rack) || ' / ' || (select count(*) from shelf)
        union all
        select 'products MED0001-MED1000 present', count(*)::text
        from product
        where productid ~ '^MED[0-9]{4}$' and substring(productid from 4)::int between 1 and 1000
        union all
        select 'sites per warehouse', string_agg(w || ': ' || c, ', ' order by w)
        from (select warehouseid::text w, count(*)::text c from site group by 1) x
        union all
        select 'WH001 products with a bin / max bins per product',
               count(*)::text || ' / ' || coalesce(max(c), 0)
        from (select productid, count(distinct binid) c from inventory
              where warehouseid = 'WH001' and binid is not null group by productid) x""",

    "06_products_med0001_med1000": """
        select * from product
        where productid ~ '^MED[0-9]{4}$' and substring(productid from 4)::int between 1 and 1000
        order by productid""",

    "07_sites": "select * from site order by 1",
    "08_warehouses": "select * from warehouse order by 1",
    "09_bins": "select * from bin order by 1",

    "12_storage": "select * from storage order by productid",
    "13_zones": "select * from zone order by zoneid",
    "14_shelf_limits": "select maxweightkg, capacityvolume, count(*) from shelf group by 1, 2 order by 1, 2",

    "10_wh001_product_bins": """
        select productid, binid, count(*) as ledger_rows
        from inventory
        where warehouseid = 'WH001' and binid is not null
        group by 1, 2
        order by 1, 2""",
}


# --------------------------------------------------------------------------
# Database part
# --------------------------------------------------------------------------
def db_settings() -> tuple[dict, str] | None:
    try:
        from dotenv import dotenv_values
    except ImportError:
        raise SystemExit("  python-dotenv is missing: python -m pip install python-dotenv")
    env = {k: v for k, v in dotenv_values(ROOT / ".env.local").items() if v}
    dsn = (env.get("DATABASE_URL") or "").strip()
    if dsn:
        return {"conninfo": dsn}, (urlparse(dsn).hostname or "?")
    if env.get("SUPABASE_DB_HOST") and env.get("SUPABASE_DB_PASSWORD"):
        kw = dict(host=env["SUPABASE_DB_HOST"], port=env.get("SUPABASE_DB_PORT", "6543"),
                  dbname=env.get("SUPABASE_DB_NAME", "postgres"),
                  user=env.get("SUPABASE_DB_USER", "postgres"),
                  password=env["SUPABASE_DB_PASSWORD"], sslmode="require")
        return kw, kw["host"]
    return None


def connect(settings: dict):
    conninfo = settings.get("conninfo")
    kw = {k: v for k, v in settings.items() if k != "conninfo"}
    try:
        import psycopg
        return psycopg.connect(conninfo or "", autocommit=True, **kw)
    except ImportError:
        import psycopg2
        conn = psycopg2.connect(conninfo, **kw) if conninfo else psycopg2.connect(**kw)
        conn.autocommit = True
        return conn


def to_csv(cur) -> tuple[str, int]:
    cols = [d[0] for d in cur.description]
    rows = cur.fetchall()
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(cols)
    w.writerows(rows)
    return buf.getvalue(), len(rows)


def run_queries(settings: dict) -> dict[str, str]:
    out: dict[str, str] = {}
    conn = connect(settings)
    try:
        cur = conn.cursor()
        # one READ ONLY transaction, rolled back at the end: nothing can be written
        cur.execute("BEGIN TRANSACTION READ ONLY")
        cur.execute("SET LOCAL statement_timeout = '120s'")

        def attempt(name: str, sql: str) -> None:
            cur.execute("SAVEPOINT q")
            try:
                cur.execute(sql)
                text, n = to_csv(cur)
                cur.execute("RELEASE SAVEPOINT q")
                out[f"{name}.csv"] = text
                print(f"    {name:<32} {n:>8,} rows")
            except Exception as e:                    # keep going; record the error
                cur.execute("ROLLBACK TO SAVEPOINT q")
                out[f"{name}.error.txt"] = f"{type(e).__name__}: {e}\n"
                print(f"    {name:<32}   FAILED ({type(e).__name__}) -- saved the error")

        for name, sql in QUERIES.items():
            attempt(name, sql)

        # exact row counts (pg_stat_user_tables is only an estimate)
        cur.execute("""select table_name from information_schema.tables
                       where table_schema = 'public' and table_type = 'BASE TABLE'
                       order by 1""")
        tables = [r[0] for r in cur.fetchall()]
        union = "\nunion all\n".join(
            f"select '{t.replace(chr(39), chr(39) * 2)}' as table_name, count(*) as exact_rows "
            f"from public.\"{t.replace(chr(34), chr(34) * 2)}\"" for t in tables)
        if union:
            attempt("11_exact_row_counts", union + "\norder by 1")

        cur.execute("ROLLBACK")
    finally:
        conn.close()
    return out


# --------------------------------------------------------------------------
# Repo part
# --------------------------------------------------------------------------
def iter_files(root: Path):
    for dirpath, dirnames, filenames in os.walk(root):
        rel_dir = Path(dirpath).relative_to(root)
        dirnames[:] = sorted(d for d in dirnames
                             if d not in EXCLUDE_DIRS
                             and not (rel_dir == Path(".") and d in EXCLUDE_TOP_DIRS))
        for f in sorted(filenames):
            yield Path(dirpath) / f


def secret_reason(text: str) -> str | None:
    if JWT_RE.search(text):
        return "looks like a Supabase/JWT key"
    if SB_SECRET_RE.search(text):
        return "looks like an sb_secret_ key"
    for m in CONN_RE.finditer(text):
        pw, host = m.group(1), m.group(2).lower()
        if host not in LOCAL_HOSTS and not pw.startswith(("<", "$", "{", "[", "*")):
            return f"connection string with a password for {host}"
    return None


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--no-db", action="store_true", help="skip the database queries")
    ap.add_argument("--max-mb", type=float, default=5.0, help="skip files bigger than this")
    a = ap.parse_args(argv)

    stamp = datetime.now().strftime("%Y%m%d_%H%M")
    zip_path = ROOT / f"medflow_for_claude_{stamp}.zip"
    max_bytes = int(a.max_mb * 1024 * 1024)

    db_files: dict[str, str] = {}
    if not a.no_db:
        found = db_settings()
        if found is None:
            print("  no DATABASE_URL (or SUPABASE_DB_*) in .env.local -- skipping the database part")
        else:
            settings, host = found
            print(f"  querying {host} (read-only transaction, rolled back at the end)")
            db_files = run_queries(settings)

    included, skipped_env, skipped_secret, skipped_large = [], [], [], []
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in iter_files(ROOT):
            rel = path.relative_to(ROOT).as_posix()
            name, suffix = path.name, path.suffix.lower()
            if path == zip_path or name == ".DS_Store" or suffix in EXCLUDE_SUFFIXES:
                continue
            if name.startswith(".env") or suffix in KEY_SUFFIXES:
                skipped_env.append(rel)
                continue
            size = path.stat().st_size
            if size > max_bytes:
                skipped_large.append(f"{rel} ({size / 1e6:,.1f} MB)")
                continue
            data = path.read_bytes()
            if b"\0" not in data[:8192]:                       # text file: scan it
                reason = secret_reason(data.decode("utf-8", errors="ignore"))
                if reason:
                    skipped_secret.append(f"{rel} -- {reason}")
                    continue
            zf.writestr(f"medflow/{rel}", data)
            included.append(rel)
        for fname, text in db_files.items():
            zf.writestr(f"medflow/db_export/{fname}", text)

    print(f"\n  wrote {zip_path.name}: {len(included):,} repo files"
          f" + {len(db_files)} database exports, {zip_path.stat().st_size / 1e6:,.1f} MB")
    if skipped_env:
        print("\n  left out (env / key files):")
        for s in skipped_env:
            print(f"    {s}")
    if skipped_secret:
        print("\n  LEFT OUT because they look like they contain credentials -- check these:")
        for s in skipped_secret:
            print(f"    {s}")
    if skipped_large:
        print(f"\n  left out (bigger than {a.max_mb:g} MB):")
        for s in skipped_large:
            print(f"    {s}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))