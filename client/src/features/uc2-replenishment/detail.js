import "./drawer.css";
import "./history.css";
import { parseRoute } from "@app/router.js";
import { WAREHOUSE } from "@shared/data/tables.js";
import { statusPill } from "@shared/components/table.js";
import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";
import { bindTips } from "./charts/history.js";
import { renderStepChart } from "./charts/rop.js";
import { renderStockTrend, trendFacts } from "./charts/trend.js";
import { historySource } from "./history-source.js";
import { loadSkuHistory, peekSkuHistory } from "./history-data.js";
import { statusKind, statusText } from "./status.js";
import { LINK_ICON, companionTag } from "./tags.js";
import { companionAdvice, companionsOf, needsRestock, sharedOrder, togetherHint, togetherLabel, worthAdding } from "./companions.js";

const dayTime = (iso) =>
  new Date(iso).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const day = (iso) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
export const n = (value) => Number(value).toLocaleString();

/* ------------------------------------------------------------------ */
/* Shared: progress stepper                                            */
/* ------------------------------------------------------------------ */

const svg = (body) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

/** One symbol per step, so the progress reads at a glance without the labels. */
const STEP_ICON = Object.freeze({
  triggered: svg('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  placed: svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M8.5 13l2.5 2.5 4.5-5"/>'),
  transit: svg('<path d="M2 6h11v10H2zM13 10h4.5l3.5 3.5V16h-8z"/><circle cx="6.5" cy="18" r="2"/><circle cx="17.5" cy="18" r="2"/>'),
  delivered: svg('<path d="M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"/>'),
});

/**
 * Horizontal stepper: Triggered → Placed → On its way → Delivered.
 * Central is assumed to have unlimited stock, so an order never stalls at Placed.
 */
export function renderProgress({ status, placedat, expectedat, deliveredat, companion = false }) {
  const delivered = status === "Fulfilled";
  const inTransit = status === "In Transit";
  const steps = [
    { label: companion ? "Sent with" : "Ran low", when: day(placedat), state: "done", icon: STEP_ICON.triggered },
    {
      label: "Ordered",
      when: day(placedat),
      state: "done",
      icon: STEP_ICON.placed,
    },
    {
      label: "On its way",
      when: inTransit && expectedat ? `arrives ${day(expectedat)}` : "",
      state: delivered ? "done" : inTransit ? "current" : "todo",
      icon: STEP_ICON.transit,
    },
    {
      label: "Delivered",
      when: delivered ? day(deliveredat) : expectedat ? `expected ${day(expectedat)}` : "",
      state: delivered ? "done" : "todo",
      icon: STEP_ICON.delivered,
    },
  ];
  const list = steps
    .map(
      (step) => `
      <li class="hs-${step.state}">
        <span class="hs-dot" aria-hidden="true">${step.icon}</span>
        <span class="hs-label">${escapeHtml(step.label)}</span>
        <span class="hs-when">${escapeHtml(step.when)}</span>
      </li>`,
    )
    .join("");
  return `
    <ol class="hsteps" aria-label="Order progress">${list}</ol>`;
}

/* ------------------------------------------------------------------ */
/* Product panel                                                       */
/* ------------------------------------------------------------------ */

/**
 * One short line on where this product stands. What is being done about it is in the restock card
 * beside the chart, so it is not said twice.
 */
function explain(sku) {
  const { reorderpoint: rop } = sku;
  if (sku.status === "Out of Stock") return "Nothing on the shelf.";
  if (sku.status === "Low Stock") return `At its reorder point of ${n(rop)}.`;
  if (sku.status === "Near ROP") return `Just above its reorder point of ${n(rop)}.`;
  return `Well above its reorder point of ${n(rop)}.`;
}

/* ---- facts from the daily history (live only; null until it has loaded) ---- */

export function dailyFor(sku) {
  const source = historySource();
  if (!source.live) return null;
  const daily = source.getSkuHistory(sku.productid);
  return daily?.stock?.length ? { ...daily, source } : null;
}

/** This product's real delivery times: days from order to delivery, over the loaded history. */
export function deliveryTimes(daily) {
  if (!daily) return null;
  const leads = (daily.deliveries || [])
    .map((d) => {
      const o = (daily.ordered || []).find((item) => item.orderid === d.orderid);
      return o ? d.day - o.day : null;
    })
    .filter((lead) => lead != null && lead > 0);
  if (!leads.length) return null;
  const avg = leads.reduce((sum, lead) => sum + lead, 0) / leads.length;
  return { avg, min: Math.min(...leads), max: Math.max(...leads), count: leads.length };
}

