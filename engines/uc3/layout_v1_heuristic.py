"""Deterministic UC3 central-warehouse slotting heuristic.

The live schema stores warehouse -> zone -> bin.  A bin's aisle, rack and
shelf are read from its validated ``ZONE-A##-R##-L##-F##-B##`` identifier;
there are deliberately no invented aisle/rack/shelf tables or columns here.
The pure functions in this module are also the contract for a later SA stage
and for UC4 planner validation.
"""

from __future__ import annotations

import os
import re
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from types import SimpleNamespace
from types import MappingProxyType
from typing import Any, Iterable, Mapping

from dotenv import load_dotenv

from engines.result import StageResult
from engines.shared.db.config import load_shared_config
from engines.shared.paths import REPO_ROOT


ALGORITHM_VERSION = "uc3-heuristic-1.1"
_BIN_ID = re.compile(
    (
        r"^(?P<zone>[^-]+)-A(?P<aisle>\d+)-R(?P<rack>\d+)"
        r"-L(?P<level>\d+)-F(?P<face>\d+)-B(?P<bin>\d+)$"
    ),
    re.IGNORECASE,
)
_PAGE_SIZE = 1_000
_ID_BATCH_SIZE = 200
_SQL_IDENTIFIER = re.compile(r"^[a-z_]+$")
_VELOCITY_RANKS = {
    "SUPER HIGH": 0,
    "HIGH": 1,
    "MEDIUM": 2,
    "LOW": 3,
    # The bundled analytical sample uses the conventional ABC labels.
    "A": 0,
    "B": 1,
    "C": 2,
}
# The live storage relation exposes quoted millimetre column names.  Keep
# those names confined to the direct read adapter and expose stable Python
# aliases to the loader, whose internal geometry is centimetres.
_DATABASE_SELECT_ALIASES = {
    "storage": {
        "case_length_mm": '"Length_mm" AS case_length_mm',
        "case_width_mm": '"Width_mm" AS case_width_mm',
        "case_height_mm": '"Height_mm" AS case_height_mm',
        "case_weight_kg": "casegrossweight_kg AS case_weight_kg",
    }
}


class LayoutDataError(ValueError):
    """Input data cannot produce one safe, complete central layout."""


class NoFeasibleBinError(LayoutDataError):
    """At least one SKU has no valid central bin; nothing may be persisted."""


@dataclass(frozen=True)
class Parameters:
    """One immutable parameter set shared by current and proposed scoring."""

    zone_distance_m: float = 40.0
    aisle_distance_m: float = 3.0
    walking_speed_mps: float = 1.0
    trip_factor: float = 1.0
    affinity_weight: float = 1.0
    use_25d: bool = True
    shelf_penalties_seconds: Mapping[str, float] = field(
        default_factory=lambda: MappingProxyType({"LADDER": 20.0})
    )
    shelf_level_bands: Mapping[int, str] = field(
        default_factory=lambda: MappingProxyType({})
    )
    affinity_band_weights: Mapping[str, float] = field(
        default_factory=lambda: MappingProxyType({"STRONG": 1.0, "MODERATE": 0.5})
    )
    available_bin_statuses: frozenset[str] = frozenset({"AVAILABLE"})
    max_weight_kg_by_shelf_band: Mapping[str, float] = field(
        default_factory=lambda: MappingProxyType({})
    )


@dataclass(frozen=True)
class SKU:
    productid: str
    pick_frequency: float
    current_binid: str
    velocityclass: str
    product_status: str
    length_cm: float
    width_cm: float
    height_cm: float
    weight_kg: float
    units_per_box: int = 1
    boxes_per_carton: int = 1
    storage_condition: str | None = None
    # These live master-data fields are kept with the snapshot for audit
    # purposes. Shelf life is deliberately not a UC3 placement constraint.
    shelf_life_days: int | None = None
    case_cube_mcube: float | None = None

    @property
    def required_volume(self) -> float:
        return (
            self.length_cm * self.width_cm * self.height_cm
            * self.units_per_box * self.boxes_per_carton
        )


@dataclass(frozen=True)
class Slot:
    binid: str
    warehouseid: str
    zoneid: str
    zone_index: int
    aisle_number: int
    rack_number: int
    shelf_level: int
    shelf_band: str
    capacity_volume: float
    status: str
    max_weight_kg: float | None = None
    length_cm: float | None = None
    width_cm: float | None = None
    height_cm: float | None = None
    storage_condition: str | None = None


@dataclass(frozen=True)
class Affinity:
    left_productid: str
    right_productid: str
    strength: str
    lift: float
    weight: float

    def other(self, productid: str) -> str | None:
        if productid == self.left_productid:
            return self.right_productid
        if productid == self.right_productid:
            return self.left_productid
        return None


@dataclass(frozen=True)
class LoadedLayout:
    warehouseid: str
    skus: tuple[SKU, ...]
    slots: tuple[Slot, ...]
    affinities: tuple[Affinity, ...]
    diagnostics: tuple[str, ...] = ()


