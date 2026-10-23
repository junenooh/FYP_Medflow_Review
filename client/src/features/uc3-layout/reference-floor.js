/**
 * Physical WH001 floor used when bin/zone rows are not yet readable.
 * This is warehouse geometry from the architecture doc — not an optimiser result.
 */
export const ZONE_LETTERS = ["A", "B", "C", "D", "E"];

export const ZONE_COLORS = {
  A: "#cfeadb",
  B: "#e2f0d6",
  C: "#faefcf",
  D: "#f9dec4",
  E: "#f6cbc9",
};

export const ZONE_METRES = 40;

export function zoneIndexFromName(zonename = "") {
  const match = String(zonename).match(/\b([A-E])\b/i);
  if (match) return match[1].toUpperCase().charCodeAt(0) - 65;
  const fromType = { FAST: 0, PICK: 0, MEDIUM: 1, SLOW: 2, BULK: 4 };
  return fromType[String(zonename).toUpperCase()] ?? 0;
}

export function accessMetres(zoneIdx, aisle = 1) {
  return zoneIdx * ZONE_METRES + (Math.max(1, aisle) - 1) * 3;
}

function makeBin(i) {
  const zoneIdx = i % 5;
  const aisle = (Math.floor(i / 5) % 2) + 1;
  const bay = Math.floor(i / 10);
  const letter = ZONE_LETTERS[zoneIdx];
  return {
    binid: `BIN${String(i + 1).padStart(3, "0")}`,
    zoneid: `Z00${zoneIdx + 1}`,
    zonename: `Zone ${letter}`,
    zoneLetter: letter,
    zoneIdx,
    aisle,
    // Mock-only rack position for the Task 1 map. Live data can provide a
    // physical rack number later without changing the renderer contract.
    rackNumber: (Math.floor(i / 10) % 3) + 1,
    bay,
    status: "Available",
    position_x: accessMetres(zoneIdx, aisle),
    position_y: bay * 2.4 + aisle,
    warehouseid: "WH001",
    capacityvolume: 1.2,
  };
}

export const REFERENCE_ZONES = ZONE_LETTERS.map((letter, index) => ({
  zoneid: `Z00${index + 1}`,
  warehouseid: "WH001",
  zonename: `Zone ${letter}`,
  zonetype: ["FAST", "MEDIUM", "MEDIUM", "SLOW", "BULK"][index],
  letter,
  index,
}));

export const REFERENCE_BINS = Array.from({ length: 22 }, (_, i) => makeBin(i));

export const REFERENCE_PRODUCTS = Array.from({ length: 12 }, (_, i) => ({
  productid: `MED${String(i + 1).padStart(3, "0")}`,
  productname: `Medical SKU ${String(i + 1).padStart(3, "0")}`,
  velocityclass: ["A", "A", "B", "B", "B", "C", "C", "C", "C", "C", "C", "C"][i],
}));

/**
 * Representative changed assignments used only when the UC3 engine has not
 * produced a readable run yet. Keeping this beside the reference floor makes
 * the fallback a coherent analytical scenario rather than a set of UI-only
 * placeholders.
 */
export const REFERENCE_MOVES = [
  {
    id: "DEMO-001",
    productid: "MED001",
    productname: "Medical SKU 001",
    velocityclass: "A",
    currentbin: "BIN015",
    recommendedbin: "BIN001",
    priority: "Critical",
    avgdailydemand: 84,
    reason: "High velocity SKU moved to a faster-access slot",
    affinity: "Strong",
  },
  {
    id: "DEMO-002",
    productid: "MED002",
    productname: "Medical SKU 002",
    velocityclass: "A",
    currentbin: "BIN014",
    recommendedbin: "BIN006",
    priority: "High",
    avgdailydemand: 66,
    reason: "High velocity and Strong companion affinity with MED001",
    affinity: "Strong",
  },
  {
    id: "DEMO-003",
    productid: "MED003",
    productname: "Medical SKU 003",
    velocityclass: "B",
    currentbin: "BIN013",
    recommendedbin: "BIN002",
    priority: "High",
    avgdailydemand: 43,
    reason: "Moderate companion group consolidated near the packing area",
    affinity: "Moderate",
  },
  {
    id: "DEMO-004",
    productid: "MED004",
    productname: "Medical SKU 004",
    velocityclass: "B",
    currentbin: "BIN012",
    recommendedbin: "BIN007",
    priority: "Medium",
    avgdailydemand: 35,
    reason: "Faster compatible slot available after velocity ranking",
    affinity: "Moderate",
  },
  {
    id: "DEMO-005",
    productid: "MED005",
    productname: "Medical SKU 005",
    velocityclass: "B",
    currentbin: "BIN011",
    recommendedbin: "BIN003",
    priority: "Medium",
    avgdailydemand: 29,
    reason: "Reduced travel while preserving capacity and storage fit",
    affinity: "—",
  },
].map((move) => ({
  ...move,
  movedirection: "Toward packing",
  distanceimprovementm: 40,
  distanceimprovementpct: 0.28,
  improvementLabel: "28%",
  illustrative: true,
}));