/** "about 2 days (1–3 lately)", or the planned figure when there is no delivery to go on. */
export function deliveryText(sku, daily) {
  const times = deliveryTimes(daily);
  if (!times) return `about ${sku.leadtimedays} days`;
  const avg = Number(times.avg.toFixed(1));
  return times.min === times.max ? `about ${avg} days` : `about ${avg} days (${times.min}–${times.max} lately)`;
}

/** "2–3 days" from this product's real deliveries, or "~2 days" from the planned figure. */
function deliveryShort(sku, daily) {
  const times = deliveryTimes(daily);
  const unit = (value) => (Number(value) === 1 ? "day" : "days");
  if (!times) return `~${sku.leadtimedays} ${unit(sku.leadtimedays)}`;
  return times.min === times.max ? `${times.min} ${unit(times.min)}` : `${times.min}–${times.max} days`;
}

function hero(sku) {
  const risk = sku.daysofsupply < sku.leadtimedays;
  const days = Number.isInteger(sku.daysofsupply) ? sku.daysofsupply : sku.daysofsupply.toFixed(1);
  const used = sku.avgdailydemand > 0 && sku.daysofsupply < 999;
  // whole days once it is a few days out; one decimal only when it is close
  const lasts = !used ? "Not used lately" : sku.daysofsupply >= 3 ? `~${Math.round(sku.daysofsupply)} days` : `${days} ${Number(days) === 1 ? "day" : "days"}`;
  return `
    <section class="drawer-section drawer-hero">
      <div class="hero-nums">
        <div><b class="is-mono">${n(sku.qtyonhand)}</b><span>on the shelf${sku.intransit ? ` · ${n(sku.intransit)} on the way` : ""}</span></div>
        <div><b>${n(sku.reorderpoint)}</b><span>reorder point</span></div>
        <div><b>${n(sku.orderuptolevel)}</b><span>order-up-to level</span></div>
      </div>
      <div class="hero-stats">
        <div class="${risk ? "is-risk" : ""}"><span>Stock lasts</span><b>${escapeHtml(lasts)}</b>${risk ? "<small>less than the lead time</small>" : ""}</div>
        <div><span>Lead time</span><b>${escapeHtml(deliveryShort(sku, dailyFor(sku)))}</b></div>
      </div>
    </section>`;
}

/**
 * How the order quantity is worked out, laid out the way replenishment systems show a min-max
 * (s, S) policy: inventory position, reorder point (lead-time demand + safety stock), the check
 * between them, then the order quantity in whole cartons. Display arithmetic only: the reorder
 * point, safety stock and order-up-to level are UC2's; the carton and companion rules mirror the
 * reorder check in scripts/live/day.py (cartonise, CAN_ORDER_SHARE), which places the real orders.
 */