@dataclass(frozen=True)
class SKUTimeMetric:
    productid: str
    current_access_time: float
    heuristic_access_time: float
    time_saved: float
    improvement_pct: float | None


@dataclass(frozen=True)
class LayoutScores:
    current: float
    heuristic: float


@dataclass(frozen=True)
class HeuristicResult:
    assignments: Mapping[str, str]
    scores: LayoutScores
    parameters: Parameters
    rejected_data_diagnostics: tuple[str, ...]
    per_sku_metrics: Mapping[str, SKUTimeMetric]
    overall_time_saved: float
    overall_improvement_pct: float | None


def parameters_from_config(config: Mapping[str, Any]) -> Parameters:
    """Validate and freeze the UC3 configuration snapshot for this run."""
    raw = config.get("uc3", {})
    penalties = {
        str(k).upper(): float(v)
        for k, v in (raw.get("shelf_penalties_seconds") or {"LADDER": 20}).items()
    }
    if "LADDER" not in penalties:
        penalties["LADDER"] = 20.0
    level_bands = {
        int(k): str(v).upper() for k, v in (raw.get("shelf_level_bands") or {}).items()
    }
    band_weights = {
        str(k).upper(): float(v)
        for k, v in (raw.get("affinity_band_weights") or {}).items()
    } or {"STRONG": 1.0, "MODERATE": 0.5}
    params = Parameters(
        zone_distance_m=float(raw.get("zone_distance_m", 40)),
        aisle_distance_m=float(raw.get("aisle_distance_m", 3)),
        walking_speed_mps=float(raw.get("walking_speed_mps", 1)),
        trip_factor=float(raw.get("trip_factor", 1)),
        affinity_weight=float(raw.get("affinity_weight", 1)),
        use_25d=str(raw.get("mode", "2.5d")).lower() in {"2.5d", "25d", "3d"},
        shelf_penalties_seconds=MappingProxyType(penalties),
        shelf_level_bands=MappingProxyType(level_bands),
        affinity_band_weights=MappingProxyType(band_weights),
        available_bin_statuses=frozenset(
            str(v).upper() for v in raw.get("available_bin_statuses", ["Available"])
        ),
        max_weight_kg_by_shelf_band=MappingProxyType(
            {
                str(k).upper(): float(v)
                for k, v in (raw.get("max_weight_kg_by_shelf_band") or {}).items()
            }
        ),
    )
    if params.zone_distance_m < 0 or params.aisle_distance_m < 0:
        raise LayoutDataError("UC3 distances must be non-negative")
    if params.walking_speed_mps <= 0 or params.trip_factor <= 0:
        raise LayoutDataError("UC3 walking_speed_mps and trip_factor must be positive")
    if penalties.get("LADDER") != 20.0:
        raise LayoutDataError(
            "US3.1 requires the LADDER shelf penalty to be exactly 20 seconds"
        )
    if params.use_25d:
        missing_penalties = sorted(set(level_bands.values()) - set(penalties))
        if missing_penalties:
            raise LayoutDataError(
                "UC3 has no configured shelf penalty for: " + ", ".join(missing_penalties)
            )
    return params


def horizontal_distance(slot: Slot, params: Parameters) -> float:
    """US3.1 walkable horizontal path, never straight-line X/Y distance."""
    return (
        slot.zone_index * params.zone_distance_m
        + (slot.aisle_number - 1) * params.aisle_distance_m
    )


def access_time(slot: Slot, params: Parameters) -> float:
    """One reusable access-time scorer for current, heuristic and future SA."""
    seconds = params.trip_factor * horizontal_distance(slot, params) / params.walking_speed_mps
    if params.use_25d:
        seconds += params.shelf_penalties_seconds.get(slot.shelf_band.upper(), 0.0)
    return seconds


def companion_travel_time(first: Slot, second: Slot, params: Parameters) -> float:
    """Walkable pair separation; shelf penalties are intentionally excluded."""
    metres = (
        abs(first.zone_index - second.zone_index) * params.zone_distance_m
        + abs(first.aisle_number - second.aisle_number) * params.aisle_distance_m
    )
    return metres / params.walking_speed_mps


def feasibility_reasons(sku: SKU, slot: Slot, params: Parameters) -> tuple[str, ...]:
    """Shared hard-constraint validator for the heuristic and later UC4/SA."""
    reasons: list[str] = []
    if slot.status.upper() not in params.available_bin_statuses:
        reasons.append("bin-unavailable")
    if sku.required_volume > slot.capacity_volume:
        reasons.append("capacity")
    if slot.length_cm is not None and sku.length_cm > slot.length_cm:
        reasons.append("length-fit")
    if slot.width_cm is not None and sku.width_cm > slot.width_cm:
        reasons.append("width-fit")
    if slot.height_cm is not None and sku.height_cm > slot.height_cm:
        reasons.append("height-fit")
    max_weight = slot.max_weight_kg
    if max_weight is None:
        max_weight = params.max_weight_kg_by_shelf_band.get(slot.shelf_band.upper())
    if max_weight is not None and sku.weight_kg > max_weight:
        reasons.append("weight-safety")
    if sku.storage_condition and slot.storage_condition:
        if sku.storage_condition.upper() != slot.storage_condition.upper():
            reasons.append("storage-condition")
    return tuple(reasons)


