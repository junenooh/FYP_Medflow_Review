import { TabulatorFull as Tabulator } from "tabulator-tables";
import "tabulator-tables/dist/css/tabulator.min.css";
import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";
import { pageQuery, setQuery } from "@app/router.js";
import { ZONE_LETTERS } from "./reference-floor.js";
import { renderWarehouseSlottingMap } from "./floorplan/grid.js";
import { DEFAULT_MAP_FILTERS, counterpartForMoveEvent, counterpartLocationForMoveEvent, formatStorageLocation, moveImpactPresentation, productDisplayForMove, resolveBinJump } from "./movement-navigation.js";
import { fetchCurrentLayout } from "./current-layout-data.js";
import { fetchRecommendedLayout, fetchUc3History } from "./recommended-layout-data.js";
import { renderComparisonChart } from "./charts/comparison.js";
import { ACCESS_MODEL, buildScenarios, enrichMoves, savedRunTravelMetrics, scenarioMetrics } from "./analytics.js";
import { bindTabs, renderFeedback, renderKpiRow, renderPageHead, renderTabs } from "@shared/components/page-frame.js";
import { analyticsTabAvailability, recommendationIsReady, resolvedUc3Tab } from "./analytics-tab-availability.js";
import { controllerAvailable, getGeneration, startGeneration } from "./workflow.js";

const TABS = [
  { id: "map", label: "Warehouse Layout" },
  { id: "assignments", label: "Product Moves" },
  { id: "comparison", label: "Picker Travel Impact" },
];
const ANALYTICS_TAB_STATUS_ID = "uc3-analytics-tab-status";
const GENERATION_STEPS = Object.freeze([
  { id: "loading", label: "Load the current layout and saved UC1 / UC2 inputs" },
  { id: "optimizing", label: "Calculate the recommended layout" },
  { id: "complete", label: "Save the recommended layout" },
]);

let layoutGen = 0;
let activeTable = null;
let disposeCurrentMap = () => {};
// UC3's three tabs are different presentations of one current-layout and
// recommendation snapshot. Keep that read-only snapshot in memory so a tab
// change never rebuilds the page around another loading state.
const layoutSnapshots = new Map();
const pendingLayoutSnapshots = new Map();
let layoutSnapshotVersion = 0;
const viewState = { scenario: "current", selectedId: "", selectedBinId: "", use25d: true, runId: "", workflowMessage: "" };
const currentMapState = {
  selectedBinId: "",
  selectedZoneId: "",
  aislePage: 0,
  focusPopover: false,
  filters: { ...DEFAULT_MAP_FILTERS },
};

export function renderLayout(root, prepared = null) {
  disposeCurrentMap();
  disposeCurrentMap = () => {};
  const q = pageQuery();
  const requestedTab = TABS.some((item) => item.id === q.tab) ? q.tab : "map";
  const data = prepared || getCachedLayoutSnapshot(viewState.runId);
  const availability = data?.availability || analyticsTabAvailability(null, null, { checking: true });
  const savedTravelMetrics = data ? savedRunTravelMetrics(data.result?.run) : null;
  const travelModel = savedTravelMetrics?.model || ACCESS_MODEL;
  const tab = resolvedUc3Tab(requestedTab, availability);
  const gen = ++layoutGen;
  activeTable?.destroy();
  activeTable = null;

  root.innerHTML = `
    <section class="uc3-dashboard">
      ${renderPageHead({
        kicker: "UC3 · Central warehouse",
        title: tab === "map" ? "Warehouse Layout" : "Slotting Intelligence",
        subtitle: tab === "map" ? "Compare the central warehouse's current layout with a saved recommended layout." : "Review product moves and the expected picker time saved.",
      })}
      ${renderTabs(tabsForAvailability(availability), tab, { unavailableDescriptionId: ANALYTICS_TAB_STATUS_ID })}
      ${renderAnalyticsAvailabilityStatus(availability)}
      ${tab === "map" ? "" : `<div class="model-strip" aria-label="Access-time model">
        <span><b>${savedTravelMetrics ? "Saved Run Assumptions" : "Travel Assumptions"}</b></span>
        <span>Zone <b>${travelModel.zoneMetres} m</b></span>
        <span>Aisle <b>${travelModel.aisleMetres} m</b></span>
        <span>Trip factor <b>${travelModel.tripFactor}×</b></span>
        <span>Walking speed <b>${travelModel.walkingSpeed} m/s</b></span>
        ${savedTravelMetrics ? "<span>Shelf access <b>Included</b></span>" : `<label class="mode-switch"><input type="checkbox" data-mode ${viewState.use25d ? "checked" : ""}> <span>Include shelf access time</span></label>`}
        <span class="ladder-rule">Upper-shelf access <b>+${travelModel.ladderPenalty} s</b></span>
      </div>
      <div data-kpis>${renderKpiRow([
        { label: "Average access time", value: "—", suffix: "s / pick" },
        { label: "Improvement", value: "—", suffix: "%" },
        { label: "Weekly Time Saved", value: "—", suffix: "hours" },
        { label: "Products to relocate", value: "—" },
      ])}</div>`}
      <div data-body>${tab === "map" ? renderCurrentLayoutState("loading") : renderFeedback("loading", { table: "layoutrecommendation" })}</div>
    </section>
  `;
  bindTabs(root);
  if (!data) {
    const requestedRunId = viewState.runId;
    loadSelectedRecommendation({ runId: requestedRunId }).then((loaded) => {
      if (gen !== layoutGen) return;
      if (loaded.result.run?.runid && viewState.runId === requestedRunId) viewState.runId = loaded.result.run.runid;
      const nextAvailability = analyticsTabAvailability(loaded.current, loaded.result);
      if (requestedTab !== "map" && !nextAvailability.ready) setQuery({ tab: "map" });
      renderLayout(root, { ...loaded, availability: nextAvailability });
    }).catch(() => {
      if (gen !== layoutGen) return;
      const result = { ok: false, state: "error", moves: [], run: null, message: "The recommended layout could not be verified." };
      if (requestedTab !== "map") setQuery({ tab: "map" });
      renderLayout(root, { current: null, result, availability: analyticsTabAvailability(null, result) });
    });
    return;
  }
  if (data.result.run?.runid) viewState.runId = data.result.run.runid;
  if (tab === "map") {
    renderCurrentMap(root.querySelector("[data-body]"), q, gen, data);
    return;
  }
  root.querySelector("[data-mode]")?.addEventListener("change", (event) => {
    viewState.use25d = event.target.checked;
    fill(root, { ...q, tab }, ++layoutGen, prepared);
  });
  fill(root, { ...q, tab }, gen, data);
}

