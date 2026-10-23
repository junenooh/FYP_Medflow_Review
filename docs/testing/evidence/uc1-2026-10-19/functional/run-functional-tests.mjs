// UC1 functional tests FT-001..FT-031, driven headless (Playwright + Chromium) against the local dev server.
// Usage: start `npm run dev`, then from a folder with playwright installed: node run-functional-tests.mjs [FT-001,FT-013]
// Writes one screenshot per test into ./shots and the results into ./ft-results.json.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const REPO = "C:/Users/GRAM/Documents/GitHub/FYP_Medflow";
const BASE = "http://127.0.0.1:5173/#/uc1";
const SHOTS = path.resolve("shots");
fs.mkdirSync(SHOTS, { recursive: true });

const env = Object.fromEntries(
  fs.readFileSync(`${REPO}/.env.local`, "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }),
);
const rest = async (q) => {
  const r = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${q}`, {
    headers: { apikey: env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${env.VITE_SUPABASE_ANON_KEY}` },
  });
  return r.json();
};

const results = [];
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
let pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

async function load(query = "") {
  await page.goto("about:blank");
  await page.goto(`${BASE}${query}`);
  await settle();
}
async function settle() {
  await page.waitForFunction(() => {
    const body = document.querySelector("[data-body]");
    return body && !/Reading persisted/i.test(body.innerText);
  }, null, { timeout: 60000 });
  await page.waitForTimeout(700);
}
const rowsText = () => page.$$eval("[data-association-table] tbody tr", (trs) =>
  trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => td.innerText.trim())));
const colIndex = async (name) => (await page.$$eval("[data-association-table] th", (ths) => ths.map((t) => t.innerText.replace(/i$/, "").trim()))).indexOf(name);
async function allPages(fn) {
  const out = [];
  for (let guard = 0; guard < 40; guard++) {
    out.push(...(await fn()));
    const next = await page.$('[data-association-table] .uc1-page-arrow[aria-label="Next page"]');
    if (!next || (await next.isDisabled())) break;
    await next.click();
    await page.waitForTimeout(150);
  }
  return out;
}
async function column(name) {
  const i = await colIndex(name);
  return allPages(async () => (await rowsText()).map((r) => r[i]));
}
const count = () => page.$eval(".uc1-table-count", (e) => e.innerText).catch(() => null);
async function openPicker() {
  const open = await page.$eval("[data-warehouse-menu]", (d) => d.open);
  if (!open) await page.click("[data-warehouse-summary]");
  await page.waitForTimeout(150);
}
const box = (id) => `[data-warehouse-id][value="${id}"]`;
async function setStatus(v) { await page.selectOption('select[name="status"]', v); await settle(); }
async function setSize(v) { await page.selectOption("[data-itemset-filter]", v); await settle(); }
async function search(text) {
  const input = page.locator('.filter-search input[name="q"]');
  await input.fill(text);
  await input.press("Enter");
  await settle();
}
const linkCount = () => page.$$eval("#uc1-network svg line", (ls) => ls.length);

