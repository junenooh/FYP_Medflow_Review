import { SAMPLE_POLICY, SAMPLE_SKUS } from "./sample-data.js";
import { buildOrderHistory, lcg } from "./sample-orders.js";

/**
 * ANALYTICAL SAMPLE of UC2 history: 90 days of daily status per SKU, plus the events behind it.
 * Real history will come from the timestamped inventory rows, one replenishmentrecommendation row per
 * engine run (generatedat, status), and orders / stocktransfer. Sample shape:
 *
 *   statuses: one code per day, oldest first, last = today. 0 Available, 1 Near ROP, 2 Low Stock, 3 Out of Stock.
 *   episode:  one auto-order. start = day it reached the reorder point, end = day it was delivered (null while open),
 *             oosDays = days out of stock before delivery. Central is assumed to have unlimited stock.
 *
 * The nine real SKUs are consistent with the rest of the page (their status today, their orders); the rest are
 * generated so the calendar can be judged at a realistic size.
 */

export const HISTORY_DAYS = 90;
export const STATUS_CODES = Object.freeze(["Available", "Near ROP", "Low Stock", "Out of Stock"]);

const DAY = 86400000;
const pad = (value) => String(value).padStart(2, "0");
const stamp = (date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
const parse = (iso) => new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);

const SNAPSHOT = new Date(SAMPLE_POLICY.snapshotAt);
const END = new Date(SNAPSHOT);
END.setHours(0, 0, 0, 0);

export const dayDate = (index) => new Date(END.getTime() - (HISTORY_DAYS - 1 - index) * DAY);
const dayIndex = (iso) => {
  const date = parse(iso);
  date.setHours(0, 0, 0, 0);
  return HISTORY_DAYS - 1 - Math.round((END - date) / DAY);
};
const stampAt = (index, hour, minute) => {
  const date = dayDate(index);
  date.setHours(hour, minute, 0, 0);
  return stamp(date > SNAPSHOT ? SNAPSHOT : date);
};

const EXTRA = [
  ["MED-1101", "Nitrile gloves (L)"],
  ["MED-1180", "Wound dressing 5 × 5 cm"],
  ["MED-1215", "Insulin syringe 1 ml"],
  ["MED-1290", "Examination mask"],
  ["MED-1344", "Cotton wool roll"],
  ["MED-1402", "Isotonic saline 500 ml"],
  ["MED-1466", "Adhesive plaster"],
  ["MED-1533", "Disposable gown"],
  ["MED-1601", "Alcohol wipes"],
  ["MED-1678", "Oxygen mask (adult)"],
  ["MED-1742", "Urine collection bag"],
  ["MED-1809", "Tourniquet"],
  ["MED-1875", "Thermometer probe cover"],
  ["MED-1930", "Sterile gauze swab"],
  ["MED-1994", "Blood glucose strips"],
];

/** Auto-orders for the real SKUs: the sample order history plus the orders on the current rows. */
function realEpisodes() {
  const episodes = [];
  buildOrderHistory().forEach((order, index) => {
    const sku = SAMPLE_SKUS.find((row) => row.productid === order.triggerid);
    episodes.push({
      productid: order.triggerid,
      orderid: order.orderid,
      start: dayIndex(order.placedat),
      end: dayIndex(order.deliveredat),
      oosDays: index % 7 === 3 ? 1 : 0,
      planned: sku.leadtimedays,
    });
  });
  SAMPLE_SKUS.forEach((sku) => {
    if (!sku.order || sku.order.triggerid !== sku.productid) return;
    episodes.push({
      productid: sku.productid,
      orderid: sku.order.orderid,
      start: dayIndex(sku.order.placedat),
      end: sku.order.status === "Fulfilled" ? dayIndex(sku.order.deliveredat) : null,
      oosDays: sku.status === "Out of Stock" ? 2 : 0,
      planned: sku.leadtimedays,
    });
  });
  return episodes;
}

function syntheticEpisodes(productid, rand, seq) {
  const count = Math.floor(rand() * 5);
  const episodes = [];
  let cursor = 3;
  for (let k = 0; k < count; k += 1) {
    const start = cursor + Math.floor(rand() * 18);
    const duration = 2 + Math.floor(rand() * 3);
    if (start >= HISTORY_DAYS) break;
    const date = dayDate(start);
    episodes.push({
      productid,
      orderid: `ORD-${pad(date.getMonth() + 1)}${pad(date.getDate())}-H${seq}${k}`,
      start,
      end: start + duration <= HISTORY_DAYS - 1 ? start + duration : null,
      oosDays: rand() < 0.3 ? 1 + Math.floor(rand() * 2) : 0,
      planned: 2 + Math.floor(rand() * 2),
    });
    cursor = start + duration + 6;
  }
  return episodes;
}

