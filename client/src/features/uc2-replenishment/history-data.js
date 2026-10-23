/**
 * LIVE History for one subsidiary: the last 90 days, from tables the dashboard can read.
 * Builds the same shape as sample-history.js, so the History tab and the product panel show it unchanged.
 *
 * Sources (read-only)
 *   consumption        closing stock per product per day (zero-filled by UC2, so every day is there)
 *   orders + orderline what was ordered, when it was placed and when it arrived
 *   warehouseproduct   the STARTING reorder points: the ones the simulated history actually ordered on
 *   UC2 rows on page   today's UC2 reorder points, for days after the simulated history ends
 *
 * Status per product per day (the page's own rule, on the inventory position):
 *   position     = closing stock that day + units ordered on an EARLIER day and not yet delivered
 *                  (an order raised at a day's evening check counts from the next day, so the day it
 *                  was raised shows the stock that triggered it)
 *   Out of Stock   closing stock 0             Low Stock   position <= reorder point
 *   Near ROP       position <= reorder point + safety stock          Available   above that
 * UC2 does not keep its past reorder points (each run replaces them), so a past day is judged against
 * the level that was in force: the starting level up to the end of the simulated history
 * (scripts/sim/sim_config.json end_date), UC2's level after it.
 *
 * Events: an order placed (23:30 on its order date), an order delivered (08:00 on its delivery date),
 * and a product running out (23:00, when the day's hand-outs are recorded, on the first day its closing stock is 0).
 */

import { requireSupabase } from "@shared/data/supabase.js";
import { displayName } from "@shared/utils/names.js";
import simConfig from "../../../../scripts/sim/sim_config.json";

export const LIVE_HISTORY_DAYS = 90;
const PAGE = 1000;
const DAY_MS = 86400000;
const SG_OFFSET_MS = 8 * 3600000;               // the data's day boundary is Singapore midnight
const HISTORY_END = simConfig?.end_date || null; // last day ordered on the starting levels

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (iso, days) => isoDay(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS);
const sgDay = (timestamp) => isoDay(Date.parse(timestamp) + SG_OFFSET_MS);
const pad = (value) => String(value).padStart(2, "0");

const PRODUCTS_PER_READ = Math.floor(PAGE / LIVE_HISTORY_DAYS); // 11 products x 90 days fit one page
const ORDERS_PER_READ = 5;                                       // ~150 lines per order at a subsidiary
const READS_AT_ONCE = 10;

/**
 * Every row of a query, one page after another until a page comes back short. A page the database
 * cancels when busy ("statement timeout") is tried once more.
 */
async function readPages(build) {
  const page = async (index, retry = true) => {
    const { data, error } = await build().range(index * PAGE, index * PAGE + PAGE - 1);
    if (error && retry && /statement timeout/i.test(error.message)) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return page(index, false);
    }
    if (error) throw error;
    return data ?? [];
  };
  const rows = [];
  for (let index = 0; rows.length === index * PAGE; index += 1) rows.push(...(await page(index)));
  return rows;
}

/**
 * The rows for a long list of keys, split into small reads run READS_AT_ONCE at a time. Small keyed
 * reads stay fast; paging deep into one big result (OFFSET 40,000+) got cancelled by the database,
 * and ~90 pages at once pushed it past its statement timeout too.
 */
async function readByKeys(keys, size, build) {
  const chunks = [];
  for (let i = 0; i < keys.length; i += size) chunks.push(keys.slice(i, i + size));
  const rows = [];
  for (let i = 0; i < chunks.length; i += READS_AT_ONCE) {
    const batch = await Promise.all(chunks.slice(i, i + READS_AT_ONCE).map((chunk) => readPages(() => build(chunk))));
    batch.forEach((data) => rows.push(...data));
  }
  return rows;
}