def feasible_bins(sku: SKU, slots: Iterable[Slot], params: Parameters) -> tuple[Slot, ...]:
    """Precompute candidates before any access or affinity score is considered."""
    return tuple(slot for slot in slots if not feasibility_reasons(sku, slot, params))


def _velocity_rank(velocityclass: str | None) -> int:
    """Return a stable priority for live velocity labels; unknown values go last."""
    normalized = " ".join(str(velocityclass or "").upper().replace("_", " ").split())
    return _VELOCITY_RANKS.get(normalized, len(_VELOCITY_RANKS))


def aggregate_inventory_lots(rows: Iterable[Mapping[str, Any]]) -> dict[tuple[str, str], float]:
    """Collapse expiry-lot inventory rows to the SKU/bin grain used by UC3."""
    totals: dict[tuple[str, str], float] = defaultdict(float)
    for row in rows:
        totals[(str(row["productid"]), str(row["binid"]))] += float(row.get("qtyonhand") or 0)
    return dict(totals)


def current_inventory_snapshot(
    rows: Iterable[Mapping[str, Any]],
) -> list[Mapping[str, Any]]:
    """Keep all lots at the newest ``lastupdated`` value for each product.

    The live inventory feed retains dated snapshots.  Selecting the latest
    product snapshot here matches the read-only Current-layout UI and avoids
    treating a product's historical bins as simultaneous assignments.
    """
    materialized = list(rows)
    latest: dict[str, str] = {}
    for row in materialized:
        productid = str(row["productid"])
        timestamp = str(row.get("lastupdated") or "")
        if productid not in latest or timestamp > latest[productid]:
            latest[productid] = timestamp
    return [
        row
        for row in materialized
        if str(row.get("lastupdated") or "") == latest[str(row["productid"])]
    ]


def _affinities_for(productid: str, affinities: Iterable[Affinity]) -> Iterable[Affinity]:
    return (pair for pair in affinities if pair.other(productid) is not None)


def candidate_cost(
    sku: SKU,
    candidate: Slot,
    assignments: Mapping[str, str],
    slots_by_id: Mapping[str, Slot],
    affinities: Iterable[Affinity],
    params: Parameters,
) -> float:
    """Deterministic local cost required by US3.1 for a candidate placement."""
    companion_cost = 0.0
    for pair in _affinities_for(sku.productid, affinities):
        companion = pair.other(sku.productid)
        companion_bin = assignments.get(companion or "")
        if companion_bin:
            companion_cost += pair.weight * companion_travel_time(
                candidate, slots_by_id[companion_bin], params
            )
    return (
        sku.pick_frequency * access_time(candidate, params)
        + params.affinity_weight * companion_cost
    )


def layout_score(
    assignments: Mapping[str, str],
    skus_by_id: Mapping[str, SKU],
    slots_by_id: Mapping[str, Slot],
    affinities: Iterable[Affinity],
    params: Parameters,
) -> float:
    """Score any complete layout using the same model, including current layout."""
    if set(assignments) != set(skus_by_id):
        raise LayoutDataError("layout score requires an assignment for every SKU")
    if len(set(assignments.values())) != len(assignments):
        raise LayoutDataError("layout score requires one SKU per bin")
    total = sum(
        sku.pick_frequency * access_time(slots_by_id[assignments[productid]], params)
        for productid, sku in skus_by_id.items()
    )
    for pair in affinities:
        total += params.affinity_weight * pair.weight * companion_travel_time(
            slots_by_id[assignments[pair.left_productid]],
            slots_by_id[assignments[pair.right_productid]],
            params,
        )
    return total


