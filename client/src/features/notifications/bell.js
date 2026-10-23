/**
 * The notification bell in the top bar, its panel and the one-off urgent toast.
 *
 * The top bar is re-rendered on every route change, so the bell button is drawn into whatever slot
 * the latest top bar provides (mountBell), while the panel and toast live once on <body> and keep
 * their state (filters, scroll, expanded groups) across those re-renders.
 *
 * Keyboard: the bell is a normal button; Escape closes the panel and returns focus to the bell;
 * clicking outside closes it. Items are links, so Enter follows them.
 */

import "./notifications.css";
import { currentPath } from "@app/router.js";
import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";
import {
  LEVELS,
  LEVEL_HEADING,
  LEVEL_LABEL,
  countByLevel,
  formatDay,
  formatAt,
  headline,
} from "./rules.js";
import {
  getState,
  isRead,
  load,
  markAllRead,
  markRead,
  refresh,
  subscribe,
  unreadCount,
} from "./store.js";

const TOAST_KEY = "medflow.notifications.toast.v1";
const TOAST_MS = 8000;

const ui = {
  slot: null,
  panel: null,
  toast: null,
  open: false,
  level: "all",
  expanded: new Set(),
  refreshing: false,
  toastTimer: null,
  wired: false,
};

const svg = (body, size = 16) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  bell: svg(`<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>`),
  oos: svg(`<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m9 10 6 6M15 10l-6 6"/>`),
  runout: svg(`<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>`),
  shortfall: svg(`<path d="M4 21V7l8-4 8 4v14"/><path d="M12 9v6M9 12h6M9 21v-3h6v3"/>`),
  demand: svg(`<path d="M3 12h4l3-8 4 16 3-8h4"/>`),
  stale: svg(`<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>`),
  reorder: svg(`<path d="M3 7h11v9H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>`),
  delivered: svg(`<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>`),
  refresh: svg(`<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>`, 15),
  close: svg(`<path d="M6 6l12 12M18 6 6 18"/>`, 15),
  chevron: svg(`<path d="m6 9 6 6 6-6"/>`, 14),
  clear: svg(`<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>`, 28),
};

/* ------------------------------------------------------------------ */
/* Bell button                                                         */
/* ------------------------------------------------------------------ */

/** Draws the bell into the top bar's slot. Call after every top bar render. */
export function mountBell(slot) {
  if (!slot) return;
  ui.slot = slot;
  wireOnce();
  drawButton();
  // Load after the page has painted, so the first view is not slowed down by five warehouses.
  const start = () => load();
  if ("requestIdleCallback" in window) window.requestIdleCallback(start, { timeout: 1500 });
  else window.setTimeout(start, 300);
}

