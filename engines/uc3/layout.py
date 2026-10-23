"""UC3 -- central-warehouse slotting on measured demand (uc3-slotting-3.0).

    python -m engines.uc3.layout                    # all payback presets (7 / 30 / 60 / 90 days)
    python -m engines.uc3.layout --preset 30        # one preset
    python -m engines.uc3.layout --uc1-runid <id>   # pin the upstream UC1 run
    python -m engines.uc3.layout --dry-run          # score and print, write nothing

WHAT IT DOES
  1. Reads one consistent, read-only snapshot of WH001: ACTIVE bins (zone, aisle, rack, level
     from the bin id), each product's current bins and stock (latest inventory row per
     product x bin), measured demand from UC2 (all rows at ONE shared asofdate), and UC1's
     Strong / Moderate rules from ONE run id, this warehouse only. The velocity class is
     banded from UC2 demand rank, since uc2_policy_parameters holds no velocityclass column.
  2. A product's bins are its GROUP. A group keeps its size and may only sit on consecutive
     bins of ONE zone and ONE aisle, on bins that are free or already its own. One product per
     bin, every bin fit- and weight-checked by the shared validator (also used by UC4).
  3. Scores a layout in SECONDS PER DAY with one function used for every layout:
       picking    cartons picked/day x mean access time of the group
                  (walking from the dock + the ladder penalty for high levels)
       companions picks-together/day x walking time between related groups
       moves      one-off labour (walk out and back per bin + handling per carton)
                  divided by the PAYBACK period in days
  4. Phase 1, heuristic: from the current layout, highest demand first, relocate a group to its
     best available run if that pays back. Deterministic, and the move list is explainable.
  5. Phase 2, in TWO stages, because the heuristic and the two stages each exhaust a
     different neighbourhood:
       cold  one long pass at a temperature too low to accept a worsening move, i.e. pure
             descent. heuristic() only RELOCATES a product to a free run and never SWAPS
             two products, so it converges in one pass while ~14% of random swap proposals
             are still improving. This stage descends through those until they dry up.
       hot   simulated annealing with REHEATING: several rounds, each with a FIXED seed,
             each reheating from the incumbent best so rounds compound. T0 is calibrated on
             the SATURATED layout, since those are the deltas it faces. This only pays once
             the cold stage has saturated: measured there, 400,000 further cold draws gained
             1,389 s/day while the same budget hot gained 6,123. Before saturation the
             ordering reverses, because exploration costs an iteration not spent descending
             plus the damage it then has to repair.
     Then one low-temperature intensification pass. Within every annealing pass the cooling
     rate is derived to reach the floor early, after which the search descends at the floor.
  6. Never saves a layout worse than the current one. Per preset it writes one `modelrun`, one
     `uc3_run` audit row, and one `layoutrecommendation` row per bin that moves.

REPRODUCIBILITY
  Every random draw comes from a fixed seed, including the temperature calibration, so the
  same snapshot and settings always produce the same layout. `uc3_run` records the round
  seeds, the per-round scores, the start temperature and the derived cooling rate, so a run
  can be replayed. Because rounds reheat from the incumbent best, `sa_seed_scores` reads as
  a monotone improvement trajectory: it shows where the search stopped paying, which is the
  signal for tuning `sa_seeds` -- it is NOT a spread over independent samples and must not
  be presented as a confidence measure.

COST COMPARABILITY
  The current layout has no move cost; the heuristic and SA layouts do. Totals are therefore
  never subtracted from one another. Pick / companion / move are kept separate end to end and
  stored separately in `uc3_run`, so running-cost and all-in comparisons are both derivable
  and neither is ambiguous.

Tables: reads bin, inventory, product, storage, uc2_policy_parameters,
productrelationship(+antecedent), modelrun. Writes modelrun, layoutrecommendation and uc3_run.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone

import numpy as np

from engines.result import StageResult
from engines.shared.db.config import load_shared_config
from scripts.sim import db
from scripts.sim.masters import Bin, cartons_per_bin

ALGORITHM_VERSION = "uc3-slotting-3.0"
_BIN_ID = re.compile(
    r"^(?P<zone>[^-]+)-A(?P<aisle>\d+)-R(?P<rack>\d+)-L(?P<level>\d+)-F(?P<face>\d+)-B(?P<bin>\d+)$",
    re.I,
)


# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Settings:
    zone_distance_m: float = 40.0
    aisle_distance_m: float = 3.0
    walking_speed_mps: float = 1.0
    trip_factor: float = 2.0                 # out and back
    ladder_levels: tuple[int, ...] = (4, 5)
    ladder_penalty_s: float = 20.0
    band_weights: dict = field(default_factory=lambda: {"Strong": 1.0, "Moderate": 0.5})
    # Velocity banding is computed here from UC2 demand rank, because
    # uc2_policy_parameters carries no velocityclass column. Shares are the top
    # fraction of products in each band; "Low" takes whatever remains.
    velocity_shares: dict = field(
        default_factory=lambda: {"Super High": 0.08, "High": 0.22, "Medium": 0.40}
    )
    handling_s_per_carton: float = 8.0       # lifting a carton off and onto a shelf
    payback_presets: tuple[int, ...] = (7, 30, 60, 90)
    max_moves: int | None = None             # optional hard cap on products moved

    # ---- simulated annealing ----
    # ---- stage 1 of phase 2: COLD saturation ----
    # One long pass at a temperature too low to accept a worsening move, i.e.
    # pure descent. It exists because heuristic() only RELOCATES a product to a
    # free run and never SWAPS two products: measured on a 1,000-product floor,
    # the heuristic converges in a single pass (a second pass moves nothing)
    # while 14% of random swap proposals are still improving. This stage chews
    # through that swap neighbourhood. At ~400,000 draws it saturates -- moves
    # 0.00% improving, swaps 1.43% -- and further cold draws buy almost nothing.
    sa_cold_iterations: int = 400_000
    sa_cold_temperature: float = 30.0        # inert BY DESIGN; see above

    # ---- stage 2 of phase 2: HOT reheat rounds ----
    # Only worth paying for once stage 1 has saturated. From the saturated
    # layout, 400,000 further COLD draws gained 1,389 s/day; the same budget at
    # a calibrated temperature gained 6,123 -- 4.4x. Before saturation the
    # ordering reverses, because exploration costs an iteration not spent
    # descending plus the damage it has to repair.
    # ONE LONG PASS, not many short ones. Each hot pass must first undo its own
    # exploration damage before it can improve on the incumbent, so splitting a
    # fixed hot budget destroys it. Measured from a saturated layout, all with
    # the SAME 400,000 draws: 1 x 400,000 gained 6,085 s/day, 2 x 200,000 gained
    # 4,405, 4 x 100,000 gained 2,737, and 8 x 50,000 or shorter gained NOTHING
    # -- below roughly 46,000 post-freeze descent draws a pass never returns to
    # par, so the best-so-far never updates. Raise this before raising sa_seeds.
    sa_hot_iterations: int = 400_000
    # Number of hot passes. Each one needs the full sa_hot_iterations to be
    # worth anything, so extra passes cost real time; 1 is the measured default.
    sa_seeds: int = 1
    sa_min_temperature: float = 0.01         # the floor the schedule cools to
    # The schedule reaches the floor after this FRACTION of each round, and the
    # remainder runs at the floor as a low-temperature descent. Annealing earns
    # its keep by escaping the heuristic's local optimum early; the gain after
    # that comes from descent, so cooling across the whole run (fraction 1.0)
    # replaces useful descent with a random walk and measurably loses ground.
    # 0.08 reproduces the original's hard-coded 0.995 at 20,000 iterations.
    sa_freeze_fraction: float = 0.08
    # Share of WORSENING moves accepted at T0. Note the convention: the familiar
    # "accept ~80% at T0" advice refers to ALL proposals, improving ones included,
    # which are always accepted. Applied to worsening moves only, 0.80 puts T0 at
    # 4.5x a typical worsening move -- above the entire layout cost on real
    # snapshots, i.e. a random walk. 0.30 puts T0 at 0.83x one typical worsening
    # move, which is the textbook intent and the scale a report can defend.
    sa_target_accept: float = 0.30
    sa_calibration_samples: int = 400
    sa_calibration_seed: int = 12_345        # FIXED, so T0 is deterministic
    sa_intensify_iterations: int = 5_000
    sa_intensify_seed: int = 99_991
    sa_intensify_temp_fraction: float = 0.05  # intensify at 5% of the calibrated T0
    sa_resync_every: int = 2_000             # re-anchor the running total to the truth
    # Pins the HOT stage's T0 and skips calibration. None = calibrate, which is
    # the default, because a hot stage at a pinned-low temperature does nothing.
    # The COLD stage's temperature is sa_cold_temperature above, not this.
    sa_start_temperature: float | None = None


def settings_from_config(raw: dict) -> Settings:
    raw = raw or {}
    pen = raw.get("shelf_penalties_seconds") or {}
    bands = raw.get("shelf_level_bands") or {}
    ladder = tuple(sorted(int(k) for k, v in bands.items() if str(v).upper() == "LADDER")) or (4, 5)
    bw = {k.capitalize(): float(v) for k, v in (raw.get("affinity_band_weights") or {}).items()}
    sa = raw.get("annealing") or {}
    # Backwards compatible on purpose. A config written before the cold/hot
    # split carries `start_temperature_s` (typically 30), which is a COLD
    # temperature -- inert against move deltas of several hundred s/day. So it
    # is read as the cold stage's temperature, which is the job it was already
    # doing, and the hot stage calibrates unless `hot_temperature_s` pins it.
    # An existing config therefore needs no edit to get the two-stage search.
    legacy = sa.get("start_temperature_s")
    cold_t = sa.get("cold_temperature_s", legacy if legacy is not None else 30.0)
    hot_pin = sa.get("hot_temperature_s")
    # Say so out loud rather than ignoring a key someone deliberately set.
    # A silently-dead config key is how `start_temperature_s` came to be
    # believed absent while it was pinning the temperature all along.
    if "iterations" in sa:
        print(f"  note: config uc3.annealing.iterations={sa['iterations']} is no longer "
              f"used; the search is now cold_iterations + hot_iterations "
              f"(currently {int(sa.get('cold_iterations', 400_000)):,} + "
              f"{int(sa.get('hot_iterations', 400_000)):,}).")
    if "seeds" in sa and "hot_passes" not in sa:
        print(f"  note: config uc3.annealing.seeds={sa['seeds']} is no longer used. Reheat "
              f"rounds were measured to be harmful in the hot stage, so it is one long pass "
              f"by default; set `hot_passes` if you want more than "
              f"{int(sa.get('hot_passes', 1))}.")
    return Settings(
        zone_distance_m=float(raw.get("zone_distance_m", 40)),
        aisle_distance_m=float(raw.get("aisle_distance_m", 3)),
        walking_speed_mps=float(raw.get("walking_speed_mps", 1)),
        trip_factor=float(raw.get("trip_factor", 2)),
        ladder_levels=ladder,
        ladder_penalty_s=float(pen.get("LADDER", 20)),
        band_weights=bw or {"Strong": 1.0, "Moderate": 0.5},
        velocity_shares=raw.get("velocity_class_shares")
        or {"Super High": 0.08, "High": 0.22, "Medium": 0.40},
        handling_s_per_carton=float(raw.get("handling_seconds_per_carton", 8)),
        payback_presets=tuple(int(x) for x in raw.get("payback_presets_days", (7, 30, 60, 90))),
        max_moves=raw.get("max_moves"),
        sa_cold_iterations=int(sa.get("cold_iterations", 400_000)),
        sa_cold_temperature=float(cold_t),
        sa_hot_iterations=int(sa.get("hot_iterations", 400_000)),
        sa_seeds=int(sa.get("hot_passes", 1)),
        sa_freeze_fraction=float(sa.get("freeze_fraction", 0.08)),
        sa_min_temperature=float(sa.get("min_temperature_s", 0.01)),
        sa_target_accept=float(sa.get("target_accept", 0.30)),
        sa_calibration_samples=int(sa.get("calibration_samples", 400)),
        sa_calibration_seed=int(sa.get("calibration_seed", 12_345)),
        sa_intensify_iterations=int(sa.get("intensify_iterations", 5_000)),
        sa_intensify_seed=int(sa.get("intensify_seed", 99_991)),
        sa_intensify_temp_fraction=float(sa.get("intensify_temp_fraction", 0.05)),
        sa_resync_every=int(sa.get("resync_every", 2_000)),
        sa_start_temperature=(float(hot_pin) if hot_pin is not None else None),
    )


# --------------------------------------------------------------------------
# Snapshot
# --------------------------------------------------------------------------
@dataclass
class Slot:
    binid: str
    zone: str
    aisle: int
    rack: int
    level: int
    face: int
    bin_no: int
    geo: Bin
    hdist: float = 0.0         # metres from the dock (horizontal only, excludes the ladder)
    access: float = 0.0        # seconds for one pick trip (INCLUDES the ladder penalty)


@dataclass
class Product:
    productid: str
    name: str
    cartons_per_day: float
    packs_per_carton: int
    case: dict
    bins: list[str]            # current group, in id order
    cartons_held: float        # for the move cost
    max_cartons_in_bin: int    # the per-bin load the new bins must take


@dataclass
class Snapshot:
    warehouseid: str
    slots: dict[str, Slot]
    runs: dict[tuple[str, int], list[str]]            # (zone, aisle) -> bin ids in id order
    products: dict[str, Product]
    pairs: list[tuple[str, str, float, str, float]]   # (a, b, picks together/day, band, lift)
    uc1_runid: str | None
    uc1_rule_count: int
    uc1_rules_skipped: int                            # multi-antecedent or unknown product
    uc2_asof: str | None
    uc2_rows_used: int
    skipped_products: tuple[str, ...]                 # had bins but no usable storage record


def _parse(binid: str, geo: Bin) -> Slot:
    m = _BIN_ID.match(binid)
    if not m:
        raise ValueError(f"bin id {binid!r} is not ZONE-A##-R##-L##-F##-B##")
    g = m.groupdict()
    return Slot(
        binid, g["zone"].upper(), int(g["aisle"]), int(g["rack"]),
        int(g["level"]), int(g["face"]), int(g["bin"]), geo,
    )


def load_snapshot(
    conn,
    s: Settings,
    warehouseid: str = "WH001",
    upstream_uc1_runid: str | None = None,
) -> Snapshot:
    empty = Snapshot(warehouseid, {}, {}, {}, [], None, 0, 0, None, 0, ())

    # ---- bins ----
    rows = conn.execute(
        "SELECT binid, lengthcm, widthcm, heightcm, maxweightkg FROM bin "
        "WHERE warehouseid = %s AND upper(status) = 'ACTIVE' ORDER BY binid",
        (warehouseid,),
    ).fetchall()
    slots: dict[str, Slot] = {}
    for b, l, w, h, mw in rows:
        slots[b] = _parse(
            b, Bin(b, b.split("-")[0], float(l or 0), float(w or 0), float(h or 0), float(mw or 0))
        )
    if not slots:
        return empty

    zones = sorted({x.zone for x in slots.values()})
    zi = {z: i for i, z in enumerate(zones)}
    for x in slots.values():
        x.hdist = zi[x.zone] * s.zone_distance_m + (x.aisle - 1) * s.aisle_distance_m
        x.access = (
            x.hdist / s.walking_speed_mps * s.trip_factor
            + (s.ladder_penalty_s if x.level in s.ladder_levels else 0.0)
        )
    runs: dict[tuple[str, int], list[str]] = defaultdict(list)
    for b in sorted(slots):                     # id order = aisle, rack, level, face, bin
        runs[(slots[b].zone, slots[b].aisle)].append(b)

    # ---- current layout: latest row per product x bin ----
    cur = conn.execute(
        """
        SELECT DISTINCT ON (productid, binid) productid, binid, qtyonhand
        FROM inventory WHERE warehouseid = %s AND binid IS NOT NULL
        ORDER BY productid, binid, lastupdated DESC, inventoryid DESC
        """,
        (warehouseid,),
    ).fetchall()
    bins_of: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for p, b, q in cur:
        if b in slots:
            bins_of[p].append((b, int(q)))
    ids = sorted(bins_of)
    if not ids:
        return Snapshot(warehouseid, slots, dict(runs), {}, [], None, 0, 0, None, 0, ())

    prod = {
        r[0]: r
        for r in conn.execute(
            "SELECT productid, productname FROM product WHERE productid = ANY(%s)", (ids,)
        )
    }
    stor = {
        r[0]: r
        for r in conn.execute(
            'SELECT productid, shippingcasepack, "Length_mm", "Width_mm", "Height_mm", '
            'casegrossweight_kg FROM storage WHERE productid = ANY(%s)',
            (ids,),
        )
    }

    # ---- UC2: measured demand, all rows at ONE shared asofdate ----
    # Pinning to max(asofdate) guarantees every product in this snapshot is
    # described by the same UC2 vintage. Mixing vintages would make the
    # demand-weighted comparison meaningless and the provenance stamp a lie.
    asof_row = conn.execute(
        "SELECT max(asofdate) FROM uc2_policy_parameters WHERE productid = ANY(%s)", (ids,)
    ).fetchone()
    uc2_asof = asof_row[0] if asof_row else None

    demand: dict[str, float] = defaultdict(float)
    uc2_rows_used = 0
    if uc2_asof is not None:
        for p, d in conn.execute(
            "SELECT productid, avgdailydemand FROM uc2_policy_parameters "
            "WHERE productid = ANY(%s) AND asofdate = %s",
            (ids, uc2_asof),
        ):
            demand[p] += float(d or 0)
            uc2_rows_used += 1

    # ---- products ----
    products: dict[str, Product] = {}
    skipped: list[str] = []
    for p in ids:
        st = stor.get(p)
        if not st:
            # Without a shipping case we cannot fit- or weight-check any bin, so
            # the product is excluded. Reported to the caller, never silent.
            skipped.append(p)
            continue
        pack = max(1, int(st[1] or 1))
        case = {
            "case_l_cm": float(st[2] or 0) / 10,
            "case_w_cm": float(st[3] or 0) / 10,
            "case_h_cm": float(st[4] or 0) / 10,
            "case_kg": float(st[5] or 0),
        }
        products[p] = Product(
            productid=p,
            name=prod[p][1] if p in prod else p,
            cartons_per_day=demand[p] / pack,
            packs_per_carton=pack,
            case=case,
            bins=sorted(b for b, _ in bins_of[p]),
            cartons_held=sum(q for _, q in bins_of[p]) / pack,
            max_cartons_in_bin=max(1, math.ceil(max(q for _, q in bins_of[p]) / pack)),
        )

    # ---- UC1: ONE run id, this warehouse only ----
    # The orchestrator's upstream_uc1_runid wins, so UC3 consumes exactly the
    # affinity snapshot the pipeline handed it. The fallback lookup is scoped to
    # this warehouse so it can never pick up a per-site rule set by accident.
    uc1_runid = upstream_uc1_runid
    if not uc1_runid:
        row = conn.execute(
            """
            SELECT pr.runid FROM productrelationship pr JOIN modelrun m USING (runid)
            WHERE pr.warehouseid = %s
            ORDER BY m.generatedate DESC LIMIT 1
            """,
            (warehouseid,),
        ).fetchone()
        uc1_runid = row[0] if row else None

    pairs: list[tuple[str, str, float, str, float]] = []
    rules_skipped = 0
    if uc1_runid:
        best: dict[tuple[str, str], tuple] = {}
        for cons, conf, lift, strength, ants in conn.execute(
            """
            SELECT pr.consequent_productid, pr.confidence, pr.lift, pr.strength,
                   array_agg(pa.antecedent_productid)
            FROM productrelationship pr JOIN productrelationshipantecedent pa USING (relationshipid)
            WHERE pr.runid = %s AND pr.warehouseid = %s AND pr.strength IN ('Strong', 'Moderate')
            GROUP BY pr.relationshipid, 1, 2, 3, 4
            """,
            (uc1_runid, warehouseid),
        ):
            # UC3's cost model is defined over PAIRS of groups, so only
            # single-antecedent rules are usable. Larger itemsets are counted
            # rather than silently discarded.
            if len(ants) != 1 or ants[0] not in products or cons not in products:
                rules_skipped += 1
                continue
            a, b = sorted((ants[0], cons))
            together = min(
                products[ants[0]].cartons_per_day, products[cons].cartons_per_day
            ) * float(conf or 0)
            key = (a, b)
            if key not in best or together > best[key][2]:
                best[key] = (a, b, together, strength, float(lift or 0))
        pairs = list(best.values())

    return Snapshot(
        warehouseid=warehouseid,
        slots=slots,
        runs=dict(runs),
        products=products,
        pairs=pairs,
        uc1_runid=uc1_runid,
        uc1_rule_count=len(pairs),
        uc1_rules_skipped=rules_skipped,
        uc2_asof=uc2_asof.isoformat() if uc2_asof else None,
        uc2_rows_used=uc2_rows_used,
        skipped_products=tuple(skipped),
    )


# --------------------------------------------------------------------------
# Validation and scoring (shared with UC4)
# --------------------------------------------------------------------------
def placement_problems(
    p: Product, bins: list[str], snap: Snapshot, owner: dict[str, str | None]
) -> list[str]:
    """Why these bins cannot hold this product's group; empty list = valid."""
    out: list[str] = []
    if len(bins) != len(p.bins):
        out.append("group size changed")
    keys = {(snap.slots[b].zone, snap.slots[b].aisle) for b in bins}
    if len(keys) != 1:
        out.append("bins span more than one zone or aisle")
    else:
        run = snap.runs[next(iter(keys))]
        idx = sorted(run.index(b) for b in bins)
        if idx != list(range(idx[0], idx[0] + len(idx))):
            out.append("bins are not consecutive")
    for b in bins:
        o = owner.get(b)
        if o not in (None, p.productid):
            out.append(f"{b} holds {o}")
        if cartons_per_bin(p.case, snap.slots[b].geo) < p.max_cartons_in_bin:
            out.append(f"{b} cannot hold {p.max_cartons_in_bin} cartons by size or weight")
    return out


