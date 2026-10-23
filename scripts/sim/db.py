"""Database connection + the table rules every simulator script follows.

The rules (product owner, Oct 2026) are written down ONCE, here, and the other
scripts import them. Nothing in scripts/sim builds a statement against a table
outside WRITE_TABLES / INSERT_ONLY_TABLES / EMPTIED_TABLES.

    UNTOUCHED   aisle bin product rack shelf storage user_roles warehouse zone
                -- never written, truncated, dropped or altered. Read only.
    OUTPUTS     layoutrecommendation (UC3), modelrun / productrelationship /
                productrelationshipantecedent (UC1) -- the simulator never
                touches them; the engines write them.
    UC2-OWNED   uc2_settings, uc2_settings_history -- only UC2 writes them.
    NOT NEEDED  demand, replenishmentrecommendation -- nothing in the
                simulator reads or writes them.
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import urlparse

REPO_ROOT = Path(__file__).resolve().parents[2]

# --- what the loader may do -------------------------------------------------
# replaced on every load: emptied (TRUNCATE, no CASCADE) and refilled
WRITE_TABLES = ("warehouseproduct", "orders", "orderline", "inventory",
                "stocktransfer", "stocktransferline")
# new rows only: existing rows are never changed or deleted
INSERT_ONLY_TABLES = ("site",)
# derived from inventory: emptied so UC2's next run rebuilds them
EMPTIED_TABLES = ("consumption", "uc2_policy_parameters")
TRUNCATE_SET = WRITE_TABLES + EMPTIED_TABLES
ALLOWED = set(TRUNCATE_SET) | set(INSERT_ONLY_TABLES)

# --- what must stay exactly as it is ----------------------------------------
UNTOUCHED_TABLES = ("aisle", "bin", "product", "rack", "shelf", "storage",
                    "user_roles", "warehouse", "zone")
OUTPUT_TABLES = ("layoutrecommendation", "modelrun", "productrelationship",
                 "productrelationshipantecedent")
UC2_OWNED_TABLES = ("uc2_settings", "uc2_settings_history")
NOT_NEEDED_TABLES = ("demand", "replenishmentrecommendation")
# fingerprinted before and after a load: must come out identical
PROTECTED = UNTOUCHED_TABLES + OUTPUT_TABLES + UC2_OWNED_TABLES + NOT_NEEDED_TABLES

CENTRAL_WAREHOUSE = "WH001"
LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", ""}


def product_ids(prefix: str, digits: int, n: int) -> list[str]:
    """The ONLY product ids the simulator may use: the first n, in order."""
    return [f"{prefix}{i:0{digits}d}" for i in range(1, n + 1)]


def settings() -> tuple[dict, str]:
    """Connection settings from .env.local -> (kwargs for connect(), host)."""
    try:
        from dotenv import dotenv_values
    except ImportError:
        raise SystemExit("  python-dotenv is missing: python -m pip install python-dotenv")
    env = {k: v for k, v in dotenv_values(REPO_ROOT / ".env.local").items() if v}
    env.update({k: v for k, v in os.environ.items()
                if k in ("DATABASE_URL",) and v})          # an exported variable wins
    dsn = (env.get("DATABASE_URL") or "").strip()
    if dsn:
        return {"conninfo": dsn}, (urlparse(dsn).hostname or "").lower()
    if env.get("SUPABASE_DB_HOST") and env.get("SUPABASE_DB_PASSWORD"):
        kw = dict(host=env["SUPABASE_DB_HOST"], port=env.get("SUPABASE_DB_PORT", "5432"),
                  dbname=env.get("SUPABASE_DB_NAME", "postgres"),
                  user=env.get("SUPABASE_DB_USER", "postgres"),
                  password=env["SUPABASE_DB_PASSWORD"], sslmode="require")
        return kw, kw["host"].lower()
    raise SystemExit("  no DATABASE_URL (or SUPABASE_DB_*) in .env.local")


def connect(read_only: bool = True):
    """psycopg 3 connection. read_only=True: the session cannot write anything."""
    import psycopg
    kw, _ = settings()
    conninfo = kw.pop("conninfo", "")
    # no server-side prepared statements: safe through Supabase's connection pooler
    conn = psycopg.connect(conninfo, prepare_threshold=None, **kw)
    if read_only:
        conn.read_only = True
    return conn


def host() -> str:
    return settings()[1]


def ts_expr(conn, table: str, column: str, tz: str = "Asia/Singapore") -> str:
    """SQL that turns table.column into local wall-clock time, whatever its type.

    inventory.lastupdated is `timestamp without time zone` in the cloud (already
    local time), stocktransfer.transferdate is `timestamptz`. `AT TIME ZONE` does
    opposite things to the two types, so pick per column.
    """
    row = conn.execute("""SELECT data_type FROM information_schema.columns
                          WHERE table_schema = 'public' AND table_name = %s AND column_name = %s""",
                       (table, column)).fetchone()
    if row and row[0] == "timestamp with time zone":
        return f"({column} AT TIME ZONE '{tz}')"
    return column
