import { fetchWarehouses } from "@shared/data/engine-outputs.js";
import { pageQuery, parseRoute, setQuery } from "@app/router.js";
import { WAREHOUSE } from "@shared/data/tables.js";
import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";
import { renderTable, statusPill } from "@shared/components/table.js";
import {
  bindFilterBar,
  bindTabs,
  renderFeedback,
  renderFilterBar,
  renderPageHead,
  renderTabs,
} from "@shared/components/page-frame.js";
import { renderPipeline, renderRunway } from "./charts/flow.js";
import { openSkuDetail } from "./detail.js";
import { historyExportRows, mountHistory, renderHistoryTab } from "./history.js";
import { loadLiveHistory, loadSkuHistory, peekLiveHistory } from "./history-data.js";
import { historySource, useHistorySource } from "./history-source.js";
import { buildOrders, mountOrders, renderOrdersTab, useLiveOrders } from "./orders.js";
import { loadLiveUc2, peekLiveUc2 } from "./live-data.js";
import { exportHistory, exportOrders, exportStock } from "./export.js";
import { companionTag } from "./tags.js";
import { companionsOf, needsRestock, worthAdding } from "./companions.js";
import { renderBulletBar } from "./charts/rop.js";
import { SAMPLE_POLICY, SAMPLE_SKUS } from "./sample-data.js";
import {
  KIND_LABEL,
  KIND_ORDER,
  STATUS_HINT,
  STATUS_RANK,
  kindText,
  replenState,
  statusKind,
  statusLabel,
  statusText,
} from "./status.js";

const TABS = [
  { id: "skus", label: "Stock status" },
  { id: "orders", label: "Restocks" },
  { id: "history", label: "History" },
];

const SKU_COLUMNS = [
  { key: "product", label: "Product", html: true, sort: true },
  {
    key: "status",
    label: "Status",
    html: true,
    sort: true,
    hint: "Out of stock: none on the shelf. Low stock: at or below its reorder point, so a restock is ordered. Near ROP: just above it. In stock: plenty on the shelf.",
  },
  {
    key: "level",
    label: "Stock level",
    html: true,
    sort: true,
    hint: "The bar is the stock on the shelf. The dark line is the reorder point: when stock reaches it, a restock is ordered automatically.",
  },
  {
    key: "days",
    label: "Runs out in",
    html: true,
    sort: true,
    hint: "How many days the stock on the shelf lasts at recent daily use. The tick on the bar is the lead time.",
  },
  { key: "order", label: "Restock", html: true, sort: true },
];

/** Default order is most urgent first: worst status, then the lowest stock against its reorder point. */
const skuSort = { key: "status", dir: "asc" };

let renderGeneration = 0;

/**
 * Live UC2 output per subsidiary is read once per page load (live-data.js, shared with the
 * notification bell). A failed read falls back to the analytical sample, with the reason in the banner.
 */
export function renderReplenishment(root) {
  const q = pageQuery();
  const generation = ++renderGeneration;
  const subsidiary = q.warehouse || WAREHOUSE.subsidiary;
  const cached = peekLiveUc2(subsidiary);
  if (!cached) {
    root.innerHTML = `
      <section class="uc2-page">
        ${renderPageHead({ kicker: "UC2", title: "Replenishment", subtitle: `Loading stock for ${subsidiary}...` })}
        ${renderFeedback("loading", { table: "uc2_policy_parameters" })}
      </section>`;
    loadLiveUc2(subsidiary).then(() => {
      if (generation === renderGeneration) renderReplenishment(root);
    });
    return;
  }
  drawPage(root, q, subsidiary, cached, generation);
}

