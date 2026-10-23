import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";

const number = (value) => Number(value).toLocaleString();
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/* ------------------------------------------------------------------ */
/* Auto-replenishment pipeline                                         */
/* ------------------------------------------------------------------ */

const icon = (body) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/** A small chevron on a card that can be opened, so it looks clickable without being told. */
const GO = `<span class="pipe-go" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg></span>`;

/** One symbol per stage: a box running down, an order sheet, a truck, a box ticked off. */
const STAGE_ICON = Object.freeze({
  start: icon('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M12 9v6M9.5 12.5 12 15l2.5-2.5"/>'),
  placed: icon('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M8.5 13l2.5 2.5 4.5-5"/>'),
  transit: icon('<path d="M2 6h11v10H2zM13 10h4.5l3.5 3.5V16h-8z"/><circle cx="6.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>'),
  done: icon('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
});

/**
 * The life of an automatic order, left to right: a SKU reaches its reorder point, the system places the
 * order, it travels, it is delivered. Central is assumed to have unlimited stock, so no order is held up.
 * Stages are mutually exclusive and count orders, exactly like the board on the Auto-orders tab.
 * Nothing is evaluated here.
 */
export function renderPipeline({ skus, orders }, activeStatus = "", lowActive = false) {
  const atRop = skus.filter((sku) => sku.status === "Out of Stock" || sku.status === "Low Stock");
  const outOfStock = skus.filter((sku) => sku.status === "Out of Stock").length;
  const stage = (group, keep = () => true) => {
    const rows = orders.filter((order) => order.group === group && keep(order));
    return { orders: rows.length, lines: rows.reduce((sum, order) => sum + order.lines.length, 0) };
  };
  const placed = stage("placed");
  const transit = stage("transit");
  const delivered = stage("delivered", (order) => order.recent);

  const node = ({ label, kind, count, sub, filter }) => {
    const active = activeStatus === filter;
    return `
      <button type="button" class="pipe-node is-${kind}${active ? " is-active" : ""}" data-stage="${escapeAttribute(filter)}" aria-pressed="${active}">
        <span class="pipe-ico is-${kind}" aria-hidden="true">${STAGE_ICON[kind]}</span>
        <span class="pipe-text">
          <span class="pipe-label">${escapeHtml(label)}</span>
          <span class="pipe-count">${number(count)}<small>${count === 1 ? "restock" : "restocks"}</small></span>
          <span class="pipe-sub">${escapeHtml(sub)}</span>
        </span>
        ${GO}
      </button>`;
  };
  const arrow = `<span class="pipe-arrow" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg></span>`;

  return `
    <div class="pipe-head">
      <div class="l">Restock status</div>
    </div>
    <div class="pipe-flow">
      <${atRop.length ? `button type="button" data-low-focus="${escapeAttribute(atRop.map((sku) => sku.productid).join(","))}" aria-pressed="${lowActive}"` : `div role="group"`} class="pipe-node is-start${lowActive ? " is-active" : ""}" aria-label="Running low: ${atRop.length} ${atRop.length === 1 ? "product" : "products"}">
        <span class="pipe-ico is-start" aria-hidden="true">${STAGE_ICON.start}</span>
        <span class="pipe-text">
          <span class="pipe-label">Running low</span>
          <span class="pipe-count">${atRop.length}<small>${atRop.length === 1 ? "product" : "products"}</small></span>
          <span class="pipe-sub">${outOfStock ? `incl. ${outOfStock} out of stock` : atRop.length ? "each gets a restock" : "nothing needs a restock"}</span>
        </span>
        ${atRop.length ? GO : ""}
      </${atRop.length ? "button" : "div"}>
      ${arrow}
      ${node({ label: "Order placed", kind: "placed", count: placed.orders, sub: plural(placed.lines, "item"), filter: "Order placed" })}
      ${arrow}
      ${node({ label: "On its way", kind: "transit", count: transit.orders, sub: plural(transit.lines, "item"), filter: "On its way" })}
      ${arrow}
      ${node({ label: "Delivered", kind: "done", count: delivered.orders, sub: "last 7 days", filter: "Delivered" })}
    </div>
  `;
}

/* ------------------------------------------------------------------ */
/* Runway mini bar                                                     */
/* ------------------------------------------------------------------ */

/**
 * Runway: how many days the current stock lasts at the recent usage rate, against the lead time.
 * The bar is scaled to `cap` days; the tick marks the lead time. A red bar means the stock is
 * expected to run out before a new order could arrive.
 */
export function renderRunway({ days, leadDays, cap = 14 }) {
  const fill = Math.min(days, cap) / cap;
  const lead = Math.min(leadDays, cap) / cap;
  const risk = days < leadDays;
  const label = `Stock lasts ${days} days, lead time ${leadDays} days${risk ? ", so it runs out before delivery" : ""}`;
  return `
    <div class="runway${risk ? " is-risk" : ""}" role="img" aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}">
      <span class="runway-fill" style="width:${fill * 100}%"></span>
      <span class="runway-lead" style="left:${lead * 100}%"></span>
    </div>
  `;
}
