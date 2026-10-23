/**
 * uc4-digital-twin/index.js
 * MedFlow · UC4 Digital Twin — 3D warehouse view for LayoutRecommendation output.
 *
 * Renders WH001 as pallet racking (blue uprights, orange beams, yellow aisle
 * signs, packing benches and outbound docks) and draws every recommended move
 * as an arc from the SKU's current bin to its recommended bin.
 *
 * Framework-agnostic ES module. Peer dependency: three (r162 or newer).
 *
 *   import { createDigitalTwin } from './uc4-digital-twin';
 *   const twin = createDigitalTwin(document.querySelector('#twin'), { moves: rows });
 *   twin.setMoves(nextRows);   // after each engine refresh
 *   twin.dispose();            // on unmount
 *
 * See README.md for the data contract and the full API.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { allocateZoneBands, formatTwinZoneLabel, MAX_TWIN_AISLES, usesZoneBand } from './zone-order.js';

/* ────────────────────────────── constants ────────────────────────────── */

/** Move priority scale. Colours follow the status ramp (critical → serious → warning). */
export const PRIORITIES = Object.freeze({
  critical: Object.freeze({ key: 'critical', label: 'Critical', color: '#D40511', rank: 0 }),
  high: Object.freeze({ key: 'high', label: 'High', color: '#EC835A', rank: 1 }),
  medium: Object.freeze({ key: 'medium', label: 'Medium', color: '#FAB219', rank: 2 }),
  low: Object.freeze({ key: 'low', label: 'Low', color: '#8F98A3', rank: 3 }),
});

/** Racking defaults. Override any of these through `options.layout`. */
export const DEFAULT_LAYOUT = Object.freeze({
  name: 'WH001 · Central',
  aisles: 5, // picking aisles (A01…)
  bays: 8, // bays per rack run, counted from the main cross-aisle
  levels: 5, // beam levels; level 0 is the floor beam
  pickLevel: 1, // level used when bins are auto-placed
  aislePrefix: 'A',
  firstAisle: 1,
  zoneLabels: Object.freeze({ A: 'Fast pick', B: 'Forward pick', C: 'Reserve' }),
  stockFill: 0.35, // share of untracked rack positions drawn with pallets (0 = empty racks)
  seed: 11,
});

// Physical dimensions in metres.
const D = Object.freeze({
  aisle: 3.2,
  depth: 1.1,
  flue: 0.3,
  bay: 2.8,
  firstBeam: 0.18,
  levelGap: 1.6,
  beamH: 0.12,
  upW: 0.09,
  upD: 0.075,
  topClear: 1.0,
  pallet: 0.14,
  load: 1.12,
  walkway: 7.0,
  dock: 11.0,
  side: 3.4,
  back: 3.4,
  wallH: 11,
});

const COLORS = Object.freeze({
  upright: '#2457A5',
  beam: '#EE6A1E',
  protector: '#F5C400',
  guard: '#F07A22',
  floor: '#A9B4BE',
  slab: '#A3ACB5',
  wall: '#F2F3F4',
  skirting: '#D3D8DD',
  yellow: '#FFCC00',
  line: '#F2C200',
  column: '#F5F6F7',
  steel: '#A9B1B9',
  dark: '#2A2F35',
  red: '#C8102E',
});

const STOCK_TONES = ['#C9A47A', '#D8BD95', '#BC9265', '#ECECE8', '#E0E4E8', '#B9CADB'];
const STOCK_WEIGHTS = [0.3, 0.22, 0.12, 0.16, 0.12, 0.08];
const ZONE_TINTS = ['#FFE39A', '#D5E3F1', '#E5DDF2', '#D6EEDF', '#F4D9D2', '#E9E4D6'];

const GHOST_OPACITY = 0.16;
const DIM = 0.12;
const POLAR_MAX = Math.PI * 0.47;
const POLAR_FLOOR = Math.PI * 0.58;
const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 1, 0);
const VIEW_LABELS = { overview: 'Overview', plan: 'Plan', floor: 'Floor' };

/* ────────────────────────────── utilities ────────────────────────────── */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const natCmp = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
const normKey = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
const binKey = (id) => String(id).trim().toUpperCase();
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const num = (v, d) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);

function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic random stream for one rack position, independent of the data. */
function slotRandom(seed, ...ints) {
  let hsh = (seed * 2654435761) >>> 0;
  for (const i of ints) hsh = Math.imul(hsh ^ (i + 0x9e3779b9), 0x85ebca6b) >>> 0;
  return mulberry32(hsh);
}

