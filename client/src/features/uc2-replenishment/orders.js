import { renderTable, statusPill } from "@shared/components/table.js";
import { renderFilterBar } from "@shared/components/page-frame.js";
import { parseRoute, setQuery } from "@app/router.js";
import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";
import { mountDrawer, renderProgress } from "./detail.js";
import { SAMPLE_POLICY } from "./sample-data.js";
import { buildOrderHistory } from "./sample-orders.js";
import { REPLEN_STATES } from "./status.js";
import { LINK_ICON, companionCount, companionTag, triggerTag } from "./tags.js";
import { togetherHint } from "./companions.js";

const PAGE_SIZE = 10;
const LINE_PAGE_SIZE = 8;

const BOARD_LIMIT = 5;

/** The stages an order moves through. Central is assumed to have unlimited stock, so no order is held up. */
export const ORDER_FILTERS = Object.freeze(["Order placed", "On its way", "Delivered"]);
const GROUP_LABEL = Object.freeze({ placed: "Order placed", transit: "On its way", delivered: "Delivered" });
const GROUP_RANK = Object.freeze({ placed: 0, transit: 1, delivered: 2 });
const STAGES = Object.freeze(["placed", "transit", "delivered"]);
/** Color marks work in flight; finished orders stay quiet. */
const GROUP_EDGE = Object.freeze({ placed: "is-near", transit: "is-near", delivered: "" });

/** Board (default) or list. It lives in the URL (?view=list) so links, search and back/forward keep it. */
const currentView = () => (parseRoute().params.get("view") === "list" ? "list" : "board");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const n = (value) => Number(value).toLocaleString();
const plural = (count, word) => `${n(count)} ${word}${count === 1 ? "" : "s"}`;
const day = (iso) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayTime = (iso) => `${day(iso)}, ${time(iso)}`;

/* ------------------------------------------------------------------ */
/* Orders from the data                                                */
/* ------------------------------------------------------------------ */

function lineFromSku(sku, order) {
  const delivered = order.status === "Fulfilled";
  return {
    productid: sku.productid,
    productname: sku.productname,
    cartons: delivered ? order.cartons ?? 0 : sku.ordercartons,
    units: delivered ? order.units ?? 0 : sku.orderunits,
    role: sku.productid === order.triggerid ? "trigger" : "companion",
    companion: sku.companion ?? null,
    reason: delivered ? "Ran low" : sku.status,
  };
}

/**
 * Live orders (set by the page once the UC2 data has loaded). Null = use the analytical sample.
 * Shape: { orders: [order with lines], snapshotAt }.
 */
let live = null;
export function useLiveOrders(source) {
  live = source || null;
}

/** "3 companions" when the extra lines are UC1 companions, "3 more" when every line reached its own reorder point. */
function othersLabel(order) {
  const others = order.lines.length - 1;
  const companions = order.lines.filter((line) => line.role === "companion").length;
  return companions === others ? companionCount(others) : `${n(others)} more`;
}

/** One entry per automatic order, from the current SKU rows plus the sample history (or the live orders). */
function finalize(order, snapshotAt = SAMPLE_POLICY.snapshotAt) {
  const lines = [...order.lines].sort(
    (a, b) =>
      Number(b.role === "trigger") - Number(a.role === "trigger") ||
      Number(Boolean(b.pairedWith?.length)) - Number(Boolean(a.pairedWith?.length)) ||
      a.productid.localeCompare(b.productid),
  );
  const recent =
    order.status === "Fulfilled" && Date.parse(order.deliveredat) >= Date.parse(snapshotAt) - WEEK_MS;
  return {
    ...order,
    recent,
    lines,
    cartons: lines.reduce((sum, line) => sum + line.cartons, 0),
    units: lines.reduce((sum, line) => sum + line.units, 0),
    group: order.status === "Fulfilled" ? "delivered" : order.status === "In Transit" ? "transit" : "placed",
    state: REPLEN_STATES[order.status],
  };
}