function tabsForAvailability(availability) {
  return TABS.map((tab) => ({ ...tab, unavailable: tab.id !== "map" && !availability.ready }));
}

function renderAnalyticsAvailabilityStatus(availability) {
  // Once a recommendation is ready, the enabled tabs communicate their own
  // availability. Keeping this line only for a blocked/checking state avoids
  // repeating information above the map.
  return availability.ready
    ? `<p id="${ANALYTICS_TAB_STATUS_ID}" class="uc3-analytics-tab-status" role="status" hidden></p>`
    : `<p id="${ANALYTICS_TAB_STATUS_ID}" class="uc3-analytics-tab-status" role="status">${escapeHtml(availability.message)}</p>`;
}

function layoutSnapshotKey(runId = "") {
  return runId || "latest";
}

function getCachedLayoutSnapshot(runId = "") {
  return layoutSnapshots.get(layoutSnapshotKey(runId)) || null;
}

function clearLayoutSnapshots() {
  layoutSnapshotVersion += 1;
  layoutSnapshots.clear();
  pendingLayoutSnapshots.clear();
}

function rememberLayoutSnapshot(runId, data) {
  layoutSnapshots.set(layoutSnapshotKey(runId), data);
  if (data.result.run?.runid) layoutSnapshots.set(layoutSnapshotKey(data.result.run.runid), data);
}

/**
 * Reads each persisted UC3 source only once per selected recommendation run.
 * Failed reads are deliberately not retained, so a later visit can retry.
 */
async function loadSelectedRecommendation({ runId = viewState.runId, force = false } = {}) {
  const key = layoutSnapshotKey(runId);
  if (!force) {
    const cached = layoutSnapshots.get(key);
    if (cached) return cached;
    const pending = pendingLayoutSnapshots.get(key);
    if (pending) return pending;
  }
  const version = layoutSnapshotVersion;
  const request = (async () => {
  const current = await fetchCurrentLayout();
  const [result, history] = await Promise.all([
    current.ok && current.state === "ready"
      ? fetchRecommendedLayout(current.layout, { runId: runId || undefined })
      : Promise.resolve({ ok: false, state: "error", kind: current.kind, message: current.message, moves: [], run: null }),
    fetchUc3History(),
  ]);
    const data = { current, result, history, availability: analyticsTabAvailability(current, result) };
    if (version === layoutSnapshotVersion && current.ok && result.ok) rememberLayoutSnapshot(runId, data);
    return data;
  })();
  pendingLayoutSnapshots.set(key, request);
  try {
    return await request;
  } finally {
    if (pendingLayoutSnapshots.get(key) === request) pendingLayoutSnapshots.delete(key);
  }
}

async function preloadLatestLayoutSnapshot() {
  clearLayoutSnapshots();
  return loadSelectedRecommendation({ runId: "", force: true });
}

async function fill(root, q, gen, prepared = null) {
  const body = root.querySelector("[data-body]");
  const { current, result } = prepared || await loadSelectedRecommendation();
  if (gen !== layoutGen) return;

  if (result.run?.runid) viewState.runId = result.run.runid;

  if (!recommendationIsReady(current, result)) return;
  const sourceMoves = result.moves;
  const bins = analyticsBins(current.layout.bins);
  const moves = enrichMoves(sourceMoves, bins, viewState.use25d).filter((move) => matchesFilters(move, bins, q));
  const scenarios = buildScenarios(bins, sourceMoves);
  const metrics = savedRunTravelMetrics(result.run) || scenarioMetrics(bins, sourceMoves, scenarios, viewState.use25d);
  if (viewState.selectedId && !sourceMoves.some((move) => move.productid === viewState.selectedId)) viewState.selectedId = "";
  if (viewState.selectedBinId && !bins.some((bin) => bin.binid === viewState.selectedBinId)) viewState.selectedBinId = "";
  renderKpis(root, metrics, sourceMoves.length);

  if (q.feedback) {
    body.innerHTML = renderFeedback(q.feedback, { table: "layoutrecommendation", detail: result.message });
    return;
  }

  const sourceNote = `<div class="live-banner"><span>RECOMMENDED LAYOUT</span><p>${escapeHtml(recommendationMoveSummary(result))} · Generated ${escapeHtml(formatRunDate(result.run?.generatedate))}</p></div>${renderTechnicalDetails(`Recommendation run ID: ${result.run?.runid || "Unavailable"}`)}`;

  activeTable?.destroy();
  activeTable = null;
  if (q.tab === "assignments") renderAssignments(body, sourceNote, moves);
  else renderComparison(body, sourceNote, metrics, sourceMoves.length);
}

function analyticsBins(mapBins) {
  return mapBins.map((bin) => ({
    binid: bin.binId,
    zoneIdx: Math.max(0, Number(String(bin.zoneId || "").replace(/\D/g, "")) - 1 || 0),
    aisle: bin.aisleNumber || 1,
    shelfLevel: bin.shelfLevel,
    accessRequirement: bin.isPickFace ? "GROUND" : "LADDER",
    sku: bin.inventory.length === 1 ? {
      productid: bin.inventory[0].productId,
      velocityclass: bin.inventory[0].velocityClass,
    } : null,
  }));
}