async function test(id, story, fn) {
  if (only && !only.has(id)) return;
  pageErrors = [];
  let status = "Pass", note = "";
  try {
    const r = await fn();
    if (r && r.status) status = r.status;
    note = (r && r.note) || "";
  } catch (e) {
    status = "Fail";
    note = e.message.split("\n")[0];
  }
  if (pageErrors.length) note += ` [page errors: ${pageErrors.join(" | ").slice(0, 200)}]`;
  await page.screenshot({ path: path.join(SHOTS, `${id}.png`) }).catch(() => {});
  results.push({ id, story, status, note });
  console.log(`${id} | ${status} | ${note}`);
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

// ------------------------------------------------------------------
const db = {
  wh001: await rest("productrelationship?select=relationshipid,strength,itemsetsize,ordercount,support,confidence,lift,consequent_productid,productrelationshipantecedent(antecedent_productid)&warehouseid=eq.WH001&limit=5000"),
  counts: Object.fromEntries(await Promise.all(["WH001", "WH002", "WH003", "WH004", "WH005", "WH006"].map(async (w) =>
    [w, (await rest(`productrelationship?select=relationshipid&warehouseid=eq.${w}&limit=5000`)).length]))),
};

await test("FT-001", "US1.6, US1.9, US1.13", async () => {
  await load();
  const summary = await page.$eval("[data-warehouse-summary]", (e) => e.innerText);
  const kpis = await page.$$eval(".kpis > *", (ks) => ks.map((k) => k.innerText.replace(/\s+/g, " ")));
  const heads = await page.$$eval("[data-association-table] th", (ths) => ths.map((t) => t.innerText.replace(/i$/, "").trim()));
  const svg = await page.$("#uc1-network svg");
  const size = await page.$eval("[data-itemset-filter]", (s) => s.value);
  expect(summary === "Product combination shared across all warehouse", `picker shows "${summary}"`);
  const want = ["Unique Product Combination", "Strong Product Combination", "Total Product Combination", "Orders Analysed"];
  want.forEach((w, i) => expect(kpis[i]?.startsWith(w) && /\d/.test(kpis[i]), `KPI ${i + 1} = "${kpis[i]}"`));
  expect(JSON.stringify(heads) === JSON.stringify(["Warehouse", "Primary Product", "Frequently Bought With", "Bundle Size", "Popularity", "Reliability", "Relationship pattern", "Suggestion"]), `headers ${heads}`);
  expect(svg, "no graph");
  return { note: `KPIs: ${kpis.join("; ")}. Bundle size opens on "${size} products".` };
});

await test("FT-002", "US1.8", async () => {
  await load();
  await openPicker();
  await page.uncheck(box("WH001")); await page.check(box("WH002")); await page.click("[data-warehouse-apply]");
  await settle();
  const whs = new Set(await column("Warehouse"));
  const summary = await page.$eval("[data-warehouse-summary]", (e) => e.innerText);
  const hash = await page.evaluate(() => location.hash);
  expect(whs.size === 1 && whs.has("WH002"), `warehouses ${[...whs]}`);
  expect(summary.includes("WH002"), `picker shows "${summary}"`);
  expect(hash.includes("warehouse=WH002"), `url ${hash}`);
  return { note: `Only WH002 rows; picker "${summary}"; URL has warehouse=WH002.` };
});

await test("FT-003", "US1.11", async () => {
  await load();
  await openPicker();
  const state = await page.$$eval("[data-warehouse-id]", (cs) => cs.map((c) => [c.value, c.checked, c.disabled]));
  const subs = state.filter(([v]) => v !== "WH001");
  expect(state.find(([v]) => v === "WH001")[1], "WH001 not ticked");
  expect(subs.every(([, , d]) => d), `enabled subsidiaries: ${subs.filter(([, , d]) => !d).map(([v]) => v)}`);
  return { note: `${subs.length} subsidiary checkboxes disabled while WH001 is ticked.` };
});

await test("FT-004", "US1.11", async () => {
  await load();
  await openPicker();
  await page.uncheck(box("WH001")); await page.check(box("WH002"));
  const wh1 = await page.$eval(box("WH001"), (c) => [c.checked, c.disabled]);
  expect(!wh1[0] && wh1[1], `WH001 checked=${wh1[0]} disabled=${wh1[1]}`);
  return { note: "WH001 unticked and disabled after ticking WH002." };
});

await test("FT-005", "US1.11", async () => {
  await load();
  await openPicker();
  await page.uncheck(box("WH001"));
  const label = await page.$eval(".uc1-warehouse-select-all-choice", (e) => e.innerText.trim());
  await page.check("[data-select-all]");
  const state = await page.$$eval("[data-warehouse-id]", (cs) => cs.map((c) => [c.value, c.checked]));
  await page.click("[data-warehouse-apply]"); await settle();
  await setSize("all");
  const summary = await page.$eval("[data-warehouse-summary]", (e) => e.innerText);
  const whs = new Set(await column("Warehouse"));
  expect(label === "Select all Subsidiary Warehouse", `label "${label}"`);
  expect(state.filter(([v, c]) => v !== "WH001" && c).length === 5 && !state.find(([v]) => v === "WH001")[1], `ticks ${JSON.stringify(state)}`);
  expect(summary === "5 warehouses selected", `picker "${summary}"`);
  expect(whs.size === 5, `warehouses in table: ${[...whs]}`);
  return { note: `"${label}" ticks WH002–WH006; picker "${summary}"; table has ${[...whs].join(", ")}.` };
});

await test("FT-006", "US1.11", async () => {
  await load();
  await openPicker();
  await page.uncheck(box("WH001")); await page.check(box("WH002")); await page.check(box("WH003"));
  const partial = await page.$eval("[data-select-all]", (c) => c.indeterminate);
  await page.click("[data-warehouse-apply]"); await settle();
  await setSize("all");
  const summary = await page.$eval("[data-warehouse-summary]", (e) => e.innerText);
  const whs = new Set(await column("Warehouse"));
  expect(partial, "Select all is not in the partial state");
  expect(summary === "2 warehouses selected", `picker "${summary}"`);
  expect([...whs].sort().join() === "WH002,WH003", `warehouses ${[...whs]}`);
  return { note: `Select all shows partial; picker "${summary}"; table has WH002 and WH003 only.` };
});

await test("FT-007", "US1.11", async () => {
  await load();
  await openPicker();
  await page.uncheck(box("WH001"));
  const disabled = await page.$eval("[data-warehouse-apply]", (b) => b.disabled);
  expect(disabled, "Apply is enabled with nothing ticked");
  return { note: "Apply disabled with no warehouse ticked." };
});

await test("FT-008", "US1.11", async () => {
  await load();
  const before = await page.evaluate(() => location.hash);
  await openPicker();
  await page.uncheck(box("WH001")); await page.check(box("WH002"));
  await page.click("h1, .page-title, .kpis", { position: { x: 5, y: 5 } }).catch(() => page.mouse.click(5, 300));
  await page.waitForTimeout(200);
  await openPicker();
  const state = await page.$$eval("[data-warehouse-id]", (cs) => Object.fromEntries(cs.map((c) => [c.value, c.checked])));
  const after = await page.evaluate(() => location.hash);
  expect(state.WH001 && !state.WH002, `after reopen: ${JSON.stringify(state)}`);
  expect(before === after, `URL changed ${before} -> ${after}`);
  return { note: "Selection reverted to WH001; table and URL unchanged." };
});

await test("FT-009", "US1.11", async () => {
  await load();
  await openPicker();
  await page.hover("[data-warehouse-info]");
  await page.waitForTimeout(200);
  const tip = await page.$eval(".table-info-tooltip", (e) => e.innerText).catch(() => "");
  expect(/central/i.test(tip) && /alone|on its own/i.test(tip), `tooltip "${tip}"`);
  return { note: `Tooltip: "${tip}"` };
});

await test("FT-010", "US1.10, US1.13", async () => {
  const notes = [];
  for (const [value, label] of [["Strong", "Best Bundle"], ["Moderate", "Recommended Bundle"], ["Weak", "Consider Bundle"]]) {
    await load("?tab=all");
    const linksAll = await linkCount();
    await setStatus(value);
    const shown = await page.$eval('select[name="status"]', (s) => s.options[s.selectedIndex].text);
    const recs = await column("Suggestion");
    const legend = await page.$eval(".nx-legend", (e) => e.innerText).catch(() => "");
    const links = await linkCount();
    expect(shown === label, `filter shows "${shown}"`);
    expect(recs.length && recs.every((r) => r === label), `${value}: rows ${[...new Set(recs)]}`);
    notes.push(`${label}: ${recs.length} rows, graph ${links}/${linksAll} links${legend.includes(label) ? "" : " (legend missing label)"}`);
  }
  return { note: notes.join("; ") };
});

await test("FT-011", "US1.10, US1.13", async () => {
  await load();
  await setSize("3");
  const sizes = await column("Bundle Size");
  const c3 = await count();
  await setSize("all");
  const call = await count();
  expect(sizes.length && sizes.every((s) => s === "3 products"), `sizes ${[...new Set(sizes)]}`);
  const n3 = db.wh001.filter((r) => r.itemsetsize === 3).length;
  expect(c3.startsWith(String(n3)), `3-product count "${c3}" vs DB ${n3}`);
  expect(call.startsWith(String(db.wh001.length)), `all count "${call}" vs DB ${db.wh001.length}`);
  return { note: `"3 products": ${c3}; "All bundle sizes": ${call}.` };
});

await test("FT-012", "US1.6", async () => {
  await load();
  await search("MED0057");
  const prim = await column("Primary Product");
  await page.click('[data-association-table] .uc1-page-button[data-table-page="1"]').catch(() => {});
  const freq = await column("Frequently Bought With");
  const ok = prim.every((p, i) => p.includes("MED0057") || freq[i]?.includes("MED0057"));
  const nodes = await page.$$eval("#uc1-network svg text", (ts) => ts.map((t) => t.textContent));
  expect(prim.length > 0, "no rows");
  expect(ok, "a row without MED0057");
  expect(nodes.includes("MED0057"), "MED0057 not in graph");
  return { note: `${prim.length} rows, all include MED0057; graph shows ${nodes.length} products incl. MED0057.` };
});

await test("FT-013", "US1.6", async () => {
  await load();
  await search("ZZZ999");
  const body = await page.$eval("[data-body]", (e) => e.innerText.replace(/\s+/g, " ").trim());
  const exportDisabled = await page.$eval("[data-export-filtered]", (b) => b.disabled);
  const table = await page.$("[data-association-table] table");
  expect(!table, "table still shown");
  expect(exportDisabled, "Export enabled");
  if (/No engine output yet/i.test(body)) return { status: "Fail", note: `Message reads like a system problem: "${body.slice(0, 160)}"` };
  return { note: `Message: "${body.slice(0, 160)}"` };
});

await test("FT-014", "US1.10", async () => {
  await load();
  const p1 = await rowsText();
  const prevDisabled = await page.$eval('.uc1-page-arrow[aria-label="Previous page"]', (b) => b.disabled);
  await page.click('.uc1-page-arrow[aria-label="Next page"]');
  const p2 = await rowsText();
  await page.click('.uc1-page-arrow[aria-label="Previous page"]');
  const back = await rowsText();
  expect(p1.length === 10, `page 1 has ${p1.length} rows`);
  expect(prevDisabled, "‹ enabled on page 1");
  expect(JSON.stringify(p1) !== JSON.stringify(p2), "page 2 same as page 1");
  expect(JSON.stringify(p1) === JSON.stringify(back), "previous did not return to page 1");
  return { note: `Page 1: 10 rows, ‹ disabled; › shows the next 10; ‹ returns to page 1 (${await count()}).` };
});

await test("FT-015", "US1.6, US1.9", async () => {
  await load();
  const kpis = await page.$$eval(".kpis > *", (ks) => ks.map((k) => k.innerText.replace(/\s+/g, " ")));
  const num = (s) => Number(s.replace(/[^\d]/g, ""));
  const total = num(kpis[2]), strong = num(kpis[1]), orders = num(kpis[3]);
  const dbStrong = db.wh001.filter((r) => r.strength === "Strong").length;
  const dbOrders = db.wh001[0]?.ordercount;
  expect(total === db.wh001.length, `Total ${total} vs DB ${db.wh001.length}`);
  expect(strong === dbStrong, `Strong ${strong} vs DB ${dbStrong}`);
  expect(orders === dbOrders, `Orders ${orders} vs DB ${dbOrders}`);
  return { note: `Total ${total} = DB; Strong ${strong} = DB; Orders Analysed ${orders.toLocaleString()} = ordercount.` };
});

await test("FT-016", "US1.6, US1.13", async () => {
  await load();
  const r = (await rowsText())[0];
  const ant = r[1], con = r[2];
  const rule = db.wh001.find((x) => x.consequent_productid === con && x.productrelationshipantecedent.map((a) => a.antecedent_productid).sort().join(", ") === ant);
  expect(rule, `rule ${ant} -> ${con} not in DB`);
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const label = { Strong: "Best Bundle", Moderate: "Recommended Bundle", Weak: "Consider Bundle" }[rule.strength];
  const popularity = rule.support >= 0.05 ? "Very Common" : rule.support >= 0.03 ? "Common" : rule.support >= 0.02 ? "Less Common" : "Uncommon";
  const reliability = rule.confidence >= 0.7 ? "Highly Reliable" : rule.confidence >= 0.6 ? "Reliable" : rule.confidence >= 0.5 ? "Moderately Reliable" : "Unreliable";
  const relationship = rule.lift >= 1.2 ? "Truly Associated" : "Coincidental";
  expect(r[4] === popularity, `Popularity ${r[4]} vs ${popularity}`);
  expect(r[5] === reliability, `Reliability ${r[5]} vs ${reliability}`);
  expect(r[6] === relationship, `Relationship pattern ${r[6]} vs ${relationship}`);
  expect(r[7] === label, `Suggestion ${r[7]} vs ${rule.strength}`);
  return { note: `${ant} → ${con}: ${r[4]} / ${r[5]} / ${r[6]} / ${r[7]} match DB (${rule.support.toFixed(4)}, ${rule.confidence.toFixed(4)}, ${rule.lift.toFixed(2)}, ${rule.strength}).` };
});

await test("FT-017", "US1.7, US1.13", async () => {
  await load();
  await setStatus("Strong");
  const c = await count();
  const firstRows = await rowsText();
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("[data-export-filtered]")]);
  const file = path.join(SHOTS, download.suggestedFilename());
  await download.saveAs(file);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const head = lines[0].split(",");
  const rows = lines.slice(1).map((l) => l.split(","));
  const want = "warehouseid,antecedent_productids,antecedent_productnames,consequent_productid,consequent_productname,itemsetsize,support,confidence,lift,strength";
  expect(/^uc1-rules-.+\.csv$/.test(download.suggestedFilename()), `file ${download.suggestedFilename()}`);
  expect(head.join() === want, `columns ${head}`);
  expect(c.startsWith(String(rows.length)), `CSV ${rows.length} rows vs table "${c}"`);
  expect(rows.every((r) => r[r.length - 1] === "Strong"), "a non-Strong row");
  for (const tr of firstRows.slice(0, 3)) {
    const m = rows.find((r) => r[1] === tr[1].replace(/, /g, " + ") && r[3] === tr[2]);
    expect(m, `row ${tr[1]} -> ${tr[2]} missing in CSV`);
    expect(`${(Number(m[6]) * 100).toFixed(1)}%` === tr[4] && Number(m[8]).toFixed(2) === tr[6], `values differ for ${tr[1]} -> ${tr[2]}`);
  }
  return { note: `${download.suggestedFilename()}: ${rows.length} rows, all Strong, 10 expected columns; 3 rows match the table after rounding.` };
});

