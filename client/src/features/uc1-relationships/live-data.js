import { fetchRelationshipOutputs, fetchWarehouses } from "@shared/data/engine-outputs.js";
import { WAREHOUSE } from "@shared/data/tables.js";

let warehouseRequest;
const relationshipRequests = new Map();

function loadWarehouses() {
  warehouseRequest ??= fetchWarehouses();
  return warehouseRequest;
}

function loadRelationships(warehouseIds) {
  const ids = [...new Set(warehouseIds.filter(Boolean))].sort();
  const key = ids.join(",");
  if (!relationshipRequests.has(key)) {
    relationshipRequests.set(
      key,
      fetchRelationshipOutputs({ warehouseIds: ids.length ? ids : [WAREHOUSE.central] }),
    );
  }
  return relationshipRequests.get(key);
}

/** Share in-flight and completed UC1 reads between startup prefetch and the page. */
export function loadUc1Data(warehouseIds = [WAREHOUSE.central]) {
  return Promise.all([loadWarehouses(), loadRelationships(warehouseIds)]).then(
    ([warehouseResult, relationshipResult]) => ({
      warehouseResult,
      relationshipResult,
    }),
  );
}

export function prefetchUc1() {
  return loadUc1Data();
}
