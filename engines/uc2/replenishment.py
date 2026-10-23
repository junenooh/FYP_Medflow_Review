"""UC2: inventory -> consumption -> demand class -> SS / ROP / OUL.

Reads:  inventory, warehouse
Writes: consumption            (its six existing columns)
        uc2_settings           (UC2's own -- seeded, never clobbered)
        uc2_policy_parameters  (UC2's own -- rebuilt warehouse by warehouse)

No existing table is altered, and nothing is written to
warehouseproductcalculation, demand, modelrun or replenishmentrecommendation.

HOW IT CONNECTS
    Over the REST API with the service-role key already in .env.local -- the
    same route UC1 and UC3 use. No database password needed here.

    The heavy lifting is Postgres functions installed from
    sql/uc2/uc2_setup.sql. Install or update them by pasting that file into
    the Supabase SQL Editor. This module refuses to run if the installed
    version differs from engines/uc2/version.py.

WHAT A RUN DOES
    1. seed settings    fill in the global row of uc2_settings from the config
    2. consumption      bring it up to the last real day (the pin)
    3. policy           classify every SKU, forecast, compute SS / ROP / OUL
                        and flags -- one warehouse at a time so each call stays
                        well inside Supabase's 60-second limit
    4. summary          one line per demand class

MODES (step 2 only)
    auto     (default) full if consumption is empty, otherwise append
    full     rewrite every series from the ledger, warehouse by warehouse
    append   write only the days that are missing -- the daily run
    rebuild  EMPTY consumption first, then full. Use this every time the
             inventory table has been regenerated: full on its own updates
             rows that still match the ledger but cannot remove rows whose
             ledger has gone, so stale rows survive. Consumption is derived
             entirely from inventory, so nothing is lost. Takes a few minutes.

USAGE
    python -m engines.uc2.replenishment
    python -m engines.uc2.replenishment --full
    python -m engines.uc2.replenishment --rebuild
    python -m engines.uc2.replenishment --push-settings
    python -m engines.uc2.replenishment --rebuild --direct   # same steps over the database
                                                            # connection (DATABASE_URL) instead
                                                            # of the REST API: no 60-second
                                                            # request limit, minutes not hours
                                                            # for a 365-day history
    python -m engines.run_all

    Use `python`, not `python3`: on this Mac `python3` is Apple's Python,
    which has none of the project's packages.

SETTINGS  (shared_config.json -> replenishment)
    service_level_z             1.65 = 95% chance of no stockout per cycle
    lead_time_days              order to arrival
    coverage_period_days        cover beyond lead time (T in the OUL)
    lead_time_std_days          lead-time variability, sigma_LT (0 = none)
    smoothing_alpha             0.065 responsive / 0.033 balanced / 0.022 stable
    classification_window_days  history used to classify each SKU (365)
    ledger_through              the pin -- last real day of data, or null
    flags { ... }               dashboard thresholds, see uc2_setup.sql PART 7

    The config seeds the database the first time. After that uc2_settings is
    authoritative, so an edit made in the UI survives the next run. Values
    added to the config later are filled in automatically; to overwrite
    values that already exist, run with --push-settings.

THE PIN -- replenishment.ledger_through
    The last day of real data, as "YYYY-MM-DD". Everything after it is
    ignored: no consumption rows are written past it, and the policy is
    computed as of that day. Move it forward, or set it to null, once the
    data is continuous -- otherwise new days are silently ignored.

INSTANT ARRIVAL -- READ BEFORE ADDING REAL LEAD TIMES
    In the current simulation an order shows up in inventory the moment it is
    placed, so stock on hand is the inventory position and a reorder check on
    stock alone cannot double-order. The day deliveries take real time, stock
    already on order (stocktransfer 'Requested' / 'In Transit' + orderline)
    must be counted too, or the same shortfall gets re-ordered every day until
    the delivery lands.
"""

from __future__ import annotations

import sys
from datetime import date

import httpx

from engines.result import StageResult
from engines.shared.db.config import load_shared_config
from engines.shared.db.supabase_client import get_service_client
from engines.uc2.version import SCHEMA_VERSION

ALGORITHM_VERSION = SCHEMA_VERSION

