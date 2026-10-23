import * as d3 from "d3";
import { escapeAttribute, escapeHtml } from "@shared/utils/html.js";
import { AISLES_PER_PAGE, classifyBinMovement, formatStorageLocation, matchesCurrentMapFilters, movementStateCopy } from "../movement-navigation.js";

export { AISLES_PER_PAGE, classifyBinMovement, matchesCurrentMapFilters } from "../movement-navigation.js";

function stockLabel(bin) {
  if (bin.occupancy === "empty") return "Empty bin";
  const productIds = [...new Set(bin.inventory.map((lot) => lot.productId))];
  return productIds.length > 1 ? `MULTI · ${productIds.length}` : bin.inventory[0]?.sku || "STOCK";
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function numericSort(a, b) {
  const difference = Number(a) - Number(b);
  return Number.isFinite(difference) && difference !== 0
    ? difference
    : String(a).localeCompare(String(b), undefined, { numeric: true });
}

function zoneGroups(bins) {
  return Array.from(d3.group(bins, (bin) => bin.zoneId || "unassigned"), ([zoneId, zoneBins]) => {
    const mappedBins = zoneBins.filter((bin) => bin.mappingStatus === "mapped");
    const occupied = zoneBins.filter((bin) => bin.occupancy === "occupied").length;
    return {
      zoneId,
      zoneLabel: zoneBins[0].zoneLabel,
      bins: zoneBins,
      occupied,
      occupancyPercent: zoneBins.length ? Math.round((occupied / zoneBins.length) * 100) : 0,
      aisleCount: new Set(mappedBins.map((bin) => bin.aisleNumber)).size,
      unmappedCount: zoneBins.length - mappedBins.length,
    };
  }).sort((a, b) => a.zoneLabel.localeCompare(b.zoneLabel, undefined, { numeric: true }));
}

/** Render a read-only overview plus paginated rack elevations from the current-layout view model. */
export function renderWarehouseSlottingMap(root, {
  bins,
  layoutLabel = "Current",
  selectedBinId,
  selectedZoneId,
  aislePage = 0,
  filters = {},
  onSelect,
  onPageChange,
}) {
  if (!root) return { filteredCount: 0, totalCount: 0, unmappedCount: 0, aislePage: 0 };
  root.innerHTML = `<div class="warehouse-overview" data-overview></div><div class="warehouse-detail" data-detail></div>`;
  const zones = zoneGroups(bins);
  renderOverview(root.querySelector("[data-overview]"), zones, selectedZoneId, onSelect, layoutLabel);
  const selectedZone = zones.find((zone) => zone.zoneId === selectedZoneId) || zones[0];
  return renderDetail(root.querySelector("[data-detail]"), selectedZone, selectedBinId, aislePage, filters, onSelect, onPageChange);
}

function renderOverview(root, zones, selectedZoneId, onSelect, layoutLabel) {
  const width = 1140;
  const height = 212;
  const svg = d3.select(root).append("svg").attr("viewBox", `0 0 ${width} ${height}`).attr("class", "warehouse-overview-svg").attr("role", "img").attr("aria-label", `${layoutLabel} warehouse zone overview`);
  const x = d3.scaleBand().domain(zones.map((zone) => zone.zoneId)).range([118, 1110]).padding(0.06);
  svg.append("text").attr("class", "overview-depot").attr("x", 34).attr("y", 93).text(String(layoutLabel).toUpperCase());
  svg.append("text").attr("class", "overview-depot").attr("x", 34).attr("y", 108).text("LAYOUT");
  svg.append("line").attr("class", "overview-axis").attr("x1", 116).attr("x2", 1092).attr("y1", 181).attr("y2", 181);
  svg.append("text").attr("class", "overview-access").attr("x", 118).attr("y", 202).text("SELECT A ZONE · THEN REVIEW THREE AISLES PER PAGE");
  const cards = svg.selectAll("g.zone-card").data(zones).join("g").attr("class", "zone-card").classed("is-selected", (zone) => zone.zoneId === selectedZoneId).attr("transform", (zone) => `translate(${x(zone.zoneId)},18)`).attr("tabindex", 0).attr("role", "button").attr("aria-label", (zone) => `${zone.zoneLabel}, ${zone.bins.length} bins, ${zone.occupancyPercent}% occupied`).on("click", (_, zone) => onSelect({ zoneId: zone.zoneId })).on("keydown", (event, zone) => {
    if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      onSelect({ zoneId: zone.zoneId });
    }
  });
  cards.append("rect").attr("width", x.bandwidth()).attr("height", 145).attr("rx", 8);
  cards.append("text").attr("class", "overview-zone").attr("x", x.bandwidth() / 2).attr("y", 26).attr("text-anchor", "middle").text((zone) => zone.zoneLabel);
  cards.append("text").attr("class", "overview-band").attr("x", x.bandwidth() / 2).attr("y", 49).attr("text-anchor", "middle").text((zone) => `${zone.bins.length} storage bins · ${zone.aisleCount} aisles`);
  cards.append("text").attr("class", "overview-band").attr("x", x.bandwidth() / 2).attr("y", 68).attr("text-anchor", "middle").text((zone) => `${zone.occupied} occupied · ${zone.occupancyPercent}%`);
  cards.append("text").attr("class", "overview-warning").attr("x", x.bandwidth() / 2).attr("y", 89).attr("text-anchor", "middle").text((zone) => zone.unmappedCount ? `${zone.unmappedCount} need location review` : "All bin locations ready");
  cards.append("rect").attr("class", "overview-progress-track").attr("x", 16).attr("y", 111).attr("width", Math.max(x.bandwidth() - 32, 0)).attr("height", 8).attr("rx", 4);
  cards.append("rect").attr("class", "overview-progress-value").attr("x", 16).attr("y", 111).attr("width", (zone) => Math.max((x.bandwidth() - 32) * zone.occupancyPercent / 100, 0)).attr("height", 8).attr("rx", 4);
}