function formatRunDate(value) {
  if (!value) return "timestamp unavailable";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

async function renderCurrentMap(body, q, gen, prepared = null) {
  disposeCurrentMap();
  disposeCurrentMap = () => {};
  body.innerHTML = renderCurrentLayoutState("loading");
  const result = prepared?.current || await fetchCurrentLayout();
  if (gen !== layoutGen) return;
  if (q.feedback) {
    body.innerHTML = renderCurrentLayoutState(q.feedback, { detail: result.message });
    return;
  }
  if (!result.ok) {
    body.innerHTML = renderCurrentLayoutState(result.kind, { detail: result.message });
    return;
  }
  if (result.state === "no-central-warehouse") {
    body.innerHTML = renderCurrentLayoutState("no-central-warehouse");
    return;
  }
  if (result.state === "no-bins") {
    body.innerHTML = renderCurrentLayoutState("no-bins", { warehouse: result.layout.warehouse.label });
    return;
  }

  const currentLayout = result.layout;
  const recommended = prepared?.result || await fetchRecommendedLayout(currentLayout, { runId: viewState.runId || undefined });
  if (gen !== layoutGen) return;
  if (recommended.run?.runid) viewState.runId = recommended.run.runid;
  renderCurrentMapView(body, q, gen, currentLayout, recommended, prepared?.history);
}

/** Switches an already loaded, immutable Current snapshot without another read. */
function renderCurrentMapView(body, q, gen, currentLayout, recommended, history = { ok: false, rows: [] }) {
  disposeCurrentMap();
  disposeCurrentMap = () => {};
  const recommendedEnabled = recommended.ok && ["ready", "zero-changes"].includes(recommended.state);
  if (viewState.scenario === "recommended" && !recommendedEnabled) viewState.scenario = "current";
  const isRecommended = viewState.scenario === "recommended";
  const layout = isRecommended ? recommended.layout : currentLayout;
  if (viewState.selectedId) {
    const selectedProductBin = layout.bins.find((bin) => bin.inventory.some((lot) => lot.productId === viewState.selectedId));
    if (selectedProductBin) {
      currentMapState.selectedBinId = selectedProductBin.binId;
      currentMapState.selectedZoneId = selectedProductBin.zoneId;
      viewState.selectedId = "";
    }
  }
  if (!layout.bins.some((bin) => bin.binId === currentMapState.selectedBinId)) currentMapState.selectedBinId = "";
  if (!layout.bins.some((bin) => bin.zoneId === currentMapState.selectedZoneId)) {
    currentMapState.selectedZoneId = layout.bins[0]?.zoneId || "";
    currentMapState.aislePage = 0;
  }
  const qualityMessages = [
    layout.missingCoordinates.length && `${layout.missingCoordinates.length} bin${layout.missingCoordinates.length === 1 ? "" : "s"} lack usable stored X/Y coordinates.`,
    layout.missingZones.length && `${layout.missingZones.length} bin${layout.missingZones.length === 1 ? "" : "s"} reference a zone not returned by the central-zone query.`,
    layout.unmappedBins.length && `${layout.unmappedBins.length} bin${layout.unmappedBins.length === 1 ? "" : "s"} could not be safely mapped from their identifier.`,
    layout.velocityMismatches.length && `${layout.velocityMismatches.length} occupied bin${layout.velocityMismatches.length === 1 ? "" : "s"} do not match the documented velocity-zone baseline.`,
  ].filter(Boolean);
  const technicalSource = isRecommended
    ? `Recommendation run ID: ${recommended.run?.runid || "Unavailable"} · Generated: ${formatRunDate(recommended.run?.generatedate)}`
    : "Source: current warehouse inventory snapshot (read-only).";
  body.innerHTML = `
    <div class="live-banner"><span>${isRecommended ? "RECOMMENDED LAYOUT" : "CURRENT LAYOUT"}</span><p>${isRecommended ? `${escapeHtml(recommendationMoveSummary(recommended))} · Generated ${escapeHtml(formatRunDate(recommended.run?.generatedate))}` : `${escapeHtml(layout.warehouse.label)} · ${layout.bins.length} storage bins`}</p></div>
    ${renderGenerationControls(history, recommended)}
    ${renderTechnicalDetails(technicalSource, qualityMessages)}
    ${isRecommended && recommended.state === "zero-changes" ? `<div class="layout-quality-banner">No product relocations are recommended for this run. The recommended layout matches the current layout.</div>` : ""}
    ${!recommendedEnabled ? `<div class="layout-quality-banner"><b>Recommended layout unavailable.</b> ${escapeHtml(recommended.state === "no-run" ? "Run the recommendation engine to create it." : recommended.state === "invalid" ? `Run UC3 again: ${recommended.message}` : `Recommended-layout data could not be read: ${recommended.message || "retry the request."}`)}</div>` : ""}
    <div class="map-toolbar"><div class="map-view-controls"><div class="scenario-control" aria-label="Layout view"><button type="button" data-scenario="current" class="${!isRecommended ? "on" : ""}">Current Layout</button><button type="button" data-scenario="recommended" class="${isRecommended ? "on" : ""}" ${recommendedEnabled ? "" : "disabled"} title="${escapeHtml(recommendedEnabled ? "Show the selected recommended layout" : recommended.message || "Run UC3 first")}">Recommended Layout</button></div>${isRecommended && recommended.presets?.length > 1 ? `<label class="preset-control"><span>Payback target</span><select data-preset>${recommended.presets.map((preset) => `<option value="${escapeHtml(preset.runid)}" ${preset.runid === recommended.run?.runid ? "selected" : ""}>${preset.payback} days</option>`).join("")}</select></label>` : ""}</div><div class="map-legend"><span><i class="legend-origin"></i> Has stock</span><span><i class="legend-empty"></i> Empty bin</span>${isRecommended ? `<span><i class="legend-moved-out"></i> Moves out</span><span><i class="legend-moved-in"></i> Moves in</span><span><i class="legend-exchanged"></i> Both directions</span>` : ""}</div></div>
    ${renderCurrentMapControls(layout.bins)}
    <div class="panel prototype-map-panel" data-current-map-panel><div class="prototype-map-scroller"><div data-current-map></div></div><div class="bin-popover-layer" data-bin-popover-layer></div></div>
  `;

  const panel = body.querySelector("[data-current-map-panel]");
  const scroller = panel.querySelector(".prototype-map-scroller");
  const controller = new AbortController();
  disposeCurrentMap = () => controller.abort();

  const generateButton = body.querySelector("[data-generate-layout]");
  const workflowStatus = body.querySelector("[data-workflow-status]");
  controllerAvailable().then((available) => {
    if (controller.signal.aborted || !generateButton) return;
    generateButton.disabled = !available;
    if (workflowStatus) {
      workflowStatus.textContent = available
        ? "Uses the saved UC1 and UC2 data; it does not run either upstream engine."
        : "The local layout generation service is unavailable. Restart the dashboard with python start_all.py.";
    }
  });

  generateButton?.addEventListener("click", async (event) => {
    const trigger = event.currentTarget;
    trigger.disabled = true;
    const dialog = openGenerationDialog(body, trigger);
    try {
      const job = await startGeneration();
      dialog.update(job);
      pollGeneration(job.jobid, dialog);
    } catch (error) {
      dialog.fail(String(error?.message || error));
    }
  }, { signal: controller.signal });

  const closePopover = ({ restoreFocus = false } = {}) => {
    const closedBinId = currentMapState.selectedBinId;
    if (!closedBinId) return;
    currentMapState.selectedBinId = "";
    currentMapState.focusPopover = false;
    draw();
    if (restoreFocus) {
      requestAnimationFrame(() => [...panel.querySelectorAll("[data-bin-id]")]
        .find((button) => button.dataset.binId === closedBinId)?.focus());
    }
  };

  const draw = () => {
    const summary = renderWarehouseSlottingMap(body.querySelector("[data-current-map]"), {
      bins: layout.bins,
      layoutLabel: isRecommended ? "Recommended" : "Current",
      selectedBinId: currentMapState.selectedBinId,
      selectedZoneId: currentMapState.selectedZoneId,
      aislePage: currentMapState.aislePage,
      filters: currentMapState.filters,
      onSelect: ({ zoneId, bin, openedWithKeyboard = false }) => {
        currentMapState.selectedZoneId = zoneId;
        if (bin) {
          currentMapState.selectedBinId = bin.binId;
          currentMapState.focusPopover = openedWithKeyboard;
        }
        else {
          currentMapState.selectedBinId = "";
          currentMapState.focusPopover = false;
          currentMapState.aislePage = 0;
        }
        draw();
      },
      onPageChange: (page) => {
        currentMapState.aislePage = page;
        currentMapState.selectedBinId = "";
        currentMapState.focusPopover = false;
        draw();
      },
    });
    currentMapState.aislePage = summary.aislePage;
    body.querySelector("[data-map-count]").textContent = `${summary.filteredCount} matching / ${summary.totalCount} bins in selected zone`;
    renderCurrentBinPopover(panel, layout.bins, isRecommended ? "Recommended" : "Current");
    panel.querySelector("[data-close-bin-popover]")?.addEventListener("click", () => closePopover({ restoreFocus: true }), { signal: controller.signal });
    panel.querySelectorAll("[data-jump-bin]").forEach((button) => button.addEventListener("click", (event) => {
      const jump = resolveBinJump(layout.bins, button.dataset.jumpBin, currentMapState.filters);
      if (!jump) return;
      currentMapState.selectedBinId = jump.selectedBinId;
      currentMapState.selectedZoneId = jump.selectedZoneId;
      currentMapState.aislePage = jump.aislePage;
      currentMapState.filters = jump.filters;
      currentMapState.focusPopover = event.detail === 0;
      if (jump.resetFilters) syncCurrentMapControls(body);
      draw();
      requestAnimationFrame(() => {
        [...panel.querySelectorAll("[data-bin-id]")]
          .find((target) => target.dataset.binId === jump.selectedBinId)
          ?.scrollIntoView({ block: "nearest", inline: "center" });
      });
    }, { signal: controller.signal }));
    requestAnimationFrame(() => {
      positionCurrentBinPopover(panel);
      if (currentMapState.focusPopover) {
        panel.querySelector("[data-close-bin-popover]")?.focus();
        currentMapState.focusPopover = false;
      }
    });
  };
  body.querySelector("[data-preset]")?.addEventListener("change", (event) => {
    viewState.runId = event.target.value;
    const root = body.closest(".uc3-dashboard")?.parentElement;
    if (root) renderLayout(root);
  }, { signal: controller.signal });
  body.querySelector("[data-layout-history]")?.addEventListener("change", (event) => {
    viewState.runId = event.target.value;
    viewState.scenario = "recommended";
    viewState.workflowMessage = "Viewing a saved recommended layout.";
    const root = body.closest(".uc3-dashboard")?.parentElement;
    if (root) renderLayout(root);
  }, { signal: controller.signal });
  body.querySelectorAll("[data-scenario]").forEach((button) => button.addEventListener("click", () => {
    viewState.scenario = button.dataset.scenario;
    currentMapState.focusPopover = false;
    renderCurrentMapView(body, q, gen, currentLayout, recommended, history);
  }, { signal: controller.signal }));
  body.querySelector("[data-map-search]").addEventListener("input", (event) => {
    currentMapState.filters.search = event.target.value;
    currentMapState.aislePage = 0;
    currentMapState.selectedBinId = "";
    currentMapState.focusPopover = false;
    draw();
  });
  body.querySelectorAll("[data-map-filter]").forEach((control) => control.addEventListener("change", (event) => {
    currentMapState.filters[event.target.dataset.mapFilter] = event.target.value;
    currentMapState.aislePage = 0;
    currentMapState.selectedBinId = "";
    currentMapState.focusPopover = false;
    draw();
  }));
  scroller.addEventListener("scroll", () => positionCurrentBinPopover(panel), { signal: controller.signal });
  window.addEventListener("resize", () => positionCurrentBinPopover(panel), { signal: controller.signal });
  body.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (currentMapState.selectedBinId && !target?.closest("[data-bin-id], [data-bin-popover]")) closePopover();
  }, { signal: controller.signal });
  body.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && currentMapState.selectedBinId) {
      event.preventDefault();
      closePopover({ restoreFocus: true });
    }
  }, { signal: controller.signal });
  draw();
}

