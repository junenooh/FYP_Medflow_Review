/**
 * LIVE UC2 data for one subsidiary warehouse, shaped exactly like the rows in sample-data.js so the
 * rest of the page renders it unchanged. Read-only; nothing is written.
 *
 * Sources
 *   uc2_policy_parameters   UC2 engine output per SKU: stock, ROP, safety stock, OUL, forecast, days of
 *                           cover, status (Low Stock / Near ROP / Available). The policy is NOT re-derived here.
 *   product                 names
 *   storage                 carton size (shippingcasepack) for whole-carton rounding
 *   orders + orderline      CW -> SW orders. Processing = on its way (Central ships the same evening),
 *                           Fulfilled = delivered on fulfilmentdate
 *   inventory               the last stock movements per SKU (the step chart in the product panel)
 *
 * Display arithmetic only (no policy is evaluated; ROP, safety stock and OUL are UC2's):
 *   inventory position  = on hand + units on their way
 *   status              = the business rule, on the inventory position:
 *                           Out of Stock  nothing on hand
 *                           Low Stock     position <= ROP
 *                           Near ROP      ROP < position <= ROP + safety stock
 *                           Available     above that
 *                         (UC2's own stockstatus compares stock on hand only, so a SKU with enough on
 *                         its way would still read Low Stock there.)
 *   recommendedorderqty = OUL - position for Low Stock / Out of Stock SKUs whose position is at or
 *                         below the reorder point; otherwise 0
 *   cartons             = units rounded UP to whole cartons
 *
 * The orders come from the simulation: the history was raised under the starting (pre-UC2) policy, days
 * added by scripts/live/day.py reorder on UC2's policy. Every line reached its own reorder point, so each
 * line is a trigger; UC1 companions are not part of these orders.
 */

import { envError, requireSupabase } from "@shared/data/supabase.js";

const PAGE = 1000;               // PostgREST returns at most 1,000 rows per request
const ORDER_LIMIT = 30;          // most recent orders shown on the Auto-orders tab
const EVENT_WINDOW_DAYS = 14;    // stock movements read for the step chart
const EVENTS_PER_SKU = 8;        // points on the step chart
const COMPANION_STRENGTHS = ["Strong", "Moderate"];   // UC1 pairs shown beside a product (docs: Weak is noise)

const DAY_MS = 86400000;
const round1 = (value) => Math.round(Number(value) * 10) / 10;
const isoDay = (date) => date.toISOString().slice(0, 10);
const addDays = (iso, days) => isoDay(new Date(Date.parse(`${iso}T00:00:00Z`) + days * DAY_MS));

const PAGES_AT_ONCE = 4;         // pages read in parallel after the first (one at a time took ~10 s for 14 days of stock moves; more at once hits statement timeouts)

/** Every row of a query, 1,000 at a time. `build` must return a fresh, ordered query each call. */
async function readAll(build) {
  const page = async (index) => {
    const { data, error } = await build().range(index * PAGE, index * PAGE + PAGE - 1);
    if (error) throw error;
    return data ?? [];
  };
  const rows = await page(0);
  // A full page means there may be more: read the next batch together, until a page comes back short.
  for (let next = 1; rows.length === next * PAGE; next += PAGES_AT_ONCE) {
    const batch = await Promise.all(Array.from({ length: PAGES_AT_ONCE }, (_, offset) => page(next + offset)));
    batch.forEach((data) => rows.push(...data));
  }
  return rows;
}