function drawButton() {
  const slot = ui.slot;
  if (!slot || !slot.isConnected) return;
  const state = getState();
  const urgent = unreadCount(["urgent"]);
  const count = unreadCount(["urgent", "warning"]);
  const loading = state.status === "loading" || state.status === "idle";
  const label = loading
    ? "Notifications, checking stock"
    : count
      ? `Notifications, ${count} unread${urgent ? `, ${urgent} urgent` : ""}`
      : "Notifications, nothing unread";
  const badge = count
    ? `<span class="notif-badge" data-tone="${urgent ? "urgent" : "warning"}">${count > 99 ? "99+" : count}</span>`
    : "";
  slot.innerHTML = `
    <button class="iconbtn notif-bell${ui.open ? " is-open" : ""}" type="button"
      aria-haspopup="dialog" aria-controls="notif-panel" aria-expanded="${ui.open}"
      aria-label="${escapeAttribute(label)}" title="Notifications">
      ${ICON.bell}${badge}
    </button>`;
  slot.querySelector("button").addEventListener("click", () => (ui.open ? close() : openPanel()));
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

function openPanel() {
  ui.open = true;
  load();
  drawPanel();
  ui.panel.hidden = false;
  drawButton();
  hideToast();
  ui.panel.querySelector(".notif-panel-inner")?.focus();
}

function close({ focusBell = false } = {}) {
  if (!ui.open) return;
  ui.open = false;
  ui.panel.hidden = true;
  drawButton();
  if (focusBell) ui.slot?.querySelector("button")?.focus();
}

function visibleItems(items) {
  return items.filter((item) => ui.level === "all" || item.level === ui.level);
}

function renderItem(item) {
  const unread = !isRead(item.id);
  const where = getState().warehouseNames?.[item.warehouseId] || item.warehouseId;
  const expanded = ui.expanded.has(item.id);
  const children = item.group
    ? `
      <button type="button" class="notif-expand" data-expand="${escapeAttribute(item.id)}" aria-expanded="${expanded}">
        ${expanded ? "Hide" : "Show"} products ${ICON.chevron}
      </button>
      <ul class="notif-children"${expanded ? "" : " hidden"}>
        ${item.children
          .map(
            (child) => `
          <li><a href="${escapeAttribute(child.href)}" data-open="${escapeAttribute(child.id)}" title="${escapeAttribute(child.detail)}">
            ${escapeHtml(child.productname)}
          </a></li>`,
          )
          .join("")}
      </ul>`
    : "";
  return `
    <li class="notif-item${unread ? " is-unread" : ""}" data-level="${item.level}">
      <a class="notif-main" href="${escapeAttribute(item.href)}" data-open="${escapeAttribute(item.id)}"${item.tech ? ` title="${escapeAttribute(item.tech)}"` : ""}>
        <span class="notif-ico">${ICON[item.kind] || ICON.bell}</span>
        <span class="notif-body">
          <span class="notif-title">${escapeHtml(item.title)}</span>
          <span class="notif-detail">${escapeHtml(item.detail)}</span>
          <span class="notif-meta">
            ${item.action ? `<span class="notif-action" data-tone="${item.action.tone}">${escapeHtml(item.action.label)}</span>` : ""}
            <span class="notif-wh" title="${escapeAttribute(where)}">${escapeHtml(item.warehouseId)}</span>
            ${item.at ? `<time class="notif-time" datetime="${escapeAttribute(item.at)}">${escapeHtml(formatAt(item.at))}</time>` : ""}
          </span>
        </span>
        ${unread ? `<i class="notif-dot" aria-label="Unread"></i>` : ""}
      </a>
      ${children}
    </li>`;
}

function renderList(state) {
  if (state.status === "idle" || (state.status === "loading" && !state.items.length)) {
    return `
      <div class="notif-loading" role="status" aria-label="Checking stock">
        ${[0, 1, 2].map(() => `<div class="notif-skel"><i></i><span><b></b><b></b></span></div>`).join("")}
      </div>`;
  }
  if (state.status === "error") {
    return `
      <div class="notif-empty">
        <p><b>Alerts are unavailable</b></p>
        <p class="notif-empty-sub" title="${escapeAttribute(state.message)}">The stock data couldn't be loaded.</p>
        <button type="button" class="notif-btn" data-refresh>Try again</button>
      </div>`;
  }
  const items = visibleItems(state.items);
  // "All" shows what needs attention; routine restock updates fold into one line at the end.
  const levels = ui.level === "all" ? ["urgent", "warning"] : [ui.level];
  const sections = levels
    .map((level) => {
      const rows = items.filter((item) => item.level === level);
      if (!rows.length) return "";
      return `
        <section class="notif-section" aria-label="${escapeAttribute(LEVEL_HEADING[level])}">
          ${ui.level === "all" ? `<h3 class="notif-section-head">${escapeHtml(LEVEL_HEADING[level])}</h3>` : ""}
          <ul class="notif-list">${rows.map(renderItem).join("")}</ul>
        </section>`;
    })
    .join("");
  const updates = ui.level === "all" ? items.filter((item) => item.level === "info").length : 0;
  const more = updates
    ? `<button type="button" class="notif-more" data-level-filter="info">
        ${ICON.reorder}<span>${updates} restock ${updates === 1 ? "update" : "updates"}</span>${ICON.chevron}
      </button>`
    : "";
  const clear = sections
    ? ""
    : `
      <div class="notif-empty">
        <span class="notif-empty-ico">${ICON.clear}</span>
        <p><b>All clear</b></p>
        <p class="notif-empty-sub">${ui.level === "all" ? "Nothing needs your attention." : "Nothing in this list."}</p>
      </div>`;
  return `${sections}${clear}${more}`;
}

function renderNotes(state) {
  const notes = state.failures.map(
    (f) => `<p title="${escapeAttribute(f.message)}">${escapeHtml(f.warehouseId)} couldn't be checked. Try again shortly.</p>`,
  );
  if (state.shortfallAccess === false) {
    notes.push(
      `<p title="Admin: run sql/policies/002_anon_read.sql in the Supabase SQL Editor">Hospital shortage alerts are off. Ask the admin to turn them on.</p>`,
    );
  }
  return notes.length ? `<footer class="notif-foot">${notes.join("")}</footer>` : "";
}

function renderHeadline(state) {
  if (state.status !== "ready" || !state.items.length) return "";
  const { tone, lead, detail } = headline(state.items);
  return `<p class="notif-headline" data-tone="${tone}"><b>${escapeHtml(lead)}</b>${detail ? `<span>${escapeHtml(detail)}</span>` : ""}</p>`;
}

function drawPanel() {
  if (!ui.panel) return;
  const state = getState();
  const counts = countByLevel(state.items);
  const unread = visibleItems(state.items).filter((item) => !isRead(item.id)).length;
  const loading = state.status === "loading" || ui.refreshing;
  const checked = state.loadedAt
    ? `Checked at ${new Date(state.loadedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. Check again`
    : "Check again";
  const sub =
    state.status === "ready"
      ? `Stock as of ${formatDay(state.asof)}`
      : state.status === "error"
        ? "Not available"
        : "Checking stock...";

  // Keep scroll and focus across redraws.
  const scroller = ui.panel.querySelector(".notif-scroll");
  const scrollTop = scroller ? scroller.scrollTop : 0;
  const focusKey = document.activeElement?.closest?.("#notif-panel")
    ? document.activeElement.getAttribute("data-key")
    : null;

  const tab = (value, label, count) => `
    <button type="button" class="notif-tab" data-key="tab-${value}" data-level-filter="${value}" aria-pressed="${ui.level === value}">
      ${escapeHtml(label)}${count ? `<span>${count}</span>` : ""}
    </button>`;

  ui.panel.innerHTML = `
    <div class="notif-panel-inner" tabindex="-1">
      <header class="notif-head">
        <div>
          <h2 id="notif-title">Notifications</h2>
          <p>${escapeHtml(sub)}</p>
        </div>
        <div class="notif-head-actions">
          ${unread ? `<button type="button" class="notif-link" data-key="readall" data-readall>Mark all read</button>` : ""}
          <button type="button" class="notif-icon-btn${loading ? " is-spinning" : ""}" data-key="refresh" data-refresh
            aria-label="${escapeAttribute(checked)}" title="${escapeAttribute(checked)}"${loading ? " disabled" : ""}>${ICON.refresh}</button>
          <button type="button" class="notif-icon-btn" data-key="close" data-close aria-label="Close" title="Close">${ICON.close}</button>
        </div>
      </header>
      ${renderHeadline(state)}
      ${
        state.items.length
          ? `<div class="notif-tabs" role="group" aria-label="Show">
              ${tab("all", "All", counts.urgent + counts.warning)}
              ${LEVELS.map((level) => tab(level, LEVEL_LABEL[level], counts[level])).join("")}
            </div>`
          : ""
      }
      <div class="notif-scroll">${renderList(state)}</div>
      ${renderNotes(state)}
    </div>`;

  const nextScroller = ui.panel.querySelector(".notif-scroll");
  if (nextScroller) nextScroller.scrollTop = scrollTop;
  if (focusKey) ui.panel.querySelector(`[data-key="${focusKey}"]`)?.focus();
}

/* ------------------------------------------------------------------ */
/* Toast: once per browser session, when there are unread urgent alerts */
/* ------------------------------------------------------------------ */

function maybeToast(state) {
  if (state.status !== "ready" || ui.open) return;
  const urgent = state.items.filter((item) => item.level === "urgent" && !isRead(item.id));
  if (!urgent.length) return;
  try {
    if (sessionStorage.getItem(TOAST_KEY)) return;
    sessionStorage.setItem(TOAST_KEY, "1");
  } catch {
    /* storage blocked: show it, it simply may show again */
  }
  const { tone, lead, detail } = headline(state.items);
  ui.toast.dataset.tone = tone;
  ui.toast.innerHTML = `
    <span class="notif-toast-ico">${ICON.oos}</span>
    <span class="notif-toast-copy">
      <b>${escapeHtml(lead)}</b>
      <span>${escapeHtml(detail)}</span>
    </span>
    <button type="button" class="notif-btn" data-toast-view>View</button>
    <button type="button" class="notif-icon-btn" data-toast-close aria-label="Dismiss">${ICON.close}</button>`;
  ui.toast.hidden = false;
  requestAnimationFrame(() => ui.toast.classList.add("is-in"));
  startToastTimer();
}

function startToastTimer() {
  window.clearTimeout(ui.toastTimer);
  ui.toastTimer = window.setTimeout(hideToast, TOAST_MS);
}

function hideToast() {
  window.clearTimeout(ui.toastTimer);
  if (!ui.toast || ui.toast.hidden) return;
  ui.toast.classList.remove("is-in");
  ui.toast.hidden = true;
}

/* ------------------------------------------------------------------ */
/* Wiring (once)                                                       */
/* ------------------------------------------------------------------ */

function follow(link, event) {
  // Close first: marking read while open would redraw the panel and detach the link being followed.
  close();
  markRead(link.dataset.open);
  // Same address twice (the panel was closed meanwhile): no hashchange fires, so repaint by hand.
  if (link.getAttribute("href") === window.location.hash) {
    event.preventDefault();
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
}

async function doRefresh() {
  ui.refreshing = true;
  drawPanel();
  await refresh();
  ui.refreshing = false;
  drawPanel();
  // The Replenishment page read the old data; repaint it from the fresh read.
  if (currentPath() === "/uc2" || currentPath() === "/replenishment") {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  }
}

function wireOnce() {
  if (ui.wired) return;
  ui.wired = true;

  ui.panel = document.createElement("div");
  ui.panel.id = "notif-panel";
  ui.panel.className = "notif-panel";
  ui.panel.setAttribute("role", "dialog");
  ui.panel.setAttribute("aria-labelledby", "notif-title");
  ui.panel.hidden = true;
  document.body.appendChild(ui.panel);

  ui.toast = document.createElement("div");
  ui.toast.className = "notif-toast";
  ui.toast.setAttribute("role", "status");
  ui.toast.hidden = true;
  document.body.appendChild(ui.toast);

  ui.panel.addEventListener("click", (event) => {
    const t = event.target;
    const link = t.closest("a[data-open]");
    if (link) return follow(link, event);
    const level = t.closest("[data-level-filter]");
    if (level) {
      ui.level = level.dataset.levelFilter;
      return drawPanel();
    }
    if (t.closest("[data-readall]")) return markAllRead(visibleItems(getState().items));
    const expand = t.closest("[data-expand]");
    if (expand) {
      const id = expand.dataset.expand;
      if (ui.expanded.has(id)) ui.expanded.delete(id);
      else ui.expanded.add(id);
      return drawPanel();
    }
    if (t.closest("[data-refresh]")) return doRefresh();
    if (t.closest("[data-close]")) return close({ focusBell: true });
    return undefined;
  });

  ui.toast.addEventListener("click", (event) => {
    if (event.target.closest("[data-toast-view]")) {
      hideToast();
      ui.level = "urgent";
      openPanel();
    } else if (event.target.closest("[data-toast-close]")) {
      hideToast();
    }
  });
  ui.toast.addEventListener("mouseenter", () => window.clearTimeout(ui.toastTimer));
  ui.toast.addEventListener("mouseleave", startToastTimer);

  // Capture on window runs before the UC2 drawer's own Escape handler, so one Escape closes one layer.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Escape" && ui.open) {
        event.stopPropagation();
        close({ focusBell: true });
      }
    },
    true,
  );
  document.addEventListener("pointerdown", (event) => {
    if (!ui.open) return;
    if (ui.panel.contains(event.target) || event.target.closest?.(".notif-bell")) return;
    close();
  });

  subscribe((state) => {
    drawButton();
    if (ui.open) drawPanel();
    maybeToast(state);
  });
}