function renderGenerationControls(history, recommended) {
  const message = viewState.workflowMessage || "Checking the local layout generation service…";
  const selectedBatch = /batch=([0-9a-f-]+)/i.exec(recommended?.run?.parametersignature || "")?.[1] || recommended?.run?.runid;
  const historyOptions = (history?.rows || []).map((run) => {
    const selected = run.runid === recommended?.run?.runid || run.historyBatchId === selectedBatch;
    const payback = /payback_days=(\d+)/.exec(run.parametersignature || "")?.[1];
    const detail = payback ? ` · ${payback}-day target` : "";
    return `<option value="${escapeAttribute(run.runid)}" ${selected ? "selected" : ""}>${escapeHtml(`${formatRunDate(run.generatedate)} · Recommended layout${detail}`)}</option>`;
  }).join("");
  return `<div class="uc3-layout-workflow" aria-label="Recommended layout generation">
    <div class="uc3-layout-workflow__controls">
      <button type="button" data-generate-layout disabled>Generate Recommended Layout</button>
      ${historyOptions ? `<label class="uc3-layout-history"><span>Layout history</span><select data-layout-history aria-label="Layout history">${historyOptions}</select></label>` : ""}
    </div>
    <output data-workflow-status>${escapeHtml(message)}</output>
  </div>`;
}