function renderDetail(root, zone, selectedBinId, requestedPage, filters, onSelect, onPageChange) {
  if (!zone) {
    root.innerHTML = `<div class="layout-coordinate-empty">No zone records are available for the current warehouse.</div>`;
    return { filteredCount: 0, totalCount: 0, unmappedCount: 0, aislePage: 0 };
  }

  const mappedBins = zone.bins.filter((bin) => bin.mappingStatus === "mapped");
  const unmappedBins = zone.bins.filter((bin) => bin.mappingStatus !== "mapped");
  const matchingBins = zone.bins.filter((bin) => matchesCurrentMapFilters(bin, filters));
  const matchingIds = new Set(matchingBins.map((bin) => bin.binId));
  // Sort before every zone is paginated: A02 always precedes A10, regardless
  // of how the live rows were returned by Supabase.
  const aisles = [...new Set(mappedBins.map((bin) => bin.aisleNumber))].sort(numericSort);
  const pageCount = Math.max(Math.ceil(aisles.length / AISLES_PER_PAGE), 1);
  const aislePage = Math.min(Math.max(Number(requestedPage) || 0, 0), pageCount - 1);
  const visibleAisles = aisles.slice(aislePage * AISLES_PER_PAGE, (aislePage + 1) * AISLES_PER_PAGE);
  const visibleMapped = mappedBins.filter((bin) => visibleAisles.includes(bin.aisleNumber));

  const aisleButtons = aisles.map((aisle, index) => `<button type="button" class="aisle-jump${visibleAisles.includes(aisle) ? " is-visible" : ""}" data-aisle-page="${Math.floor(index / AISLES_PER_PAGE)}">A${twoDigits(aisle)}</button>`).join("");
  const aisleSections = visibleAisles.map((aisle) => renderAisleElevation(aisle, visibleMapped.filter((bin) => bin.aisleNumber === aisle), matchingIds, selectedBinId)).join("");
  const matchingUnmapped = unmappedBins.filter((bin) => matchingIds.has(bin.binId));

  root.innerHTML = `
    <section class="rack-detail-head">
      <div><span class="rack-detail-kicker">${escapeHtml(zone.zoneId)}</span><h2>${escapeHtml(zone.zoneLabel)} · Rack View</h2><p>Select a storage bin to view its product and location details.</p></div>
      <div class="aisle-pager" aria-label="Aisle pages"><button type="button" data-page="${aislePage - 1}" ${aislePage === 0 ? "disabled" : ""}>Previous</button><span>Page ${aislePage + 1} of ${pageCount}</span><button type="button" data-page="${aislePage + 1}" ${aislePage === pageCount - 1 ? "disabled" : ""}>Next</button></div>
    </section>
    <nav class="aisle-jump-list" aria-label="Direct aisle selection">${aisleButtons || `<span>No mapped aisles</span>`}</nav>
    <div class="aisle-elevation-list">${aisleSections || `<div class="layout-coordinate-empty">No rack locations are available for this zone.</div>`}</div>
    ${renderUnmappedTray(matchingUnmapped, unmappedBins.length)}
  `;

  root.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => onPageChange?.(Number(button.dataset.page))));
  root.querySelectorAll("[data-aisle-page]").forEach((button) => button.addEventListener("click", () => onPageChange?.(Number(button.dataset.aislePage))));
  root.querySelectorAll("[data-bin-id]").forEach((button) => button.addEventListener("click", (event) => {
    const bin = zone.bins.find((candidate) => candidate.binId === button.dataset.binId);
    if (bin) onSelect({
      zoneId: zone.zoneId,
      bin,
      anchor: button,
      openedWithKeyboard: event.detail === 0,
    });
  }));

  return { filteredCount: matchingBins.length, totalCount: zone.bins.length, unmappedCount: unmappedBins.length, aislePage };
}