class Layout:
    """Assignment of groups to bins with incremental scoring in seconds per day."""

    def __init__(self, snap: Snapshot, s: Settings, payback_days: float):
        self.snap, self.s, self.payback = snap, s, float(payback_days)
        self.bins: dict[str, list[str]] = {p: list(x.bins) for p, x in snap.products.items()}
        self.home: dict[str, list[str]] = {p: list(x.bins) for p, x in snap.products.items()}
        self.owner: dict[str, str | None] = {b: None for b in snap.slots}
        for p, bs in self.bins.items():
            for b in bs:
                self.owner[b] = p
        # bin -> ((zone, aisle), position in that run). Precomputed because
        # is_single_run() is called inside the annealing loop, where a
        # list.index() scan per check would dominate the runtime.
        self.slot_pos: dict[str, tuple[tuple[str, int], int]] = {}
        for key, run in snap.runs.items():
            for i, b in enumerate(run):
                self.slot_pos[b] = (key, i)
        # adjacency index: p -> [(partner, band_weight * picks_together, lift)].
        # Built once; scanning the pair list per lookup is fine for one greedy
        # pass but fatal inside a 20,000-iteration annealing loop.
        self.partners: dict[str, list[tuple[str, float, float]]] = defaultdict(list)
        for a, b, together, band, lift in snap.pairs:
            w = s.band_weights.get(band, 0.0) * together
            self.partners[a].append((b, w, lift))
            self.partners[b].append((a, w, lift))

    # -- pieces ------------------------------------------------------------
    def mean_access(self, bins) -> float:
        return sum(self.snap.slots[b].access for b in bins) / len(bins)

    def centroid(self, bins) -> float:
        return sum(self.snap.slots[b].hdist for b in bins) / len(bins)

    def pick_cost(self, p: str, bins=None) -> float:
        return self.snap.products[p].cartons_per_day * self.mean_access(bins or self.bins[p])

    def companion_cost(self, p: str, bins=None, exclude: str | None = None) -> float:
        """p's share of its companion terms. `exclude` omits one partner."""
        c = self.centroid(bins or self.bins[p])
        return sum(
            w * abs(c - self.centroid(self.bins[q])) / self.s.walking_speed_mps
            for q, w, _ in self.partners.get(p, ())
            if q != exclude
        )

    def move_cost(self, p: str, bins=None) -> float:
        bins = bins or self.bins[p]
        if bins == self.home[p]:
            return 0.0
        pr = self.snap.products[p]
        labour = sum(
            self.snap.slots[a].access + self.snap.slots[b].access
            for a, b in zip(self.home[p], bins)
        )
        labour += pr.cartons_held * self.s.handling_s_per_carton
        return labour / self.payback

    def product_cost(self, p: str, bins=None) -> float:
        return self.pick_cost(p, bins) + self.companion_cost(p, bins) + self.move_cost(p, bins)

    def total(self, with_moves: bool = True) -> dict:
        pick = sum(self.pick_cost(p) for p in self.bins)
        comp = 0.0
        for a, b, together, band, _ in self.snap.pairs:
            w = self.s.band_weights.get(band, 0.0) * together
            comp += (
                w
                * abs(self.centroid(self.bins[a]) - self.centroid(self.bins[b]))
                / self.s.walking_speed_mps
            )
        move = sum(self.move_cost(p) for p in self.bins) if with_moves else 0.0
        moved = sum(1 for p in self.bins if self.bins[p] != self.home[p])
        return {"pick": pick, "companion": comp, "move": move,
                "total": pick + comp + move, "moved": moved}

    def moved_count(self) -> int:
        return sum(1 for p in self.bins if self.bins[p] != self.home[p])

    def weighted_avg_access(self) -> float | None:
        """Demand-weighted average access time -- the documented UC3 metric."""
        total_demand = sum(x.cartons_per_day for x in self.snap.products.values())
        if total_demand <= 0:
            return None
        return sum(self.pick_cost(p) for p in self.bins) / total_demand

    # -- candidate runs ----------------------------------------------------
    def free_runs(self, p: str, keys=None):
        """Runs of consecutive bins (one zone, one aisle) free or already p's."""
        n = len(self.bins[p])
        for key in (keys if keys is not None else self.snap.runs):
            run = self.snap.runs[key]
            k = 0
            for i, b in enumerate(run):
                k = k + 1 if self.owner[b] in (None, p) else 0
                if k >= n:
                    yield run[i - n + 1:i + 1]

    def is_single_run(self, bins) -> bool:
        """True if `bins` are CONSECUTIVE bins of one zone and one aisle.

        The source inventory may hold a product across several aisles (overflow
        stock put wherever there was space), so this is not guaranteed of the
        starting layout -- only of placements UC3 itself creates.
        """
        if not bins:
            return False
        keys = {self.slot_pos[b][0] for b in bins}
        if len(keys) != 1:
            return False
        idx = sorted(self.slot_pos[b][1] for b in bins)
        return idx == list(range(idx[0], idx[0] + len(idx)))

    def fits(self, p: str, bins) -> bool:
        pr = self.snap.products[p]
        return all(
            cartons_per_bin(pr.case, self.snap.slots[b].geo) >= pr.max_cartons_in_bin
            for b in bins
        )

    def best_runs(self, p: str, limit: int = 40):
        """Candidate runs with the lowest mean access time (picking dominates)."""
        cands = [(self.mean_access(bins), bins) for bins in self.free_runs(p) if self.fits(p, bins)]
        cands.sort(key=lambda x: x[0])
        return [b for _, b in cands[:limit]]

    # -- mutation ----------------------------------------------------------
    def place(self, p: str, bins: list[str]) -> None:
        for b in self.bins[p]:
            self.owner[b] = None
        for b in bins:
            self.owner[b] = p
        self.bins[p] = list(bins)

    def swap(self, p: str, q: str) -> None:
        """Exchange two groups, keeping the owner map consistent throughout."""
        bp, bq = list(self.bins[p]), list(self.bins[q])
        for b in bp:
            self.owner[b] = q
        for b in bq:
            self.owner[b] = p
        self.bins[p], self.bins[q] = bq, bp

    # -- deltas ------------------------------------------------------------
    def delta_move(self, p: str, bins: list[str]) -> float:
        """Change in TOTAL cost if p moved to `bins`.

        total() counts each pair once and product_cost(p) carries p's whole
        share of every pair it belongs to, so for a single move this is exact
        with no second term.
        """
        return self.product_cost(p, bins) - self.product_cost(p)

    def delta_swap(self, p: str, q: str) -> float:
        """Change in TOTAL cost if p and q exchanged bins. Pure: no mutation.

        The p-q companion term is excluded from both sides. It would in fact
        cancel if left in -- swapping two groups leaves the distance between
        THEM unchanged, so the term is identical before and after -- but
        dropping it keeps the arithmetic smaller and the intent explicit.

        Computing this without mutating the layout is the real gain over
        placing the groups, measuring, and unwinding by hand: there is no
        partially-applied state to leak if anything raises midway.
        """
        bp, bq = self.bins[p], self.bins[q]
        before = (
            self.pick_cost(p, bp) + self.pick_cost(q, bq)
            + self.move_cost(p, bp) + self.move_cost(q, bq)
            + self.companion_cost(p, bp, exclude=q)
            + self.companion_cost(q, bq, exclude=p)
        )
        after = (
            self.pick_cost(p, bq) + self.pick_cost(q, bp)
            + self.move_cost(p, bq) + self.move_cost(q, bp)
            + self.companion_cost(p, bq, exclude=q)
            + self.companion_cost(q, bp, exclude=p)
        )
        return after - before

    def snapshot_bins(self) -> dict[str, list[str]]:
        return {p: list(b) for p, b in self.bins.items()}

    def restore(self, bins: dict[str, list[str]]) -> None:
        """Replace the WHOLE assignment at once.

        Deliberately not a loop over place(). Restoring product by product, a
        product still recorded on a bin that an earlier product has already
        been restored onto will clear that bin's owner when its own turn comes
        -- leaving the bin reading FREE while a group sits on it. free_runs()
        would then offer that bin to a third product, and placement_problems()
        could not see the resulting overlap, because it trusts the owner map.
        Rebuilding the map from scratch cannot drift.
        """
        self.bins = {p: list(b) for p, b in bins.items()}
        self.owner = {b: None for b in self.snap.slots}
        for p, bs in self.bins.items():
            for b in bs:
                self.owner[b] = p

    def overlaps(self) -> list[tuple[str, str, str]]:
        """(bin, product, product) for each bin claimed by two groups.

        Derived from `bins` alone, never from `owner`, so it still holds when
        the owner map is wrong. This is the check that catches an owner-map
        defect, which is exactly why it must not share that map as its source.
        """
        seen: dict[str, str] = {}
        out: list[tuple[str, str, str]] = []
        for p, bs in self.bins.items():
            for b in bs:
                if b in seen:
                    out.append((b, seen[b], p))
                seen[b] = p
        return out