/** `productIds`: the products to read. With just one (the product panel's quick read) every read is narrowed to it. */
async function readRaw(db, warehouseId, asof, productIds) {
  const single = productIds.length === 1;
  const one = (query) => (single ? query.eq("productid", productIds[0]) : query);
  const from = addDays(asof, -(LIVE_HISTORY_DAYS - 1));
  const since = `${from}T00:00:00+08:00`;
  // One product: its order lines in one read, alongside the rest (orderids are PO-<warehouse>-<date>),
  // instead of waiting for the orders and then reading their lines in ~20 batches.
  const productLines = single
    ? readPages(() =>
        one(db.from("orderline").select("orderlineid,orderid,productid,qtyordered"))
          .like("orderid", `PO-${warehouseId}-%`)
          .order("orderlineid"),
      )
    : null;
  productLines?.catch(() => {}); // awaited below; this only stops an early failure elsewhere leaving it unhandled
  const [consumption, orders, starting] = await Promise.all([
    readByKeys(productIds, PRODUCTS_PER_READ, (chunk) =>
      db
        .from("consumption")
        .select("productid,consumptiondate,closingqty")
        .eq("warehouseid", warehouseId)
        .gte("consumptiondate", since)
        .in("productid", chunk)
        .order("productid")
        .order("consumptiondate"),
    ),
    db
      .from("orders")
      .select("orderid,orderdate,fulfilmentdate,status")
      .eq("warehouseid", warehouseId)
      .order("orderdate")
      .then(({ data, error }) => {
        if (error) throw error;
        return data ?? [];
      }),
    one(
      db
        .from("warehouseproduct")
        .select("productid,reorderpoint,safetystock,orderuptolevel,leadtimedays")
        .eq("warehouseid", warehouseId),
    ).then(({ data, error }) => (error ? [] : data ?? [])),
  ]);
  // Lines only for orders that can matter to the window: still open, or delivered inside it.
  const relevant = orders.filter((o) => o.status !== "Fulfilled" || !o.fulfilmentdate || o.fulfilmentdate >= from);
  const relevantIds = relevant.map((o) => o.orderid);
  const lines = single
    ? (await productLines).filter((line) => relevantIds.includes(line.orderid))
    : await readByKeys(relevantIds, ORDERS_PER_READ, (chunk) =>
        db.from("orderline").select("orderlineid,orderid,productid,qtyordered").in("orderid", chunk).order("orderlineid"),
      );
  return { consumption, orders: relevant, lines, starting, from };
}

/**
 * Pure: raw rows + the page's UC2 rows -> { skus, episodes, events, orders, stockouts, dayDate, days }.
 * `skus` are the live rows on the page (names, today's UC2 reorder point and safety stock, lead time).
 */
