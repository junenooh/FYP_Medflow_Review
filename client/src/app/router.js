/** Hash routes: `#/uc3?tab=3d&q=MED001&feedback=empty`. */

export function parseRoute() {
  const hash = window.location.hash || "#/";
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const url = new URL(raw || "/", "https://medflow.local");
  const path = (url.pathname.replace(/\/+$/, "") || "/") ;
  return { path, params: url.searchParams, hash };
}

export function currentPath() {
  return parseRoute().path;
}

export function isActivePath(href) {
  const target = href.replace(/^#/, "") || "/";
  const path = currentPath();
  if (target === "/") return path === "/";
  return path === target;
}

export function setQuery(updates) {
  const { path, params } = parseRoute();
  Object.entries(updates).forEach(([key, value]) => {
    if (value == null || value === "") params.delete(key);
    else params.set(key, String(value));
  });
  const query = params.toString();
  const next = query ? `#${path}?${query}` : `#${path}`;
  if (next !== window.location.hash) window.location.hash = next;
}

export function pageQuery() {
  const { params } = parseRoute();
  return {
    q: params.get("q") || "",
    warehouse: params.get("warehouse") || "",
    zone: params.get("zone") || "",
    status: params.get("status") || "",
    tab: params.get("tab") || "",
    feedback: params.get("feedback") || "",
  };
}