function drawPage(root, q, subsidiary, result, generation) {
  const tab = TABS.some((item) => item.id === q.tab) ? q.tab : "skus";
  const live = result.ok ? result.data : null;
  const skus = live ? live.skus : SAMPLE_SKUS;
  useLiveOrders(live ? { orders: live.orders, snapshotAt: live.snapshotAt } : null);
  // History: this subsidiary's real last 90 days once read, else the sample. It is a big read (every
  // product x 90 days), so it starts on the History tab only; the product panel reads just its own product.
  const history = live ? peekLiveHistory(subsidiary) : null;
  useHistorySource(history?.ok ? history.source : null);
  if (live && !history && tab === "history") {
    loadLiveHistory(subsidiary, skus, live.asof).then((loaded) => {
      if (generation !== renderGeneration) return;
      if (tab === "history") renderReplenishment(root);
      else if (loaded.ok) useHistorySource(loaded.source);
    });
  }
  const historyLive = Boolean(history?.ok);
  const historyLoading = Boolean(live && !history);
  const snapshot = live
    ? new Date(`${live.asof}T00:00:00`).toLocaleDateString([], { dateStyle: "medium" })
    : new Date(SAMPLE_POLICY.snapshotAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  const computed = live?.computedat
    ? new Date(live.computedat).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : "";
  // Live stock needs no banner: the line under the title says how fresh it is. The History tab and
  // sample data keep theirs, because they say something the line doesn't.
  const banner = live
    ? tab === "history"
      ? historyBanner(subsidiary, history)
      : ""
    : `<div class="sample-banner" title="${escapeAttribute(result.message || "")}"><span>SAMPLE DATA</span><p>Live data isn't available right now, so a small sample for ${escapeHtml(SAMPLE_POLICY.subsidiary)} is shown.</p></div>`;

  root.innerHTML = `
    <section class="uc2-page">
      ${renderPageHead({
        kicker: "UC2",
        title: "Replenishment",
        subtitle: "Stock at each subsidiary, and the restocks ordered automatically when it runs low.",
        actions: [
          {
            id: "export",
            label: "Export CSV",
            kind: "btn-s",
            disabled: tab === "history" && !historyLive,
            title:
              tab === "history"
                ? historyLive
                  ? "Download the products in the calendar (with your search and period) as a file for Excel"
                  : "History isn't loaded from live data, so it can't be exported"
                : tab === "orders"
                  ? "Download the restocks and their items as a file for Excel"
                  : "Download the products shown (with your search and filter) as a file for Excel",
          },
        ],
      })}
      <div class="uc2-context" aria-label="Which subsidiary and how fresh the data is">
        <label class="uc2-wh">
          <span>Subsidiary</span>
          <select name="warehouse" data-subsidiary aria-label="Subsidiary warehouse">
            <option value="${escapeAttribute(subsidiary)}" selected>${escapeHtml(subsidiary)}</option>
          </select>
        </label>
        <span class="uc2-asof">
          ${live ? "Data as of" : "Sample data ·"} <b>${escapeHtml(snapshot)}</b>${computed ? `<span class="uc2-updated"> · updated ${escapeHtml(computed)}</span>` : ""}
        </span>
      </div>
      <div class="uc2-pipeline">${renderPipeline({ skus, orders: buildOrders(skus) }, tab === "orders" ? q.status : "", tab === "skus" && parseRoute().params.get("focuswhy") === "low")}</div>
      ${renderTabs(TABS, tab)}
      ${banner}
      <div data-body>${renderBody(tab, q, subsidiary, historyLoading)}</div>
    </section>
  `;

  bindTabs(root);
  root.querySelectorAll("[data-stage]").forEach((button) => {
    button.addEventListener("click", () => {
      const same = tab === "orders" && q.status === button.dataset.stage;
      setQuery({ tab: "orders", status: same ? "" : button.dataset.stage, view: "list" });
    });
  });
  // "Running low" opens Stock status on just those products (click again to show everything).
  root.querySelector("[data-low-focus]")?.addEventListener("click", (event) => {
    const on = tab === "skus" && parseRoute().params.get("focuswhy") === "low";
    setQuery({ tab: "skus", status: "", q: "", focus: on ? "" : event.currentTarget.dataset.lowFocus, focuswhy: on ? "" : "low" });
  });
  root.querySelector("[data-subsidiary]")?.addEventListener("change", (event) => {
    setQuery({ warehouse: event.target.value });
  });
  const exportInfo = {
    warehouseId: live ? subsidiary : SAMPLE_POLICY.subsidiary,
    asof: live ? live.asof : String(SAMPLE_POLICY.snapshotAt).slice(0, 10),
    sample: !live,
  };
  let shownSkus = () => skus;
  if (tab === "skus" && !q.feedback) {
    bindFilterBar(root);
    shownSkus = mountSkuTable(root, q, skus);
    const linked = parseRoute().params.get("sku");
    if (linked) openLinkedSku(root, skus, linked);
  }
  root.querySelector('[data-action="export"]')?.addEventListener("click", () => {
    if (tab === "orders") exportOrders({ ...exportInfo, orders: buildOrders(skus) });
    else if (tab === "skus") exportStock({ ...exportInfo, skus: shownSkus(), filtered: Boolean(q.q || q.status) });
    else if (tab === "history" && historyLive) exportHistory({ ...exportInfo, ...historyExportRows(q), filtered: Boolean(q.q) });
  });
  if (tab === "orders" && !q.feedback) {
    bindFilterBar(root);
    mountOrders(root, q, skus, (sku, back) => openSkuDetail(root.querySelector(".uc2-page"), sku, { back }));
  }
  if (tab === "history" && !q.feedback && !historyLoading) {
    bindFilterBar(root);
    mountHistory(root, q, historyLive ? skus : SAMPLE_SKUS, (sku) => openSkuDetail(root.querySelector(".uc2-page"), sku));
  }
  fillSubsidiaries(root, subsidiary, generation);
}

function renderBody(tab, q, subsidiary, historyLoading = false) {
  if (q.feedback) return renderFeedback(q.feedback, { table: "replenishmentrecommendation" });
  if (tab === "skus") return renderSkusTab(subsidiary, q);
  if (tab === "orders") return renderOrdersTab(subsidiary, q);
  if (historyLoading) return renderFeedback("loading", { table: "consumption" });
  return renderHistoryTab(subsidiary);
}

const longDay = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

/** Banner on the History tab: live and over which days, still loading (none), or why it fell back. */
function historyBanner(subsidiary, history) {
  if (!history) return "";
  if (!history.ok) {
    return `<div class="sample-banner" title="${escapeAttribute(history.message)}"><span>SAMPLE DATA</span><p>The live history for ${escapeHtml(subsidiary)} couldn't be loaded, so sample data is shown.</p></div>`;
  }
  const { from, asof, startingUntil } = history.source;
  const note = startingUntil
    ? `Days up to ${longDay(startingUntil)} are compared with the starting reorder points (the ones those orders were placed on)${startingUntil < asof ? "; later days with today's levels" : ""}.`
    : "Days are compared with today's reorder points.";
  return `<div class="live-banner" title="${escapeAttribute(note)}"><span>LIVE DATA</span><p>Daily stock for ${escapeHtml(subsidiary)}, ${escapeHtml(longDay(from))} to ${escapeHtml(longDay(asof))}</p></div>`;
}

/* ------------------------------------------------------------------ */
/* Stock status tab                                                    */
/* ------------------------------------------------------------------ */

function renderSkusTab(subsidiary, q) {
  const status = SKU_FILTERS.includes(q.status) ? q.status : "";
  // The filter form republishes the whole query, so carry the values it does not own.
  const carried = `
    <input type="hidden" name="tab" value="skus" />
    <input type="hidden" name="warehouse" value="${escapeAttribute(subsidiary)}" />
    <input type="hidden" name="status" value="${escapeAttribute(status)}" />
    <input type="hidden" name="focus" value="${escapeAttribute(parseRoute().params.get("focus") || "")}" />
    <input type="hidden" name="focuswhy" value="${escapeAttribute(parseRoute().params.get("focuswhy") || "")}" />
    <div class="uc2-chips" data-chips role="group" aria-label="Filter by status"></div>
  `;
  return `
    ${renderFilterBar({ includeFeedback: false, extra: carried, searchPlaceholder: "Search product" })}
    <div data-focus-strip></div>
    <div class="panel uc2-sku-panel">
      <div class="uc2-table-head">
        <div>
          <div class="l">Stock by product</div>
          <div class="uc2-table-sub">Most urgent first. Select a product for details.</div>
        </div>
        <span class="uc2-table-count" data-sku-count></span>
      </div>
      <div class="uc2-legend" aria-label="How to read this table">
        <span><i class="lg-fill"></i> Stock on the shelf</span>
        <span><i class="lg-rop"></i> Reorder point</span>
        <span><i class="lg-band"></i> Near ROP</span>
        <span><i class="lg-lead"></i> Lead time (on “Runs out in”)</span>
      </div>
      <div data-sku-table></div>
    </div>
  `;
}

function matchesSearch(sku, q) {
  const hay = `${sku.productid} ${sku.productname}`.toLowerCase();
  return !q.q || hay.includes(q.q.toLowerCase());
}

const SKU_FILTERS = Object.values(KIND_LABEL);

function matchesStatus(sku, q) {
  if (!q.status || !SKU_FILTERS.includes(q.status)) return true;
  return statusLabel(sku) === q.status;
}

const coverageOf = (sku) => sku.qtyonhand / Math.max(sku.reorderpoint, 1);
const orderRank = (sku) => replenState(sku)?.rank ?? 3;

const SORT_VALUE = {
  product: (sku) => sku.productname,
  status: (sku) => STATUS_RANK[sku.status] ?? 9,
  level: coverageOf,
  days: (sku) => sku.daysofsupply,
  order: orderRank,
};

function sortSkus(skus) {
  const value = SORT_VALUE[skuSort.key] || SORT_VALUE.status;
  const direction = skuSort.dir === "desc" ? -1 : 1;
  return [...skus].sort((a, b) => {
    const left = value(a);
    const right = value(b);
    const order = typeof left === "string" ? left.localeCompare(right) : left - right;
    return order * direction || coverageOf(a) - coverageOf(b) || a.productid.localeCompare(b.productid);
  });
}

const day = (iso) => new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });

function runsOutCell(sku) {
  const value = Number.isInteger(sku.daysofsupply) ? sku.daysofsupply : sku.daysofsupply.toFixed(1);
  const risk = sku.daysofsupply < sku.leadtimedays;
  const note = risk
    ? `<span class="cell-sub is-warn"><i class="pipe-bang" aria-hidden="true">!</i>Runs out before a delivery could arrive</span>`
    : `<span class="cell-sub">lead time ${sku.leadtimedays} days</span>`;
  return `
    <span class="cell-main mono">${value}<small class="unit"> days</small></span>
    ${renderRunway({ days: sku.daysofsupply, leadDays: sku.leadtimedays })}
    ${note}
  `;
}

/** Where the automatic order for this SKU is. Near ROP rows without an order are simply being monitored. */
function orderCell(sku) {
  const state = replenState(sku);
  if (!state) {
    if (sku.duenote) {
      return `<span class="cell-main">Due tonight</span><span class="cell-sub">ordered at the evening stock check</span>`;
    }
    return sku.status === "Near ROP"
      ? `<span class="cell-main">Watching</span><span class="cell-sub">nothing to order yet</span>`
      : `<span class="cell-sub">—</span>`;
  }
  const { order } = sku;
  const companion = order.triggerid !== sku.productid;
  let when = "";
  if (state.kind === "done") when = ` · ${day(order.deliveredat)}`;
  else if (order.expectedat) when = ` · arrives ${day(order.expectedat)}`;
  const tag = companion ? companionTag(`Sent with ${order.triggerid}`) : "";
  // The restock number links to that restock on the Restocks tab (the row itself opens the product).
  const warehouse = parseRoute().params.get("warehouse") || WAREHOUSE.subsidiary;
  const href = `#/uc2?warehouse=${encodeURIComponent(warehouse)}&tab=orders&order=${encodeURIComponent(order.orderid)}`;
  const link = `<a class="po-link" href="${escapeAttribute(href)}" title="Open this restock">${escapeHtml(order.orderid)}</a>`;
  return `${statusPill(state.label)}<span class="cell-sub mono">${link}${escapeHtml(when)}</span>${tag}`;
}