def run_heuristic(data: LoadedLayout, params: Parameters) -> HeuristicResult:
    """Build a complete no-randomness layout and return audit-ready metrics."""
    slots_by_id = {slot.binid: slot for slot in data.slots}
    skus_by_id = {sku.productid: sku for sku in data.skus}
    if len(slots_by_id) != len(data.slots) or len(skus_by_id) != len(data.skus):
        raise LayoutDataError("duplicate SKU or bin identifiers in the central layout")
    current = {sku.productid: sku.current_binid for sku in data.skus}
    if any(binid not in slots_by_id for binid in current.values()):
        raise LayoutDataError("a current assignment references a non-central or unknown bin")
    if len(set(current.values())) != len(current):
        raise LayoutDataError("current layout violates one-SKU-per-bin")
    if len(data.skus) > len(data.slots):
        raise NoFeasibleBinError("more central SKUs than usable central bins")

    candidates = {sku.productid: feasible_bins(sku, data.slots, params) for sku in data.skus}
    missing = sorted(productid for productid, bins in candidates.items() if not bins)
    if missing:
        raise NoFeasibleBinError("no feasible bin for: " + ", ".join(missing))

    assignments: dict[str, str] = {}
    used_bins: set[str] = set()
    for sku in sorted(
        data.skus,
        key=lambda item: (
            _velocity_rank(item.velocityclass),
            -item.pick_frequency,
            item.productid,
        ),
    ):
        unused = [slot for slot in candidates[sku.productid] if slot.binid not in used_bins]
        if not unused:
            raise NoFeasibleBinError(f"no unused feasible bin remains for {sku.productid}")
        chosen = min(
            unused,
            key=lambda slot: (
                candidate_cost(
                    sku, slot, assignments, slots_by_id, data.affinities, params
                ),
                slot.binid,
            ),
        )
        assignments[sku.productid] = chosen.binid
        used_bins.add(chosen.binid)

    current_score = layout_score(current, skus_by_id, slots_by_id, data.affinities, params)
    heuristic_score = layout_score(assignments, skus_by_id, slots_by_id, data.affinities, params)
    if heuristic_score > current_score:
        raise LayoutDataError(
            "heuristic score is worse than the current layout; no recommendation was emitted"
        )

    metrics: dict[str, SKUTimeMetric] = {}
    weighted_current = weighted_recommended = 0.0
    for sku in data.skus:
        before = access_time(slots_by_id[current[sku.productid]], params)
        after = access_time(slots_by_id[assignments[sku.productid]], params)
        saved = before - after
        metrics[sku.productid] = SKUTimeMetric(
            sku.productid, before, after, saved, (saved / before) if before else None
        )
        weighted_current += sku.pick_frequency * before
        weighted_recommended += sku.pick_frequency * after
    overall_saved = weighted_current - weighted_recommended
    return HeuristicResult(
        assignments,
        LayoutScores(current_score, heuristic_score),
        params,
        data.diagnostics,
        metrics,
        overall_saved,
        (overall_saved / weighted_current) if weighted_current else None,
    )


def _read_all(query, *, label: str) -> list[dict[str, Any]]:
    """Read a bounded PostgREST relation and identify a failed source clearly."""
    rows: list[dict[str, Any]] = []
    try:
        for start in range(0, 1_000_000, _PAGE_SIZE):
            page = query.range(start, start + _PAGE_SIZE - 1).execute().data or []
            rows.extend(page)
            if len(page) < _PAGE_SIZE:
                return rows
    except Exception as exc:  # noqa: BLE001
        raise LayoutDataError(f"{label} read failed: {exc}") from exc
    raise LayoutDataError("UC3 read exceeded one million rows; use a bounded server-side loader")


def _read_in_batches(query_factory, column: str, values: Iterable[str], *, label: str) -> list[dict[str, Any]]:
    """Fetch only referenced IDs; never scan a global lookup/history table."""
    ids = sorted({str(value) for value in values})
    rows: list[dict[str, Any]] = []
    for start in range(0, len(ids), _ID_BATCH_SIZE):
        rows.extend(
            _read_all(
                query_factory().in_(column, ids[start:start + _ID_BATCH_SIZE]),
                label=label,
            )
        )
    return rows


