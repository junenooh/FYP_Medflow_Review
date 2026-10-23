/**
 * UC1 companion network — force-directed graph of FP-Growth association rules.
 *
 * Data contract (engines/uc1/arm.py):
 *   productrelationship
 *     relationshipid, warehouseid, consequent_productid, itemsetsize,
 *     support, confidence, lift, strength, ordercount, rulesource,
 *     lastupdated, runid
 *   productrelationshipantecedent
 *     relationshipid, antecedent_productid
 *
 * Rows may arrive either camelCased by the data layer or as raw DB columns;
 * normaliseRule() accepts both so this file does not care which.
 *
 * Facts from arm.py that shape the rendering:
 *   - Exactly one consequent per rule (mine_rules filters len(consequents)==1),
 *     so every rule fans out to itemsetsize-1 edges.
 *   - mlxtend emits both directions of a pair, so edges are collapsed onto an
 *     order-independent key.
 *   - strength is min(band(support), band(confidence), band(lift)), so a link
 *     can carry high lift and still be banded Weak. The tooltip shows all three.
 *   - ordercount is the run's total order count, identical on every row. It is
 *     NOT a per-item pick count and must not drive node size.
 *
 * Radius  = how often the SKU is picked (see nodeWeight() for the fallback chain)
 * Colour  = product category when the data layer supplies one
 * Width   = lift, and higher lift also shortens the link
 */

import * as d3 from "d3";

const STRENGTH_RANK = { Weak: 1, Moderate: 2, Strong: 3 };

const DEFAULTS = {
  height: 480,
  /** Cap on edges drawn. FP-Growth output gets dense fast; strongest rules survive. */
  maxLinks: 500,
  hideIsolated: true,
  /** { [productid]: pickCount } — real per-SKU frequency, if you have it. */
  itemCounts: null,
  /** { [productid]: { name, category } } — labels and category colour. */
  productMeta: null,
  showLabels: true,
};

/* ------------------------------------------------------------------ */
/* Row normalisation                                                   */
/* ------------------------------------------------------------------ */