# postgrest-py defaults to a 5 second read timeout. A consumption bucket takes
# tens of seconds, so without this every call dies client-side while the server
# carries on working.
RPC_TIMEOUT_SECONDS = 600.0

# Supabase cuts any HTTP request off at about 60 seconds. A full rebuild
# therefore runs each warehouse in BUILD_BUCKETS slices, split by a hash of
# productid. Series are independent, so a bucket is a self-contained unit of
# work; slicing by date instead would be wrong, because the running balance has
# to carry across the boundary.
BUILD_BUCKETS = 8

# config key -> uc2_seed_settings argument
_SEED_KEYS = {
    "service_level_z":            "p_z",
    "lead_time_days":             "p_lead",
    "coverage_period_days":       "p_coverage",
    "smoothing_alpha":            "p_alpha",
    "lead_time_std_days":         "p_sigmalt",
    "classification_window_days": "p_classwindow",
}
_FLAG_KEYS = {
    "demand_drop_ratio":   "p_drop_ratio",
    "spike_share":         "p_spike_share",
    "gap_multiple":        "p_gap_multiple",
    "size_multiple":       "p_size_multiple",
    "low_confidence_days": "p_low_conf_days",
    "overstock_days":      "p_overstock_days",
    "near_rop_pct":        "p_near_rop_pct",
}


class _DirectResult:
    def __init__(self, data):
        self.data = data


class _DirectCall:
    """One SQL function call, with each argument cast to the function's declared type."""

    def __init__(self, conn, name: str, args: dict):
        self.conn, self.name, self.args = conn, name, args

    def execute(self):
        types = _DirectClient.arg_types(self.conn, self.name)
        call = ", ".join(f"{k} => %({k})s::{types.get(k, 'text')}" for k in self.args)
        cur = self.conn.execute(f"SELECT * FROM public.{self.name}({call})", self.args)
        rows = cur.fetchall()
        cols = [d.name for d in cur.description]
        if cols == [self.name] and len(rows) == 1:            # a scalar function
            v = rows[0][0]
            return _DirectResult(v.isoformat() if isinstance(v, date) else v)
        return _DirectResult([dict(zip(cols, r)) for r in rows])


class _DirectTable:
    """The tiny subset of the PostgREST table API this module uses."""

    def __init__(self, conn, name: str):
        self.conn, self.name, self.cols, self.n, self.where = conn, name, "*", None, []

    def select(self, cols="*"):
        self.cols = cols
        return self

    def limit(self, n):
        self.n = n
        return self

    def eq(self, col, val):
        self.where.append((col, val))
        return self

    def execute(self):
        sql = f'SELECT {self.cols} FROM public."{self.name}"'
        params = []
        if self.where:
            sql += " WHERE " + " AND ".join(f"{c} = %s" for c, _ in self.where)
            params = [v for _, v in self.where]
        if self.n:
            sql += f" LIMIT {int(self.n)}"
        cur = self.conn.execute(sql, params)
        cols = [d.name for d in cur.description]
        return _DirectResult([dict(zip(cols, r)) for r in cur.fetchall()])


class _DirectClient:
    """Stand-in for the Supabase client that runs UC2's SQL functions over DATABASE_URL.

    Same functions, same arguments, same results as the REST path, without the 60-second
    request limit, so a 365-day rebuild runs in one piece.
    """
    _types: dict[str, dict[str, str]] = {}

    def __init__(self):
        from scripts.sim import db
        self.conn = db.connect(read_only=False)
        self.conn.autocommit = True
        self.conn.execute("SET statement_timeout = 0")

    def rpc(self, name: str, args=None):
        return _DirectCall(self.conn, name, args or {})

    def table(self, name: str):
        return _DirectTable(self.conn, name)

    @classmethod
    def arg_types(cls, conn, name: str) -> dict[str, str]:
        if name not in cls._types:
            row = conn.execute("""SELECT pg_get_function_identity_arguments(p.oid) FROM pg_proc p
                                  JOIN pg_namespace n ON n.oid = p.pronamespace
                                  WHERE n.nspname = 'public' AND p.proname = %s LIMIT 1""", (name,)).fetchone()
            types = {}
            for piece in (row[0] if row else "").split(", "):
                piece = piece.strip()
                if piece:
                    k, _, t = piece.partition(" ")
                    types[k] = t
            cls._types[name] = types
        return cls._types[name]