async function pollGeneration(jobId, dialog) {
  try {
    const job = await getGeneration(jobId);
    dialog.update(job);
    if (job.status === "succeeded") {
      await dialog.succeed(job);
      return;
    }
    if (job.status === "failed") {
      dialog.fail(job.error || "UC3 generation failed.");
      return;
    }
    window.setTimeout(() => pollGeneration(jobId, dialog), 1000);
  } catch (error) {
    dialog.fail(String(error?.message || error));
  }
}

function openGenerationDialog(body, trigger) {
  const dialog = document.createElement("dialog");
  dialog.className = "uc3-generation-dialog";
  dialog.setAttribute("aria-labelledby", "uc3-generation-title");
  let outcome = "running";
  let phase = "loading";
  let finalMessage = "UC3 is reading the current layout and the latest saved UC1 and UC2 inputs.";
  dialog.innerHTML = `<section class="uc3-generation-dialog__content">
      <p class="uc3-generation-dialog__eyebrow">UC3 · RECOMMENDATION ENGINE</p>
      <h2 id="uc3-generation-title">Generating recommended layout</h2>
      <p class="uc3-generation-dialog__message" data-generation-status aria-live="polite"></p>
      <ol class="uc3-generation-dialog__steps" data-generation-steps></ol>
      <p class="uc3-generation-note">The dashboard will refresh only after this dialog is closed.</p>
      <div class="uc3-generation-dialog__actions" data-generation-actions></div>
    </section>`;
  const status = dialog.querySelector("[data-generation-status]");
  const steps = dialog.querySelector("[data-generation-steps]");
  const actions = dialog.querySelector("[data-generation-actions]");
  const stepIndex = (value) => Math.max(0, GENERATION_STEPS.findIndex((step) => step.id === value));
  const draw = () => {
    const activeIndex = stepIndex(phase);
    status.textContent = finalMessage;
    steps.innerHTML = GENERATION_STEPS.map((step, index) => {
      const state = outcome === "failed" ? (index < activeIndex ? "done" : index === activeIndex ? "failed" : "pending")
        : index < activeIndex ? "done" : index === activeIndex ? "active" : "pending";
      return `<li class="is-${state}"><span aria-hidden="true"></span>${escapeHtml(step.label)}</li>`;
    }).join("");
  };
  draw();
  (body.closest(".uc3-dashboard") || document.body).append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");

  dialog.addEventListener("cancel", (event) => {
    if (outcome === "running") event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (outcome === "succeeded") {
      // New UC3 saves a preset batch. Clear the selection so its normal reader
      // chooses the recommended default from that newly generated batch.
      viewState.runId = "";
      viewState.scenario = "recommended";
      viewState.workflowMessage = "Recommended layout generated from the saved UC1 and UC2 data.";
      const root = body.closest(".uc3-dashboard")?.parentElement;
      if (root) renderLayout(root);
      return;
    }
    trigger.disabled = false;
  }, { once: true });

  return {
    update(job) {
      phase = GENERATION_STEPS.some((step) => step.id === job.phase) ? job.phase : "loading";
      finalMessage = phase === "optimizing"
        ? "UC3 is evaluating valid product swaps and calculating the recommended layout."
        : "UC3 is reading the current layout and the latest saved UC1 and UC2 inputs.";
      draw();
    },
    async succeed(job) {
      outcome = "succeeded";
      phase = "complete";
      finalMessage = job.runid
        ? "The recommended layout was generated and saved. Preparing the analysis views…"
        : "The recommended layout was generated. Preparing the analysis views…";
      draw();
      // A successful generator response means the new UC3 data has been
      // saved. Preload the shared snapshot before offering navigation, so the
      // Product Moves and Picker Travel Impact tabs open immediately.
      viewState.runId = "";
      try {
        const snapshot = await preloadLatestLayoutSnapshot();
        finalMessage = recommendationIsReady(snapshot.current, snapshot.result)
          ? "The recommended layout is saved. Product Moves and Picker Travel Impact are ready."
          : "The recommended layout is saved. Its analysis data will be checked when you review it.";
      } catch {
        finalMessage = "The recommended layout is saved. Its analysis data will be checked when you review it.";
      }
      draw();
      actions.innerHTML = '<button type="button" data-close-generation>Review recommended layout</button>';
      actions.querySelector("[data-close-generation]")?.addEventListener("click", () => dialog.close());
      actions.querySelector("[data-close-generation]")?.focus();
    },
    fail(message) {
      outcome = "failed";
      finalMessage = message;
      draw();
      actions.innerHTML = '<button type="button" data-close-generation>Close</button>';
      actions.querySelector("[data-close-generation]")?.addEventListener("click", () => dialog.close());
      actions.querySelector("[data-close-generation]")?.focus();
    },
  };
}