function num(value) {
  const n = typeof value === "string" ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

function maxOf(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

function minOf(a, b) {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

/** Accepts the camelCase view-model or the raw productrelationship columns. */
function normaliseRule(row) {
  if (!row) return null;
  const consequent = row.consequent ?? row.consequent_productid ?? row.consequentProductid;
  if (consequent == null) return null;

  let antecedents = row.antecedents ?? row.antecedent_productids ?? [];
  if (!Array.isArray(antecedents)) antecedents = [antecedents];
  // Tolerate a joined shape: [{ antecedent_productid: 'P1' }, ...]
  antecedents = antecedents
    .map((a) => (a && typeof a === "object" ? a.antecedent_productid ?? a.productid ?? a.id : a))
    .filter((a) => a != null && a !== "");
  if (!antecedents.length) return null;

  return {
    id: row.relationshipid ?? row.relationshipId ?? null,
    antecedents: antecedents.map(String),
    consequent: String(consequent),
    consequentName: row.consequentName ?? row.consequent_name ?? null,
    category: row.consequentCategory ?? row.consequent_category ?? row.category ?? null,
    support: num(row.support),
    confidence: num(row.confidence),
    lift: num(row.lift),
    strength: row.strength ?? null,
    itemsetSize: num(row.itemsetsize ?? row.itemsetSize) ?? antecedents.length + 1,
  };
}

/* ------------------------------------------------------------------ */
/* Graph construction                                                  */
/* ------------------------------------------------------------------ */

function buildGraph(rawRules, opts) {
  const nodes = new Map();
  const links = new Map();

  const touchNode = (id, meta = {}) => {
    const key = String(id);
    let node = nodes.get(key);
    if (!node) {
      node = {
        id: key,
        name: key,
        category: null,
        degree: 0,
        bestSupport: null,   // proxy for pick frequency
        weight: 0,
      };
      nodes.set(key, node);
    }
    const extra = opts.productMeta?.[key];
    const name = meta.name || extra?.name;
    const category = meta.category || extra?.category;
    if (name && node.name === node.id) node.name = name;
    if (category && !node.category) node.category = category;
    return node;
  };

  for (const raw of rawRules) {
    const rule = normaliseRule(raw);
    if (!rule) continue;

    const target = touchNode(rule.consequent, {
      name: rule.consequentName,
      category: rule.category,
    });
    target.bestSupport = maxOf(target.bestSupport, rule.support);

    for (const antecedentId of rule.antecedents) {
      const source = touchNode(antecedentId);
      source.bestSupport = maxOf(source.bestSupport, rule.support);
      if (source.id === target.id) continue;

      const key =
        source.id < target.id ? `${source.id}\u0000${target.id}` : `${target.id}\u0000${source.id}`;
      let link = links.get(key);
      if (!link) {
        link = {
          id: key,
          source: source.id,
          target: target.id,
          support: null,
          confidence: null,
          lift: null,
          strength: null,
          minItemsetSize: null,
          ruleCount: 0,
        };
        links.set(key, link);
      }
      link.support = maxOf(link.support, rule.support);
      link.confidence = maxOf(link.confidence, rule.confidence);
      link.lift = maxOf(link.lift, rule.lift);
      link.minItemsetSize = minOf(link.minItemsetSize, rule.itemsetSize);
      if ((STRENGTH_RANK[rule.strength] || 0) > (STRENGTH_RANK[link.strength] || 0)) {
        link.strength = rule.strength;
      }
      link.ruleCount += 1;
    }
  }

  let linkList = [...links.values()];
  if (linkList.length > opts.maxLinks) {
    linkList = linkList.sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0)).slice(0, opts.maxLinks);
  }

  const kept = new Set();
  for (const link of linkList) {
    kept.add(link.source);
    kept.add(link.target);
    nodes.get(link.source).degree += 1;
    nodes.get(link.target).degree += 1;
  }

  const nodeList = [...nodes.values()].filter((n) => kept.has(n.id));
  for (const node of nodeList) node.weight = nodeWeight(node, opts);

  return { nodes: nodeList, links: linkList, hasCategories: nodeList.some((n) => n.category) };
}

/**
 * Node radius source, best first:
 *   1. options.itemCounts — a real per-SKU pick count, if you persist one.
 *   2. Highest support among the rules the SKU appears in. An itemset's support
 *      is a lower bound on its members' individual support, so this ranks
 *      frequently-picked SKUs correctly even though it understates them.
 *   3. Degree, so the graph still reads when neither is available.
 * ordercount is deliberately absent: arm.py writes the run-level order total to
 * every row, so it is constant and carries no per-SKU information.
 */
function nodeWeight(node, opts) {
  const counts = opts.itemCounts;
  const explicit = counts ? num(counts[node.id] ?? counts.get?.(node.id)) : null;
  if (explicit != null) return explicit;
  if (node.bestSupport != null) return node.bestSupport;
  return node.degree;
}

function extentOf(items, key) {
  const values = items.map((d) => d[key]).filter((v) => v != null);
  if (!values.length) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? [lo, lo + 1e-6] : [lo, hi];
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

const STYLE_ID = "uc1-network-style";

const STYLES = `
.nx { position: relative; }
.nx-controls { display: flex; flex-wrap: wrap; gap: 14px 20px; align-items: flex-end; margin-bottom: 10px; }
.nx-help { position: absolute; z-index: 5; top: 0; right: 0; }
.nx-help .table-info-icon { margin: 0; vertical-align: initial; }
.nx-help-tip { position: absolute; top: calc(100% + 8px); right: 0; width: min(260px, calc(100vw - 48px)); padding: 10px 12px; border: 1px solid var(--line, #e8e8e3); border-radius: 8px; background: var(--bg, #fff); color: var(--ink, #1c1c1c); box-shadow: 0 6px 20px rgba(0,0,0,.14); font-size: 12px; font-weight: 400; line-height: 1.45; opacity: 0; visibility: hidden; pointer-events: none; transition: opacity .12s ease; }
.nx-help:hover .nx-help-tip, .nx-help:focus-within .nx-help-tip { opacity: 1; visibility: visible; }
.nx-help-tip p { margin: 4px 0; }
.nx-field { display: flex; flex-direction: column; gap: 4px; min-width: 148px; }
.nx-field > span { font-size: 11px; opacity: .7; display: flex; justify-content: space-between; gap: 10px; }
.nx-field input[type=range] { width: 100%; accent-color: var(--aff1, #3f7bd8); }
.nx-field input[type=search], .nx-field select { padding: 5px 8px; border-radius: 6px; border: 1px solid rgba(128,128,128,.35); background: transparent; color: inherit; font: inherit; font-size: 12px; }
.nx-toggle { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: .8; padding-bottom: 4px; }
.nx-reset { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; cursor: pointer; border: 1px solid rgba(128,128,128,.35); background: transparent; color: inherit; }
.nx-reset:hover { border-color: var(--aff1, #3f7bd8); }
.nx svg { width: 100%; display: block; touch-action: none; cursor: grab; }
.nx svg:active { cursor: grabbing; }
.nx-empty { padding: 28px; text-align: center; font-size: 13px; opacity: .65; }
.nx-node { cursor: pointer; }
.nx-label { font-size: 10px; pointer-events: none; paint-order: stroke; stroke: var(--bg, #fff); stroke-width: 3px; stroke-linejoin: round; }
.nx-tip { position: fixed; z-index: 9999; pointer-events: none; max-width: 260px; padding: 8px 10px; border-radius: 8px; font-size: 12px; line-height: 1.45; background: #16181d; color: #f3f4f6; box-shadow: 0 6px 24px rgba(0,0,0,.28); opacity: 0; transition: opacity .12s ease; }
.nx-tip b { display: block; margin-bottom: 3px; }
.nx-tip dl { display: grid; grid-template-columns: auto auto; gap: 1px 10px; margin: 4px 0 0; }
.nx-tip dt { opacity: .6; }
.nx-tip dd { margin: 0; text-align: right; font-variant-numeric: tabular-nums; }
.nx-tip small { display: block; margin-top: 5px; opacity: .55; line-height: 1.35; }
.nx-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin-top: 8px; font-size: 11px; opacity: .8; }
.nx-legend i { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; vertical-align: middle; }
.nx-legend i.bar { width: 14px; height: 3px; border-radius: 2px; }
.nx-legend hr { border: 0; border-left: 1px solid rgba(128,128,128,.3); height: 12px; margin: 0; }
@media (prefers-reduced-motion: reduce) { .nx-tip { transition: none; } }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const tag = document.createElement("style");
  tag.id = STYLE_ID;
  tag.textContent = STYLES;
  document.head.append(tag);
}

const BAND_COLOUR = {
  Strong: "var(--aff1, #2f7d4f)",
  Moderate: "var(--aff2, #c08a2e)",
  Weak: "var(--aff3, #9aa1ab)",
};

function bandColour(strength) {
  return BAND_COLOUR[strength] || "var(--aff3, #9aa1ab)";
}

function sliderField(key, label, [lo, hi], value) {
  const step = key === "lift" ? 0.01 : (hi - lo) / 100 || 0.001;
  return `
    <label class="nx-field" data-slider="${key}">
      <span>${label}</span>
      <input type="range" min="${lo}" max="${hi}" step="${step}" value="${value}">
    </label>`;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

export function renderNetworkChart(root, relationships = [], options = {}) {
  const host = typeof root === "string" ? document.querySelector(root) : root;
  if (!host) return null;

  const opts = { ...DEFAULTS, ...options };
  ensureStyles();

  const graph = buildGraph(relationships, opts);
  host.innerHTML = "";

  const noop = { update() {}, highlight() {}, clearHighlight() {}, destroy() {} };
  if (!graph.links.length) {
    host.innerHTML = `<div class="nx-empty">No product combinations match the current filters for this site.</div>`;
    return noop;
  }

  const liftExtent = extentOf(graph.links, "lift") ?? [1.2, 2];
  const supportExtent = extentOf(graph.links, "support");
  const confidenceExtent = extentOf(graph.links, "confidence");
  const sizes = [...new Set(graph.links.map((l) => l.minItemsetSize).filter(Boolean))].sort();
  const weightMax = Math.max(...graph.nodes.map((n) => n.weight), 1e-6);

  const filters = {
    support: supportExtent ? supportExtent[0] : null,
    confidence: confidenceExtent ? confidenceExtent[0] : null,
    maxItemsetSize: sizes.length ? sizes[sizes.length - 1] : null,
  };
  let pinned = new Set();
  let showLabels = opts.showLabels;

  /* ---- scales ---- */
  const categories = graph.hasCategories
    ? [...new Set(graph.nodes.map((n) => n.category || "Unclassified"))].sort()
    : [];
  const colour = d3.scaleOrdinal().domain(categories).range(d3.schemeTableau10);
  const nodeFill = (d) => (graph.hasCategories ? colour(d.category || "Unclassified") : "var(--aff1, #3f7bd8)");

  const radius = d3.scaleSqrt().domain([0, weightMax]).range([5, 20]);
  const strokeWidth = d3.scaleLinear().domain(liftExtent).range([1, 6]).clamp(true);
  // Inverted on purpose: stronger lift -> shorter link.
  const distance = d3.scaleLinear().domain(liftExtent).range([170, 45]).clamp(true);

  /* ---- markup ---- */
  const wrap = document.createElement("div");
  wrap.className = "nx";
  wrap.innerHTML = `
    <div class="nx-help">
      <button type="button" class="table-info-icon" aria-label="How to read this graph" aria-describedby="nx-help-tip">i</button>
      <div class="nx-help-tip" id="nx-help-tip" role="tooltip">
        <p><strong>Circle (Product):</strong> Circle size reflects how frequently the item is co-ordered with other products.</p>
        <p><strong>Line (Suggestion):</strong> Connects products frequently bought together. Thicker lines indicate stronger pairing likelihood, while darker colour indicates stronger product combination strength.</p>
        <p><strong>Hover:</strong> Hover over a line to view co-pick metrics, or over a product circle to see its description and SKU details.</p>
        <p><strong>Click:</strong> Click a product circle to highlight all its direct connections.</p>
        <p><strong>Drag:</strong> Drag a product circle to rearrange the network and customize your view.</p>
        <p><strong>Sliders:</strong> Adjust the sliders to the right to reveal product combinations with higher popularity and reliability.</p>
      </div>
    </div>
    <div class="nx-controls">
      ${supportExtent ? sliderField("support", "Popular Product Combination", supportExtent, filters.support) : ""}
      ${confidenceExtent ? sliderField("confidence", "Reliable Product Combination", confidenceExtent, filters.confidence) : ""}
      ${
        sizes.length > 1
          ? `<label class="nx-field">
                 <span>Bundle Size</span>
               <select data-size>
                 ${sizes
                   .map(
                     (s) =>
                         `<option value="${s}"${s === filters.maxItemsetSize ? " selected" : ""}>up to ${s} products</option>`
                   )
                   .join("")}
               </select>
             </label>`
          : ""
      }
      <label class="nx-toggle"><input type="checkbox" ${showLabels ? "checked" : ""} data-labels> Labels</label>
      <button type="button" class="nx-reset">Reset view</button>
    </div>
    <div class="nx-legend">
      ${categories.map((c) => `<span><i style="background:${colour(c)}"></i>${c}</span>`).join("")}
      ${categories.length ? "<hr>" : ""}
      ${["Strong", "Moderate", "Weak"]
        .map((b) => `<span><i class="bar" style="background:${bandColour(b)}"></i>${recommendationLabel(b)}</span>`)
        .join("")}
    </div>
  `;
  host.append(wrap);

  const tip = document.createElement("div");
  tip.className = "nx-tip";
  document.body.append(tip);

  /* ---- svg ---- */
  let w = host.clientWidth || 720;
  const h = opts.height;

  const svg = d3
    .select(wrap)
    .insert("svg", ".nx-legend")
    .attr("viewBox", [0, 0, w, h])
    .attr("height", h)
    .attr("role", "img")
    .attr("aria-label", "Product clusters showing combinations that often appear in orders");

  const view = svg.append("g");
  const linkLayer = view.append("g").attr("stroke-linecap", "round");
  const nodeLayer = view.append("g").attr("stroke", "var(--bg, #fff)").attr("stroke-width", 1.5);
  const labelLayer = view.append("g");

  const zoom = d3
    .zoom()
    .scaleExtent([0.25, 6])
    .on("zoom", (event) => view.attr("transform", event.transform));
  svg.call(zoom);

  /* ---- simulation ----
     forceLink rewrites source/target from ids to node objects, so it must be
     handed the same persistent objects every time or positions reset on filter. */
  const linkForce = d3
    .forceLink([])
    .id((d) => d.id)
    .distance((d) => distance(d.lift ?? liftExtent[0]))
    .strength((d) => 0.15 + 0.5 * normalise(d.lift, liftExtent));

  const sim = d3
    .forceSimulation(graph.nodes)
    .force("link", linkForce)
    .force("charge", d3.forceManyBody().strength(-240))
    .force("collide", d3.forceCollide((d) => radius(d.weight) + 4))
    .force("center", d3.forceCenter(w / 2, h / 2))
    .force("x", d3.forceX(w / 2).strength(0.03))
    .force("y", d3.forceY(h / 2).strength(0.03))
    .on("tick", tick);

  let linkSel = linkLayer.selectAll("line");
  let nodeSel = nodeLayer.selectAll("circle");
  let labelSel = labelLayer.selectAll("text");

  function normalise(value, [lo, hi]) {
    if (value == null || hi === lo) return 0.5;
    return (value - lo) / (hi - lo);
  }

  function visibleLinks() {
    return graph.links.filter((l) => {
      if (filters.support != null && l.support != null && l.support < filters.support) return false;
      if (filters.confidence != null && l.confidence != null && l.confidence < filters.confidence) return false;
      if (
        filters.maxItemsetSize != null &&
        l.minItemsetSize != null &&
        l.minItemsetSize > filters.maxItemsetSize
      ) {
        return false;
      }
      return true;
    });
  }

  function draw() {
    const links = visibleLinks();
    const live = new Set();
    for (const l of links) {
      live.add(typeof l.source === "object" ? l.source.id : l.source);
      live.add(typeof l.target === "object" ? l.target.id : l.target);
    }
    const nodes = opts.hideIsolated ? graph.nodes.filter((n) => live.has(n.id)) : graph.nodes;

    linkSel = linkSel
      .data(links, (d) => d.id)
      .join("line")
      .attr("stroke", (d) => bandColour(d.strength))
      .attr("stroke-width", (d) => strokeWidth(d.lift ?? liftExtent[0]))
      .attr("stroke-opacity", 0.5)
      .on("pointerenter", (event, d) => showTip(event, linkTip(d)))
      .on("pointermove", moveTip)
      .on("pointerleave", hideTip);

    nodeSel = nodeSel
      .data(nodes, (d) => d.id)
      .join((enter) =>
        enter
          .append("circle")
          .attr("class", "nx-node")
          .attr("fill", nodeFill)
          .attr("r", (d) => radius(d.weight))
          .call(drag(sim))
          .on("pointerenter", (event, d) => showTip(event, nodeTip(d)))
          .on("pointermove", moveTip)
          .on("pointerleave", hideTip)
          .on("click", (event, d) => {
            event.stopPropagation();
            togglePin(d.id);
          })
      );

    labelSel = labelSel
      .data(showLabels ? nodes : [], (d) => d.id)
      .join("text")
      .attr("class", "nx-label")
      .attr("text-anchor", "middle")
      .attr("fill", "currentColor")
      .text((d) => d.id);

    sim.nodes(nodes);
    linkForce.links(links);
    sim.alpha(0.5).restart();
    paint();
  }

  /** Opacity pass for pinned selection. Never changes the layout. */
  function paint() {
    const focus = pinned;
    const dimming = focus.size > 0;

    const near = new Set(focus);
    if (dimming) {
      for (const l of linkSel.data()) {
        const s = l.source.id ?? l.source;
        const t = l.target.id ?? l.target;
        if (focus.has(s)) near.add(t);
        if (focus.has(t)) near.add(s);
      }
    }

    nodeSel
      .attr("opacity", (d) => (!dimming ? 1 : focus.has(d.id) ? 1 : near.has(d.id) ? 0.55 : 0.12))
      .attr("stroke", (d) => (pinned.has(d.id) ? "var(--aff1, #3f7bd8)" : "var(--bg, #fff)"))
      .attr("stroke-width", (d) => (pinned.has(d.id) ? 3 : 1.5));

    linkSel.attr("stroke-opacity", (d) => {
      if (!dimming) return 0.5;
      const s = d.source.id ?? d.source;
      const t = d.target.id ?? d.target;
      if (focus.has(s) && focus.has(t)) return 0.95;
      return focus.has(s) || focus.has(t) ? 0.5 : 0.06;
    });

    labelSel.attr("opacity", (d) => (!dimming ? 1 : near.has(d.id) ? 1 : 0.12));
  }

  function tick() {
    linkSel
      .attr("x1", (d) => d.source.x)
      .attr("y1", (d) => d.source.y)
      .attr("x2", (d) => d.target.x)
      .attr("y2", (d) => d.target.y);
    nodeSel.attr("cx", (d) => d.x).attr("cy", (d) => d.y);
    labelSel.attr("x", (d) => d.x).attr("y", (d) => d.y - radius(d.weight) - 4);
  }

  /* ---- tooltip ---- */
  const pct = (v) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
  const dec = (v, d = 2) => (v == null ? "—" : Number(v).toFixed(d));

  function nodeTip(d) {
    const picked = opts.itemCounts ? `<dt>Times picked</dt><dd>${dec(d.weight, 0)}</dd>` : "";
    return `<b>${escapeHtml(d.name)}</b>
      <dl>
        ${graph.hasCategories ? `<dt>Category</dt><dd>${escapeHtml(d.category || "Not categorized")}</dd>` : ""}
        ${picked}
        <dt>Linked products</dt><dd>${d.degree}</dd>
      </dl>
    `;
  }

  function linkTip(d) {
    const s = d.source.name ?? d.source;
    const t = d.target.name ?? d.target;
    const mismatch = d.strength === "Weak" && d.lift >= 1.5;
    return `<b>${escapeHtml(s)} ↔ ${escapeHtml(t)}</b>
      <dl>
        <dt>Suggestion</dt><dd>${escapeHtml(recommendationLabel(d.strength))}</dd>
        <dt>Popularity</dt><dd>${supportLabel(d.support)}</dd>
        <dt>Reliability</dt><dd>${confidenceLabel(d.confidence)}</dd>
        <dt>Relationship pattern</dt><dd>${liftLabel(d.lift)}</dd>
      </dl>
      ${mismatch ? "<small>Rated weak because popularity or reliability is low, even though these products appear together more often than usual.</small>" : ""}`;
  }

  function showTip(event, html) {
    tip.innerHTML = html;
    tip.style.opacity = "1";
    moveTip(event);
  }
  function moveTip(event) {
    const pad = 14;
    const box = tip.getBoundingClientRect();
    let x = event.clientX + pad;
    let y = event.clientY + pad;
    if (x + box.width > window.innerWidth) x = event.clientX - box.width - pad;
    if (y + box.height > window.innerHeight) y = event.clientY - box.height - pad;
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }
  function hideTip() {
    tip.style.opacity = "0";
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  /* ---- interaction ---- */
  function drag(simulation) {
    return d3
      .drag()
      .on("start", (event, d) => {
        if (!event.active) simulation.alphaTarget(0.25).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
  }

  function togglePin(id) {
    if (pinned.has(id)) pinned.delete(id);
    else pinned.add(id);
    paint();
  }

  svg.on("click", () => {
    if (pinned.size) {
      pinned.clear();
      paint();
    }
  });

  wrap.querySelectorAll("[data-slider] input").forEach((input) => {
    const field = input.closest("[data-slider]");
    const key = field.dataset.slider;
    input.addEventListener("input", () => {
      filters[key] = Number(input.value);
      draw();
    });
  });

  wrap.querySelector("[data-size]")?.addEventListener("change", (event) => {
    filters.maxItemsetSize = Number(event.target.value);
    draw();
  });

  wrap.querySelector("[data-labels]").addEventListener("change", (event) => {
    showLabels = event.target.checked;
    draw();
  });

  wrap.querySelector(".nx-reset").addEventListener("click", () => {
    svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity);
    pinned.clear();
    paint();
  });

  /* ---- responsive ---- */
  const observer = new ResizeObserver(() => {
    const next = host.clientWidth;
    if (!next || Math.abs(next - w) < 8) return;
    w = next;
    svg.attr("viewBox", [0, 0, w, h]);
    sim.force("center", d3.forceCenter(w / 2, h / 2));
    sim.force("x", d3.forceX(w / 2).strength(0.03));
    sim.alpha(0.3).restart();
  });
  observer.observe(host);

  draw();

  /* ---- public API ---- */
  return {
    update(nextRelationships = []) {
      const next = buildGraph(nextRelationships, opts);
      graph.nodes = next.nodes;
      graph.links = next.links;
      sim.nodes(graph.nodes);
      draw();
    },
    /** Spotlight SKUs. Pass a rule's antecedents plus its consequent. */
    highlight(ids) {
      pinned = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String));
      paint();
      focusOn(pinned);
    },
    clearHighlight() {
      pinned.clear();
      paint();
    },
    destroy() {
      observer.disconnect();
      sim.stop();
      tip.remove();
      host.innerHTML = "";
    },
  };

  function focusOn(ids) {
    const targets = nodeSel.data().filter((d) => ids.has(d.id));
    if (!targets.length) return;
    const xs = targets.map((d) => d.x);
    const ys = targets.map((d) => d.y);
    const pad = 90;
    const x0 = Math.min(...xs) - pad;
    const x1 = Math.max(...xs) + pad;
    const y0 = Math.min(...ys) - pad;
    const y1 = Math.max(...ys) + pad;
    const k = Math.min(3, w / (x1 - x0), h / (y1 - y0));
    const tx = w / 2 - (k * (x0 + x1)) / 2;
    const ty = h / 2 - (k * (y0 + y1)) / 2;
    svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
  }
}
import {
  confidenceLabel,
  liftLabel,
  recommendationLabel,
  supportLabel,
} from "../labels.js";