function weightedPick(rnd, items, weights) {
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

const fmtSec = (s) => (s === null || s === undefined ? '—' : `${(Math.round(s * 10) / 10).toFixed(1)} s`);
const fmtInt = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString());
const fmtTotal = (s) => (s >= 90 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`);
const fmtPerPick = (m) =>
  m.dailyPicks > 0 && m.timeSavedSec !== null ? `${(m.timeSavedSec / m.dailyPicks).toFixed(1)} s` : '—';

/* ─────────────────────────── data normalisation ─────────────────────────── */

const MOVE_FIELDS = {
  sku: ['skuid', 'sku', 'skucode', 'productid', 'productcode', 'itemid', 'itemcode', 'item', 'id'],
  product: ['product', 'productname', 'skuname', 'itemname', 'name', 'description'],
  velocity: ['demandvelocity', 'velocity', 'velocityclass', 'demandclass', 'abcclass', 'abc', 'class'],
  fromBin: ['currentbin', 'currentbinid', 'currentlocation', 'frombin', 'frombinid', 'sourcebin', 'sourcebinid', 'from', 'binid', 'bin'],
  toBin: ['recommendedbin', 'recommendedbinid', 'recommendedlocation', 'tobin', 'tobinid', 'targetbin', 'targetbinid', 'newbin', 'newbinid', 'to'],
  priority: ['movepriority', 'priority', 'urgency'],
  dailyPicks: ['dailypicks', 'picksperday', 'avgdailypicks', 'averagedailypicks', 'dailypickcount', 'picks'],
  timeSavedSec: ['timesavedsec', 'timesavedseconds', 'timesaveds', 'timesaved', 'timesavedperday', 'secondssaved', 'traveltimesaved', 'savings'],
  reason: ['reason', 'rationale', 'explanation', 'why', 'notes', 'note'],
  status: ['status', 'decision', 'movestatus', 'state'],
};

const BIN_FIELDS = {
  id: ['binid', 'bin', 'bincode', 'binname', 'locationid', 'location', 'code', 'id'],
  zone: ['zoneid', 'zone', 'zonecode', 'zonename', 'area'],
  aisle: ['aisle', 'aisleid', 'aisleno', 'aislenumber', 'aislecode'],
  rack: ['racknumber', 'rackno', 'rack'],
  side: ['side', 'face', 'rackside'],
  faceNumber: ['facenumber', 'faceno'],
  bay: ['bay', 'bayid', 'bayno', 'baynumber', 'column', 'col', 'position'],
  level: ['level', 'levelid', 'levelno', 'tier', 'shelf'],
  shelfLevel: ['shelflevel'],
  binPosition: ['binposition'],
  occupancy: ['occupancy'],
  inventory: ['inventory'],
  quantityOnHand: ['totalquantityonhand', 'quantityonhand'],
  x: ['x', 'xm', 'posx', 'positionx'],
  y: ['y', 'ym', 'posy', 'positiony'],
  z: ['z', 'zm', 'posz', 'positionz'],
};

function reader(row) {
  const map = new Map();
  if (row && typeof row === 'object') {
    for (const k of Object.keys(row)) {
      const nk = normKey(k);
      if (!map.has(nk)) map.set(nk, row[k]);
    }
  }
  return (aliases) => {
    for (const a of aliases) {
      const v = map.get(a);
      if (v !== undefined && v !== null && String(v).trim() !== '') return v;
    }
    return undefined;
  };
}

function toNumber(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim().toLowerCase();
  const n = parseFloat(s.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  if (/\d\s*(min|mins|minutes)\b/.test(s)) return n * 60;
  if (/\d\s*(h|hr|hrs|hours?)\b/.test(s)) return n * 3600;
  return n;
}

function normPriority(v) {
  const s = str(v).toLowerCase();
  if (PRIORITIES[s]) return s;
  if (/crit|urgent|p0/.test(s)) return 'critical';
  if (/high|p1/.test(s)) return 'high';
  if (/low|minor|p3|p4/.test(s)) return 'low';
  return 'medium';
}

function normStatus(v) {
  const s = str(v).toLowerCase();
  if (/accept|approv|done|complete|commit/.test(s)) return 'accepted';
  if (/overrid|manual/.test(s)) return 'overridden';
  if (/reject|declin|dismiss/.test(s)) return 'rejected';
  return 'pending';
}

/**
 * Normalise engine rows into move objects. Accepts the column names of the
 * Recommended Product Moves table ("SKU ID", "Current bin", "Time Saved" …)
 * as well as snake_case / camelCase API fields.
 * @param {object[]} rows
 */
export function normalizeMoves(rows) {
  const out = [];
  (Array.isArray(rows) ? rows : []).forEach((row, i) => {
    const get = reader(row);
    const fromBin = str(get(MOVE_FIELDS.fromBin));
    const toBin = str(get(MOVE_FIELDS.toBin));
    if (!fromBin || !toBin || binKey(fromBin) === binKey(toBin)) return;
    out.push({
      id: `move-${i}`,
      sku: str(get(MOVE_FIELDS.sku)) || `Row ${i + 1}`,
      product: str(get(MOVE_FIELDS.product)),
      velocity: str(get(MOVE_FIELDS.velocity)),
      fromBin,
      toBin,
      priority: normPriority(get(MOVE_FIELDS.priority)),
      dailyPicks: toNumber(get(MOVE_FIELDS.dailyPicks)),
      timeSavedSec: toNumber(get(MOVE_FIELDS.timeSavedSec)),
      reason: str(get(MOVE_FIELDS.reason)),
      status: normStatus(get(MOVE_FIELDS.status)),
      raw: row,
    });
  });
  return out;
}

/**
 * Normalise bin-table rows. Each bin may carry a slot address
 * (aisle, bay, level, side) or twin-space coordinates in metres (x, z, optional y).
 * @param {object[]} rows
 */
export function normalizeBins(rows) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const get = reader(row);
    const id = str(get(BIN_FIELDS.id));
    if (!id) continue;
    out.push({
      id,
      key: binKey(id),
      zone: str(get(BIN_FIELDS.zone)) || null,
      aisle: get(BIN_FIELDS.aisle),
      side: get(BIN_FIELDS.side),
      rackNumber: get(BIN_FIELDS.rack),
      faceNumber: get(BIN_FIELDS.faceNumber),
      bay: get(BIN_FIELDS.bay),
      level: get(BIN_FIELDS.level),
      shelfLevel: get(BIN_FIELDS.shelfLevel),
      binPosition: get(BIN_FIELDS.binPosition),
      occupancy: str(get(BIN_FIELDS.occupancy)).toLowerCase() || null,
      inventory: Array.isArray(get(BIN_FIELDS.inventory)) ? get(BIN_FIELDS.inventory) : [],
      totalQuantityOnHand: toNumber(get(BIN_FIELDS.quantityOnHand)),
      x: toNumber(get(BIN_FIELDS.x)),
      y: toNumber(get(BIN_FIELDS.y)),
      z: toNumber(get(BIN_FIELDS.z)),
      raw: row,
    });
  }
  return out;
}

function parseIndex(v, base) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v) - base : null;
  const s = String(v).trim();
  const m = s.match(/(\d+)(?!.*\d)/);
  if (m) return parseInt(m[1], 10) - base;
  if (/^[a-z]$/i.test(s)) return s.toUpperCase().charCodeAt(0) - 65;
  return null;
}

function parseSide(v) {
  const s = str(v).toLowerCase();
  if (/^(l|left|w|west|-1)$/.test(s)) return -1;
  if (/^(r|right|e|east|1|\+1)$/.test(s)) return 1;
  return null;
}

/* ──────────────────────────── layout model ──────────────────────────── */

function resolveLayout(opts) {
  const o = opts || {};
  const L = { ...DEFAULT_LAYOUT, zoneLabels: { ...DEFAULT_LAYOUT.zoneLabels, ...(o.zoneLabels || {}) } };
  for (const k of ['name', 'aislePrefix']) if (typeof o[k] === 'string') L[k] = o[k];
  L.aisles = Math.round(clamp(num(o.aisles, L.aisles), 1, MAX_TWIN_AISLES));
  L.aisleCodes = Array.isArray(o.aisleCodes) ? o.aisleCodes.map(String) : [];
  L.bays = Math.round(clamp(num(o.bays, L.bays), 2, 40));
  L.levels = Math.round(clamp(num(o.levels, L.levels), 1, 8));
  L.pickLevel = Math.round(clamp(num(o.pickLevel, L.pickLevel), 0, L.levels - 1));
  L.zoneOrder = Array.isArray(o.zoneOrder) ? o.zoneOrder.map(String) : [];
  L.groupBinsByZone = o.groupBinsByZone === true;
  L.firstAisle = Math.round(num(o.firstAisle, L.firstAisle));
  L.stockFill = clamp(num(o.stockFill, L.stockFill), 0, 1);
  L.seed = Math.round(num(o.seed, L.seed));
  return L;
}

/**
 * Rack rows run front→back (−z) from the main cross-aisle at z = 0.
 * Aisles sit between rows; the outer rows are single-sided, inner rows back-to-back.
 * The packing benches are front-left, the outbound docks front-right.
 */
function buildModel(layout) {
  const A = layout.aisles;
  const racks = [];
  const aisles = [];
  let x = 0;
  const addRack = (x0, aisle, side, row) => racks.push({ index: racks.length, x0, x1: x0 + D.depth, aisle, side, row });
  addRack(x, 0, -1, 0);
  x += D.depth;
  for (let a = 0; a < A; a += 1) {
    aisles.push({
      index: a,
      x0: x,
      x1: x + D.aisle,
      code: layout.aisleCodes[a] || `${layout.aislePrefix}${String(a + layout.firstAisle).padStart(2, '0')}`,
    });
    x += D.aisle;
    if (a < A - 1) {
      addRack(x, a, 1, a + 1); // right-hand rack of aisle a
      addRack(x + D.depth + D.flue, a + 1, -1, a + 1); // left-hand rack of aisle a+1
      x += 2 * D.depth + D.flue;
    } else {
      addRack(x, a, 1, a + 1);
      x += D.depth;
    }
  }
  const off = -x / 2;
  for (const r of racks) {
    r.x0 += off;
    r.x1 += off;
    r.cx = (r.x0 + r.x1) / 2;
    r.faceX = r.side < 0 ? r.x1 : r.x0; // face that opens onto the aisle
  }
  for (const a of aisles) {
    a.x0 += off;
    a.x1 += off;
    a.cx = (a.x0 + a.x1) / 2;
    a.left = racks.find((r) => r.aisle === a.index && r.side === -1);
    a.right = racks.find((r) => r.aisle === a.index && r.side === 1);
  }
  const rows = [];
  for (const r of racks) {
    if (!rows[r.row]) rows[r.row] = { index: r.row, racks: [] };
    rows[r.row].racks.push(r);
  }
  for (const row of rows) {
    row.x0 = Math.min(...row.racks.map((r) => r.x0));
    row.x1 = Math.max(...row.racks.map((r) => r.x1));
    row.cx = (row.x0 + row.x1) / 2;
    row.double = row.racks.length > 1;
  }
  const runLen = layout.bays * D.bay;
  const levelY = (l) => D.firstBeam + l * D.levelGap;
  const bounds = { x0: off - D.side, x1: -off + D.side, z0: -runLen - D.back, z1: D.walkway + D.dock };
  return {
    layout,
    racks,
    aisles,
    rows,
    runLen,
    zBack: -runLen,
    levelY,
    bayZ: (b) => -(b + 0.5) * D.bay,
    uprightH: levelY(layout.levels - 1) + D.topClear,
    bounds,
    width: bounds.x1 - bounds.x0,
    depth: bounds.z1 - bounds.z0,
    center: new THREE.Vector3((bounds.x0 + bounds.x1) / 2, 0, (bounds.z0 + bounds.z1) / 2),
  };
}

/* ──────────────────────────── bin placement ──────────────────────────── */

function slotBin(model, e, a, s, b, l, auto, zone) {
  const aisle = model.aisles[a];
  const rack = s < 0 ? aisle.left : aisle.right;
  const z = model.bayZ(b);
  const y = model.levelY(l) + D.pallet + D.load / 2;
  return {
    id: e.id,
    key: e.key,
    zone: zone || null,
    aisle: a,
    aisleNumber: e.aisle,
    aisleCode: aisle.code,
    rackNumber: e.rackNumber,
    shelfLevel: e.shelfLevel,
    faceNumber: e.faceNumber,
    binPosition: e.binPosition,
    occupancy: e.occupancy,
    inventory: e.inventory,
    totalQuantityOnHand: e.totalQuantityOnHand,
    side: s,
    bay: b,
    level: l,
    auto,
    pos: new THREE.Vector3(rack.cx, y, z),
    size: new THREE.Vector3(D.depth - 0.12, D.load, D.bay - 0.3),
    face: new THREE.Vector3(rack.faceX, y, z),
    aisleX: aisle.cx,
    floor: new THREE.Vector3(aisle.cx, 0, z),
  };
}

function freeBin(model, e) {
  let best = model.aisles[0];
  for (const a of model.aisles) if (Math.abs(a.cx - e.x) < Math.abs(best.cx - e.x)) best = a;
  const y = e.y !== null && e.y !== undefined ? e.y : model.levelY(model.layout.pickLevel) + D.pallet + D.load / 2;
  const pos = new THREE.Vector3(e.x, y, e.z);
  return {
    id: e.id,
    key: e.key,
    zone: e.zone || null,
    aisle: best.index,
    aisleNumber: e.aisle,
    aisleCode: best.code,
    rackNumber: e.rackNumber,
    shelfLevel: e.shelfLevel,
    faceNumber: e.faceNumber,
    binPosition: e.binPosition,
    occupancy: e.occupancy,
    inventory: e.inventory,
    totalQuantityOnHand: e.totalQuantityOnHand,
    side: e.x < best.cx ? -1 : 1,
    bay: null,
    level: null,
    auto: false,
    pos,
    size: new THREE.Vector3(D.depth - 0.12, D.load, D.bay - 0.3),
    face: pos.clone(),
    aisleX: best.cx,
    floor: new THREE.Vector3(best.cx, 0, e.z),
  };
}

/**
 * Resolve every bin referenced by the bin table or by a move to a rack slot.
 * Order of precedence: slot address → coordinates → auto layout.
 * Auto layout splits the run into zone bands (front = fast pick) and fills each
 * band from the aisle nearest the packing benches.
 */
function placeBins(model, binRows, moves) {
  const { layout } = model;
  const A = model.aisles.length;
  const B = layout.bays;
  const Lv = layout.levels;
  const entries = new Map();
  for (const b of normalizeBins(binRows)) if (!entries.has(b.key)) entries.set(b.key, b);
  for (const m of moves) {
    for (const id of [m.fromBin, m.toBin]) {
      const k = binKey(id);
      if (!entries.has(k)) entries.set(k, { id, key: k, zone: null });
    }
  }
  if (!binRows || !binRows.length) fillSequence(entries);
  const list = [...entries.values()].sort((a, b) => natCmp(a.id, b.id));
  const bins = new Map();
  const used = new Set();
  const slotId = (a, s, b, l) => `${a}|${s}|${b}|${l}`;
  const put = (e, a, s, b, l, auto, zone) => {
    used.add(slotId(a, s, b, l));
    bins.set(e.key, slotBin(model, e, a, s, b, l, auto, zone));
  };

  for (const e of list) {
    if (usesZoneBand(e.zone, layout)) continue;
    const ai = parseIndex(e.aisle, layout.firstAisle);
    const bi = parseIndex(e.bay, 1);
    if (ai === null || bi === null) continue;
    const a = clamp(ai, 0, A - 1);
    const b = clamp(bi, 0, B - 1);
    const li = parseIndex(e.level, 0);
    const l = clamp(li === null ? layout.pickLevel : li, 0, Lv - 1);
    let s = parseSide(e.side);
    if (s === null) s = a % 2 === 0 ? 1 : -1;
    if (used.has(slotId(a, s, b, l))) s = -s;
    put(e, a, s, b, l, false, e.zone);
  }
  for (const e of list) {
    if (usesZoneBand(e.zone, layout)) continue;
    if (bins.has(e.key) || e.x === null || e.x === undefined || e.z === null || e.z === undefined) continue;
    bins.set(e.key, freeBin(model, e));
  }

  const rest = list.filter((e) => !bins.has(e.key));
  const bands = [];
  if (rest.length) {
    let groups;
    if (rest.some((e) => e.zone)) {
      const byZone = new Map();
      for (const e of rest) {
        const z = e.zone || '';
        if (!byZone.has(z)) byZone.set(z, []);
        byZone.get(z).push(e);
      }
      const zoneRank = new Map(layout.zoneOrder.map((zone, index) => [zone, index]));
      groups = [...byZone.keys()]
        .sort((a, b) => (a === '') - (b === '')
          || (zoneRank.get(a) ?? layout.zoneOrder.length) - (zoneRank.get(b) ?? layout.zoneOrder.length)
          || natCmp(a, b))
        .map((zone) => ({ zone: zone || null, entries: byZone.get(zone) }));
    } else {
      const k = Math.min(3, rest.length);
      const per = Math.ceil(rest.length / k);
      groups = [];
      for (let i = 0; i < k; i += 1) {
        const chunk = rest.slice(i * per, (i + 1) * per);
        if (chunk.length) groups.push({ zone: 'ABC'[i], entries: chunk });
      }
    }
    const zoneBands = allocateZoneBands(groups.map((group) => group.zone), B);
    const levelOrder = [layout.pickLevel];
    for (let d = 1; levelOrder.length < Lv; d += 1) {
      for (const l of [layout.pickLevel + d, layout.pickLevel - d]) if (l >= 0 && l < Lv) levelOrder.push(l);
    }
    const free = () => {
      for (const l of levelOrder) for (let b = 0; b < B; b += 1) for (let a = 0; a < A; a += 1) for (const s of [1, -1]) {
        if (!used.has(slotId(a, s, b, l))) return [a, s, b, l];
      }
      return null;
    };
    groups.forEach((g, gi) => {
      const { start, end } = zoneBands[gi];
      bands.push({ zone: g.zone, start, end });
      const n = end - start + 1;
      const c = Math.floor((n - 1) / 2);
      const bayOrder = [c];
      for (let d = 1; bayOrder.length < n; d += 1) for (const b of [c + d, c - d]) if (b >= 0 && b < n) bayOrder.push(b);
      const slots = [];
      for (const l of levelOrder) for (const bo of bayOrder) for (let pass = 0; pass < 2; pass += 1) for (let a = 0; a < A; a += 1) {
        slots.push([a, (a + pass) % 2 === 0 ? 1 : -1, start + bo, l]);
      }
      let i = 0;
      for (const e of g.entries) {
        while (i < slots.length && used.has(slots[i].join('|'))) i += 1;
        const slot = i < slots.length ? slots[i] : free();
        if (!slot) break;
        i += 1;
        put(e, slot[0], slot[1], slot[2], slot[3], true, g.zone);
      }
    });
  }
  return { bins, bands };
}

/**
 * Without a bin table, assume bins are numbered in sequence (BIN001…BIN015) and add the
 * unreferenced numbers as idle bins, so zones split the way the numbering does.
 */
function fillSequence(entries) {
  const parsed = [...entries.values()].map((e) => /^(.*?)(\d+)$/.exec(e.id));
  if (parsed.length < 2 || parsed.some((m) => !m) || !parsed.every((m) => m[1] === parsed[0][1])) return;
  const prefix = parsed[0][1];
  const width = parsed[0][2].length;
  const nums = parsed.map((m) => parseInt(m[2], 10));
  const hi = Math.max(...nums);
  let lo = Math.min(...nums);
  if (lo <= 10) lo = Math.min(lo, 1);
  if (hi - lo + 1 > Math.max(40, nums.length * 4)) return;
  for (let n = lo; n <= hi; n += 1) {
    const id = `${prefix}${String(n).padStart(width, '0')}`;
    const k = binKey(id);
    if (!entries.has(k)) entries.set(k, { id, key: k, zone: null, inferred: true });
  }
}

function describeBin(bin) {
  if (!bin) return '';
  return [
    bin.zone ? `Zone ${bin.zone}` : null,
    bin.aisleNumber !== null && bin.aisleNumber !== undefined ? `Aisle A${String(bin.aisleNumber).padStart(2, '0')}` : null,
    bin.rackNumber !== null && bin.rackNumber !== undefined ? `Rack R${String(bin.rackNumber).padStart(2, '0')}` : null,
    bin.shelfLevel ? `Shelf ${bin.shelfLevel}` : null,
    bin.faceNumber !== null && bin.faceNumber !== undefined ? `Rack face F${String(bin.faceNumber).padStart(2, '0')}` : null,
    bin.binPosition ? `Bin ${bin.binPosition}` : null,
    bin.aisleNumber === null || bin.aisleNumber === undefined ? bin.aisleCode : null,
    !bin.binPosition && bin.bay !== null ? `Bay ${bin.bay + 1}` : null,
    !bin.shelfLevel && bin.level !== null ? `Level ${bin.level}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Rise out of the source aisle, arc over the racking, drop into the target aisle. */
function moveCurve(from, to, model) {
  const top = model.uprightH + 1.25;
  const a0 = new THREE.Vector3(from.aisleX, from.pos.y + 0.95, from.pos.z);
  const a1 = new THREE.Vector3(to.aisleX, to.pos.y + 0.95, to.pos.z);
  const t0 = new THREE.Vector3(from.aisleX, top, from.pos.z);
  const t1 = new THREE.Vector3(to.aisleX, top, to.pos.z);
  const horiz = Math.hypot(t1.x - t0.x, t1.z - t0.z);
  const apex = t0.clone().lerp(t1, 0.5);
  const pts = [from.face.clone(), a0];
  if (horiz > 2) {
    apex.y = top + 0.9 + horiz * 0.075;
    pts.push(t0, apex, t1);
  } else {
    apex.y = top + 0.6;
    pts.push(apex);
  }
  pts.push(a1, to.face.clone());
  return { curve: new THREE.CatmullRomCurve3(pts, false, 'centripetal'), apex, rise: t0 };
}

/* ──────────────────────────── canvas textures ──────────────────────────── */

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(canvas, { repeat = null, aniso = 4 } = {}) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  if (repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

function fitFont(g, text, weight, size, family, maxW) {
  g.font = `${weight} ${size}px ${family}`;
  const w = g.measureText(text).width;
  if (w > maxW) g.font = `${weight} ${Math.floor((size * maxW) / w)}px ${family}`;
}

function floorCanvas() {
  const S = 1024;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = COLORS.floor;
  g.fillRect(0, 0, S, S);
  const rnd = mulberry32(7);
  for (let i = 0; i < 2400; i += 1) {
    const light = rnd() < 0.5;
    g.fillStyle = light ? `rgba(255,255,255,${0.025 + rnd() * 0.05})` : `rgba(58,70,82,${0.02 + rnd() * 0.035})`;
    g.beginPath();
    const r = 3 + rnd() * 22;
    g.ellipse(rnd() * S, rnd() * S, r * (1 + rnd()), r, rnd() * Math.PI, 0, Math.PI * 2);
    g.fill();
  }
  g.fillStyle = 'rgba(66,78,90,0.32)'; // saw-cut joints every 6 m
  g.fillRect(0, 0, S, 3);
  g.fillRect(0, 0, 3, S);
  return c;
}

function cartonCanvas() {
  const S = 256;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, S, S);
  g.fillStyle = 'rgba(255,255,255,0.4)';
  for (const x of [S / 4, (3 * S) / 4]) g.fillRect(x - 7, 0, 14, S); // tape
  g.fillStyle = 'rgba(0,0,0,0.07)';
  for (const [x, y] of [[0.1, 0.62], [0.6, 0.62], [0.1, 0.12], [0.6, 0.12]]) g.fillRect(x * S, y * S, S * 0.17, S * 0.1);
  g.fillStyle = 'rgba(0,0,0,0.2)'; // carton seams
  g.fillRect(0, S / 2 - 2, S, 4);
  g.fillRect(S / 2 - 2, 0, 4, S);
  g.fillRect(0, 0, S, 3);
  g.fillRect(0, S - 3, S, 3);
  g.fillRect(0, 0, 3, S);
  g.fillRect(S - 3, 0, 3, S);
  return c;
}

function signCanvas(text, { w = 512, h = 336, font = 'sans-serif', bg = COLORS.yellow, fg = '#111111', border = '#111111' } = {}) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, w, h);
  if (border) {
    const lw = Math.max(5, Math.round(h * 0.035));
    g.strokeStyle = border;
    g.lineWidth = lw;
    g.strokeRect(lw * 1.6, lw * 1.6, w - lw * 3.2, h - lw * 3.2);
  }
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fitFont(g, text, 900, Math.round(h * 0.56), font, w * 0.8);
  g.fillText(text, w / 2, h * 0.54);
  return c;
}

function bannerCanvas(text, font) {
  const w = 256;
  const h = 1024;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = COLORS.yellow;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#D40511';
  g.fillRect(0, 18, w, 12);
  g.fillRect(0, h - 30, w, 12);
  g.save();
  g.translate(w / 2, h / 2);
  g.rotate(-Math.PI / 2);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  fitFont(g, text, 900, Math.round(w * 0.4), font, h * 0.8);
  g.fillText(text, 0, 4);
  g.restore();
  return c;
}

function boardCanvas(font) {
  const w = 512;
  const h = 352;
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#FAFAF8';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#1E2A36';
  g.fillRect(0, 0, w, 54);
  g.fillStyle = '#FFFFFF';
  g.textBaseline = 'middle';
  fitFont(g, 'RACK LOAD NOTICE', 800, 28, font, w - 40);
  g.fillText('RACK LOAD NOTICE', 20, 28);
  g.fillStyle = 'rgba(30,42,54,0.5)';
  for (let i = 0; i < 7; i += 1) g.fillRect(20, 76 + i * 22, 200 - (i % 3) * 30, 8);
  ['#2F6DB5', '#D7263D', '#D7263D', '#F2C200'].forEach((col, i) => {
    g.fillStyle = col;
    g.fillRect(250, 72 + i * 34, 240, 22);
  });
  g.lineWidth = 7;
  g.strokeStyle = '#D7263D';
  for (const x of [50, 118, 186]) {
    g.beginPath();
    g.arc(x, 270, 26, 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = '#F2C200';
  g.beginPath();
  g.moveTo(262, 296);
  g.lineTo(292, 244);
  g.lineTo(322, 296);
  g.closePath();
  g.fill();
  return c;
}

function shutterCanvas() {
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  g.fillStyle = '#BCC3CA';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 14) {
    g.fillStyle = 'rgba(40,50,60,0.22)';
    g.fillRect(0, y, 256, 2);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(0, y + 2, 256, 2);
  }
  g.fillStyle = '#3A4148';
  g.fillRect(0, 238, 256, 18);
  return c;
}

function cageCanvas() {
  const c = makeCanvas(128, 128);
  const g = c.getContext('2d');
  g.strokeStyle = '#8D969F';
  g.lineWidth = 3;
  for (let i = 0; i <= 128; i += 16) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i, 128);
    g.moveTo(0, i);
    g.lineTo(128, i);
    g.stroke();
  }
  g.lineWidth = 8;
  g.strokeRect(0, 0, 128, 128);
  return c;
}

function rollerCanvas() {
  const c = makeCanvas(256, 64);
  const g = c.getContext('2d');
  g.fillStyle = '#5E666E';
  g.fillRect(0, 0, 256, 64);
  for (let x = 0; x < 256; x += 32) {
    const grd = g.createLinearGradient(x, 0, x + 26, 0);
    grd.addColorStop(0, '#9EA7B0');
    grd.addColorStop(0.5, '#E3E7EA');
    grd.addColorStop(1, '#8D959E');
    g.fillStyle = grd;
    g.fillRect(x + 3, 0, 26, 64);
  }
  return c;
}

function contactCanvas() {
  const c = makeCanvas(256, 256);
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 20, 128, 128, 128);
  grd.addColorStop(0, 'rgba(20,28,36,0.32)');
  grd.addColorStop(0.6, 'rgba(20,28,36,0.16)');
  grd.addColorStop(1, 'rgba(20,28,36,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  return c;
}

/* ──────────────────────────── scene helpers ──────────────────────────── */