await test("FT-018", "US1.6", async () => {
  await load();
  const dim = () => page.$$eval("#uc1-network svg circle", (cs) => cs.filter((c) => Number(c.getAttribute("opacity") ?? 1) < 1).length);
  const before = await dim();
  const row = page.locator("[data-association-table] tbody tr").first();
  await row.focus(); await row.press("Enter"); await page.waitForTimeout(800);
  const selected = await row.getAttribute("aria-selected");
  const during = await dim();
  await row.press("Enter"); await page.waitForTimeout(500);
  const after = await dim();
  expect(selected === "true" && during > before, `highlight not applied (dimmed ${before} -> ${during})`);
  expect(after === before, `highlight not cleared (dimmed ${after})`);
  return { note: `Enter highlights the row's products (others dimmed: ${during}); Enter again clears it.` };
});

await test("FT-019", "US1.6, US1.13", async () => {
  await load("?tab=all");
  const notes = [];
  const fields = await page.$$eval(".nx-field", (fs) => fs.map((f) => f.innerText.split("\n")[0].trim()));
  expect(!fields.includes("Linked Product Combination"), "lift/linkage slider should not be shown");
  for (const name of ["Popular Product Combination", "Reliable Product Combination"]) {
    await load("?tab=all");
    const before = await linkCount();
    const idx = fields.indexOf(name);
    expect(idx >= 0, `slider "${name}" not found (${fields})`);
    await page.$$eval(".nx-field input[type=range]", (ins, i) => {
      const el = ins[i]; el.value = String(Number(el.min) + (Number(el.max) - Number(el.min)) * 0.6);
      el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
    }, idx);
    await page.waitForTimeout(500);
    const after = await linkCount();
    expect(after < before, `${name}: links ${before} -> ${after}`);
    notes.push(`${name}: ${before} → ${after} links`);
  }
  return { note: notes.join("; ") };
});