/** Raw rows for one subsidiary. */
export async function readRaw(db, warehouseId) {
  const policy = await readAll(() =>
    db
      .from("uc2_policy_parameters")
      .select(
        "productid,asofdate,computedat,method,demandclass,avgdailydemand,safetystock,reorderpoint," +
          "orderuptolevel,currentstock,daysofcover,stockstatus,leadtimedays,isdormant," +
          "flag_demand_spiked,flag_demand_dropped,flag_possible_stockout",
      )
      .eq("warehouseid", warehouseId)
      .order("productid"),
  );
  if (!policy.length) return { policy };
  const ids = policy.map((row) => row.productid);
  const asof = policy[0].asofdate;
  const since = addDays(asof, -EVENT_WINDOW_DAYS);

  const recentOrders = async () => {
    const { data, error } = await db
      .from("orders")
      .select("orderid,orderdate,fulfilmentdate,status")
      .eq("warehouseid", warehouseId)
      .order("orderdate", { ascending: false })
      .order("orderid", { ascending: false })
      .limit(ORDER_LIMIT);
    if (error) throw error;
    return data ?? [];
  };

  const [products, storage, orders, events, pairs] = await Promise.all([
    readAll(() => db.from("product").select("productid,productname").in("productid", ids).order("productid")),
    readAll(() => db.from("storage").select("productid,shippingcasepack").in("productid", ids).order("productid")),
    recentOrders(),
    readAll(() =>
      db
        .from("inventory")
        .select("inventoryid,productid,qtyonhand,lastupdated,orderid")
        .eq("warehouseid", warehouseId)
        .gte("lastupdated", since)
        .order("lastupdated")
        .order("inventoryid"),
    ),
    // UC1 companions for this subsidiary. Read only to show beside a product; nothing is ordered from them.
    readAll(() =>
      db
        .from("productrelationship")
        .select("relationshipid,consequent_productid,strength,lift,confidence,productrelationshipantecedent(antecedent_productid)")
        .eq("warehouseid", warehouseId)
        .in("strength", COMPANION_STRENGTHS)
        .order("relationshipid"),
    ).catch((err) => {
      console.warn(`UC1 companions for ${warehouseId} not read`, err);
      return [];
    }),
  ]);
  const orderIds = orders.map((order) => order.orderid);
  const lines = orderIds.length
    ? await readAll(() =>
        db
          .from("orderline")
          .select("orderlineid,orderid,productid,qtyordered")
          .in("orderid", orderIds)
          .order("orderlineid"),
      )
    : [];
  return { policy, products, storage, orders, lines, events, pairs };
}

/**
 * UC1 rules -> productid -> [{ productid, strength, lift, confidence }], strongest first.
 * A pair counts both ways (A with B is also B with A); when both directions exist the stronger one is
 * kept. Only two-product rules are used, the only kind UC1 writes today.
 */
export function companionMap(pairs = []) {
  const RANK = { Strong: 0, Moderate: 1 };
  const better = (a, b) => (RANK[a.strength] ?? 9) - (RANK[b.strength] ?? 9) || b.lift - a.lift;
  const map = new Map();
  const add = (from, to, rule) => {
    if (!from || !to || from === to) return;
    if (!map.has(from)) map.set(from, new Map());
    const entry = { productid: to, strength: rule.strength, lift: Number(rule.lift) || 0, confidence: Number(rule.confidence) || 0 };
    const current = map.get(from).get(to);
    if (!current || better(entry, current) < 0) map.get(from).set(to, entry);
  };
  pairs.forEach((rule) => {
    const antecedents = (rule.productrelationshipantecedent || []).map((row) => row.antecedent_productid);
    if (antecedents.length !== 1) return;
    add(antecedents[0], rule.consequent_productid, rule);
    add(rule.consequent_productid, antecedents[0], rule);
  });
  return new Map([...map].map(([id, list]) => [id, [...list.values()].sort(better)]));
}