# --------------------------------------------------------------------------
# Phase 1: heuristic
# --------------------------------------------------------------------------
def heuristic(lay: Layout, s: Settings) -> list[str]:
    """Highest demand first: move a group to its best run if that pays back.

    "Pays back" is enforced by the cost function itself, not a separate test:
    delta_move already includes the amortised relocation labour, so a negative
    delta IS a move that repays its own cost within the payback period.
    """
    moved: list[str] = []
    order = sorted(lay.bins, key=lambda p: -lay.snap.products[p].cartons_per_day)
    for p in order:
        if s.max_moves is not None and len(moved) >= s.max_moves:
            break
        best, best_bins = 0.0, None
        for bins in lay.best_runs(p):
            d = lay.delta_move(p, bins)
            if d < best - 1e-9:
                best, best_bins = d, bins
        if best_bins is not None:
            lay.place(p, best_bins)
            moved.append(p)
    return moved


# --------------------------------------------------------------------------
# Phase 2: simulated annealing
# --------------------------------------------------------------------------
def _propose(lay: Layout, s: Settings, rng, ids: list[str], keys: list):
    """Pick one random neighbouring layout and score it WITHOUT applying it.

    Returns (kind, payload, delta) or None when the draw produced nothing
    valid. Invalid moves are rejected here, before scoring. Shared by the
    temperature calibration and the annealing loop, so the calibration sees
    exactly the move distribution the search will.
    """
    p = ids[rng.integers(len(ids))]
    roll = rng.random()

    if roll < 0.45:                                   # relocate to a free run
        key = keys[rng.integers(len(keys))]
        cands = [r for r in lay.free_runs(p, [key])]
        if not cands:
            return None
        new = cands[rng.integers(len(cands))]
        if new == lay.bins[p] or not lay.fits(p, new):
            return None
        # a hard cap on moved products is a constraint, not a cost: reject a
        # move that would newly displace a product beyond the cap
        if (
            s.max_moves is not None
            and new != lay.home[p]
            and lay.bins[p] == lay.home[p]
            and lay.moved_count() >= s.max_moves
        ):
            return None
        return ("move", (p, new), lay.delta_move(p, new))

    if roll < 0.80:                                   # swap two equal-size groups
        q = ids[rng.integers(len(ids))]
        if q == p or len(lay.bins[q]) != len(lay.bins[p]):
            return None
        if not lay.fits(p, lay.bins[q]) or not lay.fits(q, lay.bins[p]):
            return None
        # A swap hands each product the other's bin set verbatim. If either set
        # straddles an aisle -- which the SOURCE layout may well do -- the
        # receiver inherits an invalid group. Relocating such a product to a
        # proper run is allowed (and repairs it); passing the bad set on is not.
        if not (lay.is_single_run(lay.bins[p]) and lay.is_single_run(lay.bins[q])):
            return None
        return ("swap", (p, q), lay.delta_swap(p, q))

    # send a group home (un-move it)
    if lay.bins[p] == lay.home[p]:
        return None
    home = lay.home[p]
    if any(lay.owner[b] not in (None, p) for b in home):
        return None
    return ("move", (p, home), lay.delta_move(p, home))


