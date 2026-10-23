export const MAX_TWIN_AISLES = 128;

function zoneNumber(id) {
  const match = String(id || "").match(/(\d+)$/);
  return match ? Number(match[1]) : null;
}

export function formatTwinZoneLabel(id) {
  const match = String(id || "").match(/(\d+)$/);
  return match ? `Zone ${match[1].padStart(3, "0")}` : `Zone ${id}`;
}

function zoneTypeRank(type) {
  const value = String(type || "").trim().toUpperCase();
  if (value.includes("HIGH") || value === "FAST" || value === "PICK") return 0;
  if (value.includes("MEDIUM")) return 1;
  if (value.includes("LOW") || value.includes("SLOW")) return 2;
  if (value.includes("BULK")) return 3;
  return 4;
}

export function orderTwinZones(zones = []) {
  return zones
    .slice()
    .sort((a, b) => {
      const aNumber = zoneNumber(a.id);
      const bNumber = zoneNumber(b.id);
      if (aNumber !== null && bNumber !== null && aNumber !== bNumber) return aNumber - bNumber;
      return zoneTypeRank(a.type) - zoneTypeRank(b.type)
        || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    })
    .map((zone) => zone.id);
}

export function allocateZoneBands(zones, bayCount) {
  const count = zones.length;
  return zones.map((zone, index) => ({
    zone,
    start: Math.min(bayCount - 1, Math.floor((index * bayCount) / count)),
    end: Math.max(
      Math.min(bayCount - 1, Math.floor((index * bayCount) / count)),
      Math.min(bayCount - 1, Math.floor(((index + 1) * bayCount) / count) - 1),
    ),
  }));
}

export function allocateZoneAisles(zones, aisleSourcesByZone) {
  let nextAisle = 1;
  const aisleMaps = new Map();
  const aisleCodes = [];
  for (const zone of zones) {
    const sources = [...new Set(aisleSourcesByZone.get(zone) || [])].sort((a, b) => a - b);
    const aisleMap = new Map();
    for (const source of sources) {
      aisleMap.set(source, nextAisle++);
      aisleCodes.push(`A${String(source).padStart(2, "0")}`);
    }
    aisleMaps.set(zone, aisleMap);
  }
  return { aisleMaps, aisleCodes, count: nextAisle - 1 };
}

export function usesZoneBand(zone, layout) {
  return layout.groupBinsByZone === true && layout.zoneOrder.includes(zone);
}
