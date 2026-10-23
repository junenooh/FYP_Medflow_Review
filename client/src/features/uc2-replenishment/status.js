/**
 * UC2 status vocabulary (docs/use-cases/technical-documentation.md, "Status & Classification Strategy").
 *
 * replenishmentrecommendation.status, shown verbatim:
 *   Out of Stock  on hand <= 0                        Urgent alert. Stockout occurred.
 *   Low Stock     inventory position <= ROP           Regular alert. Reorder threshold breached.
 *   Near ROP      ROP < position <= ROP + safety stock Monitor. Quantity is 0 for now.
 *   Available     above the Near ROP band             OK.
 * Out of Stock and Low Stock raise an order automatically; there is no approval step.
 */

export const STATUS_KIND = Object.freeze({
  "Out of Stock": "oos",
  "Low Stock": "low",
  "Near ROP": "near",
  Available: "ok",
});

/** Most urgent first. */
export const STATUS_RANK = Object.freeze({
  "Out of Stock": 0,
  "Low Stock": 1,
  "Near ROP": 2,
  Available: 3,
});

/** Plain-language meaning of each status, shown as a hover hint. */
export const STATUS_HINT = Object.freeze({
  "Out of Stock": "None on the shelf. A restock is ordered automatically.",
  "Low Stock": "At or below its reorder point. A restock is ordered automatically.",
  "Near ROP": "Just above its reorder point. Being watched; nothing ordered yet.",
  Available: "Plenty on the shelf.",
});

export const KIND_ORDER = Object.freeze(["oos", "low", "near", "ok"]);
export const KIND_LABEL = Object.freeze({
  oos: "Out of Stock",
  low: "Low Stock",
  near: "Near ROP",
  ok: "Available",
});

export const statusLabel = (row) => row.status;
export const statusKind = (row) => STATUS_KIND[row.status] || "ok";

/**
 * What the viewer reads. The stored values above stay as they are: filters, links and the
 * notification bell match on them.
 */
export const STATUS_TEXT = Object.freeze({
  "Out of Stock": "Out of stock",
  "Low Stock": "Low stock",
  "Near ROP": "Near ROP",
  Available: "In stock",
});
export const statusText = (row) => STATUS_TEXT[row.status] || row.status;
export const kindText = (kind) => STATUS_TEXT[KIND_LABEL[kind]] || KIND_LABEL[kind];

/**
 * Auto-order progress, mapped from orders.status (stocktransfer.status can refine it later).
 * Replenishment is automatic, so there is no "suggested" or "approve" state. Central is assumed to
 * hold unlimited stock, so every order is filled in full and nothing is held up.
 */
export const REPLEN_STATES = Object.freeze({
  Processing: { label: "Restock ordered", kind: "placed", rank: 1 },
  "In Transit": { label: "On its way", kind: "transit", rank: 2 },
  Fulfilled: { label: "Delivered", kind: "done", rank: 4 },
});

export const replenState = (row) => (row.order ? REPLEN_STATES[row.order.status] || null : null);
