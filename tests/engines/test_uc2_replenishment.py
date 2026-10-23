"""
Unit tests for the UC2 engine (replenishment policy).

Modules under test:
  engines/uc2/replenishment.py   the run: settings, consumption, policy, in that order
  engines/uc2/service_levels.py  product -> service-level class (z-score)
  engines/uc2/backtest.py        the Python copy of uc2_calc()'s classification and
                                 reorder-point rules, used to backtest the policy

The policy maths itself (safety stock, reorder point, order-up-to level, status) runs as
Postgres functions (sql/uc2/uc2_setup.sql) and is checked against the stored results by
tests/integration/test_uc2_policy_db.py.

No database is used here: the Supabase client is replaced by a fake that records every
call. Test IDs (TC-UC2-UT-xxx) match docs/testing/uc2-unit-tests.md.
"""

import math

import numpy as np
import pytest

from engines.uc2 import backtest, replenishment as rep
from engines.uc2.version import SCHEMA_VERSION


# ------------------------------------------------------------------
# A fake Supabase client that records calls
# ------------------------------------------------------------------
class _Result:
    def __init__(self, data):
        self.data = data


class _Call:
    def __init__(self, data):
        self._data = data

    def execute(self):
        return _Result(self._data)


class _Table:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *_args, **_kw):
        return self

    def limit(self, n):
        self._rows = self._rows[:n]
        return self

    def execute(self):
        return _Result(self._rows)


class FakeClient:
    def __init__(self, *, schema=SCHEMA_VERSION, ledger_max="2026-10-14", consumption=(1,),
                 warehouses=None, written=10, skus=1000):
        self.calls = []
        self.schema = schema
        self.ledger_max = ledger_max
        self.consumption = list(consumption)
        self.warehouses = warehouses if warehouses is not None else [
            {"warehouseid": "WH001", "warehouserole": "CENTRAL"},
            {"warehouseid": "WH003", "warehouserole": "SUBSIDIARY"},
            {"warehouseid": "WH002", "warehouserole": "SUBSIDIARY"},
        ]
        self.written = written
        self.skus = skus

    def rpc(self, name, args):
        self.calls.append((name, dict(args or {})))
        if name == "uc2_schema_version":
            if isinstance(self.schema, Exception):
                raise self.schema
            return _Call(self.schema)
        return _Call({
            "uc2_seed_settings": "kept",
            "uc2_ledger_maxday": self.ledger_max,
            "uc2_reset_consumption": "emptied",
            "uc2_build_consumption": self.written,
            "uc2_append_consumption": self.written,
            "uc2_compute_parameters": self.skus,
            "uc2_policy_summary": [],
        }.get(name))

    def table(self, name):
        return _Table({"warehouse": self.warehouses,
                       "consumption": [{"consumptionid": c} for c in self.consumption]}[name])

    def names(self):
        return [name for name, _ in self.calls]


CONFIG = {
    "project": {"central_warehouse_id": "WH001"},
    "replenishment": {
        "service_level_z": 1.65, "lead_time_days": 2, "coverage_period_days": 4,
        "lead_time_std_days": 0.45, "smoothing_alpha": 0.033, "classification_window_days": 365,
        "ledger_through": None, "build_buckets": 3,
        "flags": {"near_rop_pct": 0.2, "overstock_days": 180},
    },
}


@pytest.fixture
def engine(monkeypatch):
    """Run the engine against a FakeClient built with the given options."""
    def start(config=None, **client_options):
        client = FakeClient(**client_options)
        monkeypatch.setattr(rep, "load_shared_config", lambda: config or CONFIG)
        monkeypatch.setattr(rep, "get_service_client", lambda: client)
        monkeypatch.setattr(rep, "_raise_timeout", lambda c, *a: c)
        return client
    return start


def with_pin(pin):
    cfg = {**CONFIG, "replenishment": {**CONFIG["replenishment"], "ledger_through": pin}}
    return cfg


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------
def test_ut001_pin_resolves_to_the_last_real_day():
    assert rep._resolve_pin(None, "2026-10-14") == ("2026-10-14", None)
    assert rep._resolve_pin("", "2026-10-14") == ("2026-10-14", None)
    assert rep._resolve_pin("2026-10-05", "2026-10-14") == ("2026-10-05", None)

    day, error = rep._resolve_pin("2026-10-20", "2026-10-14")
    assert day == "" and "after the last day" in error      # would invent zero-demand days

    day, error = rep._resolve_pin("14/10/2026", "2026-10-14")
    assert day == "" and "YYYY-MM-DD" in error