class _DatabaseReadQuery:
    """Small read-only PostgREST-shaped adapter backed by psycopg2."""

    def __init__(self, connection, table: str) -> None:
        self.connection = connection
        self.table = table
        self.columns = "*"
        self.filters: list[tuple[str, str, Any]] = []
        self.orderings: list[tuple[str, bool]] = []
        self.offset = 0
        self.maximum: int | None = None

    def select(self, columns: str):
        self.columns = columns
        return self

    def eq(self, column: str, value: Any):
        self.filters.append((column, "eq", value))
        return self

    def in_(self, column: str, values: Iterable[Any]):
        self.filters.append((column, "in", list(values)))
        return self

    def order(self, column: str, *, ascending: bool = True, desc: bool | None = None):
        """Match the ordered subset of PostgREST used by the UC3 loader."""
        if not _SQL_IDENTIFIER.fullmatch(column):
            raise LayoutDataError(f"unsafe UC3 read order: {column}")
        if desc is not None:
            ascending = not desc
        self.orderings.append((column, bool(ascending)))
        return self

    def limit(self, maximum: int):
        self.maximum = maximum
        return self

    def range(self, start: int, end: int):
        self.offset = start
        self.maximum = end - start + 1
        return self

    def execute(self):
        from psycopg2.extras import RealDictCursor

        if not _SQL_IDENTIFIER.fullmatch(self.table):
            raise LayoutDataError(f"unsafe UC3 read table: {self.table}")
        columns = [column.strip() for column in self.columns.split(",")]
        aliases = _DATABASE_SELECT_ALIASES.get(self.table, {})
        if not columns or any(
            not _SQL_IDENTIFIER.fullmatch(column) and column not in aliases
            for column in columns
        ):
            raise LayoutDataError(f"unsafe UC3 read columns: {self.columns}")
        clauses: list[str] = []
        values: list[Any] = []
        for column, operator, value in self.filters:
            if not _SQL_IDENTIFIER.fullmatch(column):
                raise LayoutDataError(f"unsafe UC3 read filter: {column}")
            if operator == "eq":
                clauses.append(f"{column} = %s")
                values.append(value)
            elif operator == "in":
                if not value:
                    return SimpleNamespace(data=[])
                clauses.append(f"{column} = ANY(%s)")
                values.append(value)
            else:  # pragma: no cover - this adapter has only the methods above.
                raise LayoutDataError(f"unsupported UC3 read operator: {operator}")
        selected_columns = [aliases.get(column, column) for column in columns]
        statement = f"SELECT {', '.join(selected_columns)} FROM public.{self.table}"
        if clauses:
            statement += " WHERE " + " AND ".join(clauses)
        if self.orderings:
            statement += " ORDER BY " + ", ".join(
                f"{column} {'ASC' if ascending else 'DESC'}"
                for column, ascending in self.orderings
            )
        if self.maximum is not None:
            statement += " LIMIT %s OFFSET %s"
            values.extend([self.maximum, self.offset])
        with self.connection.cursor(cursor_factory=RealDictCursor) as cursor:
            cursor.execute(statement, values)
            return SimpleNamespace(data=[dict(row) for row in cursor.fetchall()])


class _DatabaseReadClient:
    """Expose the subset of the Supabase query interface used by UC3 reads."""

    def __init__(self, connection) -> None:
        self.connection = connection

    def table(self, table: str) -> _DatabaseReadQuery:
        return _DatabaseReadQuery(self.connection, table)


def _central_warehouse(client) -> str:
    rows = (
        client.table("warehouse")
        .select("warehouseid")
        .eq("warehouserole", "CENTRAL")
        .order("warehouseid")
        .limit(2)
        .execute()
        .data
        or []
    )
    if len(rows) != 1:
        raise LayoutDataError(f"expected exactly one CENTRAL warehouse, found {len(rows)}")
    return str(rows[0]["warehouseid"])


def _parse_slot(
    row: Mapping[str, Any], zone_indexes: Mapping[str, int], params: Parameters
) -> Slot:
    binid = str(row["binid"])
    match = _BIN_ID.fullmatch(binid.strip())
    if not match:
        raise LayoutDataError(
            f"{binid}: bin ID must use ZONE-A##-R##-L##-F##-B## to score UC3"
        )
    groups = match.groupdict()
    # The live bin relation has no zoneid column.  Its validated structured
    # identifier starts with the zone ID, so derive the relationship without
    # requesting a nonexistent field from PostgREST.
    zoneid = groups["zone"].upper()
    if zoneid not in zone_indexes:
        raise LayoutDataError(f"{binid}: bin-ID zone is not in the CENTRAL warehouse ({zoneid})")
    level = int(groups["level"])
    try:
        band = params.shelf_level_bands[level]
    except KeyError as exc:
        raise LayoutDataError(f"{binid}: shelf level {level} has no configured UC3 band") from exc
    return Slot(
        binid,
        str(row["warehouseid"]),
        zoneid,
        zone_indexes[zoneid],
        int(groups["aisle"]),
        int(groups["rack"]),
        level,
        band,
        float(row["capacityvolume"]),
        str(row["status"]),
        max_weight_kg=(
            float(row["maxweightkg"]) if row.get("maxweightkg") is not None else None
        ),
        length_cm=float(row["lengthcm"]) if row.get("lengthcm") is not None else None,
        width_cm=float(row["widthcm"]) if row.get("widthcm") is not None else None,
        height_cm=float(row["heightcm"]) if row.get("heightcm") is not None else None,
    )


def _storage_case_measurements(storage: Mapping[str, Any], productid: str) -> tuple[float, float, float, float]:
    """Return one shipping case's dimensions (cm) and gross weight (kg).

    UC3 assigns the physical shipping case described by ``storage``.  Its
    dimensions are stored in millimetres, so packing-count fields must not be
    multiplied into the case volume a second time.
    """
    try:
        length_cm = float(storage["case_length_mm"]) / 10
        width_cm = float(storage["case_width_mm"]) / 10
        height_cm = float(storage["case_height_mm"]) / 10
        weight_kg = float(storage["case_weight_kg"])
    except (KeyError, TypeError, ValueError) as exc:
        raise LayoutDataError(f"{productid}: invalid shipping-case storage dimensions or weight") from exc
    if min(length_cm, width_cm, height_cm, weight_kg) <= 0:
        raise LayoutDataError(f"{productid}: shipping-case storage dimensions and weight must be positive")
    return length_cm, width_cm, height_cm, weight_kg