const _m4 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** items: [{ p:[x,y,z], s:[sx,sy,sz], r:[rx,ry,rz], c:'#hex' }] */
function instanced(geometry, material, items, { cast = true, receive = true } = {}) {
  if (!items.length) return null;
  const mesh = new THREE.InstancedMesh(geometry, material, items.length);
  items.forEach((it, i) => {
    _p.fromArray(it.p);
    _s.fromArray(it.s || [1, 1, 1]);
    if (it.r) _q.setFromEuler(_e.set(it.r[0], it.r[1], it.r[2]));
    else _q.identity();
    mesh.setMatrixAt(i, _m4.compose(_p, _q, _s));
    if (it.c) mesh.setColorAt(i, _c.set(it.c));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  mesh.computeBoundingSphere();
  return mesh;
}

function addAll(group, ...objs) {
  for (const o of objs) if (o) group.add(o);
}

function disposeTree(root, keep) {
  const geos = new Set();
  const mats = new Set();
  const texs = new Set();
  root.traverse((o) => {
    if (o.geometry && !(keep && keep.has(o.geometry))) geos.add(o.geometry);
    const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of list) {
      if (keep && keep.has(m)) continue;
      mats.add(m);
      for (const k of ['map', 'alphaMap']) if (m[k] && !(keep && keep.has(m[k]))) texs.add(m[k]);
    }
    if (o.isInstancedMesh) o.dispose();
  });
  geos.forEach((g) => g.dispose());
  mats.forEach((m) => m.dispose());
  texs.forEach((t) => t.dispose());
}

function makeShared(renderer) {
  const box = new THREE.BoxGeometry(1, 1, 1);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 14);
  const sphere = new THREE.SphereGeometry(1, 16, 12);
  const cone = new THREE.ConeGeometry(1, 1, 16);
  const ring = new THREE.RingGeometry(0.42, 0.6, 48);
  const edges = new THREE.EdgesGeometry(box);
  const carton = toTexture(cartonCanvas(), { aniso: 2 });
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const shared = {
    box,
    cyl,
    sphere,
    cone,
    ring,
    edges,
    carton,
    hitMat,
    aniso: Math.min(8, renderer.capabilities.getMaxAnisotropy()),
    font: 'system-ui, sans-serif',
  };
  shared.keep = new Set([box, cyl, sphere, cone, ring, edges, carton, hitMat]);
  return shared;
}

/* ──────────────────────────── static warehouse ──────────────────────────── */

function buildWarehouse(model, shared) {
  const { layout, bounds: b } = model;
  const cx = model.center.x;
  const cz = model.center.z;
  const W = model.width;
  const DZ = model.depth;
  const group = new THREE.Group();
  group.name = 'mfdt-warehouse';
  const ceiling = new THREE.Group();
  ceiling.name = 'mfdt-ceiling';
  ceiling.visible = false;
  const ghost = [];
  const texts = [];
  const std = (color, o = {}) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05, envMapIntensity: 0.45, ...o });
  const ghostable = (m) => {
    m.transparent = true;
    ghost.push(m);
    return m;
  };
  const textMat = (draw, o = {}) => {
    const tex = toTexture(draw(), { aniso: shared.aniso });
    texts.push({ draw, tex });
    return std('#ffffff', { map: tex, roughness: 0.6, envMapIntensity: 0.5, ...o });
  };
  const { box, cyl } = shared;

  /* floor slab, contact shadow, walls */
  const floorMat = std('#ffffff', {
    map: toTexture(floorCanvas(), { repeat: [W / 6, DZ / 6], aniso: shared.aniso }),
    roughness: 0.42,
    envMapIntensity: 0.42,
  });
  const slabMat = std(COLORS.slab, { roughness: 0.9 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(W, 0.3, DZ), [slabMat, slabMat, floorMat, slabMat, slabMat, slabMat]);
  slab.position.set(cx, -0.15, cz);
  slab.receiveShadow = true;
  group.add(slab);

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 1.4, DZ * 1.35),
    new THREE.MeshBasicMaterial({ map: toTexture(contactCanvas()), transparent: true, depthWrite: false, toneMapped: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(cx, -0.32, cz);
  group.add(shadow);

  // Inward-facing planes: back-face culling hides whichever walls stand between camera and racks.
  const wallMat = std(COLORS.wall, { roughness: 0.95, envMapIntensity: 0.35 });
  const skirtMat = std(COLORS.skirting, { roughness: 0.9 });
  for (const wl of [
    { w: W, x: cx, z: b.z0, ry: 0 },
    { w: W, x: cx, z: b.z1, ry: Math.PI },
    { w: DZ, x: b.x0, z: cz, ry: Math.PI / 2 },
    { w: DZ, x: b.x1, z: cz, ry: -Math.PI / 2 },
  ]) {
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(wl.w, D.wallH), wallMat);
    wall.position.set(wl.x, D.wallH / 2, wl.z);
    wall.rotation.y = wl.ry;
    wall.receiveShadow = true;
    const skirt = new THREE.Mesh(new THREE.PlaneGeometry(wl.w, 0.24), skirtMat);
    skirt.position.set(wl.x, 0.12, wl.z);
    skirt.rotation.y = wl.ry;
    skirt.translateZ(0.015);
    group.add(wall, skirt);
  }

  /* pallet racking: uprights, beams, frame lacing, upright protectors */
  const uprights = [];
  const beams = [];
  const braces = [];
  const protectors = [];
  for (const r of model.racks) {
    const span = D.depth - D.upW * 2;
    const lace = Math.max(2, Math.round((model.uprightH - 0.7) / 1.15));
    const step = (model.uprightH - 0.7) / lace;
    for (let k = 0; k <= layout.bays; k += 1) {
      const z = -k * D.bay;
      for (const x of [r.x0 + D.upW / 2, r.x1 - D.upW / 2]) {
        uprights.push({ p: [x, model.uprightH / 2, z], s: [D.upW, model.uprightH, D.upD] });
      }
      braces.push({ p: [r.cx, 0.32, z], s: [span, 0.035, 0.03] });
      braces.push({ p: [r.cx, model.uprightH - 0.2, z], s: [span, 0.035, 0.03] });
      for (let i = 0; i < lace; i += 1) {
        const y0 = 0.32 + i * step;
        const ang = Math.atan2(step, span) * (i % 2 ? -1 : 1);
        braces.push({ p: [r.cx, y0 + step / 2, z], s: [Math.hypot(span, step), 0.03, 0.025], r: [0, 0, ang] });
      }
      const px = r.side < 0 ? r.x1 - D.upW / 2 : r.x0 + D.upW / 2;
      protectors.push({ p: [px, 0.22, z], s: [0.17, 0.44, 0.15] });
    }
    for (let bay = 0; bay < layout.bays; bay += 1) {
      for (let l = 0; l < layout.levels; l += 1) {
        const y = model.levelY(l) - D.beamH / 2;
        for (const x of [r.x0 + 0.03, r.x1 - 0.03]) beams.push({ p: [x, y, model.bayZ(bay)], s: [0.05, D.beamH, D.bay - D.upD] });
      }
    }
  }
  const upMat = ghostable(std(COLORS.upright, { roughness: 0.45, metalness: 0.25 }));
  addAll(
    group,
    instanced(box, upMat, uprights),
    instanced(box, ghostable(std(COLORS.beam, { roughness: 0.42, metalness: 0.15 })), beams),
    instanced(box, upMat, braces),
    instanced(box, ghostable(std(COLORS.protector, { roughness: 0.5 })), protectors, { cast: false }),
  );

  /* row ends: guard rails, structural columns, aisle signs, load notices, banners */
  const columnRows = new Set(model.rows.filter((r) => r.double && r.index % 2 === 0).map((r) => r.index));
  const posts = [];
  const rails = [];
  const reds = [];
  for (const row of model.rows) {
    for (const front of [true, false]) {
      if (front && columnRows.has(row.index)) continue;
      const zEdge = front ? 0 : model.zBack;
      const dir = front ? 1 : -1;
      const zr = zEdge + dir * 0.45;
      for (const x of [row.x0 + 0.06, row.x1 - 0.06]) {
        posts.push({ p: [x, 0.5, zr], s: [0.055, 1, 0.055] });
        for (const y of [0.42, 0.92]) rails.push({ p: [x, y, zEdge + dir * 0.225], s: [0.04, 0.45, 0.04], r: [Math.PI / 2, 0, 0] });
      }
      for (const y of [0.42, 0.92]) rails.push({ p: [row.cx, y, zr], s: [0.045, row.x1 - row.x0 - 0.12, 0.045], r: [0, 0, Math.PI / 2] });
    }
  }
  const guardMat = ghostable(std(COLORS.guard, { roughness: 0.4, metalness: 0.2 }));
  addAll(group, instanced(cyl, guardMat, posts), instanced(cyl, guardMat, rails));

  const columnMat = std(COLORS.column, { roughness: 0.85 });
  for (const ri of columnRows) {
    const row = model.rows[ri];
    const col = new THREE.Mesh(box, columnMat);
    col.scale.set(0.7, D.wallH, 0.7);
    col.position.set(row.cx, D.wallH / 2, 0.75);
    col.castShadow = true;
    col.receiveShadow = true;
    group.add(col);
    reds.push({ p: [row.cx, 1.45, 1.17], s: [0.34, 0.12, 0.34], r: [Math.PI / 2, 0, 0] }); // hose reel
    reds.push({ p: [row.cx + 0.52, 0.32, 1.0], s: [0.085, 0.52, 0.085] }); // extinguisher
  }

  const signGeo = new THREE.PlaneGeometry(0.92, 0.6);
  const boardGeo = new THREE.PlaneGeometry(0.78, 0.54);
  const boardMat = textMat(() => boardCanvas(shared.font));
  for (const a of model.aisles) {
    const mat = textMat(() => signCanvas(a.code, { font: shared.font }));
    const front = new THREE.Mesh(signGeo, mat);
    front.position.set(a.left.cx, 3.35, 0.06);
    const back = new THREE.Mesh(signGeo, mat);
    back.position.set(a.left.cx, 3.35, model.zBack - 0.06);
    back.rotation.y = Math.PI;
    const board = new THREE.Mesh(boardGeo, boardMat);
    board.position.set(a.left.cx, 2.05, 0.06);
    group.add(front, back, board);
  }
  const bannerGeo = new THREE.PlaneGeometry(0.82, 3.2);
  const bannerMat = textMat(() => bannerCanvas(layout.name.toUpperCase(), shared.font), { side: THREE.DoubleSide });
  for (const r of model.racks) {
    if (r.side !== 1 || r.row % 2 !== 1) continue;
    const banner = new THREE.Mesh(bannerGeo, bannerMat);
    banner.position.set(r.cx, 5.45, 0.08);
    group.add(banner);
  }

  /* floor markings */
  const strips = [];
  const strip = (x0, z0, x1, z1, w = 0.1) => {
    strips.push({
      p: [(x0 + x1) / 2, 0.006, (z0 + z1) / 2],
      s: [Math.hypot(x1 - x0, z1 - z0) + w, 0.012, w],
      r: [0, -Math.atan2(z1 - z0, x1 - x0), 0],
    });
  };
  const rect = (x0, z0, x1, z1) => {
    strip(x0, z0, x1, z0);
    strip(x1, z0, x1, z1);
    strip(x1, z1, x0, z1);
    strip(x0, z1, x0, z0);
  };
  strip(b.x0 + 0.6, 1.3, b.x1 - 0.6, 1.3);
  strip(b.x0 + 0.6, 4.2, b.x1 - 0.6, 4.2);
  strip(b.x0 + 0.6, D.walkway, b.x1 - 0.6, D.walkway, 0.14);

  /* packing benches (front-left) */
  const pack = { x0: b.x0 + 1.4, x1: cx - 2.2, z0: D.walkway + 1.6, z1: D.walkway + 7.2 };
  rect(pack.x0 - 0.5, pack.z0 - 0.6, pack.x1 + 0.5, pack.z1);
  const benchN = Math.max(2, Math.floor((pack.x1 - pack.x0) / 3.2));
  const pitch = (pack.x1 - pack.x0) / benchN;
  const tops = [];
  const steel = [];
  const darks = [];
  const cartons = [];
  for (let i = 0; i < benchN; i += 1) {
    const x = pack.x0 + pitch * (i + 0.5);
    const z = pack.z0 + 1.2;
    tops.push({ p: [x, 0.9, z], s: [2.3, 0.05, 0.9] });
    for (const dx of [-1.08, 1.08]) for (const dz of [-0.38, 0.38]) steel.push({ p: [x + dx, 0.44, z + dz], s: [0.05, 0.88, 0.05] });
    steel.push({ p: [x, 1.62, z - 0.31], s: [2.3, 0.035, 0.34] });
    for (const dx of [-1.1, 1.1]) steel.push({ p: [x + dx, 1.26, z - 0.42], s: [0.04, 0.74, 0.04] });
    darks.push({ p: [x - 0.4, 1.2, z - 0.3], s: [0.56, 0.34, 0.035] });
    darks.push({ p: [x, 0.008, z + 0.95], s: [2.0, 0.016, 0.75] });
    cartons.push({ p: [x + 0.55, 1.08, z + 0.05], s: [0.5, 0.3, 0.38], c: '#C9A47A' });
    cartons.push({ p: [x + 0.12, 1.75, z - 0.31], s: [0.32, 0.22, 0.26], c: '#D8BD95' });
    cartons.push({ p: [x - 0.75, 1.75, z - 0.31], s: [0.28, 0.2, 0.24], c: '#ECECE8' });
  }
  const convZ = pack.z0 + 3.6;
  const convX0 = pack.x0 - 0.4;
  const convX1 = cx + 2.6;
  const convLen = convX1 - convX0;
  const steelMat = std(COLORS.steel, { roughness: 0.4, metalness: 0.45 });
  const rollerMat = std('#ffffff', { map: toTexture(rollerCanvas(), { repeat: [convLen / 0.64, 1] }), roughness: 0.4, metalness: 0.4 });
  const conveyor = new THREE.Mesh(new THREE.BoxGeometry(convLen, 0.12, 0.72), [steelMat, steelMat, rollerMat, steelMat, steelMat, steelMat]);
  conveyor.position.set((convX0 + convX1) / 2, 0.8, convZ);
  conveyor.castShadow = true;
  conveyor.receiveShadow = true;
  group.add(conveyor);
  for (let x = convX0 + 0.4; x < convX1; x += 2.2) for (const dz of [-0.3, 0.3]) steel.push({ p: [x, 0.37, convZ + dz], s: [0.05, 0.74, 0.05] });
  for (let x = convX0 + 1.2; x < convX1 - 1; x += 3.1) cartons.push({ p: [x, 1.03, convZ], s: [0.48, 0.34, 0.4], c: '#C9A47A' });

  /* outbound docks (front-right) */
  const doors = [];
  const ox0 = cx + 3.2;
  const ox1 = b.x1 - 2.4;
  for (let i = 0; i < 3; i += 1) doors.push(ox0 + ((ox1 - ox0) * (i + 0.5)) / 3);
  const doorMat = std('#ffffff', { map: toTexture(shutterCanvas()), roughness: 0.5, metalness: 0.3 });
  const doorGeo = new THREE.PlaneGeometry(3.0, 3.4);
  const plateGeo = new THREE.PlaneGeometry(1.1, 0.5);
  const bollards = [];
  const cages = [];
  const wrapped = [];
  const woodPallets = [];
  doors.forEach((dx, i) => {
    const door = new THREE.Mesh(doorGeo, doorMat);
    door.position.set(dx, 1.7, b.z1 - 0.015);
    door.rotation.y = Math.PI;
    const plate = new THREE.Mesh(plateGeo, textMat(() => signCanvas(`DOCK ${i + 1}`, { w: 512, h: 232, font: shared.font })));
    plate.position.set(dx, 3.95, b.z1 - 0.02);
    plate.rotation.y = Math.PI;
    group.add(door, plate);
    for (const sx of [-1.85, 1.85]) bollards.push({ p: [dx + sx, 0.55, b.z1 - 0.5], s: [0.1, 1.1, 0.1] });
    rect(dx - 1.6, 9.4, dx + 1.6, b.z1 - 0.35);
    const rnd = slotRandom(layout.seed, 991, i);
    for (const z of [b.z1 - 1.9, b.z1 - 3.4, b.z1 - 4.9]) {
      for (const sx of [-0.66, 0.66]) {
        if (rnd() < 0.3) continue;
        const h = 1.0 + rnd() * 0.5;
        woodPallets.push({ p: [dx + sx, 0.07, z], s: [1.0, 0.14, 1.18], c: '#B98C5E' });
        wrapped.push({ p: [dx + sx, 0.14 + h / 2, z], s: [0.96, h, 1.12], c: rnd() < 0.7 ? '#F1F2F0' : '#D8BD95' });
      }
    }
    cages.push({ p: [dx + (i % 2 ? 0.7 : -0.7), 0.9, 10.5], s: [0.8, 1.7, 0.72] });
  });
  for (const z of [1.3, 2.9, 4.5]) bollards.push({ p: [b.x1 - 1.15, 0.55, z], s: [0.1, 1.1, 0.1] });
  const cabinets = [1.7, 2.9, 4.1].map((z) => ({ p: [b.x1 - 0.3, 1.05, z], s: [0.5, 2.1, 1.1] }));
  const cageMat = new THREE.MeshStandardMaterial({
    map: toTexture(cageCanvas()),
    transparent: true,
    alphaTest: 0.4,
    side: THREE.DoubleSide,
    roughness: 0.5,
    metalness: 0.4,
  });
  addAll(
    group,
    instanced(box, std('#E7EAED', { roughness: 0.5 }), tops),
    instanced(box, steelMat, steel),
    instanced(box, std(COLORS.dark, { roughness: 0.7 }), darks, { cast: false }),
    instanced(box, std('#ffffff', { map: shared.carton, roughness: 0.85, envMapIntensity: 0.55 }), [...cartons, ...wrapped]),
    instanced(box, std('#ffffff', { roughness: 0.85 }), woodPallets),
    instanced(box, std('#C3CAD1', { roughness: 0.55, metalness: 0.2 }), cabinets),
    instanced(cyl, std(COLORS.yellow, { roughness: 0.45 }), bollards),
    instanced(cyl, std(COLORS.red, { roughness: 0.45 }), reds),
    instanced(box, cageMat, cages),
    instanced(box, std(COLORS.line, { roughness: 0.5, envMapIntensity: 0.5 }), strips, { cast: false }),
  );

  /* hanging signs (cables live in the ceiling group) */
  const cables = [];
  const hang = (text, w, h, pos, axis) => {
    const face = textMat(() => signCanvas(text, { w: 1024, h: Math.round((1024 * h) / w), font: shared.font }));
    const edge = std(COLORS.yellow, { roughness: 0.6 });
    const geo = axis === 'x' ? new THREE.BoxGeometry(0.06, h, w) : new THREE.BoxGeometry(w, h, 0.06);
    const mats = axis === 'x' ? [face, face, edge, edge, edge, edge] : [edge, edge, edge, edge, face, face];
    const sign = new THREE.Mesh(geo, mats);
    sign.position.copy(pos);
    group.add(sign);
    for (const d of [-w / 2 + 0.3, w / 2 - 0.3]) {
      const len = D.wallH - (pos.y + h / 2);
      const p = axis === 'x' ? [pos.x, pos.y + h / 2 + len / 2, pos.z + d] : [pos.x + d, pos.y + h / 2 + len / 2, pos.z];
      cables.push({ p, s: [0.012, len, 0.012] });
    }
  };
  hang('OUTBOUND', 4.4, 1.15, new THREE.Vector3(2.0, 6.3, 2.75), 'x');
  hang('PACKING', 3.6, 1.0, new THREE.Vector3((pack.x0 + pack.x1) / 2, 5.4, pack.z0 - 0.2), 'z');

  /* ceiling — only shown when the camera is inside the building (Floor view) */
  const roof = new THREE.Mesh(new THREE.PlaneGeometry(W, DZ), std('#EEF0F2', { roughness: 0.95 }));
  roof.rotation.x = Math.PI / 2;
  roof.position.set(cx, D.wallH, cz);
  ceiling.add(roof);
  const roofBeams = [];
  for (let z = b.z0 + 3; z < b.z1 - 1; z += 7.5) roofBeams.push({ p: [cx, D.wallH - 0.3, z], s: [W, 0.55, 0.28] });
  const pipes = [];
  for (let z = b.z0 + 4.5; z < b.z1; z += 6) pipes.push({ p: [cx, D.wallH - 0.75, z], s: [0.05, W - 0.6, 0.05], r: [0, 0, Math.PI / 2] });
  const ducts = [cx - W * 0.22, cx + W * 0.2].map((x) => ({ p: [x, 9.7, cz], s: [0.45, DZ - 1, 0.45], r: [Math.PI / 2, 0, 0] }));
  const lamps = [];
  const lampXs = [...model.aisles.map((a) => a.cx), b.x0 + 1.7, b.x1 - 1.7];
  for (const x of lampXs) for (let z = b.z0 + 2.5; z < b.z1 - 1; z += 5.6) lamps.push({ p: [x, 9.25, z], s: [0.36, 0.16, 0.36] });
  addAll(
    ceiling,
    instanced(box, std('#E8EBEE', { roughness: 0.8 }), roofBeams, { cast: false }),
    instanced(cyl, std(COLORS.red, { roughness: 0.5 }), pipes, { cast: false }),
    instanced(cyl, std('#D3D9DE', { roughness: 0.35, metalness: 0.5 }), ducts, { cast: false }),
    instanced(cyl, new THREE.MeshBasicMaterial({ color: '#FFFFFF', toneMapped: false }), lamps, { cast: false, receive: false }),
    instanced(box, std('#7A838C'), cables, { cast: false }),
  );

  return { group, ceiling, ghost, texts, pack, doors };
}