export function buildLiveHistory(raw, liveSkus, asof) {
  // product names in normal case here (the database stores most in capitals)
  const skus = liveSkus.map((sku) => ({ ...sku, productname: displayName(sku.productname) }));
  const days = LIVE_HISTORY_DAYS;
  const from = addDays(asof, -(days - 1));
  const dayIso = (index) => addDays(from, index);
  const indexOf = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
  const dayDate = (index) => new Date(`${dayIso(index)}T00:00:00`);
  const stamp = (index, hour, minute = 0) => `${dayIso(index)}T${pad(hour)}:${pad(minute)}:00`;

  const byId = new Map(skus.map((sku) => [sku.productid, sku]));
  const starting = new Map(raw.starting.map((row) => [row.productid, row]));

  // closing stock per product per day
  const closing = new Map();
  raw.consumption.forEach((row) => {
    if (!byId.has(row.productid)) return;
    const index = indexOf(sgDay(row.consumptiondate));
    if (index < 0 || index >= days) return;
    if (!closing.has(row.productid)) closing.set(row.productid, new Array(days).fill(null));
    closing.get(row.productid)[index] = Number(row.closingqty) || 0;
  });

  // units on their way at the end of each day, per product
  const orderById = new Map(raw.orders.map((order) => [order.orderid, order]));
  const linesByOrder = new Map();
  const transit = new Map();
  raw.lines.forEach((line) => {
    const order = orderById.get(line.orderid);
    if (!order || !byId.has(line.productid)) return;
    if (!linesByOrder.has(order.orderid)) linesByOrder.set(order.orderid, []);
    linesByOrder.get(order.orderid).push(line);
    const qty = Number(line.qtyordered) || 0;
    // On its way from the day after it was placed: the order is raised at the evening check, so the
    // day it was raised shows the stock that triggered it (Low), not the stock it was topped up to.
    const start = Math.max(0, indexOf(order.orderdate) + 1);
    const delivered = order.status === "Fulfilled" && order.fulfilmentdate ? indexOf(order.fulfilmentdate) : days;
    if (!transit.has(line.productid)) transit.set(line.productid, new Array(days).fill(0));
    const row = transit.get(line.productid);
    for (let i = start; i < Math.min(delivered, days); i += 1) row[i] += qty;
  });

  const levelFor = (sku, index) => {
    const usesStart = HISTORY_END && dayIso(index) <= HISTORY_END && starting.has(sku.productid);
    const base = usesStart ? starting.get(sku.productid) : sku;
    return { rop: Number(base.reorderpoint) || 0, ss: Number(base.safetystock) || 0 };
  };

  // daily status codes: 0 Available, 1 Near ROP, 2 Low Stock, 3 Out of Stock (null before data starts)
  const historySkus = [];
  const productRop = new Map();      // productid -> ROP per day
  const stockouts = [];
  const events = [];
  skus.forEach((sku) => {
    const stock = closing.get(sku.productid);
    if (!stock) return;
    const onWay = transit.get(sku.productid) || new Array(days).fill(0);
    const dormant = !(sku.avgdailydemand > 0);
    let previous = null;
    // the reorder point in force each day; today's is UC2's, the one tonight's check uses
    const ropSeries = stock.map((_, index) => (index === days - 1 ? Number(sku.reorderpoint) || 0 : levelFor(sku, index).rop));
    productRop.set(sku.productid, ropSeries);
    const statuses = stock.map((value, index) => {
      if (value == null) return 0;
      const { rop, ss } = levelFor(sku, index);
      const position = value + onWay[index];
      const code = dormant ? 0 : value <= 0 ? 3 : position <= rop ? 2 : position <= rop + ss ? 1 : 0;
      if (code === 3 && previous !== 3) {
        stockouts.push({ productid: sku.productid, day: index });
        const waiting = [...linesByOrder.entries()].find(([orderid, lines]) => {
          const order = orderById.get(orderid);
          const placed = indexOf(order.orderdate);
          const arrived = order.fulfilmentdate ? indexOf(order.fulfilmentdate) : days;
          return placed <= index && arrived > index && lines.some((l) => l.productid === sku.productid);
        });
        events.push({
          productid: sku.productid,
          productname: sku.productname,
          orderid: waiting ? waiting[0] : "",
          at: stamp(index, 23),
          type: "stockout",
          title: `${sku.productname} ran out`,
          detail: waiting ? `Restock ${waiting[0]} was already on its way` : "Nothing on hand at the end of the day",
        });
      }
      previous = code;
      return code;
    });
    historySkus.push({ productid: sku.productid, name: sku.productname, real: true, statuses });
  });

  // one episode per product per order (for per-product counts), one record per order (for the tiles)
  const episodes = [];
  const orderRecords = [];
  const productEvents = new Map();   // productid -> its own orders, deliveries and stock-outs
  const productFlow = new Map();     // productid -> { ordered: [{ day, qty }], deliveries: [{ day, qty }] }
  raw.orders.forEach((order) => {
    const lines = linesByOrder.get(order.orderid) || [];
    if (!lines.length) return;
    const start = indexOf(order.orderdate);
    const end = order.status === "Fulfilled" && order.fulfilmentdate ? indexOf(order.fulfilmentdate) : null;
    if ((end ?? days) < 0 || start >= days) return;
    const planned = Math.round(
      lines.reduce((sum, l) => sum + (Number(byId.get(l.productid)?.leadtimedays) || 0), 0) / lines.length,
    );
    orderRecords.push({ orderid: order.orderid, start, end, planned });
    lines.forEach((line) => {
      const own = byId.get(line.productid)?.productname || line.productid;
      const qty = (Number(line.qtyordered) || 0).toLocaleString();
      const mine = productEvents.get(line.productid) || [];
      if (start >= 0) {
        mine.push({ productid: line.productid, productname: own, orderid: order.orderid, at: stamp(start, 23, 30), type: "order",
          title: `Ordered ${qty} units`, detail: `Restock ${order.orderid}` });
      }
      if (end != null && end >= 0 && end < days) {
        mine.push({ productid: line.productid, productname: own, orderid: order.orderid, at: stamp(end, 8), type: "delivered",
          title: `${qty} units delivered`, detail: `Restock ${order.orderid} · took ${end - start} ${end - start === 1 ? "day" : "days"}` });
      }
      productEvents.set(line.productid, mine);
      const flow = productFlow.get(line.productid) || { ordered: [], deliveries: [] };
      const units = Number(line.qtyordered) || 0;
      if (start >= 0) flow.ordered.push({ day: start, qty: units, orderid: order.orderid });
      if (end != null && end >= 0 && end < days) flow.deliveries.push({ day: end, qty: units, orderid: order.orderid });
      productFlow.set(line.productid, flow);
      episodes.push({
        productid: line.productid,
        productname: byId.get(line.productid)?.productname || line.productid,
        orderid: order.orderid,
        start,
        end,
        planned,
      });
    });
    const first = byId.get(lines[0].productid)?.productname || lines[0].productid;
    const name = lines.length > 1 ? `${first} + ${lines.length - 1} more` : first;
    const units = lines.reduce((sum, l) => sum + (Number(l.qtyordered) || 0), 0);
    if (start >= 0) {
      events.push({
        productid: lines.length === 1 ? lines[0].productid : "",
        productname: name,
        orderid: order.orderid,
        at: stamp(start, 23, 30),
        type: "order",
        title: `Restock ${order.orderid} ordered`,
        detail: `${name} · ${units.toLocaleString()} units`,
      });
    }
    if (end != null && end >= 0 && end < days) {
      events.push({
        productid: lines.length === 1 ? lines[0].productid : "",
        productname: name,
        orderid: order.orderid,
        at: stamp(end, 8),
        type: "delivered",
        title: `Restock ${order.orderid} delivered`,
        detail: `${name} · took ${end - start} ${end - start === 1 ? "day" : "days"} (planned ${planned})`,
      });
    }
  });
  events.sort((a, b) => b.at.localeCompare(a.at));
  events.filter((e) => e.type === "stockout").forEach((e) => {
    if (!productEvents.has(e.productid)) productEvents.set(e.productid, []);
    productEvents.get(e.productid).push(e);
  });
  productEvents.forEach((list) => list.sort((a, b) => b.at.localeCompare(a.at)));

  const startingUntil = HISTORY_END && HISTORY_END >= from ? (HISTORY_END > asof ? asof : HISTORY_END) : null;
  return {
    days,
    dayDate,
    from,
    asof,
    startingUntil,
    history: { skus: historySkus, episodes, events },
    orders: orderRecords,
    stockouts,
    productEvents,
    productFlow,
    closing,
    productRop,
    transit,
    starting,
  };
}