def _apply(lay: Layout, kind: str, payload) -> None:
    if kind == "move":
        lay.place(payload[0], payload[1])
    else:
        lay.swap(payload[0], payload[1])


def calibrate_temperature(lay: Layout, s: Settings) -> float:
    """Pick T0 so roughly `sa_target_accept` of worsening moves are accepted.

    Uses a FIXED calibration seed, so T0 is a deterministic function of the
    data: it adapts when the cost scale changes -- each payback preset has its
    own scale -- but never varies between reruns of the same snapshot. A T0
    drawn from the main RNG, or from the clock, would break reproducibility.

    From exp(-d / T) = target  =>  T = -mean_positive_delta / ln(target).
    """
    if s.sa_start_temperature is not None:
        return s.sa_start_temperature
    rng = np.random.default_rng(s.sa_calibration_seed)
    ids, keys = list(lay.bins), list(lay.snap.runs)
    if not ids or not keys:
        return max(s.sa_min_temperature, 1.0)
    positives: list[float] = []
    for _ in range(s.sa_calibration_samples):
        proposal = _propose(lay, s, rng, ids, keys)
        if proposal and proposal[2] > 0:
            positives.append(proposal[2])
    if not positives:
        return max(s.sa_min_temperature, 1.0)
    mean_positive = sum(positives) / len(positives)
    target = min(max(s.sa_target_accept, 1e-6), 1 - 1e-6)
    return max(s.sa_min_temperature, -mean_positive / math.log(target))


