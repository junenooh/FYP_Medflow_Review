// Unit tests for the UC2 page logic: inventory position, status, restock quantity and cartons
// (client/src/features/uc2-replenishment/live-data.js `assemble`), UC1 companion advice
// (companions.js) and the stock alerts (features/notifications/rules.js).
//
// Run: node --test tests/frontend/test_uc2_replenishment.mjs
// The modules use the Vite aliases (@shared/...), so they are loaded through Vite's module loader.
// No database is used: every test builds the raw rows by hand.
// Test IDs (TC-UC2-UT-1xx) match docs/testing/uc2-unit-tests.md.

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
let server, assemble, companionAdvice, needsRestock, buildAlerts, headline;

before(async () => {
  server = await createServer({ root: `${ROOT}/client`, configFile: `${ROOT}/vite.config.js`, server: { middlewareMode: true }, appType: "custom", logLevel: "error" });
  ({ assemble } = await server.ssrLoadModule("/src/features/uc2-replenishment/live-data.js"));
  ({ companionAdvice, needsRestock } = await server.ssrLoadModule("/src/features/uc2-replenishment/companions.js"));
  ({ buildAlerts, headline } = await server.ssrLoadModule("/src/features/notifications/rules.js"));
});
after(async () => server?.close());

const ASOF = "2026-10-14";

/** One uc2_policy_parameters row: reorder point 100, safety stock 30, order-up-to 200, 20 a day. */
function policy(productid, currentstock, extra = {}) {
  return {
    productid, asofdate: ASOF, computedat: "2026-10-15T00:07:11Z", method: "ses", demandclass: "smooth",
    avgdailydemand: 20, safetystock: 30, reorderpoint: 100, orderuptolevel: 200, currentstock,
    daysofcover: currentstock / 20, stockstatus: "", leadtimedays: 2, isdormant: false, ...extra,
  };
}

function build(policyRows, { orders = [], lines = [], carton = 24 } = {}) {
  const ids = policyRows.map((r) => r.productid);
  return assemble({
    policy: policyRows,
    products: ids.map((id) => ({ productid: id, productname: `Product ${id}` })),
    storage: ids.map((id) => ({ productid: id, shippingcasepack: carton })),
    orders, lines, events: [], pairs: [],
  }, "WH002");
}
const sku = (data, id) => data.skus.find((s) => s.productid === id);

// ------------------------------------------------------------------
// Status (UC2.4 AC2-AC6)
// ------------------------------------------------------------------
test("TC-UC2-UT-101 status bands: Out of Stock, Low Stock, Near ROP, Available", () => {
  const data = build([
    policy("OOS", 0), policy("AT_ROP", 100), policy("LOW", 80),
    policy("NEAR", 120), policy("NEAR_EDGE", 130), policy("OK", 131),
  ]);
  assert.equal(sku(data, "OOS").status, "Out of Stock");      // nothing on hand
  assert.equal(sku(data, "AT_ROP").status, "Low Stock");      // position = reorder point
  assert.equal(sku(data, "LOW").status, "Low Stock");         // position below it
  assert.equal(sku(data, "NEAR").status, "Near ROP");         // inside reorder point + safety stock
  assert.equal(sku(data, "NEAR_EDGE").status, "Near ROP");    // exactly reorder point + safety stock
  assert.equal(sku(data, "OK").status, "Available");          // above that
});

test("TC-UC2-UT-102 a product with no demand is never flagged", () => {
  const data = build([policy("DORMANT", 0, { avgdailydemand: 0, reorderpoint: 0, isdormant: true })]);
  assert.equal(sku(data, "DORMANT").status, "Available");
  assert.equal(sku(data, "DORMANT").recommendedorderqty, 0);
});