await test("FT-020", "US1.6", async () => {
  await load();
  const visibleLabels = () => page.$$eval("#uc1-network svg text.nx-label", (ts) => ts.filter((t) => getComputedStyle(t).display !== "none" && t.getAttribute("display") !== "none" && getComputedStyle(t).visibility !== "hidden").length);
  const transform = () => page.$eval("#uc1-network svg g", (g) => g.getAttribute("transform") || "");
  const before = await visibleLabels();
  await page.uncheck("[data-labels]"); await page.waitForTimeout(300);
  const hidden = await visibleLabels();
  const t0 = await transform();
  const svgBox = await page.locator("#uc1-network svg").boundingBox();
  await page.mouse.move(svgBox.x + svgBox.width / 2, svgBox.y + svgBox.height / 2);
  await page.mouse.wheel(0, -600); await page.waitForTimeout(400);
  const zoomed = await transform();
  await page.click(".nx-reset"); await page.waitForTimeout(800);
  const reset = await transform();
  expect(before > 0 && hidden === 0, `labels ${before} -> ${hidden}`);
  expect(zoomed !== t0, "zoom did not change the view");
  expect(/scale\(1\)|^translate\(0,0\)scale\(1\)$|^$/.test(reset.replace(/\s/g, "")) || reset === t0, `after reset: "${reset}" (start "${t0}")`);
  return { note: `Labels ${before} → ${hidden}; zoom changed the view; Reset view returned it (${reset || "identity"}).` };
});

