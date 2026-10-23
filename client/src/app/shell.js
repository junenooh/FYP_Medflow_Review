import { renderSidebar, renderTopbar, bindSearchShortcut } from "./sidebar.js";
import { renderDashboard } from "@features/dashboard/index.js";
import { renderTest } from "@features/connection-test/index.js";
import { renderRelationships } from "@features/uc1-relationships/index.js";
import { renderReplenishment } from "@features/uc2-replenishment/index.js";
import { renderLayout } from "@features/uc3-layout/index.js";
import { renderDigitalTwin } from "@features/uc4-digital-twin/index.js";
import { prefetchUc1 } from "@features/uc1-relationships/live-data.js";
import { currentPath } from "@app/router.js";
import { fetchLatestRun } from "@shared/data/engine-outputs.js";

function renderPage(content) {
  const page = currentPath();
  if (page === "/test") return renderTest(content);
  if (page === "/uc1" || page === "/relationships") return renderRelationships(content);
  if (page === "/uc2" || page === "/replenishment") return renderReplenishment(content);
  if (page === "/uc3" || page === "/layout") return renderLayout(content);
  if (page === "/uc4" || page === "/digital-twin") return renderDigitalTwin(content);
  return renderDashboard(content);
}

export function mountAppShell(root) {
  root.classList.add("app-shell");
  root.innerHTML = `
    <header class="topbar" id="topbar"></header>
    <div class="app-body">
      <aside id="sidebar"></aside>
      <main id="content"></main>
    </div>
  `;
  const topbar = root.querySelector("#topbar");
  const sidebar = root.querySelector("#sidebar");
  const content = root.querySelector("#content");
  bindSearchShortcut(topbar);
  let paintGen = 0;

  const paint = async () => {
    const gen = ++paintGen;
    renderSidebar(sidebar);
    renderTopbar(topbar, { runKind: "loading" });
    renderPage(content);
    const run = await fetchLatestRun();
    if (gen !== paintGen) return;
    renderTopbar(topbar, {
      run: run.run,
      runKind: run.ok ? (run.run ? "ok" : "empty") : run.kind,
    });
  };

  window.addEventListener("hashchange", paint);
  paint();
  const startUc1Prefetch = () => {
    void prefetchUc1();
  };
  if ("requestIdleCallback" in window) {
    window.requestIdleCallback(startUc1Prefetch, { timeout: 1500 });
  } else {
    window.setTimeout(startUc1Prefetch, 300);
  }
}
