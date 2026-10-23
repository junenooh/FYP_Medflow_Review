import { escapeHtml } from "@shared/utils/html.js";

const STATUS_CLASS = {
  "Out of stock": "pill-oos",
  "Out of Stock": "pill-oos",
  OOS: "pill-oos",
  "Low Stock": "pill-low",
  Low: "pill-low",
  "Near ROP": "pill-near",
  Near: "pill-near",
  Available: "pill-ok",
  "Auto-order placed": "pill-near",
  // UC2 plain-language labels
  "Low stock": "pill-low",
  "In stock": "pill-ok",
  "Restock ordered": "pill-near",
  "On its way": "pill-near",
  Delivered: "pill-ok",
  "Needs attention": "pill-oos",
  "Order cancelled": "pill-oos",
  Full: "pill-ok",
  Partial: "pill-low",
  Unavailable: "pill-oos",
  Critical: "pill-crit",
  High: "pill-high",
  Medium: "pill-med",
  Deferred: "pill-near",
};

export function statusPill(label) {
  const cls = STATUS_CLASS[label] || "pill-near";
  const color =
    cls === "pill-oos" || cls === "pill-crit"
      ? "var(--oos)"
      : cls === "pill-low" || cls === "pill-high"
        ? "var(--low)"
        : cls === "pill-ok"
          ? "var(--ok)"
          : "var(--near)";
  return `<span class="pill ${cls}"><i style="background:${color}"></i>${escapeHtml(label)}</span>`;
}

export function affinityTag(strength, label = strength) {
  const key = String(strength || "Weak").toLowerCase();
  const cls = key.startsWith("strong") || key.startsWith("high")
    ? "tag-strong"
    : key.startsWith("mod") || key.startsWith("medium")
      ? "tag-moderate"
      : "tag-weak";
  return `<span class="tag ${cls}">${escapeHtml(label || "Weak")}</span>`;
}

function renderHeaderCell(col, sort) {
  const hint = col.hint ? ` title="${escapeHtml(col.hint)}"` : "";
  const num = col.align === "right" ? " num" : "";
  const label = `${escapeHtml(col.label)}${col.infoHint ? `<button type="button" class="table-info-icon" data-tooltip="${escapeHtml(col.infoHint)}" aria-label="${escapeHtml(`${col.label}: ${col.infoHint}`)}">i</button>` : ""}`;
  if (!col.sort) return `<th${num ? ' class="num"' : ""}${hint}>${label}</th>`;
  const active = sort?.key === col.key;
  const ariaSort = active ? (sort.dir === "desc" ? "descending" : "ascending") : "none";
  return `<th class="sortable${num}" data-sort="${escapeHtml(col.key)}" aria-sort="${ariaSort}"${hint}><button type="button">${label}</button></th>`;
}

export function renderTable(root, { columns = [], rows = [], sort = null } = {}) {
  const html = `
    <table class="data">
      <thead><tr>${columns.map((col) => renderHeaderCell(col, sort)).join("")}</tr></thead>
      <tbody>
        ${
          rows.length
            ? rows
                .map(
                  (row) =>
                    `<tr${row._class ? ` class="${escapeHtml(row._class)}"` : ""}${row._key ? ` data-key="${escapeHtml(row._key)}"` : ""}>${columns
                      .map((col) => {
                        const value = row[col.key] ?? "—";
                        const content = col.html ? String(value) : escapeHtml(value);
                        const classes = [col.mono ? "mono" : "", col.align === "right" ? "num" : ""].filter(Boolean).join(" ");
                        return `<td class="${classes}">${content}</td>`;
                      })
                      .join("")}</tr>`,
                )
                .join("")
            : `<tr><td colspan="${Math.max(columns.length, 1)}">No persisted rows for the current filters.</td></tr>`
        }
      </tbody>
    </table>
  `;
  if (root) root.innerHTML = html;
  return html;
}
