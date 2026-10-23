"""
Data verification of the UC2 policy written by the database functions (sql/uc2/uc2_setup.sql).

The policy maths runs inside Postgres (uc2_calc), so it is verified here against every row it
stored in uc2_policy_parameters, using the formulas documented in uc2_setup.sql PART 7:

    sigma  floored at sqrt(mu)
    SS   = z * sqrt( LT * sigma^2 + mu^2 * sigma_LT^2 )
    ROP  = ceil( mu * LT + SS ),          at least 1 when mu > 0, 0 when mu = 0
    OUL  = ceil( mu * (LT + T) + SS ),    at least ROP + 1
    class: ADI < 1.32 / CV2 < 0.49  ->  smooth, erratic, intermittent, lumpy
    status: Low Stock <= ROP, Near ROP <= ROP * (1 + near_rop_pct), Available above

Read-only. Reads the live Supabase project with the anon key in .env.local and is skipped when
that file or the network is not available. Run: python -m pytest tests/integration -v
Test IDs (TC-UC2-DV-xxx) match docs/testing/uc2-unit-tests.md.
"""

import json
import math
import urllib.request
from collections import Counter
from pathlib import Path

import pytest

ENV_FILE = Path(__file__).resolve().parents[2] / ".env.local"


def _env():
    if not ENV_FILE.exists():
        return None
    pairs = (line.strip().split("=", 1) for line in ENV_FILE.read_text().splitlines() if "=" in line)
    env = {k: v.strip('"') for k, v in pairs}
    return env if env.get("VITE_SUPABASE_URL") and env.get("VITE_SUPABASE_ANON_KEY") else None


def _get(env, query, rng=None):
    headers = {"apikey": env["VITE_SUPABASE_ANON_KEY"],
               "Authorization": f"Bearer {env['VITE_SUPABASE_ANON_KEY']}"}
    if rng:
        headers["Range"] = rng
    req = urllib.request.Request(f"{env['VITE_SUPABASE_URL']}/rest/v1/{query}", headers=headers)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.load(resp)


def _all(env, query):
    rows, start = [], 0
    while True:
        page = _get(env, query, f"{start}-{start + 999}")
        rows += page
        if len(page) < 1000:
            return rows
        start += 1000


@pytest.fixture(scope="module")
def db():
    env = _env()
    if not env:
        pytest.skip(".env.local with Supabase URL and anon key not found")
    try:
        policy = _all(env, "uc2_policy_parameters?select=*&order=warehouseid,productid")
        settings = _all(env, "uc2_settings?select=*&order=scopewarehouseid,scopeproductid")
    except Exception as exc:  # noqa: BLE001
        pytest.skip(f"Supabase not reachable: {exc}")
    return {"env": env, "policy": policy, "settings": settings}


def num(value):
    return float(value) if value is not None else 0.0


def demand_rows(db):
    return [r for r in db["policy"] if num(r["avgdailydemand"]) > 0]


def global_settings(db):
    return next(s for s in db["settings"] if s["scopewarehouseid"] == "" and s["scopeproductid"] == "")


# ------------------------------------------------------------------
def test_dv001_one_policy_row_per_subsidiary_product_with_run_record(db):
    rows = db["policy"]
    per_wh = Counter(r["warehouseid"] for r in rows)
    keys = {(r["warehouseid"], r["productid"]) for r in rows}

    assert rows, "no policy rows"
    assert "WH001" not in per_wh                       # central warehouse is not replenished by UC2
    assert len(set(per_wh.values())) == 1              # every subsidiary covers the same products
    assert len(keys) == len(rows)                      # no duplicates
    assert len({r["asofdate"] for r in rows}) == 1     # one consistent as-of day
    assert all(r["computedat"] and r["method"] and r["demandclass"] for r in rows)


def test_dv002_safety_stock_matches_the_formula(db):
    wrong = []
    for r in demand_rows(db):
        mu, sd = num(r["avgdailydemand"]), num(r["stddailydemand"])
        z, lt, slt = num(r["zscore"]), num(r["leadtimedays"]), num(r["sigmaltdays"])
        sigma = max(sd, math.sqrt(mu))
        expected = z * math.sqrt(lt * sigma ** 2 + mu ** 2 * slt ** 2)
        if not math.isclose(expected, num(r["safetystock"]), rel_tol=1e-6, abs_tol=1e-6):
            wrong.append((r["warehouseid"], r["productid"], expected, r["safetystock"]))
    assert not wrong, wrong[:5]


