import "./history.css";
import { parseRoute, setQuery } from "@app/router.js";
import { renderFilterBar } from "@shared/components/page-frame.js";
import { renderTable } from "@shared/components/table.js";
import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";
import { STATUS_META, bindTips, renderCalendar, renderSpark } from "./charts/history.js";
import { historySource } from "./history-source.js";

/** The history on screen: live for this subsidiary once loaded, else the sample. */
const src = () => historySource();

const PERIODS = [7, 30, 90];
const ROW_STEP = 10;
const FEED_STEP = 8;

const EVENT_FILTERS = [
  { id: "stockout", label: "Stock-outs" },
  { id: "all", label: "All" },
  { id: "order", label: "Restocks" },
  { id: "delivered", label: "Delivered" },
];
const EVENT_GROUP = { stockout: "stockout", order: "order", delivered: "delivered" };
const EVENT_MARK = { stockout: "!", order: "+", delivered: "✓" };

const n = (value) => Number(value).toLocaleString();
const param = (key) => parseRoute().params.get(key);
const period = () => (PERIODS.includes(Number(param("period"))) ? Number(param("period")) : 30);
/** The chosen feed filter, or "" when none was chosen (the feed then opens on stock-outs). */
const eventFilter = () => (EVENT_FILTERS.some((item) => item.id === param("event")) ? param("event") : "");
const currentView = () => (param("hview") === "table" ? "table" : "calendar");

/** How many rows / feed items are open. Reset when the query changes. */
let rowsShown = ROW_STEP;
let feedShown = FEED_STEP;
let lastSignature = "";

/* ------------------------------------------------------------------ */
/* Markup                                                              */
/* ------------------------------------------------------------------ */

export function renderHistoryTab(subsidiary) {
  const carried = `
    <input type="hidden" name="tab" value="history" />
    <input type="hidden" name="warehouse" value="${escapeAttribute(subsidiary)}" />
    <div class="uc2-view-toggle" role="group" aria-label="Period">
      ${PERIODS.map((days) => `<button type="button" data-period="${days}">${days} days</button>`).join("")}
    </div>
  `;
  return `
    ${renderFilterBar({ includeFeedback: false, extra: carried, searchPlaceholder: "Search product" })}
    <div class="hist-tiles" data-hist-tiles></div>
    <div class="hist-grid">
      <section class="panel hist-cal">
        <div class="hist-head">
          <div>
            <div class="l">Stock calendar</div>
            <div class="uc2-table-sub" data-cal-sub></div>
          </div>
          <div class="uc2-view-toggle" role="group" aria-label="Calendar or table">
            <button type="button" data-hview="calendar">Calendar</button>
            <button type="button" data-hview="table">Table</button>
          </div>
        </div>
        <div class="hist-legend" data-legend></div>
        <div data-cal-body></div>
        <div class="hist-more" data-cal-more></div>
      </section>
      <section class="panel hist-feed">
        <div class="hist-head">
          <div>
            <div class="l">Recent activity</div>
            <div class="uc2-table-sub">Newest first</div>
          </div>
        </div>
        <div class="uc2-chips hist-chips" data-feed-chips role="group" aria-label="Filter activity"></div>
        <div data-feed></div>
        <div class="hist-more" data-feed-more></div>
      </section>
    </div>`;
}

/** A stat tile: label, headline number, change vs the previous period, and a 12-point trend. */
function tile({ label, value, unit = "", sub = "", delta, tone, spark, sparkLabel }) {
  const arrow = delta?.dir > 0 ? "▲" : delta?.dir < 0 ? "▼" : "•";
  return `
    <div class="hist-tile">
      <span class="ht-label">${escapeHtml(label)}</span>
      <div class="ht-main">
        <div>
          <b class="ht-value">${escapeHtml(value)}${unit ? `<small>${escapeHtml(unit)}</small>` : ""}</b>
          ${sub ? `<span class="ht-sub">${escapeHtml(sub)}</span>` : ""}
        </div>
        ${renderSpark(spark, { label: sparkLabel })}
      </div>
      <span class="ht-delta is-${delta ? tone : "none"}">${delta ? `${arrow} ${escapeHtml(delta.text)}` : "no earlier period to compare"}</span>
    </div>`;
}