def _raise_timeout(client, seconds: float = RPC_TIMEOUT_SECONDS):
    """Widen the HTTP read timeout on the PostgREST session, in place."""
    if isinstance(client, _DirectClient):
        return client
    try:
        client.postgrest.session.timeout = httpx.Timeout(seconds)
    except Exception as exc:  # noqa: BLE001 -- never fail the run over this
        print(f"  warning: could not raise the RPC timeout ({exc})")
    return client


def _rpc(client, name: str, args: dict | None = None):
    return client.rpc(name, args or {}).execute().data


def _fail(error: str) -> StageResult:
    return StageResult(name="UC2", runid="", status="failed", error=error)


def _check_schema(client) -> str | None:
    """Return an error string if the database functions are missing or stale."""
    try:
        found = _rpc(client, "uc2_schema_version")
    except Exception as exc:  # noqa: BLE001
        return (
            "could not call uc2_schema_version() -- the UC2 functions are "
            "probably not installed. Paste sql/uc2/uc2_setup.sql into the "
            f"Supabase SQL Editor. (underlying error: {exc})"
        )
    if found != SCHEMA_VERSION:
        return (
            f"the database has UC2 schema {found}, this repo expects "
            f"{SCHEMA_VERSION}. Paste the current sql/uc2/uc2_setup.sql into "
            "the Supabase SQL Editor."
        )
    return None


def _seed_args(rep: dict, force: bool) -> dict:
    args = {arg: rep[key] for key, arg in _SEED_KEYS.items() if rep.get(key) is not None}
    flags = rep.get("flags") or {}
    args.update({arg: flags[key] for key, arg in _FLAG_KEYS.items()
                 if flags.get(key) is not None})
    args["p_force"] = bool(force)
    return args


def _subsidiaries(client, central: str) -> list[str]:
    """Every warehouse that is not the central one, from the warehouse table."""
    rows = client.table("warehouse").select("warehouseid,warehouserole").execute().data or []
    subs = [
        r["warehouseid"]
        for r in rows
        if r.get("warehouserole") == "SUBSIDIARY" and r["warehouseid"] != central
    ]
    # Fall back to "everything that isn't central" if warehouserole is unset.
    if not subs:
        subs = [r["warehouseid"] for r in rows if r["warehouseid"] != central]
    return sorted(subs)


def _consumption_is_empty(client) -> bool:
    rows = client.table("consumption").select("consumptionid").limit(1).execute().data
    return not rows


def _resolve_pin(pin, ledger_max: str) -> tuple[str, str | None]:
    """Return (last day to use, error). No pin means the ledger's latest day.

    A pin later than the ledger's latest day is refused: it would zero-fill
    days that have no data at all, which is exactly what the pin exists to
    prevent.
    """
    if pin in (None, ""):
        return ledger_max, None
    try:
        pin_day = date.fromisoformat(str(pin))
    except ValueError:
        return "", f"replenishment.ledger_through must be YYYY-MM-DD, got {pin!r}"
    if pin_day > date.fromisoformat(str(ledger_max)):
        return "", (
            f"replenishment.ledger_through ({pin_day}) is after the last day "
            f"in the ledger ({ledger_max}) -- that would invent zero-demand days"
        )
    return pin_day.isoformat(), None