function calculation(sku) {
  const line = (op, label, value, { total = false, hint = "" } = {}) => `
    <div class="calc-line${total ? " is-total" : ""}">
      <span class="calc-op" aria-hidden="true">${op}</span>
      <span class="calc-label">${escapeHtml(label)}${hint ? `<small>${escapeHtml(hint)}</small>` : ""}</span>
      <b>${escapeHtml(value)}</b>
    </div>`;
  const block = (title, body) => `<div class="calc-block"><h4>${escapeHtml(title)}</h4>${body}</div>`;

  const onOrder = sku.intransit || 0;
  const position = sku.qtyonhand + onOrder;
  const rop = sku.reorderpoint;
  const safety = Math.min(sku.safetystock, rop);
  const leadDemand = Math.max(0, rop - safety);
  const days = Number(sku.leadtimedays) || 0;
  const reorder = position <= rop;

  const positionBlock = block(
    "Inventory position",
    line("", "On hand", n(sku.qtyonhand)) +
      line("+", "On order", n(onOrder), { hint: "ordered, not yet delivered" }) +
      line("=", "Inventory position", n(position), { total: true }),
  );
  const ropBlock = block(
    "Reorder point",
    line("", "Lead-time demand", n(leadDemand), {
      hint: days ? `about ${n(sku.avgdailydemand)} a day × ${n(days)} ${days === 1 ? "day" : "days"} lead time` : "",
    }) +
      line("+", "Safety stock", n(safety), { hint: "buffer for busy days and late deliveries" }) +
      line("=", "Reorder point", n(rop), { total: true }),
  );
  // Above its own reorder point it can still join tonight's order as a UC1 companion: when a partner
  // reaches its reorder point and this one is at or below its can-order level (reorder point + 100% of
  // safety stock for a Strong rule, 50% for Moderate).
  const partner = reorder ? null : companionChance(sku, position);
  const check = `
    <div class="calc-check ${reorder ? "is-reorder" : partner ? "is-maybe" : "is-ok"}">
      <span>${n(position)} ${reorder ? "≤" : ">"} ${n(rop)}</span>
      <b>${reorder ? "Reorder at tonight's check" : partner ? "No order of its own" : "No order needed"}</b>
    </div>
    ${partner ? `<p class="calc-note">May join tonight's order with ${escapeHtml(partner.name)} (${escapeHtml(partner.strength)} pair): it is at or below its can-order level of ${n(partner.level)}.</p>` : ""}`;
  if (!(sku.recommendedorderqty > 0)) return `${positionBlock}${ropBlock}${check}${levelsNote(sku)}`;

  const plural = (count) => (count === 1 ? "carton" : "cartons");
  // The reorder check's carton rule: nearest whole carton to the gap, but never fewer than it takes to
  // lift the position above the reorder point, and at least one.
  const pack = sku.unitspercarton || 1;
  const nearest = Math.round(sku.recommendedorderqty / pack);
  const toClear = Math.ceil((rop - position + 1) / pack);
  const roundHint =
    sku.orderunits === sku.recommendedorderqty
      ? `full cartons of ${n(pack)}`
      : toClear > nearest
        ? `enough cartons of ${n(pack)} to lift stock above the reorder point`
        : `nearest whole carton of ${n(pack)}`;
  const orderBlock = block(
    "Tonight's order",
    line("", "Order-up-to level", n(sku.orderuptolevel)) +
      line("−", "Inventory position", n(position)) +
      line("=", "Net requirement", n(sku.recommendedorderqty), { total: true }) +
      line("", "Order", `${n(sku.ordercartons)} ${plural(sku.ordercartons)} × ${n(sku.unitspercarton)} = ${n(sku.orderunits)}`, {
        total: true,
        hint: roundHint,
      }),
  );
  return `${positionBlock}${ropBlock}${check}${orderBlock}${levelsNote(sku)}`;
}

const CAN_ORDER_SHARE = { Strong: 1, Moderate: 0.5 }; // of the safety stock above the reorder point (scripts/live/day.py)

/**
 * A UC1 partner at or below its own reorder point tonight, while this product is at or below its
 * can-order level: then the reorder check may add this product to the partner's order. "May": the
 * check only adds it when the rule runs from the partner to this product.
 */
function companionChance(sku, position) {
  if (!(sku.orderuptolevel > position)) return null;
  const partners = (sku.companions || [])
    .filter((pair) => CAN_ORDER_SHARE[pair.strength] && pair.sku)
    .filter((pair) => (pair.sku.qtyonhand || 0) + (pair.sku.intransit || 0) <= pair.sku.reorderpoint)
    .map((pair) => ({
      name: pair.sku.productname,
      strength: pair.strength,
      level: Math.round(sku.reorderpoint + CAN_ORDER_SHARE[pair.strength] * sku.safetystock),
    }))
    .filter((pair) => position <= pair.level);
  return partners.find((pair) => pair.strength === "Strong") || partners[0] || null;
}

/** For a restock not ordered yet: when it would arrive, from tonight's check plus the usual delivery time. */
export function arrivalEstimate(sku) {
  const daily = dailyFor(sku);
  const times = deliveryTimes(daily);
  const lead = Math.round(times ? times.avg : sku.leadtimedays);
  if (!daily || !(lead > 0)) return `Usually arrives ${deliveryText(sku, daily).replace(/^about /, "in about ").replace(/ \(.*\)$/, "")}.`;
  const today = daily.source.dayDate(daily.source.HISTORY_DAYS - 1);
  const eta = new Date(today.getTime() + (1 + lead) * 86400000);
  return `Expected around ${day(eta)}.`;
}

/**
 * Why past orders can look much bigger than today's: they were placed on the starting levels (the
 * same at every subsidiary). Shown only when the starting levels differ from today's.
 */