function deltaFor(current, previous, { good, unit, digits = 0, words = ["more", "fewer"] }) {
  if (previous == null || current == null) return null;
  const diff = Number((current - previous).toFixed(digits));
  const text =
    diff === 0
      ? "no change vs prior period"
      : `${Math.abs(diff).toLocaleString(undefined, { maximumFractionDigits: digits })}${unit} ${diff > 0 ? words[0] : words[1]} vs prior period`;
  const dir = Math.sign(diff);
  // colour follows direction × whether more is good; a neutral measure stays grey
  const tone = dir === 0 || good === "neutral" ? "neutral" : (dir > 0) === (good === "up") ? "good" : "bad";
  return { dir, text, tone };
}

function renderTiles(days) {
  const { current, previous } = src().periodMetrics(days);
  const orders = deltaFor(current.orders.value, previous?.orders.value, { good: "neutral", unit: "" });
  const stockouts = deltaFor(current.stockouts.value, previous?.stockouts.value, { good: "down", unit: "" });
  const delivery = deltaFor(current.delivery.value, previous?.delivery.value, { good: "down", unit: " days", digits: 1, words: ["longer", "shorter"] });
  // Live history: how many products ran out, how often, and how much of the time the shelves had stock.
  if (current.affected) {
    const affected = deltaFor(current.affected.value, previous?.affected.value, { good: "down", unit: "" });
    const available = deltaFor(current.availability.value, previous?.availability.value, { good: "up", unit: " pts", digits: 1, words: ["higher", "lower"] });
    const took = current.delivery.value == null
      ? ""
      : `<p class="hist-note">Restocks took ${current.delivery.value.toFixed(1)} days on average to arrive${current.delivery.planned == null ? "" : ` (planned ${current.delivery.planned.toFixed(1)})`}.</p>`;
    return [
      tile({ label: "Products that ran out", value: n(current.affected.value), unit: ` of ${n(current.affected.total)}`, sub: `in the last ${days} days`, delta: affected, tone: affected?.tone, spark: current.affected.series, sparkLabel: "Products that ran out per interval" }),
      tile({ label: "Stock-outs", value: n(current.stockouts.value), sub: "times a shelf was empty", delta: stockouts, tone: stockouts?.tone, spark: current.stockouts.series, sparkLabel: "Stock-outs per interval" }),
      tile({ label: "In stock", value: current.availability.value.toFixed(1), unit: "%", sub: "of the time, across all products", delta: available, tone: available?.tone, spark: current.availability.series, sparkLabel: "Share of the time in stock per interval" }),
      took,
    ].join("");
  }
  return [
    tile({ label: "Restocks ordered", value: n(current.orders.value), sub: `last ${days} days`, delta: orders, tone: orders?.tone, spark: current.orders.series, sparkLabel: "Restocks ordered per interval" }),
    tile({ label: "Stock-outs", value: n(current.stockouts.value), sub: "times a product ran out", delta: stockouts, tone: stockouts?.tone, spark: current.stockouts.series, sparkLabel: "Stock-outs per interval" }),
    tile({ label: "Lead time", value: current.delivery.value == null ? "—" : current.delivery.value.toFixed(1), unit: current.delivery.value == null ? "" : " days", sub: current.delivery.planned == null ? "" : `planned ${current.delivery.planned.toFixed(1)}`, delta: delivery, tone: delivery?.tone, spark: current.delivery.series, sparkLabel: "Average lead time per interval" }),
  ].join("");
}

/* ------------------------------------------------------------------ */
/* Calendar / table                                                    */
/* ------------------------------------------------------------------ */