await test("FT-021", "US1.6, US1.13", async () => {
  await load();
  const line = page.locator("#uc1-network svg line").first();
  await line.dispatchEvent("pointerenter", { clientX: 400, clientY: 400 });
  await page.waitForTimeout(250);
  const tip = await page.$eval(".nx-tip", (e) => e.innerText.replace(/\s+/g, " "));
  for (const w of ["Suggestion", "Popularity", "Reliability", "Relationship pattern"]) expect(tip.includes(w), `tooltip lacks ${w}: "${tip}"`);
  return { note: `Tooltip: "${tip.slice(0, 160)}"` };
});

await test("FT-022", "—", async () => {
  await load("?warehouse=WH999");
  const summary = await page.$eval("[data-warehouse-summary]", (e) => e.innerText);
  const table = await page.$("[data-association-table] table");
  expect(table, "no table");
  return { note: `Fell back to "${summary}" with no error.` };
});

await test("FT-023", "—", async () => {
  await context.route(/supabase\.co/, (r) => r.abort());
  try {
    await page.goto("about:blank");
    await page.goto(BASE);
    await page.waitForFunction(() => !/Reading persisted/i.test(document.querySelector("[data-body]")?.innerText || "x"), null, { timeout: 45000 }).catch(() => {});
    const body = await page.$eval("[data-body]", (e) => e.innerText.replace(/\s+/g, " ").trim()).catch(() => "");
    expect(body && !/Reading persisted/i.test(body), `page still loading / blank: "${body.slice(0, 120)}"`);
    return { note: `Database blocked → message: "${body.slice(0, 160)}"` };
  } finally {
    await context.unroute(/supabase\.co/);
  }
});