/** Tile figures for the last `days` days and the period before, from a built history. */
export function liveMetrics(built, days) {
  const measure = (offset) => {
    const hi = built.days - 1 - offset * days;
    const lo = hi - days + 1;
    if (lo < 0) return null;
    const within = (index) => index != null && index >= lo && index <= hi;
    const started = built.orders.filter((o) => within(o.start));
    const total = built.history.skus.length;
    // products with an empty shelf, per day, counted once and reused
    if (!built.emptyPerDay) {
      built.emptyPerDay = Array.from({ length: built.days }, (_, index) =>
        built.history.skus.reduce((sum, sku) => sum + (sku.statuses[index] === 3 ? 1 : 0), 0),
      );
    }
    const emptyDays = (a, b) => built.emptyPerDay.slice(a, b + 1).reduce((sum, value) => sum + value, 0);
    const availability = (a, b) => (total ? 100 * (1 - emptyDays(a, b) / (total * (b - a + 1))) : 100);
    const delivered = built.orders.filter((o) => o.end != null && within(o.end));
    const outs = built.stockouts.filter((s) => within(s.day));
    const mean = (list, pick) => (list.length ? list.reduce((sum, item) => sum + pick(item), 0) / list.length : null);
    const buckets = Math.min(12, days);
    const series = (values) =>
      Array.from({ length: buckets }, (_, bucket) => {
        const a = lo + Math.floor((bucket * days) / buckets);
        const b = lo + Math.floor(((bucket + 1) * days) / buckets) - 1;
        return values(a, b);
      });
    let last = null;
    return {
      orders: { value: started.length, series: series((a, b) => started.filter((o) => o.start >= a && o.start <= b).length) },
      stockouts: { value: outs.length, series: series((a, b) => outs.filter((s) => s.day >= a && s.day <= b).length) },
      // how many different products ran out (40 stock-outs could be 40 products once, or 5 eight times)
      affected: {
        value: new Set(outs.map((s) => s.productid)).size,
        total,
        series: series((a, b) => new Set(outs.filter((s) => s.day >= a && s.day <= b).map((s) => s.productid)).size),
      },
      // share of product-days with something on the shelf
      availability: { value: availability(lo, hi), series: series((a, b) => availability(a, b)) },
      delivery: {
        value: mean(delivered, (o) => o.end - o.start),
        planned: mean(delivered, (o) => o.planned),
        series: series((a, b) => {
          const group = delivered.filter((o) => o.end >= a && o.end <= b);
          if (group.length) last = mean(group, (o) => o.end - o.start);
          return last ?? 0;
        }),
      },
    };
  };
  return { current: measure(0), previous: measure(1) };
}

