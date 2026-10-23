import { fetchOverviewCounts } from "@shared/data/engine-outputs.js";
import { FEEDBACK_KINDS } from "@shared/utils/feedback-state.js";
import { renderFeedback, renderKpiRow } from "@shared/components/page-frame.js";

const USE_CASES = [
  {
    href: "#/uc1",
    code: "UC1",
    title: "Product Relationships",
    blurb: "Association rules from persisted productrelationship rows. FP-Growth stays in the engine.",
  },
  {
    href: "#/uc2",
    code: "UC2",
    title: "Replenishment",
    blurb: "(s,S) transfer recommendations from replenishmentrecommendation. No browser ROP math.",
  },
  {
    href: "#/uc3",
    code: "UC3",
    title: "Layout",
    blurb: "Slotting moves on a shared Layout page. Grid and move list first; 3D mounts here later.",
  },
  {
    href: "#/uc4",
    code: "UC4",
    title: "Digital Twin",
    blurb: "Planner accept / adjust / reject frame. Uses the Layout page, not a second app.",
  },
];

export function renderDashboard(root) {
  root.innerHTML = `
    <section>
      ${pageIntro()}
      ${renderKpiRow([
        { label: "SKUs tracked", value: "—", delta: "reading product" },
        { label: "Needs reorder", value: "—", delta: "from replenishmentrecommendation" },
        { label: "Companion pairs", value: "—", delta: "from productrelationship" },
        { label: "Slotting moves", value: "—", delta: "from layoutrecommendation" },
      ])}
      <div class="uc-grid">
        ${USE_CASES.map(
          (uc) => `
          <a class="uc-card" href="${uc.href}">
            <span class="uc-code">${uc.code}</span>
            <h2>${uc.title}</h2>
            <p>${uc.blurb}</p>
          </a>`,
        ).join("")}
      </div>
      <p class="section-label">Loading, empty, permission and data-error</p>
      <p class="page-sub" style="margin-bottom:10px">Same four states on every use-case page. Preview them here, or with the filter on each page.</p>
      <div class="states-grid">
        ${FEEDBACK_KINDS.map((kind) => renderFeedback(kind)).join("")}
      </div>
    </section>
  `;

  loadCounts(root);
}

function pageIntro() {
  return `
    <header class="page-head">
      <div>
        <p class="page-kicker">Overview</p>
        <div class="page-title">Dashboard</div>
        <div class="page-sub">Central warehouse WH001 · one shell for UC1–UC4 · demo width 1280px</div>
      </div>
      <div class="page-actions">
        <a class="btn btn-s" href="#/uc3">Open Layout</a>
        <button class="btn btn-p" type="button" disabled>Run engines</button>
      </div>
    </header>
  `;
}

async function loadCounts(root) {
  const result = await fetchOverviewCounts();
  const kpis = root.querySelector(".kpis");
  if (!kpis) return;
  if (!result.ok) {
    kpis.outerHTML = renderFeedback(result.kind, { detail: result.message, table: "modelrun" });
    return;
  }
  const counts = result.counts;
  kpis.outerHTML = renderKpiRow([
    {
      label: "SKUs tracked",
      value: counts.products,
      delta: "product master",
    },
    {
      label: "Needs reorder",
      value: counts.replenishment,
      delta: "persisted UC2 rows",
      color: counts.replenishment ? "var(--oos)" : undefined,
    },
    {
      label: "Companion pairs",
      value: counts.relationships,
      delta: "persisted UC1 rows",
    },
    {
      label: "Slotting moves",
      value: counts.layout,
      delta: counts.layout ? "SA vs current" : "awaiting layoutrecommendation",
      deltaColor: counts.layout ? "var(--ok)" : undefined,
    },
  ]);
}