function renderCurrentMapControls(bins) {
  const mapped = bins.filter((bin) => bin.mappingStatus === "mapped");
  const statuses = [...new Set(bins.flatMap((bin) => bin.inventory.map((lot) => lot.inventoryStatus)).filter(Boolean))].sort();
  const faces = [...new Set(mapped.map((bin) => bin.faceNumber))].sort((a, b) => a - b);
  const levels = [...new Set(mapped.map((bin) => bin.shelfLevel))].sort((a, b) => Number(b.slice(1)) - Number(a.slice(1)));
  const option = (value, label, selected) => `<option value="${escapeHtml(value)}" ${String(value) === String(selected) ? "selected" : ""}>${escapeHtml(label)}</option>`;
  return `
    <div class="current-map-controls" aria-label="Warehouse layout filters">
      <label class="map-search"><span>Search</span><input type="search" data-map-search value="${escapeHtml(currentMapState.filters.search)}" placeholder="Bin ID, SKU or product"></label>
      <label><span>Bin contents</span><select data-map-filter="occupancy">${option("all", "All bins", currentMapState.filters.occupancy)}${option("occupied", "With stock", currentMapState.filters.occupancy)}${option("empty", "Empty", currentMapState.filters.occupancy)}</select></label>
      <label><span>Stock status</span><select data-map-filter="inventoryStatus">${option("all", "All statuses", currentMapState.filters.inventoryStatus)}${statuses.map((status) => option(status, status, currentMapState.filters.inventoryStatus)).join("")}</select></label>
      <label><span>Rack face</span><select data-map-filter="face">${option("all", "All rack faces", currentMapState.filters.face)}${faces.map((face) => option(face, `F${String(face).padStart(2, "0")}`, currentMapState.filters.face)).join("")}</select></label>
      <label><span>Shelf level</span><select data-map-filter="shelfLevel">${option("all", "All shelf levels", currentMapState.filters.shelfLevel)}${levels.map((level) => option(level, level, currentMapState.filters.shelfLevel)).join("")}</select></label>
      <output data-map-count></output>
    </div>
  `;
}

function syncCurrentMapControls(body) {
  const search = body.querySelector("[data-map-search]");
  if (search) search.value = currentMapState.filters.search;
  body.querySelectorAll("[data-map-filter]").forEach((control) => {
    control.value = currentMapState.filters[control.dataset.mapFilter];
  });
}

function renderCurrentBinPopover(panel, bins, layoutLabel = "Current") {
  const layer = panel.querySelector("[data-bin-popover-layer]");
  const selected = bins.find((bin) => bin.binId === currentMapState.selectedBinId);
  if (!layer) return;
  if (!selected) {
    layer.innerHTML = "";
    return;
  }
  const productIds = [...new Set(selected.inventory.map((lot) => lot.productId))];
  const stockLabel = selected.occupancy === "empty" ? "Empty bin" : productIds.length > 1 ? `${productIds.length} products / SKUs` : selected.inventory[0]?.sku || "Stock";
  const snapshot = selected.inventory[0];
  const hierarchy = formatStorageLocation(selected);
  const placement = selected.velocityPlacement === "matched"
    ? "Location check: product is in its expected velocity zone"
    : selected.velocityPlacement === "mismatch"
      ? "Location check: product is outside its expected velocity zone"
      : selected.occupancy === "empty" ? "No product is assigned to this bin" : "Location check is unavailable for this bin";
  const placementTone = selected.velocityPlacement === "matched" ? "matched" : selected.velocityPlacement === "mismatch" ? "mismatch" : "inconclusive";
  const movement = selected.moveEvents || [];
  const moveDetails = movement.map(({ direction, move }) => {
    const product = productDisplayForMove(move, bins);
    const locationLabel = direction === "in" ? "Original location" : "Recommended location";
    const location = counterpartLocationForMoveEvent({ direction, move, bins });
    const impact = moveImpactPresentation(move);
    const counterpart = counterpartForMoveEvent({ direction, move });
    return `<section class="bin-popover-move is-${escapeAttribute(direction)}"><span class="bin-popover-move-badge">${direction === "in" ? "MOVE IN" : "MOVE OUT"}</span><div class="bin-popover-move-product"><b>${escapeHtml(product.productId)}</b>${product.productName ? `<span>${escapeHtml(product.productName)}</span>` : ""}</div><p class="bin-popover-move-location"><b>${locationLabel}</b><span>${escapeHtml(location)}</span></p><p class="bin-popover-move-impact is-${impact.kind}">${escapeHtml(impact.text)}</p>${counterpart ? `<button type="button" class="bin-popover-jump" data-jump-bin="${escapeAttribute(counterpart.binId)}">${escapeHtml(counterpart.label)}</button>` : ""}</section>`;
  }).join("");
  const technicalNotes = [
    selected.mappingStatus === "mapped" ? "" : selected.mappingIssue || "Bin location could not be mapped.",
    ...movement.map(({ direction, move }) => {
      const affinity = Number(move.lift) > 0 ? ` · UC1 affinity lift ${Number(move.lift).toFixed(2)}` : "";
      return `${direction === "in" ? "Move in" : "Move out"} ${move.productid}: ${move.reason || "No engine reason was saved."}${affinity}`;
    }),
  ];
  layer.innerHTML = `
    <section class="bin-popover" data-bin-popover data-side="right" id="uc3-bin-popover" role="dialog" aria-modal="false" aria-labelledby="uc3-bin-popover-title" tabindex="-1">
      <header class="bin-popover-head">
        <div><span>${escapeHtml(layoutLabel)} location</span><h3 id="uc3-bin-popover-title">${escapeHtml(stockLabel)}</h3><p>${escapeHtml(selected.binLabel)}</p></div>
        <button type="button" data-close-bin-popover aria-label="Close bin details">×</button>
      </header>
      <div class="bin-popover-context"><span>${escapeHtml(selected.zoneLabel)}</span>${selected.isPickFace ? `<b>Primary pick location</b>` : ""}</div>
      <dl class="bin-popover-stats">
        <div><dt>Units on hand</dt><dd>${selected.totalQuantityOnHand}</dd></div>
        <div><dt>Stock status</dt><dd>${escapeHtml(snapshot?.inventoryStatus || selected.binStatus || "Empty")}</dd></div>
        <div><dt>Storage capacity</dt><dd>${selected.capacityVolume ?? "Unavailable"}</dd></div>
        <div><dt>Expiry date</dt><dd>${escapeHtml(snapshot?.expiryDate || "Not applicable")}</dd></div>
      </dl>
      <section class="bin-popover-location"><span>Storage location</span><b>${escapeHtml(hierarchy)}</b></section>
      <p class="bin-popover-placement is-${placementTone}">${escapeHtml(placement)}</p>
      ${moveDetails}
      ${renderTechnicalDetails(`Coordinates: X ${selected.positionX ?? "Unavailable"} · Y ${selected.positionY ?? "Unavailable"} · Z ${selected.positionZ === null || selected.positionZ === undefined ? "Unavailable" : `${selected.positionZ} cm`}`, technicalNotes)}
    </section>
  `;
}