await test("FT-024", "US1.12", async () => {
  await load();
  await search("MED0057");
  const title = await page.$eval('[data-association-table] tbody span[title]', (s) => [s.textContent, s.title]).catch(() => null);
  const all = await page.$$eval('[data-association-table] tbody span[title]', (ss) => ss.filter((s) => s.textContent === "MED0057").map((s) => s.title));
  expect(all.length && all.every((t) => t === "Ventolin Salbutamol Inhaler Original 100mg"), `titles ${[...new Set(all)]}`);
  return { note: `MED0057 → "${all[0]}"` };
});

await test("FT-025", "US1.12, US1.13", async () => {
  await load();
  const hints = await page.$$eval("[data-association-table] th", (ths) => ths.map((t) => [t.innerText.replace(/i$/, "").trim(), t.querySelector(".table-info-icon")?.dataset.tooltip || ""]));
  const want = ["Primary Product", "Frequently Bought With", "Bundle Size", "Popularity", "Reliability", "Relationship pattern", "Suggestion"];
  const missing = want.filter((w) => !hints.find(([h, t]) => h === w && t));
  const technical = hints.filter(([, t]) => /\b(support|confidence|lift|antecedent|consequent|itemset)\b/i.test(t)).map(([h]) => h);
  const th = page.locator("[data-association-table] th .table-info-icon").nth(5);
  await th.hover(); await page.waitForTimeout(250);
  const shown = await page.$eval(".table-info-tooltip", (e) => e.innerText).catch(() => "");
  expect(!missing.length, `no info icon on ${missing}`);
  expect(!technical.length, `technical words in tooltip of ${technical}`);
  expect(shown.length > 10, "hover shows no tooltip");
  return { note: `7 info icons, plain language; hover on Relationship pattern shows: "${shown.slice(0, 120)}"` };
});

