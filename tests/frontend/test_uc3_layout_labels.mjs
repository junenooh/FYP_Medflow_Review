import assert from "node:assert/strict";
import test from "node:test";
import { counterpartForMoveEvent, formatStorageLocation, movementEventCopy, movementStateCopy } from "../../client/src/features/uc3-layout/movement-navigation.js";

test("formats a mapped bin as a business-readable storage location", () => {
  assert.equal(
    formatStorageLocation({
      mappingStatus: "mapped",
      aisleNumber: 1,
      rackNumber: 2,
      shelfLevel: "L03",
      faceNumber: 4,
      binPosition: "B05",
    }),
    "Aisle A01 · Rack R02 · Shelf L03 · Rack face F04 · Bin B05"
  );
  assert.equal(formatStorageLocation({ mappingStatus: "unparseable" }), "Location needs review");
});

test("uses distinct business labels for inbound, outbound, and exchanged bins", () => {
  assert.deepEqual(movementStateCopy("in"), {
    legend: "Products moving in", badge: "MOVE IN", aria: "products moving in",
  });
  assert.deepEqual(movementStateCopy("out"), {
    legend: "Products moving out", badge: "MOVE OUT", aria: "products moving out",
  });
  assert.deepEqual(movementStateCopy("both"), {
    legend: "Products moving in and out", badge: "IN & OUT", aria: "products moving in and out",
  });
  assert.equal(movementEventCopy("in"), "Product moved into this bin");
  assert.equal(movementEventCopy("out"), "Product moved out of this bin");
  assert.equal(
    counterpartForMoveEvent({ direction: "in", move: { currentbin: "Z001-A01" } }).label,
    "View original bin"
  );
  assert.equal(
    counterpartForMoveEvent({ direction: "out", move: { recommendedbin: "Z002-A01" } }).label,
    "View recommended bin"
  );
});