/** Turns raw rows into { skus, orders, snapshotAt, asof, computedat }. Pure: easy to test. */
export function assemble(raw, warehouseId) {
  const { policy, products = [], storage = [], orders = [], lines = [], events = [], pairs = [] } = raw;
  const asof = policy[0].asofdate;
  const snapshotAt = `${asof}T23:59:00`;
  const names = new Map(products.map((row) => [row.productid, row.productname]));
  const carton = new Map(storage.map((row) => [row.productid, Number(row.shippingcasepack) || 1]));
  const policyById = new Map(policy.map((row) => [row.productid, row]));
  const nameOf = (id) => names.get(id) || id;
  const cartonOf = (id) => Math.max(1, carton.get(id) || 1);

  /* ---- orders ---------------------------------------------------- */
  const linesByOrder = new Map();
  lines.forEach((line) => {
    if (!linesByOrder.has(line.orderid)) linesByOrder.set(line.orderid, []);
    linesByOrder.get(line.orderid).push(line);
  });
  const liveOrders = orders.map((order) => {
    const delivered = order.status === "Fulfilled";
    const rows = (linesByOrder.get(order.orderid) || []).map((line) => {
      const units = Number(line.qtyordered) || 0;
      // a 'C' suffix on the line id marks a companion: ordered with its UC1 partner before it reached
      // its own reorder point (the can-order rule in scripts/live/day.py)
      const isCompanion = /C$/.test(String(line.orderlineid || ""));
      return {
        productid: line.productid,
        productname: nameOf(line.productid),
        cartons: Math.ceil(units / cartonOf(line.productid)),
        units,
        role: isCompanion ? "companion" : "trigger",
        companion: null,
        reason: isCompanion
          ? "Ordered with its UC1 partner"
          : `Stock ran low on ${new Date(`${order.orderdate}T00:00:00`).toLocaleDateString([], { day: "numeric", month: "short" })}`,
      };
    });
    rows.sort((a, b) => (a.role === b.role ? 0 : a.role === "trigger" ? -1 : 1)
      || b.units - a.units || a.productid.localeCompare(b.productid));
    const lead = Math.round(Number(policyById.get(rows[0]?.productid)?.leadtimedays) || 2);
    // not delivered by the end of the data, so it arrives the day after at the earliest
    const expected = addDays(order.orderdate, lead) > asof ? addDays(order.orderdate, lead) : addDays(asof, 1);
    return {
      orderid: order.orderid,
      // Central ships every order the same evening: an order from the last day is "placed",
      // older open orders are already on their way.
      status: delivered ? "Fulfilled" : order.orderdate === asof ? "Processing" : "In Transit",
      triggerid: rows[0]?.productid ?? "",
      placedat: `${order.orderdate}T23:30:00`, // the nightly reorder check (scripts/live/day.py, scripts/sim/generate.py)
      expectedat: delivered ? null : expected,
      deliveredat: delivered ? order.fulfilmentdate : null,
      lines: rows,
    };
  });

  // per SKU: units on their way, its open order, its most recent delivery
  const transit = new Map();
  const openOrder = new Map();
  const lastDelivery = new Map();
  const weekAgo = Date.parse(snapshotAt) - 7 * DAY_MS;
  liveOrders.forEach((order) => {
    order.lines.forEach((line) => {
      if (order.status !== "Fulfilled") {
        transit.set(line.productid, (transit.get(line.productid) || 0) + line.units);
        if (!openOrder.has(line.productid)) openOrder.set(line.productid, { order, line });
      } else if (!lastDelivery.has(line.productid) && Date.parse(order.deliveredat) >= weekAgo) {
        lastDelivery.set(line.productid, { order, line });
      }
    });
  });

  /* ---- recent stock movements ----------------------------------- */
  const history = new Map();
  events.forEach((event) => {
    if (!history.has(event.productid)) history.set(event.productid, []);
    history.get(event.productid).push(event);
  });

  /* ---- SKU rows ---------------------------------------------------- */
  const skus = policy.map((row) => {
    const productid = row.productid;
    const onHand = Math.max(0, Math.round(Number(row.currentstock) || 0));
    const onTheWay = transit.get(productid) || 0;
    const position = onHand + onTheWay;
    const rop = Math.round(Number(row.reorderpoint) || 0);
    const safety = Math.round(Number(row.safetystock) || 0);
    const oul = Math.round(Number(row.orderuptolevel) || 0);
    const avg = Number(row.avgdailydemand) || 0;
    const dormant = avg <= 0 || row.isdormant;
    const status = dormant
      ? "Available"
      : onHand <= 0
        ? "Out of Stock"
        : position <= rop
          ? "Low Stock"
          : position <= rop + safety
            ? "Near ROP"
            : "Available";
    const due = (status === "Low Stock" || status === "Out of Stock") && position <= rop;
    const qty = due ? Math.max(0, oul - position) : 0;
    const perCarton = cartonOf(productid);
    // whole cartons, the same rule the reorder check uses: nearest to the gap, never fewer than it
    // takes to lift the position above the reorder point, at least one when an order is due
    const cartons = qty > 0
      ? Math.max(Math.round(qty / perCarton), Math.ceil((rop - position + 1) / perCarton), 1)
      : 0;
    const days = row.daysofcover != null ? Number(row.daysofcover) : avg > 0 ? onHand / avg : 999;

    const own = history.get(productid) || [];
    const recent = own.slice(-EVENTS_PER_SKU);
    const last = recent[recent.length - 1];
    const open = openOrder.get(productid);
    const delivered = status === "Available" || status === "Near ROP" ? lastDelivery.get(productid) : null;
    const pick = open || delivered;
    const order = pick
      ? {
          orderid: pick.order.orderid,
          status: pick.order.status,
          triggerid: productid,
          placedat: pick.order.placedat,
          expectedat: pick.order.expectedat,
          deliveredat: pick.order.deliveredat,
          cartons: pick.line.cartons,
          units: pick.line.units,
        }
      : null;

    return {
      productid,
      warehouseid: warehouseId,   // with asof: lets the product panel read this product's daily stock
      asof,
      productname: nameOf(productid),
      qtyonhand: onHand,
      intransit: onTheWay,
      reorderpoint: rop,
      safetystock: safety,
      orderuptolevel: oul,
      recommendedorderqty: qty,
      status,
      avgdailydemand: round1(avg),
      usenote: "based on recent daily use",
      daysofsupply: Math.min(999, round1(days)),
      leadtimedays: round1(row.leadtimedays || 0),
      unitspercarton: perCarton,
      ordercartons: cartons,
      orderunits: cartons * perCarton,
      order,
      duenote: due && !open ? "Raised at the next reorder check" : null,
      lasteventat: last ? last.lastupdated : `${addDays(asof, -EVENT_WINDOW_DAYS)}T00:00:00`,
      lasteventtype: last ? (last.orderid ? "Delivery received" : "Handed out to hospitals") : `No movement in the last ${EVENT_WINDOW_DAYS} days`,
      history: recent.length ? recent.map((event) => Number(event.qtyonhand)) : [onHand],
      flags: {
        spiked: Boolean(row.flag_demand_spiked),
        dropped: Boolean(row.flag_demand_dropped),
        possibleStockout: Boolean(row.flag_possible_stockout),
      },
    };
  });

  // UC1 companions beside each product, linked to the companion's own row so its stock can be shown.
  const byId = new Map(skus.map((sku) => [sku.productid, sku]));
  const related = companionMap(pairs);
  skus.forEach((sku) => {
    sku.companions = (related.get(sku.productid) || [])
      .filter((pair) => byId.has(pair.productid))
      .map((pair) => ({ ...pair, sku: byId.get(pair.productid) }));
  });

  // Inside each order: which lines are UC1 companions of another line on the same order. Every line
  // was still ordered for its own reorder point; the pair just ran low on the same night.
  liveOrders.forEach((order) => {
    const onOrder = new Map(order.lines.map((line) => [line.productid, line]));
    order.lines.forEach((line) => {
      line.pairedWith = (related.get(line.productid) || [])
        .filter((pair) => onOrder.has(pair.productid))
        .map((pair) => ({ ...pair, productname: onOrder.get(pair.productid).productname }));
      if (line.role === "companion") {
        // the strongest rule linking this companion to a trigger line on the same order
        const partner = line.pairedWith.find((pair) => onOrder.get(pair.productid)?.role === "trigger") || line.pairedWith[0];
        if (partner) {
          line.companion = { strength: partner.strength, lift: Math.round(partner.lift * 10) / 10 };
          line.reason = `Ordered with ${partner.productname} (${partner.strength})`;
        }
      }
    });
    order.pairs = order.lines.reduce((sum, line) => sum + line.pairedWith.length, 0) / 2;
  });

  // Last day the stock ledger moved. Later than asof means UC2 has not been rerun since.
  const ledgerday = events.reduce((latest, event) => {
    const dayOf = String(event.lastupdated).slice(0, 10);
    return dayOf > latest ? dayOf : latest;
  }, "");

  return {
    warehouseId,
    skus,
    orders: liveOrders,
    asof,
    ledgerday: ledgerday || null,
    snapshotAt,
    computedat: policy[0].computedat,
  };
}