def run(
    *,
    upstream_uc1_runid: str | None = None,
    mode: str = "auto",
    push_settings: bool = False,
    direct: bool = False,
) -> StageResult:
    """
    Bring consumption up to date, then rebuild the policy.

    mode: "auto", "full", "append" or "rebuild" (see MODES above).

    upstream_uc1_runid is accepted for orchestrator compatibility and unused --
    neither step depends on the UC1 affinity rules.
    """
    cfg = load_shared_config()
    rep = cfg.get("replenishment", {})
    proj = cfg.get("project", {})

    central = proj.get("central_warehouse_id", "WH001")
    tz = rep.get("day_boundary_tz", "Asia/Singapore")

    client = _DirectClient() if direct else _raise_timeout(get_service_client())

    problem = _check_schema(client)
    if problem:
        return _fail(problem)

    warehouses = _subsidiaries(client, central)
    if not warehouses:
        return _fail("no subsidiary warehouses found in the warehouse table")

    # ---- 1. settings ----------------------------------------------------------
    seeded = _rpc(client, "uc2_seed_settings", _seed_args(rep, push_settings))
    print(f"  uc2_settings: {seeded}")

    # ---- 2. inventory -> consumption -----------------------------------------
    ledger_max = _rpc(client, "uc2_ledger_maxday", {"p_tz": tz})
    if not ledger_max:
        return _fail("the inventory ledger is empty for every subsidiary warehouse")

    maxday, problem = _resolve_pin(rep.get("ledger_through"), ledger_max)
    if problem:
        return _fail(problem)
    if maxday == ledger_max:
        print(f"  ledger ends {ledger_max} (no pin)")
    else:
        print(f"  ledger ends {ledger_max}, pinned to {maxday} -- "
              f"rows after it are ignored")

    effective = mode
    if mode == "rebuild":
        # Only now, after the schema, settings and pin have all checked out,
        # so a run that was going to fail anyway never leaves the table empty.
        print(f"  mode: rebuild -- {_rpc(client, 'uc2_reset_consumption', {'p_confirm': 'rebuild'})}, "
              f"rebuilding from inventory")
        effective = "full"
    elif mode == "auto":
        effective = "full" if _consumption_is_empty(client) else "append"
        print(f"  mode: {effective} (auto)")
    else:
        print(f"  mode: {effective}")

    total = 0
    if effective == "full":
        buckets = int(rep.get("build_buckets", BUILD_BUCKETS))
        for wh in warehouses:
            wh_total = 0
            for b in range(buckets):
                written = int(_rpc(client, "uc2_build_consumption", {
                    "p_warehouse": wh, "p_tz": tz,
                    "p_buckets": buckets, "p_bucket": b,
                    "p_maxday": maxday,
                }) or 0)
                wh_total += written
                print(f"    {wh} bucket {b + 1}/{buckets}: {written:,} rows")
            total += wh_total
            print(f"  consumption {wh}: {wh_total:,} rows")
    else:
        total = int(_rpc(client, "uc2_append_consumption", {
            "p_tz": tz, "p_maxday": maxday,
        }) or 0)
        print(f"  consumption appended: {total:,} rows")

    # ---- 3. classify, forecast, SS / ROP / OUL, flags -------------------------
    params = 0
    for wh in warehouses:
        n = int(_rpc(client, "uc2_compute_parameters", {
            "p_tz": tz, "p_asof": maxday, "p_warehouse": wh,
        }) or 0)
        params += n
        print(f"  policy {wh}: {n:,} SKUs")
    print(f"  uc2_policy_parameters: {params:,} rows as of {maxday}")

    # ---- 4. summary ------------------------------------------------------------
    _print_summary(client)

    return StageResult(
        name="UC2", runid="", status="success",
        input_rows=total, output_rows=params,
    )


def _print_summary(client) -> None:
    rows = _rpc(client, "uc2_policy_summary") or []
    if not rows:
        print("  (no policy rows)")
        return
    print(f"\n  {'class':<13}{'method':<8}{'SKUs':>7}{'low':>7}{'near':>7}"
          f"{'drop':>7}{'spike':>7}{'lowconf':>9}{'over':>7}{'stkout':>8}")
    for r in rows:
        print(f"  {r['demandclass'] or '-':<13}{r['method'] or '-':<8}"
              f"{r['skus']:>7,}{r['low_stock']:>7,}{r['near_rop']:>7,}"
              f"{r['flag_demand_dropped']:>7,}{r['flag_demand_spiked']:>7,}"
              f"{r['flag_low_confidence']:>9,}{r['flag_overstock']:>7,}"
              f"{r['flag_possible_stockout']:>8,}")
    print("  low = Low Stock, near = Near ROP; the rest are flag counts")


def main(argv: list[str]) -> int:
    mode = "auto"
    if "--rebuild" in argv:
        mode = "rebuild"
    elif "--full" in argv:
        mode = "full"
    elif "--append" in argv:
        mode = "append"

    result = run(mode=mode, push_settings="--push-settings" in argv, direct="--direct" in argv)
    print(f"\n{result.name}: {result.status} "
          f"in={result.input_rows} out={result.output_rows}")
    if result.error:
        print(f"  error: {result.error}")
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))