export function levelsNote(sku) {
  const daily = dailyFor(sku);
  const start = daily?.starting;
  const until = daily?.source.startingUntil;
  if (!start || !until) return "";
  const startRop = Number(start.reorderpoint) || 0;
  const startOul = Number(start.orderuptolevel) || 0;
  if (startRop === sku.reorderpoint && startOul === sku.orderuptolevel) return "";
  const fromDay = day(new Date(Date.parse(`${until}T00:00:00`) + 86400000));
  return `<p class="calc-levels">Before ${escapeHtml(fromDay)} (starting levels): reorder point <b>${n(startRop)}</b>, order-up-to level <b>${n(startOul)}</b>.</p>`;
}

/** What happened to this product lately: restocks ordered and delivered, and any day it ran out. */
function historyCard(sku) {
  const source = historySource();
  const history = source.getSkuHistory(sku.productid);
  const events = history?.events?.slice(0, 6) || [];
  if (!events.length) return "";
  return `
    <section class="drawer-section">
      <h3>Recent activity</h3>
      <div class="drawer-events">${events
        .map(
          (event) => `
        <div class="feed-item ev-${event.type}">
          <i class="feed-mark" aria-hidden="true">${{ stockout: "!", order: "+", short: "!", hold: "!", delivered: "✓" }[event.type]}</i>
          <span class="feed-text"><b>${escapeHtml(event.title)}</b>${event.detail ? `<small>${escapeHtml(event.detail)}</small>` : ""}</span>
          <time class="feed-time">${escapeHtml(day(event.at))}</time>
        </div>`,
        )
        .join("")}</div>
    </section>`;
}

/** The Auto-orders tab with this order open, for the subsidiary on screen. */
function orderHref(orderid) {
  const warehouse = parseRoute().params.get("warehouse") || WAREHOUSE.subsidiary;
  return `#/uc2?warehouse=${encodeURIComponent(warehouse)}&tab=orders&order=${encodeURIComponent(orderid)}`;
}

function companionsCard(sku) {
  const list = companionsOf(sku);
  if (!list.length) return "";
  const restock = needsRestock(sku);
  return `
    <section class="drawer-section co-card">
      <h3>Often used with this <span class="ord-count">${list.length}</span></h3>
      <ul class="co-list">
        ${list
          .map((c) => {
            // "Worth adding" only means something when this product is being restocked; being on the
            // same order is worth saying either way.
            const shared = sharedOrder(sku, c);
            const advice = restock || shared?.open ? companionAdvice(c, sku) : null;
            const other = c.sku;
            const stock = `${n(other.qtyonhand)} on hand${other.intransit ? ` + ${n(other.intransit)} on its way` : ""} · reorder point ${n(other.reorderpoint)}`;
            // Outside the row's button (a link can't sit inside a button), with a link to that order.
            const together = shared
              ? `<div class="co-together-row">
                  <span class="co-together">${LINK_ICON}${
                    shared.open
                      ? `Coming on the same delivery${shared.order.expectedat ? `, ${escapeHtml(day(shared.order.expectedat))}` : ""}`
                      : `Delivered together on ${escapeHtml(day(shared.order.deliveredat))}`
                  }</span>
                  <a class="co-view" href="${escapeAttribute(orderHref(shared.order.orderid))}" data-view-order
                    title="${escapeAttribute(`Open order ${shared.order.orderid}`)}">View order →</a>
                </div>`
              : "";
            return `
          <li>
            <button type="button" class="co-row" data-open-companion="${escapeAttribute(c.productid)}" aria-label="Show details for ${escapeAttribute(other.productname)}">
              <span class="co-main">
                <span class="co-name">${escapeHtml(other.productname)} <em>${escapeHtml(c.productid)}</em></span>
                <span class="co-stock">${statusPill(statusText(other))}<span>${escapeHtml(stock)}</span></span>
              </span>
              <span class="co-side">
                ${advice ? `<span class="co-advice" data-tone="${advice.tone}">${escapeHtml(advice.label)}</span>` : ""}
                <span class="co-strength" title="${escapeAttribute(togetherHint(c))}">${escapeHtml(togetherLabel(c.strength))}</span>
              </span>
            </button>
            ${together}
          </li>`;
          })
          .join("")}
      </ul>
      <p class="drawer-foot">${
        restock
          ? "Items marked <b>Worth adding</b> are running low too, so they could go on the same delivery. Your call."
          : "No restock needed right now."
      }</p>
    </section>`;
}