/** Worst status wins on a day where episodes overlap. */
function statusesFor(episodes, nearTail) {
  const statuses = new Array(HISTORY_DAYS).fill(0);
  const set = (index, value) => {
    if (index >= 0 && index < HISTORY_DAYS && value > statuses[index]) statuses[index] = value;
  };
  episodes.forEach((episode) => {
    const endExclusive = episode.end ?? HISTORY_DAYS;
    set(episode.start - 2, 1);
    set(episode.start - 1, 1);
    for (let index = episode.start; index < endExclusive; index += 1) set(index, 2);
    for (let index = endExclusive - episode.oosDays; index < endExclusive; index += 1) set(index, 3);
  });
  for (let index = HISTORY_DAYS - nearTail; index < HISTORY_DAYS; index += 1) set(index, 1);
  return statuses;
}

function eventsFor(episode, productid, name) {
  const events = [];
  const base = { productid, productname: name, orderid: episode.orderid };
  const hour = 7 + ((episode.start * 7 + episode.orderid.length) % 8);
  const minute = 5 + ((episode.start * 13) % 50);
  events.push({
    ...base,
    at: stampAt(episode.start, hour, minute),
    type: "order",
    title: `Order ${episode.orderid} placed`,
    detail: `${name} reached its reorder point`,
  });
  if (episode.oosDays > 0) {
    const day = (episode.end ?? HISTORY_DAYS) - episode.oosDays;
    events.push({ ...base, at: stampAt(day, 13, 20), type: "stockout", title: `${name} out of stock`, detail: `Waiting on ${episode.orderid}` });
  }
  if (episode.end != null) {
    events.push({
      ...base,
      at: stampAt(episode.end, 10, 30),
      type: "delivered",
      title: `Order ${episode.orderid} delivered`,
      detail: `${name} · ${episode.end - episode.start} days (planned ${episode.planned})`,
    });
  }
  return events;
}

function build() {
  const rand = lcg(20260921);
  const real = realEpisodes();
  const nearTail = { "MED-2210": 3, "MED-3307": 2, "MED-6001": 2, "MED-8804": 4 };
  const skus = [];
  const episodes = [];
  const events = [];
  const add = (productid, name, isReal, own, tail) => {
    const tagged = own.map((episode) => ({ ...episode, productname: name }));
    skus.push({ productid, name, real: isReal, statuses: statusesFor(tagged, tail) });
    tagged.forEach((episode) => {
      episodes.push(episode);
      events.push(...eventsFor(episode, productid, name));
    });
  };
  SAMPLE_SKUS.forEach((sku) => {
    add(sku.productid, sku.productname, true, real.filter((episode) => episode.productid === sku.productid), nearTail[sku.productid] ?? 0);
  });
  EXTRA.forEach(([id, name], index) => add(id, name, false, syntheticEpisodes(id, rand, index), 0));
  events.sort((a, b) => b.at.localeCompare(a.at));
  return { skus, episodes, events };
}

export const HISTORY = build();

export function getSkuHistory(productid) {
  const sku = HISTORY.skus.find((row) => row.productid === productid);
  if (!sku) return null;
  return { ...sku, events: HISTORY.events.filter((event) => event.productid === productid) };
}

/* ------------------------------------------------------------------ */
/* Period metrics                                                      */
/* ------------------------------------------------------------------ */

const stockoutDay = (episode) => (episode.oosDays > 0 ? (episode.end ?? HISTORY_DAYS) - episode.oosDays : null);
const inWindow = (index, [lo, hi]) => index != null && index >= lo && index <= hi;

function measure(days, offset) {
  const hi = HISTORY_DAYS - 1 - offset * days;
  const lo = hi - days + 1;
  if (lo < 0) return null;
  const window = [lo, hi];
  const started = HISTORY.episodes.filter((episode) => inWindow(episode.start, window));
  const stockouts = HISTORY.episodes.filter((episode) => inWindow(stockoutDay(episode), window));
  const delivered = HISTORY.episodes.filter((episode) => episode.end != null && inWindow(episode.end, window));
  const mean = (list, pick) => (list.length ? list.reduce((sum, item) => sum + pick(item), 0) / list.length : null);
  const buckets = Math.min(12, days);
  const series = (values) =>
    Array.from({ length: buckets }, (_, bucket) => {
      const from = lo + Math.floor((bucket * days) / buckets);
      const to = lo + Math.floor(((bucket + 1) * days) / buckets) - 1;
      return values(from, to);
    });
  let lastDelivery = null;
  return {
    orders: {
      value: started.length,
      series: series((from, to) => started.filter((e) => e.start >= from && e.start <= to).length),
    },
    stockouts: {
      value: stockouts.length,
      series: series((from, to) => stockouts.filter((e) => stockoutDay(e) >= from && stockoutDay(e) <= to).length),
    },
    delivery: {
      value: mean(delivered, (e) => e.end - e.start),
      planned: mean(delivered, (e) => e.planned),
      series: series((from, to) => {
        const group = delivered.filter((e) => e.end >= from && e.end <= to);
        if (group.length) lastDelivery = mean(group, (e) => e.end - e.start);
        return lastDelivery ?? 0;
      }),
    },
  };
}

/** Metrics for the last `days` days, plus the previous period of the same length when the history covers it. */
export function periodMetrics(days) {
  return { current: measure(days, 0), previous: measure(days, 1) };
}