export function buildOrders(skus) {
  if (live) return live.orders.map((order) => finalize(order, live.snapshotAt));
  const byId = new Map();
  skus.forEach((sku) => {
    if (!sku.order) return;
    const entry = byId.get(sku.order.orderid) ?? { ...sku.order, lines: [] };
    entry.lines.push(lineFromSku(sku, sku.order));
    byId.set(sku.order.orderid, entry);
  });
  return [...byId.values(), ...buildOrderHistory()].map(finalize);
}

/* ------------------------------------------------------------------ */
/* Board                                                               */
/* ------------------------------------------------------------------ */

function boardCard(order) {
  const trigger = order.lines.find((line) => line.productid === order.triggerid) ?? order.lines[0];
  const more = order.lines.length - 1;
  const when = order.status === "Fulfilled" ? `delivered ${day(order.deliveredat)}` : `arrives ${day(order.expectedat)}`;
  return `
    <button type="button" class="board-card" data-order="${escapeAttribute(order.orderid)}" aria-label="Show items in ${escapeAttribute(order.orderid)}">
      <span class="bc-top"><span class="mono">${escapeHtml(order.orderid)}</span><span class="bc-when">${escapeHtml(when)}</span></span>
      <span class="bc-what" title="${escapeAttribute(trigger.productname)}"><span class="bc-name">${escapeHtml(trigger.productname)}</span>${more > 0 ? `<em>+ ${othersLabel(order)}</em>` : ""}</span>
      <span class="bc-qty"><b>${plural(order.cartons, "carton")}</b><span>${plural(order.lines.length, "item")} · ${plural(order.units, "unit")}</span></span>
      ${order.pairs ? `<span class="bc-pair">${LINK_ICON}Includes items used together</span>` : ""}
    </button>`;
}

/** Delivered shows only the last 7 days here, matching the pipeline; older ones are one click away. */
function renderBoard(orders) {
  return STAGES.map((stage) => {
    const all = orders.filter((order) => order.group === stage);
    const list = (stage === "delivered" ? all.filter((order) => order.recent) : all).sort(
      (a, b) => Date.parse(b.deliveredat ?? b.placedat) - Date.parse(a.deliveredat ?? a.placedat),
    );
    const shown = list.slice(0, BOARD_LIMIT);
    const label = GROUP_LABEL[stage];
    const cartons = list.reduce((sum, order) => sum + order.cartons, 0);
    const sub = `${stage === "delivered" ? "last 7 days · " : ""}${plural(cartons, "carton")}`;
    const cards = shown.length ? shown.map(boardCard).join("") : `<p class="board-empty">Nothing here</p>`;
    const more =
      all.length > shown.length
        ? `<button type="button" class="board-more" data-board-more="${escapeAttribute(label)}">View all ${n(all.length)} →</button>`
        : "";
    return `
      <section class="board-col is-${stage}" aria-label="${escapeAttribute(label)}">
        <header>
          <i class="ord-dot is-${stage}" aria-hidden="true"></i>
          <div class="board-title"><h3>${escapeHtml(label)}</h3><span class="board-sub">${escapeHtml(sub)}</span></div>
          <span class="board-count">${n(list.length)}</span>
        </header>
        <div class="board-cards">${cards}</div>
        ${more}
      </section>`;
  }).join("");
}

/* ------------------------------------------------------------------ */
/* Pager                                                               */
/* ------------------------------------------------------------------ */

function pageItems(current, count) {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index + 1);
  if (current <= 4) return [1, 2, 3, 4, "…", count];
  if (current >= count - 3) return [1, "…", count - 3, count - 2, count - 1, count];
  return [1, "…", current - 1, current, current + 1, "…", count];
}

/** Uses the shared pagination styles (.uc1-table-pagination) that the UC1 table already has. */
function renderPager(page, count, label) {
  if (count <= 1) return "";
  const button = (target, text, extra = "", disabled = false, aria = "") =>
    `<button type="button" class="uc1-page-button${extra}" data-page="${target}"${aria}${disabled ? " disabled" : ""}>${text}</button>`;
  return `<nav class="uc1-table-pagination" aria-label="${escapeAttribute(label)}">
    ${button(page - 1, "&lsaquo;", " uc1-page-arrow", page === 1, ' aria-label="Previous page"')}
    ${pageItems(page, count)
      .map((item) =>
        item === "…"
          ? '<span class="uc1-page-ellipsis" aria-hidden="true">...</span>'
          : button(item, item, item === page ? " is-current" : "", false, item === page ? ' aria-current="page"' : ""),
      )
      .join("")}
    ${button(page + 1, "&rsaquo;", " uc1-page-arrow", page === count, ' aria-label="Next page"')}
  </nav>`;
}

