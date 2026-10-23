/** Pure, fail-closed projection of UC3 moves onto a current-layout snapshot. */
function invalid(message) {
  return { ok: true, state: "invalid", kind: null, message, run: null, moves: [], layout: null };
}

export function selectLatestUc3Run(rows) {
  return [...(rows || [])]
    .filter((row) => row?.runtype === "UC3" && row?.runid)
    .sort((left, right) => String(right.generatedate || "").localeCompare(String(left.generatedate || "")) || String(right.runid).localeCompare(String(left.runid)))[0] || null;
}

function refreshBin(bin) {
  const inventory = bin.inventory || [];
  const productIds = [...new Set(inventory.map((lot) => lot.productId))];
  const velocityClasses = [...new Set(inventory.map((lot) => lot.velocityClass).filter(Boolean))];
  const velocityClass = velocityClasses.length === 1 ? velocityClasses[0] : null;
  // documented baseline: Super High -> Z001, High -> Z002, Medium and Low -> Z003 (A/B/C for the sample)
  const expectedZoneId = velocityClass
    ? ({ "Super High": "Z001", High: "Z002", Medium: "Z003", Low: "Z003", A: "Z001", B: "Z002", C: "Z003" }[velocityClass] || null)
    : null;
  const totalQuantityOnHand = inventory.reduce((total, lot) => total + (Number(lot.quantityOnHand) || 0), 0);
  // A persisted UC3 snapshot has a SKU-to-bin assignment even when its
  // on-hand quantity is unavailable.  Occupancy is therefore an assignment
  // property, not a positive-quantity property.
  return { ...bin, inventory, totalQuantityOnHand, occupancy: inventory.length ? "occupied" : "empty", productCount: productIds.length, velocityClass, expectedZoneId, velocityPlacement: !inventory.length ? "not-applicable" : productIds.length !== 1 || !velocityClass || !expectedZoneId ? "inconclusive" : expectedZoneId === bin.zoneId ? "matched" : "mismatch" };
}

/** Apply all removals before placements, allowing swaps and longer cycles. */
export function projectRecommendedLayout(currentLayout, moves) {
  if (!currentLayout?.warehouse?.id || !Array.isArray(currentLayout.bins)) return invalid("The current layout is unavailable for projection.");
  const warehouseId = currentLayout.warehouse.id;
  const bins = currentLayout.bins.map((bin) => ({ ...bin, inventory: (bin.inventory || []).map((lot) => ({ ...lot })), moveEvents: [] }));
  const binById = new Map(bins.map((bin) => [bin.binId, bin]));
  // A product may occupy several bins (one product per bin); a run moves it bin by bin.
  const binsByProduct = new Map();
  for (const bin of bins) {
    if (bin.warehouseId !== warehouseId) return invalid(`Bin ${bin.binId} is outside the CENTRAL warehouse.`);
    const here = new Set(bin.inventory.map((lot) => lot.productId));
    if (here.size > 1) return invalid(`Bin ${bin.binId} currently holds more than one product.`);
    for (const lot of bin.inventory) {
      if (!lot.productId) return invalid(`Bin ${bin.binId} has inventory without a product reference.`);
      if (!binsByProduct.has(lot.productId)) binsByProduct.set(lot.productId, new Set());
      binsByProduct.get(lot.productId).add(bin.binId);
    }
  }
  const products = new Set();
  const sources = new Set();
  const destinations = new Set();
  for (const move of moves) {
    const current = binById.get(move.currentbin);
    const target = binById.get(move.recommendedbin);
    if (!move.productid || !current || !target) return invalid("A recommendation references a product or bin that is not in the current layout.");
    if (current.warehouseId !== warehouseId || target.warehouseId !== warehouseId) return invalid(`Recommendation ${move.productid} references a non-central bin.`);
    if (move.currentbin === move.recommendedbin) return invalid(`Recommendation ${move.productid} has the same current and recommended bin.`);
    if (sources.has(move.currentbin)) return invalid(`The selected run moves ${move.currentbin} more than once.`);
    if (destinations.has(move.recommendedbin)) return invalid(`The selected run assigns more than one product to ${move.recommendedbin}.`);
    if (!binsByProduct.get(move.productid)?.has(move.currentbin)) return invalid(`Recommendation ${move.productid} no longer matches its current bin ${move.currentbin}.`);
    products.add(move.productid); sources.add(move.currentbin); destinations.add(move.recommendedbin);
  }
  for (const destination of destinations) {
    if (binById.get(destination).inventory.some((lot) => !products.has(lot.productId))) return invalid(`Recommendation destination ${destination} is occupied by an unmoved product.`);
  }
  const removed = new Map();                       // keyed by the source bin: each bin's lots travel together
  for (const move of moves) {
    const source = binById.get(move.currentbin);
    const movingLots = source.inventory.filter((lot) => lot.productId === move.productid);
    if (!movingLots.length) return invalid(`Recommendation ${move.productid} has no movable inventory in ${move.currentbin}.`);
    removed.set(move.currentbin, movingLots);
    source.inventory = source.inventory.filter((lot) => lot.productId !== move.productid);
    source.moveEvents.push({ direction: "out", move });
  }
  for (const move of moves) {
    const destination = binById.get(move.recommendedbin);
    if (destination.inventory.length) return invalid(`Recommendation destination ${move.recommendedbin} remains occupied after move removal.`);
    destination.inventory = removed.get(move.currentbin).map((lot) => ({ ...lot }));
    destination.moveEvents.push({ direction: "in", move });
  }
  for (const bin of bins) if (new Set(bin.inventory.map((lot) => lot.productId)).size > 1) return invalid(`Projection would place multiple products in ${bin.binId}.`);
  const refreshedBins = bins.map(refreshBin);
  return { ok: true, state: "ready", kind: null, message: null, run: null, moves, layout: { ...currentLayout, bins: refreshedBins, missingCoordinates: currentLayout.missingCoordinates || [], missingZones: currentLayout.missingZones || [], unmappedBins: currentLayout.unmappedBins || [], unmappedInventory: currentLayout.unmappedInventory || [], velocityMismatches: refreshedBins.filter((bin) => bin.velocityPlacement === "mismatch") } };
}