function positionCurrentBinPopover(panel) {
  const popover = panel.querySelector("[data-bin-popover]");
  if (!popover || window.matchMedia("(max-width: 760px)").matches) return;
  const anchor = [...panel.querySelectorAll("[data-bin-id]")]
    .find((button) => button.dataset.binId === currentMapState.selectedBinId);
  if (!anchor) return;

  const panelRect = panel.getBoundingClientRect();
  const anchorRect = anchor.getBoundingClientRect();
  const gap = 12;
  const padding = 10;
  popover.style.visibility = "hidden";
  popover.style.left = "0px";
  popover.style.top = "0px";
  const popoverRect = popover.getBoundingClientRect();
  const width = popoverRect.width;
  const height = popoverRect.height;
  const bounds = {
    left: padding,
    top: padding,
    right: Math.max(padding, panelRect.width - width - padding),
    bottom: Math.max(padding, panelRect.height - height - padding),
  };
  const centerX = anchorRect.left - panelRect.left + anchorRect.width / 2;
  const centerY = anchorRect.top - panelRect.top + anchorRect.height / 2;
  const candidates = [
    { side: "right", left: anchorRect.right - panelRect.left + gap, top: centerY - height / 2 },
    { side: "left", left: anchorRect.left - panelRect.left - width - gap, top: centerY - height / 2 },
    { side: "bottom", left: centerX - width / 2, top: anchorRect.bottom - panelRect.top + gap },
    { side: "top", left: centerX - width / 2, top: anchorRect.top - panelRect.top - height - gap },
  ];
  const placement = candidates.find(({ left, top }) => left >= bounds.left && left <= bounds.right && top >= bounds.top && top <= bounds.bottom) || candidates[0];
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
  popover.dataset.side = placement.side;
  popover.style.left = `${clamp(placement.left, bounds.left, bounds.right)}px`;
  popover.style.top = `${clamp(placement.top, bounds.top, bounds.bottom)}px`;
  popover.style.visibility = "";
}

function renderCurrentLayoutState(kind, { detail = "", warehouse = "" } = {}) {
  const states = {
    loading: ["Reading Current Warehouse Layout", "Loading the central warehouse, its zones, storage bins, and current inventory."],
    permission: ["Current Layout Is Not Available", "The current warehouse layout cannot be read with this session's access."],
    "invalid-inventory": ["Current Inventory Needs Review", "Some current inventory cannot be linked to a storage bin, so the layout is not shown."],
    error: ["Could Not Load the Current Layout", "The current warehouse layout could not be loaded. Please try again."],
    empty: ["No Current Layout Data", "There are no current storage bins to show."],
    "no-central-warehouse": ["No Central Warehouse Found", "A central warehouse must be available before its layout can be shown."],
    "no-bins": ["No Storage Bins in the Central Warehouse", `${warehouse || "The central warehouse"} was found, but it has no storage bins to show.`],
  };
  const [title, message] = states[kind] || states.error;
  return `<div class="feedback${kind === "loading" ? " is-loading" : ""}" data-feedback="${escapeHtml(kind)}" role="status">${kind === "loading" ? "<medflow-loader></medflow-loader>" : ""}<span class="feedback-kind">Current Layout · ${escapeHtml(kind)}</span><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p>${detail ? renderTechnicalDetails("System details", [detail]) : ""}</div>`;
}

