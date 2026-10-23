/**
 * Notification store: loads every subsidiary's UC2 output, turns it into alerts (rules.js) and
 * remembers which ones the viewer has read.
 *
 * Reads only (anon key): the same UC2 read as the Replenishment page (shared cache in live-data.js),
 * plus the last few days of hospital request lines for the shortfall alert. Nothing is written to the
 * database. Read state lives in this browser's localStorage, so it is per viewer and per device; if
 * storage is blocked the bell still works, it just forgets on reload.
 */

import { fetchWarehouses } from "@shared/data/engine-outputs.js";
import { envError, requireSupabase } from "@shared/data/supabase.js";
import { WAREHOUSE } from "@shared/data/tables.js";
import { clearLiveUc2, loadLiveUc2 } from "@features/uc2-replenishment/live-data.js";
import { buildAlerts, groupAlerts, sortAlerts } from "./rules.js";

const READ_KEY = "medflow.notifications.read.v1";
const READ_LIMIT = 600;
const SHORTFALL_DAYS = 3;       // the as-of day and the two before it
const PAGE = 1000;
const TZ_OFFSET = "+08:00";     // day boundary of the data (Singapore), as in shared_config.json

const state = {
  status: "idle",               // idle | loading | ready | error
  items: [],
  warehouses: [],               // subsidiaries covered
  warehouseNames: {},           // id -> warehousename
  failures: [],                 // [{ warehouseId, message }]
  asof: null,                   // latest as-of day across subsidiaries
  shortfallAccess: null,        // false when hospital request lines are not readable
  loadedAt: null,
  message: "",
};
const listeners = new Set();
let read = loadRead();
let pending = null;

function loadRead() {
  try {
    const raw = localStorage.getItem(READ_KEY);
    const ids = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids : []);
  } catch {
    return new Set();
  }
}

function saveRead() {
  try {
    localStorage.setItem(READ_KEY, JSON.stringify([...read].slice(-READ_LIMIT)));
  } catch {
    /* storage blocked: read state lasts until reload */
  }
}

function emit() {
  listeners.forEach((fn) => {
    try {
      fn(state);
    } catch (err) {
      console.error("notification listener failed", err);
    }
  });
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const getState = () => state;
export const isRead = (id) => read.has(id);

export function unreadCount(levels = ["urgent", "warning"]) {
  return state.items.filter((item) => levels.includes(item.level) && !read.has(item.id)).length;
}

export function markRead(id) {
  if (!id || read.has(id)) return;
  read.add(id);
  saveRead();
  emit();
}

export function markAllRead(items = state.items) {
  let changed = false;
  items.forEach((item) => {
    if (!read.has(item.id)) {
      read.add(item.id);
      changed = true;
    }
  });
  if (!changed) return;
  saveRead();
  emit();
}

/** Subsidiary ids, sorted, and their names (id -> warehousename). */
async function subsidiaries() {
  const result = await fetchWarehouses();
  const rows = result.ok
    ? result.rows.filter((row) => String(row.warehouserole).toUpperCase() === "SUBSIDIARY")
    : [];
  const ids = rows.map((row) => row.warehouseid).sort();
  const names = Object.fromEntries(rows.map((row) => [row.warehouseid, row.warehousename || ""]));
  return ids.length ? { ids, names } : { ids: [WAREHOUSE.subsidiary], names: {} };
}

const addDays = (iso, days) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const sgDay = (timestamp) =>
  new Date(timestamp).toLocaleDateString("en-CA", { timeZone: "Asia/Singapore" });

/**
 * Hospital request lines for the last SHORTFALL_DAYS days, aggregated per SKU where less was handed
 * out than asked for. `access` is false when the lines are hidden from this key (row level security
 * returns no rows rather than an error), detected as requests without any lines.
 */
async function readShortfalls(db, warehouseId, asof) {
  const since = `${addDays(asof, -(SHORTFALL_DAYS - 1))}T00:00:00${TZ_OFFSET}`;
  const lines = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("stocktransferline")
      .select("transferlineid,productid,qtyrequested,qtyissued,stocktransfer!inner(sourcewarehouseid,transferdate)")
      .eq("stocktransfer.sourcewarehouseid", warehouseId)
      .gte("stocktransfer.transferdate", since)
      .order("transferlineid")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    lines.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  if (!lines.length) {
    const { count } = await db
      .from("stocktransfer")
      .select("transferid", { count: "exact", head: true })
      .eq("sourcewarehouseid", warehouseId)
      .gte("transferdate", since);
    return { access: !count, rows: [] };
  }
  const bySku = new Map();
  lines.forEach((line) => {
    const requested = Number(line.qtyrequested) || 0;
    const issued = Number(line.qtyissued) || 0;
    if (issued >= requested) return;
    const day = sgDay(line.stocktransfer.transferdate);
    const row = bySku.get(line.productid) || { productid: line.productid, requested: 0, issued: 0, requests: 0, lastday: day };
    row.requested += requested;
    row.issued += issued;
    row.requests += 1;
    if (day > row.lastday) row.lastday = day;
    bySku.set(line.productid, row);
  });
  return { access: true, rows: [...bySku.values()] };
}

async function loadWarehouse(db, warehouseId) {
  const result = await loadLiveUc2(warehouseId);
  if (!result.ok) return { warehouseId, ok: false, message: result.message };
  let shortfalls = { access: null, rows: [] };
  try {
    shortfalls = await readShortfalls(db, warehouseId, result.data.asof);
  } catch (err) {
    console.warn(`hospital shortfalls for ${warehouseId} not read`, err);
  }
  return {
    warehouseId,
    ok: true,
    asof: result.data.asof,
    access: shortfalls.access,
    alerts: buildAlerts({ warehouseId, data: result.data, shortfalls: shortfalls.rows }),
  };
}

async function run() {
  const missing = envError();
  if (missing) {
    Object.assign(state, { status: "error", message: missing, items: [], failures: [] });
    emit();
    return;
  }
  state.status = "loading";
  emit();
  try {
    const db = requireSupabase();
    const { ids, names } = await subsidiaries();
    // One warehouse at a time: five big reads at once push the database past its statement timeout,
    // and the UC2 page then falls back to sample data. The UC2 page's own warehouse is cached already.
    const results = [];
    for (const id of ids) results.push(await loadWarehouse(db, id));
    const good = results.filter((r) => r.ok);
    Object.assign(state, {
      warehouses: ids,
      warehouseNames: names,
      failures: results.filter((r) => !r.ok).map((r) => ({ warehouseId: r.warehouseId, message: r.message })),
      items: sortAlerts(groupAlerts(good.flatMap((r) => r.alerts))),
      asof: good.reduce((latest, r) => (r.asof > (latest || "") ? r.asof : latest), null),
      shortfallAccess: good.some((r) => r.access === false) ? false : good.length ? true : null,
      loadedAt: new Date().toISOString(),
      status: good.length ? "ready" : "error",
      message: good.length ? "" : results[0]?.message || "UC2 output could not be read",
    });
  } catch (err) {
    Object.assign(state, { status: "error", message: String(err?.message || err) });
  }
  emit();
}

/** Loads once per page load; later calls reuse the result. */
export function load() {
  if (!pending) pending = run();
  return pending;
}

/** Reads everything again (after a new simulated day, say). Clears the shared UC2 cache too. */
export function refresh() {
  clearLiveUc2();
  pending = run();
  return pending;
}