def derive_cooling(t_start: float, t_min: float, iterations: int) -> float:
    """Geometric rate that reaches t_min exactly at the last iteration.

    A hard-coded 0.995 over 20,000 iterations drives T to ~1e-43: the search
    is frozen after roughly 2,000 steps and the remaining 90% of the run is a
    plain hill-climb. Deriving the rate from the iteration count keeps it
    annealing all the way through.
    """
    if iterations <= 1 or t_start <= 0 or t_min <= 0 or t_min >= t_start:
        return 0.999
    return (t_min / t_start) ** (1.0 / iterations)


def anneal(lay: Layout, s: Settings, seed: int, t_start: float, iterations: int) -> float:
    """One SA run from the layout as given. Returns the best total found.

    The layout is left holding the BEST layout seen, not the last one visited:
    because SA deliberately accepts worsening moves, the final state is usually
    not the best, so a separate best-so-far snapshot is required.
    """
    rng = np.random.default_rng(seed)
    ids, keys = list(lay.bins), list(lay.snap.runs)
    if not ids or not keys or iterations <= 0:
        return lay.total()["total"]

    # Cool to the floor within the first `sa_freeze_fraction` of the round, then
    # hold at the floor: a brief annealing phase to escape the incumbent's local
    # optimum, followed by descent for the remainder.
    freeze_at = max(1, int(iterations * s.sa_freeze_fraction))
    cooling = derive_cooling(t_start, s.sa_min_temperature, freeze_at)
    T = t_start
    cur = lay.total()["total"]
    best = cur
    best_bins = lay.snapshot_bins()

    for it in range(1, iterations + 1):
        proposal = _propose(lay, s, rng, ids, keys)
        if proposal is not None:
            kind, payload, d = proposal
            # accept anything better; accept worse with probability exp(-d/T)
            if d <= 0 or rng.random() < math.exp(-d / max(T, 1e-12)):
                _apply(lay, kind, payload)
                cur += d

        # Re-anchor the running total to the truth. `cur` is accumulated from
        # deltas for speed; over tens of thousands of additions rounding drifts,
        # and `best` is tracked from `cur`, so without this a drifted total
        # could crown a layout that is not actually the best one seen.
        if s.sa_resync_every and it % s.sa_resync_every == 0:
            cur = lay.total()["total"]
            if cur < best - 1e-9:
                best, best_bins = cur, lay.snapshot_bins()

        if cur < best - 1e-9:
            best, best_bins = cur, lay.snapshot_bins()
        # Clamped at the floor rather than decaying to zero, so the post-freeze
        # phase is an explicit low-temperature descent instead of a float
        # underflow that happens to behave like one.
        T = max(T * cooling, s.sa_min_temperature)

    lay.restore(best_bins)
    return lay.total()["total"]          # the truth, not the accumulated value


