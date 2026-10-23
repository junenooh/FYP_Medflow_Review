import { pageQuery } from "@app/router.js";
import { renderFeedback, renderKpiRow, renderPageHead } from "@shared/components/page-frame.js";
import { fetchCurrentLayout } from "@features/uc3-layout/current-layout-data.js";
import { fetchRecommendedLayout } from "@features/uc3-layout/recommended-layout-data.js";
import { resolveFeedback } from "@shared/utils/feedback-state.js";
import { allocateZoneAisles, MAX_TWIN_AISLES, orderTwinZones } from "./zone-order.js";

let renderGeneration = 0;
let activeTwin = null;
let routeCleanupBound = false;

function disposeTwin() {
  activeTwin?.dispose();
  activeTwin = null;
}

function disposeOutsideDigitalTwin() {
  const path = window.location.hash.split("?")[0].replace(/^#/, "") || "/";
  if (path === "/uc4" || path === "/digital-twin") return;
  renderGeneration += 1;
  disposeTwin();
}

function getTwinLayout(layout) {
  const bins = layout.bins.map((bin) => {
    const rack = bin.rackNumber;
    const position = Number.parseInt(String(bin.binPosition || "").replace(/\D/g, ""), 10);
    const level = Number.parseInt(String(bin.shelfLevel || "").replace(/\D/g, ""), 10);
    return {
      id: bin.binId,
      zone: bin.zoneId,
      aisle: bin.aisleNumber,
      side: bin.faceNumber === 1 ? "left" : bin.faceNumber === 2 ? "right" : null,
      rack,
      position: Number.isFinite(position) ? position : null,
      level: Number.isFinite(level) ? Math.max(0, level - 1) : null,
      mappingStatus: bin.mappingStatus,
      rackNumber: bin.rackNumber,
      shelfLevel: bin.shelfLevel,
      faceNumber: bin.faceNumber,
      binPosition: bin.binPosition,
      occupancy: bin.occupancy,
      inventory: bin.inventory,
      totalQuantityOnHand: bin.totalQuantityOnHand,
    };
  });
  const zoneOrder = orderTwinZones(layout.zones || []);
  const zoneRank = new Map(zoneOrder.map((zone, index) => [zone, index]));
  const compareZones = (a, b) =>
    (zoneRank.get(a) ?? zoneOrder.length) - (zoneRank.get(b) ?? zoneOrder.length)
      || String(a || "").localeCompare(String(b || ""));
  const positionsPerRack = Math.max(1, ...bins.map((bin) => bin.position || 1));
  const aisleSourcesByZone = new Map();
  for (const bin of bins) {
    const zone = bin.zone || "";
    if (!aisleSourcesByZone.has(zone)) aisleSourcesByZone.set(zone, new Set());
    if (Number.isFinite(bin.aisle) && bin.aisle >= 1     && bin.aisle <= MAX_TWIN_AISLES) {
      aisleSourcesByZone.get(zone).add(bin.aisle);
    }
  }
  const orderedZones = [...aisleSourcesByZone.keys()].sort(compareZones);
  const { aisleMaps, aisleCodes, count: aisleCount } = allocateZoneAisles(orderedZones, aisleSourcesByZone);
  const aisles = Math.min(MAX_TWIN_AISLES, Math.max(1, aisleCount));
  const bays = Math.min(40, Math.max(2, ...bins.map((bin) =>
    ((bin.rack || 1) - 1) * positionsPerRack + (bin.position || 1),
  )));
  const levels = Math.min(8, Math.max(1, ...bins.map((bin) => (bin.level ?? 0) + 1)));
  const usedSlots = new Set();

  return {
    layout: {
      name: layout.warehouse.label,
      aisles,
      bays,
      levels,
      pickLevel: 0,
      stockFill: 0,
      aisleCodes,
      zoneOrder: orderedZones,
      groupBinsByZone: false,
    },
    bins: bins.map((bin) => {
      const localBay = ((bin.rack || 1) - 1) * positionsPerRack + (bin.position || 1);
      const aisle = aisleMaps.get(bin.zone || "")?.get(bin.aisle);
      const bay = localBay - 1;
      const slot = `${aisle}|${bin.side}|${bay}|${bin.level}`;
      const mapped = bin.mappingStatus === "mapped"
        && Number.isFinite(aisle)
        && aisle >= 1
        && aisle <= MAX_TWIN_AISLES
        && Number.isFinite(bay)
        && bay < 40
        && bin.side
        && bin.level !== null
        && bin.level < 8
        && !usedSlots.has(slot);
      if (mapped) usedSlots.add(slot);
      return {
        binid: bin.id,
        zone: bin.zone,
        aisle: mapped ? aisle : null,
        side: mapped ? bin.side : null,
        bay: mapped ? bay + 1 : null,
        level: mapped ? bin.level : null,
        rackNumber: bin.rackNumber,
        shelfLevel: bin.shelfLevel,
        faceNumber: bin.faceNumber,
        binPosition: bin.binPosition,
        occupancy: bin.occupancy,
        inventory: bin.inventory,
        totalQuantityOnHand: bin.totalQuantityOnHand,
      };
    }),
  };
}

function getTwinMoves(moves) {
  return moves.map((move) => ({
    id: move.id,
    sku: move.productid,
    product: move.productname,
    velocity: move.velocityclass,
    currentbin: move.currentbin,
    recommendedbin: move.recommendedbin,
    priority: move.priority,
    reason: move.reason,
    status: "pending",
  }));
}

function formatRunDate(value) {
  if (!value) return "No completed UC3 run";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString();
}

export function renderDigitalTwin(root) {
  disposeTwin();
  const q = pageQuery();
  const generation = ++renderGeneration;
  if (!routeCleanupBound) {
    window.addEventListener("hashchange", disposeOutsideDigitalTwin);
    routeCleanupBound = true;
  }

  root.innerHTML = `
    <section>
      ${renderPageHead({
        kicker: "UC4",
        title: "Digital Twin",
        subtitle: "Explore live occupied and empty bins alongside saved UC3 product moves.",
        actions: [
          { label: "Open Layout", kind: "btn-s" },
          { label: "Commit plan", disabled: true },
        ],
      })}
      <div data-kpis>${renderKpiRow([
        { label: "Recommended moves", value: "—" },
        { label: "Warehouse bins", value: "—" },
        { label: "Aisles", value: "—" },
        { label: "UC3 source", value: "—" },
      ])}</div>
      <div data-body>${renderFeedback("loading", { table: "layoutrecommendation" })}</div>
    </section>
  `;
  root.querySelector(".btn-s")?.addEventListener("click", () => {
    window.location.hash = "#/uc3";
  });
  fill(root, q, generation);
}

async function fill(root, q, generation) {
  const body = root.querySelector("[data-body]");
  const current = await fetchCurrentLayout();
  if (generation !== renderGeneration) return;

  const feedback = resolveFeedback({
    override: q.feedback,
    loading: false,
    loadState: current.ok ? null : current.kind,
    rowCount: current.ok && current.state === "ready" ? current.layout.bins.length : 0,
  });
  if (feedback) {
    body.innerHTML = renderFeedback(feedback, {
      detail: current.message || (current.state === "no-central-warehouse"
        ? "No CENTRAL warehouse is configured."
        : current.state === "no-bins"
          ? `No bin records were found for ${current.layout?.warehouse?.label || "the CENTRAL warehouse"}.`
          : ""),
      table: "warehouse layout",
    });
    return;
  }

  const recommendation = await fetchRecommendedLayout(current.layout);
  if (generation !== renderGeneration) return;

  const mapped = getTwinLayout(current.layout);
  const moves = recommendation.ok ? recommendation.moves : [];
  const runDate = recommendation.ok ? recommendation.run?.generatedate : null;
  root.querySelector("[data-kpis]").innerHTML = renderKpiRow([
    { label: "Recommended moves", value: String(moves.length) },
    { label: "Warehouse bins", value: current.layout.bins.length.toLocaleString() },
    { label: "Aisles", value: String(mapped.layout.aisles) },
    { label: "UC3 source", value: formatRunDate(runDate) },
  ]);

  try {
    const { createDigitalTwin } = await import("./twin.js");
    if (generation !== renderGeneration) return;
    body.innerHTML = `
      <div data-twin-host style="height:min(78vh, 860px);min-height:520px"></div>
      <p class="page-sub" data-twin-note role="status"></p>
    `;
    activeTwin = createDigitalTwin(body.querySelector("[data-twin-host]"), {
      title: current.layout.warehouse.label,
      layout: mapped.layout,
      bins: mapped.bins,
      moves: getTwinMoves(moves),
    });
    if (!recommendation.ok) {
      activeTwin.setError(`UC3 recommendations unavailable: ${recommendation.message}`);
    }
    const note = body.querySelector("[data-twin-note]");
    note.textContent = recommendation.state === "no-run"
      ? "Showing the live warehouse layout. Run UC3 to display recommended moves."
      : recommendation.state === "zero-changes"
        ? "The latest UC3 run has no product relocations."
        : !recommendation.ok
          ? "Showing the live warehouse layout without recommendations because the UC3 output could not be loaded."
          : `${moves.length} saved UC3 move${moves.length === 1 ? "" : "s"} available. Select or hover a move to show its route.`;
    activeTwin.resize();
  } catch (error) {
    disposeTwin();
    body.innerHTML = renderFeedback("error", {
      detail: `Could not initialize the 3D warehouse view: ${String(error?.message || error)}`,
      table: "digital twin",
    });
  }
}
