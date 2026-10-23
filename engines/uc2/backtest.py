"""UC2 backtest: which forecasting method would have worked best on our data?

WHAT IT DOES
    Pretends it is an earlier date and forecasts each day using only the days
    before it, then compares the forecast with what actually happened. It does
    that for every day of a test period (the last 90 days by default), for a
    fixed sample of SKUs, for every method below -- and reports which method
    was most accurate and which reorder points would actually have held.

    It is read-only. Nothing is written to the database.

METHODS COMPARED
    old tier rule        30 days, else 60, else 90 -- the rule UC2 used before
    simple average       plain mean of the last 30 / 90 days
    SES                  exponential smoothing at three alphas
    SBA                  Syntetos-Boylan approximation at three alphas
    policy               what UC2 now does: classify each SKU (ADI / CV2) on
                         the data before the test period, then SES for smooth
                         SKUs and SBA for the rest

    SES, SBA and the policy use exactly the same formulas as uc2_calc() in
    sql/uc2/uc2_setup.sql, so the numbers here describe the live system.

WHAT THE COLUMNS MEAN
    rel. error    mean absolute forecast error / the SKU's average demand.
                  0.80 means the forecast is off by 80% of a normal day's
                  demand, on average. Lower is better. Scaled per SKU so
                  high-volume SKUs don't drown out everything else.
    bias          average (forecast - actual) on the same scale. Negative =
                  forecasts too low (risk of stockouts), positive = too high.
    service       share of test days on which the reorder point set that day
                  would have covered actual demand over the following lead
                  time. The target is the configured z (1.65 -> 95%). Below
                  target = that method's ROPs would have let stock run out
                  more often than promised.
    ROP days      average reorder point, in days of the SKU's own demand --
                  what the method costs in stock. Lower is cheaper; compare
                  it only between methods that meet the service target.
    jitter        average day-to-day change in the forecast, on the same
                  scale. High jitter means reorder points that jump around.

    Pick the method with the lowest error among those that meet the service
    target, then prefer less stock and less jitter.

USAGE
    python -m engines.uc2.backtest
    python -m engines.uc2.backtest --n 1000 --test-days 90
    python -m engines.uc2.backtest --csv reports/uc2_backtest.csv

    Needs the UC2 functions installed (uc2_backtest_series) and a live policy
    (run engines.uc2.replenishment first). The sample is chosen by hash, so
    it is the same SKUs every time -- results are comparable between runs.
"""

from __future__ import annotations

import argparse
import csv
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

CLASS_ADI = 1.32
CLASS_CV2 = 0.49
ALPHAS = (("responsive", 0.065), ("balanced", 0.033), ("stable", 0.022))


# ---------------------------------------------------------------------------
# classification -- identical rules to uc2_calc()
# ---------------------------------------------------------------------------
def classify(hist: np.ndarray) -> str:
    nz = hist[hist > 0]
    k = len(nz)
    if k == 0:
        return "dormant"
    if k == 1:
        return "insufficient"
    adi = len(hist) / k
    cv2 = (nz.std(ddof=1) / nz.mean()) ** 2 if nz.mean() > 0 else 0.0
    if adi < CLASS_ADI:
        return "smooth" if cv2 < CLASS_CV2 else "erratic"
    return "intermittent" if cv2 < CLASS_CV2 else "lumpy"


# ---------------------------------------------------------------------------
# forecasters: each returns (mu, sigma) arrays where index t is the forecast
# for day t made from days [0, t). Index 0 has no history and is NaN.
# ---------------------------------------------------------------------------
def _window_stats(d: np.ndarray, lo: int, hi: int) -> tuple[float, float]:
    w = d[lo:hi]
    if len(w) == 0:
        return 0.0, 0.0
    sd = float(w.std(ddof=1)) if len(w) > 1 else 0.0
    return float(w.mean()), sd