def test_ut002_settings_map_to_seed_arguments():
    args = rep._seed_args(CONFIG["replenishment"], force=True)

    assert args == {
        "p_z": 1.65, "p_lead": 2, "p_coverage": 4, "p_sigmalt": 0.45, "p_alpha": 0.033,
        "p_classwindow": 365, "p_near_rop_pct": 0.2, "p_overstock_days": 180, "p_force": True,
    }
    sparse = rep._seed_args({"lead_time_days": 3, "service_level_z": None}, force=False)
    assert sparse == {"p_lead": 3, "p_force": False}   # unset values are left to the database


def test_ut003_subsidiaries_exclude_central_and_are_sorted():
    assert rep._subsidiaries(FakeClient(), "WH001") == ["WH002", "WH003"]

    no_roles = FakeClient(warehouses=[{"warehouseid": w} for w in ("WH001", "WH005", "WH004")])
    assert rep._subsidiaries(no_roles, "WH001") == ["WH004", "WH005"]   # fallback without roles


def test_ut004_schema_version_must_match_the_repo():
    assert rep._check_schema(FakeClient()) is None
    assert "this repo expects" in rep._check_schema(FakeClient(schema="uc2-0.1"))
    assert "not installed" in rep._check_schema(FakeClient(schema=RuntimeError("no function")))


# ------------------------------------------------------------------
# run(): order of steps, scope and results
# ------------------------------------------------------------------
def test_ut005_daily_run_appends_consumption_then_rebuilds_policy(engine):
    client = engine()            # consumption already has rows -> auto = append

    result = rep.run()

    assert client.names() == [
        "uc2_schema_version", "uc2_seed_settings", "uc2_ledger_maxday",
        "uc2_append_consumption",
        "uc2_compute_parameters", "uc2_compute_parameters",
        "uc2_policy_summary",
    ]
    computed = [args for name, args in client.calls if name == "uc2_compute_parameters"]
    assert [a["p_warehouse"] for a in computed] == ["WH002", "WH003"]   # every subsidiary, not WH001
    assert all(a["p_asof"] == "2026-10-14" for a in computed)
    assert (result.status, result.input_rows, result.output_rows) == ("success", 10, 2000)


def test_ut006_first_run_builds_consumption_in_buckets(engine):
    client = engine(consumption=[])   # empty -> auto = full

    result = rep.run()

    builds = [a for name, a in client.calls if name == "uc2_build_consumption"]
    assert [(a["p_warehouse"], a["p_bucket"]) for a in builds] == [
        ("WH002", 0), ("WH002", 1), ("WH002", 2), ("WH003", 0), ("WH003", 1), ("WH003", 2)]
    assert all(a["p_buckets"] == 3 and a["p_maxday"] == "2026-10-14" for a in builds)
    assert "uc2_append_consumption" not in client.names()
    assert result.input_rows == 60


def test_ut007_pin_sets_the_policy_date(engine):
    client = engine(with_pin("2026-10-05"))

    rep.run()

    computed = [a for name, a in client.calls if name == "uc2_compute_parameters"]
    assert all(a["p_asof"] == "2026-10-05" for a in computed)
    appended = [a for name, a in client.calls if name == "uc2_append_consumption"]
    assert appended[0]["p_maxday"] == "2026-10-05"


def test_ut008_rebuild_empties_consumption_only_after_every_check_passes(engine):
    good = engine()
    rep.run(mode="rebuild")
    names = good.names()
    assert names.index("uc2_reset_consumption") > names.index("uc2_ledger_maxday")
    assert "uc2_build_consumption" in names

    bad_pin = engine(with_pin("2026-12-31"))
    result = rep.run(mode="rebuild")
    assert result.status == "failed" and "after the last day" in result.error
    assert "uc2_reset_consumption" not in bad_pin.names()   # a failing run never empties the table


def test_ut009_stale_schema_stops_the_run_before_any_write(engine):
    client = engine(schema="uc2-1.0")

    result = rep.run()

    assert result.status == "failed" and SCHEMA_VERSION in result.error
    assert client.names() == ["uc2_schema_version"]


