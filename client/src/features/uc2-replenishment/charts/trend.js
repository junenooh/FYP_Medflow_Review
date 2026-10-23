import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";

/**
 * Stock over the last N days for one product, kept deliberately quiet:
 *   the stock on the shelf each day (a step line: it is the closing count per day),
 *   the reorder point that was in force each day (dashed, steps where it changed),
 *   a triangle under each delivery, and red along the bottom on days the shelf was empty.
 * No coloured zones: the only alarm colour is an empty shelf. Each day carries its details in
 * data-tip; the panel reads the chosen day out under the chart (tap or point), so nothing is hover-only.
 *
 *   stock       closing stock per day, oldest first (null = no data that day)
 *   dates       Date per day, same length
 *   rop         ROP per day (array), or one number for every day
 *   ordered     [{ day, qty, orderid }]   used for the delivery tooltip ("ordered 2 days before")
 *   deliveries  [{ day, qty, orderid }]
 *   onWay       units ordered earlier and not yet delivered, per day (shown in the tooltip)
 *   kind        today's status kind (oos | low | near | ok), colours today's point
 */

const W = 340;
const H = 150;
const PAD = { top: 16, right: 30, bottom: 30, left: 34 };
const n = (value) => Number(value).toLocaleString();
const short = (date) => date.toLocaleDateString([], { day: "numeric", month: "short" });
const long = (date) => date.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });

/** A round top for the y axis just above the largest value (700 for a peak of 650, not 1,000). */
function niceMax(value) {
  if (value <= 0) return 10;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10].find((m) => m * power >= value) ?? 10;
  return step * power;
}

export function renderStockTrend({ stock, dates, rop, ordered = [], deliveries = [], onWay = [], kind = "ok" }) {
  const days = stock.length;
  const values = stock.map((value) => (value == null ? null : Math.max(0, Number(value))));
  const known = values.filter((value) => value != null);
  if (!known.length) return `<p class="drawer-foot">No daily stock recorded for this product yet.</p>`;
  const levels = Array.isArray(rop) && rop.length === days ? rop.map((v) => Number(v) || 0) : new Array(days).fill(Number(rop) || 0);

  const top = niceMax(Math.max(...known, ...levels) * 1.1);
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const step = innerW / days;
  const x = (index) => PAD.left + index * step;
  const y = (value) => PAD.top + innerH - (Math.min(value, top) / top) * innerH;
  const base = y(0);

  // a step path through per-day values: each day's value holds across that day
  const stepPath = (list) => {
    let d = "";
    list.forEach((value, index) => {
      if (value == null) return;
      const yy = y(value).toFixed(1);
      d += `${d ? " L" : "M"}${x(index).toFixed(1)} ${yy} L${x(index + 1).toFixed(1)} ${yy}`;
    });
    return d;
  };

  const empties = values
    .map((value, index) => (value === 0 ? `<rect class="st-empty" x="${x(index).toFixed(1)}" y="${(base - 3).toFixed(1)}" width="${step.toFixed(1)}" height="3" />` : ""))
    .join("");

  const markY = base + 9;
  const triangle = (cx) => `M${cx.toFixed(1)} ${markY - 4} L${(cx + 4.5).toFixed(1)} ${markY + 4} L${(cx - 4.5).toFixed(1)} ${markY + 4} Z`;
  const deliveryMarks = deliveries
    .filter((d) => d.day >= 0 && d.day < days)
    .map((d) => `<path class="st-delivered" d="${triangle(x(d.day) + step / 2)}" />`)
    .join("");

  const hits = values
    .map((value, index) => {
      if (value == null) return "";
      // In the order the day happened: morning delivery, closing count, night order, still coming.
      const sum = (list) => list.filter((item) => item.day === index).reduce((total, item) => total + item.qty, 0);
      const delivered = sum(deliveries);
      const placed = sum(ordered);
      const parts = [index === days - 1 ? "Today" : long(dates[index])];
      if (delivered) parts.push(`${n(delivered)} delivered in the morning`);
      parts.push(value === 0 ? `shelf empty by closing` : `${n(value)} on the shelf at closing`);
      if (placed) parts.push(`${n(placed)} more ordered at night`);
      if (onWay[index] > 0) parts.push(`${n(onWay[index])} ${delivered || placed ? "still " : ""}on the way`);
      const tip = parts.join(" · ");
      return `<rect class="st-hit" x="${x(index).toFixed(1)}" y="${PAD.top}" width="${step.toFixed(1)}" height="${(innerH + 14).toFixed(1)}" data-tip="${escapeAttribute(tip)}" />`;
    })
    .join("");

  const lastIndex = values.reduce((last, value, index) => (value == null ? last : index), -1);
  const lastValue = values[lastIndex];
  const nowX = x(lastIndex + 1);
  const nowY = y(lastValue);
  const ropNow = levels[days - 1];
  const ropY = y(ropNow);
  const mid = Math.floor(days / 2);
  const label = `Stock on the shelf over the last ${days} days, now ${n(lastValue)}. Reorder point now ${n(ropNow)}.`;

  return `
    <svg class="stock-trend" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="${escapeAttribute(label)}">
      <line class="st-grid" x1="${PAD.left}" x2="${W - PAD.right}" y1="${y(top).toFixed(1)}" y2="${y(top).toFixed(1)}" />
      <text class="st-axis" x="${PAD.left - 6}" y="${(y(top) + 3).toFixed(1)}" text-anchor="end">${n(top)}</text>
      <line class="st-base" x1="${PAD.left}" x2="${W - PAD.right}" y1="${base.toFixed(1)}" y2="${base.toFixed(1)}" />
      <text class="st-axis" x="${PAD.left - 6}" y="${(base + 3).toFixed(1)}" text-anchor="end">0</text>
      <path class="st-rop" d="${stepPath(levels)}" />
      <path class="st-line" d="${stepPath(values)}" />
      ${empties}
      ${deliveryMarks}
      <circle class="st-now is-${kind}" cx="${nowX.toFixed(1)}" cy="${nowY.toFixed(1)}" r="4" />
      <text class="st-now-label" x="${(nowX + 6).toFixed(1)}" y="${(nowY + (nowY < ropY ? -4 : 12)).toFixed(1)}">${n(lastValue)}</text>
      <text class="st-axis" x="${PAD.left}" y="${H - 4}" text-anchor="start">${escapeHtml(short(dates[0]))}</text>
      <text class="st-axis" x="${(x(mid) + step / 2).toFixed(1)}" y="${H - 4}" text-anchor="middle">${escapeHtml(short(dates[mid]))}</text>
      <text class="st-axis" x="${W - PAD.right}" y="${H - 4}" text-anchor="end">Today</text>
      ${hits}
    </svg>`;
}