# --------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------
def velocity_classes(snap: Snapshot, s: Settings) -> dict[str, str]:
    """Band products by demand rank, fastest first.

    uc2_policy_parameters has no velocityclass column, so the class is derived
    here from the UC2 demand this snapshot already carries. Banding is by RANK,
    not by absolute demand, so the shares hold whatever the demand scale.
    """
    order = sorted(snap.products, key=lambda p: -snap.products[p].cartons_per_day)
    n = len(order)
    cls = {}
    cut1 = int(round(n * s.velocity_shares["Super High"]))
    cut2 = cut1 + int(round(n * s.velocity_shares["High"]))
    cut3 = cut2 + int(round(n * s.velocity_shares["Medium"]))
    for i, p in enumerate(order):
        cls[p] = "Super High" if i < cut1 else "High" if i < cut2 else "Medium" if i < cut3 else "Low"
    return cls


def _priority(saved_s_per_day: float) -> str:
    if saved_s_per_day > 300:
        return "Critical"
    if saved_s_per_day > 60:
        return "High"
    if saved_s_per_day > 10:
        return "Medium"
    return "Low"


def _direction(pick_saved: float, comp_saved: float) -> str:
    """Label the dominant reason for the move, WITHOUT abs().

    Comparing magnitudes with abs() meant a move that badly SEPARATED
    companions was labelled "Companion consolidation" -- the opposite of what
    happened. Only a genuine positive companion gain earns that label now.
    """
    if pick_saved > 0 and comp_saved > 0:
        return "Toward packing" if pick_saved >= comp_saved else "Companion consolidation"
    if pick_saved > 0:
        return "Toward packing"              # bought pick speed, gave up companion closeness
    if comp_saved > 0:
        return "Companion consolidation"     # walked further out to sit beside a companion
    return "Layout rebalance"                # freed a slot a better mover needed


def _reason(saved: float, pick_saved: float, comp_saved: float,
            has_partners: bool, payback_days: float | None) -> str:
    """Plain-language rationale. Signed, so a trade-off reads as a trade-off."""
    if saved >= 0:
        parts = [f"Saves {saved:.0f} s/day"]
    else:
        parts = [f"Costs {abs(saved):.0f} s/day here, accepted to improve the layout overall"]
    parts.append(f"picking {pick_saved:+.0f} s/day")
    if has_partners:
        parts.append(f"companion walking {comp_saved:+.0f} s/day")
    if payback_days is not None:
        parts.append(f"pays back in {payback_days:.0f} days")
    return "; ".join(parts)


def recommendation_rows(lay: Layout, runid: str, classes: dict[str, str]) -> list[tuple]:
    """One row per bin that moves.

    distanceimprovementm   horizontal metres only, excluding the ladder penalty,
                           as the column name says. Clamped at 0.
    distanceimprovementpct fractional improvement in ACCESS TIME, so the ladder
                           penalty IS reflected. Clamped to [0,1] for the CHECK.
    timesavedseconds       this product's own seconds/day saved, ladder included.
                           May be NEGATIVE: a move can be accepted because it
                           improves the total layout at this product's expense.
                           The whole-run saving is guaranteed non-negative by
                           uc3_run, which is where that invariant belongs.
    """
    rows: list[tuple] = []
    today = date.today().isoformat()
    for p in sorted(lay.bins):
        if lay.bins[p] == lay.home[p]:
            continue
        pr = lay.snap.products[p]
        home = lay.home[p]

        pick_saved = lay.pick_cost(p, home) - lay.pick_cost(p)
        comp_saved = lay.companion_cost(p, home) - lay.companion_cost(p)
        saved = pick_saved + comp_saved

        partners = lay.partners.get(p, [])
        lift = max((l for _, _, l in partners), default=None)
        move_labour = lay.move_cost(p) * lay.payback          # back out the amortisation
        payback_days = (move_labour / saved) if saved > 1e-9 else None

        direction = _direction(pick_saved, comp_saved)
        reason = _reason(saved, pick_saved, comp_saved, bool(partners), payback_days)
        priority = _priority(saved)

        # access-time improvement for the whole group, ladder included
        access_home = lay.mean_access(home)
        access_now = lay.mean_access(lay.bins[p])
        pct = ((access_home - access_now) / access_home) if access_home else 0.0
        pct = min(1.0, max(0.0, pct))

        for k, (cb, rb) in enumerate(zip(home, lay.bins[p]), 1):
            rows.append((
                f"{runid}:{p}:{k}",
                lay.snap.warehouseid,
                p,
                classes[p],                             # from velocity_classes()
                direction,
                reason,
                max(0.0, lay.snap.slots[cb].hdist - lay.snap.slots[rb].hdist),
                pct,
                priority,
                round(pr.cartons_per_day, 4),
                bool(partners) and comp_saved > 0,
                lift,
                today,
                cb,
                rb,
                runid,
                round(saved, 4),                        # signed; negatives are legitimate
            ))
    return rows


REC_COLS = (
    "movefieldid", "warehouseid", "productid", "velocityclass", "movedirection", "reason",
    "distanceimprovementm", "distanceimprovementpct", "priority", "avgdailydemand",
    "forconsolidation", "lift", "lastupdated", "currentbin", "recommendedbin", "runid",
    "timesavedseconds",
)

UC3_RUN_COLS = (
    "runid", "batchid", "payback_days",
    "current_pick_s", "current_companion_s",
    "heuristic_pick_s", "heuristic_companion_s", "heuristic_move_s",
    "sa_pick_s", "sa_companion_s", "sa_move_s",
    "saved_s_per_day", "heuristic_to_sa_s", "actual_payback_days",
    "current_avg_access_s", "sa_avg_access_s",
    "products_total", "products_moved", "bins_total", "bins_moved",
    "sa_seeds_tested", "sa_seed_scores", "sa_seed_best", "sa_seed_score_best",
    "sa_intensify_seed", "sa_intensify_gain_s",
    "sa_iterations", "sa_start_temperature", "sa_cooling_rate", "sa_min_temperature",
    "sa_calibrated",
    "upstream_uc1_runid", "uc1_rule_count", "uc2_asofdate", "uc2_rows_used",
)