function rowsFor(days, needle) {
  const lo = src().HISTORY_DAYS - days;
  return src().HISTORY.skus
    .filter((sku) => !needle || `${sku.productid} ${sku.name}`.toLowerCase().includes(needle))
    .map((sku) => {
      const statuses = sku.statuses.slice(lo);
      const count = (code) => statuses.filter((value) => value === code).length;
      const oos = count(3);
      const low = count(2);
      const near = count(1);
      const orders = src().HISTORY.episodes.filter((e) => e.productid === sku.productid && e.start >= lo).length;
      return { productid: sku.productid, name: sku.name, real: sku.real, statuses, oos, low, near, orders, riskDays: oos + low, score: oos * 3 + low * 2 + near };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** The calendar's rows for the current period and search, for the CSV export. */
export function historyExportRows(q) {
  const days = period();
  return { days, rows: rowsFor(days, (q.q || "").trim().toLowerCase()) };
}

function tableFor(rows) {
  const columns = [
    { key: "sku", label: "Product", html: true },
    { key: "oos", label: "Out of stock", align: "right", mono: true, hint: "Days out of stock in this period" },
    { key: "low", label: "Low stock", align: "right", mono: true, hint: "Days at or below its reorder point" },
    { key: "near", label: "Near ROP", align: "right", mono: true, hint: "Days just above its reorder point" },
    { key: "orders", label: "Restocks", align: "right", mono: true, hint: "Restocks ordered in this period" },
  ];
  return renderTable(null, {
    columns,
    rows: rows.map((row) => ({
      _key: row.productid,
      sku: `<span class="cell-main">${escapeHtml(row.name)}</span><span class="cell-sub mono">${escapeHtml(row.productid)}</span>`,
      oos: row.oos,
      low: row.low,
      near: row.near,
      orders: row.orders,
    })),
  });
}

/* ------------------------------------------------------------------ */
/* Feed                                                                */
/* ------------------------------------------------------------------ */

function dayHeading(iso) {
  const date = new Date(iso);
  const today = src().dayDate(src().HISTORY_DAYS - 1);
  const diff = Math.round((today - new Date(date.getFullYear(), date.getMonth(), date.getDate())) / 86400000);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}

function feedHtml(events, real) {
  let heading = "";
  return events
    .map((event) => {
      const group = dayHeading(event.at);
      const head = group === heading ? "" : `<h4 class="feed-day">${escapeHtml(group)}</h4>`;
      heading = group;
      const open = real.has(event.productid);
      return `${head}
        <div class="feed-item ev-${event.type}${open ? " is-linked" : ""}" ${open ? `role="button" tabindex="0" data-open-sku="${escapeAttribute(event.productid)}"` : ""}>
          <i class="feed-mark" aria-hidden="true">${EVENT_MARK[event.type]}</i>
          <span class="feed-text"><b>${escapeHtml(event.title)}</b>${event.detail ? `<small>${escapeHtml(event.detail)}</small>` : ""}</span>
          <time class="feed-time">${escapeHtml(new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }))}</time>
        </div>`;
    })
    .join("");
}

/* ------------------------------------------------------------------ */
/* Mount                                                               */
/* ------------------------------------------------------------------ */

export function mountHistory(root, q, skus, openSku) {
  const host = root.querySelector(".hist-grid");
  if (!host) return;
  const days = period();
  const view = currentView();
  const filter = eventFilter();
  const needle = (q.q || "").trim().toLowerCase();
  const signature = `${days}|${view}|${filter}|${needle}`;
  if (signature !== lastSignature) {
    rowsShown = ROW_STEP;
    feedShown = FEED_STEP;
    lastSignature = signature;
  }
  const real = new Set(skus.map((sku) => sku.productid));
  const bySku = new Map(skus.map((sku) => [sku.productid, sku]));

  // toggles live in the URL, so links and back/forward keep them
  root.querySelectorAll("[data-period]").forEach((button) => {
    const active = Number(button.dataset.period) === days;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.addEventListener("click", () => setQuery({ period: button.dataset.period }));
  });
  root.querySelectorAll("[data-hview]").forEach((button) => {
    const active = button.dataset.hview === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
    button.addEventListener("click", () => setQuery({ hview: button.dataset.hview === "table" ? "table" : "" }));
  });

  root.querySelector("[data-hist-tiles]").innerHTML = renderTiles(days);

  /* ---- calendar or table ---- */
  const rows = rowsFor(days, needle);
  const bucket = days > 45 ? 3 : 1;
  const lo = src().HISTORY_DAYS - days;
  const dates = Array.from({ length: days }, (_, index) => src().dayDate(lo + index));
  root.querySelector("[data-cal-sub]").textContent = `Which products keep running low, most affected first${bucket > 1 ? ` · each column is ${bucket} days` : ""}`;
  root.querySelector("[data-legend]").innerHTML =
    STATUS_META.map((item) => `<span><i class="hc hc-${item.code}"></i>${escapeHtml(item.label)}</span>`).join("") +
    `<span class="hist-legend-note">Taller and brighter = needs attention</span>`;

  const calBody = root.querySelector("[data-cal-body]");
  const calMore = root.querySelector("[data-cal-more]");
  const shown = view === "table" ? rows : rows.slice(0, rowsShown);
  calBody.innerHTML = rows.length
    ? view === "table"
      ? `<div class="hist-table">${tableFor(shown)}</div>`
      : renderCalendar(shown, dates, bucket)
    : `<p class="board-empty">No products match “${escapeHtml(q.q)}”.</p>`;
  calMore.innerHTML =
    view === "calendar" && rows.length > shown.length
      ? `<span>Showing ${shown.length} of ${rows.length} products</span><button type="button" class="board-more" data-more-rows>Show ${Math.min(ROW_STEP, rows.length - shown.length)} more →</button>`
      : `<span>${rows.length} ${rows.length === 1 ? "product" : "products"}</span>`;
  calMore.querySelector("[data-more-rows]")?.addEventListener("click", () => {
    rowsShown += ROW_STEP;
    mountHistory(root, q, skus, openSku);
  });

  /* ---- feed ---- */
  const since = src().dayDate(lo).getTime();
  const inPeriod = src().HISTORY.events.filter((event) => {
    if (new Date(event.at).getTime() < since) return false;
    return !needle || `${event.productid} ${event.productname} ${event.orderid}`.toLowerCase().includes(needle);
  });
  const counts = Object.fromEntries(EVENT_FILTERS.map((item) => [item.id, 0]));
  inPeriod.forEach((event) => {
    counts.all += 1;
    counts[EVENT_GROUP[event.type]] += 1;
  });
  // Stock-outs are what needs attention; routine restocks are one click away.
  const chosen = filter || (counts.stockout ? "stockout" : "all");
  const events = chosen === "all" ? inPeriod : inPeriod.filter((event) => EVENT_GROUP[event.type] === chosen);
  const visible = events.slice(0, feedShown);
  root.querySelector("[data-feed-chips]").innerHTML = EVENT_FILTERS.map(
    (item) => `<button type="button" class="uc2-chip${item.id === chosen ? " is-active" : ""}" data-event="${item.id}" aria-pressed="${item.id === chosen}">${escapeHtml(item.label)} <b>${counts[item.id]}</b></button>`,
  ).join("");
  root.querySelectorAll("[data-event]").forEach((button) => {
    button.addEventListener("click", () => setQuery({ event: button.dataset.event }));
  });
  root.querySelector("[data-feed]").innerHTML = visible.length
    ? feedHtml(visible, real)
    : `<p class="board-empty">Nothing to show for this filter.</p>`;
  const feedMore = root.querySelector("[data-feed-more]");
  feedMore.innerHTML =
    events.length > visible.length
      ? `<span>Showing ${visible.length} of ${events.length}</span><button type="button" class="board-more" data-more-feed>Show ${Math.min(FEED_STEP, events.length - visible.length)} more →</button>`
      : `<span>${events.length} ${events.length === 1 ? "event" : "events"}</span>`;
  feedMore.querySelector("[data-more-feed]")?.addEventListener("click", () => {
    feedShown += FEED_STEP;
    mountHistory(root, q, skus, openSku);
  });

  /* ---- interactions ---- */
  bindTips(root.querySelector(".hist-cal"));
  const openBySku = (id) => {
    const sku = bySku.get(id);
    if (sku) openSku(sku);
  };
  root.querySelectorAll("[data-open-sku]").forEach((el) => {
    el.addEventListener("click", () => openBySku(el.dataset.openSku));
    el.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openBySku(el.dataset.openSku);
      }
    });
  });
  root.querySelectorAll(".hist-table tbody tr[data-key]").forEach((row) => {
    if (!real.has(row.dataset.key)) return;
    row.tabIndex = 0;
    row.style.cursor = "pointer";
    row.addEventListener("click", () => openBySku(row.dataset.key));
  });
}