/* ──────────────────────────── inventory + moves ──────────────────────────── */

/** Twelve thin edges around a slot, drawn as one instanced mesh. */
function cageMesh(geo, size, t, mat) {
  const hx = size.x / 2;
  const hy = size.y / 2;
  const hz = size.z / 2;
  const items = [];
  for (const y of [-hy, hy]) for (const z of [-hz, hz]) items.push({ p: [0, y, z], s: [size.x + t, t, t] });
  for (const x of [-hx, hx]) for (const z of [-hz, hz]) items.push({ p: [x, 0, z], s: [t, size.y + t, t] });
  for (const x of [-hx, hx]) for (const y of [-hy, hy]) items.push({ p: [x, y, 0], s: [t, t, size.z + t] });
  return instanced(geo, mat, items, { cast: false, receive: false });
}

function floorRing(geo, mat, at) {
  const m = new THREE.Mesh(geo, mat);
  m.rotation.x = -Math.PI / 2;
  m.position.set(at.x, 0.03, at.z);
  m.renderOrder = 2;
  return m;
}

function buildMove(move, from, to, model, shared, maxSaved, index) {
  const P = PRIORITIES[move.priority] || PRIORITIES.medium;
  const color = new THREE.Color(P.color);
  const { curve, apex, rise } = moveCurve(from, to, model);
  const length = curve.getLength();
  const share = clamp((move.timeSavedSec || 0) / maxSaved, 0, 1);
  const radius = 0.07 + 0.09 * Math.sqrt(share);
  const segs = Math.round(clamp(length * 4, 80, 420));
  const obj = new THREE.Group();
  obj.name = `mfdt-move-${move.sku}`;
  const mats = []; // [material, baseOpacity, baseDepthWrite]
  const basic = (opacity, o = {}) => {
    const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity, toneMapped: false, ...o });
    mats.push([m, opacity, m.depthWrite]);
    return m;
  };

  const tubeMat = basic(1);
  const tube = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, radius, 10, false), tubeMat);
  tube.renderOrder = 3;
  const haloMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.2, depthWrite: false, toneMapped: false });
  const halo = new THREE.Mesh(new THREE.TubeGeometry(curve, segs, radius * 2.4 + 0.08, 12, false), haloMat);
  halo.visible = false;
  halo.renderOrder = 2;
  const hit = new THREE.Mesh(new THREE.TubeGeometry(curve, 48, 0.7, 6, false), shared.hitMat);
  const dotMat = basic(1);
  const dots = [0, 1, 2].map(() => {
    const d = new THREE.Mesh(shared.sphere, dotMat);
    d.scale.setScalar(radius * 2.1 + 0.05);
    d.renderOrder = 3;
    return d;
  });
  const arrow = new THREE.Mesh(shared.cone, tubeMat);
  arrow.scale.set(radius * 3 + 0.14, radius * 4 + 0.32, radius * 3 + 0.14);
  const uA = clamp(1 - (0.9 + radius * 2) / length, 0.5, 0.995);
  arrow.position.copy(curve.getPointAt(uA));
  arrow.quaternion.setFromUnitVectors(UP, curve.getTangentAt(uA));
  arrow.renderOrder = 3;

  // Current bin: the SKU's stock, in its priority colour.
  const srcMat = new THREE.MeshStandardMaterial({ color, map: shared.carton, roughness: 0.6, envMapIntensity: 0.6, transparent: true });
  mats.push([srcMat, 1, true]);
  const srcLoad = new THREE.Mesh(shared.box, srcMat);
  srcLoad.position.copy(from.pos);
  srcLoad.scale.copy(from.size);
  const edgeMat = new THREE.LineBasicMaterial({ color: color.clone().multiplyScalar(0.5), transparent: true });
  mats.push([edgeMat, 1, true]);
  const srcEdges = new THREE.LineSegments(shared.edges, edgeMat);
  srcEdges.position.copy(from.pos);
  srcEdges.scale.copy(from.size).addScalar(0.02);

  // Recommended bin: an empty slot outlined in the same colour.
  const ghostMat = basic(0.2, { depthWrite: false });
  const dstGhost = new THREE.Mesh(shared.box, ghostMat);
  dstGhost.position.copy(to.pos);
  dstGhost.scale.copy(to.size);
  const cage = cageMesh(shared.box, to.size, 0.045, basic(1));
  cage.position.copy(to.pos);

  // Floor markers in the aisle in front of each bin.
  const ringMat = basic(0.85, { depthWrite: false, side: THREE.DoubleSide });
  const pulseMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, toneMapped: false, side: THREE.DoubleSide });
  const pulse = floorRing(shared.ring, pulseMat, to.floor);
  obj.add(tube, halo, hit, ...dots, arrow, srcLoad, srcEdges, dstGhost, cage, floorRing(shared.ring, ringMat, from.floor), floorRing(shared.ring, ringMat, to.floor), pulse);

  const entry = {
    move,
    from,
    to,
    color: P.color,
    curve,
    length,
    radius,
    obj,
    halo,
    haloMat,
    hit,
    dots,
    srcLoad,
    dstGhost,
    pulse,
    pulseMat,
    mats,
    apex,
    seed: (index * 0.37) % 1,
    fade: 1,
    visible: true,
    chipAnchor: rise.clone().add(new THREE.Vector3(0, 0.4, 0)),
    fromAnchor: from.pos.clone().add(new THREE.Vector3(0, from.size.y / 2 + 0.25, 0)),
    toAnchor: to.pos.clone().add(new THREE.Vector3(0, to.size.y / 2 + 0.25, 0)),
  };
  for (const o of [hit, srcLoad, dstGhost]) o.userData.pick = { kind: 'move', entry };
  return entry;
}

function buildInventory(model, placement, moves, shared) {
  const { layout } = model;
  const { bins, bands } = placement;
  const group = new THREE.Group();
  group.name = 'mfdt-inventory';
  const ghost = [];
  const binList = [...bins.values()];
  const binBySlot = new Map();
  for (const bin of binList) if (bin.bay !== null) binBySlot.set(`${bin.aisle}|${bin.side}|${bin.bay}|${bin.level}`, bin);
  const roles = new Map();
  const role = (k) => {
    if (!roles.has(k)) roles.set(k, { src: [], dst: [] });
    return roles.get(k);
  };
  for (const m of moves) {
    role(binKey(m.fromBin)).src.push(m);
    role(binKey(m.toBin)).dst.push(m);
  }

  /* stock on the racks (tracked bins are always filled; the rest is context) */
  const pallets = [];
  const loads = [];
  for (const r of model.racks) {
    for (let bay = 0; bay < layout.bays; bay += 1) {
      for (let l = 0; l < layout.levels; l += 1) {
        const bin = binBySlot.get(`${r.aisle}|${r.side}|${bay}|${l}`);
        if (bin?.occupancy === 'empty') continue;
        const y = model.levelY(l);
        const bias = l === 0 ? 1.1 : l === layout.levels - 1 ? 0.7 : 1;
        for (const half of [0, 1]) {
          const rnd = slotRandom(layout.seed, r.index, bay, l, half);
          if (!bin && rnd() > layout.stockFill * bias) continue;
          const h = bin ? 0.85 + rnd() * 0.25 : 0.5 + rnd() * 0.62;
          const z = model.bayZ(bay) + (half ? D.bay / 4 : -D.bay / 4);
          const lot = bin?.inventory?.length ? bin.inventory[half % bin.inventory.length] : null;
          const productKey = String(lot?.sku || lot?.productId || '');
          const productHash = [...productKey].reduce((hash, character) => hash + character.charCodeAt(0), 0);
          pallets.push({ p: [r.cx, y + D.pallet / 2, z], s: [D.depth - 0.1, D.pallet, 1.18], c: rnd() < 0.22 ? '#8F9AA5' : '#B98C5E' });
          loads.push({ p: [r.cx, y + D.pallet + h / 2, z], s: [D.depth - 0.16, h, 1.1], c: lot ? STOCK_TONES[productHash % STOCK_TONES.length] : weightedPick(rnd, STOCK_TONES, STOCK_WEIGHTS) });
        }
      }
    }
  }
  const palletMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.85, envMapIntensity: 0.5, transparent: true });
  const loadMat = new THREE.MeshStandardMaterial({ color: '#ffffff', map: shared.carton, roughness: 0.85, envMapIntensity: 0.4, transparent: true });
  ghost.push(palletMat, loadMat);
  addAll(group, instanced(shared.box, palletMat, pallets), instanced(shared.box, loadMat, loads));

  /* tracked bins without a move: thin outline */
  const neutral = binList;
  if (neutral.length) {
    const E = shared.edges.attributes.position.array;
    const pos = [];
    for (const bin of neutral) {
      for (let i = 0; i < E.length; i += 3) {
        pos.push(bin.pos.x + E[i] * (bin.size.x + 0.04), bin.pos.y + E[i + 1] * (bin.size.y + 0.04), bin.pos.z + E[i + 2] * (bin.size.z + 0.04));
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: '#4A5661', transparent: true, opacity: 0.55 });
    ghost.push(lineMat);
    group.add(new THREE.LineSegments(geo, lineMat));
  }

  /* invisible pick boxes for every tracked bin */
  const binHits = instanced(
    shared.box,
    shared.hitMat,
    binList.map((bin) => ({ p: bin.pos.toArray(), s: [bin.size.x + 0.1, bin.size.y + 0.1, bin.size.z + 0.1] })),
    { cast: false, receive: false },
  );
  if (binHits) {
    binHits.userData.pick = { kind: 'bins' };
    group.add(binHits);
  }

  /* zones: floor tint per aisle across the band, plus a label anchor */
  const zones = [];
  const byZone = new Map();
  for (const bin of binList) {
    if (!bin.zone) continue;
    if (!byZone.has(bin.zone)) byZone.set(bin.zone, []);
    byZone.get(bin.zone).push(bin);
  }
  const tints = [];
  [...byZone.keys()].sort(natCmp).forEach((zone, i) => {
    const band = bands.find((bd) => bd.zone === zone);
    const tint = ZONE_TINTS[i % ZONE_TINTS.length];
    if (band) {
      const z0 = model.bayZ(band.end) - D.bay / 2;
      const z1 = model.bayZ(band.start) + D.bay / 2;
      for (const a of model.aisles) tints.push({ p: [a.cx, 0.004, (z0 + z1) / 2], s: [D.aisle - 0.5, 0.008, z1 - z0 - 0.3], c: tint });
      zones.push({ zone, label: layout.zoneLabels[zone] || '', anchor: new THREE.Vector3(model.bounds.x0 + D.side / 2, 0.05, (z0 + z1) / 2) });
      return;
    }
    const aisleIndices = [...new Set(byZone.get(zone).map((bin) => bin.aisle))].sort((a, b) => a - b);
    const zoneAisles = aisleIndices.map((index) => model.aisles[index]).filter(Boolean);
    if (!zoneAisles.length) return;
    const x = zoneAisles.reduce((sum, aisle) => sum + aisle.cx, 0) / zoneAisles.length;
    for (const aisle of zoneAisles) {
      tints.push({
        p: [aisle.cx, 0.004, -model.runLen / 2],
        s: [D.aisle - 0.5, 0.008, model.runLen - 0.3],
        c: tint,
      });
    }
    zones.push({
      zone,
      label: layout.zoneLabels[zone] || '',
      anchor: new THREE.Vector3(x, model.uprightH + 0.5, -model.runLen / 2),
    });
  });
  const tintMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.4, transparent: true, opacity: 0.55, depthWrite: false });
  addAll(group, instanced(shared.box, tintMat, tints, { cast: false }));

  /* moves */
  const maxSaved = Math.max(1, ...moves.map((m) => m.timeSavedSec || 0));
  const entries = [];
  moves.forEach((m, i) => {
    const from = bins.get(binKey(m.fromBin));
    const to = bins.get(binKey(m.toBin));
    if (!from || !to) return;
    const e = buildMove(m, from, to, model, shared, maxSaved, i);
    entries.push(e);
    group.add(e.obj);
  });

  return { group, ghost, entries, binList, roles, zones, binHits, autoPlaced: binList.some((bin) => bin.auto) };
}

/* ──────────────────────────── HTML label layer ──────────────────────────── */

class LabelLayer {
  constructor(host) {
    this.host = host;
    this.items = new Set();
    this.v = new THREE.Vector3();
  }

  add(node, anchor, { declutter = false, priority = 0, visible = true, steps = null, hideCrowded = false, alignGroup = null } = {}) {
    const wrap = this.host.ownerDocument.createElement('div');
    wrap.className = 'mfdt-label';
    wrap.style.visibility = 'hidden';
    wrap.appendChild(node);
    this.host.appendChild(wrap);
    const item = { wrap, node, anchor: anchor.clone(), declutter, priority, visible, steps, hideCrowded, alignGroup, w: 0, h: 0, x: null, y: null, shown: false, crowded: false };
    this.items.add(item);
    return item;
  }

