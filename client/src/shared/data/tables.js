/** Live FYP MedFlow DB table names and CHECK enums. Keep in sync with engines/shared/db/tables.py */

export const DATABASE_NAME = "FYP MedFlow DB";
export const PROJECT_ID = "ikjrcfqleskfgatsxdjr";

export const WAREHOUSE = Object.freeze({
  central: "WH001",
  subsidiary: "WH002",
});

export const TABLE_NAMES = Object.freeze([
  "warehouse",
  "site",
  "zone",
  "bin",
  "product",
  "storage",
  "inventory",
  "orders",
  "orderline",
  "stocktransfer",
  "consumption",
  "demand",
  "warehouseproduct",
  "warehouseproductcalculation",
  "modelrun",
  "productrelationship",
  "productrelationshipantecedent",
  "replenishmentrecommendation",
  "layoutrecommendation",
]);

export const TABLES = Object.freeze(
  Object.fromEntries(TABLE_NAMES.map((name) => [name, name])),
);

export const STATUS = Object.freeze({
  warehouseRole: Object.freeze(["CENTRAL", "SUBSIDIARY"]),
  product: Object.freeze([
    "Available",
    "Phase-Out",
    "Discontinued",
    "Obsolete",
    "Inactive",
    "Archived",
  ]),
  inventory: Object.freeze([
    "Available",
    "Allocated",
    "Reserved",
    "Blocked",
    "Quarantine",
    "In Transit",
    "Expired",
  ]),
  order: Object.freeze(["Processing", "Fulfilled", "Cancelled", "On Hold"]),
  stockTransfer: Object.freeze(["Requested", "In Transit", "Completed", "Cancelled"]),
  layoutPriority: Object.freeze(["Critical", "High", "Medium", "Low", "Deferred"]),
  replenishmentRow: Object.freeze(["Out of Stock", "Low Stock", "Near ROP", "Available"]),
  recommendation: Object.freeze(["Pending", "Accepted", "Modified", "Declined", "Dismissed"]),
  fulfillment: Object.freeze(["Unfulfilled", "Fulfilled", "Cannot Fulfill"]),
});