def f_simple(d: np.ndarray, window: int, t0: int):
    n = len(d)
    mu = np.full(n, np.nan)
    sd = np.full(n, np.nan)
    for t in range(max(t0, 1), n):
        mu[t], sd[t] = _window_stats(d, max(0, t - window), t)
    return mu, sd


def f_tier(d: np.ndarray, t0: int):
    """30 days if any demand in them, else 60, else 90, else 0."""
    n = len(d)
    mu = np.full(n, np.nan)
    sd = np.full(n, np.nan)
    for t in range(max(t0, 1), n):
        mu[t], sd[t] = 0.0, 0.0
        for w in (30, 60, 90):
            lo = max(0, t - w)
            if (d[lo:t] > 0).any():
                mu[t], sd[t] = _window_stats(d, lo, t)
                break
    return mu, sd


def f_ses(d: np.ndarray, a: float):
    """Normalised exponentially weighted mean and std -- SES in closed form."""
    n = len(d)
    mu = np.full(n, np.nan)
    sd = np.full(n, np.nan)
    b = 1.0 - a
    s1 = s2 = w = 0.0
    for t in range(n):
        if w > 0:
            m = s1 / w
            mu[t] = m
            sd[t] = math.sqrt(max(s2 / w - m * m, 0.0))
        x = float(d[t])
        s1 = x + b * s1
        s2 = x * x + b * s2
        w = 1.0 + b * w
    return mu, sd


def f_sba(d: np.ndarray, a: float):
    """Syntetos-Boylan: smooth order size and gap separately, per demand."""
    n = len(d)
    mu = np.full(n, np.nan)
    sd = np.full(n, np.nan)
    b = 1.0 - a
    s1 = s2 = w = 0.0              # day-weighted moments, for sigma
    sz = wz = sp = wp = 0.0         # demand-weighted size and gap
    k = 0
    last = None
    total = 0.0
    for t in range(n):
        if t > 0:
            if k >= 2:
                m = (1.0 - a / 2.0) * (sz / wz) / (sp / wp)
            elif k == 1:
                m = total / t
            else:
                m = 0.0
            mu[t] = m
            sd[t] = (math.sqrt(max(s2 / w - 2 * m * s1 / w + m * m, 0.0))
                     if m > 0 and w > 0 else 0.0)
        x = float(d[t])
        total += x
        s1 = x + b * s1
        s2 = x * x + b * s2
        w = 1.0 + b * w
        if x > 0:
            sz = x + b * sz
            wz = 1.0 + b * wz
            if last is not None:
                sp = (t - last) + b * sp
                wp = 1.0 + b * wp
            last = t
            k += 1
    return mu, sd


def f_policy(d: np.ndarray, a: float, cls: str):
    if cls == "smooth":
        return f_ses(d, a)
    if cls in ("erratic", "intermittent", "lumpy"):
        return f_sba(d, a)
    n = len(d)
    if cls == "dormant":
        return np.zeros(n), np.zeros(n)
    # insufficient: plain mean, weighted std around it (as uc2_calc)
    mu = np.full(n, np.nan)
    sd = np.full(n, np.nan)
    b = 1.0 - a
    s1 = s2 = w = total = 0.0
    for t in range(n):
        if t > 0:
            m = total / t
            mu[t] = m
            sd[t] = math.sqrt(max(s2 / w - 2 * m * s1 / w + m * m, 0.0)) if m > 0 else 0.0
        x = float(d[t])
        total += x
        s1 = x + b * s1
        s2 = x * x + b * s2
        w = 1.0 + b * w
    return mu, sd


def reorder_points(mu, sd, z: float, lt: float, slt: float) -> np.ndarray:
    """Same rule as uc2_calc(): sqrt(mu) floor, round up, at least 1."""
    mu = np.nan_to_num(mu)
    sd = np.nan_to_num(sd)
    sdf = np.maximum(sd, np.sqrt(np.maximum(mu, 0)))
    ss = z * np.sqrt(lt * sdf ** 2 + mu ** 2 * slt ** 2)
    rop = np.maximum(np.ceil(mu * lt + ss), 1.0)
    return np.where(mu > 0, rop, 0.0)


