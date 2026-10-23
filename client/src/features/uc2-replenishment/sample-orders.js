import { SAMPLE_SKUS } from "./sample-data.js";

const pad = (value) => String(value).padStart(2, "0");
const stamp = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;

/** Small deterministic generator so the sample looks the same on every load. */
export function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/**
 * Older delivered auto-orders, so the Auto-orders table can be judged at a realistic size
 * (pagination, search, sorting). All are delivered more than a week before the sample snapshot.
 * Shape: the order fields plus `lines`, each line already in whole cartons.
 */
export function buildOrderHistory(count = 18) {
  const rand = lcg(20260920);
  return Array.from({ length: count }, (_, index) => {
    const placed = new Date(2026, 8, 9 - Math.floor(index * 0.4), 7 + ((index * 3) % 9), (index * 11) % 60);
    const delivered = new Date(placed);
    delivered.setDate(delivered.getDate() + 2 + (index % 2));
    const size = 1 + Math.floor(rand() * 3);
    const start = Math.floor(rand() * SAMPLE_SKUS.length);
    const lines = Array.from({ length: size }, (_, position) => {
      const sku = SAMPLE_SKUS[(start + position * 3) % SAMPLE_SKUS.length];
      const cartons = 4 + Math.floor(rand() * 36);
      return {
        productid: sku.productid,
        productname: sku.productname,
        cartons,
        units: cartons * sku.unitspercarton,
        role: position === 0 ? "trigger" : "companion",
        companion:
          position === 0
            ? null
            : { strength: rand() > 0.5 ? "Strong" : "Moderate", lift: Number((1.5 + rand() * 2.4).toFixed(1)) },
        reason: "Reached reorder point",
        supply: null,
      };
    });
    return {
      orderid: `ORD-${pad(placed.getMonth() + 1)}${pad(placed.getDate())}-${pad(index + 1)}`,
      status: "Fulfilled",
      triggerid: lines[0].productid,
      placedat: stamp(placed),
      deliveredat: stamp(delivered).slice(0, 10),
      lines,
    };
  });
}