def _optional_case_cube(storage: Mapping[str, Any], productid: str) -> float | None:
    """Validate the live cube value when supplied without changing fit scoring."""
    value = storage.get("casecube_mcube")
    if value is None:
        return None
    try:
        cube = float(value)
    except (TypeError, ValueError) as exc:
        raise LayoutDataError(f"{productid}: invalid shipping-case cube") from exc
    if cube <= 0:
        raise LayoutDataError(f"{productid}: shipping-case cube must be positive")
    return cube


def _shelf_life_days(product: Mapping[str, Any], productid: str) -> int:
    """Validate the required live shelf-life field without scoring against it."""
    try:
        value = int(product["shelflife_days"])
    except (KeyError, TypeError, ValueError) as exc:
        raise LayoutDataError(f"{productid}: invalid or missing shelf-life days") from exc
    if value < 0:
        raise LayoutDataError(f"{productid}: shelf-life days cannot be negative")
    return value


def load_live_layout(client, upstream_uc1_runid: str, params: Parameters) -> LoadedLayout:
    """Load and validate all finalized-schema inputs from the one CENTRAL warehouse."""
    warehouseid = _central_warehouse(client)
    zones = _read_all(
        client.table("zone")
        .select("zoneid,warehouseid")
        .eq("warehouseid", warehouseid)
        .order("zoneid"),
        label="CENTRAL zones",
    )
    zone_ids = {str(row["zoneid"]) for row in zones}
    if not zone_ids:
        raise LayoutDataError("the CENTRAL warehouse has no zones")
    zone_indexes = {zoneid: index for index, zoneid in enumerate(sorted(zone_ids))}
    bin_rows = _read_all(
        client.table("bin")
        .select(
            "binid,capacityvolume,status,warehouseid,"
            "lengthcm,widthcm,heightcm,maxweightkg"
        )
        .eq("warehouseid", warehouseid)
        .order("binid"),
        label="CENTRAL bins",
    )
    diagnostics: list[str] = []
    slots: list[Slot] = []
    for row in bin_rows:
        try:
            slots.append(_parse_slot(row, zone_indexes, params))
        except LayoutDataError as exc:
            diagnostics.append(str(exc))
    if diagnostics:
        raise LayoutDataError("invalid central-bin hierarchy: " + "; ".join(sorted(diagnostics)))
    if not slots:
        raise LayoutDataError("the CENTRAL warehouse has no scorable bins")

    inventory = _read_all(
        client.table("inventory")
        .select("inventoryid,productid,binid,qtyonhand,lastupdated")
        .eq("warehouseid", warehouseid)
        .order("inventoryid"),
        label="CENTRAL inventory",
    )
    inventory = current_inventory_snapshot(inventory)
    product_bins: dict[str, set[str]] = defaultdict(set)
    for productid, binid in aggregate_inventory_lots(inventory):
        product_bins[productid].add(binid)
    multi_bin = sorted(productid for productid, bins in product_bins.items() if len(bins) != 1)
    if multi_bin:
        raise LayoutDataError("one-SKU-per-bin source violation for: " + ", ".join(multi_bin))
    bin_products: dict[str, set[str]] = defaultdict(set)
    for productid, bins in product_bins.items():
        bin_products[next(iter(bins))].add(productid)
    shared_bins = sorted(binid for binid, products in bin_products.items() if len(products) != 1)
    if shared_bins:
        raise LayoutDataError(
            "one-SKU-per-bin source violation in bins: " + ", ".join(shared_bins)
        )

    product_ids = sorted(product_bins)
    products = _read_in_batches(
        lambda: client.table("product")
        .select("productid,velocityclass,status,manualbasedemand,shelflife_days")
        .order("productid"),
        "productid",
        product_ids,
        label="assigned products",
    )
    storage_rows = _read_in_batches(
        lambda: client.table("storage").select(
            "productid,case_length_mm,case_width_mm,case_height_mm,case_weight_kg,casecube_mcube"
        ).order("productid"),
        "productid",
        product_ids,
        label="assigned storage records",
    )
    product_by_id = {str(row["productid"]): row for row in products}
    storage_by_id = {str(row["productid"]): row for row in storage_rows}
    demand_rows = _read_in_batches(
        lambda: client.table("demand")
        .select("demandid,productid,avgdailydemand,calculateddate")
        .eq("warehouseid", warehouseid)
        .order("calculateddate")
        .order("demandid"),
        "productid",
        product_ids,
        label="CENTRAL demand history",
    )
    demand_by_id: dict[str, Mapping[str, Any]] = {}
    for row in demand_rows:
        productid = str(row["productid"])
        if productid not in demand_by_id or (
            str(row.get("calculateddate", "")), str(row.get("demandid", ""))
        ) > (
            str(demand_by_id[productid].get("calculateddate", "")),
            str(demand_by_id[productid].get("demandid", "")),
        ):
            demand_by_id[productid] = row

    skus: list[SKU] = []
    for productid, bins in sorted(product_bins.items()):
        product = product_by_id.get(productid)
        storage = storage_by_id.get(productid)
        if not product or not storage:
            raise LayoutDataError(f"{productid}: missing product or storage record")
        if str(product.get("status", "")) != "Available":
            raise LayoutDataError(f"{productid}: product status is not Available")
        shelf_life_days = _shelf_life_days(product, productid)
        demand = demand_by_id.get(productid, {}).get("avgdailydemand")
        pick_frequency = float(
            demand if demand is not None else product.get("manualbasedemand") or 0
        )
        length_cm, width_cm, height_cm, weight_kg = _storage_case_measurements(
            storage, productid
        )
        case_cube_mcube = _optional_case_cube(storage, productid)
        skus.append(
            SKU(
                productid,
                pick_frequency,
                next(iter(bins)),
                str(product.get("velocityclass") or ""),
                str(product.get("status") or ""),
                length_cm,
                width_cm,
                height_cm,
                weight_kg,
                shelf_life_days=shelf_life_days,
                case_cube_mcube=case_cube_mcube,
            )
        )
    if not skus:
        raise LayoutDataError("the CENTRAL warehouse has no inventory assignments")

    relationship_rows = _read_all(
        client.table("productrelationship")
        .select("relationshipid,consequent_productid,strength,lift")
        .eq("warehouseid", warehouseid)
        .eq("runid", upstream_uc1_runid)
        .in_("strength", ["Strong", "Moderate"])
        .order("relationshipid"),
        label="selected UC1 relationships",
    )
    relationship_ids = {str(row["relationshipid"]) for row in relationship_rows}
    antecedent_rows = _read_in_batches(
        lambda: client.table("productrelationshipantecedent").select(
            "relationshipid,antecedent_productid"
        ).order("relationshipid").order("antecedent_productid"),
        "relationshipid",
        relationship_ids,
        label="selected UC1 relationship antecedents",
    )
    known_skus = {sku.productid for sku in skus}
    affinities: list[Affinity] = []
    seen_pairs: set[tuple[str, str]] = set()
    relationship_by_id = {str(row["relationshipid"]): row for row in relationship_rows}
    for antecedent in antecedent_rows:
        relationshipid = str(antecedent["relationshipid"])
        if relationshipid not in relationship_ids:
            continue
        relationship = relationship_by_id[relationshipid]
        left, right = (
            str(antecedent["antecedent_productid"]),
            str(relationship["consequent_productid"]),
        )
        if left == right or left not in known_skus or right not in known_skus:
            continue
        key = tuple(sorted((left, right)))
        if key in seen_pairs:
            continue
        seen_pairs.add(key)
        strength = str(relationship["strength"]).upper()
        affinities.append(
            Affinity(
                left,
                right,
                strength,
                float(relationship["lift"]),
                params.affinity_band_weights[strength],
            )
        )
    return LoadedLayout(
        warehouseid,
        tuple(skus),
        tuple(slots),
        tuple(affinities),
        tuple(diagnostics),
    )