function renderTechnicalDetails(summary, notes = []) {
  const detailNotes = Array.isArray(notes) ? notes.filter(Boolean) : [notes].filter(Boolean);
  return `<details class="uc3-technical-details"><summary>Technical details</summary><p>${escapeHtml(summary)}</p>${detailNotes.length ? `<ul>${detailNotes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : ""}</details>`;
}

function matchesFilters(move, bins, q) {
  const haystack = `${move.productid} ${move.productname} ${move.currentbin} ${move.recommendedbin} ${move.reason}`.toLowerCase();
  if (q.q && !haystack.includes(q.q.toLowerCase())) return false;
  if (q.status && move.priority !== q.status) return false;
  if (q.zone) {
    const wanted = q.zone.replace("Zone ", "");
    const target = bins.find((bin) => bin.binid === move.recommendedbin);
    if (target?.zoneLetter !== wanted) return false;
  }
  return true;
}

function renderKpis(root, metrics, moveCount) {
  const host = root.querySelector("[data-kpis]");
  if (!host) return;
  if (metrics.source === "saved-run") {
    host.innerHTML = renderKpiRow([
      { label: "Daily Picker Time", value: metrics.recommended.hoursPerDay.toFixed(1), suffix: "hours / day", delta: `${metrics.current.hoursPerDay.toFixed(1)} hours / day current`, deltaColor: "var(--ok)" },
      { label: "Daily Time Reduction", value: metrics.dailyHoursSaved.toFixed(1), suffix: "hours / day", delta: `${(metrics.improvementPct * 100).toFixed(1)}% lower than current`, deltaColor: "var(--ok)" },
      { label: "Weekly Time Saved", value: metrics.weeklyHoursSaved.toFixed(1), suffix: "hours", delta: "same demand and companion-pick inputs", deltaColor: "var(--ok)" },
      { label: "Products To Relocate", value: metrics.productsMoved, delta: `across ${metrics.binsMoved.toLocaleString()} bin positions` },
    ]);
    return;
  }
  host.innerHTML = renderKpiRow([
    { label: "Average access time", value: metrics.recommended.average.toFixed(1), suffix: "s / pick", delta: `${metrics.current.average.toFixed(1)} s current`, deltaColor: "var(--ok)" },
    { label: "Access time improvement", value: (metrics.improvementPct * 100).toFixed(1), suffix: "%", delta: "recommended vs current", deltaColor: "var(--ok)" },
    { label: "Weekly Time Saved", value: metrics.weeklyHoursSaved.toFixed(1), suffix: "hours", delta: "same demand period", deltaColor: "var(--ok)" },
    { label: "Products to relocate", value: moveCount, delta: "recommended changes only" },
  ]);
}

function recommendationMoveSummary(recommendation) {
  const savedMetrics = savedRunTravelMetrics(recommendation?.run);
  if (savedMetrics) return `${savedMetrics.binsMoved.toLocaleString()} bin moves · ${savedMetrics.productsMoved.toLocaleString()} products`;
  return `${recommendation?.moves?.length || 0} bin moves`;
}

function renderAssignments(body, sourceNote, moves) {
  body.innerHTML = `
    ${sourceNote}
    <div class="assignment-head">
      <div><h2>Recommended Bin Moves</h2><p>Each row is one bin position within a product’s relocated storage group.</p></div>
      <input type="search" data-table-search placeholder="Search SKU, bin or reason" aria-label="Search assignments">
    </div>
    <div class="panel table-panel"><div data-assignment-table></div></div>
  `;
  activeTable = new Tabulator(body.querySelector("[data-assignment-table]"), {
    data: moves,
    layout: "fitColumns",
    responsiveLayout: "collapse",
    height: "500px",
    placeholder: "No changed assignments match the current filters.",
    initialSort: [{ column: "savingSeconds", dir: "desc" }],
    columns: [
      { title: "SKU ID", field: "productid", width: 105, cssClass: "mono", headerSort: true },
      { title: "Product", field: "productname", minWidth: 165 },
      { title: "Demand velocity", field: "velocityclass", width: 120, hozAlign: "center" },
      { title: "Current bin", field: "currentbin", width: 120, cssClass: "mono" },
      { title: "Recommended bin", field: "recommendedbin", width: 142, cssClass: "mono" },
      { title: "Move priority", field: "priority", width: 118 },
      { title: "Daily Picks", field: "avgdailydemand", width: 108, hozAlign: "right", formatter: (cell) => Math.round(cell.getValue()) },
      { title: "Time Saved", field: "savingSeconds", width: 116, hozAlign: "right", formatter: (cell) => `${cell.getValue().toFixed(1)} s` },
      { title: "Reason", field: "reason", minWidth: 260, formatter: "textarea" },
    ],
    rowClick: (_, row) => {
      viewState.selectedId = row.getData().productid;
      if (!sourceNote.includes("ANALYTICAL SAMPLE")) viewState.scenario = "recommended";
      window.location.hash = "#/uc3?tab=map";
    },
  });
  body.querySelector("[data-table-search]").addEventListener("input", (event) => {
    const value = event.target.value.trim();
    if (!value) activeTable.clearFilter();
    else activeTable.setFilter([
      [
        { field: "productid", type: "like", value },
        { field: "productname", type: "like", value },
        { field: "currentbin", type: "like", value },
        { field: "recommendedbin", type: "like", value },
        { field: "reason", type: "like", value },
      ],
    ]);
  });
}

function renderComparison(body, sourceNote, metrics, moveCount) {
  const savedRun = metrics.source === "saved-run";
  const productsMoved = savedRun ? metrics.productsMoved : moveCount;
  const moveScope = savedRun
    ? `${metrics.binsMoved.toLocaleString()} bin positions`
    : "recommended changes only";
  const impactCopy = savedRun
    ? `The saved UC3 run reduces total daily picker time by <b>${metrics.dailyHoursSaved.toFixed(1)} hours</b> (${(metrics.improvementPct * 100).toFixed(1)}%).`
    : `The saved recommendation applies the complete feasible move set and improves the average access time by <b>${(metrics.improvementPct * 100).toFixed(1)}%</b>.`;
  body.innerHTML = `
    ${sourceNote}
    <div class="comparison-grid">
      <div class="panel comparison-panel"><div class="panel-title"><div><span>Picker Travel Impact</span><h2>${savedRun ? "Daily Picker Time by Layout" : "Access Time by Layout"}</h2></div><b>${savedRun || viewState.use25d ? "Shelf-aware" : "Travel only"}</b></div><div data-comparison-chart></div></div>
      <aside class="analysis-summary">
        <p class="detail-kicker">Expected impact</p>
        <h2>The Recommended Layout Reduces Picker Time</h2>
        <p>${impactCopy}</p>
        <div class="metric-stack">
          <div><span>${savedRun ? "Daily time reduction" : "Access-time reduction"}</span><b>${savedRun ? `${metrics.dailyHoursSaved.toFixed(1)} hours / day` : `${Math.max(0, metrics.current.average - metrics.recommended.average).toFixed(1)} s / pick`}</b></div>
          <div><span>Products to relocate</span><b>${productsMoved.toLocaleString()} products<br><small>${moveScope}</small></b></div>
          <div><span>Estimated weekly benefit</span><b>${metrics.weeklyHoursSaved.toFixed(1)} picker hours</b></div>
        </div>
      </aside>
    </div>
    <div class="methodology-panel">
      <div><span>01</span><b>Storage fit first</b><p>Physical fit, storage condition, capacity, and one product per bin are checked before recommendations are compared.</p></div>
      <div><span>02</span><b>Like-for-like comparison</b><p>Current and recommended layouts use the same travel and shelf-access assumptions.</p></div>
      <div><span>03</span><b>Business outcome</b><p>Benefits are expressed as picker time saved.</p></div>
    </div>
    ${renderTechnicalDetails(savedRun ? "Source: saved UC3 run totals (picking plus companion travel; excludes one-off move labour)." : `Internal model: ${viewState.use25d ? "2.5D shelf-aware" : "2D travel-only"} · Zone distance ${ACCESS_MODEL.zoneMetres} m · Aisle distance ${ACCESS_MODEL.aisleMetres} m · Trip factor ${ACCESS_MODEL.tripFactor}× · Walking speed ${ACCESS_MODEL.walkingSpeed} m/s · Upper-shelf access +${ACCESS_MODEL.ladderPenalty} s`)}
  `;
  renderComparisonChart(body.querySelector("[data-comparison-chart]"), metrics);
}

export { ZONE_LETTERS };