/** { ok: true, data } or { ok: false, message }. Never throws, so the page can fall back to the sample. */
export async function fetchLiveUc2(warehouseId) {
  const missing = envError();
  if (missing) return { ok: false, message: missing };
  try {
    // A busy database cancels slow reads ("statement timeout"); one more try usually gets through.
    const raw = await readRaw(requireSupabase(), warehouseId).catch(async (err) => {
      if (!/statement timeout/i.test(String(err?.message))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      return readRaw(requireSupabase(), warehouseId);
    });
    if (!raw.policy.length) {
      return { ok: false, message: `No UC2 policy rows for ${warehouseId} yet. Run python -m engines.uc2.replenishment.` };
    }
    return { ok: true, data: assemble(raw, warehouseId) };
  } catch (err) {
    return { ok: false, message: String(err?.message || err) };
  }
}

/**
 * One read per subsidiary per page load, shared by the UC2 page and the notification bell.
 * warehouseid -> { promise, result }. A failed read is cached too, so the page shows its fallback
 * instead of retrying on every render; clearLiveUc2() starts over (the bell's Refresh).
 */
const liveCache = new Map();

export function loadLiveUc2(warehouseId) {
  let entry = liveCache.get(warehouseId);
  if (!entry) {
    entry = { result: null };
    entry.promise = fetchLiveUc2(warehouseId).then((result) => {
      entry.result = result;
      return result;
    });
    liveCache.set(warehouseId, entry);
  }
  return entry.promise;
}

/** The finished read for a subsidiary, or null while it is pending or not started. */
export function peekLiveUc2(warehouseId) {
  return liveCache.get(warehouseId)?.result ?? null;
}

export function clearLiveUc2() {
  liveCache.clear();
}
