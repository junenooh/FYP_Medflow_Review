import { loadUc1Data } from "./live-data.js";
import { resolveFeedback } from "@shared/utils/feedback-state.js";
import { pageQuery, setQuery } from "@app/router.js";
import { affinityTag, renderTable } from "@shared/components/table.js";
import {
  confidenceLabel,
  liftLabel,
  recommendationLabel,
  supportLabel,
} from "./labels.js";
import { WAREHOUSE } from "@shared/data/tables.js";
import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";
import {
  bindFilterBar,
  renderFeedback,
  renderFilterBar,
  renderKpiRow,
  renderPageHead,
} from "@shared/components/page-frame.js";
import { renderNetworkChart } from "./charts/network.js";

let renderGeneration = 0;
let networkChart = null;
const ASSOCIATION_PAGE_SIZE = 10;

/* ------------------------------------------------------------------ */
/* Field access — tolerates camelCase or raw productrelationship cols   */
/* ------------------------------------------------------------------ */

const pick = (row, ...keys) => {
  for (const key of keys) if (row[key] != null) return row[key];
  return null;
};

const consequentOf = (row) => pick(row, "consequent", "consequent_productid");
const antecedentsOf = (row) => {
  const raw = pick(row, "antecedents", "antecedent_productids") || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .map((a) => (a && typeof a === "object" ? a.antecedent_productid ?? a.productid : a))
    .filter(Boolean);
};
const antecedentNamesOf = (row) => {
  const raw = pick(row, "antecedentNames", "antecedent_names") || [];
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(String).filter(Boolean);
};
const itemsetSizeOf = (row) =>
  pick(row, "itemsetsize", "itemsetSize") ?? antecedentsOf(row).length + 1;