# ---------------------------------------------------------------------------
# evaluation
# ---------------------------------------------------------------------------
def methods_for(d: np.ndarray, t0: int, cls: str):
    yield "old tier rule 30/60/90", *f_tier(d, t0)
    yield "simple 30-day average", *f_simple(d, 30, t0)
    yield "simple 90-day average", *f_simple(d, 90, t0)
    for label, a in ALPHAS:
        yield f"SES {label} ({a})", *f_ses(d, a)
    for label, a in ALPHAS:
        yield f"SBA {label} ({a})", *f_sba(d, a)
    for label, a in ALPHAS:
        yield f"policy {label} ({a})", *f_policy(d, a, cls)


def evaluate(series: list[dict], test_days: int, z: float, lt: float, slt: float):
    lt_days = max(1, int(math.ceil(lt)))
    per = []           # one row per (sku, method)
    skipped = 0
    for s in series:
        d = np.asarray(s["qty"], dtype=float)
        n = len(d)
        t0 = n - test_days
        if t0 < 60 or d.mean() <= 0:
            skipped += 1
            continue
        cls = classify(d[:t0])
        scale = float(d.mean())
        actual = d[t0:]
        cover_idx = range(t0, n - lt_days + 1)
        lt_demand = np.array([d[t:t + lt_days].sum() for t in cover_idx])
        for name, mu, sd in methods_for(d, t0, cls):
            f = np.nan_to_num(mu[t0:])
            rop = reorder_points(mu, sd, z, lt, slt)
            rop_test = np.array([rop[t] for t in cover_idx])
            per.append({
                "sku": f"{s['warehouseid']}/{s['productid']}",
                "class": cls,
                "method": name,
                "rel_error": float(np.abs(f - actual).mean() / scale),
                "bias": float((f - actual).mean() / scale),
                "covered": int((lt_demand <= rop_test).sum()),
                "cover_n": len(rop_test),
                "rop_days": float(rop_test.mean() / scale) if len(rop_test) else float("nan"),
                "jitter": float(np.abs(np.diff(f)).mean() / scale) if len(f) > 1 else 0.0,
            })
    return per, skipped


def summarise(rows: list[dict], key=lambda r: r["method"]):
    acc = defaultdict(lambda: {"n": 0, "err": 0.0, "bias": 0.0, "cov": 0, "covn": 0,
                               "rop": 0.0, "jit": 0.0})
    for r in rows:
        a = acc[key(r)]
        a["n"] += 1
        a["err"] += r["rel_error"]
        a["bias"] += r["bias"]
        a["cov"] += r["covered"]
        a["covn"] += r["cover_n"]
        a["rop"] += 0.0 if math.isnan(r["rop_days"]) else r["rop_days"]
        a["jit"] += r["jitter"]
    out = {}
    for k, a in acc.items():
        n = max(a["n"], 1)
        out[k] = {"skus": a["n"], "rel_error": a["err"] / n, "bias": a["bias"] / n,
                  "service": a["cov"] / a["covn"] if a["covn"] else float("nan"),
                  "rop_days": a["rop"] / n, "jitter": a["jit"] / n}
    return out


