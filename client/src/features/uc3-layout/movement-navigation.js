export const AISLES_PER_PAGE = 3;

export const DEFAULT_MAP_FILTERS = Object.freeze({
  search: "",
  occupancy: "all",
  inventoryStatus: "all",
  face: "all",
  shelfLevel: "all",
});

function numericSort(a, b) {
  const difference = Number(a) - Number(b);
  return Number.isFinite(difference) && difference !== 0
    ? difference
    : String(a).localeCompare(String(b), undefined, { numeric: true });
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

/** Human-readable labels for the persisted rack-location components. */
export function formatStorageLocation(bin) {
  if (!bin || bin.mappingStatus !== "mapped") return "Location needs review";
  return `Aisle A${twoDigits(bin.aisleNumber)} · Rack R${twoDigits(bin.rackNumber)} · Shelf ${bin.shelfLevel} · Rack face F${twoDigits(bin.faceNumber)} · Bin ${bin.binPosition}`;
}

export function movementStateCopy(state) {
  switch (state) {
    case "in":
      return { legend: "Products moving in", badge: "MOVE IN", aria: "products moving in" };
    case "out":
      return { legend: "Products moving out", badge: "MOVE OUT", aria: "products moving out" };
    case "both":
      return { legend: "Products moving in and out", badge: "IN & OUT", aria: "products moving in and out" };
    default:
      return { legend: "", badge: "", aria: "" };
  }
}

export function matchesCurrentMapFilters(bin, filters = {}) {
  const search = String(filters.search || "").trim().toLowerCase();
  if (search) {
    const inventoryText = bin.inventory.map((lot) => `${lot.sku} ${lot.productName}`).join(" ");
    if (!`${bin.binId} ${inventoryText}`.toLowerCase().includes(search)) return false;
  }
  if (filters.occupancy && filters.occupancy !== "all" && bin.occupancy !== filters.occupancy) return false;
  if (filters.inventoryStatus && filters.inventoryStatus !== "all" && !bin.inventory.some((lot) => lot.inventoryStatus === filters.inventoryStatus)) return false;
  if (filters.face && filters.face !== "all" && String(bin.faceNumber) !== String(filters.face)) return false;
  if (filters.shelfLevel && filters.shelfLevel !== "all" && bin.shelfLevel !== filters.shelfLevel) return false;
  return true;
}

/** Movement direction is presentation state derived from the validated projection. */
export function classifyBinMovement(bin) {
  const movement = bin?.moveEvents || [];
  const movedIn = movement.some((event) => event.direction === "in");
  const movedOut = movement.some((event) => event.direction === "out");
  if (movedIn && movedOut) return "both";
  if (movedIn) return "in";
  if (movedOut) return "out";
  return "none";
}

export function movementEventCopy(direction) {
  return direction === "in" ? "Product moved into this bin" : "Product moved out of this bin";
}

/** Resolve a move's other bin to a readable storage location when possible. */
export function counterpartLocationForMoveEvent({ direction, move, bins } = {}) {
  const binId = direction === "in" ? move?.currentbin : direction === "out" ? move?.recommendedbin : null;
  if (!binId) return "Location unavailable";
  const bin = (bins || []).find((candidate) => candidate.binId === binId);
  return bin ? formatStorageLocation(bin) : binId;
}

/** Prefer the product name held in the live snapshot, with a safe SKU fallback. */
export function productDisplayForMove(move, bins = []) {
  const productId = move?.productid || "Product";
  const lot = bins
    .flatMap((bin) => bin.inventory || [])
    .find((candidate) => candidate.productId === productId);
  return {
    productId,
    productName: lot?.productName && lot.productName !== productId ? lot.productName : "",
  };
}

/**
 * Older runs have only a textual reason. Parse the engine's saved daily
 * benefit when present so a cycle participant is not presented as a saving.
 */
export function moveImpactPresentation(move = {}) {
  const saved = /Saves\s+(-?[\d.]+)\s+s\/day/i.exec(String(move.reason || ""));
  if (saved && Number(saved[1]) <= 0) {
    return { kind: "coordinated", text: "Part of a coordinated product exchange" };
  }
  return {
    kind: "benefit",
    text: `Move priority: ${move.priority || "Medium"} · Estimated walking-distance improvement: ${Number(move.distanceimprovementm || 0).toFixed(1)} m (${Math.round(Number(move.distanceimprovementpct || 0) * 100)}%)`,
  };
}

/** Return the other end of one persisted move for the bin-popover action. */
export function counterpartForMoveEvent({ direction, move } = {}) {
  if (!move || !direction) return null;
  const binId = direction === "in" ? move.currentbin : direction === "out" ? move.recommendedbin : null;
  if (!binId) return null;
  return {
    binId,
    label: direction === "in" ? "View original bin" : "View recommended bin",
  };
}

/** Resolve a counterpart jump without requiring the caller to know rack pagination. */
export function resolveBinJump(bins, targetBinId, filters = {}) {
  const target = (bins || []).find((bin) => bin.binId === targetBinId);
  if (!target) return null;
  const mappedZoneBins = (bins || []).filter(
    (bin) => bin.zoneId === target.zoneId && bin.mappingStatus === "mapped"
  );
  const aisles = [...new Set(mappedZoneBins.map((bin) => bin.aisleNumber))].sort(numericSort);
  const aisleIndex = aisles.indexOf(target.aisleNumber);
  const targetMatchesFilters = matchesCurrentMapFilters(target, filters);
  return {
    selectedBinId: target.binId,
    selectedZoneId: target.zoneId,
    aislePage: aisleIndex < 0 ? 0 : Math.floor(aisleIndex / AISLES_PER_PAGE),
    filters: targetMatchesFilters ? { ...filters } : { ...DEFAULT_MAP_FILTERS },
    resetFilters: !targetMatchesFilters,
  };
}
