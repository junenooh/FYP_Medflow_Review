import { escapeAttribute } from "@shared/utils/html.js";

const clampPct = (value) => Math.max(0, Math.min(100, value));

/**
 * Stock level bar: the track runs from 0 to the Order Up To Level (S).
 * The fill is stock on hand, the dark tick is the reorder point (s), and the tinted zone
 * just above it is the Near ROP band (ROP up to ROP + safety stock).
 * Positions are scaled for drawing only; no policy is evaluated here.
 */
export function renderBulletBar({ position, reorderPoint, safetyStock = 0, orderUpTo, kind = "ok" }) {
  const scale = Math.max(orderUpTo, position, 1);
  const positionPct = clampPct((position / scale) * 100);
  const ropPct = clampPct((reorderPoint / scale) * 100);
  const bandPct = clampPct(((reorderPoint + safetyStock) / scale) * 100) - ropPct;
  const label = `On the shelf ${position}, reorder point ${reorderPoint}, order-up-to level ${orderUpTo}`;
  return `
    <div class="bullet" role="img" aria-label="${escapeAttribute(label)}" title="${escapeAttribute(label)}">
      <span class="bullet-band" style="left:${ropPct}%;width:${Math.max(0, bandPct)}%"></span>
      <span class="bullet-fill is-${kind}" style="width:${positionPct}%"></span>
      <span class="bullet-rop" style="left:${ropPct}%"></span>
    </div>
  `;
}

/**
 * Stock over the last inventory events. Inventory rows are only written when quantity changes,
 * so the line holds its value until the next event (a step, not a slope). The hairline is the
 * reorder point; the dot is the latest position (see the key under the chart). Events are evenly spaced, not to time scale.
 */
export function renderStepChart({ history, reorderPoint, kind = "ok", width = 396, height = 156 }) {
  if (!history?.length) return "";
  const pad = { left: 34, right: 44, top: 14, bottom: 26 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(...history, reorderPoint, 1) * 1.08;
  const x = (index) => pad.left + (index / Math.max(history.length - 1, 1)) * innerW;
  const y = (value) => pad.top + innerH - (value / max) * innerH;
  let path = `M${x(0).toFixed(1)} ${y(history[0]).toFixed(1)}`;
  for (let index = 1; index < history.length; index += 1) {
    path += ` H${x(index).toFixed(1)} V${y(history[index]).toFixed(1)}`;
  }
  const last = history.length - 1;
  const ropY = y(reorderPoint);
  const points = history
    .map(
      (value, index) =>
        `<circle class="sc-hit" cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="11"><title>${escapeAttribute(index === last ? `Latest: ${value}` : `${last - index} events ago: ${value}`)}</title></circle>`,
    )
    .join("");
  const label = `Stock over the last ${history.length} stock movements: ${history.join(", ")}. Reorder point ${reorderPoint}.`;
  return `
    <svg class="step-chart" viewBox="0 0 ${width} ${height}" width="100%" role="img" aria-label="${escapeAttribute(label)}">
      <line class="sc-base" x1="${pad.left}" x2="${width - pad.right}" y1="${y(0)}" y2="${y(0)}" />
      <text class="sc-axis" x="${pad.left - 8}" y="${y(0) + 4}" text-anchor="end">0</text>
      <line class="sc-rop" x1="${pad.left}" x2="${width - pad.right}" y1="${ropY.toFixed(1)}" y2="${ropY.toFixed(1)}" />
      <path class="sc-line" d="${path}" />
      <text class="sc-axis" x="${pad.left}" y="${height - 6}" text-anchor="start">${last} events ago</text>
      <text class="sc-axis" x="${width - pad.right}" y="${height - 6}" text-anchor="end">latest</text>
      <circle class="sc-dot is-${kind}" cx="${x(last).toFixed(1)}" cy="${y(history[last]).toFixed(1)}" r="5" />
      <text class="sc-end" x="${x(last) + 12}" y="${y(history[last]) + 4}">${history[last]}</text>
      ${points}
    </svg>
  `;
}