// ------------------------------------------------------------------
// Inventory position and restock quantity (US2.2 AC1-AC5)
// ------------------------------------------------------------------
test("TC-UC2-UT-103 inventory position counts units already on the way", () => {
  // 50 on hand + 60 on an open order = 110: above the reorder point (100), so no new order
  const data = build([policy("P5", 50)], {
    orders: [{ orderid: "PO-WH002-20261013", orderdate: "2026-10-13", fulfilmentdate: null, status: "Processing" }],
    lines: [{ orderlineid: "PO-WH002-20261013-0001", orderid: "PO-WH002-20261013", productid: "P5", qtyordered: 60 }],
  });
  const p5 = sku(data, "P5");
  assert.equal(p5.intransit, 60);
  assert.equal(p5.status, "Near ROP");
  assert.equal(p5.recommendedorderqty, 0);
  assert.equal(p5.order.orderid, "PO-WH002-20261013");
});

test("TC-UC2-UT-104 restock quantity = order-up-to level - inventory position, only when due", () => {
  const data = build([policy("LOW", 80), policy("OOS", 0), policy("NEAR", 120), policy("OK", 180)]);
  assert.equal(sku(data, "LOW").recommendedorderqty, 120);    // 200 - 80
  assert.equal(sku(data, "OOS").recommendedorderqty, 200);    // 200 - 0
  assert.equal(sku(data, "NEAR").recommendedorderqty, 0);     // above the reorder point
  assert.equal(sku(data, "OK").recommendedorderqty, 0);

  // 30 on hand + 20 on the way = 50, still at or below 100: order 200 - 50 = 150, not 200 - 30
  const due = build([policy("DUE", 30)], {
    orders: [{ orderid: "PO-WH002-20261013", orderdate: "2026-10-13", fulfilmentdate: null, status: "Processing" }],
    lines: [{ orderlineid: "PO-WH002-20261013-0001", orderid: "PO-WH002-20261013", productid: "DUE", qtyordered: 20 }],
  });
  assert.equal(sku(due, "DUE").recommendedorderqty, 150);
});

// ------------------------------------------------------------------
// Whole cartons (US2.1 AC7), the same rule as the reorder check in scripts/live/day.py
// ------------------------------------------------------------------
test("TC-UC2-UT-105 cartons: nearest to the gap, never fewer than it takes to clear the reorder point", () => {
  const data = build([
    policy("LOW", 80),                                   // gap 120 = 5 cartons of 24 exactly
    policy("OOS", 0),                                    // gap 200 = 8.33 -> 8 cartons (192 units)
    policy("CLEAR", 0, { orderuptolevel: 105 }),         // gap 105 = 4.4 -> 4, but 101 needed to clear -> 5
  ]);
  assert.deepEqual([sku(data, "LOW").ordercartons, sku(data, "LOW").orderunits], [5, 120]);
  assert.deepEqual([sku(data, "OOS").ordercartons, sku(data, "OOS").orderunits], [8, 192]);
  assert.deepEqual([sku(data, "CLEAR").ordercartons, sku(data, "CLEAR").orderunits], [5, 120]);
  assert.equal(sku(data, "LOW").unitspercarton, 24);
});

