"""Simulate MedFlow's history against the REAL master data and write it as CSV files.

    python -m scripts.sim.generate --profile full                # MED0001-MED1000 x 365 days
    python -m scripts.sim.generate --profile dev                 # MED0001-MED0200 x 120 days
    python -m scripts.sim.generate --profile full --masters <folder>    # masters from CSV exports
    python -m scripts.sim.generate --profile full --bin-max-weight-kg 60   # plan with a bin limit
                                                                  # the client has not applied yet

Reads (read-only) product, storage, warehouse, bin, zone, shelf and site, then writes
data/sim/<profile>/*.csv plus ground_truth.json. It never writes to a database -- load.py
does that, and only to the tables listed in scripts/sim/db.py.

UNITS
  Hospitals request SALES PACKS (storage.salespackqty dosage units each). Central ships to the
  subsidiaries in whole CARTONS of storage.shippingcasepack packs. All quantities in the data are
  sales packs; order quantities are multiples of the carton size.

DEMAND
  product.manualbasedemand = annual NETWORK demand in dosage units (static). A subsidiary's share
  is its demand_multiplier / sum of multipliers. Request lines, quantities and timing follow
  sim_config.json; planted bundles land on the same request together (the ground truth for UC1).

ONE SIMULATED DAY, per subsidiary (SW)
  08:00        orders from Central (CW) that are due arrive -> inventory rows going UP, orderid set
  all day      hospitals send requests (hourly profile; near zero 01:00-05:00); each request is a
               basket of lines; the SW hands out what it has (same day, no transit)
               -> stocktransfer + stocktransferline
  23:00        the day's hand-outs come off the shelf -> one inventory row per product, going DOWN
  23:30        review against the SW's OWN reorder point / order-up-to level (the baseline policy:
               mis-sized levels, quantity noise and timing slips, see sim_config.json);
               the order is rounded to whole cartons -> orders (Processing) + orderline
  23:45        Central draws the shipped cartons from each product's bins, earliest expiry first
               (FEFO), one inventory row per bin touched; then every touched bin is topped back
               up to full by the supplier -> inventory rows going UP (WH001 only). On a day a
               product is ordered beyond what its bins hold, the balance comes straight from the
               supplier (cross-docked, no bin rows): Central never runs out.
Orders arrive 1-3 days later (10/80/10 %); the order becomes Fulfilled on that date. Orders still
on the road when the history ends stay Processing.

CENTRAL AND BINS
  Each product keeps a MAX in cartons (cover_days of mean dispatch + safety stock at
  service_level_z), held in as many bins as needed in the zone of its velocity class, filling bins
  in id order. A bin holds one product; a product may hold several bins. Cartons per bin come from
  the carton's size (any orientation) and the bin's weight limit. If a zone runs out of bins the
  build stops and says by how much.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import sys
import time
from collections import defaultdict
from pathlib import Path

import numpy as np

from scripts.sim import db, masters as masters_mod
from scripts.sim.masters import cartons_per_bin

HERE = Path(__file__).resolve().parent
REPO_ROOT = db.REPO_ROOT
DEFAULT_CONFIG = HERE / "sim_config.json"

# Column order of every CSV file = the COPY column list load.py uses.
TABLE_COLUMNS: dict[str, tuple[str, ...]] = {
    "site": ("siteid", "sitename", "address", "warehouseid"),
    "warehouseproduct": ("warehouseproductid", "warehouseid", "productid", "leadtimedays",
                         "servicelevel", "safetystock", "reorderpoint", "orderuptolevel",
                         "orderingcost", "holdingcost"),
    "orders": ("orderid", "warehouseid", "orderdate", "fulfilmentdate", "status"),
    "orderline": ("orderlineid", "orderid", "productid", "qtyordered"),
    "inventory": ("inventoryid", "warehouseid", "productid", "qtyonhand", "expirydate",
                  "datereceived", "inventorystatus", "lastupdated", "orderid", "binid"),
    "stocktransfer": ("transferid", "transferdate", "sourcewarehouseid", "siteid", "status"),
    "stocktransferline": ("transferlineid", "transferid", "productid", "qtyrequested", "qtyissued"),
}
LOAD_ORDER = tuple(TABLE_COLUMNS)
assert set(LOAD_ORDER) <= db.ALLOWED, "the simulator may only write tables listed in db.py"


class Csvs:
    def __init__(self, out: Path):
        out.mkdir(parents=True, exist_ok=True)
        self._files, self.w = {}, {}
        self.rows = {t: 0 for t in TABLE_COLUMNS}
        for t, cols in TABLE_COLUMNS.items():
            f = open(out / f"{t}.csv", "w", newline="", encoding="utf-8")
            self._files[t] = f
            self.w[t] = csv.writer(f)
            self.w[t].writerow(cols)

    def add(self, table: str, rows) -> None:
        rows = list(rows)
        self.w[table].writerows(rows)
        self.rows[table] += len(rows)

    def close(self) -> None:
        for f in self._files.values():
            f.close()


def _loguniform(rng, lo, hi, size):
    return np.exp(rng.uniform(math.log(lo), math.log(hi), size))


def _ts(day: dt.date, hour: float, tz: str) -> str:
    minutes = min(int(round(hour * 60)), 23 * 60 + 59)      # never roll into the next day
    return f"{day.isoformat()}T{minutes // 60:02d}:{minutes % 60:02d}:00{tz}"


def cartonise(qty, position, rop, pack):
    """Whole cartons: nearest to the gap, never fewer than it takes to clear the ROP, at least one.

    All arguments are numpy arrays in packs; returns cartons (int array, >= 1).
    """
    nearest = np.round(qty / pack)
    to_clear = np.ceil((rop - position + 1) / pack)
    return np.maximum(np.maximum(nearest, to_clear), 1).astype(np.int64)


def end_date_of(cfg: dict) -> dt.date:
    if cfg.get("end_date"):
        return dt.date.fromisoformat(cfg["end_date"])
    return dt.date.today() - dt.timedelta(days=1)


def load_masters(cfg: dict, profile: str, source: str | None) -> masters_mod.Masters:
    pc = cfg["products"]
    n = int(cfg["profiles"][profile]["n_products"])
    want = db.product_ids(pc["prefix"], int(pc["digits"]), n)
    subs = [s["id"] for s in cfg["subsidiaries"]]
    if source:
        return masters_mod.from_export(Path(source), want, cfg["central_warehouse"], subs)
    return masters_mod.from_db(want, cfg["central_warehouse"], subs)


# --------------------------------------------------------------------------
# Model: demand, policies, Central layout -- everything decided before day 1
# --------------------------------------------------------------------------
class Model:
    def __init__(self, cfg: dict, profile: str, m: masters_mod.Masters, bin_weight_override: float | None):
        prof = cfg["profiles"][profile]
        self.cfg, self.m = cfg, m
        self.n = n = int(prof["n_products"])
        self.days = int(prof["days"])
        self.seed = int(cfg["seed"])
        rng = np.random.default_rng([self.seed, 1])
        P = m.products
        self.pid = [p["productid"] for p in P]
        self.index = {p: i for i, p in enumerate(self.pid)}
        self.tier = np.array([p["tier"] for p in P])
        self.pack_units = np.array([p["pack_units"] for p in P], dtype=np.int64)
        self.carton = np.array([p["packs_per_carton"] for p in P], dtype=np.int64)
        self.shelf = np.array([max(1, p["shelflife_days"]) for p in P], dtype=np.int64)
        self.cost = np.array([p["unitcostsgd"] for p in P], dtype=float)

        # ---- demand ---------------------------------------------------------
        subs = cfg["subsidiaries"]
        self.whs = [s["id"] for s in subs]
        self.mult = np.array([s["demand_multiplier"] for s in subs], dtype=float)
        self.nw = len(self.whs)
        dcfg = cfg["demand"]
        x = float(dcfg["multiplier_lines_exponent"])
        self.mult_lines, self.mult_qty = self.mult ** x, self.mult ** (1 - x)
        self.rate_net = np.array([p["annual_units"] for p in P]) / 365.0 / self.pack_units   # packs/day, network
        self.base = self.rate_net / self.mult.sum()                                        # packs/day at x1.0
        tiers = dcfg["packs_per_line_mean"]
        unknown = sorted(set(self.tier) - set(tiers))
        if unknown:
            raise SystemExit(f"  velocityclass values with no demand settings: {', '.join(unknown)}")
        self.qbar = np.empty(n)
        self.cv = np.empty(n)
        for t, (lo, hi) in tiers.items():
            k = self.tier == t
            self.qbar[k] = _loguniform(rng, lo, hi, int(k.sum()))
            self.cv[k] = dcfg["line_cv"][t]
        self.lam = self.base / self.qbar                  # request lines/day at x1.0
        self.shape = 1.0 / self.cv ** 2
        self.p_max = float(dcfg["max_daily_request_prob"])
        self.dow = np.array(dcfg["day_of_week"], dtype=float)
        hw = np.array(dcfg["hour_weights"], dtype=float)
        self.hour_p = hw / hw.sum()
        self.mean_lines = float(cfg["requests"]["mean_lines_per_request"])
        self.requests_per_day = float(self.lam.sum() / self.mean_lines)   # at x1.0, before bundles

        # ---- bundles --------------------------------------------------------
        # A bundle appears on support_target of a subsidiary's requests. Its ANCHOR (the member with the
        # fewest request lines of its own) has its unrelated lines trimmed so that the rule
        # anchor -> other member reaches the band's confidence; the anchor's packs per line are
        # rescaled so its packs/day (manualbasedemand) is unchanged. Rules in the other direction
        # (popular -> anchor) are weaker, as in real baskets.
        bc = cfg["bundles"]
        conf_t = bc["confidence_target"]
        self.lam_ind = self.lam.copy()
        self.bundles, self.bundles_skipped = [], []
        specs = []
        for b in bc["list"]:
            if not all(x in self.index for x in b["members"]):
                self.bundles_skipped.append(b["id"])
                continue
            specs.append(b)
        for _pass in range(2):                       # rates depend on the request count, which depends on rates
            self.lam_ind = self.lam.copy()
            self.bundles = []
            bundle_lines = 0.0
            for b in specs:
                idx = np.array([self.index[x] for x in b["members"]])
                p = bc["p_include"][b["band"]]
                rate = bc["support_target"][b["band"]] * self.requests_per_day / (p * p)
                self.lam_ind[idx] -= rate * p
                anchor = int(idx[np.argmin(self.lam[idx])])
                self.bundles.append(dict(id=b["id"], band=b["band"], name=b["name"], why=b["why"], idx=idx,
                                         rate=rate, p=p, anchor=anchor,
                                         support_target=bc["support_target"][b["band"]]))
                bundle_lines += rate * p * idx.size
            self.lam_ind = np.maximum(self.lam_ind, 0.15 * self.lam)
            for b in self.bundles:
                if b["band"] in conf_t:
                    a, rate, p = b["anchor"], b["rate"], b["p"]
                    self.lam_ind[a] = min(self.lam_ind[a], rate * p * (p / conf_t[b["band"]] - 1))
            self.requests_per_day = float((self.lam_ind.sum() + bundle_lines) / self.mean_lines)
        self.qbar_ind = self.qbar.copy()                 # packs per line on a product's own lines
        for b in self.bundles:                           # anchors: keep packs/day, fewer but bigger lines
            a = b["anchor"]
            total_lines = self.lam_ind[a] + sum(x["rate"] * x["p"] for x in self.bundles if a in x["idx"].tolist())
            self.qbar[a] = max(1.0, self.base[a] / max(total_lines, 1e-9))

        # ---- subsidiaries' baseline policy (packs) ---------------------------
        bp = cfg["baseline_policy"]
        self.lt_days = np.array(cfg["lead_time"]["days"])
        self.lt_probs = np.array(cfg["lead_time"]["probs"], dtype=float)
        self.lt_mean = float((self.lt_days * self.lt_probs).sum())
        prng = np.random.default_rng([self.seed, 2])
        mu = self.base[None, :] * self.mult[:, None]                     # packs/day per SW x product
        e_rop = np.exp(prng.normal(0, bp["error_sigma"], (self.nw, n)))
        e_oul = np.exp(prng.normal(0, bp["error_sigma"], (self.nw, n)))
        self.mu = mu
        self.rop = np.maximum(1, np.ceil(mu * bp["rop_days"] * e_rop)).astype(np.int64)
        self.oul = np.maximum(self.rop + np.ceil(mu * 2), np.ceil(mu * bp["oul_days"] * e_oul)).astype(np.int64)
        self.ss = np.maximum(1, self.rop - np.ceil(mu * self.lt_mean)).astype(np.int64)
        self.bp = bp

        # ---- Central: max per product in cartons, bins per product ----------
        c = cfg["central"]
        disp = self.rate_net / self.carton                                 # cartons/day shipped, mean
        cover = float(c["cover_days"])
        self.cw_z = float(c["service_level_z"])
        self.cw_max_cartons = np.maximum(
            1, np.ceil(cover * disp + self.cw_z * np.sqrt(cover * disp))).astype(np.int64)
        zones = m.bins_by_zone()
        zone_of = c["zone_by_class"]
        self.cpb = np.zeros(n, dtype=np.int64)
        self.cw_bins: list[list[masters_mod.Bin]] = [[] for _ in range(n)]
        cursor = {z: 0 for z in zones}
        shortfall: dict[str, int] = defaultdict(int)
        for i in range(n):
            z = zone_of[str(self.tier[i])]
            pool = zones.get(z, [])
            if not pool:
                shortfall[z] += 1
                continue
            probe = pool[min(cursor[z], len(pool) - 1)]
            if bin_weight_override:
                probe = masters_mod.Bin(probe.binid, probe.zoneid, probe.length_cm, probe.width_cm,
                                        probe.height_cm, bin_weight_override)
            cpb = cartons_per_bin(P[i], probe)
            if cpb < 1:
                raise SystemExit(f"  {self.pid[i]}: its carton does not fit a {z} bin at all")
            self.cpb[i] = cpb
            need = int(math.ceil(self.cw_max_cartons[i] / cpb))
            take = pool[cursor[z]:cursor[z] + need]
            if len(take) < need:
                shortfall[z] += need - len(take)
            cursor[z] += need
            self.cw_bins[i] = take
        self.bins_used = {z: cursor.get(z, 0) for z in dict.fromkeys(zone_of.values())}
        self.bins_avail = {z: len(zones.get(z, [])) for z in self.bins_used}
        self.shortfall = dict(shortfall)
        self.bin_weight_override = bin_weight_override

    def lead(self, rng) -> int:
        return int(rng.choice(self.lt_days, p=self.lt_probs))


# --------------------------------------------------------------------------
def simulate(cfg: dict, profile: str, out: Path, m: masters_mod.Masters, mdl: Model) -> dict:
    n, nw, days = mdl.n, mdl.nw, mdl.days
    rng = np.random.default_rng([mdl.seed, 3])
    off = int(cfg["timezone_offset_hours"])
    tz = f"{'+' if off >= 0 else '-'}{abs(off):02d}:00"
    end = end_date_of(cfg)
    start = end - dt.timedelta(days=days - 1)
    status = cfg.get("inventory", {}).get("status", "Available")
    T = cfg["times"]
    cw = cfg["central_warehouse"]
    pid, whs, carton = mdl.pid, mdl.whs, mdl.carton

    out.mkdir(parents=True, exist_ok=True)
    (out / "ground_truth.json").unlink(missing_ok=True)    # written last: no truth = incomplete run
    csvs = Csvs(out)

    # ---- hospitals (existing sites; create only for a warehouse with none) ---
    site_rng = np.random.default_rng([mdl.seed, 4])
    sites, site_w, new_sites = [], [], []
    for s in cfg["subsidiaries"]:
        ids = [r["siteid"] for r in m.sites.get(s["id"], [])]
        if not ids:
            ids = [f"H{s['id'][2:]}-{k:02d}" for k in range(1, int(s["hospitals"]) + 1)]
            new_sites += [(h, f"Hospital {h}", f"Served by {s['id']}", s["id"]) for h in ids]
        wts = site_rng.uniform(0.5, 1.5, len(ids))
        sites.append(ids)
        site_w.append(wts / wts.sum())
    csvs.add("site", new_sites)

    # ---- warehouseproduct: the baseline levels (SW) and Central's max (WH001) --
    bp = mdl.bp
    holding = mdl.cost * mdl.pack_units * bp["holding_rate_per_year"] / 365.0   # SGD per pack per day
    for wi, w in enumerate(whs):
        csvs.add("warehouseproduct", (
            (f"WP-{w}-{pid[i]}", w, pid[i], int(round(mdl.lt_mean)), bp["service_level"], int(mdl.ss[wi, i]),
             int(mdl.rop[wi, i]), int(mdl.oul[wi, i]), bp["ordering_cost_sgd"], round(float(holding[i]), 5))
            for i in range(n)))
    cw_max_packs = mdl.cw_max_cartons * carton
    cw_ss = np.maximum(carton, np.ceil(mdl.cw_z * np.sqrt(cfg["central"]["cover_days"] * mdl.rate_net / carton))
                       * carton).astype(np.int64)
    # Central is topped up to its max after every dispatch, so its reorder point is its max.
    csvs.add("warehouseproduct", (
        (f"WP-{cw}-{pid[i]}", cw, pid[i], 0, 0.97, int(cw_ss[i]), int(cw_max_packs[i]), int(cw_max_packs[i]),
         bp["ordering_cost_sgd"], round(float(holding[i]), 5)) for i in range(n)))

    # ---- state ----------------------------------------------------------------
    oh = np.stack([rng.integers(mdl.rop[wi] + 1, mdl.oul[wi] + 1) for wi in range(nw)]).astype(np.int64)
    transit = np.zeros((nw, n), dtype=np.int64)
    arrivals: dict[tuple[int, int], list] = defaultdict(list)
    last_recv = np.full((nw, n), -1, dtype=np.int64)
    first_recv = start - dt.timedelta(days=14)
    late_skipped = np.zeros((nw, n), dtype=bool)

    # Central bins per product, in id order; FEFO draws from the earliest expiry first
    recv0 = start - dt.timedelta(days=int(cfg["central"]["opening_received_days_ago"]))
    cw_bins = []
    for i in range(n):
        cap = int(mdl.cpb[i] * carton[i])
        left = int(mdl.cw_max_cartons[i] * carton[i])
        rows = []
        for j, b in enumerate(mdl.cw_bins[i], 1):
            q = min(cap, left)
            left -= q
            rows.append({"bin": b.binid, "seq": j, "cap": cap, "qty": q, "recv": recv0,
                         "exp": recv0 + dt.timedelta(days=int(mdl.shelf[i]))})
        cw_bins.append(rows)

    def sw_rows(wi, w, idx, qty_after, day, hour, tag, orderid=None):
        rows = []
        for i, q in zip(idx.tolist(), qty_after.tolist()):
            lr = last_recv[wi, i]
            recv = first_recv if lr < 0 else start + dt.timedelta(days=int(lr))
            rows.append((f"INV-{w}-{pid[i]}-{day:%Y%m%d}-{tag}", w, pid[i], int(q),
                         (recv + dt.timedelta(days=int(mdl.shelf[i]))).isoformat(), recv.isoformat(),
                         status, _ts(day, hour, tz), orderid, None))
        csvs.add("inventory", rows)

    def cw_row(i, b, day, hour, tag):
        return (f"INV-{cw}-{pid[i]}-{day:%Y%m%d}-{tag}{b['seq']}", cw, pid[i], int(b["qty"]),
                b["exp"].isoformat(), b["recv"].isoformat(), status, _ts(day, hour, tz), None, b["bin"])

    allidx = np.arange(n)
    for wi, w in enumerate(whs):
        sw_rows(wi, w, allidx, oh[wi], start, 0.0, "O")
    csvs.add("inventory", (cw_row(i, b, start, 0.0, "O") for i in range(n) for b in cw_bins[i]))

    stats = dict(requested=np.zeros((nw, n), dtype=np.int64), issued=np.zeros((nw, n), dtype=np.int64),
                 requests=np.zeros(nw, dtype=np.int64), lines=np.zeros(nw, dtype=np.int64),
                 orders=np.zeros(nw, dtype=np.int64), orderlines=np.zeros(nw, dtype=np.int64),
                 early=0, late=0, lead_times=[], in_transit_orders=0, cw_rows=0, cw_topups=0, cross_docked=0)

    def draw_lines(expected):
        trials = np.maximum(1, np.ceil(expected / mdl.p_max)).astype(np.int64)
        return rng.binomial(trials, expected / trials)

    def draw_qty(sku, scale):
        extra = np.maximum(mdl.qbar[sku] * scale - 1.0, 0.01)
        return 1 + rng.poisson(rng.gamma(mdl.shape[sku], extra / mdl.shape[sku])).astype(np.int64)

    t0 = time.time()
    for d in range(days):
        day = start + dt.timedelta(days=d)
        f = mdl.dow[day.weekday()]
        ymd = f"{day:%Y%m%d}"
        dispatch = np.zeros(n, dtype=np.int64)

        for wi, w in enumerate(whs):
            # ---- 08:00 deliveries, one ledger row per order and product -----------
            for k, (oid, got, qty) in enumerate(arrivals.pop((d, wi), []), 1):
                oh[wi, got] += qty
                transit[wi, got] -= qty
                last_recv[wi, got] = d
                sw_rows(wi, w, got, oh[wi, got], day, T["arrivals"] + (k - 1) / 60, f"R{k}", oid)

            # ---- hospital requests through the day --------------------------------
            cnt = draw_lines(mdl.lam_ind * mdl.mult_lines[wi] * f)
            sku = np.repeat(allidx, cnt)
            qty = draw_qty(sku, mdl.mult_qty[wi])
            b_sku, b_evt, n_evt = [], [], 0
            for b in mdl.bundles:
                for _ in range(rng.poisson(b["rate"] * mdl.mult_lines[wi] * f)):
                    inc = b["idx"][rng.random(b["idx"].size) < b["p"]]
                    if inc.size:
                        b_sku.append(inc)
                        b_evt.append(np.full(inc.size, n_evt))
                        n_evt += 1
            b_sku = np.concatenate(b_sku) if b_sku else np.zeros(0, dtype=np.int64)
            b_evt = np.concatenate(b_evt) if b_evt else np.zeros(0, dtype=np.int64)
            total = sku.size + b_sku.size
            if total:
                n_req = max(1, int(round(total / mdl.mean_lines)))
                req = np.concatenate([rng.integers(n_req, size=sku.size),
                                      rng.integers(n_req, size=max(n_evt, 1))[b_evt]])
                all_sku = np.concatenate([sku, b_sku])
                all_qty = np.concatenate([qty, draw_qty(b_sku, mdl.mult_qty[wi])])
                key, inv = np.unique(req * n + all_sku, return_inverse=True)   # one line per product per request
                l_qty = np.bincount(inv, weights=all_qty).astype(np.int64)
                l_sku, l_req = key % n, key // n
                hours = np.sort(rng.choice(24, size=n_req, p=mdl.hour_p) + rng.random(n_req))
                site_of = rng.choice(len(sites[wi]), p=site_w[wi], size=n_req)

                requested = np.bincount(l_sku, weights=l_qty, minlength=n).astype(np.int64)
                l_iss = l_qty.copy()
                for s in np.nonzero(requested > oh[wi])[0]:              # short: serve in request-time order
                    li = np.nonzero(l_sku == s)[0]
                    before = np.cumsum(l_qty[li]) - l_qty[li]
                    l_iss[li] = np.clip(oh[wi, s] - before, 0, l_qty[li])
                issued = np.bincount(l_sku, weights=l_iss, minlength=n).astype(np.int64)
                oh[wi] -= issued
                stats["requested"][wi] += requested
                stats["issued"][wi] += issued

                used = np.unique(l_req)
                tid = {int(r): f"TR-{w}-{ymd}-{k:05d}" for k, r in enumerate(used.tolist(), 1)}
                csvs.add("stocktransfer", ((tid[r], _ts(day, float(hours[r]), tz), w,
                                            sites[wi][int(site_of[r])], "Completed") for r in used.tolist()))
                line_no = np.arange(l_req.size) - np.searchsorted(l_req, l_req, "left") + 1
                csvs.add("stocktransferline", (
                    (f"{tid[r]}-{j:03d}", tid[r], pid[s], q, iq)
                    for r, j, s, q, iq in zip(l_req.tolist(), line_no.tolist(), l_sku.tolist(),
                                              l_qty.tolist(), l_iss.tolist())))
                stats["requests"][wi] += used.size
                stats["lines"][wi] += l_req.size
                out_idx = np.nonzero(issued)[0]
                if out_idx.size:
                    sw_rows(wi, w, out_idx, oh[wi, out_idx], day, T["handout_booking"], "I")

            # ---- 23:30 review: the baseline policy with its slips -------------------
            pos = oh[wi] + transit[wi]
            at_rop = pos <= mdl.rop[wi]
            near = (~at_rop) & (pos <= mdl.rop[wi] * (1 + bp["early_band"]))
            early = near & (rng.random(n) < bp["early_prob"])
            late = at_rop & (~late_skipped[wi]) & (rng.random(n) < bp["late_prob"])
            late_skipped[wi] = (late_skipped[wi] | late) & at_rop      # a late skip lasts one day
            trig = np.nonzero((at_rop & ~late) | early)[0]
            stats["early"] += int(early.sum())
            stats["late"] += int(late.sum())
            if trig.size:
                late_skipped[wi, trig] = False
                gap = (mdl.oul[wi, trig] - pos[trig]).astype(float)
                noisy = gap * (1 + rng.uniform(-bp["qty_noise"], bp["qty_noise"], trig.size))
                cartons = cartonise(noisy, pos[trig], mdl.rop[wi, trig], carton[trig])
                oq = cartons * carton[trig]
                lt = mdl.lead(rng)
                due = d + lt
                oid = f"PO-{w}-{ymd}"
                arrived = due < days
                csvs.add("orders", [(oid, w, day.isoformat(),
                                     (day + dt.timedelta(days=lt)).isoformat() if arrived else "",
                                     "Fulfilled" if arrived else "Processing")])
                csvs.add("orderline", ((f"{oid}-{k:04d}", oid, pid[i], int(q))
                                       for k, (i, q) in enumerate(zip(trig.tolist(), oq.tolist()), 1)))
                transit[wi, trig] += oq
                if arrived:
                    arrivals[(due, wi)].append((oid, trig, oq))
                else:
                    stats["in_transit_orders"] += 1
                dispatch[trig] += oq
                stats["orders"][wi] += 1
                stats["orderlines"][wi] += trig.size
                stats["lead_times"].append(lt)

        # ---- 23:45 Central: draw FEFO from the bins, then top every touched bin back up --
        rows = []
        for i in np.nonzero(dispatch)[0].tolist():
            need = int(dispatch[i])
            bins = cw_bins[i]
            touched = []
            for b in sorted(bins, key=lambda b: (b["exp"], b["seq"])):
                if need <= 0:
                    break
                take = min(b["qty"], need)
                if take <= 0:
                    continue
                b["qty"] -= take
                need -= take
                touched.append(b)
                rows.append(cw_row(i, b, day, T["central"], "D"))
            if need > 0:                                   # beyond what the bins hold: cross-docked from the supplier
                stats["cross_docked"] += need
            for b in touched:                              # supplier top-up, instant
                b["qty"], b["recv"] = b["cap"], day
                b["exp"] = day + dt.timedelta(days=int(mdl.shelf[i]))
                rows.append(cw_row(i, b, day, T["central"] + 5 / 60, "S"))
                stats["cw_topups"] += 1
        csvs.add("inventory", rows)
        stats["cw_rows"] += len(rows)

        if (d + 1) % 30 == 0 or d == days - 1:
            print(f"    day {d + 1:>4}/{days}  {day}  ({time.time() - t0:,.0f}s)", flush=True)

    csvs.close()

    # ---- ground truth ----------------------------------------------------------
    req, iss = stats["requested"], stats["issued"]
    lts = np.array(stats["lead_times"]) if stats["lead_times"] else np.zeros(1)
    truth = {
        "profile": profile, "seed": mdl.seed, "start_date": start.isoformat(), "end_date": end.isoformat(),
        "days": days, "n_skus": n, "product_range": [pid[0], pid[-1]], "masters_source": m.source,
        "central_warehouse": cw, "units": "sales packs; order quantities are whole cartons",
        "warehouses": [{"id": w, "demand_multiplier": float(mdl.mult[i]), "hospitals": sites[i]}
                       for i, w in enumerate(whs)],
        "sites_created": [r[0] for r in new_sites],
        "requests_per_day_at_1x": round(mdl.requests_per_day, 1),
        "mean_lines_per_request": mdl.mean_lines, "max_daily_request_prob": mdl.p_max,
        "multiplier_lines_exponent": float(cfg["demand"]["multiplier_lines_exponent"]),
        "day_of_week": mdl.dow.tolist(), "hour_weights": cfg["demand"]["hour_weights"],
        "products": [{"productid": pid[i], "name": m.products[i]["name"], "category": m.products[i]["category"],
                      "tier": str(mdl.tier[i]), "annual_units": m.products[i]["annual_units"],
                      "pack_units": int(mdl.pack_units[i]), "packs_per_carton": int(carton[i]),
                      "network_packs_per_day": round(float(mdl.rate_net[i]), 3),
                      "lines_per_day_at_1x": round(float(mdl.lam[i]), 3),
                      "own_lines_per_day_at_1x": round(float(mdl.lam_ind[i]), 4),
                      "packs_per_line_mean": round(float(mdl.qbar[i]), 3), "line_cv": float(mdl.cv[i]),
                      "baseline": {w: {"rop": int(mdl.rop[wi, i]), "oul": int(mdl.oul[wi, i]),
                                       "ss": int(mdl.ss[wi, i])} for wi, w in enumerate(whs)},
                      "cw_max_cartons": int(mdl.cw_max_cartons[i]), "cartons_per_bin": int(mdl.cpb[i]),
                      "cw_bins": [b.binid for b in mdl.cw_bins[i]]} for i in range(n)],
        "bundles": [{"id": b["id"], "band": b["band"], "name": b["name"], "why": b["why"],
                     "members": [pid[i] for i in b["idx"]], "names": [m.products[i]["name"] for i in b["idx"]],
                     "support_target": b["support_target"], "events_per_day_at_1x": round(b["rate"], 4),
                     "p_include": b["p"]} for b in mdl.bundles],
        "bundles_skipped_outside_range": mdl.bundles_skipped,
        "bands": cfg["bundles"]["bands"],
        "baseline_policy": {k: v for k, v in bp.items() if not k.startswith("_")},
        "lead_time": {"days": mdl.lt_days.tolist(), "probs": mdl.lt_probs.tolist(), "mean": mdl.lt_mean},
        "central": {"cover_days": cfg["central"]["cover_days"], "service_level_z": mdl.cw_z,
                    "zone_by_class": cfg["central"]["zone_by_class"],
                    "bins_used": mdl.bins_used, "bins_available": mdl.bins_avail,
                    "bin_max_weight_kg_assumed": mdl.bin_weight_override},
        "demand": {k: v for k, v in cfg["demand"].items() if not k.startswith("_")},
        "requests": cfg["requests"], "times": T,
        "realised": {
            "rows": csvs.rows,
            "fill_rate_by_warehouse": {w: round(float(iss[i].sum() / max(req[i].sum(), 1)), 4)
                                       for i, w in enumerate(whs)},
            "requested_packs_per_day": {w: round(float(req[i].sum() / days), 1) for i, w in enumerate(whs)},
            "requests_per_day": {w: round(float(stats["requests"][i] / days), 1) for i, w in enumerate(whs)},
            "orders_by_warehouse": {w: int(stats["orders"][i]) for i, w in enumerate(whs)},
            "order_lines_by_warehouse": {w: int(stats["orderlines"][i]) for i, w in enumerate(whs)},
            "orders_in_transit_at_end": int(stats["in_transit_orders"]),
            "early_orders": int(stats["early"]), "late_skips": int(stats["late"]),
            "lead_time_mean": round(float(lts.mean()), 3), "lead_time_sd": round(float(lts.std()), 3),
            "central_bin_rows": int(stats["cw_rows"]), "central_topups": int(stats["cw_topups"]),
            "central_cross_docked_packs": int(stats["cross_docked"]),
        },
    }
    (out / "ground_truth.json").write_text(json.dumps(truth, indent=1), encoding="utf-8")
    return truth


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--profile", default="full")
    ap.add_argument("--config", default=str(DEFAULT_CONFIG))
    ap.add_argument("--out", default=None, help="default: data/sim/<profile>")
    ap.add_argument("--masters", default=None, help="read masters from this export folder instead of the database")
    ap.add_argument("--bin-max-weight-kg", type=float, default=None,
                    help="plan with this bin weight limit instead of the bin table's (the loader still "
                         "checks against the table)")
    a = ap.parse_args(argv)

    cfg = json.loads(Path(a.config).read_text(encoding="utf-8"))
    if a.profile not in cfg["profiles"]:
        print(f"  unknown profile {a.profile!r}; have {', '.join(cfg['profiles'])}")
        return 2
    out = Path(a.out) if a.out else REPO_ROOT / "data" / "sim" / a.profile
    p = cfg["profiles"][a.profile]
    m = load_masters(cfg, a.profile, a.masters)
    mdl = Model(cfg, a.profile, m, a.bin_max_weight_kg)
    print(f"  masters from {m.source}: {len(m.products):,} products "
          f"({m.products[0]['productid']}-{m.products[-1]['productid']}), "
          f"{len(m.cw_bins):,} ACTIVE {cfg['central_warehouse']} bins, {sum(len(v) for v in m.sites.values())} sites")
    if a.bin_max_weight_kg:
        print(f"  NOTE: planning with a bin weight limit of {a.bin_max_weight_kg:g} kg; the bin table says "
              f"{m.cw_bins[0].max_weight_kg:g} kg. The loader will refuse until the table is changed.")
    print("  Central bins by zone (needed / available):  " + "  ".join(
        f"{z} {mdl.bins_used[z]:,}/{mdl.bins_avail[z]:,}" for z in mdl.bins_used))
    if mdl.shortfall:
        print("  Central does NOT fit: short by " + ", ".join(f"{z} {k:,} bins" for z, k in mdl.shortfall.items()))
        print("  Lower central.cover_days, change central.zone_by_class, or raise the bin weight limit.")
        return 1
    end = end_date_of(cfg)
    print(f"  simulating profile {a.profile}: {p['n_products']:,} products x {p['days']} days, ending {end} -> {out}")
    truth = simulate(cfg, a.profile, out, m, mdl)

    r = truth["realised"]
    print("\n  rows written:")
    for t, k in r["rows"].items():
        print(f"    {t:<18} {k:>12,}")
    size = sum((out / f"{t}.csv").stat().st_size for t in TABLE_COLUMNS)
    print(f"    {'(csv total)':<18} {size / 1e6:>10,.0f} MB")
    print("\n  warehouse  requests/day  packs/day  fill rate  orders   lines")
    for w in truth["warehouses"]:
        i = w["id"]
        print(f"    {i}   {r['requests_per_day'][i]:>10,.0f}   {r['requested_packs_per_day'][i]:>9,.0f}"
              f"   {r['fill_rate_by_warehouse'][i]:>7.1%}   {r['orders_by_warehouse'][i]:>5,}  "
              f"{r['order_lines_by_warehouse'][i]:>6,}")
    print(f"\n  baseline slips: {r['early_orders']:,} early orders, {r['late_skips']:,} late skips; "
          f"lead time mean {r['lead_time_mean']} d; {r['orders_in_transit_at_end']} orders in transit at the end")
    print(f"  Central: {r['central_bin_rows']:,} bin rows, {r['central_topups']:,} supplier top-ups, "
          f"{r['central_cross_docked_packs']:,} packs cross-docked (dispatch beyond what the bins held)")
    print(f"  bundles planted: {', '.join(b['id'] for b in truth['bundles']) or 'none'}"
          + (f"; skipped (outside range): {', '.join(truth['bundles_skipped_outside_range'])}"
             if truth["bundles_skipped_outside_range"] else ""))
    print(f"  ground truth: {out / 'ground_truth.json'}")
    print(f"  next: python -m scripts.sim.load --profile {a.profile}   (dry run)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