const num = (v) => {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const dec = (v, d = 2) => (num(v) == null ? "—" : num(v).toFixed(d));
const pct = (v) => (num(v) == null ? "—" : `${(num(v) * 100).toFixed(1)}%`);

/**
 * mlxtend emits both directions of a pair, so the rule count over-reports the
 * number of distinct SKU relationships. This counts undirected pairs.
 */
function uniquePairCount(rows) {
  const pairs = new Set();
  for (const row of rows) {
    const consequent = String(consequentOf(row));
    for (const antecedent of antecedentsOf(row)) {
      const a = String(antecedent);
      pairs.add(a < consequent ? `${a}|${consequent}` : `${consequent}|${a}`);
    }
  }
  return pairs.size;
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export function renderRelationships(root) {
  const q = pageQuery();
  const generation = ++renderGeneration;

  // The force simulation ticks forever; tear the old one down before replacing the DOM.
  networkChart?.destroy();
  networkChart = null;

  root.innerHTML = `
    <section>
      ${renderPageHead({
        kicker: "UC1",
        title: "Product Relationships",
        subtitle: "Group of products that frequently appear in the same order. Use these to plan replenishment and slotting layout.",
      })}
      ${renderKpiRow([
        { label: "Unique Product Combination", value: "—" },
        { label: "Strong Product Combination", value: "—" },
        { label: "Total Product Combination", value: "—" },
        { label: "Orders Analysed", value: "—" },
      ])}
      ${renderFilterBar({
        statuses: ["Strong", "Moderate", "Weak"],
        statusLabel: "Suggestion",
        statusLabels: {
          Strong: recommendationLabel("Strong"),
          Moderate: recommendationLabel("Moderate"),
          Weak: recommendationLabel("Weak"),
        },
        includeFeedback: false,
        searchPlaceholder: "Search for product",
        extra: `${renderWarehousePicker(q.warehouse)}${renderItemsetFilter([2, 3, 4], q.tab || "2")}<button class="btn btn-p filter-export" type="button" data-export-filtered disabled>Export filtered rows</button>`,
      })}
      <div data-body>${renderFeedback("loading", { table: "productrelationship" })}</div>
    </section>
  `;
  bindFilterBar(root);
  fill(root, q, generation);
}

async function fill(root, q, generation) {
  const body = root.querySelector("[data-body]");
  const requestedIds = q.warehouse.split(",").filter(Boolean);
  const initialWarehouseIds = requestedIds.length ? requestedIds : [WAREHOUSE.central];
  const { warehouseResult, relationshipResult: initialResult } =
    await loadUc1Data(initialWarehouseIds);
  if (generation !== renderGeneration) return;
  const warehouses = warehouseResult.rows
    .map((warehouse) => ({
      id: warehouse.warehouseid,
      label: warehouse.warehouseid === WAREHOUSE.central
        ? "Product combination shared across all warehouse"
        : `${warehouse.warehouseid} · ${warehouse.warehousename || warehouse.warehouserole || "Warehouse"}`,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const selectedWarehouseIds = requestedIds.filter((id) => warehouses.some((warehouse) => warehouse.id === id));
  if (!selectedWarehouseIds.length) selectedWarehouseIds.push(warehouses[0]?.id || WAREHOUSE.central);
  fillWarehousePicker(root, warehouses, selectedWarehouseIds);
  const selectionChanged =
    selectedWarehouseIds.length !== initialWarehouseIds.length ||
    selectedWarehouseIds.some((id, index) => id !== initialWarehouseIds[index]);
  const result = selectionChanged
    ? (await loadUc1Data(selectedWarehouseIds)).relationshipResult
    : initialResult;
  if (generation !== renderGeneration) return;

  const itemsetSizes = [...new Set(result.rows.map(itemsetSizeOf))].sort((a, b) => a - b);
  const selectedSize = q.tab === "all"
    ? null
    : itemsetSizes.includes(Number(q.tab))
      ? Number(q.tab)
      : itemsetSizes[0] ?? null;
  const itemsetFilter = root.querySelector("[data-itemset-filter]");
  if (itemsetFilter) {
    itemsetFilter.innerHTML = renderItemsetOptions(itemsetSizes, selectedSize);
    itemsetFilter.value = selectedSize == null ? "all" : String(selectedSize);
  }

  const filteredRows = result.rows.filter((row) => {
    const hay = [
      consequentOf(row),
      pick(row, "consequentName", "consequent_name"),
      ...antecedentsOf(row),
      ...antecedentNamesOf(row),
    ]
      .join(" ")
      .toLowerCase();
    if (q.q && !hay.includes(q.q.toLowerCase())) return false;
    if (q.status && row.strength !== q.status) return false;
    return true;
  });
  const rows = filteredRows.filter((row) => {
    if (selectedSize != null && itemsetSizeOf(row) !== selectedSize) return false;
    return true;
  });

  const kind = resolveFeedback({
    override: q.feedback,
    loading: false,
    loadState: result.ok ? null : result.kind,
    rowCount: rows.length,
  });

  const kpis = root.querySelector(".kpis");
  if (kpis && result.ok) {
    const all = result.rows;
    const strong = all.filter((r) => r.strength === "Strong").length;
    const orders = num(pick(all[0] || {}, "ordercount", "orderCount"));
    kpis.outerHTML = renderKpiRow([
      {
        label: "Unique Product Combination",
        value: uniquePairCount(all),
      },
      {
        label: "Strong Product Combination",
        value: strong,
      },
      { label: "Total Product Combination", value: all.length },
      { label: "Orders Analysed", value: orders != null ? orders.toLocaleString() : "—" },
    ]);
  }

  if (kind) {
    body.innerHTML = renderFeedback(kind, { detail: result.message, table: "productrelationship" });
    return;
  }

  body.innerHTML = `
    <div class="work uc1-work">
      <div class="panel uc1-table-panel">
        <div class="uc1-panel-title">
          <div>
            <div class="l">Products Often Ordered Together</div>
            <div class="uc1-panel-subtitle">Product combinations are analyzed based on historical order patterns across selected sites</div>
          </div>
          <span class="uc1-table-count">${rows.length} ${rows.length === 1 ? "Product Combination" : "Product Combinations"}</span>
        </div>
        <div data-association-table>${renderAssociationTable(rows, 1)}</div>
      </div>
      <div class="panel uc1-network-panel">
        <div class="uc1-panel-title">
          <div>
            <div class="l">Product Clusters</div>
            <div class="uc1-panel-subtitle">Each line connects products that often appear together in orders</div>
          </div>
        </div>
        <div id="uc1-network"></div>
        <p class="uc1-network-note"><strong>Note:</strong> A product pairing is shown once, even if it appears in multiple group sizes or selected sites.</p>
      </div>
    </div>
  `;

  networkChart = renderNetworkChart(root.querySelector("#uc1-network"), rows);
  bindTablePagination(body, rows);
  bindExport(root, rows, result.run);
}

function renderItemsetOptions(sizes, selectedSize) {
  return [
    `<option value="all" ${selectedSize == null ? "selected" : ""}>All bundle sizes</option>`,
    ...sizes.map(
      (size) =>       `<option value="${size}" ${size === selectedSize ? "selected" : ""}>${size} products</option>`,
    ),
  ].join("");
}

function renderItemsetFilter(sizes, selectedValue) {
  const selectedSize = selectedValue === "all" ? null : Number(selectedValue);
  return `<select name="tab" data-itemset-filter aria-label="Bundle size">${renderItemsetOptions(sizes, selectedSize)}</select>`;
}

const ASSOCIATION_COLUMNS = [
  { key: "warehouse", label: "Warehouse", mono: true },
  { key: "from", label: "Primary Product", mono: true, html: true, infoHint: "Product or products ordered before the frequently bought products in the pattern." },
  { key: "to", label: "Frequently Bought With", mono: true, html: true, infoHint: "Product or products that also appear in orders containing the primary product." },
  { key: "size", label: "Bundle Size", mono: true, infoHint: "Number of products in the order pattern." },
  { key: "support", label: "Popularity", mono: true, infoHint: "How often the product combination appears together in warehouse orders." },
  { key: "confidence", label: "Reliability", mono: true, infoHint: "How often the frequently bought products also appear when the primary product is present." },
  { key: "lift", label: "Relationship pattern", mono: true, infoHint: "How many times more often the products appear together than expected from their usual popularity. 1 means no increase." },
  { key: "strength", label: "Suggestion", html: true, infoHint: "Overall assessment of how useful and consistent this product combination is." },
];

function associationTableRows(rows) {
  return rows.map((row) => {
    const antecedents = antecedentsOf(row);
    const antecedentNames = antecedentNamesOf(row);
    const consequent = consequentOf(row);
    const consequentName = pick(row, "consequentName", "consequent_name") || consequent;
    const skuTitle = (id, name) => `<span title="${escapeAttribute(name)}">${escapeHtml(id)}</span>`;
    return {
      warehouse: row.warehouseid || "—",
      from: antecedents.map((id, index) => skuTitle(id, antecedentNames[index] || id)).join(", ") || "—",
      to: skuTitle(consequent, consequentName),
      size: `${itemsetSizeOf(row)} products`,
      support: supportLabel(row.support),
      confidence: confidenceLabel(row.confidence),
      lift: liftLabel(row.lift),
      strength: affinityTag(row.strength, recommendationLabel(row.strength)),
    };
  });
}

function paginationItems(currentPage, pageCount) {
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_, index) => index + 1);
  if (currentPage <= 4) return [1, 2, 3, 4, "ellipsis", pageCount];
  if (currentPage >= pageCount - 3) return [1, "ellipsis", pageCount - 3, pageCount - 2, pageCount - 1, pageCount];
  return [1, "ellipsis", currentPage - 1, currentPage, currentPage + 1, "ellipsis", pageCount];
}

function renderAssociationTable(rows, page) {
  const pageCount = Math.max(1, Math.ceil(rows.length / ASSOCIATION_PAGE_SIZE));
  const currentPage = Math.min(Math.max(page, 1), pageCount);
  const start = (currentPage - 1) * ASSOCIATION_PAGE_SIZE;
  const pageRows = associationTableRows(rows).slice(start, start + ASSOCIATION_PAGE_SIZE);
  const pagination = pageCount > 1
    ? `<nav class="uc1-table-pagination" aria-label="Association table pages">
        <button type="button" class="uc1-page-button uc1-page-arrow" data-table-page="${currentPage - 1}" aria-label="Previous page"${currentPage === 1 ? " disabled" : ""}>&lsaquo;</button>
        ${paginationItems(currentPage, pageCount).map((item) => item === "ellipsis"
          ? '<span class="uc1-page-ellipsis" aria-hidden="true">...</span>'
          : `<button type="button" class="uc1-page-button${item === currentPage ? " is-current" : ""}" data-table-page="${item}"${item === currentPage ? ' aria-current="page"' : ""}>${item}</button>`).join("")}
        <button type="button" class="uc1-page-button uc1-page-arrow" data-table-page="${currentPage + 1}" aria-label="Next page"${currentPage === pageCount ? " disabled" : ""}>&rsaquo;</button>
      </nav>`
    : "";

  return `${renderTable(null, { columns: ASSOCIATION_COLUMNS, rows: pageRows })}${pagination}`;
}

function bindTablePagination(body, rows) {
  const host = body.querySelector("[data-association-table]");
  if (!host) return;
  let currentPage = 1;

  const hideTooltip = () => {
    document.querySelector(".table-info-tooltip")?.remove();
  };
  const showTooltip = (button) => {
    hideTooltip();
    const tooltip = document.createElement("div");
    tooltip.className = "table-info-tooltip";
    tooltip.textContent = button.dataset.tooltip;
    document.body.append(tooltip);
    const rect = button.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - box.width - 8));
    const top = rect.top - box.height - 9 >= 8 ? rect.top - box.height - 9 : rect.bottom + 9;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  host.addEventListener("pointerover", (event) => {
    const button = event.target.closest(".table-info-icon");
    if (button && !button.contains(event.relatedTarget)) showTooltip(button);
  });
  host.addEventListener("pointerout", (event) => {
    if (event.target.closest(".table-info-icon") && !event.target.closest(".table-info-icon").contains(event.relatedTarget)) hideTooltip();
  });
  host.addEventListener("focusin", (event) => {
    const button = event.target.closest(".table-info-icon");
    if (button) showTooltip(button);
  });
  host.addEventListener("focusout", (event) => {
    if (event.target.closest(".table-info-icon")) hideTooltip();
  });

  const bindPage = () => {
    const start = (currentPage - 1) * ASSOCIATION_PAGE_SIZE;
    bindRowHighlight(body, rows.slice(start, start + ASSOCIATION_PAGE_SIZE));
    host.querySelectorAll("[data-table-page]").forEach((button) => {
      button.addEventListener("click", () => {
        currentPage = Number(button.dataset.tablePage);
        host.innerHTML = renderAssociationTable(rows, currentPage);
        bindPage();
      });
    });
  };

  bindPage();
}

/** arm.py writes the FP-Growth parameter signature onto the modelrun. Surface it. */
function runCaption(run) {
  if (!run) return "Edges come from persisted lift and strength. Nothing is mined in the browser.";
  const parts = [];
  if (run.algorithmversion || run.algorithmVersion) {
    parts.push(run.algorithmversion || run.algorithmVersion);
  }
  const signature = run.parametersignature || run.parameterSignature;
  if (signature) parts.push(signature.replaceAll(";", " · "));
  const generated = run.generatedate || run.generateDate || run.lastupdated;
  if (generated) parts.push(new Date(generated).toLocaleString());
  return parts.length
    ? `${parts.join(" — ")}. Nothing is mined in the browser.`
    : "Edges come from persisted lift and strength. Nothing is mined in the browser.";
}

function shortRunId(runId) {
  return String(runId).slice(0, 8);
}

/* ------------------------------------------------------------------ */
/* Table → graph                                                       */
/* ------------------------------------------------------------------ */

/**
 * Clicking a rule spotlights its SKUs in the graph.
 * Rows are matched by position because renderTable emits plain cells; if the
 * table ever gains sorting or paging, key off a data attribute instead.
 */
function bindRowHighlight(body, rows) {
  const table = body.querySelector("table");
  if (!table || !networkChart) return;
  const trs = table.querySelectorAll("tbody tr");
  trs.forEach((tr, index) => {
    const row = rows[index];
    if (!row) return;
    tr.style.cursor = "pointer";
    tr.tabIndex = 0;
    const highlight = () => {
      const active = tr.getAttribute("aria-selected") === "true";
      trs.forEach((other) => other.removeAttribute("aria-selected"));
      if (active) {
        networkChart.clearHighlight();
        return;
      }
      tr.setAttribute("aria-selected", "true");
      networkChart.highlight([...antecedentsOf(row), consequentOf(row)]);
    };
    tr.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      highlight();
    });
    tr.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        highlight();
      }
    });
  });
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

