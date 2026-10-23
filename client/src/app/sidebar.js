import { isActivePath, pageQuery, setQuery } from "@app/router.js";
import dhlLogoUrl from "@brand/dhl-logo.png";
import medflowMarkUrl from "@brand/medflow-mark.svg";
import { escapeAttribute } from "@shared/utils/html.js";
import { mountBell } from "@features/notifications/bell.js";

const ICONS = {
  dashboard: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5F6B72" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>`,
  relationships: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5F6B72" stroke-width="2"><circle cx="5" cy="6" r="2.4"/><circle cx="19" cy="7" r="2.4"/><circle cx="12" cy="18" r="2.4"/><path d="M7 7l3.5 9M17 9l-3.5 7.5"/></svg>`,
  replenishment: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5F6B72" stroke-width="2"><path d="M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8"/></svg>`,
  layout: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5F6B72" stroke-width="2"><rect x="3" y="3" width="18" height="18"/><path d="M9 3v18M15 3v18M3 9h18"/></svg>`,
  twin: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5F6B72" stroke-width="2"><path d="M12 2l9 5v10l-9 5-9-5V7zM12 2v20M3 7l9 5 9-5"/></svg>`,
  test: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#5F6B72" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3 1.2 0 2.4-.1 3.4-.4"/><path d="m17 18 1.5 1.5L22 16"/></svg>`,
};

export const LINKS = [
  { href: "#/", path: "/", label: "Dashboard", icon: ICONS.dashboard },
  { href: "#/uc1", path: "/uc1", label: "Product Relationships", icon: ICONS.relationships },
  { href: "#/uc2", path: "/uc2", label: "Replenishment", icon: ICONS.replenishment },
  { href: "#/uc3", path: "/uc3", label: "Layout", icon: ICONS.layout },
  { href: "#/uc4", path: "/uc4", label: "Digital Twin", icon: ICONS.twin },
  { href: "#/test", path: "/test", label: "Connection test", icon: ICONS.test, system: true },
];

export function renderSidebar(root) {
  root.innerHTML = `
    <div class="sidebar-heading">
      <span class="nav-kicker">Planner workspace</span>
      <span class="sidebar-site">WH001 · Central</span>
    </div>
    <nav aria-label="Use cases">
      ${LINKS.map((link, index) => {
        const active = isActivePath(link.href);
        const code = link.system ? "TEST" : link.path === "/" ? "" : link.path.replace("/", "").toUpperCase();
        const divider = link.system && !LINKS[index - 1]?.system
          ? `<div class="nav-section"><span>System</span></div>`
          : "";
        return `${divider}<a href="${link.href}" class="${active ? "is-active" : ""}" data-path="${link.path}">
          <span class="nav-icon">${link.icon}</span>
          <span class="nav-label">${link.label}</span>
          ${code ? `<span class="nav-code">${code}</span>` : ""}
        </a>`;
      }).join("")}
    </nav>
  `;
}

export function renderTopbar(root, { run = null, runKind = "empty" } = {}) {
  const q = pageQuery();
  const when = run?.generatedate
    ? new Date(run.generatedate).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "—";
  const label =
    {
      loading: "Reading",
      permission: "No access",
      error: "Run failed",
      empty: "No run",
    }[runKind] || (run ? "Run OK" : "No run");
  root.innerHTML = `
    <div class="lockup">
      <span class="dhl-logo-wrap">
        <img class="dhl-logo" src="${dhlLogoUrl}" alt="DHL" />
      </span>
      <span class="lockup-divider"></span>
      <img class="medflow-mark" src="${medflowMarkUrl}" alt="MedFlow medicine capsule mark" />
      <span class="product-lockup">
        <span class="wordmark"><span>Med</span><strong>Flow</strong></span>
        <small>Warehouse intelligence</small>
      </span>
    </div>
    <form class="search" role="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#5F6B72" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.5-4.5"/></svg>
      <input name="q" type="search" placeholder="Search SKU, zone or order" value="${escapeAttribute(q.q)}" aria-label="Search SKU, zone or order" />
      <kbd>⌘K</kbd>
    </form>
    <div class="topbar-right">
      <span class="runchip" data-state="${runKind}"><i></i>${label}<em>${when}</em></span>
      <span class="notif-slot" data-notif-slot></span>
      <span class="topbar-separator"></span>
      <span class="user">
        <span class="avatar">DO</span>
        <span class="user-copy"><span class="uname">DHL Ops</span><small>Ops Manager</small></span>
        <svg class="user-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg>
      </span>
    </div>
  `;

  mountBell(root.querySelector("[data-notif-slot]"));

  const form = root.querySelector("form.search");
  const input = form.querySelector("input");
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    setQuery({ q: input.value.trim() });
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      setQuery({ q: input.value.trim() });
    }
  });
}

export function bindSearchShortcut(root) {
  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      root.querySelector(".search input")?.focus();
    }
  });
}