  clear() {
    for (const it of this.items) it.wrap.remove();
    this.items.clear();
  }

  remeasure() {
    for (const it of this.items) it.w = 0;
  }

  update(camera, w, h) {
    const v = this.v;
    const placed = [];
    const list = [...this.items].sort((a, b) => b.priority - a.priority);
    const alignedRows = new Map();
    for (const it of list) {
      if (!it.visible || !it.alignGroup) continue;
      v.copy(it.anchor).project(camera);
      if (v.z <= -1 || v.z >= 1 || v.x <= -1.1 || v.x >= 1.1 || v.y <= -1.1 || v.y >= 1.1) continue;
      const row = alignedRows.get(it.alignGroup) || { total: 0, count: 0 };
      row.total += (-v.y * 0.5 + 0.5) * h;
      row.count += 1;
      alignedRows.set(it.alignGroup, row);
    }
    for (const it of list) {
      let show = it.visible;
      if (show) {
        v.copy(it.anchor).project(camera);
        show = v.z > -1 && v.z < 1 && v.x > -1.1 && v.x < 1.1 && v.y > -1.1 && v.y < 1.1;
      }
      if (!show) {
        if (it.shown) {
          it.wrap.style.visibility = 'hidden';
          it.shown = false;
        }
        continue;
      }
      if (!it.w) {
        it.w = it.wrap.offsetWidth;
        it.h = it.wrap.offsetHeight;
      }
      let x = clamp((v.x * 0.5 + 0.5) * w - it.w / 2, 4, Math.max(4, w - it.w - 4));
      const row = it.alignGroup ? alignedRows.get(it.alignGroup) : null;
      let y = (row ? row.total / row.count : (-v.y * 0.5 + 0.5) * h) - it.h - 4;
      let crowded = false;
      if (it.declutter) {
        crowded = true;
        const step = it.h + 4;
        for (const k of it.steps || [0, -1, 1, -2, 2]) {
          const dy = k * step;
          const r = { l: x - 3, t: y + dy - 2, r: x + it.w + 3, b: y + dy + it.h + 2 };
          if (!placed.some((p) => r.l < p.r && r.r > p.l && r.t < p.b && r.b > p.t)) {
            y += dy;
            placed.push(r);
            crowded = false;
            break;
          }
        }
      } else {
        placed.push({ l: x, t: y, r: x + it.w, b: y + it.h });
      }
      if (crowded && it.hideCrowded) {
        if (it.shown) {
          it.wrap.style.visibility = 'hidden';
          it.shown = false;
        }
        continue;
      }
      x = Math.round(x);
      y = Math.round(y);
      if (x !== it.x || y !== it.y) {
        it.wrap.style.transform = `translate3d(${x}px, ${y}px, 0)`;
        it.x = x;
        it.y = y;
      }
      if (!it.shown) {
        it.wrap.style.visibility = 'visible';
        it.shown = true;
      }
      if (crowded !== it.crowded) {
        it.crowded = crowded;
        it.node.toggleAttribute('data-crowded', crowded);
      }
    }
  }
}

/* ──────────────────────────── DOM + styles ──────────────────────────── */

function el(doc, tag, props, ...kids) {
  const node = doc.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style') for (const [sk, sv] of Object.entries(v)) node.style.setProperty(sk, sv);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) {
    if (kid === undefined || kid === null || kid === false) continue;
    node.append(kid.nodeType ? kid : doc.createTextNode(String(kid)));
  }
  return node;
}

function icon(doc, d, viewBox = '0 0 16 16', w = 2) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', String(w));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

const CSS = `
.mfdt{--_ink:var(--mfdt-ink,#1c1c1c);--_muted:var(--mfdt-muted,#5f6b72);--_line:var(--mfdt-line,#e8e8e3);--_panel:var(--mfdt-panel,rgba(255,255,255,.9));--_solid:var(--mfdt-surface,#fff);--_hover:var(--mfdt-hover,rgba(28,28,28,.05));--_accent:var(--mfdt-accent,#d40511);--_tint:var(--mfdt-accent-tint,#fff1f2);--_focus:var(--mfdt-focus,#2e77d0);--_scene:var(--mfdt-scene,radial-gradient(120% 90% at 50% 6%,#fbfbfa 0%,#eceeef 55%,#dfe3e6 100%));--_mono:var(--mfdt-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace);--_r:var(--mfdt-radius,12px);--_shadow:var(--mfdt-shadow,0 1px 2px rgba(20,24,28,.06),0 8px 24px rgba(20,24,28,.08));
position:relative;overflow:hidden;width:100%;height:100%;min-height:420px;container:mfdt/inline-size;isolation:isolate;color:var(--_ink);background:var(--_scene);font-size:14px;line-height:1.4;-webkit-font-smoothing:antialiased;-webkit-tap-highlight-color:transparent;outline:none}
.mfdt *,.mfdt *::before,.mfdt *::after{box-sizing:border-box}
.mfdt [hidden]{display:none!important}
.mfdt button{font:inherit;color:inherit;margin:0}
.mfdt :focus-visible{outline:2px solid var(--_focus);outline-offset:2px}
.mfdt-canvas{position:absolute;inset:0;width:100%!important;height:100%!important;display:block;touch-action:none;cursor:grab;outline:none}
.mfdt-canvas:active{cursor:grabbing}
.mfdt[data-hover] .mfdt-canvas{cursor:pointer}
.mfdt .mfdt-canvas:focus-visible{outline:none;box-shadow:inset 0 0 0 2px var(--_focus)}
.mfdt-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1}
.mfdt-label{position:absolute;left:0;top:0;will-change:transform}
.mfdt-ui{position:absolute;inset:0;z-index:2;pointer-events:none;display:grid;grid-template-columns:minmax(0,272px) minmax(0,1fr) minmax(0,316px);grid-template-rows:auto minmax(0,1fr) auto;gap:12px;padding:14px}
.mfdt-panel{pointer-events:auto;background:var(--_panel);border:1px solid var(--_line);border-radius:var(--_r);box-shadow:var(--_shadow);-webkit-backdrop-filter:blur(12px) saturate(1.3);backdrop-filter:blur(12px) saturate(1.3)}
.mfdt-head{grid-area:1/1;align-self:start;padding:10px 14px 11px;min-width:0}
.mfdt-eyebrow{font-family:var(--_mono);font-size:10.5px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--_accent)}
.mfdt-title{font-size:16px;font-weight:800;letter-spacing:-.01em;margin-top:3px}
.mfdt-sub{font-size:12.5px;color:var(--_muted);margin-top:2px}
.mfdt-tools{grid-area:1/3;justify-self:end;align-self:start;display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.mfdt-seg{display:flex;gap:2px;padding:3px}
.mfdt-seg button,.mfdt-toggle{appearance:none;border:0;background:none;cursor:pointer;font-weight:700;font-size:13px;color:var(--_muted);border-radius:9px;padding:7px 12px;white-space:nowrap}
.mfdt-seg button:hover,.mfdt-toggle:hover{color:var(--_ink);background:var(--_hover)}
.mfdt-seg button[aria-pressed="true"]{background:var(--_tint);color:var(--_ink)}
.mfdt-toggle.mfdt-panel{display:inline-flex;align-items:center;gap:8px;padding:7px 12px 7px 9px;border-radius:var(--_r);border:1px solid var(--_line);background:var(--_panel)}
.mfdt-switch{width:26px;height:16px;border-radius:999px;background:var(--_line);position:relative;transition:background .2s;flex:none}
.mfdt-switch::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--_solid);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .2s}
.mfdt-toggle[aria-pressed="true"]{color:var(--_ink)}
.mfdt-toggle[aria-pressed="true"] .mfdt-switch{background:var(--_accent)}
.mfdt-toggle[aria-pressed="true"] .mfdt-switch::after{transform:translateX(10px)}
.mfdt-walk{appearance:none;border:1px solid var(--_line);background:var(--_panel);cursor:pointer;font:inherit;font-size:13px;font-weight:700;color:var(--_muted);border-radius:var(--_r);padding:7px 12px;white-space:nowrap}
.mfdt-walk:hover,.mfdt-walk[aria-pressed="true"]{color:var(--_ink);background:var(--_tint)}
.mfdt-notice{grid-area:1/2;justify-self:center;align-self:start;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;padding:8px 14px;font-size:13px;max-width:100%;min-width:0}
.mfdt-notice b{font-weight:800}
.mfdt-notice[data-tone="error"] b{color:var(--_accent)}
.mfdt-notice code{font-family:var(--_mono);font-size:12px;color:var(--_muted);overflow-wrap:anywhere}
.mfdt-list{grid-area:2/1;align-self:start;display:flex;flex-direction:column;max-height:100%;min-height:0;overflow:hidden}
.mfdt-list-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;padding:11px 14px 7px;font-size:13px;font-weight:800}
.mfdt-count{font-family:var(--_mono);font-size:12px;font-weight:500;color:var(--_muted)}
.mfdt-items{list-style:none;margin:0;padding:0 6px 6px;overflow:auto;min-height:0;overscroll-behavior:contain}
.mfdt-items li[hidden]{display:none!important}
.mfdt-item{width:100%;display:grid;grid-template-columns:10px minmax(0,1fr) auto;align-items:center;column-gap:10px;row-gap:1px;padding:8px 9px;border:0;border-radius:9px;background:none;text-align:left;cursor:pointer}
.mfdt-item:hover{background:var(--_hover)}
.mfdt-item[aria-current="true"]{background:var(--_tint);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--c) 45%,transparent)}
.mfdt-dot{width:10px;height:10px;border-radius:50%;background:var(--c);flex:none;display:inline-block}
.mfdt-item-sku{font-family:var(--_mono);font-weight:700;font-size:13px}
.mfdt-item-saved{font-size:13px;font-weight:700;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.mfdt-item-route{grid-column:2;font-family:var(--_mono);font-size:11.5px;color:var(--_muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mfdt-item-pri{grid-column:3;font-size:11.5px;color:var(--_muted);text-align:right}
.mfdt-empty{margin:0;padding:4px 14px 14px;font-size:12.5px;color:var(--_muted)}
.mfdt-card{grid-area:2/3;align-self:start;max-height:100%;overflow:auto;padding:13px 16px 15px;min-width:0}
.mfdt-card-top{display:flex;align-items:center;gap:8px}
.mfdt-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px 3px 7px;border-radius:999px;font-size:12px;font-weight:700;background:color-mix(in srgb,var(--c) 16%,var(--_solid));color:var(--_ink)}
.mfdt-pill .mfdt-dot{width:8px;height:8px}
.mfdt-status{font-family:var(--_mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--_muted)}
.mfdt-x{margin-left:auto;appearance:none;border:0;background:none;width:28px;height:28px;border-radius:8px;display:grid;place-items:center;cursor:pointer;color:var(--_muted)}
.mfdt-x:hover{background:var(--_hover);color:var(--_ink)}
.mfdt-x svg{width:14px;height:14px}
.mfdt-card-sku{font-family:var(--_mono);font-size:20px;font-weight:700;margin-top:10px}
.mfdt-card-prod{font-size:13px;color:var(--_muted);margin-top:1px}
.mfdt-stock-list{display:grid;gap:8px;margin-top:12px}
.mfdt-stock-lot{display:grid;gap:2px;padding:8px 10px;border:1px solid var(--_line);border-radius:9px;font-size:12px}
.mfdt-stock-lot b{font-family:var(--_mono);font-size:12px}
.mfdt-stock-lot span,.mfdt-stock-lot small{color:var(--_muted)}
.mfdt-route{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr);align-items:center;gap:8px;margin-top:12px;padding:10px 0;border-top:1px solid var(--_line);border-bottom:1px solid var(--_line)}
.mfdt-route svg{width:28px;height:16px;color:var(--c)}
.mfdt-bin{min-width:0}
.mfdt-k{display:block;font-family:var(--_mono);font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--_muted)}
.mfdt-bin b{display:flex;align-items:center;gap:7px;font-family:var(--_mono);font-size:16px;font-weight:700;margin-top:2px}
.mfdt-bin b::after{content:"";width:9px;height:9px;border-radius:2px;background:var(--c);flex:none}
.mfdt-bin.is-to b::after{background:none;box-shadow:inset 0 0 0 2px var(--c)}
.mfdt-stats{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:12px 0 0}
.mfdt-stats div{min-width:0}
.mfdt-stats dd{margin:2px 0 0;font-size:17px;font-weight:800;white-space:nowrap}
.mfdt-stats dd small{font-size:11.5px;font-weight:600;color:var(--_muted);margin-left:2px}
.mfdt-reason{margin-top:12px;padding-top:10px;border-top:1px solid var(--_line)}
.mfdt-reason p{margin:3px 0 0;font-size:13px;line-height:1.45}
.mfdt-legend{grid-area:3/1/auto/3;justify-self:start;align-self:end;display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;padding:8px 12px;font-size:12px;color:var(--_muted);min-width:0}
.mfdt-legend-group{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:center}
.mfdt-code-key{display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
.mfdt-code-key b{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border-radius:5px;background:var(--_hover);color:var(--_ink);font-family:var(--_mono);font-size:10px}
.mfdt-code-key span{font-size:11px}
.mfdt-hint{grid-area:3/3;justify-self:end;align-self:end;font-size:12px;color:var(--_muted);background:var(--_panel);border:1px solid var(--_line);border-radius:999px;padding:6px 11px;transition:opacity .5s ease;white-space:nowrap}
.mfdt-hint[data-off]{opacity:0}
.mfdt-tip{position:absolute;left:0;top:0;z-index:3;pointer-events:none;width:max-content;max-width:min(360px,calc(100% - 16px));max-height:calc(100% - 16px);overflow:auto;padding:8px 10px;border-radius:10px;background:var(--_solid);border:1px solid var(--_line);box-shadow:var(--_shadow);font-size:12px;line-height:1.45;color:var(--_ink);overflow-wrap:anywhere}
.mfdt-tip-row{display:flex;align-items:center;gap:7px;flex-wrap:wrap;white-space:normal}
.mfdt-tip-row i{width:14px;height:3px;border-radius:2px;background:var(--c);flex:none}
.mfdt-tip b{font-family:var(--_mono);font-size:13px}
.mfdt-tip span{color:var(--_muted)}
.mfdt-tip-bin{width:min(360px,calc(100vw - 32px));padding:12px;border-radius:12px;border-color:rgba(28,47,61,.14);box-shadow:0 12px 32px rgba(23,36,46,.2),0 2px 6px rgba(23,36,46,.1);backdrop-filter:blur(12px)}
.mfdt-tip-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-bottom:9px;border-bottom:1px solid var(--_line)}
.mfdt-tip-heading{min-width:0}
.mfdt-tip-kicker{display:block;margin-bottom:2px;font-family:var(--_mono);font-size:9px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--_muted)}
.mfdt-tip-bin .mfdt-tip-id{display:block;font-size:12px;line-height:1.35;overflow-wrap:anywhere}
.mfdt-tip-status{flex:none;padding:4px 8px;border-radius:999px;background:#edf5ef;color:#356947;font-size:10px;font-weight:750;white-space:nowrap}
.mfdt-tip-status.is-empty{background:#f1f3f4;color:#69747d}
.mfdt-tip-status.is-unknown{background:#fff3e8;color:#8a5428}
.mfdt-tip-stock{padding:9px 10px;border:1px solid var(--_line);border-radius:9px;background:color-mix(in srgb,var(--_hover) 55%,var(--_solid))}
.mfdt-tip-section-label{display:block;margin-bottom:5px;font-family:var(--_mono);font-size:9px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--_muted)}
.mfdt-tip-lot{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:2px 10px}
.mfdt-tip-lot+.mfdt-tip-lot{margin-top:8px;padding-top:8px;border-top:1px solid var(--_line)}
.mfdt-tip-lot b{font-size:11px}
.mfdt-tip-lot span{grid-column:1;color:var(--_ink);font-size:11px}
.mfdt-tip-lot small{grid-column:2;grid-row:1/3;align-self:center;color:var(--_muted);font-size:10px;text-align:right;white-space:nowrap}
.mfdt-tip-stock-empty{color:var(--_muted);font-size:11px}
.mfdt-tip-move{display:flex;align-items:center;gap:7px;margin-top:9px;color:var(--_muted);font-size:10px}
.mfdt-tip-move i{width:7px;height:7px;border-radius:50%;background:#a0a9b1;flex:none}
.mfdt-tip-move.is-planned{color:var(--_ink)}
.mfdt-tip-move.is-planned i{background:var(--_accent)}
.mfdt-chip{pointer-events:auto;display:inline-flex;align-items:center;gap:6px;padding:3px 9px 3px 6px;border-radius:999px;border:1px solid var(--_line);background:var(--_solid);box-shadow:0 1px 2px rgba(0,0,0,.08),0 3px 10px rgba(0,0,0,.08);font-size:12px;line-height:1.3;white-space:nowrap;cursor:pointer;transition:opacity .25s}
.mfdt-chip b{font-family:var(--_mono);font-weight:700}
.mfdt-chip .mfdt-dot{width:9px;height:9px}
.mfdt-chip:hover{border-color:var(--c)}
.mfdt-chip[aria-pressed="true"]{border-color:var(--c);box-shadow:0 0 0 2px color-mix(in srgb,var(--c) 35%,transparent),0 3px 10px rgba(0,0,0,.12)}
.mfdt-chip[data-dim]{opacity:.35}
.mfdt-chip[data-crowded]:not([aria-pressed="true"]){opacity:.5}
.mfdt-tag{display:flex;flex-direction:column;padding:4px 9px 5px;border-radius:8px;background:var(--_solid);border:1px solid var(--_line);box-shadow:var(--_shadow);line-height:1.25}
.mfdt-tag .mfdt-k{font-size:9.5px}
.mfdt-tag b{display:flex;align-items:center;gap:6px;font-family:var(--_mono);font-size:13px}
.mfdt-tag b::after{content:"";width:8px;height:8px;border-radius:2px;background:var(--c)}
.mfdt-tag.is-to b::after{background:none;box-shadow:inset 0 0 0 2px var(--c)}
.mfdt-zone{display:flex;gap:6px;align-items:baseline;padding:3px 8px;border-radius:7px;background:var(--_panel);border:1px solid var(--_line);font-size:11.5px;color:var(--_muted);white-space:nowrap}
.mfdt-zone b{font-family:var(--_mono);font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--_ink)}
@container mfdt (max-width:760px){
.mfdt-ui{grid-template-columns:minmax(0,1fr) auto;grid-template-rows:auto auto minmax(0,1fr) auto;padding:10px;gap:8px}
.mfdt-head{grid-area:1/1;padding:8px 12px}
.mfdt-eyebrow{display:none}
.mfdt-title{font-size:15px;margin:0}
.mfdt-tools{grid-area:1/2;flex-direction:column;align-items:flex-end}
.mfdt-notice{grid-area:2/1/auto/3;justify-self:stretch}
.mfdt-card,.mfdt-list{grid-area:4/1/auto/3;align-self:end;max-height:none}
.mfdt-card{max-height:min(330px,100%)}
.mfdt[data-selected] .mfdt-list{display:none}
.mfdt-list-head{padding:8px 12px 6px}
.mfdt-items{display:flex;gap:6px;overflow-x:auto;padding:0 8px 8px;scroll-snap-type:x proximity}
.mfdt-items li{flex:0 0 auto;width:208px;scroll-snap-align:start}
.mfdt-item{background:var(--_hover)}
.mfdt-legend,.mfdt-hint{display:none}
}
@container mfdt (max-width:440px){.mfdt-sub{display:none}.mfdt-seg button{padding:6px 9px}}
@media (prefers-reduced-motion:reduce){.mfdt *{transition:none!important}}
`;

