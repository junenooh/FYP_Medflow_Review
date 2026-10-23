/**
 * Export CSV for the Replenishment page. Exports what the viewer is looking at:
 *   Stock status  one row per product, with the current search and status filter, in table order
 *   Auto-orders   one row per order line
 * History is still the analytical sample, so it is not exported.
 *
 * Numbers are written raw (no thousand separators) so Excel treats them as numbers; dates are
 * YYYY-MM-DD. Every value comes from what the page already loaded: UC2's own figures, not re-derived.
 */

import { downloadCsv, toCsv } from "@shared/utils/csv.js";
import { STATUS_TEXT, replenState } from "./status.js";
import { companionSummary } from "./companions.js";

const dateOnly = (iso) => (iso ? String(iso).slice(0, 10) : "");
const round = (value, digits = 1) => (value == null || Number.isNaN(Number(value)) ? "" : Number(Number(value).toFixed(digits)));

function restockLabel(sku) {
  const state = replenState(sku);
  if (state) return state.label;
  if (sku.duenote) return "Order due";
  return sku.status === "Near ROP" ? "Monitoring" : "";
}

const stockColumns = (warehouseId, asof) => [
  ["Warehouse", () => warehouseId],
  ["Product ID", (s) => s.productid],
  ["Product", (s) => s.productname],
  ["Status", (s) => STATUS_TEXT[s.status] || s.status],
  ["On hand", (s) => s.qtyonhand],
  ["On the way", (s) => s.intransit || 0],
  ["Reorder point", (s) => s.reorderpoint],
  ["Safety stock", (s) => s.safetystock],
  ["Order-up-to level", (s) => s.orderuptolevel],
  ["Avg daily use", (s) => round(s.avgdailydemand)],
  ["Days of stock left", (s) => (s.daysofsupply >= 999 ? "" : round(s.daysofsupply))],
  ["Lead time (days)", (s) => round(s.leadtimedays)],
  ["Restock", restockLabel],
  ["Restock ID", (s) => s.order?.orderid || ""],
  ["Expected arrival", (s) => (s.order && s.order.status !== "Fulfilled" ? dateOnly(s.order.expectedat) : "")],
  ["Delivered", (s) => (s.order?.status === "Fulfilled" ? dateOnly(s.order.deliveredat) : "")],
  ["Units to order", (s) => s.orderunits || 0],
  ["Cartons to order", (s) => s.ordercartons || 0],
  ["Often used with", companionSummary],
  ["Data as of", () => asof],
];

const orderColumns = (warehouseId) => [
  ["Warehouse", () => warehouseId],
  ["Restock ID", (r) => r.order.orderid],
  ["Restock status", (r) => r.order.state?.label || r.order.status],
  ["Ordered", (r) => dateOnly(r.order.placedat)],
  ["Expected arrival", (r) => (r.order.status === "Fulfilled" ? "" : dateOnly(r.order.expectedat))],
  ["Delivered", (r) => (r.order.status === "Fulfilled" ? dateOnly(r.order.deliveredat) : "")],
  ["Product ID", (r) => r.line.productid],
  ["Product", (r) => r.line.productname],
  ["Why", (r) => (r.line.role === "companion" ? "Sent along with another product" : "Ran low")],
  ["Units", (r) => r.line.units],
  ["Cartons", (r) => r.line.cartons],
];

const fileName = ({ warehouseId, what, asof, sample, filtered }) =>
  `MedFlow-UC2-${warehouseId}-${what}-${asof}${filtered ? "-filtered" : ""}${sample ? "-SAMPLE" : ""}.csv`;

/** skus: the rows as shown (filtered and sorted). */
export function exportStock({ skus, warehouseId, asof, sample, filtered }) {
  downloadCsv(fileName({ warehouseId, what: "stock", asof, sample, filtered }), toCsv(stockColumns(warehouseId, asof), skus));
}

export function exportOrders({ orders, warehouseId, asof, sample }) {
  const rows = [...orders]
    .sort((a, b) => String(b.placedat).localeCompare(String(a.placedat)) || a.orderid.localeCompare(b.orderid))
    .flatMap((order) => order.lines.map((line) => ({ order, line })));
  downloadCsv(fileName({ warehouseId, what: "orders", asof, sample }), toCsv(orderColumns(warehouseId), rows));
}

/** History: one row per product for the period shown (days in each status, orders raised). */
export function exportHistory({ rows, days, warehouseId, asof, sample, filtered }) {
  const columns = [
    ["Warehouse", () => warehouseId],
    ["Product ID", (r) => r.productid],
    ["Product", (r) => r.name],
    ["Period (days)", () => days],
    ["Days out of stock", (r) => r.oos],
    ["Days low", (r) => r.low],
    ["Days near ROP", (r) => r.near],
    ["Restocks", (r) => r.orders],
    ["Data as of", () => asof],
  ];
  downloadCsv(fileName({ warehouseId, what: `history-${days}d`, asof, sample, filtered }), toCsv(columns, rows));
}