def _priority(metric: SKUTimeMetric) -> str:
    if metric.time_saved > 60:
        return "Critical"
    if metric.time_saved > 20:
        return "High"
    if metric.time_saved > 0:
        return "Medium"
    return "Low"


def _recommendation_rows(
    data: LoadedLayout, result: HeuristicResult, runid: str
) -> list[dict[str, Any]]:
    slots = {slot.binid: slot for slot in data.slots}
    rows: list[dict[str, Any]] = []
    for sku in sorted(data.skus, key=lambda item: item.productid):
        recommended = result.assignments[sku.productid]
        if sku.current_binid == recommended:
            continue
        metric = result.per_sku_metrics[sku.productid]
        before_distance = horizontal_distance(slots[sku.current_binid], result.parameters)
        after_distance = horizontal_distance(slots[recommended], result.parameters)
        related = [pair for pair in data.affinities if pair.other(sku.productid)]
        lift = max((pair.lift for pair in related), default=None)
        rows.append(
            {
                "movefieldid": f"{runid}:{sku.productid}",
                "warehouseid": data.warehouseid,
                "productid": sku.productid,
                "velocityclass": sku.velocityclass or "Unclassified",
                "movedirection": (
                    "Toward packing"
                    if metric.time_saved >= 0
                    else "Companion consolidation"
                ),
                "reason": (
                    "Reduced access time"
                    if metric.time_saved >= 0
                    else "Companion affinity consolidation"
                ),
                "distanceimprovementm": max(0.0, before_distance - after_distance),
                "distanceimprovementpct": max(0.0, metric.improvement_pct or 0.0),
                "priority": _priority(metric),
                "avgdailydemand": sku.pick_frequency,
                "forconsolidation": bool(related),
                "lift": lift,
                "lastupdated": date.today().isoformat(),
                "currentbin": sku.current_binid,
                "recommendedbin": recommended,
                "runid": runid,
            }
        )
    return rows