def test_dv003_reorder_point_matches_the_formula(db):
    wrong = []
    for r in db["policy"]:
        mu, lt, ss = num(r["avgdailydemand"]), num(r["leadtimedays"]), num(r["safetystock"])
        expected = max(math.ceil(mu * lt + ss - 1e-9), 1) if mu > 0 else 0
        if expected != num(r["reorderpoint"]):
            wrong.append((r["warehouseid"], r["productid"], expected, r["reorderpoint"]))
    assert not wrong, wrong[:5]


def test_dv004_order_up_to_level_matches_the_formula(db):
    wrong = []
    for r in demand_rows(db):
        mu, lt, cover, ss = (num(r[k]) for k in ("avgdailydemand", "leadtimedays", "coverageperiod", "safetystock"))
        rop = num(r["reorderpoint"])
        expected = max(math.ceil(mu * (lt + cover) + ss - 1e-9), rop + 1)
        if expected != num(r["orderuptolevel"]):
            wrong.append((r["warehouseid"], r["productid"], expected, r["orderuptolevel"]))
    assert not wrong, wrong[:5]


def test_dv005_demand_class_and_forecast_method_follow_adi_and_cv2(db):
    wrong = []
    for r in db["policy"]:
        if int(num(r["demanddays"])) < 2:
            continue
        adi, cv2 = num(r["adi"]), num(r["cv2"])
        expected = ("smooth" if cv2 < 0.49 else "erratic") if adi < 1.32 else ("intermittent" if cv2 < 0.49 else "lumpy")
        method = "ses" if expected == "smooth" else "sba"
        if (r["demandclass"], r["method"]) != (expected, method):
            wrong.append((r["warehouseid"], r["productid"], adi, cv2, r["demandclass"], r["method"]))
    assert not wrong, wrong[:5]


def test_dv006_stored_stock_status_follows_the_reorder_point(db):
    near = num(global_settings(db)["flag_near_rop_pct"])
    wrong = []
    for r in db["policy"]:
        stock, rop, mu = num(r["currentstock"]), num(r["reorderpoint"]), num(r["avgdailydemand"])
        expected = ("Dormant" if mu <= 0 else "Low Stock" if stock <= rop
                    else "Near ROP" if stock <= rop * (1 + near) else "Available")
        if r["stockstatus"] != expected:
            wrong.append((r["warehouseid"], r["productid"], stock, rop, r["stockstatus"], expected))
    assert not wrong, wrong[:5]


def test_dv007_service_level_z_comes_from_the_product_override_or_the_default(db):
    default = num(global_settings(db)["zscore"])
    overrides = {s["scopeproductid"]: num(s["zscore"]) for s in db["settings"]
                 if s["scopewarehouseid"] == "" and s["scopeproductid"] and s["zscore"] is not None}
    wrong = [(r["productid"], r["zscore"]) for r in db["policy"]
             if not math.isclose(num(r["zscore"]), overrides.get(r["productid"], default), abs_tol=1e-9)]
    assert not wrong, wrong[:5]


def test_dv008_restock_orders_are_whole_cartons(db):
    env = db["env"]
    asof = db["policy"][0]["asofdate"]
    orders = _all(env, "orders?select=orderid&orderdate=gte.2026-10-06&order=orderid")
    assert orders, "no orders placed by the reorder check yet"
    ids = [o["orderid"] for o in orders]
    lines = []
    for i in range(0, len(ids), 40):
        chunk = ",".join(ids[i:i + 40])
        lines += _all(env, f"orderline?select=orderlineid,productid,qtyordered&orderid=in.({chunk})&order=orderlineid")
    cartons = {s["productid"]: int(num(s["shippingcasepack"])) or 1
               for s in _all(env, "storage?select=productid,shippingcasepack&order=productid")}
    wrong = [(l["orderlineid"], l["qtyordered"], cartons.get(l["productid"]))
             for l in lines if int(num(l["qtyordered"])) % cartons.get(l["productid"], 1) != 0
             or int(num(l["qtyordered"])) <= 0]
    assert lines and not wrong, (asof, wrong[:5])