function toTableRow(sku) {
  return {
    _key: sku.productid,
    _class: `is-${statusKind(sku)}`,
    product: `<span class="cell-main">${escapeHtml(sku.productname)}</span><span class="cell-sub mono">${escapeHtml(sku.productid)}</span>`,
    status: `${statusPill(statusText(sku))}${flagNote(sku)}`,
    level: `${renderBulletBar({
      position: sku.qtyonhand,
      reorderPoint: sku.reorderpoint,
      safetyStock: sku.safetystock,
      orderUpTo: sku.orderuptolevel,
      kind: statusKind(sku),
    })}<span class="cell-sub level-sub">
      <span><b class="mono">${sku.qtyonhand.toLocaleString()}</b> on the shelf${sku.intransit ? ` + ${sku.intransit.toLocaleString()} on its way` : ""}</span>
      <span>Reorder point ${sku.reorderpoint.toLocaleString()}</span>
    </span>`,
    days: runsOutCell(sku),
    order: `${orderCell(sku)}${companionHint(sku)}`,
  };
}

/** Why a grouped notification is showing these products: the heading and one line of explanation. */
const FOCUS_WHY = {
  demand: { title: "with unusual demand", note: "Hospitals asked for much more, or much less, than usual. Worth checking it isn't a one-off." },
  oos: { title: "out of stock", note: "Nothing on the shelf right now." },
  low: { title: "running low", note: "At or below their reorder point. A restock is ordered automatically." },
  runout: { title: "that will run out before delivery", note: "Stock won't last until the restock arrives." },
  shortfall: { title: "short-supplied to hospitals", note: "Hospitals asked for more than could be handed out in the last few days." },
  other: { title: "from a notification", note: "" },
};