const TREND_DAYS = 30;

/**
 * Where the panel's daily chart comes from: the subsidiary's full history if loaded, else this
 * product's own read (instant when hovered or opened before). `loading`: a live product still waiting.
 */
function stockState(sku) {
  if (historySource().live) return { source: historySource() };
  const own = peekSkuHistory(sku);
  if (own?.ok) return { source: own.source };
  return { source: historySource(), loading: Boolean(sku.asof) && !own };
}

/**
 * Stock over the last 30 days from the daily history: the stock each day against the reorder
 * point, with restocks ordered and delivered and any empty-shelf days. While it loads, a placeholder
 * of the same size; if it can't be read (or on sample data), the last few stock movements.
 */
function stockSection(sku, { source = historySource(), loading = false } = {}) {
  if (loading) {
    return `
      <section class="drawer-section" aria-busy="true">
        <h3>Stock over the last ${TREND_DAYS} days</h3>
        <div class="st-loading" role="status">
          <span class="st-loading-facts"><i></i><i></i><i></i></span>
          <span class="st-loading-chart"></span>
          <span class="st-loading-text">Loading daily stock...</span>
        </div>
      </section>`;
  }
  const daily = source.live ? source.getSkuHistory(sku.productid) : null;
  if (daily?.stock?.length) {
    const days = Math.min(TREND_DAYS, daily.stock.length);
    const offset = daily.stock.length - days;
    const shift = (list) => list.map((item) => ({ ...item, day: item.day - offset })).filter((item) => item.day >= 0);
    const input = {
      stock: daily.stock.slice(offset),
      dates: Array.from({ length: days }, (_, index) => source.dayDate(source.HISTORY_DAYS - days + index)),
      rop: daily.rop?.length === daily.stock.length ? daily.rop.slice(offset) : sku.reorderpoint,
      ordered: shift(daily.ordered || []),
      deliveries: shift(daily.deliveries || []),
      onWay: (daily.onWay || []).slice(offset),
      kind: statusKind(sku),
      use: sku.avgdailydemand,
    };
    return `
      <section class="drawer-section">
        <h3>Stock over the last ${days} days</h3>
        ${trendFacts(input)}
        ${renderStockTrend(input)}
        <p class="st-readout" data-st-readout aria-live="polite"></p>
        <p class="drawer-foot chart-key st-key">
          <span><i class="k-line"></i>On the shelf</span>
          <span><i class="k-rop"></i>Reorder point</span>
          <span><i class="k-delivered" aria-hidden="true"></i>Delivery</span>
          <span><i class="k-empty" aria-hidden="true"></i>Empty shelf</span>
        </p>
      </section>`;
  }
  // With no movement there is no real event time to show (the date there is only the window start).
  const latest = sku.lasteventtype.startsWith("No movement")
    ? `${sku.lasteventtype}.`
    : `Latest: ${sku.lasteventtype}, ${dayTime(sku.lasteventat)}.`;
  return `
    <section class="drawer-section">
      <h3>Stock over time</h3>
      ${renderStepChart({ history: sku.history, reorderPoint: sku.reorderpoint, kind: statusKind(sku) })}
      <p class="drawer-foot chart-key">
        <span><i class="k-line"></i>Stock on the shelf</span>
        <span><i class="k-rop"></i>Reorder point ${n(sku.reorderpoint)}</span>
        <span><i class="k-dot is-${statusKind(sku)}"></i>Latest</span>
      </p>
      <p class="drawer-foot">${escapeHtml(latest)}${sku.asof ? " The daily view couldn't be loaded; open the product again to retry." : ""}</p>
    </section>`;
}