# --------------------------------------------------------------------------
# Solve
# --------------------------------------------------------------------------
def solve(snap: Snapshot, s: Settings, payback: int, log=print) -> tuple[Layout, dict]:
    t0 = time.time()
    lay = Layout(snap, s, payback)

    # current layout: NO move cost, by definition (nothing moved to reach it)
    current = lay.total(with_moves=False)
    current_running = current["pick"] + current["companion"]
    current_avg_access = lay.weighted_avg_access()

    # ---- Phase 1: heuristic ----
    moved = heuristic(lay, s)
    heur = lay.total()
    heur_bins = lay.snapshot_bins()
    heur_running = heur["pick"] + heur["companion"]
    log(f"    heuristic: {heur['total']:,.0f} s/day incl. moves "
        f"({len(moved)} products moved) in {time.time() - t0:.0f}s")

    # ---- Phase 2 stage 1: COLD saturation (pure descent) ----
    # heuristic() has already exhausted its OWN neighbourhood -- it relocates a
    # product to a free run, and a second pass of it moves nothing -- but it
    # never swaps two products, and swaps are where the remaining value is.
    # This stage descends through that neighbourhood at a temperature too low to
    # accept a worsening move, until improving draws dry up.
    seed_scores: dict[str, float] = {}
    best_total, best_bins = heur["total"], heur_bins
    if s.sa_cold_iterations > 0:
        cold = anneal(lay, s, 0, s.sa_cold_temperature, s.sa_cold_iterations)
        if cold < best_total - 1e-9:
            best_total, best_bins = cold, lay.snapshot_bins()
        log(f"    cold stage: {heur['total']:,.0f} -> {best_total:,.0f} s/day "
            f"({s.sa_cold_iterations:,} draws at T={s.sa_cold_temperature:g}, "
            f"i.e. pure descent) in {time.time() - t0:.0f}s")
    cold_best = best_total
    seed_scores["cold"] = round(cold_best, 4)
    seed_scores["cold_draws"] = s.sa_cold_iterations

    # ---- Phase 2 stage 2: HOT reheat rounds ----
    # T0 is calibrated HERE, on the saturated layout, not on the heuristic
    # layout: the move deltas the hot stage actually faces are the ones that
    # should set its temperature. Each round reheats from the incumbent best, so
    # rounds compound rather than re-attempting the same problem.
    # sa_seed_scores is therefore a monotone improvement TRAJECTORY -- "cold"
    # first, then one entry per hot round -- not a sample of independent runs.
    lay.restore(best_bins)
    cold_totals = lay.total()
    cold_running = cold_totals["pick"] + cold_totals["companion"]
    t_start = calibrate_temperature(lay, s)
    cooling = derive_cooling(
        t_start, s.sa_min_temperature, max(1, int(s.sa_hot_iterations * s.sa_freeze_fraction))
    )
    descent_per_pass = s.sa_hot_iterations - int(s.sa_hot_iterations * s.sa_freeze_fraction)
    log(f"    hot stage: T0={t_start:,.3f} s/day "
        f"({'calibrated at the saturated layout' if s.sa_start_temperature is None else 'pinned'}), "
        f"cooling={cooling:.6f}, {s.sa_seeds} x {s.sa_hot_iterations:,} draws "
        f"({descent_per_pass:,} of each pass spent descending after the freeze)")

    seeds = list(range(s.sa_seeds))
    best_seed = None
    for seed in seeds:
        lay.restore(best_bins)
        score = anneal(lay, s, seed, t_start, s.sa_hot_iterations)
        seed_scores[str(seed)] = round(score, 4)
        if score < best_total - 1e-9:
            best_total, best_bins, best_seed = score, lay.snapshot_bins(), seed
    diversify_best = best_total
    log(f"    hot result: {cold_best:,.0f} -> {diversify_best:,.0f} s/day "
        f"(last improvement in pass {best_seed}), trajectory "
        f"{[round(seed_scores[str(x)]) for x in seeds]}")

    # ---- Phase 2b: intensification from the single best ----
    lay.restore(best_bins)
    intensified = anneal(
        lay, s, s.sa_intensify_seed,
        max(t_start * s.sa_intensify_temp_fraction, s.sa_min_temperature),
        s.sa_intensify_iterations,
    )
    if intensified < best_total - 1e-9:
        best_total, best_bins = intensified, lay.snapshot_bins()
    intensify_gain = max(0.0, diversify_best - best_total)

    lay.restore(best_bins)
    final = lay.total()

    # ---- never worse than today, compared like for like (all-in vs running) ----
    if final["total"] > current_running + 1e-9:
        lay.restore({p: list(lay.home[p]) for p in lay.bins})
        final = lay.total()

    # ---- hard-constraint check on exactly what will be written ----
    # The shared validator, not an inline shortcut: UC4 judges planner moves
    # with this same function, so algorithmic and manual placements are held
    # to one definition of validity.
    # Only products UC3 is actually RELOCATING are judged. A product left where
    # the inventory already had it is not UC3's placement: real stock is often
    # spread across aisles as overflow, and failing the run over a pre-existing
    # data condition would block every recommendation on the floor. Products
    # that do move are held to the full constraint set, and a move is the one
    # thing that can repair a straddling group.
    problems: list[str] = []
    for p in lay.bins:
        if lay.bins[p] == lay.home[p]:
            continue
        problems.extend(
            f"{p}: {why}"
            for why in placement_problems(snap.products[p], lay.bins[p], snap, lay.owner)
        )
    # Independent double-booking check. placement_problems() reads the owner
    # map, so an owner map that is itself wrong would report a clean layout;
    # overlaps() is derived from the assignment instead, and so is not fooled
    # by the one class of defect that matters most here.
    problems.extend(
        f"{b} assigned to both {p} and {q}" for b, p, q in lay.overlaps()
    )
    if problems:
        raise ValueError("final UC3 layout violates hard constraints: " + "; ".join(problems[:10]))

    sa_running = final["pick"] + final["companion"]
    saved = current_running - sa_running
    heuristic_to_sa = heur_running - sa_running

    log(f"    annealing: {final['total']:,.0f} s/day incl. moves "
        f"({final['moved']} products moved) in {time.time() - t0:.0f}s"
        f"Current vs SA: {saved}"
        f"Heuristic vs SA: {heuristic_to_sa}")

    metrics = {
        "current_pick_s": current["pick"],
        "current_companion_s": current["companion"],
        "heuristic_pick_s": heur["pick"],
        "heuristic_companion_s": heur["companion"],
        "heuristic_move_s": heur["move"],
        "sa_pick_s": final["pick"],
        "sa_companion_s": final["companion"],
        "sa_move_s": final["move"],
        "saved_s_per_day": saved,
        "heuristic_to_sa_s": heuristic_to_sa,
        # Phase 2 split, for the console and for tuning. Not uc3_run columns:
        # the table is unchanged, and sa_seed_scores carries the "cold" entry.
        "heuristic_to_cold_s": heur_running - cold_running,
        "cold_to_hot_s": cold_running - (final["pick"] + final["companion"]),
        "actual_payback_days": ((final["move"] * payback) / saved) if saved > 1e-9 else None,
        "current_avg_access_s": current_avg_access,
        "sa_avg_access_s": lay.weighted_avg_access(),
        "products_total": len(snap.products),
        "products_moved": final["moved"],
        "bins_total": len(snap.slots),
        "bins_moved": sum(len(lay.bins[p]) for p in lay.bins if lay.bins[p] != lay.home[p]),
        "sa_seeds_tested": seeds,
        "sa_seed_scores": seed_scores,
        "sa_seed_best": best_seed,
        "sa_seed_score_best": diversify_best,
        "sa_intensify_seed": s.sa_intensify_seed,
        "sa_intensify_gain_s": intensify_gain,
        # TOTAL draws across both stages, which is what the column should mean
        # now that the search has two of them. The split is in sa_seed_scores
        # ("cold_draws") and in the console line.
        "sa_iterations": s.sa_cold_iterations + s.sa_hot_iterations * s.sa_seeds,
        "sa_start_temperature": t_start,
        "sa_cooling_rate": cooling,
        "sa_min_temperature": s.sa_min_temperature,
        "sa_calibrated": s.sa_start_temperature is None,
    }
    return lay, metrics