/* ------------------------------------------------------------------ */
/* Orders table                                                        */
/* ------------------------------------------------------------------ */

const COLUMNS = [
  { key: "order", label: "Restock", html: true, sort: true },
  { key: "status", label: "Status", html: true, sort: true },
  { key: "raised", label: "Ordered", html: true, sort: true },
  { key: "eta", label: "Arrives", html: true, sort: true, hint: "Expected arrival, or the delivery date once delivered." },
  { key: "lines", label: "Items", align: "right", mono: true, sort: true },
  { key: "cartons", label: "Cartons", align: "right", mono: true, sort: true, hint: "Whole cartons: the units needed, rounded up to full cartons." },
  { key: "units", label: "Units", align: "right", mono: true, sort: true },
];

/** Default: in progress first, then delivered; newest first within each. */
const sort = { key: "priority", dir: "asc" };
let page = 1;
let lastSignature = "";
/** The restock last opened (from a notification, a product's "View order", or a click): stays marked. */
let highlighted = "";

const SORT_VALUE = {
  priority: (o) => GROUP_RANK[o.group] * 1e14 - Date.parse(o.placedat),
  order: (o) => o.orderid,
  status: (o) => GROUP_RANK[o.group],
  raised: (o) => Date.parse(o.placedat),
  eta: (o) => Date.parse(o.deliveredat ?? o.expectedat ?? o.placedat),
  lines: (o) => o.lines.length,
  cartons: (o) => o.cartons,
  units: (o) => o.units,
};

function sorted(orders) {
  const value = SORT_VALUE[sort.key] || SORT_VALUE.priority;
  const direction = sort.dir === "desc" ? -1 : 1;
  return [...orders].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    const order = typeof left === "string" ? left.localeCompare(right) : left - right;
    return order * direction || a.orderid.localeCompare(b.orderid);
  });
}

function matchesSearch(order, q) {
  if (!q.q) return true;
  const needle = q.q.toLowerCase();
  return (
    order.orderid.toLowerCase().includes(needle) ||
    order.lines.some((line) => `${line.productid} ${line.productname}`.toLowerCase().includes(needle))
  );
}

function toRow(order) {
  const delivered = order.status === "Fulfilled";
  const arrival = delivered
    ? `<span class="cell-main">${day(order.deliveredat)}</span><span class="cell-sub">delivered</span>`
    : `<span class="cell-main">${day(order.expectedat)}</span><span class="cell-sub">expected</span>`;
  return {
    _key: order.orderid,
    _class: GROUP_EDGE[order.group],
    order: `<span class="cell-main mono">${escapeHtml(order.orderid)}</span><span class="cell-sub">triggered by ${escapeHtml(order.triggerid)}${order.lines.length > 1 ? ` + ${othersLabel(order)}` : ""}</span>`,
    status: statusPill(order.state.label),
    raised: `<span class="cell-main">${day(order.placedat)}</span><span class="cell-sub">${time(order.placedat)}</span>`,
    eta: arrival,
    lines: n(order.lines.length),
    cartons: n(order.cartons),
    units: n(order.units),
  };
}

export function renderOrdersTab(subsidiary, q) {
  const status = ORDER_FILTERS.includes(q.status) ? q.status : "";
  const carried = `
    <input type="hidden" name="tab" value="orders" />
    <input type="hidden" name="warehouse" value="${escapeAttribute(subsidiary)}" />
    <input type="hidden" name="status" value="${escapeAttribute(status)}" />
    <div class="uc2-view-toggle" role="group" aria-label="View">
      <button type="button" data-view="board">Board</button>
      <button type="button" data-view="list">List</button>
    </div>
    <div class="uc2-chips ord-list-only" data-order-chips role="group" aria-label="Filter orders"></div>
  `;
  return `
    ${renderFilterBar({ includeFeedback: false, extra: carried, searchPlaceholder: "Search restock or product" })}
    <div class="ord-board ord-board-only" data-orders-board></div>
    <div class="panel uc2-sku-panel uc2-orders-panel ord-list-only">
      <div class="uc2-table-head">
        <div>
          <div class="l">Restocks</div>
          <div class="uc2-table-sub">Ordered automatically when stock runs low. Select one to see its items.</div>
        </div>
        <span class="uc2-table-count" data-order-count></span>
      </div>
      <div data-order-table></div>
      <div data-order-pager></div>
    </div>`;
}