const CSV_COLUMNS = [
  ["warehouseid", (r) => r.warehouseid],
  ["antecedent_productids", (r) => antecedentsOf(r).join(" + ")],
  ["antecedent_productnames", (r) => antecedentNamesOf(r).join(" + ")],
  ["consequent_productid", (r) => consequentOf(r)],
  ["consequent_productname", (r) => pick(r, "consequentName", "consequent_name") || consequentOf(r)],
  ["itemsetsize", (r) => itemsetSizeOf(r)],
  ["support", (r) => r.support],
  ["confidence", (r) => r.confidence],
  ["lift", (r) => r.lift],
  ["strength", (r) => r.strength],
];

function toCsv(rows) {
  const escape = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [CSV_COLUMNS.map(([header]) => header).join(",")];
  for (const row of rows) {
    lines.push(CSV_COLUMNS.map(([, read]) => escape(read(row))).join(","));
  }
  return lines.join("\n");
}

function bindExport(root, rows, run) {
  const button = root.querySelector("[data-export-filtered]");
  if (!button) return;
  button.disabled = rows.length === 0;
  button.addEventListener("click", () => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `uc1-rules-${run?.runid ? shortRunId(run.runid) : "export"}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  });
}

function renderWarehousePicker(selectedValue) {
  return `
    <div class="uc1-warehouse-picker">
      <details class="uc1-warehouse-menu" data-warehouse-menu>
        <summary data-warehouse-summary>Loading warehouses...</summary>
        <div class="uc1-warehouse-panel">
          <div class="uc1-warehouse-options" data-warehouse-options role="group" aria-label="Select warehouses"></div>
          <div class="uc1-warehouse-actions">
          <button type="button" class="btn btn-p" data-warehouse-apply disabled>Apply</button>
          </div>
        </div>
      </details>
      <input type="hidden" name="warehouse" value="${escapeAttribute(selectedValue)}" data-selected-warehouses />
    </div>
  `;
}

function fillWarehousePicker(root, warehouses, selectedIds) {
  const options = root.querySelector("[data-warehouse-options]");
  const menu = root.querySelector("[data-warehouse-menu]");
  const summary = root.querySelector("[data-warehouse-summary]");
  const hidden = root.querySelector("[data-selected-warehouses]");
  const apply = root.querySelector("[data-warehouse-apply]");
  if (!options || !menu || !summary || !hidden || !apply) return;

  const selected = new Set(selectedIds);
  hidden.value = selectedIds.join(",");
  summary.textContent = selectedIds.length === 1
    ? warehouses.find((warehouse) => warehouse.id === selectedIds[0])?.label || selectedIds[0]
    : `${selectedIds.length} warehouses selected`;
  options.innerHTML = `
    <div class="uc1-warehouse-select-all">
      <label class="uc1-warehouse-select-all-choice">
        <input type="checkbox" data-select-all aria-label="Select all subsidiary warehouse" />
        <span>Select all Subsidiary Warehouse</span>
      </label>
      <button type="button" class="table-info-icon" data-warehouse-info aria-label="Why can't I select Central and subsidiaries together?" data-tooltip="Central hub shows the aggregated relationship across all subsidiary hospitals. Select Central Hub alone, or uncheck it to select specific subsidiaries.">i</button>
    </div>
    ${warehouses.map((warehouse) => `
      <label class="uc1-warehouse-option">
        <input type="checkbox" data-warehouse-id data-warehouse-role="${escapeAttribute(String(warehouse.warehouserole || "").toUpperCase())}" value="${escapeAttribute(warehouse.id)}"${selected.has(warehouse.id) ? " checked" : ""} />
        <span>${escapeHtml(warehouse.label)}</span>
      </label>
    `).join("")}
  `;
  const selectAll = options.querySelector("[data-select-all]");
  const warehouseInfo = options.querySelector("[data-warehouse-info]");
  const warehouseCheckboxes = [...options.querySelectorAll("[data-warehouse-id]")];
  const centralCheckboxes = warehouseCheckboxes.filter((checkbox) =>
    checkbox.dataset.warehouseRole === "CENTRAL" || checkbox.value === WAREHOUSE.central,
  );
  const subsidiaryCheckboxes = warehouseCheckboxes.filter((checkbox) => !centralCheckboxes.includes(checkbox));
  const showWarehouseInfo = () => {
    document.querySelector(".table-info-tooltip")?.remove();
    const tooltip = document.createElement("div");
    tooltip.className = "table-info-tooltip";
    tooltip.textContent = warehouseInfo.dataset.tooltip;
    document.body.append(tooltip);
    const rect = warehouseInfo.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    tooltip.style.left = `${Math.max(8, Math.min(rect.left + rect.width / 2 - box.width / 2, window.innerWidth - box.width - 8))}px`;
    tooltip.style.top = `${rect.top - box.height - 9 >= 8 ? rect.top - box.height - 9 : rect.bottom + 9}px`;
  };
  const hideWarehouseInfo = () => document.querySelector(".table-info-tooltip")?.remove();
  warehouseInfo.addEventListener("pointerenter", showWarehouseInfo);
  warehouseInfo.addEventListener("pointerleave", hideWarehouseInfo);
  warehouseInfo.addEventListener("focus", showWarehouseInfo);
  warehouseInfo.addEventListener("blur", hideWarehouseInfo);
  const updateSelectionState = () => {
    const checkedCount = warehouseCheckboxes.filter((checkbox) => checkbox.checked).length;
    const checkedSubsidiaries = subsidiaryCheckboxes.filter((checkbox) => checkbox.checked).length;
    apply.disabled = checkedCount === 0;
    selectAll.checked = subsidiaryCheckboxes.length > 0 && checkedSubsidiaries === subsidiaryCheckboxes.length;
    selectAll.indeterminate = checkedSubsidiaries > 0 && checkedSubsidiaries < subsidiaryCheckboxes.length;
    centralCheckboxes.forEach((checkbox) => {
      checkbox.disabled = checkedSubsidiaries > 0;
    });
    subsidiaryCheckboxes.forEach((checkbox) => {
      checkbox.disabled = centralCheckboxes.some((central) => central.checked);
    });
    warehouseCheckboxes.forEach((checkbox) => {
      checkbox.closest(".uc1-warehouse-option")?.classList.toggle("is-disabled", checkbox.disabled);
    });
  };

  selectAll.addEventListener("change", () => {
    centralCheckboxes.forEach((checkbox) => {
      checkbox.checked = false;
    });
    subsidiaryCheckboxes.forEach((checkbox) => {
      checkbox.checked = selectAll.checked;
    });
    updateSelectionState();
  });

  warehouseCheckboxes.forEach((checkbox) => checkbox.addEventListener("change", () => {
    if (centralCheckboxes.includes(checkbox) && checkbox.checked) {
      subsidiaryCheckboxes.forEach((subsidiary) => {
        subsidiary.checked = false;
      });
    } else if (subsidiaryCheckboxes.includes(checkbox) && checkbox.checked) {
      centralCheckboxes.forEach((central) => {
        central.checked = false;
      });
    }
    updateSelectionState();
  }));
  updateSelectionState();
  menu.addEventListener("toggle", () => {
    if (menu.open) return;
    const committed = new Set(hidden.value.split(",").filter(Boolean));
    warehouseCheckboxes.forEach((checkbox) => {
      checkbox.checked = committed.has(checkbox.value);
    });
    updateSelectionState();
  });
  apply.addEventListener("click", (event) => {
    event.preventDefault();
    const ids = warehouseCheckboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
    if (!ids.length) return;
    hidden.value = ids.join(",");
    setQuery({ warehouse: hidden.value });
    menu.open = false;
  });
}

document.addEventListener("click", (event) => {
  const openMenus = document.querySelectorAll("[data-warehouse-menu][open]");
  openMenus.forEach((menu) => {
    if (!menu.contains(event.target)) {
      menu.removeAttribute("open");
    }
  });
});