function injectStyles(doc) {
  if (doc.getElementById('mfdt-styles')) return;
  const style = doc.createElement('style');
  style.id = 'mfdt-styles';
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function buildUI(doc, { coarse }) {
  const E = (...a) => el(doc, ...a);
  const root = E('div', { class: 'mfdt', role: 'region', 'aria-label': 'Warehouse digital twin', tabindex: '-1' });
  const labels = E('div', { class: 'mfdt-labels' });
  const title = E('div', { class: 'mfdt-title' });
  const sub = E('div', { class: 'mfdt-sub' });
  const head = E('header', { class: 'mfdt-head mfdt-panel' }, E('div', { class: 'mfdt-eyebrow', text: 'Warehouse' }), title, sub);
  const viewButtons = Object.keys(VIEW_LABELS).map((v) =>
    E('button', { type: 'button', 'data-view': v, 'aria-pressed': 'false', text: VIEW_LABELS[v] }),
  );
  const walk = E('button', { type: 'button', class: 'mfdt-walk mfdt-panel', 'aria-pressed': 'false' }, 'Walk');
  const tools = E('div', { class: 'mfdt-tools' }, E('div', { class: 'mfdt-seg mfdt-panel', role: 'group', 'aria-label': 'Camera view' }, viewButtons), walk);
  const notice = E('div', { class: 'mfdt-notice mfdt-panel', role: 'status', hidden: true });
  const count = E('span', { class: 'mfdt-count' });
  const items = E('ol', { class: 'mfdt-items' });
  const empty = E('p', { class: 'mfdt-empty', hidden: true });
  const list = E('nav', { class: 'mfdt-list mfdt-panel', 'aria-label': 'Recommended moves' }, E('div', { class: 'mfdt-list-head' }, E('span', { text: 'Recommended moves' }), count), items, empty);
  const card = E('section', { class: 'mfdt-card mfdt-panel', hidden: true, 'aria-live': 'polite', 'aria-label': 'Selected move' });
  const legend = E('div', { class: 'mfdt-legend mfdt-panel' });
  const hint = E('div', {
    class: 'mfdt-hint',
    text: coarse ? 'Drag to orbit · Pinch to zoom · Tap a move' : 'Drag to orbit · Right-drag to pan · Scroll to zoom',
  });
  const grid = E('div', { class: 'mfdt-ui' }, head, tools, notice, list, card, legend, hint);
  const tip = E('div', { class: 'mfdt-tip', hidden: true, role: 'tooltip' });
  root.append(labels, grid, tip);
  return { root, labels, title, sub, viewButtons, walk, notice, list, count, items, empty, card, legend, hint, tip };
}

/* ──────────────────────────── controller ──────────────────────────── */

/**
 * @typedef {object} TwinOptions
 * @property {object[]} [moves]       LayoutRecommendation rows (see README for accepted field names)
 * @property {object[]} [bins]        Bin-table rows; pins bins to real slots. Optional.
 * @property {object}   [layout]      Overrides for DEFAULT_LAYOUT (aisles, bays, levels, …)
 * @property {'overview'|'plan'|'floor'} [initialView]
 * @property {string}   [title]       Panel title; defaults to layout.name
 * @property {boolean}  [focusGhost]  Fade the racking while a move is selected (default true)
 * @property {boolean}  [shadows]     Shadow map (default true)
 * @property {boolean}  [intro]       Short camera move on first load (default true)
 * @property {number}   [maxPixelRatio] Cap for devicePixelRatio (default 2)
 * @property {(move: object|null) => void} [onSelect] Called when the selected move changes
 */

/**
 * Mount the 3D digital twin into `container` (give it a height, e.g. 640px).
 * @param {HTMLElement} container
 * @param {TwinOptions} [options]
 */
export function createDigitalTwin(container, options = {}) {
  if (!container || typeof container.appendChild !== 'function') {
    throw new TypeError('createDigitalTwin(container): pass a DOM element');
  }
  const doc = container.ownerDocument || document;
  const win = doc.defaultView || window;
  injectStyles(doc);
  const opts = { focusGhost: true, shadows: true, intro: true, ...options };
  const layout = resolveLayout(opts.layout);
  const model = buildModel(layout);
  const media = (q) => !!(win.matchMedia && win.matchMedia(q).matches);
  const reduceMotion = opts.reducedMotion !== undefined ? !!opts.reducedMotion : media('(prefers-reduced-motion: reduce)');
  const ui = buildUI(doc, { coarse: media('(pointer: coarse)') });
  container.appendChild(ui.root);

  const size = { w: 0, h: 0 };
  const state = {
    moves: [],
    binRows: Array.isArray(opts.bins) ? opts.bins : [],
    inv: null,
    entries: [],
    selectedId: null,
    selectedKey: null,
    selectedBinKey: null,
    hoverId: null,
    filter: { query: '', status: 'all', priority: 'all' },
    view: null,
    polar: POLAR_MAX,
    userMoved: false,
    ghost: 1,
    ghostTo: 1,
    offset: 0,
    offsetTo: 0,
    padL: 0,
    padR: 0,
    tween: null,
    dirty: true,
    running: false,
    inView: true,
    docVisible: !doc.hidden,
    loading: false,
    error: null,
    disposed: false,
    raf: 0,
    last: 0,
    pointer: null,
    buttons: 0,
    hoverPending: false,
    walking: false,
    walkYaw: 0,
    walkPitch: 0,
    walkKeys: new Set(),
    walkLookPointer: null,
  };
  const invalidate = () => {
    state.dirty = true;
  };

  /* renderer, scene, lights, camera */
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(win.devicePixelRatio || 1, opts.maxPixelRatio || 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping !== undefined ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = opts.shadows !== false;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false; // the racking is static: re-render shadows only on rebuild
  const canvas = renderer.domElement;
  canvas.className = 'mfdt-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', '3D warehouse view. Select a recommended move from the list to show its route.');
  ui.root.insertBefore(canvas, ui.root.firstChild);

  const fontFamily = () => (win.getComputedStyle(ui.root).fontFamily || '').trim() || 'system-ui, sans-serif';
  const shared = makeShared(renderer);
  shared.font = fontFamily();

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  scene.environment = envRT.texture;
  if (typeof room.dispose === 'function') room.dispose();
  pmrem.dispose();

  const hemi = new THREE.HemisphereLight(0xffffff, 0xb8c0c8, 0.45);
  const sun = new THREE.DirectionalLight(0xffffff, 1.85);
  sun.position.set(model.center.x - 16, 42, model.center.z + 14);
  sun.target.position.copy(model.center);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const half = Math.max(model.width, model.depth) * 0.62;
  Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 5, far: 120 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  sun.shadow.radius = 2.5;
  scene.add(hemi, sun, sun.target);

  const world = buildWarehouse(model, shared);
  scene.add(world.group, world.ceiling);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 600);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.screenSpacePanning = false;
  controls.minDistance = 2.5;
  controls.maxDistance = 150;
  controls.maxPolarAngle = POLAR_MAX;
  controls.rotateSpeed = 0.7;
  controls.zoomSpeed = 0.9;
  controls.addEventListener('start', () => {
    state.tween = null;
    state.userMoved = true;
    hideHint();
  });
  controls.addEventListener('change', invalidate);

  const labels = new LabelLayer(ui.labels);
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const floorPlane = new THREE.Plane(UP, 0);

  /* ── data → scene ── */

  const moveKey = (m) => `${binKey(m.sku)}|${binKey(m.fromBin)}|${binKey(m.toBin)}`;
  const selectedEntry = () => state.entries.find((e) => e.move.id === state.selectedId) || null;
  const publicMove = (m) => ({ ...m });

  function tagNode(bin, caption, color, isTo) {
    return el(
      doc,
      'div',
      { class: `mfdt-tag${isTo ? ' is-to' : ''}`, style: { '--c': color } },
      el(doc, 'span', { class: 'mfdt-k', text: caption }),
      el(doc, 'b', { text: bin.id }),
    );
  }

  function rebuild() {
    if (state.inv) {
      scene.remove(state.inv.group);
      disposeTree(state.inv.group, shared.keep);
    }
    labels.clear();
    ui.items.replaceChildren();
    const placement = placeBins(model, state.binRows, state.moves);
    state.inv = buildInventory(model, placement, state.moves, shared);
    state.entries = state.inv.entries;
    scene.add(state.inv.group);

    const zoneRank = new Map(layout.zoneOrder.map((zone, index) => [zone, index]));
    const orderedZones = [...state.inv.zones].sort(
      (a, b) => (zoneRank.get(a.zone) ?? layout.zoneOrder.length) - (zoneRank.get(b.zone) ?? layout.zoneOrder.length)
        || natCmp(a.zone, b.zone),
    );
    for (const z of orderedZones) {
      const node = el(doc, 'div', { class: 'mfdt-zone' }, el(doc, 'b', { text: formatTwinZoneLabel(z.zone) }), z.label ? el(doc, 'span', { text: z.label }) : null);
      labels.add(node, z.anchor, { priority: 50, declutter: true, steps: [0], hideCrowded: true, alignGroup: 'zone-labels' });
    }
    const sorted = [...state.entries].sort(
      (a, b) =>
        PRIORITIES[a.move.priority].rank - PRIORITIES[b.move.priority].rank ||
        (b.move.timeSavedSec || 0) - (a.move.timeSavedSec || 0),
    );
    for (const e of sorted) {
      const m = e.move;
      const P = PRIORITIES[m.priority];
      const chip = el(
        doc,
        'button',
        { type: 'button', class: 'mfdt-chip', tabindex: '-1', style: { '--c': P.color }, 'aria-pressed': 'false', title: `${m.sku} · ${m.fromBin} → ${m.toBin}` },
        el(doc, 'span', { class: 'mfdt-dot', 'aria-hidden': 'true' }),
        el(doc, 'b', { text: m.sku }),
      );
      chip.addEventListener('click', () => select(m.id));
      chip.addEventListener('pointerenter', () => setHover(m.id));
      chip.addEventListener('pointerleave', () => setHover(null));
      e.basePriority = 10 - P.rank;
      e.chip = labels.add(chip, e.chipAnchor, { declutter: true, priority: e.basePriority });
      e.tagFrom = labels.add(tagNode(e.from, 'Current bin', P.color, false), e.fromAnchor, { priority: 30, visible: false });
      e.tagTo = labels.add(tagNode(e.to, 'Recommended', P.color, true), e.toAnchor, { priority: 31, visible: false });
      e.button = el(
        doc,
        'button',
        { type: 'button', class: 'mfdt-item', style: { '--c': P.color }, 'aria-current': 'false' },
        el(doc, 'span', { class: 'mfdt-dot', 'aria-hidden': 'true' }),
        el(doc, 'span', { class: 'mfdt-item-sku', text: m.sku }),
        el(doc, 'span', { class: 'mfdt-item-saved', text: m.timeSavedSec === null ? '—' : fmtSec(m.timeSavedSec) }),
        el(doc, 'span', { class: 'mfdt-item-route', text: `${m.fromBin} → ${m.toBin}` }),
        el(doc, 'span', { class: 'mfdt-item-pri', text: P.label }),
      );
      e.button.addEventListener('click', () => select(m.id === state.selectedId ? null : m.id, { fly: m.id !== state.selectedId }));
      e.button.addEventListener('pointerenter', () => setHover(m.id));
      e.button.addEventListener('pointerleave', () => setHover(null));
      e.li = el(doc, 'li', null, e.button);
      ui.items.appendChild(e.li);
    }

    const kept = state.selectedKey && state.entries.find((e) => moveKey(e.move) === state.selectedKey);
    state.selectedId = kept ? kept.move.id : null;
    if (!kept) state.selectedKey = null;
    if (!state.inv.binList.some((bin) => bin.key === state.selectedBinKey)) state.selectedBinKey = null;
    state.hoverId = null;
    animateMoves(0);
    for (const e of state.entries) e.pulse.visible = !reduceMotion;
    renderLegend();
    applyFilter(false);
    applyGhost();
    applyEmphasis();
    renderCard();
    renderer.shadowMap.needsUpdate = true;
    invalidate();
  }

  function matches(m) {
    const f = state.filter;
    if (f.status && f.status !== 'all' && m.status !== f.status) return false;
    if (f.priority && f.priority !== 'all' && m.priority !== f.priority) return false;
    const q = String(f.query || '').trim().toLowerCase();
    if (!q) return true;
    return [m.sku, m.product, m.fromBin, m.toBin, m.reason].some((v) => String(v || '').toLowerCase().includes(q));
  }

  function applyFilter(autoSelect = true) {
    let shown = 0;
    for (const e of state.entries) {
      e.visible = matches(e.move);
      const focused = e.move.id === state.selectedId || e.move.id === state.hoverId;
      e.obj.visible = e.visible && focused;
      e.chip.visible = e.visible && focused;
      e.li.hidden = !e.visible;
      if (e.visible) shown += 1;
    }
    const sel = selectedEntry();
    if (sel && !sel.visible) select(null, { fly: false });
    const total = state.entries.length;
    ui.count.textContent = shown === total ? String(total) : `${shown} of ${total}`;
    ui.empty.hidden = shown > 0;
    ui.empty.textContent = total ? 'No moves match the current filter.' : 'No recommended moves in this engine output.';
    renderSummary();
    if (autoSelect) {
      const q = String(state.filter.query || '').trim().toUpperCase();
      const exact = q ? state.entries.filter((e) => e.visible && e.move.sku.toUpperCase() === q) : [];
      if (exact.length === 1 && exact[0].move.id !== state.selectedId) select(exact[0].move.id);
    }
    applyEmphasis();
  }

  function renderSummary() {
    const vis = state.entries.filter((e) => e.visible);
    const total = state.entries.length;
    const saved = vis.reduce((s, e) => s + (e.move.timeSavedSec || 0), 0);
    const trackedBins = state.inv?.binList.filter((bin) => bin.occupancy === 'occupied' || bin.occupancy === 'empty') || [];
    const occupiedBins = trackedBins.filter((bin) => bin.occupancy === 'occupied').length;
    const emptyBins = trackedBins.length - occupiedBins;
    const stockSummary = trackedBins.length ? `${occupiedBins} occupied · ${emptyBins} empty bins` : '';
    ui.title.textContent = opts.title || layout.name;
    const moveSummary = total
      ? `${vis.length === total ? total : `${vis.length} of ${total}`} move${total === 1 ? '' : 's'} · ${fmtTotal(saved)} saved per day`
      : 'No recommended moves';
    ui.sub.textContent = [stockSummary, moveSummary].filter(Boolean).join(' · ');
  }

  function renderLegend() {
    const E = (...a) => el(doc, ...a);
    ui.legend.replaceChildren(
      E('div', { class: 'mfdt-legend-group', role: 'list', 'aria-label': 'Bin location code meanings' },
        [['Z', 'Zone'], ['A', 'Aisle'], ['R', 'Rack'], ['L', 'Shelf level'], ['F', 'Rack face'], ['B', 'Bin']]
          .map(([code, meaning]) => E('span', { class: 'mfdt-code-key', role: 'listitem' },
            E('b', { text: code }),
            E('span', { text: meaning }),
          )),
      ),
    );
  }

  function renderCard() {
    const card = ui.card;
    const e = selectedEntry();
    const selectedBin = state.inv?.binList.find((bin) => bin.key === state.selectedBinKey);
    if (!e && !selectedBin) {
      card.hidden = true;
      card.replaceChildren();
      updatePads();
      return;
    }
    const E = (...a) => el(doc, ...a);
    if (!e) {
      const lots = selectedBin.inventory || [];
      const occupied = selectedBin.occupancy === 'occupied';
      const occupancyLabel = occupied ? 'Occupied' : selectedBin.occupancy === 'empty' ? 'Empty' : 'Status unavailable';
      const close = E('button', { type: 'button', class: 'mfdt-x', 'aria-label': 'Close bin details' }, icon(doc, 'M4 4l8 8M12 4l-8 8'));
      close.addEventListener('click', () => select(null, { fly: false }));
      card.style.setProperty('--c', occupied ? '#3f7f58' : selectedBin.occupancy === 'empty' ? '#77828c' : '#d40511');
      card.replaceChildren(
        E('div', { class: 'mfdt-card-top' }, E('span', { class: 'mfdt-pill' }, E('span', { class: 'mfdt-dot' }), occupancyLabel), close),
        E('div', { class: 'mfdt-card-sku', text: selectedBin.id }),
        E('div', { class: 'mfdt-card-prod', text: describeBin(selectedBin) }),
        E('dl', { class: 'mfdt-stats' },
          E('div', null, E('dt', { class: 'mfdt-k', text: 'Quantity on hand' }), E('dd', null, fmtInt(selectedBin.totalQuantityOnHand))),
          E('div', null, E('dt', { class: 'mfdt-k', text: 'Products' }), E('dd', null, String(lots.length))),
        ),
        lots.length
          ? E('div', { class: 'mfdt-stock-list' }, lots.map((lot) =>
            E('div', { class: 'mfdt-stock-lot' },
              E('b', { text: lot.sku || lot.productId || 'Product' }),
              E('span', { text: lot.productName || '' }),
              E('small', { text: `${fmtInt(lot.quantityOnHand)} units${lot.inventoryStatus ? ` · ${lot.inventoryStatus}` : ''}` }),
            )))
          : E('p', { class: 'mfdt-empty', text: occupied ? 'Stock is present, but product details are unavailable.' : selectedBin.occupancy === 'empty' ? 'This storage bin is currently empty.' : 'No occupancy snapshot is available for this bin.' }),
      );
      card.hidden = false;
      updatePads();
      return;
    }
    const m = e.move;
    const P = PRIORITIES[m.priority];
    const close = E('button', { type: 'button', class: 'mfdt-x', 'aria-label': 'Close move details' }, icon(doc, 'M4 4l8 8M12 4l-8 8'));
    close.addEventListener('click', () => select(null, { fly: false }));
    const bin = (b, caption, isTo) =>
      E('div', { class: `mfdt-bin${isTo ? ' is-to' : ''}` }, E('span', { class: 'mfdt-k', text: caption }), E('b', { text: b.id }));
    const stat = (k, v, unit) => E('div', null, E('dt', { class: 'mfdt-k', text: k }), E('dd', null, v, unit ? E('small', { text: unit }) : null));
    card.style.setProperty('--c', P.color);
    card.replaceChildren(
      E('div', { class: 'mfdt-card-top' }, E('span', { class: 'mfdt-pill' }, E('span', { class: 'mfdt-dot' }), P.label), m.status !== 'pending' ? E('span', { class: 'mfdt-status', text: m.status }) : null, close),
      E('div', { class: 'mfdt-card-sku', text: m.sku }),
      E('div', { class: 'mfdt-card-prod', text: [m.product, m.velocity ? `Velocity ${m.velocity}` : ''].filter(Boolean).join(' · ') || ' ' }),
      E('div', { class: 'mfdt-route' }, bin(e.from, 'Current bin', false), icon(doc, 'M2 8h22m-6-6 6 6-6 6', '0 0 28 16'), bin(e.to, 'Recommended', true)),
      E(
        'dl',
        { class: 'mfdt-stats' },
        stat('Daily picks', fmtInt(m.dailyPicks)),
        stat('Time saved', fmtSec(m.timeSavedSec), m.timeSavedSec === null ? '' : '/day'),
        stat('Per pick', fmtPerPick(m)),
      ),
      m.reason ? E('div', { class: 'mfdt-reason' }, E('span', { class: 'mfdt-k', text: 'Reason' }), E('p', { text: m.reason })) : null,
    );
    card.hidden = false;
    updatePads();
  }

  function renderNotice() {
    const n = ui.notice;
    if (state.error) {
      n.dataset.tone = 'error';
      n.replaceChildren(el(doc, 'b', { text: 'Could not load engine output' }), el(doc, 'code', { text: state.error }));
      n.hidden = false;
    } else if (state.loading) {
      n.dataset.tone = 'info';
      n.replaceChildren(el(doc, 'b', { text: 'Refreshing engine output…' }));
      n.hidden = false;
    } else {
      n.hidden = true;
      n.replaceChildren();
    }
  }

  /* ── emphasis, ghosting, hover ── */

  function applyEmphasis() {
    const sel = state.selectedId;
    const hov = state.hoverId;
    for (const e of state.entries) {
      const isSel = e.move.id === sel;
      const focused = isSel || e.move.id === hov;
      const dim = !!sel && !isSel;
      e.obj.visible = e.visible && focused;
      e.chip.visible = e.visible && focused;
      const f = (dim ? DIM : 1) * (state.loading ? 0.45 : 1);
      if (f !== e.fade) {
        e.fade = f;
        for (const [m, base, dw] of e.mats) {
          m.opacity = base * f;
          m.depthWrite = dw && f > 0.99;
        }
      }
      e.halo.visible = e.visible && (isSel || (e.move.id === hov && !dim));
      e.haloMat.opacity = isSel ? 0.26 : 0.18;
      e.chip.node.toggleAttribute('data-dim', dim);
      e.chip.node.setAttribute('aria-pressed', String(isSel));
      e.chip.priority = isSel ? 40 : e.move.id === hov ? 20 : e.basePriority;
      e.tagFrom.visible = isSel && e.visible;
      e.tagTo.visible = isSel && e.visible;
      e.button.setAttribute('aria-current', String(isSel));
    }
    state.ghostTo = sel && opts.focusGhost && state.view !== 'floor' ? GHOST_OPACITY : 1;
    ui.root.toggleAttribute('data-selected', !!sel);
    invalidate();
  }

  function applyGhost() {
    const mats = state.inv ? world.ghost.concat(state.inv.ghost) : world.ghost;
    for (const m of mats) {
      if (m.userData.base === undefined) m.userData.base = m.opacity;
      m.opacity = m.userData.base * state.ghost;
      m.depthWrite = state.ghost > 0.98;
    }
  }

  function setHover(id) {
    if (id === state.hoverId) return;
    state.hoverId = id;
    applyEmphasis();
  }

  function animateMoves(t) {
    for (const e of state.entries) {
      if (!e.visible || (e.move.id !== state.selectedId && e.move.id !== state.hoverId)) continue;
      const phase = ((t * 6.5) / e.length + e.seed) % 1;
      e.dots.forEach((d, i) => d.position.copy(e.curve.getPointAt((phase + i / e.dots.length) % 1)));
      if (!reduceMotion) {
        const k = (t / 1.8 + e.seed) % 1;
        e.pulse.scale.setScalar(1 + k * 0.9);
        e.pulseMat.opacity = (1 - k) * 0.7 * e.fade;
      }
    }
  }

  /* ── picking + tooltip ── */

  function pick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height || !state.inv) return null;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const targets = [];
    for (const e of state.entries) {
      if (e.visible && (e.move.id === state.selectedId || e.move.id === state.hoverId)) {
        targets.push(e.hit, e.srcLoad, e.dstGhost);
      }
    }
    if (state.inv.binHits) targets.push(state.inv.binHits);
    for (const h of raycaster.intersectObjects(targets, false)) {
      const d = h.object.userData.pick;
      if (!d) continue;
      if (d.kind === 'move') return { kind: 'move', entry: d.entry };
      const bin = state.inv.binList[h.instanceId];
      if (bin) return { kind: 'bin', bin };
    }
    return null;
  }

  function floorPoint(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.ray.intersectPlane(floorPlane, new THREE.Vector3());
  }

  function isWalkable(x, z) {
    const b = model.bounds;
    if (x < b.x0 + 0.7 || x > b.x1 - 0.7 || z < b.z0 + 0.7 || z > b.z1 - 0.7) return false;
    if (z >= -model.runLen && z <= 0 && model.racks.some((rack) => x >= rack.x0 - 0.3 && x <= rack.x1 + 0.3)) return false;
    return true;
  }

  function updateWalkTarget() {
    const direction = new THREE.Vector3(
      -Math.sin(state.walkYaw) * Math.cos(state.walkPitch),
      Math.sin(state.walkPitch),
      -Math.cos(state.walkYaw) * Math.cos(state.walkPitch),
    );
    camera.rotation.order = 'YXZ';
    camera.rotation.set(state.walkPitch, state.walkYaw, 0);
    controls.target.copy(camera.position).addScaledVector(direction, 5);
  }

  function setWalkMode(on) {
    state.walking = !!on;
    if (state.walking) state.tween = null;
    state.walkKeys.clear();
    state.walkLookPointer = null;
    controls.enabled = !state.walking;
    ui.walk.setAttribute('aria-pressed', String(state.walking));
    ui.walk.textContent = state.walking ? 'Exit walk' : 'Walk';
    ui.hint.removeAttribute('data-off');
    ui.hint.textContent = state.walking
      ? 'Click a clear floor spot · WASD/arrows to walk · Drag to look · Esc to exit'
      : media('(pointer: coarse)')
        ? 'Drag to orbit · Pinch to zoom · Tap a move'
        : 'Drag to orbit · Right-drag to pan · Scroll to zoom';
    if (!state.walking) {
      state.view = null;
      state.userMoved = true;
      state.polar = POLAR_MAX;
      controls.maxPolarAngle = POLAR_MAX;
      updateWalkTarget();
      controls.update();
    }
    invalidate();
  }

  function startWalkAt(point) {
    if (!isWalkable(point.x, point.z)) {
      ui.hint.textContent = 'Choose a clear floor area outside the racks.';
      ui.hint.removeAttribute('data-off');
      return false;
    }
    camera.position.set(point.x, 1.65, point.z);
    const aisle = model.aisles.reduce((nearest, item) =>
      Math.abs(item.cx - point.x) < Math.abs(nearest.cx - point.x) ? item : nearest,
    );
    state.walkYaw = Math.atan2(point.x - aisle.cx, 1);
    state.walkPitch = 0;
    setWalkMode(true);
    updateWalkTarget();
    canvas.focus();
    return true;
  }

  function updateWalk(dt) {
    const forward = Number(state.walkKeys.has('w') || state.walkKeys.has('arrowup'))
      - Number(state.walkKeys.has('s') || state.walkKeys.has('arrowdown'));
    const sideways = Number(state.walkKeys.has('d') || state.walkKeys.has('arrowright'))
      - Number(state.walkKeys.has('a') || state.walkKeys.has('arrowleft'));
    if (!forward && !sideways) return false;
    const distance = 4.2 * dt / Math.hypot(forward, sideways);
    const dx = (-Math.sin(state.walkYaw) * forward + Math.cos(state.walkYaw) * sideways) * distance;
    const dz = (-Math.cos(state.walkYaw) * forward - Math.sin(state.walkYaw) * sideways) * distance;
    const x = camera.position.x;
    const z = camera.position.z;
    if (isWalkable(x + dx, z)) camera.position.x += dx;
    if (isWalkable(camera.position.x, z + dz)) camera.position.z += dz;
    updateWalkTarget();
    return true;
  }

  function showTip(hit, clientX, clientY) {
    const tip = ui.tip;
    if (!hit) {
      tip.hidden = true;
      return;
    }
    const E = (...a) => el(doc, ...a);
    tip.classList.toggle('mfdt-tip-bin', hit.kind !== 'move');
    if (hit.kind === 'move') {
      const m = hit.entry.move;
      const P = PRIORITIES[m.priority];
      tip.style.setProperty('--c', P.color);
      tip.replaceChildren(
        E('div', { class: 'mfdt-tip-row' }, E('i'), E('b', { text: m.sku }), E('span', { text: `${m.fromBin} → ${m.toBin}` })),
        E('div', null, E('strong', { text: m.timeSavedSec === null ? '—' : `${fmtSec(m.timeSavedSec)}/day` }), E('span', { text: ` saved · ${P.label}` })),
      );
    } else {
      const bin = hit.bin;
      const r = state.inv.roles.get(bin.key);
      const moveLabels = [];
      if (r) {
        for (const m of r.src) moveLabels.push(`Current bin of ${m.sku}`);
        for (const m of r.dst) moveLabels.push(`Recommended for ${m.sku}`);
      }
      const occupancy = bin.occupancy === 'occupied' ? 'Occupied' : bin.occupancy === 'empty' ? 'Empty' : 'Status unavailable';
      const statusClass = bin.occupancy === 'occupied' ? '' : bin.occupancy === 'empty' ? ' is-empty' : ' is-unknown';
      const stockContent = bin.inventory.length
        ? bin.inventory.map((lot) => E(
          'div',
          { class: 'mfdt-tip-lot' },
          E('b', { text: lot.sku || lot.productId || 'Product' }),
          E('span', { text: lot.productName || 'Product details unavailable' }),
          E('small', { text: `${fmtInt(lot.quantityOnHand)} units` }),
        ))
        : E('div', {
          class: 'mfdt-tip-stock-empty',
          text: bin.occupancy === 'occupied'
            ? `${fmtInt(bin.totalQuantityOnHand)} units on hand · Product details unavailable`
            : bin.occupancy === 'empty' ? 'No stock in this location' : 'Live occupancy is unavailable',
        });
      tip.style.removeProperty('--c');
      tip.replaceChildren(
        E('div', { class: 'mfdt-tip-head' },
          E('div', { class: 'mfdt-tip-heading' },
            E('span', { class: 'mfdt-tip-kicker', text: 'Storage bin' }),
            E('b', { class: 'mfdt-tip-id', text: bin.id }),
          ),
          E('span', { class: `mfdt-tip-status${statusClass}`, text: occupancy }),
        ),
        E('div', { class: 'mfdt-tip-stock' },
          E('span', { class: 'mfdt-tip-section-label', text: 'On-hand stock' }),
          stockContent,
        ),
        E('div', { class: `mfdt-tip-move${moveLabels.length ? ' is-planned' : ''}` },
          E('i', { 'aria-hidden': 'true' }),
          E('span', { text: moveLabels.length ? moveLabels.join(' · ') : 'No move planned' }),
        ),
      );
    }
    tip.hidden = false;
    const rr = ui.root.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = clientX - rr.left + 14;
    let y = clientY - rr.top + 16;
    if (x + tw > rr.width - 8) x = clientX - rr.left - tw - 14;
    if (y + th > rr.height - 8) y = clientY - rr.top - th - 12;
    x = clamp(x, 8, Math.max(8, rr.width - tw - 8));
    y = clamp(y, 8, Math.max(8, rr.height - th - 8));
    tip.style.transform = `translate(${Math.round(Math.max(8, x))}px, ${Math.round(Math.max(8, y))}px)`;
  }

  /* ── selection + camera ── */

  function findEntry(x) {
    if (x === null || x === undefined || x === '') return null;
    const s = typeof x === 'object' ? x.id || x.sku : String(x);
    if (!s) return null;
    const up = String(s).toUpperCase();
    return state.entries.find((e) => e.move.id === s) || state.entries.find((e) => e.move.sku.toUpperCase() === up) || null;
  }

  function revealInList(li) {
    const box = ui.items;
    const b = box.getBoundingClientRect();
    const r = li.getBoundingClientRect();
    if (r.top < b.top) box.scrollTop -= b.top - r.top + 4;
    else if (r.bottom > b.bottom) box.scrollTop += r.bottom - b.bottom + 4;
    if (r.left < b.left) box.scrollLeft -= b.left - r.left + 8;
    else if (r.right > b.right) box.scrollLeft += r.right - b.right + 8;
  }

  function select(x, { fly = true, emit = true } = {}) {
    const e = findEntry(x);
    const next = e && e.visible ? e : null;
    const nextId = next ? next.move.id : null;
    const changed = nextId !== state.selectedId;
    state.selectedId = nextId;
    state.selectedKey = next ? moveKey(next.move) : null;
    state.selectedBinKey = null;
    if (next && fly) focusEntry(next); // leaves Floor view, so emphasis is computed after
    applyEmphasis();
    renderCard();
    if (next) revealInList(next.li);
    if (changed && emit && typeof opts.onSelect === 'function') opts.onSelect(next ? publicMove(next.move) : null);
    return !!next;
  }

  function selectBin(bin) {
    const changed = state.selectedId !== null;
    state.selectedId = null;
    state.selectedKey = null;
    state.selectedBinKey = bin.key;
    applyEmphasis();
    renderCard();
    if (changed && typeof opts.onSelect === 'function') opts.onSelect(null);
  }

  const dirFrom = (az, elv) => new THREE.Vector3(Math.sin(az) * Math.cos(elv), Math.sin(elv), Math.cos(az) * Math.cos(elv));
  const freeAspect = () => Math.max(200, size.w - state.padL - state.padR) / Math.max(1, size.h);

  function fitDistance(radius) {
    const vf = camera.fov * DEG;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * freeAspect());
    return radius / Math.sin(Math.min(vf, hf) / 2);
  }

  function viewPose(name) {
    const b = model.bounds;
    const c = model.center;
    if (name === 'plan') {
      const tanV = Math.tan((camera.fov * DEG) / 2);
      const h = Math.max(model.depth / 2 / tanV, model.width / 2 / (tanV * freeAspect())) * 1.2 + 4;
      return { pos: new THREE.Vector3(c.x, h, c.z + 0.01), target: new THREE.Vector3(c.x, 0, c.z), polar: POLAR_MAX };
    }
    if (name === 'floor') {
      return { pos: new THREE.Vector3(b.x0 + 2.6, 1.7, 6.1), target: new THREE.Vector3(b.x0 + 17, 3.1, 0.6), polar: POLAR_FLOOR };
    }
    const target = new THREE.Vector3(c.x + 0.5, 0, model.zBack * 0.32);
    const radius = 0.4 * Math.hypot(model.width, model.depth);
    return { pos: target.clone().addScaledVector(dirFrom(30 * DEG, 42 * DEG), fitDistance(radius) * 0.92), target, polar: POLAR_MAX };
  }

  function flyTo(pos, target, polar = POLAR_MAX, animate = true, ms = 950) {
    if (!animate || reduceMotion) {
      state.tween = null;
      camera.position.copy(pos);
      controls.target.copy(target);
      state.polar = polar;
      controls.maxPolarAngle = polar;
      controls.update();
      invalidate();
      return;
    }
    state.tween = { p0: camera.position.clone(), t0: controls.target.clone(), p1: pos.clone(), t1: target.clone(), start: performance.now(), ms, polar };
    invalidate();
  }

  function setView(name, { animate = true } = {}) {
    if (state.walking) setWalkMode(false);
    const v = VIEW_LABELS[name] ? name : 'overview';
    state.view = v;
    state.userMoved = false;
    for (const btn of ui.viewButtons) btn.setAttribute('aria-pressed', String(btn.dataset.view === v));
    const pose = viewPose(v);
    flyTo(pose.pos, pose.target, pose.polar, animate);
    applyEmphasis();
  }

  function focusEntry(e) {
    const box = new THREE.Box3().setFromPoints([e.from.pos, e.to.pos, e.apex, e.from.floor, e.to.floor]).expandByScalar(2);
    const center = box.getCenter(new THREE.Vector3());
    center.y = Math.min(center.y, 2.5);
    const radius = Math.max(9, box.getSize(new THREE.Vector3()).length() / 2);
    state.view = null;
    for (const btn of ui.viewButtons) btn.setAttribute('aria-pressed', 'false');
    flyTo(center.clone().addScaledVector(dirFrom(22 * DEG, 54 * DEG), fitDistance(radius) * 0.95), center, POLAR_MAX);
  }

  function updatePads() {
    const rr = ui.root.getBoundingClientRect();
    if (!rr.width) return;
    const wide = rr.width > 760;
    const lr = ui.list.getBoundingClientRect();
    const cr = ui.card.hidden ? null : ui.card.getBoundingClientRect();
    state.padL = wide && lr.width ? lr.right - rr.left + 8 : 0;
    state.padR = wide && cr && cr.width ? rr.right - cr.left + 8 : 0;
    state.offsetTo = (state.padL - state.padR) / 2;
    invalidate();
  }

  function resize() {
    const w = Math.max(1, ui.root.clientWidth);
    const h = Math.max(1, ui.root.clientHeight);
    if (w === size.w && h === size.h) return;
    size.w = w;
    size.h = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    updatePads();
    state.offset = state.offsetTo;
    camera.setViewOffset(w, h, -state.offset, 0, w, h);
    labels.remeasure();
    if (state.view && !state.userMoved && !state.tween) {
      const p = viewPose(state.view);
      camera.position.copy(p.pos);
      controls.target.copy(p.target);
      controls.update();
    }
    invalidate();
  }

  function hideHint() {
    if (!ui.hint.hasAttribute('data-off')) ui.hint.setAttribute('data-off', '');
  }

  /* ── frame loop ── */

  function frame(now) {
    if (!state.running) return;
    state.raf = win.requestAnimationFrame(frame);
    const dt = Math.min(0.1, Math.max(0, (now - state.last) / 1000));
    state.last = now;
    let dirty = state.dirty;

    if (state.tween) {
      const tw = state.tween;
      const k = clamp((now - tw.start) / tw.ms, 0, 1);
      const s = easeInOutCubic(k);
      camera.position.lerpVectors(tw.p0, tw.p1, s);
      controls.target.lerpVectors(tw.t0, tw.t1, s);
      camera.lookAt(controls.target);
      if (k >= 1) {
        state.tween = null;
        state.polar = tw.polar;
        controls.maxPolarAngle = tw.polar;
        controls.update();
      }
      dirty = true;
    } else if (state.walking) {
      if (updateWalk(dt)) dirty = true;
    } else {
      if (state.polar > POLAR_MAX) {
        const dist = Math.max(0.01, camera.position.distanceTo(controls.target));
        controls.maxPolarAngle = Math.min(state.polar, Math.acos(clamp((0.35 - controls.target.y) / dist, -1, 1)));
      }
      if (controls.update()) dirty = true;
      const t = controls.target;
      const b = model.bounds;
      const tx = clamp(t.x, b.x0, b.x1);
      const ty = clamp(t.y, 0, 8);
      const tz = clamp(t.z, b.z0, b.z1);
      if (tx !== t.x || ty !== t.y || tz !== t.z) {
        camera.position.x += tx - t.x;
        camera.position.y += ty - t.y;
        camera.position.z += tz - t.z;
        t.set(tx, ty, tz);
        dirty = true;
      }
    }

    if (Math.abs(state.offset - state.offsetTo) > 0.5) {
      state.offset += (state.offsetTo - state.offset) * (reduceMotion ? 1 : 1 - Math.exp(-dt * 8));
      if (Math.abs(state.offset - state.offsetTo) <= 0.5) state.offset = state.offsetTo;
      camera.setViewOffset(size.w, size.h, -state.offset, 0, size.w, size.h);
      dirty = true;
    }
    if (state.ghost !== state.ghostTo) {
      state.ghost += (state.ghostTo - state.ghost) * (reduceMotion ? 1 : 1 - Math.exp(-dt * 9));
      if (Math.abs(state.ghost - state.ghostTo) < 0.004) state.ghost = state.ghostTo;
      applyGhost();
      dirty = true;
    }
    if (!reduceMotion && state.entries.some((e) => e.visible)) {
      animateMoves(now / 1000);
      dirty = true;
    }
    if (state.hoverPending && state.pointer && !state.tween) {
      state.hoverPending = false;
      const hit = state.buttons === 0 ? pick(state.pointer.x, state.pointer.y) : null;
      setHover(hit && hit.kind === 'move' ? hit.entry.move.id : null);
      ui.root.toggleAttribute('data-hover', !!hit);
      showTip(hit, state.pointer.x, state.pointer.y);
    }

    if (!dirty) return;
    const p = camera.position;
    const b = model.bounds;
    world.ceiling.visible = p.y < D.wallH - 0.3 && p.x > b.x0 && p.x < b.x1 && p.z > b.z0 && p.z < b.z1;
    const near = clamp(p.y * 0.035, 0.08, 1.2);
    if (Math.abs(near - camera.near) / camera.near > 0.15) {
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
    labels.update(camera, size.w, size.h);
    state.dirty = false;
  }

  function updateRunning() {
    const should = !state.disposed && state.inView && state.docVisible;
    if (should && !state.running) {
      state.running = true;
      state.last = performance.now();
      state.raf = win.requestAnimationFrame(frame);
    } else if (!should && state.running) {
      state.running = false;
      win.cancelAnimationFrame(state.raf);
    }
  }

  /* ── events ── */

  let down = null;
  const onPointerMove = (ev) => {
    state.pointer = { x: ev.clientX, y: ev.clientY };
    state.buttons = ev.buttons;
    if (state.walking && state.walkLookPointer && ev.buttons) {
      const dx = ev.clientX - state.walkLookPointer.x;
      const dy = ev.clientY - state.walkLookPointer.y;
      state.walkLookPointer.x = ev.clientX;
      state.walkLookPointer.y = ev.clientY;
      state.walkYaw -= dx * 0.003;
      state.walkPitch = clamp(state.walkPitch - dy * 0.003, -0.75, 0.75);
      updateWalkTarget();
      invalidate();
      return;
    }
    state.hoverPending = true;
  };
  const onPointerLeave = () => {
    state.pointer = null;
    state.hoverPending = false;
    showTip(null);
    setHover(null);
    ui.root.removeAttribute('data-hover');
  };
  const onPointerDown = (ev) => {
    down = { x: ev.clientX, y: ev.clientY };
    if (state.walking && ev.button === 0) {
      state.walkLookPointer = { x: ev.clientX, y: ev.clientY };
      canvas.setPointerCapture(ev.pointerId);
    }
    showTip(null);
    hideHint();
  };
  const onPointerUp = (ev) => {
    if (!down) return;
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y);
    down = null;
    state.walkLookPointer = null;
    if (moved > 6 || ev.button !== 0) return;
    if (state.walking) {
      const point = floorPoint(ev.clientX, ev.clientY);
      if (point) startWalkAt(point);
      return;
    }
    const hit = pick(ev.clientX, ev.clientY);
    if (hit && hit.kind === 'move') select(hit.entry.move.id);
    else if (hit && hit.kind === 'bin') selectBin(hit.bin);
    else select(null, { fly: false });
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape' && state.walking) {
      setWalkMode(false);
      ev.stopPropagation();
      return;
    }
    if (ev.key === 'Escape' && state.selectedId) {
      select(null, { fly: false });
      ev.stopPropagation();
    }
  };
  const onWalkKeyDown = (ev) => {
    if (!state.walking) return;
    const key = ev.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowleft', 'arrowdown', 'arrowright'].includes(key)) {
      state.walkKeys.add(key);
      ev.preventDefault();
      invalidate();
    }
  };
  const onWalkKeyUp = (ev) => {
    state.walkKeys.delete(ev.key.toLowerCase());
  };
  const onVisibility = () => {
    state.docVisible = !doc.hidden;
    updateRunning();
  };
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  ui.root.addEventListener('keydown', onKey);
  win.addEventListener('keydown', onWalkKeyDown);
  win.addEventListener('keyup', onWalkKeyUp);
  doc.addEventListener('visibilitychange', onVisibility);
  for (const btn of ui.viewButtons) btn.addEventListener('click', () => setView(btn.dataset.view));
  ui.walk.addEventListener('click', () => setWalkMode(!state.walking));

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(ui.root);
  else win.addEventListener('resize', resize);
  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((list) => {
          state.inView = list.some((x) => x.isIntersecting);
          updateRunning();
        })
      : null;
  if (io) io.observe(ui.root);
  const hintTimer = win.setTimeout(hideHint, 9000);
  if (doc.fonts && doc.fonts.ready) {
    doc.fonts.ready.then(() => {
      if (state.disposed) return;
      shared.font = fontFamily();
      for (const t of world.texts) {
        t.tex.image = t.draw();
        t.tex.needsUpdate = true;
      }
      labels.remeasure();
      invalidate();
    });
  }

  function dispose() {
    if (state.disposed) return;
    state.disposed = true;
    updateRunning();
    win.clearTimeout(hintTimer);
    if (ro) ro.disconnect();
    else win.removeEventListener('resize', resize);
    if (io) io.disconnect();
    doc.removeEventListener('visibilitychange', onVisibility);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerleave', onPointerLeave);
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointerup', onPointerUp);
    win.removeEventListener('keydown', onWalkKeyDown);
    win.removeEventListener('keyup', onWalkKeyUp);
    controls.dispose();
    labels.clear();
    disposeTree(scene);
    envRT.dispose();
    renderer.dispose();
    if (typeof renderer.forceContextLoss === 'function') renderer.forceContextLoss();
    ui.root.remove();
  }

  /* ── boot ── */

  resize();
  state.moves = normalizeMoves(opts.moves);
  rebuild();
  setView(opts.initialView || 'overview', { animate: false });
  if (!reduceMotion && opts.intro !== false) {
    const endPos = camera.position.clone();
    const target = controls.target.clone();
    const startPos = target.clone().add(endPos.clone().sub(target).applyAxisAngle(UP, -0.38).multiplyScalar(1.22));
    camera.position.copy(startPos);
    camera.lookAt(target);
    state.tween = { p0: startPos, t0: target.clone(), p1: endPos, t1: target, start: performance.now(), ms: 1700, polar: state.polar };
  }
  updateRunning();

  const api = {
    /** Replace the moves (rows from the engine). */
    setMoves(rows) {
      state.moves = normalizeMoves(rows);
      rebuild();
      return api;
    },
    /** Pin bins to real slots with rows from the bin table. */
    setBins(rows) {
      state.binRows = Array.isArray(rows) ? rows : [];
      rebuild();
      return api;
    },
    /** Select a move by SKU, move id or move object; pass null to clear. Returns true when found. */
    select: (x, o) => select(x, o),
    clearSelection: () => select(null, { fly: false }),
    /** { query, status: 'all'|'pending'|'accepted'|'overridden'|'rejected', priority: 'all'|'critical'|… } */
    setFilter(f = {}) {
      state.filter = { ...state.filter, ...f };
      applyFilter();
      return api;
    },
    setView: (name, o) => setView(name, o),
    /** Keep the last render visible at reduced opacity while the engine refreshes. */
    setLoading(on) {
      state.loading = !!on;
      renderNotice();
      applyEmphasis();
    },
    /** Show an engine error above the twin (pass null to clear). */
    setError(err) {
      state.error = err ? (typeof err === 'string' ? err : err.message || String(err)) : null;
      renderNotice();
    },
    getMoves: () => state.moves.map(publicMove),
    getSelected: () => {
      const e = selectedEntry();
      return e ? publicMove(e.move) : null;
    },
    getSummary() {
      const all = state.moves;
      const vis = state.entries.filter((e) => e.visible).map((e) => e.move);
      const byPriority = {};
      for (const k of Object.keys(PRIORITIES)) byPriority[k] = all.filter((m) => m.priority === k).length;
      const count = (k) => all.filter((m) => m.status === k).length;
      return {
        total: all.length,
        visible: vis.length,
        pending: count('pending'),
        accepted: count('accepted'),
        overridden: count('overridden'),
        rejected: count('rejected'),
        timeSavedSecPerDay: all.reduce((s, m) => s + (m.timeSavedSec || 0), 0),
        visibleTimeSavedSecPerDay: vis.reduce((s, m) => s + (m.timeSavedSec || 0), 0),
        byPriority,
        autoPlacedBins: state.inv ? state.inv.binList.filter((b) => b.auto).map((b) => b.id) : [],
      };
    },
    resize() {
      size.w = 0;
      resize();
    },
    dispose,
    get element() {
      return ui.root;
    },
    get three() {
      return { THREE, scene, camera, renderer, controls };
    },
  };
  return api;
}

export default createDigitalTwin;