function renderAisleElevation(aisleNumber, aisleBins, matchingIds, selectedBinId) {
  const faces = [...new Set(aisleBins.map((bin) => bin.faceNumber))].sort(numericSort);
  const occupied = aisleBins.filter((bin) => bin.occupancy === "occupied").length;
  const matching = aisleBins.filter((bin) => matchingIds.has(bin.binId)).length;
  const faceSections = faces.map((face) => renderFace(face, aisleBins.filter((bin) => bin.faceNumber === face), matchingIds, selectedBinId)).join("");
  return `<article class="aisle-elevation"><header><div><span>AISLE</span><h3>A${twoDigits(aisleNumber)}</h3></div><p>${aisleBins.length} bins · ${occupied} occupied · ${matching} match${matching === 1 ? "" : "es"}</p></header><div class="aisle-rack-scroll"><div class="aisle-rack-canvas">${faceSections}</div></div></article>`;
}

function renderFace(faceNumber, faceBins, matchingIds, selectedBinId) {
  const racks = [...new Set(faceBins.map((bin) => bin.rackNumber))].sort(numericSort);
  return `<section class="rack-face" aria-label="Rack face F${twoDigits(faceNumber)}"><div class="rack-face-label"><span>RACK FACE</span><b>F${twoDigits(faceNumber)}</b></div><div class="rack-run">${racks.map((rack) => renderRack(rack, faceBins.filter((bin) => bin.rackNumber === rack), matchingIds, selectedBinId)).join("")}</div></section>`;
}

function renderRack(rackNumber, rackBins, matchingIds, selectedBinId) {
  const levels = [...new Set(rackBins.map((bin) => bin.shelfLevel))]
    .sort((a, b) => Number(String(b).replace(/^L/, "")) - Number(String(a).replace(/^L/, "")));
  return `<section class="rack-elevation" aria-label="Rack R${twoDigits(rackNumber)}"><h4>RACK R${twoDigits(rackNumber)}</h4><div class="rack-levels">${levels.map((level) => renderLevel(level, rackBins.filter((bin) => bin.shelfLevel === level), matchingIds, selectedBinId)).join("")}</div></section>`;
}

function renderLevel(level, levelBins, matchingIds, selectedBinId) {
  const visibleBins = levelBins.filter((bin) => matchingIds.has(bin.binId)).sort((a, b) => a.binPosition.localeCompare(b.binPosition, undefined, { numeric: true }));
  return `<div class="rack-level"><span class="rack-level-label">${escapeHtml(level)}</span><div class="rack-level-bins">${visibleBins.length ? visibleBins.map((bin) => renderBinButton(bin, selectedBinId)).join("") : `<span class="rack-level-no-match">No matches</span>`}</div></div>`;
}

function renderBinButton(bin, selectedBinId) {
  const productIds = [...new Set(bin.inventory.map((lot) => lot.productId))];
  const isSelected = bin.binId === selectedBinId;
  const movement = classifyBinMovement(bin);
  const movementCopy = movementStateCopy(movement);
  const classes = ["rack-bin", bin.occupancy === "empty" ? "is-empty" : "is-occupied", productIds.length > 1 ? "is-multi" : "", bin.isPickFace ? "is-pick-face" : "", movement === "in" ? "is-moved-in" : "", movement === "out" ? "is-moved-out" : "", movement === "both" ? "is-moved-both" : "", bin.binId === selectedBinId ? "is-selected" : ""].filter(Boolean).join(" ");
  const tooltip = `${bin.binId}\n${stockLabel(bin)} · ${bin.totalQuantityOnHand} units on hand${movementCopy.aria ? ` · ${movementCopy.aria}` : ""}`;
  return `<button type="button" class="${classes}" data-bin-id="${escapeAttribute(bin.binId)}" title="${escapeAttribute(tooltip)}" aria-label="${escapeAttribute(`${bin.binId}, ${stockLabel(bin)}, ${bin.totalQuantityOnHand} units on hand${movementCopy.aria ? `, ${movementCopy.aria}` : ""}${bin.isPickFace ? ", primary pick location" : ""}`)}" aria-controls="uc3-bin-popover" aria-expanded="${isSelected}"><b>${escapeHtml(bin.binPosition)}${bin.isPickFace ? " · PF" : ""}</b><span>${escapeHtml(stockLabel(bin))}</span>${movementCopy.badge ? `<em class="rack-bin-move is-${movement}">${movementCopy.badge}</em>` : ""}</button>`;
}

function renderUnmappedTray(matchingBins, totalUnmapped) {
  if (!totalUnmapped) return "";
  return `<details class="unmapped-bin-tray"><summary><span><b>${totalUnmapped} bin${totalUnmapped === 1 ? "" : "s"} needing location review</b><small>These storage bins cannot yet be shown in the rack view.</small></span><em>${matchingBins.length} shown</em></summary><div class="unmapped-bin-list">${matchingBins.length ? matchingBins.map((bin) => `<button type="button" data-bin-id="${escapeAttribute(bin.binId)}"><b>${escapeHtml(bin.binId)}</b><span>${escapeHtml(bin.mappingIssue || "Location unavailable")}</span></button>`).join("") : `<p>No bins needing location review match the current filters.</p>`}</div></details>`;
}