def _target(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def print_report(rows, skipped, n_series, test_days, z, lt, alpha_live):
    target = _target(z)
    overall = summarise(rows)
    print(f"\n  {n_series} SKUs sampled, {n_series - skipped} evaluated "
          f"({skipped} skipped: too little history or no demand)")
    print(f"  test period: last {test_days} days | lead time {lt:g} d | "
          f"service target {target:.0%} (z = {z:g})\n")
    print(f"  {'method':<30}{'rel. error':>11}{'bias':>8}{'service':>9}"
          f"{'ROP days':>10}{'jitter':>8}")
    ordered = sorted(overall.items(), key=lambda kv: kv[1]["rel_error"])
    for name, m in ordered:
        live = "  <- live" if name.startswith("policy") and f"({alpha_live})" in name else ""
        miss = " *" if m["service"] < target else ""
        print(f"  {name:<30}{m['rel_error']:>11.3f}{m['bias']:>+8.3f}"
              f"{m['service']:>8.1%}{miss:<1}{m['rop_days']:>10.1f}"
              f"{m['jitter']:>8.3f}{live}")
    print("  * below the service target\n")

    by_class = summarise(rows, key=lambda r: (r["class"], r["method"]))
    classes = sorted({c for c, _ in by_class})
    print(f"  {'class':<14}{'SKUs':>6}  best method (lowest error, meeting target)"
          f"{'error':>9}{'service':>9}")
    for c in classes:
        cand = {m: v for (cc, m), v in by_class.items() if cc == c}
        ok = {m: v for m, v in cand.items() if v["service"] >= target} or cand
        best = min(ok.items(), key=lambda kv: kv[1]["rel_error"])
        miss = " *" if best[1]["service"] < target else ""
        print(f"  {c:<14}{best[1]['skus']:>6}  {best[0]:<43}"
              f"{best[1]['rel_error']:>8.3f}{best[1]['service']:>9.1%}{miss}")
    print("  * no method met the target for this class -- lowest error shown")
    return overall, by_class


def write_csv(path: Path, overall: dict, by_class: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["scope", "method", "skus", "rel_error", "bias", "service",
                    "rop_days", "jitter"])
        for name, m in overall.items():
            w.writerow(["all", name, m["skus"], f"{m['rel_error']:.4f}", f"{m['bias']:.4f}",
                        f"{m['service']:.4f}", f"{m['rop_days']:.2f}", f"{m['jitter']:.4f}"])
        for (c, name), m in sorted(by_class.items()):
            w.writerow([c, name, m["skus"], f"{m['rel_error']:.4f}", f"{m['bias']:.4f}",
                        f"{m['service']:.4f}", f"{m['rop_days']:.2f}", f"{m['jitter']:.4f}"])


# ---------------------------------------------------------------------------
def fetch_series(n: int, asof: str | None, tz: str) -> list[dict]:
    from engines.uc2.replenishment import _raise_timeout
    from engines.shared.db.supabase_client import get_service_client

    client = _raise_timeout(get_service_client())
    args = {"p_n": min(n, 1000), "p_tz": tz}
    if asof:
        args["p_asof"] = asof
    return client.rpc("uc2_backtest_series", args).execute().data or []


def main(argv: list[str]) -> int:
    from engines.shared.db.config import load_shared_config
    from engines.shared.paths import REPO_ROOT

    ap = argparse.ArgumentParser(prog="python -m engines.uc2.backtest")
    ap.add_argument("--n", type=int, default=1000, help="SKUs to sample (max 1000)")
    ap.add_argument("--test-days", type=int, default=90)
    ap.add_argument("--asof", default=None, help="YYYY-MM-DD; default = live policy date")
    ap.add_argument("--csv", default=str(REPO_ROOT / "reports" / "uc2_backtest.csv"))
    args = ap.parse_args(argv)

    rep = load_shared_config().get("replenishment", {})
    z = float(rep.get("service_level_z", 1.65))
    lt = float(rep.get("lead_time_days", 5))
    slt = float(rep.get("lead_time_std_days", 0) or 0)
    alpha_live = float(rep.get("smoothing_alpha", 0.033))
    tz = rep.get("day_boundary_tz", "Asia/Singapore")

    series = fetch_series(args.n, args.asof, tz)
    if not series:
        print("  no series returned -- run engines.uc2.replenishment first")
        return 1

    rows, skipped = evaluate(series, args.test_days, z, lt, slt)
    if not rows:
        print("  nothing to evaluate -- histories too short for the test period")
        return 1
    overall, by_class = print_report(rows, skipped, len(series), args.test_days,
                                     z, lt, alpha_live)
    write_csv(Path(args.csv), overall, by_class)
    print(f"\n  written: {args.csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))