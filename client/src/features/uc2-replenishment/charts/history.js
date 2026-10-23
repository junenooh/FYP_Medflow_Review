import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";

/** Status per day, mildest first. The colors live in history.css (--hc-0 … --hc-3). */
export const STATUS_META = Object.freeze([
  { code: 0, label: "In stock" },
  { code: 1, label: "Near ROP" },
  { code: 2, label: "Low stock" },
  { code: 3, label: "Out of stock" },
]);

const shortDate = (date) => date.toLocaleDateString([], { day: "numeric", month: "short" });
const longDate = (date) => date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

/* ------------------------------------------------------------------ */
/* Sparkline for the stat tiles                                        */
/* ------------------------------------------------------------------ */

/** 12-point trend in the de-emphasis hue; the current (last) period carries the accent dot. */
export function renderSpark(values, { label = "Trend" } = {}) {
  if (!values?.length) return "";
  const width = 96;
  const height = 34;
  const pad = 6;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index) => pad + (index / Math.max(values.length - 1, 1)) * (width - pad * 2);
  const y = (value) => height - pad - ((value - min) / span) * (height - pad * 2);
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(" ");
  const last = values.length - 1;
  return `
    <svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeAttribute(`${label}: ${values.map((v) => Math.round(v * 100) / 100).join(", ")}`)}">
      <polyline class="spark-line" points="${points}" />
      <circle class="spark-dot" cx="${x(last).toFixed(1)}" cy="${y(values[last]).toFixed(1)}" r="4" />
    </svg>`;
}

/* ------------------------------------------------------------------ */
/* Status cells                                                        */
/* ------------------------------------------------------------------ */

/** Worst status in each group of `bucket` days, with the date range for the tooltip. */
export function bucketStatuses(statuses, dates, bucket) {
  const cells = [];
  for (let from = 0; from < statuses.length; from += bucket) {
    const to = Math.min(from + bucket, statuses.length) - 1;
    cells.push({
      code: Math.max(...statuses.slice(from, to + 1)),
      from: dates[from],
      to: dates[to],
    });
  }
  return cells;
}

function cellHtml(cell, name, isLast) {
  const label = STATUS_META[cell.code].label;
  const when = cell.from.getTime() === cell.to.getTime() ? longDate(cell.from) : `${shortDate(cell.from)} – ${shortDate(cell.to)}`;
  return `<i class="hc hc-${cell.code}${isLast ? " is-today" : ""}" data-tip-value="${escapeAttribute(label)}" data-tip-title="${escapeAttribute(`${name} · ${when}`)}"></i>`;
}

/** One SKU's strip of cells (used in the product panel and in each calendar row). */
export function renderStrip(statuses, dates, name, bucket = 1) {
  const cells = bucketStatuses(statuses, dates, bucket);
  return `<div class="hc-strip" style="--cols:${cells.length}" role="img" aria-label="${escapeAttribute(`${name}: status per day, latest ${STATUS_META[statuses[statuses.length - 1]].label}`)}">${cells
    .map((cell, index) => cellHtml(cell, name, index === cells.length - 1))
    .join("")}</div>`;
}

/* ------------------------------------------------------------------ */
/* Calendar                                                            */
/* ------------------------------------------------------------------ */

/**
 * SKU × day heatmap. Every cell uses the same status scale, so colors compare across rows.
 * rows: [{ productid, name, statuses (window), riskDays, real }]
 */
export function renderCalendar(rows, dates, bucket) {
  const columns = Math.ceil(dates.length / bucket);
  const marks = [0, Math.floor(columns / 3), Math.floor((columns * 2) / 3), columns - 1];
  const axis = marks
    .map((index, position) => {
      const cell = bucketStatuses(new Array(dates.length).fill(0), dates, bucket)[index];
      const label = position === marks.length - 1 ? "Today" : shortDate(cell.from);
      const left = ((index + 0.5) / columns) * 100;
      const align = position === 0 ? "start" : position === marks.length - 1 ? "end" : "mid";
      return `<span class="cal-mark is-${align}" style="left:${left}%">${escapeHtml(label)}</span>`;
    })
    .join("");
  const body = rows
    .map(
      (row) => `
      <div class="cal-row${row.real ? " is-linked" : ""}" ${row.real ? `role="button" tabindex="0" data-open-sku="${escapeAttribute(row.productid)}" aria-label="Show details for ${escapeAttribute(row.name)}"` : ""}>
        <span class="cal-name"><b>${escapeHtml(row.name)}</b><small>${escapeHtml(row.productid)}</small></span>
        ${renderStrip(row.statuses, dates, row.name, bucket)}
        <span class="cal-risk" title="Days at or below its reorder point in this period">${row.riskDays} d</span>
      </div>`,
    )
    .join("");
  return `
    <div class="cal">
      <div class="cal-head"><span></span><div class="cal-axis">${axis}</div><span class="cal-risk-head" title="Days low or out of stock in this period">Days low</span></div>
      ${body}
    </div>`;
}

/* ------------------------------------------------------------------ */
/* Tooltip (text only)                                                 */
/* ------------------------------------------------------------------ */

/** One tooltip for every cell. Values are set with textContent, never as HTML. */
export function bindTips(host) {
  let tip = host.querySelector(":scope > .hist-tip");
  if (!tip) {
    tip = document.createElement("div");
    tip.className = "hist-tip";
    tip.hidden = true;
    tip.innerHTML = `<b data-v></b><span data-t></span>`;
    host.appendChild(tip);
  }
  const hide = () => {
    tip.hidden = true;
  };
  host.addEventListener("pointermove", (event) => {
    const target = event.target.closest("[data-tip-value]");
    if (!target || !host.contains(target)) return hide();
    tip.querySelector("[data-v]").textContent = target.dataset.tipValue;
    tip.querySelector("[data-t]").textContent = target.dataset.tipTitle;
    tip.hidden = false;
    const box = host.getBoundingClientRect();
    const cell = target.getBoundingClientRect();
    tip.style.left = `${Math.min(Math.max(cell.left - box.left + cell.width / 2, 90), box.width - 90)}px`;
    tip.style.top = `${cell.top - box.top}px`;
  });
  host.addEventListener("pointerleave", hide);
}
