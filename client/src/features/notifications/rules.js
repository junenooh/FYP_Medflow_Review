/**
 * Notification rules: UC2 output for one subsidiary -> the alerts worth a planner's attention.
 *
 * Pure (no DOM, no database), so it can be tested on plain objects. Input is the shape returned by
 * features/uc2-replenishment/live-data.js (`assemble`), plus the hospital shortfalls read by the store.
 * Nothing here re-derives UC2's policy: ROP, safety stock, OUL and days of cover are UC2's numbers.
 *
 * Written for an operations manager, not an analyst: every alert says what happened, what it means
 * for the hospitals, and whether anyone has to act (`action`). Technical detail, where there is any,
 * goes in `tech` and is only shown on hover.
 *
 * Levels
 *   urgent   a stockout has happened or is about to happen
 *     oos        nothing on hand
 *     runout     stock runs out before the order that refills it can arrive
 *     shortfall  a hospital asked for more than the subsidiary could hand out (qtyissued < qtyrequested)
 *   warning  worth checking: a number may be misleading
 *     demand     UC2 flagged a spike, a drop, or demand hidden by an empty shelf
 *     stale      the stock ledger has moved on but UC2 has not been rerun
 *   info     what the automatic replenishment did
 *     reorder    an order was raised at the latest reorder check
 *     delivered  an order arrived on the latest day
 *
 * Several alerts of one kind at one warehouse are folded into one entry (GROUP_OVER), so a day with
 * 12 demand spikes reads as "12 products show unusual demand", not 12 rows.
 *
 * Every alert carries a stable id that includes the as-of day: dismissing it lasts until the data
 * moves on a day, and a problem that is still there the next day comes back as unread.
 */

import { displayName } from "../../shared/utils/names.js";

export { displayName };

export const LEVELS = Object.freeze(["urgent", "warning", "info"]);
/** Short labels for the filter tabs. */
export const LEVEL_LABEL = Object.freeze({ urgent: "Urgent", warning: "Check", info: "Updates" });
/** Section headings in the list. */
export const LEVEL_HEADING = Object.freeze({
  urgent: "Urgent: hospitals affected",
  warning: "Worth checking",
  info: "Updates",
});
const LEVEL_RANK = { urgent: 0, warning: 1, info: 2 };
const KIND_RANK = { oos: 0, runout: 1, shortfall: 2, stale: 3, demand: 4, reorder: 5, delivered: 6 };

export const KIND_LABEL = Object.freeze({
  oos: "Out of stock",
  runout: "Will run out",
  shortfall: "Hospital shortage",
  demand: "Unusual demand",
  stale: "Out-of-date figures",
  reorder: "Restock ordered",
  delivered: "Restock delivered",
});

/**
 * Does anyone need to do something? tone: act (someone should step in), check (have a look),
 * handled (the system is already dealing with it), fyi (nothing to do).
 */
const ACTION = {
  act: (label = "Needs action") => ({ label, tone: "act" }),
  check: (label = "Worth a check") => ({ label, tone: "check" }),
  handled: (label) => ({ label, tone: "handled" }),
  fyi: (label = "No action needed") => ({ label, tone: "fyi" }),
};
const TONE_RANK = { act: 0, check: 1, handled: 2, fyi: 3 };

/** More than this many alerts of one kind at one warehouse are shown as a single group. */
export const GROUP_OVER = 3;

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const DAY_MS = 86400000;
const dayMs = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
export const daysBetween = (from, to) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS);
export const formatDay = (iso) =>
  new Date(`${String(iso).slice(0, 10)}T00:00:00`).toLocaleDateString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

/**
 * When an alert happened: "Wed 14 Oct, 11:00 pm" when the data has a time, else just the day.
 * Data times are local (no zone), like the rest of the page.
 */