/**
 * Three plain facts above the chart: daily use, the last delivery, and the lowest the shelf got
 * (so a near-miss shows, not just "never ran out"). Red at 0, amber below the reorder point.
 */
export function trendFacts({ stock, dates, rop, deliveries = [], use }) {
  const lastDelivery = [...deliveries].sort((a, b) => b.day - a.day)[0];
  let runs = 0;
  let low = null;
  stock.forEach((value, index) => {
    if (value === 0 && stock[index - 1] !== 0) runs += 1;
    if (value != null && (low == null || value < stock[low])) low = index;
  });
  const levels = Array.isArray(rop) ? rop : stock.map(() => rop);
  const lowest = low == null ? null : stock[low];
  const lowTone = lowest == null ? "" : lowest === 0 ? "bad" : lowest <= (Number(levels[low]) || 0) ? "warn" : "good";
  // Ran out: say so, with how often (and when, if it was once). Otherwise the lowest it got and when.
  const ranOut = lowest === 0;
  const lowLabel = ranOut ? "Ran out" : "Lowest stock";
  const lowText =
    lowest == null ? "–" : ranOut ? (runs === 1 ? `Once (${short(dates[low])})` : `${runs} times`) : `${n(lowest)} (${short(dates[low])})`;
  const fact = (label, value, tone = "") =>
    `<div class="st-fact${tone ? ` is-${tone}` : ""}"><span>${escapeHtml(label)}</span><b>${escapeHtml(value)}</b></div>`;
  return `
    <div class="st-facts">
      ${fact("Daily use", use > 0 ? `~${use < 10 ? Number(use.toFixed(1)) : n(Math.round(use))}` : "None")}
      ${fact("Last delivery", lastDelivery ? `${short(dates[lastDelivery.day])} (+${n(lastDelivery.qty)})` : "None")}
      ${fact(lowLabel, lowText, lowTone)}
    </div>`;
}