// ------------------------------------------------------------------
// Orders (US2.3 AC1, AC4)
// ------------------------------------------------------------------
test("TC-UC2-UT-106 order status, timing and companion lines", () => {
  const orders = [
    { orderid: "PO-WH002-20261014", orderdate: "2026-10-14", fulfilmentdate: null, status: "Processing" },
    { orderid: "PO-WH002-20261012", orderdate: "2026-10-12", fulfilmentdate: null, status: "Processing" },
    { orderid: "PO-WH002-20261010", orderdate: "2026-10-10", fulfilmentdate: "2026-10-12", status: "Fulfilled" },
  ];
  const lines = [
    { orderlineid: "PO-WH002-20261014-0001", orderid: "PO-WH002-20261014", productid: "A", qtyordered: 48 },
    { orderlineid: "PO-WH002-20261014-0002C", orderid: "PO-WH002-20261014", productid: "B", qtyordered: 24 },
    { orderlineid: "PO-WH002-20261012-0001", orderid: "PO-WH002-20261012", productid: "A", qtyordered: 24 },
    { orderlineid: "PO-WH002-20261010-0001", orderid: "PO-WH002-20261010", productid: "B", qtyordered: 72 },
  ];
  const data = build([policy("A", 50), policy("B", 150)], { orders, lines });
  const byId = Object.fromEntries(data.orders.map((o) => [o.orderid, o]));

  assert.equal(byId["PO-WH002-20261014"].status, "Processing");   // placed on the last day
  assert.equal(byId["PO-WH002-20261012"].status, "In Transit");   // older and still open
  assert.equal(byId["PO-WH002-20261010"].status, "Fulfilled");
  assert.equal(byId["PO-WH002-20261014"].placedat, "2026-10-14T23:30:00");   // nightly check
  assert.equal(byId["PO-WH002-20261010"].deliveredat, "2026-10-12");
  assert.deepEqual(byId["PO-WH002-20261014"].lines.map((l) => [l.productid, l.role]),
    [["A", "trigger"], ["B", "companion"]]);                       // 'C' suffix = companion
  assert.equal(sku(data, "A").intransit, 72);                      // both open orders count
  assert.equal(sku(data, "B").intransit, 24);                      // the delivered order does not
});

// ------------------------------------------------------------------
// UC1 companions are advice only (US2.3 AC2)
// ------------------------------------------------------------------
test("TC-UC2-UT-107 companion advice depends on the companion's own position", () => {
  const owner = { status: "Low Stock", order: null };
  const advise = (companionSku) => companionAdvice({ sku: companionSku }, owner).tone;
  assert.equal(advise({ status: "Near ROP" }), "worth");
  assert.equal(advise({ status: "Low Stock" }), "due");
  assert.equal(advise({ status: "Available" }), "quiet");
  assert.equal(advise({ status: "Available", order: { orderid: "X", status: "In Transit" } }), "onorder");
  const shared = { orderid: "Y", status: "Processing" };
  assert.equal(companionAdvice({ sku: { status: "Low Stock", order: shared } }, { order: shared }).tone, "together");
  assert.equal(needsRestock({ status: "Near ROP" }), false);
  assert.equal(needsRestock({ status: "Out of Stock" }), true);
});

// ------------------------------------------------------------------
// Alerts (UC2.4 AC8, UC2.5 AC6)
// ------------------------------------------------------------------
test("TC-UC2-UT-108 stock alerts: out of stock is urgent and says whether a restock is coming", () => {
  const orders = [{ orderid: "PO-WH002-20261013", orderdate: "2026-10-13", fulfilmentdate: null, status: "Processing" }];
  const lines = [{ orderlineid: "PO-WH002-20261013-0001", orderid: "PO-WH002-20261013", productid: "COMING", qtyordered: 96 }];
  const data = build([policy("COMING", 0), policy("NONE", 0), policy("OK", 180)], { orders, lines });
  const alerts = buildAlerts({ warehouseId: "WH002", data });
  const oos = Object.fromEntries(alerts.filter((a) => a.kind === "oos").map((a) => [a.productid, a]));

  assert.equal(oos.COMING.level, "urgent");
  assert.equal(oos.COMING.action.label, "Delivery on the way");
  assert.equal(oos.NONE.action.label, "Ordering tonight");
  assert.ok(!alerts.some((a) => a.productid === "OK" && a.level === "urgent"));
  assert.ok(alerts.every((a) => a.href.includes("warehouse=WH002")));   // each alert links to its product
});

test("TC-UC2-UT-109 headline leads with what needs action", () => {
  const data = build([policy("A", 0), policy("B", 0)]);
  const h = headline(buildAlerts({ warehouseId: "WH002", data }));
  assert.equal(h.tone, "handled");                        // both are ordered automatically tonight
  assert.equal(h.lead, "Restocks are on the way");
  assert.match(h.detail, /^2 out of stock · 1 subsidiary$/);
  assert.equal(headline([]).lead, "No stock problems");
});