def _database_connection():
    """Direct connection for bounded UC3 reads and atomic persistence."""
    load_dotenv(REPO_ROOT / ".env.local")
    try:
        import psycopg2
    except ImportError as exc:  # pragma: no cover
        raise RuntimeError("psycopg2 is required for atomic UC3 persistence") from exc
    required = ("SUPABASE_DB_HOST", "SUPABASE_DB_USER", "SUPABASE_DB_PASSWORD")
    missing = [name for name in required if not os.getenv(name)]
    if missing:
        raise RuntimeError("Missing " + ", ".join(missing) + " for atomic UC3 persistence")
    return psycopg2.connect(
        host=os.environ["SUPABASE_DB_HOST"],
        port=os.getenv("SUPABASE_DB_PORT", "6543"),
        dbname=os.getenv("SUPABASE_DB_NAME", "postgres"),
        user=os.environ["SUPABASE_DB_USER"],
        password=os.environ["SUPABASE_DB_PASSWORD"],
        sslmode="require",
    )


def _database_read_connection():
    """Open one read-only repeatable snapshot for all UC3 source queries."""
    connection = _database_connection()
    try:
        connection.set_session(isolation_level="REPEATABLE READ", readonly=True, autocommit=False)
        with connection.cursor() as cursor:
            # Transaction-local settings survive the read sequence but are
            # discarded on close; neither schema nor data is changed.
            cursor.execute("SET LOCAL statement_timeout TO 0")
        return connection
    except Exception:
        connection.close()
        raise


def persist_successful_layout(
    data: LoadedLayout, result: HeuristicResult, upstream_uc1_runid: str
) -> str:
    """Atomically create lineage and only genuinely changed recommendation rows."""
    runid = str(uuid.uuid4())
    rows = _recommendation_rows(data, result, runid)
    signature = (
        f"uc3-heuristic|upstream={upstream_uc1_runid}|skus={len(data.skus)}|"
        f"moves={len(rows)}|zone_m={result.parameters.zone_distance_m}|"
        f"aisle_m={result.parameters.aisle_distance_m}|"
        f"speed={result.parameters.walking_speed_mps}|"
        f"trip={result.parameters.trip_factor}|25d={result.parameters.use_25d}"
    )
    conn = _database_connection()
    try:
        with conn:
            with conn.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO modelrun "
                    "(runid, runtype, generatedate, algorithmversion, parametersignature) "
                    "VALUES (%s, %s, %s, %s, %s)",
                    (
                        runid,
                        "UC3",
                        datetime.now(timezone.utc),
                        ALGORITHM_VERSION,
                        signature,
                    ),
                )
                if rows:
                    columns = tuple(rows[0])
                    placeholders = ", ".join(["%s"] * len(columns))
                    cursor.executemany(
                        "INSERT INTO layoutrecommendation "
                        f"({', '.join(columns)}) VALUES ({placeholders})",
                        [tuple(row[column] for column in columns) for row in rows],
                    )
    finally:
        conn.close()
    return runid


def run(*, upstream_uc1_runid: str | None = None) -> StageResult:
    """Live UC3 entry point used by the batch orchestrator."""
    if not upstream_uc1_runid:
        return StageResult(
            "UC3",
            "",
            "failed",
            error="UC3 needs upstream_uc1_runid from a successful UC1 affinity run.",
        )
    try:
        params = parameters_from_config(load_shared_config())
        # PostgREST applies a short statement timeout to the engine's large
        # read set. UC1 already uses this credentialed direct connection; use
        # it for UC3 reads as well, with no mutation before persistence.
        read_connection = _database_read_connection()
        try:
            data = load_live_layout(
                _DatabaseReadClient(read_connection), upstream_uc1_runid, params
            )
        finally:
            read_connection.close()
        result = run_heuristic(data, params)
        runid = persist_successful_layout(data, result, upstream_uc1_runid)
        moves = sum(
            sku.current_binid != result.assignments[sku.productid] for sku in data.skus
        )
        return StageResult("UC3", runid, "success", len(data.skus), moves)
    except Exception as exc:  # noqa: BLE001
        return StageResult("UC3", "", "failed", error=str(exc))


if __name__ == "__main__":
    import sys

    result = run(upstream_uc1_runid=sys.argv[1] if len(sys.argv) > 1 else None)
    print(
        f"{result.name}: {result.status} runid={result.runid} "
        f"in={result.input_rows} out={result.output_rows}"
    )
    if result.error:
        print(f"  error: {result.error}")
    raise SystemExit(0 if result.ok else 1)