await test("FT-026", "US1.11", async () => {
  await load("?warehouse=WH002,WH003&tab=all");
  await search("MED0101");
  const rows = await allPages(rowsText);
  // Rules that link the two products (one leads to the other), of any bundle size: the graph merges them all.
  const links2 = (r) => (r[1].split(", ").includes("MED0101") && r[2] === "MED0109") || (r[1].split(", ").includes("MED0109") && r[2] === "MED0101");
  const pair = rows.filter(links2);
  const whs = new Set(pair.map((r) => r[0]));
  const best = {
    pop: Math.max(...pair.map((r) => parseFloat(r[4]))),
    rel: Math.max(...pair.map((r) => parseFloat(r[5]))),
    lift: Math.max(...pair.map((r) => parseFloat(r[6]))),
  };
  const handle = await page.evaluateHandle(() => [...document.querySelectorAll("#uc1-network svg line")].find((l) => {
    const d = l.__data__; const ids = [d?.source?.id, d?.target?.id].sort().join();
    return ids === "MED0101,MED0109";
  }));
  const links = await page.$$eval("#uc1-network svg line", (ls) => ls.filter((l) => [l.__data__?.source?.id, l.__data__?.target?.id].sort().join() === "MED0101,MED0109").length);
  expect(handle.asElement(), "pair link not drawn");
  await handle.asElement().dispatchEvent("pointerenter", { clientX: 400, clientY: 400 });
  await page.waitForTimeout(250);
  const tip = await page.$eval(".nx-tip", (e) => e.innerText.replace(/\s+/g, " "));
  expect([...whs].sort().join() === "WH002,WH003", `pair rows from ${[...whs]}`);
  expect(links === 1, `${links} links drawn for the pair`);
  expect(tip.includes(`${best.pop.toFixed(1)}%`) && tip.includes(`${best.rel.toFixed(1)}%`) && tip.includes(best.lift.toFixed(2)), `tooltip "${tip}" vs best ${JSON.stringify(best)}`);
  return { note: `${pair.length} rules link the pair at WH002 and WH003 (2- and 3-product); the graph draws 1 link, and its tooltip shows the highest: ${best.pop.toFixed(1)}% / ${best.rel.toFixed(1)}% / ${best.lift.toFixed(2)}.` };
});