export function decorateBins(bins = [], zones = []) {
  const zoneById = Object.fromEntries((zones.length ? zones : REFERENCE_ZONES).map((z) => [z.zoneid, z]));
  const source = bins.length ? bins : REFERENCE_BINS;
  const slotInZone = {};
  return source.map((bin, i) => {
    const zone = zoneById[bin.zoneid] || REFERENCE_ZONES[i % 5];
    const letter = zone.letter || ZONE_LETTERS[zoneIndexFromName(zone.zonename || zone.zonetype)] || "A";
    const zoneIdx = ZONE_LETTERS.indexOf(letter);
    const aisle = Number.isFinite(bin.position_y) ? (Math.round(bin.position_y) % 2) + 1 : (i % 2) + 1;
    const slot = (slotInZone[letter] = (slotInZone[letter] || 0) + 1);
    return {
      ...bin,
      zonename: zone.zonename || `Zone ${letter}`,
      zonetype: zone.zonetype,
      zoneLetter: letter,
      zoneIdx: zoneIdx < 0 ? 0 : zoneIdx,
      aisle,
      rackNumber: Number(bin.rackNumber) || 1,
      shelfLevel: ["LOW", "MID", "HIGH"][(slot - 1) % 3],
      accessRequirement: slot % 6 === 0 ? "LADDER" : "STANDARD",
      x: Number.isFinite(bin.position_x) ? bin.position_x : accessMetres(zoneIdx, aisle),
      z: Number.isFinite(bin.position_y) ? bin.position_y : (slot - 1) * 2.6,
    };
  });
}

export function occupancyFor(bins, inventory = [], products = [], moves = []) {
  const productById = Object.fromEntries(
    (products.length ? products : REFERENCE_PRODUCTS).map((p) => [p.productid, p]),
  );
  const byBin = {};
  if (!inventory.length) {
    moves.forEach((move) => {
      const product = productById[move.productid] || move;
      byBin[move.currentbin] = {
        productid: product.productid,
        productname: product.productname,
        velocityclass: product.velocityclass,
        illustrative: true,
      };
    });
    const movedIds = new Set(moves.map((move) => move.productid));
    const freeBins = bins.filter((bin) => !byBin[bin.binid]);
    REFERENCE_PRODUCTS.filter((product) => !movedIds.has(product.productid)).forEach((product, i) => {
      const bin = freeBins[i + 8] || freeBins[i];
      if (!bin) return;
      byBin[bin.binid] = {
        productid: product.productid,
        productname: product.productname,
        velocityclass: product.velocityclass,
        illustrative: true,
      };
    });
  }
  inventory.forEach((row) => {
    if (!row.binid) return;
    byBin[row.binid] = {
      productid: row.productid,
      productname: productById[row.productid]?.productname || row.productid,
      qtyonhand: row.qtyonhand,
      velocityclass: productById[row.productid]?.velocityclass,
    };
  });
  moves.forEach((move) => {
    if (move.currentbin && !byBin[move.currentbin]) {
      byBin[move.currentbin] = {
        productid: move.productid,
        productname: move.productname,
        velocityclass: move.velocityclass,
      };
    }
  });
  return bins.map((bin) => ({
    ...bin,
    sku: byBin[bin.binid] || null,
    move: moves.find((m) => m.currentbin === bin.binid || m.recommendedbin === bin.binid) || null,
  }));
}