function progressCard(sku) {
  const { order } = sku;
  if (!order) return "";
  // How much is coming, in units first (what stock and daily use are counted in), cartons beside it,
  // and how long it lasts at recent daily use: enough to tell if this delivery alone covers the gap.
  const units = Number(order.units) || 0;
  const cover = units && sku.avgdailydemand > 0 ? Math.round(units / sku.avgdailydemand) : null;
  const amount = units
    ? `
      <div class="rs-main"><b>${n(units)} units</b><span>${n(order.cartons)} ${order.cartons === 1 ? "carton" : "cartons"}</span></div>
      ${cover != null ? `<p class="drawer-foot">About ${cover < 1 ? "less than a day" : `${n(cover)} ${cover === 1 ? "day" : "days"}`} of stock at ~${n(Math.round(sku.avgdailydemand))} a day.</p>` : ""}`
    : "";
  // This restock isn't enough on its own: say a second one follows tonight (worked out under "How it's calculated").
  const next =
    sku.recommendedorderqty > 0
      ? `<p class="rs-next">Not enough on its own: <b>${n(sku.ordercartons)} more ${sku.ordercartons === 1 ? "carton" : "cartons"} (${n(sku.orderunits)} units)</b> will be ordered at tonight's check.</p>`
      : "";
  return `
    <section class="drawer-section">
      <h3>Restock progress <a class="po-link ord-count" href="${escapeAttribute(orderHref(order.orderid))}" data-view-order title="Open this restock">${escapeHtml(order.orderid)}</a></h3>
      ${amount}
      ${renderProgress({ ...order, companion: order.triggerid !== sku.productid })}
      ${next}
    </section>`;
}

/**
 * A section that starts closed and opens on click, so the panel shows the essentials first.
 * `single`: the body is one section whose own heading would only repeat the summary.
 * `split`: the body is two sections, shown side by side when there is room.
 */
function more(title, body, { single = false, split = false, open = false } = {}) {
  if (!body || !body.trim()) return "";
  return `
    <details class="drawer-more${single ? " is-single" : ""}${split ? " is-split" : ""}"${open ? " open" : ""}>
      <summary>${escapeHtml(title)}</summary>
      <div class="drawer-more-body">${body}</div>
    </details>`;
}

/** The one thing to know about restocking: the order on its way, or tonight's order, or nothing. */
function restockSummary(sku) {
  const { order } = sku;
  if (order && order.status !== "Fulfilled") return progressCard(sku);
  if (sku.recommendedorderqty > 0) {
    return `
      <section class="drawer-section rs-card">
        <h3>Tonight's restock</h3>
        <div class="rs-main"><b>${n(sku.ordercartons)} ${sku.ordercartons === 1 ? "carton" : "cartons"}</b><span>${n(sku.orderunits)} units</span></div>
        <p class="drawer-foot">${escapeHtml(arrivalEstimate(sku))}</p>
      </section>`;
  }
  // Nothing ordered and nothing due: say when the next restock is likely, so every product's panel
  // has the same shape (this card beside the chart).
  if (sku.avgdailydemand > 0) {
    const days = Math.round((sku.qtyonhand + (sku.intransit || 0) - sku.reorderpoint) / sku.avgdailydemand);
    const when = days < 1 ? "Within a day" : `In about ${days} ${days === 1 ? "day" : "days"}`;
    return `
      <section class="drawer-section rs-card">
        <h3>Next restock</h3>
        <div class="rs-main"><b>${escapeHtml(when)}</b></div>
        <p class="drawer-foot">Ordered automatically when stock reaches ${n(sku.reorderpoint)}.</p>
      </section>`;
  }
  return `
    <section class="drawer-section rs-card">
      <h3>Next restock</h3>
      <div class="rs-main"><b>Not needed</b></div>
      <p class="drawer-foot">This product hasn't been used lately.</p>
    </section>`;
}

function render(sku, back) {
  const companion = sku.order && sku.order.triggerid !== sku.productid;
  const summary = restockSummary(sku);
  const companionNote = companion
    ? `<div class="drawer-alert is-info"><span class="di-icon" aria-hidden="true">${LINK_ICON}</span><span>Sent with restock ${escapeHtml(sku.order.orderid)} for ${escapeHtml(sku.order.triggerid)}, because hospitals often use the two together. It hadn't run low itself.</span></div>`
    : "";
  return `
    <aside class="uc2-drawer" data-tone="${statusKind(sku)}" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <header class="drawer-head">
        <div>
          ${back ? `<button type="button" class="drawer-back" data-drawer-back>← ${escapeHtml(back.label)}</button>` : ""}
          <div class="drawer-kicker">${escapeHtml(sku.productid)}</div>
          <h2 id="drawer-title">${escapeHtml(sku.productname)}</h2>
          <div class="drawer-meta">${statusPill(statusText(sku))}${companion ? companionTag("Sent along") : ""}<span>${escapeHtml(explain(sku))}</span></div>
          ${companionNote}
        </div>
        <button type="button" class="drawer-close" data-drawer-close aria-label="Close details">×</button>
      </header>
      <div class="drawer-body">
        ${hero(sku)}
        <div class="drawer-cols${summary ? "" : " is-one"}">
          ${summary ? `<div class="drawer-col">${summary}</div>` : ""}
          <div class="drawer-col" data-stock-col>
            ${stockSection(sku, stockState(sku))}
          </div>
        </div>
        <div class="drawer-mores">
          ${more("How it's calculated", `<section class="drawer-section">${calculation(sku)}</section>`, { single: true })}
          ${more(`Often used with this (${companionsOf(sku).length})`, companionsCard(sku), { single: true, open: needsRestock(sku) && worthAdding(sku).length > 0 })}
          ${more("Recent activity", historyCard(sku), { single: true })}
        </div>
      </div>
    </aside>`;
}

