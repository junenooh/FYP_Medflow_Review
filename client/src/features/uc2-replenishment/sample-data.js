/**
 * ANALYTICAL SAMPLE for the UC2 page while replenishmentrecommendation is empty.
 * Field names mirror replenishmentrecommendation so real rows can replace this file.
 * All (s,S) results below are precomputed here; the browser never derives them.
 *
 * Policy (technical documentation, Use Case 2): when the inventory position is at or below the
 * reorder point (ROP) the system raises an order by itself, Recommended Quantity = OUTL - position
 * (minimum 0). There is no approval step. Status bands:
 *   Out of Stock  on hand <= 0
 *   Low Stock     position <= ROP
 *   Near ROP      ROP < position <= ROP + safety stock   (quantity 0 on its own; may join a trigger's order)
 *   Available     above the Near ROP band
 *
 * avgdailydemand (ADD, trailing 30 days), daysofsupply, leadtimedays, safetystock, reorderpoint (s) and
 * orderuptolevel (S / OUTL) are persisted columns of the same table.
 * order: the auto-order this row belongs to (orders.status: Processing, In Transit, Fulfilled);
 *   triggerid = the SKU that raised it, equal to productid unless this row was bundled as a companion.
 * companion: the UC1 relationship that bundled this SKU into a triggering SKU's order (strength Strong | Moderate, lift).
 * order.cartons / order.units: what a delivered order carried (its rows no longer have a recommended quantity).
 * Central is assumed to hold unlimited stock, so every order is filled in full (no availability check).
 * unitspercarton / ordercartons / orderunits: calculate in units, then round the order UP to whole cartons
 *   (recommendedorderqty 436 at 12 per carton is 36.3, so 37 cartons = 444 units). Carton size comes from the
 *   storage table (shippingcasepack or totaldosagepershippingcase; confirm which matches the stock unit).
 * history: quantity after each of the last 8 inventory events, oldest first (last value = qtyonhand).
 * lasteventat / lasteventtype: the inventory row that produced this snapshot.
 */

export const SAMPLE_POLICY = Object.freeze({
  central: "WH001",
  subsidiary: "WH002",
  snapshotAt: "2026-09-20T14:32:00",
});

const ORDER_A = { orderid: "ORD-0920-01", status: "Processing", triggerid: "MED-1042", placedat: "2026-09-20T14:32:00", expectedat: "2026-09-22" };
const ORDER_B = { orderid: "ORD-0919-02", status: "In Transit", triggerid: "MED-5518", placedat: "2026-09-19T10:05:00", expectedat: "2026-09-21" };
const ORDER_C = { orderid: "ORD-0920-02", status: "Processing", triggerid: "MED-9015", placedat: "2026-09-20T12:20:00", expectedat: "2026-09-23" };