def test_ut010_run_fails_cleanly_without_subsidiaries_or_ledger(engine):
    engine(warehouses=[{"warehouseid": "WH001", "warehouserole": "CENTRAL"}])
    result = rep.run()
    assert result.status == "failed" and "no subsidiary warehouses" in result.error

    client = engine(ledger_max=None)
    result = rep.run()
    assert result.status == "failed" and "ledger is empty" in result.error
    assert "uc2_compute_parameters" not in client.names()


# ------------------------------------------------------------------
# Service levels (z-score per product)
# ------------------------------------------------------------------
SL_CONFIG = {
    "by_classification": {"INHALER": "Vital"},
    "by_category": {"Anticoagulants": "Vital", "Analgesics": "Desirable"},
    "default_class": "Essential",
}


def test_ut011_service_level_class_by_form_then_category_then_default():
    from engines.uc2.service_levels import classify

    assert classify({"productclassification": "inhaler", "category": "Analgesics"}, SL_CONFIG) == "Vital"
    assert classify({"productclassification": "TABLET", "category": "Anticoagulants"}, SL_CONFIG) == "Vital"
    assert classify({"productclassification": None, "category": "Analgesics"}, SL_CONFIG) == "Desirable"
    assert classify({"category": "Vitamins"}, SL_CONFIG) == "Essential"


# ------------------------------------------------------------------
# Policy rules (Python copy of uc2_calc, used by the backtest)
# ------------------------------------------------------------------
def every(n, size, days=365, start=0):
    d = np.zeros(days)
    d[start::n] = size
    return d


@pytest.mark.parametrize(
    ("series", "expected"),
    [
        (np.zeros(365), "dormant"),                                  # no demand at all
        (np.r_[np.zeros(364), [5]], "insufficient"),                 # one demand day
        (np.full(365, 10.0), "smooth"),                              # every day, same size
        (np.tile([1.0, 30.0], 183)[:365], "erratic"),                # every day, sizes vary (CV2 0.87)
        (every(3, 10.0), "intermittent"),                            # every 3rd day (ADI 3), same size
        (np.where(np.arange(365) % 7 < 5, 10.0, 0.0), "intermittent"),  # 5 days in 7: ADI 1.4, just over 1.32
        (np.where(np.arange(365) % 3 == 0, np.tile([1.0, 30.0], 183)[:365], 0), "lumpy"),
    ],
)
def test_ut012_demand_class_uses_adi_132_and_cv2_049(series, expected):
    assert backtest.classify(series) == expected


def test_ut013_reorder_point_matches_hand_calculation():
    # MED0147 at WH002 on 2026-10-14: mu 26.85/day, sigma 24.08, z 1.96, LT 2 days, sigma_LT 0.45
    # SS = 1.96 * sqrt(2 * 24.08^2 + 26.85^2 * 0.45^2) = 70.81 -> ROP = ceil(2 * 26.85 + 70.81) = 125
    rop = backtest.reorder_points(np.array([26.8522]), np.array([24.0758]), 1.96, 2, 0.45)
    assert rop[0] == 125


def test_ut014_reorder_point_floors_sigma_and_handles_zero_demand():
    # sigma below sqrt(mu) is raised to sqrt(mu): mu 4, sigma 0 -> SS = 1.65 * sqrt(2 * 4) = 4.67
    rop = backtest.reorder_points(np.array([4.0, 0.0, 0.1]), np.array([0.0, 0.0, 0.0]), 1.65, 2, 0.0)
    assert rop[0] == math.ceil(4 * 2 + 1.65 * math.sqrt(2 * 4))   # 13
    assert rop[1] == 0                                              # no demand -> no reorder point
    assert rop[2] == 1                                              # ceil(0.2 + 0.74) = 1: any demand keeps a reorder point


def test_ut015_sba_forecast_removes_croston_bias():
    # 10 units every 4th day: size z = 10, gap p = 4, Croston z/p = 2.5, SBA = (1 - a/2) * 2.5
    alpha = 0.033
    mu, _ = backtest.f_sba(every(4, 10.0, days=200), alpha)
    assert mu[-1] == pytest.approx((1 - alpha / 2) * 10 / 4, rel=1e-6)