/** A short line under the status when recent demand looks unusual, so the reason is on the row. */
function flagNote(sku) {
  const flags = sku.flags || {};
  const text = flags.possibleStockout ? "Demand may be hidden" : flags.spiked ? "Demand jumped" : flags.dropped ? "Demand slowed" : "";
  return text ? `<span class="cell-sub uc2-flag" title="Recent use is unusual, so check before relying on these levels">${text}</span>` : "";
}

/**
 * "2 companions" under the restock status. On a product that needs a restock and has a companion
 * just above its own reorder point, it says so, as a prompt to consider sending both. Advice only.
 */
function companionHint(sku) {
  const all = companionsOf(sku);
  if (!all.length) return "";
  const worth = needsRestock(sku) ? worthAdding(sku).length : 0;
  const text = `Used with ${all.length} ${all.length === 1 ? "item" : "items"}${worth ? ` · ${worth} worth adding` : ""}`;
  const names = all.map((c) => c.sku.productname).join(", ");
  return `<span class="co-hint${worth ? " is-worth" : ""}" title="${escapeAttribute(`Hospitals often use this together with: ${names}. Open the product to see their stock.`)}">${companionTag(text)}</span>`;
}

/** Draws the table; returns the rows as currently shown (filtered, in the current sort) for export. */
function mountSkuTable(root, rawQuery, all) {
  const q = { ...rawQuery, status: SKU_FILTERS.includes(rawQuery.status) ? rawQuery.status : "" };
  const host = root.querySelector("[data-sku-table]");
  const count = root.querySelector("[data-sku-count]");
  const chips = root.querySelector("[data-chips]");
  if (!host) return () => all;
  // From a grouped notification: only the products it is about, with a strip saying why.
  const params = parseRoute().params;
  const focusIds = (params.get("focus") || "").split(",").filter(Boolean);
  const focused = focusIds.length ? all.filter((sku) => focusIds.includes(sku.productid)) : all;
  const strip = root.querySelector("[data-focus-strip]");
  if (strip) {
    const why = FOCUS_WHY[params.get("focuswhy")] || FOCUS_WHY.other;
    strip.innerHTML = focusIds.length
      ? `<div class="uc2-focus" role="status">
          <div class="uc2-focus-text">
            <b>${focused.length} ${focused.length === 1 ? "product" : "products"} ${escapeHtml(why.title)}</b>
            <span>${escapeHtml(why.note)}</span>
          </div>
          <button type="button" class="btn btn-s" data-focus-clear>Show all products</button>
        </div>`
      : "";
    strip.querySelector("[data-focus-clear]")?.addEventListener("click", () => setQuery({ focus: "", focuswhy: "" }));
  }
  // Search scopes everything; the chips then narrow the table.
  const searched = focused.filter((sku) => matchesSearch(sku, q));
  const skus = searched.filter((sku) => matchesStatus(sku, q));

  const draw = () => {
    host.innerHTML = renderTable(null, {
      columns: SKU_COLUMNS,
      rows: sortSkus(skus).map(toTableRow),
      sort: skuSort,
    });
    host.querySelectorAll("th.sortable").forEach((th) => {
      th.querySelector("button").addEventListener("click", () => {
        const key = th.dataset.sort;
        skuSort.dir = skuSort.key === key && skuSort.dir === "asc" ? "desc" : "asc";
        skuSort.key = key;
        draw();
      });
    });
    bindRowDetails(root, host, skus);
  };

  if (count) count.textContent = skus.length === all.length ? `${all.length} products` : `${skus.length} of ${all.length} products`;
  draw();

  if (chips) {
    const counts = Object.fromEntries(KIND_ORDER.map((kind) => [kind, 0]));
    searched.forEach((sku) => {
      counts[statusKind(sku)] += 1;
    });
    const chip = (label, total, dot, active, value, hint = "") => `
      <button type="button" class="uc2-chip${active ? " is-active" : ""}" data-chip-status="${escapeAttribute(value)}" aria-pressed="${active}"${hint ? ` title="${escapeAttribute(hint)}"` : ""}>
        ${dot}${escapeHtml(label)} <b>${total}</b>
      </button>`;
    const dot = (kind) => `<i class="chip-dot is-${kind}"></i>`;
    chips.innerHTML =
      chip("All", searched.length, "", !q.status, "") +
      KIND_ORDER.map((kind) =>
        chip(kindText(kind), counts[kind], dot(kind), q.status === KIND_LABEL[kind], KIND_LABEL[kind], STATUS_HINT[KIND_LABEL[kind]]),
      ).join("");
    chips.querySelectorAll("[data-chip-status]").forEach((button) => {
      button.addEventListener("click", () => setQuery({ status: button.dataset.chipStatus }));
    });
  }
  // A function, so a sort chosen after the page drew is still the order that gets exported.
  return () => sortSkus(skus);
}