export const SAMPLE_SKUS = Object.freeze([
  { productid: "MED-1042", productname: "Surgical gloves (M)", qtyonhand: 120, reorderpoint: 200, safetystock: 60, orderuptolevel: 800, recommendedorderqty: 680, status: "Low Stock", avgdailydemand: 40, daysofsupply: 3.0, leadtimedays: 2, unitspercarton: 20, ordercartons: 34, orderunits: 680, order: ORDER_A, lasteventat: "2026-09-20T14:32:00", lasteventtype: "Consumption", history: [780, 700, 610, 520, 430, 330, 240, 120] },
  { productid: "MED-2210", productname: "Sterile gauze 10 cm", qtyonhand: 64, reorderpoint: 50, safetystock: 30, orderuptolevel: 500, recommendedorderqty: 436, status: "Near ROP", avgdailydemand: 8, daysofsupply: 8.0, leadtimedays: 2, unitspercarton: 12, ordercartons: 37, orderunits: 444, companion: { strength: "Strong", lift: 3.4 }, order: { ...ORDER_A }, lasteventat: "2026-09-20T13:05:00", lasteventtype: "Consumption", history: [480, 400, 330, 260, 200, 140, 96, 64] },
  { productid: "MED-3307", productname: "Saline flush 10 ml", qtyonhand: 112, reorderpoint: 90, safetystock: 40, orderuptolevel: 300, recommendedorderqty: 188, status: "Near ROP", avgdailydemand: 12, daysofsupply: 9.3, leadtimedays: 3, unitspercarton: 24, ordercartons: 8, orderunits: 192, companion: { strength: "Moderate", lift: 1.8 }, order: { ...ORDER_A }, lasteventat: "2026-09-19T16:40:00", lasteventtype: "Consumption", history: [300, 262, 224, 186, 150, 138, 124, 112] },
  { productid: "MED-4120", productname: "IV giving set", qtyonhand: 310, reorderpoint: 150, safetystock: 45, orderuptolevel: 600, recommendedorderqty: 0, status: "Available", avgdailydemand: 10, daysofsupply: 31.0, leadtimedays: 2, unitspercarton: 10, ordercartons: 0, orderunits: 0, order: { orderid: "ORD-0916-01", status: "Fulfilled", triggerid: "MED-4120", placedat: "2026-09-16T09:00:00", deliveredat: "2026-09-18", cartons: 40, units: 400 }, lasteventat: "2026-09-18T09:15:00", lasteventtype: "Receipt", history: [520, 430, 360, 290, 230, 180, 140, 310] },
  { productid: "MED-5518", productname: "N95 respirator mask", qtyonhand: 35, reorderpoint: 120, safetystock: 50, orderuptolevel: 400, recommendedorderqty: 365, status: "Low Stock", avgdailydemand: 14, daysofsupply: 2.5, leadtimedays: 2, unitspercarton: 10, ordercartons: 37, orderunits: 370, order: ORDER_B, lasteventat: "2026-09-20T14:10:00", lasteventtype: "Consumption", history: [260, 220, 180, 150, 130, 118, 60, 35] },
  { productid: "MED-6001", productname: "Face shield", qtyonhand: 78, reorderpoint: 65, safetystock: 25, orderuptolevel: 200, recommendedorderqty: 122, status: "Near ROP", avgdailydemand: 6, daysofsupply: 13.0, leadtimedays: 3, unitspercarton: 8, ordercartons: 16, orderunits: 128, companion: { strength: "Strong", lift: 2.9 }, order: { ...ORDER_B }, lasteventat: "2026-09-20T11:48:00", lasteventtype: "Consumption", history: [160, 140, 125, 108, 96, 90, 84, 78] },
  { productid: "MED-7702", productname: "Alcohol swab", qtyonhand: 500, reorderpoint: 200, safetystock: 60, orderuptolevel: 900, recommendedorderqty: 0, status: "Available", avgdailydemand: 20, daysofsupply: 25.0, leadtimedays: 2, unitspercarton: 100, ordercartons: 0, orderunits: 0, order: { orderid: "ORD-0915-03", status: "Fulfilled", triggerid: "MED-7702", placedat: "2026-09-15T08:30:00", deliveredat: "2026-09-17", cartons: 6, units: 600 }, lasteventat: "2026-09-17T15:20:00", lasteventtype: "Receipt", history: [310, 260, 220, 190, 150, 110, 80, 500] },
  { productid: "MED-8804", productname: "Syringe 5 ml", qtyonhand: 205, reorderpoint: 200, safetystock: 40, orderuptolevel: 700, recommendedorderqty: 0, status: "Near ROP", avgdailydemand: 22, daysofsupply: 9.3, leadtimedays: 2, unitspercarton: 20, ordercartons: 0, orderunits: 0, order: null, lasteventat: "2026-09-20T08:02:00", lasteventtype: "Consumption", history: [640, 560, 480, 400, 340, 290, 240, 205] },
  { productid: "MED-9015", productname: "Blood collection tube", qtyonhand: 0, reorderpoint: 150, safetystock: 45, orderuptolevel: 600, recommendedorderqty: 600, status: "Out of Stock", avgdailydemand: 15, daysofsupply: 0.0, leadtimedays: 3, unitspercarton: 50, ordercartons: 12, orderunits: 600, order: ORDER_C, lasteventat: "2026-09-20T12:20:00", lasteventtype: "Consumption", history: [300, 240, 190, 140, 90, 50, 20, 0] },
]);