export function formatAt(at) {
  const value = String(at || "");
  if (!value) return "";
  if (value.length <= 10) return formatDay(value);
  const time = new Date(value.slice(0, 19)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${formatDay(value)}, ${time}`;
}

/** "tomorrow (Tue 6 Oct)", "in 3 days (Thu 8 Oct)", seen from the as-of day. */
export function whenFrom(asof, iso) {
  const n = daysBetween(asof, iso);
  const rel = n === 0 ? "today" : n === 1 ? "tomorrow" : n > 1 ? `in ${n} days` : `${-n} days ago`;
  return `${rel} (${formatDay(iso)})`;
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const aboutDays = (value) => {
  if (value < 1) return "less than a day";
  const n = Math.round(value);
  return `about ${plural(n, "day")}`;
};

const skuHref = (wh, productid) =>
  `#/uc2?warehouse=${encodeURIComponent(wh)}&tab=skus&sku=${encodeURIComponent(productid)}`;
/** The Restocks tab with this restock opened and marked. */
const orderHref = (wh, orderid) =>
  `#/uc2?warehouse=${encodeURIComponent(wh)}&tab=orders&order=${encodeURIComponent(orderid)}`;
const tabHref = (wh, tab, status = "") =>
  `#/uc2?warehouse=${encodeURIComponent(wh)}&tab=${tab}${status ? `&status=${encodeURIComponent(status)}` : ""}`;

const isOpen = (order) => order && order.status !== "Fulfilled";

function productAlert(kind, level, wh, asof, sku, { title, detail, action, tech = "", at = null }) {
  // When it happened: the stock movement that left the product like this, else the data day.
  const moved = sku.lasteventat && !String(sku.lasteventtype || "").startsWith("No movement");
  return {
    id: `${kind}:${wh}:${sku.productid}:${asof}`,
    kind,
    level,
    warehouseId: wh,
    productid: sku.productid,
    productname: displayName(sku.productname || sku.productid),
    title,
    detail,
    action,
    tech,
    day: asof,
    at: at || (moved ? sku.lasteventat : asof),
    href: skuHref(wh, sku.productid),
  };
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

/** One SKU's urgent stock alert, if any: out of stock, or out of stock before its refill arrives. */
function stockAlert(sku, wh, asof) {
  if (!(sku.avgdailydemand > 0)) return null;            // not used: an empty shelf is not a problem
  const name = displayName(sku.productname || sku.productid);
  const order = isOpen(sku.order) ? sku.order : null;
  const tech = `On hand ${sku.qtyonhand} · reorder point ${sku.reorderpoint} · uses about ${sku.avgdailydemand} a day`;

  if (sku.qtyonhand <= 0) {
    return productAlert("oos", "urgent", wh, asof, sku, order?.expectedat
      ? {
          title: `${name} is out of stock`,
          detail: `${sku.order.units.toLocaleString()} units arrive ${whenFrom(asof, order.expectedat)}.`,
          action: ACTION.handled("Delivery on the way"),
          tech: `${tech} · order ${order.orderid}`,
        }
      : {
          title: `${name} is out of stock`,
          detail: "A restock is ordered automatically tonight.",
          action: ACTION.handled("Ordering tonight"),
          tech,
        });
  }

  // Deliveries land at 08:00, so stock has to last the full days in between, not the arrival day.
  if (order?.expectedat) {
    const daysNeeded = daysBetween(asof, order.expectedat) - 1;
    if (daysNeeded > 0 && sku.daysofsupply < daysNeeded) {
      const gap = daysNeeded - sku.daysofsupply;
      return productAlert("runout", "urgent", wh, asof, sku, {
        title: `${name} will run out before restock`,
        detail: `Stock lasts ${aboutDays(sku.daysofsupply)}; the restock arrives ${whenFrom(asof, order.expectedat)}. Gap of ${aboutDays(gap)}.`,
        action: ACTION.act("Urgent transfer"),
        tech: `${tech} · order ${order.orderid}`,
      });
    }
  } else if (sku.recommendedorderqty > 0 && sku.daysofsupply < sku.leadtimedays) {
    return productAlert("runout", "urgent", wh, asof, sku, {
      title: `${name} will run out before restock`,
      detail: `Stock lasts ${aboutDays(sku.daysofsupply)}; a restock takes ${aboutDays(sku.leadtimedays)} to arrive.`,
      action: ACTION.act("Urgent transfer"),
      tech,
    });
  }
  return null;
}

/** UC2's own warning flags, folded into one alert per SKU (the most serious flag names it). */
function demandAlert(sku, wh, asof) {
  const flags = sku.flags || {};
  const name = displayName(sku.productname || sku.productid);
  const tech = `UC2 flag · reorder point ${sku.reorderpoint} · uses about ${sku.avgdailydemand} a day`;
  if (flags.possibleStockout) {
    return productAlert("demand", "warning", wh, asof, sku, {
      title: `${name}: demand may be hidden`,
      detail: "Shelf empty and nothing handed out for 30 days.",
      action: ACTION.check("Check with hospitals"),
      tech,
    });
  }
  if (flags.spiked) {
    return productAlert("demand", "warning", wh, asof, sku, {
      title: `${name}: demand jumped`,
      detail: "Hospitals asked for much more than usual. Check it isn't a one-off.",
      action: ACTION.check(),
      tech,
    });
  }
  if (flags.dropped) {
    return productAlert("demand", "warning", wh, asof, sku, {
      title: `${name}: demand has slowed`,
      detail: "Hospitals are using much less than usual.",
      action: ACTION.check(),
      tech,
    });
  }
  return null;
}

/**
 * Shortfalls: [{ productid, requested, issued, requests, lastday }] for the last few days, one per
 * SKU (the store aggregates the request lines).
 */
function shortfallAlerts(shortfalls, byId, wh, asof) {
  return shortfalls
    .filter((row) => row.requested > row.issued)
    .map((row) => {
      const sku = byId.get(row.productid) || { productid: row.productid, productname: row.productid };
      const name = displayName(sku.productname || sku.productid);
      const missing = row.requested - row.issued;
      return productAlert("shortfall", "urgent", wh, asof, sku, {
        title: `${name} short-supplied to hospitals`,
        detail: `${plural(missing, "unit")} couldn't be supplied (${plural(row.requests, "request")}, last ${formatDay(row.lastday)}).`,
        action: ACTION.act("Stockout happened"),
        tech: `Requested ${row.requested.toLocaleString()} · supplied ${row.issued.toLocaleString()}`,
        at: row.lastday,
      });
    });
}

function orderAlerts(orders, wh, asof) {
  const out = [];
  orders.forEach((order) => {
    const units = order.lines.reduce((sum, line) => sum + (line.units || 0), 0);
    const products = plural(order.lines.length, "product");
    if (String(order.placedat).slice(0, 10) === asof && order.status !== "Fulfilled") {
      out.push({
        id: `reorder:${wh}:${order.orderid}`,
        kind: "reorder",
        level: "info",
        warehouseId: wh,
        orderid: order.orderid,
        title: `Restock ordered for ${products}`,
        detail: `${units.toLocaleString()} units from Central${order.expectedat ? `, arriving ${whenFrom(asof, order.expectedat)}` : ""}.`,
        action: ACTION.fyi("Automatic"),
        tech: `Order ${order.orderid}`,
        day: asof,
        at: order.placedat,
        href: orderHref(wh, order.orderid),
      });
    }
    if (order.status === "Fulfilled" && order.deliveredat === asof) {
      out.push({
        id: `delivered:${wh}:${order.orderid}`,
        kind: "delivered",
        level: "info",
        warehouseId: wh,
        orderid: order.orderid,
        title: `Restock delivered: ${products}`,
        detail: `${units.toLocaleString()} units now on the shelf.`,
        action: ACTION.fyi("Done"),
        tech: `Order ${order.orderid}`,
        day: asof,
        at: `${order.deliveredat}T08:00:00`, // deliveries are received at 08:00
        href: orderHref(wh, order.orderid),
      });
    }
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Grouping and ordering                                               */
/* ------------------------------------------------------------------ */

const GROUP_TITLE = {
  oos: (n) => `${plural(n, "product")} out of stock`,
  runout: (n) => `${plural(n, "product")} will run out before delivery`,
  shortfall: (n) => `${plural(n, "product")} short-supplied to hospitals`,
  demand: (n) => `${plural(n, "product")} show unusual demand`,
};
/** The Stock status tab showing only these products, labelled with why (the alert kind). */
const focusHref = (wh, kind, ids) =>
  `#/uc2?warehouse=${encodeURIComponent(wh)}&tab=skus&focus=${ids.map(encodeURIComponent).join(",")}&focuswhy=${kind}`;

/** A group's action: the most pressing of its members ("Delivery on the way" only if all have one). */
function groupAction(members) {
  const top = members.reduce((best, m) => (TONE_RANK[m.action.tone] < TONE_RANK[best.action.tone] ? m : best));
  const same = members.every((m) => m.action.label === top.action.label);
  if (same || top.action.tone !== "handled") return top.action;
  return ACTION.handled("Being restocked");
}

/** Folds product alerts of one kind at one warehouse into a group when there are more than GROUP_OVER. */
export function groupAlerts(items, over = GROUP_OVER) {
  const buckets = new Map();
  const out = [];
  items.forEach((item) => {
    if (!item.productid || !GROUP_TITLE[item.kind]) {
      out.push(item);
      return;
    }
    const key = `${item.kind}:${item.warehouseId}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(item);
  });
  buckets.forEach((members) => {
    if (members.length <= over) {
      out.push(...members);
      return;
    }
    const [first] = members;
    const names = members.slice(0, 3).map((m) => m.productname);
    const rest = members.length - names.length;
    out.push({
      id: `${first.kind}:${first.warehouseId}:group:${first.day}`,
      kind: first.kind,
      level: first.level,
      warehouseId: first.warehouseId,
      group: true,
      children: members,
      title: GROUP_TITLE[first.kind](members.length),
      detail: `${names.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}.`,
      action: groupAction(members),
      tech: "",
      day: first.day,
      at: members.reduce((latest, m) => (String(m.at || "") > String(latest || "") ? m.at : latest), null),
      href: focusHref(first.warehouseId, first.kind, members.map((m) => m.productid)),
    });
  });
  return out;
}

export function sortAlerts(items) {
  return [...items].sort(
    (a, b) =>
      LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
      TONE_RANK[a.action.tone] - TONE_RANK[b.action.tone] ||
      KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
      String(a.warehouseId).localeCompare(String(b.warehouseId)) ||
      (b.children?.length || 0) - (a.children?.length || 0) ||
      String(a.title).localeCompare(String(b.title)),
  );
}

/**
 * All alerts for one subsidiary.
 *   data        { skus, orders, asof, ledgerday } from live-data.js
 *   shortfalls  aggregated hospital shortfalls (optional)
 */
export function buildAlerts({ warehouseId, data, shortfalls = [] }) {
  const { skus = [], orders = [], asof, ledgerday } = data;
  const byId = new Map(skus.map((sku) => [sku.productid, sku]));
  const items = [];

  skus.forEach((sku) => {
    const stock = stockAlert(sku, warehouseId, asof);
    if (stock) items.push(stock);
    const demand = demandAlert(sku, warehouseId, asof);
    if (demand) items.push(demand);
  });
  items.push(...shortfallAlerts(shortfalls, byId, warehouseId, asof));

  if (ledgerday && ledgerday > asof) {
    items.push({
      id: `stale:${warehouseId}:${asof}:${ledgerday}`,
      kind: "stale",
      level: "warning",
      warehouseId,
      title: `Stock figures for ${warehouseId} may be out of date`,
      detail: `Reorder points are from ${formatDay(asof)}, stock from ${formatDay(ledgerday)}. Ask the admin to run the daily update.`,
      action: ACTION.check("Ask the admin"),
      tech: "Run python -m engines.uc2.replenishment",
      day: ledgerday,
      at: ledgerday,
      href: tabHref(warehouseId, "skus"),
    });
  }
  items.push(...orderAlerts(orders, warehouseId, asof));
  return items;
}

/** Counts per level, a group counting once. */
export function countByLevel(items) {
  const counts = { all: items.length, urgent: 0, warning: 0, info: 0 };
  items.forEach((item) => {
    counts[item.level] += 1;
  });
  return counts;
}

/** Products behind a list of alerts (a group counts its members). */
const productsIn = (items) => items.flatMap((item) => (item.group ? item.children : item.productid ? [item] : []));

/**
 * Headline for the top of the panel and the toast: what to do first (lead), then the counts (detail).
 * { tone: "act" | "handled" | "ok", lead, detail, text }   text = both, for one-line use
 */
export function headline(items) {
  const urgent = productsIn(items.filter((item) => item.level === "urgent"));
  if (!urgent.length) {
    const checks = productsIn(items.filter((item) => item.level === "warning")).length;
    const lead = "No stock problems";
    const detail = checks ? `${plural(checks, "product")} worth a check` : "";
    return { tone: "ok", lead, detail, text: detail ? `${lead} · ${detail}` : lead };
  }
  const where = new Set(urgent.map((a) => a.warehouseId)).size;
  const byKind = (kind) => urgent.filter((a) => a.kind === kind).length;
  const detail = [
    byKind("oos") && `${byKind("oos")} out of stock`,
    byKind("runout") && `${byKind("runout")} may run out`,
    byKind("shortfall") && `${byKind("shortfall")} short-supplied`,
    plural(where, "subsidiary", "subsidiaries"),
  ]
    .filter(Boolean)
    .join(" · ");
  const needsAction = urgent.filter((a) => a.action.tone === "act").length;
  const lead = needsAction
    ? `${plural(needsAction, "product")} need${needsAction === 1 ? "s" : ""} action`
    : "Restocks are on the way";
  return { tone: needsAction ? "act" : "handled", lead, detail, text: `${lead} · ${detail}` };
}
