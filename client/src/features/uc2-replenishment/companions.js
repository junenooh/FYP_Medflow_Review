/**
 * UC1 companions beside a replenishment recommendation.
 *
 * User story: as an Ops Analyst, I want to see related UC1 companion SKUs beside each replenishment
 * recommendation, so that I can consider coordinated replenishment WITHOUT additional SKUs being added
 * to the transfer automatically. So this is advice only: nothing here changes an order.
 *
 * sku.companions (live-data.js): [{ productid, strength, lift, confidence, sku }], strongest first,
 * where `sku` is the companion's own row on the page (its stock and status right now).
 */

export const needsRestock = (sku) => sku.status === "Out of Stock" || sku.status === "Low Stock";

/**
 * Whether adding the companion to this restock is worth considering, from its own position today:
 *   on order      it already has an order on the way
 *   due           it is at or below its own reorder point, so it is ordered at the next check anyway
 *   worth         Near ROP: just above its reorder point, so sending it now could save a separate trip
 *   quiet         comfortably stocked, nothing to do
 */
/**
 * The order this product and its companion share, if they were restocked on the same order (both
 * reached their reorder point on the same night). { order, open } or null.
 */
export function sharedOrder(owner, companion) {
  const mine = owner?.order;
  const theirs = companion.sku.order;
  if (!mine || !theirs || mine.orderid !== theirs.orderid) return null;
  return { order: mine, open: mine.status !== "Fulfilled" };
}

export function companionAdvice(companion, owner) {
  const { sku } = companion;
  const shared = sharedOrder(owner, companion);
  if (shared?.open) return { tone: "together", label: "Same delivery" };
  if (sku.order && sku.order.status !== "Fulfilled") return { tone: "onorder", label: "Already on order" };
  if (needsRestock(sku)) return { tone: "due", label: "Due as well" };
  if (sku.status === "Near ROP") return { tone: "worth", label: "Worth adding" };
  return { tone: "quiet", label: "Not needed" };
}

export const companionsOf = (sku) => sku.companions || [];

/** UC1 strength in plain words. */
export const togetherLabel = (strength) => (strength === "Strong" ? "Very often used together" : "Often used together");

/** The analyst's detail, for hover text only: what lift means, plus the raw UC1 figures. */
export const togetherHint = (pair) =>
  `Hospitals ask for these together about ${pair.lift.toFixed(1)}× more often than by chance (UC1: ${pair.strength}, lift ${pair.lift.toFixed(2)}).`;
export const worthAdding = (sku) => companionsOf(sku).filter((c) => companionAdvice(c, sku).tone === "worth");

const STOCK_WORDS = {
  "Out of Stock": "out of stock",
  "Low Stock": "running low",
  "Near ROP": "close to its reorder point",
  Available: "in stock",
};

/**
 * "Water for Injection (MED0187): worth adding; ..." for the CSV export. The advice is given only when
 * this product is being restocked; otherwise the item's own stock status is shown.
 */
export const companionSummary = (sku) =>
  companionsOf(sku)
    .map((c) => {
      const shared = sharedOrder(sku, c);
      const note = shared
        ? shared.open
          ? "coming on the same delivery"
          : "delivered together"
        : needsRestock(sku)
          ? companionAdvice(c, sku).label.toLowerCase()
          : STOCK_WORDS[c.sku.status] || c.sku.status.toLowerCase();
      return `${c.sku.productname} (${c.productid}): ${note}`;
    })
    .join("; ");