/** Rows open the detail drawer on click, Enter or Space. */
function bindRowDetails(root, host, skus) {
  const bySku = new Map(skus.map((sku) => [sku.productid, sku]));
  host.querySelectorAll("tbody tr[data-key]").forEach((row) => {
    const sku = bySku.get(row.dataset.key);
    if (!sku) return;
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-label", `Show details for ${sku.productname}`);
    const open = () => {
      host.querySelectorAll("tr.is-selected").forEach((el) => el.classList.remove("is-selected"));
      row.classList.add("is-selected");
      openSkuDetail(root.querySelector(".uc2-page"), sku, {
        onClose: () => row.classList.remove("is-selected"),
      });
    };
    // Resting on a row starts reading its daily stock, so the panel's chart is usually there on click.
    let prefetch = 0;
    row.addEventListener("pointerenter", () => {
      if (historySource().live) return;
      prefetch = window.setTimeout(() => loadSkuHistory(sku), 150);
    });
    row.addEventListener("pointerleave", () => window.clearTimeout(prefetch));
    // a link inside the row (the restock number) goes where it says, not to the product panel
    row.addEventListener("click", (event) => {
      if (!event.target.closest("a")) open();
    });
    row.addEventListener("keydown", (event) => {
      if (event.target.closest("a")) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });
}

/**
 * `?sku=MED0170` (from a notification) opens that product's panel and marks its row. Closing the panel
 * drops `sku` from the address without a reload, so the page underneath stays as it is.
 */
function openLinkedSku(root, skus, productid) {
  const sku = skus.find((item) => item.productid === productid);
  const dropParam = () => {
    const { path, params } = parseRoute();
    params.delete("sku");
    const query = params.toString();
    history.replaceState(null, "", `#${path}${query ? `?${query}` : ""}`);
  };
  if (!sku) {
    dropParam();
    return;
  }
  const row = [...root.querySelectorAll("[data-sku-table] tbody tr[data-key]")].find(
    (tr) => tr.dataset.key === productid,
  );
  row?.classList.add("is-selected");
  row?.scrollIntoView({ block: "center" });
  openSkuDetail(root.querySelector(".uc2-page"), sku, {
    onClose: () => {
      row?.classList.remove("is-selected");
      dropParam();
    },
  });
}

/** Fills the destination selector with live SUBSIDIARY warehouses when readable; keeps the default otherwise. */
async function fillSubsidiaries(root, selectedId, generation) {
  const result = await fetchWarehouses();
  if (generation !== renderGeneration || !result.ok) return;
  const select = root.querySelector("[data-subsidiary]");
  const subsidiaries = result.rows
    .filter((warehouse) => String(warehouse.warehouserole).toUpperCase() === "SUBSIDIARY")
    .sort((a, b) => a.warehouseid.localeCompare(b.warehouseid));
  if (!select || !subsidiaries.length) return;
  select.innerHTML = subsidiaries
    .map((warehouse) => {
      const label = `${warehouse.warehouseid} · ${warehouse.warehousename || "Subsidiary"}`;
      return `<option value="${escapeAttribute(warehouse.warehouseid)}">${escapeHtml(label)}</option>`;
    })
    .join("");
  select.value = subsidiaries.some((warehouse) => warehouse.warehouseid === selectedId)
    ? selectedId
    : subsidiaries[0].warehouseid;
}