def uc3_run_row(runid: str, batch: str, payback: int, m: dict, snap: Snapshot) -> tuple:
    """Shape one uc3_run row in UC3_RUN_COLS order.

    Two different keys, for two different relationships:
      runid   the same value is written to modelrun, to every layoutrecommendation
              row of this run, and to this audit row -- so
              `uc3_run JOIN layoutrecommendation USING (runid)` gives a run
              beside the moves it recommended.
      batchid shared by every payback preset of one invocation. runid cannot
              express this, because each preset mints its own.
    """
    return (
        runid, batch, payback,
        m["current_pick_s"], m["current_companion_s"],
        m["heuristic_pick_s"], m["heuristic_companion_s"], m["heuristic_move_s"],
        m["sa_pick_s"], m["sa_companion_s"], m["sa_move_s"],
        m["saved_s_per_day"], m["heuristic_to_sa_s"], m["actual_payback_days"],
        m["current_avg_access_s"], m["sa_avg_access_s"],
        m["products_total"], m["products_moved"], m["bins_total"], m["bins_moved"],
        json.dumps(m["sa_seeds_tested"]), json.dumps(m["sa_seed_scores"]),
        m["sa_seed_best"], m["sa_seed_score_best"],
        m["sa_intensify_seed"], m["sa_intensify_gain_s"],
        m["sa_iterations"], m["sa_start_temperature"], m["sa_cooling_rate"],
        m["sa_min_temperature"], m["sa_calibrated"],
        snap.uc1_runid, snap.uc1_rule_count, snap.uc2_asof, snap.uc2_rows_used,
    )


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------
def run(*, upstream_uc1_runid: str | None = None, presets=None, dry_run: bool = False) -> StageResult:
    try:
        s = settings_from_config(load_shared_config().get("uc3", {}))
        presets = tuple(presets or s.payback_presets)

        with db.connect(read_only=True) as conn:
            snap = load_snapshot(conn, s, upstream_uc1_runid=upstream_uc1_runid)
            conn.rollback()

        if not snap.products:
            return StageResult("UC3", "", "failed", error="no products with bins at WH001")

        if snap.skipped_products:
            shown = ", ".join(snap.skipped_products[:10])
            more = " ..." if len(snap.skipped_products) > 10 else ""
            print(f"  WARNING: {len(snap.skipped_products)} product(s) excluded for having no "
                  f"storage record: {shown}{more}")
        if snap.uc1_rules_skipped:
            print(f"  note: {snap.uc1_rules_skipped} UC1 rule(s) skipped "
                  f"(multi-antecedent, or a product not stocked at WH001)")

        print(f"  snapshot: {len(snap.products):,} products on "
              f"{sum(len(p.bins) for p in snap.products.values()):,} of {len(snap.slots):,} bins; "
              f"{snap.uc1_rule_count} UC1 pairs from run {snap.uc1_runid}; "
              f"UC2 as of {snap.uc2_asof} ({snap.uc2_rows_used:,} rows)")

        # Products the source inventory already holds across more than one zone
        # or aisle. Reported, not rejected: UC3 can relocate them to a proper
        # run (which repairs them), but leaving them alone is not a UC3 fault.
        straddling = [
            p for p, pr in snap.products.items()
            if len({(snap.slots[b].zone, snap.slots[b].aisle) for b in pr.bins}) != 1
        ]
        if straddling:
            shown = ", ".join(straddling[:10])
            more = " ..." if len(straddling) > 10 else ""
            print(f"  note: {len(straddling)} product(s) are stored across more than one "
                  f"zone/aisle in the source inventory: {shown}{more}")

        # Demand rank is a property of the snapshot, not of a payback preset, so
        # this is computed once and shared: every preset then reports the same
        # class for a given product, which it would not if recomputed per run.
        classes = velocity_classes(snap, s)

        # Each preset mints its own runid, so runid cannot say which presets came
        # from one invocation. batchid carries that, and is what lets the UI
        # offer the 7/30/60/90 options as alternatives on the same snapshot.
        batch = str(uuid.uuid4())
        runids, total_rows = [], 0

        for payback in presets:
            print(f"  payback {payback} days:")
            lay, m = solve(snap, s, payback)
            print(f"    current {m['current_pick_s'] + m['current_companion_s']:,.0f} -> "
                  f"heuristic {m['heuristic_pick_s'] + m['heuristic_companion_s']:,.0f} -> "
                  f"SA {m['sa_pick_s'] + m['sa_companion_s']:,.0f} s/day running cost; "
                  f"saves {m['saved_s_per_day']:,.0f} s/day "
                  f"({m['saved_s_per_day'] / 3600:.1f} h/day), of which SA added "
                  f"{m['heuristic_to_sa_s']:,.0f} "
                  f"(cold {m['heuristic_to_cold_s']:,.0f} + hot {m['cold_to_hot_s']:,.0f}); "
                  f"{m['products_moved']} products / {m['bins_moved']} bins moved"
                  + (f", pays back in {m['actual_payback_days']:.0f} days"
                     if m["actual_payback_days"] else ""))
            if dry_run:
                continue

            runid = str(uuid.uuid4())
            rows = recommendation_rows(lay, runid, classes)
            sig = (
                f"uc3-slotting|batch={batch}|payback_days={payback}|"
                f"upstream_uc1={snap.uc1_runid}|uc2_asof={snap.uc2_asof}|"
                f"zone_m={s.zone_distance_m}|aisle_m={s.aisle_distance_m}|"
                f"speed={s.walking_speed_mps}|trip={s.trip_factor}|"
                f"ladder_s={s.ladder_penalty_s}|handling_s={s.handling_s_per_carton}|"
                f"cold={s.sa_cold_iterations}@T{s.sa_cold_temperature:g}|"
                f"hot={s.sa_hot_iterations}x{s.sa_seeds}|seed_best={m['sa_seed_best']}"
            )

            # modelrun -> layoutrecommendation -> uc3_run, one transaction per
            # preset. uc3_run is written LAST, after the move list it describes,
            # and its CHECK constraints are the final gate: if the run somehow
            # came out worse than today, the insert fails and the whole preset
            # rolls back rather than publishing a bad recommendation.
            with db.connect(read_only=False) as conn:
                conn.execute(
                    "INSERT INTO modelrun (runid, runtype, generatedate, algorithmversion, "
                    "parametersignature) VALUES (%s, %s, %s, %s, %s)",
                    (runid, "UC3", datetime.now(timezone.utc), ALGORITHM_VERSION, sig),
                )
                if rows:
                    with conn.cursor() as cur:
                        cur.executemany(
                            f"INSERT INTO layoutrecommendation ({', '.join(REC_COLS)}) "
                            f"VALUES ({', '.join(['%s'] * len(REC_COLS))})",
                            rows,
                        )
                conn.execute(
                    f"INSERT INTO uc3_run ({', '.join(UC3_RUN_COLS)}) "
                    f"VALUES ({', '.join(['%s'] * len(UC3_RUN_COLS))})",
                    uc3_run_row(runid, batch, payback, m, snap),
                )
                conn.commit()

            runids.append(runid)
            total_rows += len(rows)
            print(f"    saved run {runid} ({len(rows)} bin moves, uc3_run written)")

        return StageResult("UC3", runids[-1] if runids else "", "success",
                           len(snap.products), total_rows)
    except Exception as exc:  # noqa: BLE001
        return StageResult("UC3", "", "failed", error=str(exc))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--preset", type=int, action="append",
                    help="payback preset in days (repeatable); default all")
    ap.add_argument("--uc1-runid", help="upstream UC1 run id to consume")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    r = run(upstream_uc1_runid=a.uc1_runid, presets=a.preset, dry_run=a.dry_run)
    print(f"{r.name}: {r.status} runid={r.runid} in={r.input_rows} out={r.output_rows}")
    if r.error:
        print(f"  {r.error}")
    raise SystemExit(0 if r.ok else 1)