/**
 * One read per subsidiary per page load. warehouseid -> { promise, result }, result being
 * { ok: true, source } or { ok: false, message }.
 */
const cache = new Map();

export function loadLiveHistory(warehouseId, skus, asof) {
  let entry = cache.get(warehouseId);
  if (!entry) {
    entry = { result: null };
    entry.promise = (async () => {
      try {
        const raw = await readRaw(requireSupabase(), warehouseId, asof, skus.map((sku) => sku.productid));
        if (!raw.consumption.length) return { ok: false, message: `No daily stock rows for ${warehouseId} yet.` };
        const built = buildLiveHistory(raw, skus, asof);
        return { ok: true, source: toSource(built) };
      } catch (err) {
        return { ok: false, message: String(err?.message || err) };
      }
    })().then((result) => {
      entry.result = result;
      return result;
    });
    cache.set(warehouseId, entry);
  }
  return entry.promise;
}

/**
 * One product's last 90 days, for the product panel while the whole subsidiary is still loading
 * (that read is ~1,000 products x 90 days). Same shape as the full history, so the panel draws it unchanged.
 */
const skuCache = new Map();   // "warehouse:product" -> { promise, result }
const skuKey = (sku) => `${sku.warehouseid}:${sku.productid}`;

export function loadSkuHistory(sku) {
  if (!sku?.warehouseid || !sku?.asof) return Promise.resolve({ ok: false, message: "Not a live product." });
  const key = skuKey(sku);
  if (!skuCache.has(key)) {
    const entry = { result: null };
    entry.promise = readRaw(requireSupabase(), sku.warehouseid, sku.asof, [sku.productid])
      .then((raw) => {
        if (!raw.consumption.length) return { ok: false, message: `No daily stock rows for ${sku.productid} yet.` };
        return { ok: true, source: toSource(buildLiveHistory(raw, [sku], sku.asof)) };
      })
      .catch((err) => {
        skuCache.delete(key); // try again next time the panel opens
        return { ok: false, message: String(err?.message || err) };
      })
      .then((result) => {
        entry.result = result;
        return result;
      });
    skuCache.set(key, entry);
  }
  return skuCache.get(key).promise;
}

/** One product's finished read, or null while it is pending or not started. */
export const peekSkuHistory = (sku) => skuCache.get(skuKey(sku))?.result ?? null;

export const peekLiveHistory = (warehouseId) => cache.get(warehouseId)?.result ?? null;
export const clearLiveHistory = () => {
  cache.clear();
  skuCache.clear();
};

/** The interface history.js and the product panel read: same as the sample's. */
function toSource(built) {
  return {
    live: true,
    HISTORY: built.history,
    HISTORY_DAYS: built.days,
    dayDate: built.dayDate,
    periodMetrics: (days) => liveMetrics(built, days),
    getSkuHistory: (productid) => {
      const sku = built.history.skus.find((row) => row.productid === productid);
      if (!sku) return null;
      const flow = built.productFlow.get(productid) || { ordered: [], deliveries: [] };
      return {
        ...sku,
        events: built.productEvents.get(productid) || [],
        stock: built.closing.get(productid) || [],      // closing stock per day, oldest first
        rop: built.productRop.get(productid) || [],      // ROP in force each day
        onWay: built.transit.get(productid) || [],       // units ordered earlier and not yet delivered, per day
        starting: built.starting.get(productid) || null, // the starting levels the history was ordered on
        ordered: flow.ordered,
        deliveries: flow.deliveries,
      };
    },
    startingUntil: built.startingUntil,
    from: built.from,
    asof: built.asof,
  };
}
