export function renderKpiChart(root, series = []) {
  if (!root) return;
  root.textContent = series.length ? `${series.length} series` : "";
}