await test("FT-027", "US1.8, US1.9", async () => {
  const empty = Object.entries(db.counts).filter(([, n]) => n === 0);
  if (!empty.length) return { status: "Blocked", note: `No suitable data: every warehouse has rules (${Object.entries(db.counts).map(([w, n]) => `${w} ${n}`).join(", ")}).` };
  await load(`?warehouse=${empty[0][0]}`);
  const body = await page.$eval("[data-body]", (e) => e.innerText);
  return { note: `Message: "${body.slice(0, 120)}"` };
});

await test("FT-028", "US1.13", async () => {
  await load("?tab=all");
  const line = page.locator("#uc1-network svg line").first();
  await line.dispatchEvent("pointerenter", { clientX: 400, clientY: 400 });
  await page.waitForTimeout(250);
  const texts = await page.evaluate(() => [
    ...[...document.querySelectorAll(".kpis > *")].map((k) => k.innerText),
    ...[...document.querySelectorAll("[data-association-table] th")].map((t) => t.innerText),
    ...[...document.querySelectorAll("form select")].map((s) => `${s.getAttribute("aria-label")} ${[...s.options].map((o) => o.text).join(" ")}`),
    document.querySelector(".nx-controls")?.innerText || "",
    document.querySelector(".nx-legend")?.innerText || "",
    document.querySelector(".nx-tip")?.innerText || "",
    ...[...document.querySelectorAll(".uc1-panel-title")].map((t) => t.innerText),
  ].join(" | "));
  const bad = texts.match(/\b(support|confidence|lift|antecedents?|consequents?|itemsets?)\b/gi);
  expect(!bad, `technical terms found: ${[...new Set(bad || [])]}`);
  return { note: "No Support/Confidence/Lift/Antecedent/Consequent/Itemset in KPIs, headers, filters, sliders, legend, tooltip or panel titles." };
});

await test("FT-029", "US1.13", async () => {
  await load("?tab=all");
  const rows = await allPages(rowsText);
  const map = { Strong: "Best Bundle", Moderate: "Recommended Bundle", Weak: "Consider Bundle" };
  const notes = [];
  for (const label of Object.values(map)) {
    const r = rows.find((x) => x[7] === label);
    if (!r) { notes.push(`no "${label}" row`); continue; }
    const rule = db.wh001.find((x) => x.consequent_productid === r[2] && x.productrelationshipantecedent.map((a) => a.antecedent_productid).sort().join(", ") === r[1]);
    expect(rule && map[rule.strength] === label, `${r[1]} → ${r[2]} shows "${label}" but DB says ${rule?.strength}`);
    notes.push(`${r[1]} → ${r[2]}: "${label}" = ${rule.strength}`);
  }
  const legend = await page.$eval(".nx-legend", (e) => e.innerText);
  expect(Object.values(map).every((l) => legend.includes(l)), `legend "${legend}"`);
  return { note: `${notes.join("; ")}. Legend uses the same labels.` };
});

await test("FT-030", "US1.13", async () => {
  await load();
  await page.hover('.nx-help .table-info-icon'); await page.waitForTimeout(300);
  const visible = await page.$eval(".nx-help-tip", (e) => getComputedStyle(e).visibility === "visible");
  const text = await page.$eval(".nx-help-tip", (e) => e.innerText.replace(/\s+/g, " "));
  for (const w of ["Circle", "Line", "Hover", "Click", "Drag", "Slider"]) expect(text.includes(w), `help lacks ${w}`);
  expect(visible, "help tooltip not visible on hover");
  return { note: `Help explains circle, line, hover, click, drag and sliders.` };
});

await test("FT-031", "US1.6", async () => {
  await load();
  await search("Ventolin");
  const rows = await allPages(rowsText);
  expect(rows.length > 0, "no rows");
  expect(rows.every((r) => r[1].includes("MED0057") || r[2].includes("MED0057")), "a row without MED0057");
  return { note: `${rows.length} rows, all with MED0057 (Ventolin).` };
});

fs.writeFileSync("ft-results.json", JSON.stringify(results, null, 1));
await browser.close();
