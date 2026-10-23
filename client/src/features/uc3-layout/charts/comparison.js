import * as d3 from "d3";

export function renderComparisonChart(root, metrics) {
  if (!root) return;
  root.innerHTML = "";
  const savedRun = metrics.source === "saved-run";
  const data = [
    { key: "current", label: "Current", value: metrics.current.average, color: "#5f6b72" },
    { key: "recommended", label: "Recommended layout", value: metrics.recommended.average, color: "#d40511" },
  ];
  const width = 760;
  const height = 270;
  // Reserve enough room for both labels. The previous 146px margin clipped
  // "Recommended heuristic" at the edge of the SVG.
  const margin = { top: 28, right: 38, bottom: 46, left: 184 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const svg = d3.select(root).append("svg").attr("class", "comparison-svg").attr("viewBox", `0 0 ${width} ${height}`).attr("role", "img").attr("aria-label", "Demand-weighted access time comparison");
  const g = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);
  const x = d3.scaleLinear().domain([0, d3.max(data, (d) => d.value) * 1.14 || 1]).range([0, plotWidth]);
  const y = d3.scaleBand().domain(data.map((d) => d.key)).range([0, plotHeight]).padding(0.34);

  g.append("g").attr("class", "chart-grid").call(d3.axisBottom(x).ticks(5).tickSize(plotHeight).tickFormat("")).select(".domain").remove();
  g.selectAll("rect").data(data).join("rect").attr("x", 0).attr("y", (d) => y(d.key)).attr("width", (d) => x(d.value)).attr("height", y.bandwidth()).attr("rx", 5).attr("fill", (d) => d.color);
  g.selectAll("text.bar-label").data(data).join("text").attr("class", "bar-label").attr("x", -14).attr("y", (d) => y(d.key) + y.bandwidth() / 2 + 5).attr("text-anchor", "end").text((d) => d.label);
  g.selectAll("text.bar-value").data(data).join("text").attr("class", "bar-value").attr("x", (d) => x(d.value) + 10).attr("y", (d) => y(d.key) + y.bandwidth() / 2 + 5).text((d) => savedRun ? `${(d.value / 3600).toFixed(1)} h/day` : `${d.value.toFixed(1)} s`);
  svg.append("text").attr("class", "chart-axis-title").attr("x", margin.left + plotWidth / 2).attr("y", height - 8).attr("text-anchor", "middle").text(savedRun ? "Saved UC3 run · total daily picker time · lower is better" : "Demand-weighted average access time · lower is better");
}
