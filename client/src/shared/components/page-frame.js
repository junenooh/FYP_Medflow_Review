import { FEEDBACK_COPY, FEEDBACK_KINDS } from "@shared/utils/feedback-state.js";
import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";
import { pageQuery, setQuery } from "@app/router.js";
import "@shared/components/loader.js";

export function renderFeedback(kind, { detail = "", table = "" } = {}) {
  const copy = FEEDBACK_COPY[kind] || FEEDBACK_COPY.error;
  const loadingClass = kind === "loading" ? " is-loading" : "";
  const detailHtml = detail ? `<pre class="detail">${escapeHtml(detail)}</pre>` : "";
  const loaderHtml = kind === "loading" ? "<medflow-loader></medflow-loader>" : "";
  return `
    <div class="feedback${loadingClass}" data-feedback="${kind}" role="status">
      ${loaderHtml}
      <span class="feedback-kind">${kind}${table ? ` · ${escapeHtml(table)}` : ""}</span>
      <h2>${copy.title}</h2>
      <p>${copy.body}</p>
      ${detailHtml}
    </div>
  `;
}

export function renderKpiRow(items = []) {
  return `
    <div class="kpis">
      ${items
        .map(
          (item) => `
        <div class="kpi">
          <div class="l">${escapeHtml(item.label)}</div>
          <div class="v" ${item.color ? `style="color:${escapeAttribute(item.color)}"` : ""}>${escapeHtml(item.value)}${item.suffix ? `<small>${escapeHtml(item.suffix)}</small>` : ""}</div>
          <div class="d" ${item.deltaColor ? `style="color:${escapeAttribute(item.deltaColor)}"` : ""}>${escapeHtml(item.delta || "")}</div>
        </div>`,
        )
        .join("")}
    </div>
  `;
}

export function renderFilterBar({
  warehouses = [],
  zones = [],
  statuses = [],
  statusLabel = "Status",
  statusLabels = {},
  includeFeedback = true,
  extra = "",
  searchPlaceholder = "Search for SKU",
} = {}) {
  const q = pageQuery();
  const warehouseOpts = warehouses.map((warehouse) => {
    const value = typeof warehouse === "string" ? warehouse : warehouse.id;
    const label = typeof warehouse === "string" ? warehouse : warehouse.label;
    return `<option value="${escapeAttribute(value)}" ${q.warehouse === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
  });
  const zoneOpts = ["", ...zones].map(
    (zone) =>
      `<option value="${escapeAttribute(zone)}" ${q.zone === zone ? "selected" : ""}>${escapeHtml(zone || "All zones")}</option>`,
  );
  const statusOpts = ["", ...statuses].map(
    (status) =>
      `<option value="${escapeAttribute(status)}" ${q.status === status ? "selected" : ""}>${escapeHtml(status ? statusLabels[status] || status : `All ${statusLabel.toLowerCase()}`)}</option>`,
  );
  const feedbackOpts = ["", ...FEEDBACK_KINDS].map(
    (kind) =>
      `<option value="${kind}" ${q.feedback === kind ? "selected" : ""}>${kind ? `Preview: ${kind}` : "Live engine output"}</option>`,
  );
  return `
    <form class="filter-bar" data-filters>
      <label class="filter-search">
        <span class="filter-search-icon" aria-hidden="true"></span>
        <input class="input" name="q" type="search" placeholder="${escapeAttribute(searchPlaceholder)}" value="${escapeAttribute(q.q)}" aria-label="${escapeAttribute(searchPlaceholder)}" />
      </label>
      ${warehouses.length ? `<select name="warehouse" aria-label="Warehouse">${warehouseOpts.join("")}</select>` : ""}
      ${zones.length ? `<select name="zone">${zoneOpts.join("")}</select>` : ""}
      ${statuses.length ? `<select name="status" aria-label="${escapeAttribute(statusLabel)}">${statusOpts.join("")}</select>` : ""}
      ${includeFeedback ? `<select name="feedback" aria-label="Preview feedback state">${feedbackOpts.join("")}</select>` : ""}
      ${extra}
    </form>
  `;
}

export function bindFilterBar(root) {
  const form = root.querySelector("[data-filters]");
  if (!form) return;
  const publish = () => {
    const data = new FormData(form);
    setQuery({
      q: String(data.get("q") || "").trim(),
      warehouse: data.get("warehouse") || "",
      zone: data.get("zone") || "",
      status: data.get("status") || "",
      tab: data.get("tab") || "",
      feedback: data.get("feedback") || "",
    });
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    publish();
  });
  form.querySelectorAll("select").forEach((select) => select.addEventListener("change", publish));
  form.querySelector('input[name="q"]')?.addEventListener("change", publish);
}

export function renderTabs(tabs, active, { unavailableDescriptionId = "" } = {}) {
  return `
    <div class="tabs" role="tablist">
      ${tabs
        .map(
          (tab) => {
            const unavailable = Boolean(tab.unavailable);
            return `<button type="button" class="tab ${tab.id === active ? "on" : ""}${unavailable ? " is-unavailable" : ""}" data-tab="${escapeAttribute(tab.id)}" role="tab" aria-selected="${tab.id === active}"${unavailable ? ` aria-disabled="true"${unavailableDescriptionId ? ` aria-describedby="${escapeAttribute(unavailableDescriptionId)}"` : ""}` : ""}>${unavailable ? '<span class="tab-unavailable-icon" aria-hidden="true">🔒</span>' : ""}${escapeHtml(tab.label)}</button>`;
          },
        )
        .join("")}
    </div>
  `;
}

export function bindTabs(root) {
  root.querySelectorAll("[data-tab]").forEach((button) => {
    const activate = () => {
      if (button.getAttribute("aria-disabled") === "true") return;
      setQuery({ tab: button.dataset.tab });
    };
    button.addEventListener("click", activate);
    button.addEventListener("keydown", (event) => {
      if (!["Enter", " ", "Spacebar"].includes(event.key)) return;
      if (button.getAttribute("aria-disabled") !== "true") return;
      event.preventDefault();
    });
  });
}

export function renderPageHead({ kicker, title, subtitle, actions = [] }) {
  return `
    <header class="page-head">
      <div>
        <p class="page-kicker">${escapeHtml(kicker)}</p>
        <div class="page-title">${escapeHtml(title)}</div>
        <div class="page-sub">${escapeHtml(subtitle)}</div>
      </div>
      <div class="page-actions">
        ${actions
          .map(
            (action) =>
              `<button class="btn ${action.kind || "btn-p"}" type="button"${action.id ? ` data-action="${escapeHtml(action.id)}"` : ""}${action.title ? ` title="${escapeHtml(action.title)}"` : ""} ${action.disabled ? "disabled" : ""}>${escapeHtml(action.label)}</button>`,
          )
          .join("")}
      </div>
    </header>
  `;
}
