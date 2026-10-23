import { parseStructuredBinId } from "./bin-hierarchy.js";

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/**
 * Inventory is a ledger: every row is the balance of one product in one bin at a point in time,
 * and a product may hold several bins. A bin's current content is the NEWEST row for that
 * product x bin (ties by inventoryid). Older rows are history, not stock.
 */
export function selectCurrentInventorySnapshot(rows) {
  const latest = new Map();
  for (const row of rows) {
    const key = `${row.productid}\u0000${row.binid || ""}`;
    const current = latest.get(key);
    const newer = !current
      || String(row.lastupdated || "") > String(current.lastupdated || "")
      || (String(row.lastupdated || "") === String(current.lastupdated || "") && String(row.inventoryid) > String(current.inventoryid));
    if (newer) latest.set(key, row);
  }
  return [...latest.values()];
}

/** Convert the complete live inventory lot set into immutable map-view data. */
export function mapCurrentLayout({ warehouse, zones, bins, inventory, products }) {
  const zoneById = new Map(zones.map((zone) => [zone.zoneid, zone]));
  const productById = new Map(products.map((product) => [product.productid, product]));
  const inventoryByBinId = new Map(bins.map((bin) => [bin.binid, []]));
  const unmappedInventory = [];

  for (const row of selectCurrentInventorySnapshot(inventory)) {
    const lots = inventoryByBinId.get(row.binid);
    if (!lots) {
      unmappedInventory.push(row);
      continue;
    }
    const product = productById.get(row.productid);
    lots.push({
      productId: row.productid,
      sku: row.productid,
      productName: product?.productname || row.productid,
      velocityClass: product?.velocityclass || null,
      quantityOnHand: numberOrNull(row.qtyonhand) ?? 0,
      expiryDate: row.expirydate ?? null,
      inventoryStatus: row.inventorystatus || "Unknown",
    });
  }

  const currentBins = bins.map((bin) => {
    const zoneId = String(bin.binid || "").split("-", 1)[0] || null;
    const zone = zoneById.get(zoneId);
    const hierarchy = parseStructuredBinId(bin.binid, zoneId);
    const lots = inventoryByBinId.get(bin.binid) || [];
    const totalQuantityOnHand = lots.reduce((total, lot) => total + lot.quantityOnHand, 0);
    const productIds = [...new Set(lots.map((lot) => lot.productId))];
    const velocityClasses = [...new Set(lots.map((lot) => lot.velocityClass).filter(Boolean))];
    const expectedZoneId = velocityClasses.length === 1
      ? ({ A: "Z001", B: "Z002", C: "Z003" }[velocityClasses[0]] || null)
      : null;
    return {
      warehouseId: warehouse.warehouseid,
      zoneId,
      zoneLabel: zone?.zonename || zoneId || "Unassigned zone",
      binId: bin.binid,
      binLabel: bin.binid,
      capacityVolume: numberOrNull(bin.capacityvolume),
      binStatus: bin.status || "Unknown",
      positionX: numberOrNull(bin.position_x),
      positionY: numberOrNull(bin.position_y),
      ...hierarchy,
      positionZ: numberOrNull(bin.position_z) ?? hierarchy.positionZ,
      inventory: lots,
      totalQuantityOnHand,
      occupancy: totalQuantityOnHand > 0 ? "occupied" : "empty",
      productCount: productIds.length,
      velocityClass: velocityClasses.length === 1 ? velocityClasses[0] : null,
      expectedZoneId,
      velocityPlacement: !lots.length
        ? "not-applicable"
        : productIds.length !== 1 || velocityClasses.length !== 1 || !expectedZoneId
          ? "inconclusive"
          : expectedZoneId === zoneId ? "matched" : "mismatch",
    };
  });

  return {
    warehouse: { id: warehouse.warehouseid, label: warehouse.warehousename || warehouse.warehouseid },
    zones: zones.map((zone) => ({
      id: zone.zoneid,
      label: zone.zonename || zone.zoneid,
      type: zone.zonetype || "",
    })),
    bins: currentBins,
    missingCoordinates: currentBins.filter((bin) => bin.positionX === null || bin.positionY === null),
    missingZones: currentBins.filter((bin) => !bin.zoneId || !zoneById.has(bin.zoneId)),
    unmappedBins: currentBins.filter((bin) => bin.mappingStatus !== "mapped"),
    unmappedInventory,
    velocityMismatches: currentBins.filter((bin) => bin.velocityPlacement === "mismatch"),
  };
}