/**
 * Mounts a right-hand drawer with the given markup. Esc, the backdrop and the close button dismiss it,
 * and focus returns to where it was. A [data-drawer-back] button closes it and runs `onBack`.
 */
export function mountDrawer(host, html, { onClose, onBack } = {}) {
  host.querySelector(".uc2-drawer-layer")?.remove();
  const previous = document.activeElement;
  const layer = document.createElement("div");
  layer.className = "uc2-drawer-layer";
  layer.innerHTML = html;
  host.appendChild(layer);

  const close = ({ restoreFocus = true } = {}) => {
    document.removeEventListener("keydown", onKey);
    layer.remove();
    onClose?.();
    if (restoreFocus && previous && typeof previous.focus === "function") previous.focus();
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };
  layer.addEventListener("click", (event) => {
    if (event.target.closest("[data-drawer-back]")) {
      close({ restoreFocus: false });
      onBack?.();
    } else if (event.target === layer || event.target.closest("[data-drawer-close]")) {
      close();
    }
  });
  document.addEventListener("keydown", onKey);
  layer.querySelector("[data-drawer-close]")?.focus();
  return { layer, close };
}

/** Opens the product panel. `back` ({ label, run }) adds a link back to where the user came from. */
/**
 * The chart reads out one day under it: today to start with, then whichever day is tapped or
 * pointed at. Nothing depends on hovering, so it works on a tablet too.
 */
function bindReadout(layer) {
  const readout = layer.querySelector("[data-st-readout]");
  const hits = [...layer.querySelectorAll(".st-hit")];
  if (!readout || !hits.length) return;
  const show = (hit) => {
    hits.forEach((item) => item.classList.toggle("is-on", item === hit));
    readout.textContent = hit.dataset.tip;
  };
  hits.forEach((hit) => {
    hit.addEventListener("pointerenter", () => show(hit));
    hit.addEventListener("click", () => show(hit));
  });
  show(hits[hits.length - 1]);
}

export function openSkuDetail(host, sku, { onClose, back } = {}) {
  const handle = mountDrawer(host, render(sku, back), { onClose, onBack: back?.run });
  bindTips(handle.layer);
  bindReadout(handle.layer);
  // Still loading this product's daily stock: draw the chart when it arrives, or the last few stock
  // movements if it can't be read.
  if (stockState(sku).loading) {
    loadSkuHistory(sku).then((loaded) => {
      const col = handle.layer.querySelector("[data-stock-col]");
      if (!handle.layer.isConnected || !col) return;
      col.innerHTML = stockSection(sku, loaded.ok ? { source: loaded.source } : {});
      bindReadout(handle.layer);
    });
  }
  // "View order" goes to the Auto-orders tab; close this panel first so its key handler goes with it.
  handle.layer.querySelectorAll("[data-view-order]").forEach((link) => {
    link.addEventListener("click", () => handle.close({ restoreFocus: false }));
  });
  // A companion opens its own panel, with a way back to this one.
  handle.layer.querySelectorAll("[data-open-companion]").forEach((button) => {
    button.addEventListener("click", () => {
      const companion = companionsOf(sku).find((c) => c.productid === button.dataset.openCompanion);
      if (!companion) return;
      handle.close({ restoreFocus: false });
      openSkuDetail(host, companion.sku, {
        back: { label: `Back to ${sku.productname}`, run: () => openSkuDetail(host, sku, { back }) },
      });
    });
  });
  return handle;
}