export function mountOrders(root, q, skus, openSku) {
  const table = root.querySelector("[data-order-table]");
  const pager = root.querySelector("[data-order-pager]");
  const count = root.querySelector("[data-order-count]");
  const chips = root.querySelector("[data-order-chips]");
  if (!table) return;

  const status = ORDER_FILTERS.includes(q.status) ? q.status : "";
  const signature = `${q.q}|${status}`;
  if (signature !== lastSignature) {
    page = 1;
    lastSignature = signature;
  }

  const all = buildOrders(skus);
  const searched = all.filter((order) => matchesSearch(order, q));
  const filtered = searched.filter((order) => !status || GROUP_LABEL[order.group] === status);
  const host = root.querySelector(".uc2-page");
  const view = currentView();
  host.dataset.ordersView = view;

  const skuById = new Map(skus.map((sku) => [sku.productid, sku]));
  // Marks the last-opened restock on the board and in the list, so it is easy to find again.
  const markHighlighted = () => {
    root.querySelectorAll("[data-order], [data-order-table] tr[data-key]").forEach((el) => {
      el.classList.toggle("is-linked", Boolean(highlighted) && (el.dataset.order || el.dataset.key) === highlighted);
    });
  };
  const openOrder = (order) => {
    highlighted = order.orderid;
    markHighlighted();
    const handle = openOrderDetail(host, order, (line) => {
      const sku = skuById.get(line.productid);
      if (!sku) return;
      handle.close({ restoreFocus: false });
      openSku(sku, { label: `Back to ${order.orderid}`, run: () => openOrder(order) });
    });
  };

  // `?order=PO-...` (a restock notification, or "View order" on a product) opens that restock and
  // marks it. The parameter is dropped straight away, so closing or refreshing doesn't reopen it.
  const { path, params } = parseRoute();
  const linked = params.get("order");
  if (linked) {
    params.delete("order");
    const query = params.toString();
    history.replaceState(null, "", `#${path}${query ? `?${query}` : ""}`);
    const order = all.find((item) => item.orderid === linked);
    if (order) {
      // after the board and list below have been drawn, so the mark and the scroll have something to hit
      queueMicrotask(() => {
        openOrder(order);
        root.querySelector(`[data-order="${CSS.escape(order.orderid)}"]`)?.scrollIntoView({ block: "center" });
      });
    }
  } else {
    queueMicrotask(markHighlighted);
  }

  const draw = () => {
    const rows = sorted(filtered);
    const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    page = Math.min(Math.max(page, 1), pageCount);
    const start = (page - 1) * PAGE_SIZE;
    const visible = rows.slice(start, start + PAGE_SIZE);

    table.innerHTML = renderTable(null, { columns: COLUMNS, rows: visible.map(toRow), sort });
    pager.innerHTML = renderPager(page, pageCount, "Order pages");
    if (count) {
      count.textContent = rows.length
        ? `${start + 1}–${start + visible.length} of ${n(rows.length)} orders`
        : "0 orders";
    }

    table.querySelectorAll("th.sortable").forEach((th) => {
      th.querySelector("button").addEventListener("click", () => {
        const key = th.dataset.sort;
        sort.dir = sort.key === key && sort.dir === "asc" ? "desc" : "asc";
        sort.key = key;
        page = 1;
        draw();
      });
    });
    pager.querySelectorAll("[data-page]").forEach((button) => {
      button.addEventListener("click", () => {
        page = Number(button.dataset.page);
        draw();
      });
    });
    const byId = new Map(filtered.map((order) => [order.orderid, order]));
    table.querySelectorAll("tbody tr[data-key]").forEach((row) => {
      const order = byId.get(row.dataset.key);
      if (!order) return;
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Show items in ${order.orderid}`);
      const open = () => openOrder(order);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  };
  draw();

  const board = root.querySelector("[data-orders-board]");
  if (board) {
    board.innerHTML = renderBoard(searched);
    const byId = new Map(all.map((order) => [order.orderid, order]));
    board.querySelectorAll("[data-order]").forEach((card) => {
      card.addEventListener("click", () => openOrder(byId.get(card.dataset.order)));
    });
    board.querySelectorAll("[data-board-more]").forEach((button) => {
      button.addEventListener("click", () => {
        setQuery({ status: button.dataset.boardMore, view: "list" });
      });
    });
  }

  const syncToggle = () => {
    root.querySelectorAll(".uc2-view-toggle [data-view]").forEach((button) => {
      const active = button.dataset.view === view;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  };
  root.querySelectorAll(".uc2-view-toggle [data-view]").forEach((button) => {
    button.addEventListener("click", () => setQuery({ view: button.dataset.view }));
  });
  syncToggle();

  if (chips) {
    const counts = Object.fromEntries(ORDER_FILTERS.map((label) => [label, 0]));
    searched.forEach((order) => {
      counts[GROUP_LABEL[order.group]] += 1;
    });
    const dots = { "Order placed": "is-near", "On its way": "is-near", Delivered: "is-ok" };
    const chip = (label, total, dot, active, value) => `
      <button type="button" class="uc2-chip${active ? " is-active" : ""}" data-order-filter="${escapeAttribute(value)}" aria-pressed="${active}">
        ${dot}${escapeHtml(label)} <b>${total}</b>
      </button>`;
    chips.innerHTML =
      chip("All", searched.length, "", !status, "") +
      ORDER_FILTERS.map((label) =>
        chip(
          label,
          counts[label],
          `<i class="chip-dot ${dots[label]}"></i>`,
          status === label,
          label,
        ),
      ).join("");
    chips.querySelectorAll("[data-order-filter]").forEach((button) => {
      button.addEventListener("click", () => setQuery({ status: button.dataset.orderFilter }));
    });
  }
}

/* ------------------------------------------------------------------ */
/* Order panel                                                         */
/* ------------------------------------------------------------------ */

const TONE = Object.freeze({ placed: "progress", transit: "progress", delivered: "delivered" });

function lineRow(line, order, maxCartons) {
  const trigger = line.role === "trigger";
  const tag = trigger ? triggerTag() : companionTag(line.companion ? `Companion · ${line.companion.strength}` : "Companion");
  const why = trigger || line.reason?.startsWith("Ordered with")
    ? `${line.productid} · ${line.reason}${!trigger && line.companion ? ` · lift ${line.companion.lift}` : ""}`
    : `${line.productid} · with ${order.triggerid}${line.companion ? ` · lift ${line.companion.lift}` : ""}`;
  // UC1 companions that are also on this order (each was still ordered for its own reorder point).
  const paired = line.pairedWith?.length
    ? `<div class="ol-pair" title="${escapeAttribute(line.pairedWith.map((p) => `${p.productname}: ${togetherHint(p)}`).join(" "))}">${companionTag(
        "Used together",
      )}<span>with ${escapeHtml(line.pairedWith.map((p) => p.productname).join(" and "))}</span></div>`
    : "";
  return `
    <div class="ol-row${paired ? " is-paired" : ""}" role="button" tabindex="0" data-line="${escapeAttribute(line.productid)}" aria-label="Show details for ${escapeAttribute(line.productname)}">
      <div class="ol-line1"><span class="ol-title"><span class="ol-name">${escapeHtml(line.productname)}</span>${tag}</span><span class="ol-qty">${plural(line.cartons, "carton")}</span></div>
      <div class="ol-line2"><span class="ol-sub">${escapeHtml(why)}</span><span class="ol-units">${plural(line.units, "unit")}</span></div>
      ${paired}
      <div class="ol-bar" aria-hidden="true"><span style="width:${Math.max(4, (line.cartons / maxCartons) * 100)}%"></span></div>
    </div>`;
}

function openOrderDetail(host, order, openLine) {
  const arrival =
    order.status === "Fulfilled" ? `Delivered <b>${day(order.deliveredat)}</b>` : `Arrives <b>${day(order.expectedat)}</b>`;
  const maxCartons = Math.max(...order.lines.map((line) => line.cartons), 1);
  const html = `
    <aside class="uc2-drawer" data-tone="${TONE[order.group]}" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
      <header class="drawer-head">
        <div>
          <div class="drawer-kicker">Restock</div>
          <h2 id="drawer-title" class="mono-title">${escapeHtml(order.orderid)}</h2>
          <div class="drawer-meta">
            ${statusPill(order.state.label)}
            <span>Ordered <b>${escapeHtml(dayTime(order.placedat))}</b></span>
            <span>${arrival}</span>
            ${order.lines.length > 1
              ? order.lines.every((line) => line.role === "trigger")
                ? `<span><b>${n(order.lines.length)} items</b> running low</span>`
                : `<span><b>1 ran low</b> + <b>${n(order.lines.length - 1)}</b> sent along</span>`
              : ""}
            ${order.pairs ? `<span>${companionTag("Includes items used together")}</span>` : ""}
          </div>
        </div>
        <button type="button" class="drawer-close" data-drawer-close aria-label="Close details">×</button>
      </header>
      <div class="drawer-body">
        <div class="drawer-cols">
          <section class="drawer-section drawer-hero">
            <div class="hero-nums">
              <div><b>${n(order.cartons)}</b><span>cartons</span></div>
              <div><b>${n(order.units)}</b><span>units</span></div>
              <div><b>${n(order.lines.length)}</b><span>${order.lines.length === 1 ? "item" : "items"}</span></div>
            </div>
          </section>
          <section class="drawer-section">
            <h3>Progress</h3>
            ${renderProgress({ ...order, companion: false })}
          </section>
        </div>
        <section class="drawer-section">
          <h3>Items in this restock <span class="ord-count">${n(order.lines.length)}</span></h3>
          ${order.pairs
            ? `<p class="drawer-foot ol-note">Each item was ordered because its stock ran low. <span class="ol-note-icon">${LINK_ICON}</span> Used together: hospitals often use these together, so they ran low at the same time.</p>`
            : ""}
          ${
            order.lines.length > LINE_PAGE_SIZE
              ? `<input class="input ol-search" type="search" placeholder="Search these items" aria-label="Search items in this restock" data-line-search />`
              : ""
          }
          <div class="ol-list" data-lines></div>
          <div data-lines-pager></div>
        </section>
      </div>
    </aside>`;

  const handle = mountDrawer(host, html);
  const layer = handle.layer;
  const list = layer.querySelector("[data-lines]");
  const pager = layer.querySelector("[data-lines-pager]");
  const search = layer.querySelector("[data-line-search]");
  const byId = new Map(order.lines.map((line) => [line.productid, line]));
  let linePage = 1;

  const draw = () => {
    const needle = (search?.value ?? "").trim().toLowerCase();
    const rows = order.lines.filter((line) => !needle || `${line.productid} ${line.productname}`.toLowerCase().includes(needle));
    const pageCount = Math.max(1, Math.ceil(rows.length / LINE_PAGE_SIZE));
    linePage = Math.min(Math.max(linePage, 1), pageCount);
    const start = (linePage - 1) * LINE_PAGE_SIZE;
    list.innerHTML = rows.length
      ? rows.slice(start, start + LINE_PAGE_SIZE).map((line) => lineRow(line, order, maxCartons)).join("")
      : `<p class="drawer-foot">No lines match.</p>`;
    pager.innerHTML = renderPager(linePage, pageCount, "Line pages");
    pager.querySelectorAll("[data-page]").forEach((button) => {
      button.addEventListener("click", () => {
        linePage = Number(button.dataset.page);
        draw();
      });
    });
    list.querySelectorAll("[data-line]").forEach((row) => {
      const open = () => openLine(byId.get(row.dataset.line));
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  };
  search?.addEventListener("input", () => {
    linePage = 1;
    draw();
  });
  draw();
  return handle;
}
