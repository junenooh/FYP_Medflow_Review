import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBins } from "../../client/src/features/uc4-digital-twin/twin.js";
import { allocateZoneAisles, allocateZoneBands, formatTwinZoneLabel, MAX_TWIN_AISLES, orderTwinZones, usesZoneBand } from "../../client/src/features/uc4-digital-twin/zone-order.js";

test("keeps numeric zone IDs in order even when zone types rank differently", () => {
  const zones = [
    { id: "Z003", type: "FAST" },
    { id: "Z002", type: "SLOW" },
    { id: "Z010", type: "PICK" },
    { id: "Z001", type: "BULK" },
  ];

  assert.deepEqual(orderTwinZones(zones), ["Z001", "Z002", "Z003", "Z010"]);
  assert.deepEqual(zones.map((zone) => zone.id), ["Z003", "Z002", "Z010", "Z001"]);
});

test("formats zone labels in the same zero-padded sequence as the floor layout", () => {
  assert.deepEqual(
    orderTwinZones([{ id: "Z003" }, { id: "Z001" }, { id: "Z002" }]).map(formatTwinZoneLabel),
    ["Zone 001", "Zone 002", "Zone 003"],
  );
});

test("allocates UC4's Z002 band before Z003 and keeps their bin placements in those bands", () => {
  const zoneOrder = orderTwinZones([
    { id: "Z003", type: "FAST" },
    { id: "Z002", type: "SLOW" },
  ]);
  const bands = allocateZoneBands(zoneOrder, 40);

  assert.deepEqual(zoneOrder, ["Z002", "Z003"]);
  assert.ok(bands[0].end < bands[1].start);
  assert.equal(usesZoneBand("Z002", { groupBinsByZone: true, zoneOrder }), true);
  assert.equal(usesZoneBand("Z003", { groupBinsByZone: true, zoneOrder }), true);
  assert.equal(usesZoneBand("Z002", { groupBinsByZone: false, zoneOrder }), false);
});

test("allocates contiguous aisle groups in zone order from left to right", () => {
  const sources = new Map([
    ["Z003", new Set([1, 2])],
    ["Z001", new Set([1, 2])],
    ["Z002", new Set([1, 2, 3])],
  ]);
  const { aisleMaps, aisleCodes, count } = allocateZoneAisles(["Z001", "Z002", "Z003"], sources);

  assert.equal(count, 7);
  assert.deepEqual([...aisleMaps.get("Z001").values()], [1, 2]);
  assert.deepEqual([...aisleMaps.get("Z002").values()], [3, 4, 5]);
  assert.deepEqual([...aisleMaps.get("Z003").values()], [6, 7]);
  assert.deepEqual(aisleCodes, ["A01", "A02", "A01", "A02", "A03", "A01", "A02"]);
});

test("keeps every zone in its left-to-right group when combined aisles exceed the old limit", () => {
  const sources = new Map(["Z001", "Z002", "Z003"].map((zone) => [
    zone,
    new Set(Array.from({ length: 24 }, (_, index) => index + 1)),
  ]));
  const { aisleMaps, count } = allocateZoneAisles(["Z001", "Z002", "Z003"], sources);

  assert.equal(count, 72);
  assert.ok(count <= MAX_TWIN_AISLES);
  assert.deepEqual([...aisleMaps.get("Z001").values()], Array.from({ length: 24 }, (_, index) => index + 1));
  assert.deepEqual([...aisleMaps.get("Z002").values()], Array.from({ length: 24 }, (_, index) => index + 25));
  assert.deepEqual([...aisleMaps.get("Z003").values()], Array.from({ length: 24 }, (_, index) => index + 49));
});

test("normalizes live occupancy, stock, and UC3 rack-location details", () => {
  const [bin] = normalizeBins([{
    binid: "Z001-A01-R02-L03-F01-B04",
    zone: "Z001",
    aisle: 1,
    rackNumber: 2,
    shelfLevel: "L03",
    faceNumber: 1,
    binPosition: "B04",
    occupancy: "occupied",
    totalQuantityOnHand: 12,
    inventory: [{
      sku: "MED0019",
      productId: "MED0019",
      productName: "Product 19",
      quantityOnHand: 12,
    }],
  }]);

  assert.equal(bin.occupancy, "occupied");
  assert.equal(bin.totalQuantityOnHand, 12);
  assert.equal(bin.rackNumber, 2);
  assert.equal(bin.shelfLevel, "L03");
  assert.equal(bin.faceNumber, 1);
  assert.equal(bin.binPosition, "B04");
  assert.equal(bin.inventory[0].sku, "MED0019");
});

test("preserves empty bins without inventing inventory", () => {
  const [bin] = normalizeBins([{
    binid: "Z001-A01-R02-L03-F01-B05",
    occupancy: "empty",
    inventory: [],
    totalQuantityOnHand: 0,
  }]);

  assert.equal(bin.occupancy, "empty");
  assert.deepEqual(bin.inventory, []);
  assert.equal(bin.totalQuantityOnHand, 0);
});
