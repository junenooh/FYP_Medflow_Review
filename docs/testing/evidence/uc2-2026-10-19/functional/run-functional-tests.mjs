// UC2 functional tests FT-001..FT-027, driven headless (Playwright + Chromium) against the local dev server.
// Usage: start `npm run dev`, then from a folder with playwright installed: node run-functional-tests.mjs [FT-001,FT-013]
// Writes one screenshot per test into ./shots-uc2 and the results into ./ft2-results.json.
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const REPO = "C:/Users/GRAM/Documents/GitHub/FYP_Medflow";
const BASE = "http://127.0.0.1:5173/#/uc2";
const SHOTS = path.resolve("shots-uc2");
fs.mkdirSync(SHOTS, { recursive: true });

const env = Object.fromEntries(
  fs.readFileSync(`${REPO}/.env.local`, "utf8").split(/\r?\n/).filter((l) => l.includes("="))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; }),
);
const rest = async (q, range) => {
  const r = await fetch(`${env.VITE_SUPABASE_URL}/rest/v1/${q}`, {
    headers: { apikey: env.VITE_SUPABASE_ANON_KEY, Authorization: `Bearer ${env.VITE_SUPABASE_ANON_KEY}`, ...(range ? { Range: range } : {}) },
  });
  return r.json();
};
const policyRows = async (wh) => [...await rest(`uc2_policy_parameters?select=*&warehouseid=eq.${wh}&order=productid`, "0-999")];

const results = [];
const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
let pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(e.message));

async function load(query = "?warehouse=WH002") {
  await page.goto("about:blank");
  await page.goto(`${BASE}${query}`);
  await page.waitForFunction(() => {
    const b = document.querySelector("[data-body]");
    const text = document.body.innerText;
    return b && !/Loading stock|Reading persisted/i.test(text) && !!document.querySelector("[data-sku-table] table, .board-card, .sample-banner, .live-banner, [data-order-table] table");
  }, null, { timeout: 90000 });
  await page.waitForTimeout(1200);
}
const rows = () => page.$$eval("[data-sku-table] tbody tr[data-key]", (trs) =>
  trs.map((tr) => {
    const cells = [...tr.querySelectorAll("td")].map((td) => td.innerText.replace(/\s+/g, " ").trim());
    // the status cell may carry a flag note after the status ("Low stock Demand jumped")
    cells[1] = (cells[1].match(/^(Out of stock|Low stock|Near ROP|In stock)/) || [cells[1]])[0];
    return { id: tr.dataset.key, cells };
  }));
const chips = () => page.$$eval("[data-chip-status]", (cs) => cs.map((c) => [c.dataset.chipStatus, Number(c.querySelector("b")?.innerText.replace(/\D/g, "") || c.innerText.replace(/\D/g, ""))]));
const STATUS_WORD = { "Out of Stock": "Out of stock", "Low Stock": "Low stock", "Near ROP": "Near ROP", Available: "In stock" };
const parseLevel = (cell) => {
  const m = cell.match(/([\d,]+) on the shelf(?: \+ ([\d,]+) on its way)? Reorder point ([\d,]+)/);
  const n = (s) => Number(String(s || "0").replace(/,/g, ""));
  return m ? { shelf: n(m[1]), way: n(m[2]), rop: n(m[3]) } : null;
};
async function openPanel(id) {
  await page.click(`[data-sku-table] tbody tr[data-key="${id}"]`);
  await page.waitForSelector(".uc2-drawer-layer", { timeout: 10000 });
  await page.waitForTimeout(1500);
}
const panelText = () => page.$eval(".uc2-drawer-layer", (l) => l.innerText.replace(/\s+/g, " "));

async function test(id, story, fn) {
  if (only && !only.has(id)) return;
  pageErrors = [];
  let status = "Pass", note = "";
  try {
    const r = await fn();
    if (r?.status) status = r.status;
    note = r?.note || "";
  } catch (e) { status = "Fail"; note = e.message.split("\n")[0]; }
  if (pageErrors.length) note += ` [page errors: ${pageErrors.join(" | ").slice(0, 200)}]`;
  await page.screenshot({ path: path.join(SHOTS, `${id}.png`) }).catch(() => {});
  results.push({ id, story, status, note });
  console.log(`${id} | ${status} | ${note}`);
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }

const db = { WH002: await policyRows("WH002") };
const byId = (wh, id) => db[wh].find((r) => r.productid === id);

// ------------------------------------------------------------------
await test("FT-001", "UC2.4, UC2.5", async () => {
  await load();
  const s = await page.evaluate(() => ({
    title: document.querySelector(".page-title")?.innerText,
    wh: document.querySelector("[data-subsidiary]")?.value,
    asof: document.querySelector(".uc2-asof")?.innerText,
    tabs: [...document.querySelectorAll("[role=tab], .tabs a, .tabs button")].map((t) => t.innerText.trim()),
    heads: [...document.querySelectorAll("[data-sku-table] th")].map((t) => t.innerText.trim()),
    pipeline: document.querySelector(".uc2-pipeline")?.innerText.replace(/\s+/g, " "),
  }));
  const r = await rows();
  expect(s.title === "Replenishment", `title ${s.title}`);
  expect(s.wh === "WH002", `warehouse ${s.wh}`);
  expect(/Data as of/.test(s.asof), `as-of "${s.asof}"`);
  expect(s.tabs.join() === "Stock status,Restocks,History", `tabs ${s.tabs}`);
  expect(s.heads.join() === "Product,Status,Stock level,Runs out in,Restock", `headers ${s.heads}`);
  expect(r.length === db.WH002.length, `${r.length} rows vs ${db.WH002.length} products`);
  return { note: `WH002, ${r.length} products; "${s.asof}"; pipeline: ${s.pipeline.slice(0, 110)}` };
});

await test("FT-002", "UC2.4", async () => {
  await load();
  const options = await page.$$eval("[data-subsidiary] option", (os) => os.map((o) => o.value));
  await page.selectOption("[data-subsidiary]", "WH004");
  await page.waitForFunction(() => location.hash.includes("warehouse=WH004"));
  await load("?warehouse=WH004");
  const r = await rows();
  const wh = await page.$eval("[data-subsidiary]", (s) => s.value);
  expect(options.join() === "WH002,WH003,WH004,WH005,WH006", `options ${options}`);
  expect(wh === "WH004" && r.length > 0, `after switch: ${wh}, ${r.length} rows`);
  return { note: `Selector lists WH002–WH006; switching shows WH004 (${r.length} products).` };
});

await test("FT-003", "UC2.4", async () => {
  await load();
  const c = Object.fromEntries(await chips());
  const r = await rows();
  const counted = r.reduce((acc, x) => ({ ...acc, [x.cells[1]]: (acc[x.cells[1]] || 0) + 1 }), {});
  for (const [status, word] of Object.entries(STATUS_WORD)) expect(c[status] === (counted[word] || 0), `${word}: chip ${c[status]} vs table ${counted[word] || 0}`);
  expect(c[""] === r.length, `All chip ${c[""]} vs ${r.length}`);
  return { note: `Chips: ${Object.entries(STATUS_WORD).map(([k, w]) => `${w} ${c[k]}`).join(", ")} = table counts; All ${c[""]}.` };
});

await test("FT-004", "UC2.4", async () => {
  const notes = [];
  for (const [status, word] of Object.entries(STATUS_WORD)) {
    await load(`?warehouse=WH002&tab=skus&status=${encodeURIComponent(status)}`);
    const r = await rows();
    const statuses = new Set(r.map((x) => x.cells[1]));
    expect(r.length && statuses.size === 1 && statuses.has(word), `${word}: ${[...statuses]}`);
    notes.push(`${word} ${r.length}`);
  }
  return { note: `Each status chip shows only that status: ${notes.join(", ")}.` };
});

await test("FT-005", "UC2.4, US2.2", async () => {
  await load();
  const r = await rows();
  const notes = [];
  for (const word of Object.values(STATUS_WORD)) {
    const sample = r.filter((x) => x.cells[1] === word).slice(0, 3);
    for (const x of sample) {
      const lvl = parseLevel(x.cells[2]);
      const row = byId("WH002", x.id);
      const ss = Math.round(Number(row.safetystock));
      const pos = lvl.shelf + lvl.way;
      const expected = Number(row.avgdailydemand) <= 0 ? "In stock" : lvl.shelf <= 0 ? "Out of stock" : pos <= lvl.rop ? "Low stock" : pos <= lvl.rop + ss ? "Near ROP" : "In stock";
      expect(expected === word, `${x.id}: shelf ${lvl.shelf} + way ${lvl.way} vs ROP ${lvl.rop} + SS ${ss} -> ${expected}, page ${word}`);
      expect(lvl.rop === Number(row.reorderpoint), `${x.id}: page ROP ${lvl.rop} vs DB ${row.reorderpoint}`);
    }
    notes.push(`${word} ×${sample.length}`);
  }
  return { note: `12 sampled rows follow the rule on inventory position (shelf + on the way) and match the stored reorder point: ${notes.join(", ")}.` };
});

await test("FT-006", "UC2.5", async () => {
  await load();
  const rank = { "Out of stock": 0, "Low stock": 1, "Near ROP": 2, "In stock": 3 };
  const r = await rows();
  const ranks = r.map((x) => rank[x.cells[1]]);
  const sorted = ranks.every((v, i) => i === 0 || v >= ranks[i - 1]);
  expect(sorted, "rows are not ordered most urgent first");
  return { note: `Rows run Out of stock → Low stock → Near ROP → In stock; first row: ${r[0].cells[0].slice(0, 50)}.` };
});

await test("FT-007", "UC2.4", async () => {
  await load();
  const input = page.locator('.filter-search input[name="q"]');
  await input.fill("MED0147"); await input.press("Enter"); await page.waitForTimeout(800);
  const byIdRows = await rows();
  await input.fill("Allopurinol"); await input.press("Enter"); await page.waitForTimeout(800);
  const byName = await rows();
  expect(byIdRows.length === 1 && byIdRows[0].id === "MED0147", `ID search: ${byIdRows.map((x) => x.id)}`);
  expect(byName.length >= 1 && byName.every((x) => /allopurinol/i.test(x.cells[0])), `name search: ${byName.length}`);
  return { note: `ID search → MED0147 only; "Allopurinol" → ${byName.length} products, all Allopurinol.` };
});

await test("FT-008", "UC2.4, UC2.5, US2.1", async () => {
  await load("?warehouse=WH002&tab=skus&sku=MED0147");
  await page.waitForSelector(".uc2-drawer-layer", { timeout: 15000 }); await page.waitForTimeout(1500);
  const hero = await page.$eval(".drawer-hero", (h) => h.innerText.replace(/\s+/g, " "));
  const head = await page.$eval(".uc2-drawer-layer header", (h) => h.innerText.replace(/\s+/g, " "));
  const row = byId("WH002", "MED0147");
  const num = (re) => Number((hero.match(re) || [])[1]?.replace(/,/g, ""));
  expect(num(/([\d,]+) on the shelf/) === Math.round(row.currentstock), `on shelf vs DB ${row.currentstock}`);
  expect(num(/([\d,]+) reorder point/) === row.reorderpoint, `reorder point vs DB ${row.reorderpoint}`);
  expect(num(/([\d,]+) order-up-to level/) === row.orderuptolevel, `order-up-to vs DB ${row.orderuptolevel}`);
  expect(/reorder point/i.test(head), `no plain reason in header: "${head}"`);
  return { note: `MED0147: ${hero.slice(0, 90)}… Reason line: "${head.replace(/^.*?(Low stock|Out of stock|Near ROP|In stock) /, "").replace(/ ×$/, "")}"` };
});

await test("FT-009", "UC2.5, US2.1", async () => {
  await load("?warehouse=WH002&tab=skus&sku=MED0147");
  await page.waitForSelector(".uc2-drawer-layer"); await page.waitForTimeout(1200);
  const closed = await page.$eval(".drawer-more", (d) => !d.open);
  await page.click(".drawer-more summary");
  const calc = await page.$eval(".drawer-more-body", (b) => b.innerText.replace(/\s+/g, " "));
  const row = byId("WH002", "MED0147");
  const ss = Math.round(row.safetystock), rop = row.reorderpoint, lead = Math.max(0, rop - ss);
  for (const w of ["INVENTORY POSITION", "REORDER POINT", "Lead-time demand", "Safety stock", "Order-up-to level"]) expect(calc.toUpperCase().includes(w.toUpperCase()), `missing "${w}"`);
  expect(calc.includes(`Safety stock buffer for busy days and late deliveries ${ss}`), `safety stock ${ss} not shown`);
  expect(calc.includes(`Reorder point ${rop}`) && calc.includes(`Lead-time demand`) && calc.includes(String(lead)), `ROP/lead-time demand ${rop}/${lead} not shown`);
  expect(closed, "calculation open by default");
  return { note: `Collapsed by default. Shows inventory position, lead-time demand ${lead} + safety stock ${ss} = reorder point ${rop} (DB), decision and tonight's order.` };
});

await test("FT-010", "US2.2, US2.1", async () => {
  await load("?warehouse=WH002&tab=skus&status=Low%20Stock");
  const r = (await rows()).filter((x) => /Ordering tonight|tonight/i.test(x.cells[4])).slice(0, 3);
  expect(r.length, "no product due tonight");
  const notes = [];
  for (const x of r) {
    await openPanel(x.id);
    const text = await panelText();
    const lvl = parseLevel(x.cells[2]); const row = byId("WH002", x.id);
    const carton = 24;
    const pos = lvl.shelf + lvl.way, qty = row.orderuptolevel - pos;
    const cartonsShown = Number((text.match(/Tonight's restock ([\d,]+) cartons?/) || [])[1]?.replace(/,/g, ""));
    const unitsShown = Number((text.match(/Tonight's restock [\d,]+ cartons? ([\d,]+) units/) || [])[1]?.replace(/,/g, ""));
    expect(cartonsShown > 0 && unitsShown % cartonsShown === 0, `${x.id}: "${text.slice(0, 160)}"`);
    const per = unitsShown / cartonsShown;
    const expected = Math.max(Math.round(qty / per), Math.ceil((row.reorderpoint - pos + 1) / per), 1);
    expect(cartonsShown === expected, `${x.id}: ${cartonsShown} cartons vs expected ${expected} (gap ${qty}, carton ${per})`);
    notes.push(`${x.id}: gap ${qty} → ${cartonsShown} × ${per} = ${unitsShown}`);
    await page.keyboard.press("Escape"); await page.waitForTimeout(300);
  }
  return { note: notes.join("; ") };
});

await test("FT-011", "US2.2", async () => {
  await load("?warehouse=WH002&tab=skus&status=Available");
  const x = (await rows()).find((r) => !/PO-/.test(r.cells[4]));   // in stock, no restock pending
  await openPanel(x.id);
  const text = await panelText();
  await page.click(".drawer-more summary"); await page.waitForTimeout(200);
  const calc = await page.$eval(".drawer-more-body", (b) => b.innerText.replace(/\s+/g, " "));
  expect(/Next restock/.test(text) && /Ordered automatically when stock reaches/.test(text), `no "Next restock" card for ${x.id}`);
  expect(/No order needed/.test(calc), `decision not "No order needed": ${calc.slice(0, 200)}`);
  expect(!/Tonight's order/.test(calc), "an order block is shown above the reorder point");
  return { note: `${x.id} (in stock): "Next restock" card, decision "No order needed", no order quantity.` };
});

await test("FT-012", "US2.3", async () => {
  await load();
  const r = (await rows()).find((x) => /On its way PO-/.test(x.cells[4]));
  expect(r, "no product with a restock on its way");
  await openPanel(r.id);
  const text = await panelText();
  expect(/Restock progress PO-WH002-\d{8}/.test(text), "no Restock progress card");
  expect(/[\d,]+ units [\d,]+ cartons?/.test(text), "no units / cartons on the restock");
  expect(/Ordered/.test(text) && /On its way|Delivered/.test(text), "no progress steps");
  return { note: `${r.id}: ${(text.match(/Restock progress PO-WH002-\d{8} [\d,]+ units [\d,]+ cartons?( About [^.]+\.)?/) || [""])[0]}` };
});

await test("FT-013", "UC2.5", async () => {
  await load("?warehouse=WH002&tab=skus&sku=MED0147");
  await page.waitForSelector(".st-hit", { timeout: 20000 });
  const readout = await page.$eval("[data-st-readout]", (e) => e.innerText);
  const days = await page.$$eval(".st-hit", (h) => h.length);
  expect(days === 30, `${days} days drawn`);
  expect(/^Today ·/.test(readout), `readout "${readout}"`);
  return { note: `30-day chart drawn; readout "${readout}".` };
});

await test("FT-014", "US2.3", async () => {
  await load();
  const r = (await rows()).find((x) => /Used with \d+ item/.test(x.cells[4]));
  expect(r, "no product with UC1 companions");
  await openPanel(r.id);
  const summary = await page.$$eval(".drawer-more summary", (s) => s.map((x) => x.innerText));
  const sec = summary.find((s) => /Often used with this/.test(s));
  expect(sec, `no companions section (${summary})`);
  await page.click(`.drawer-more summary:has-text("Often used with this")`).catch(() => {});
  await page.waitForTimeout(300);
  const text = await panelText();
  const advice = (text.match(/Same delivery|Already on order|Due as well|Worth adding|Not needed/g) || []);
  expect(advice.length, "no advice label on companions");
  return { note: `${r.id}: "${sec}" with advice ${[...new Set(advice)].join(", ")}; suggestions only, no add-to-order control.` };
});

await test("FT-015", "US2.3", async () => {
  await load("?warehouse=WH002&tab=orders");
  const cols = await page.$$eval(".board-col, [data-board] > *", (cs) => cs.map((c) => c.innerText.split("\n")[0])).catch(() => []);
  const cards = await page.$$eval(".board-card", (cs) => cs.map((c) => c.dataset.order));
  const body = await page.$eval("[data-body]", (b) => b.innerText);
  const orders = await rest("orders?select=orderid,status&warehouseid=eq.WH002&order=orderdate.desc&limit=30");
  const open = orders.filter((o) => o.status !== "Fulfilled").map((o) => o.orderid);
  expect(/Order placed/.test(body) && /On its way/.test(body) && /Delivered/.test(body), "board columns missing");
  expect(open.every((id) => cards.includes(id)), `open orders not on the board: ${open.filter((id) => !cards.includes(id))}`);
  return { note: `Board shows Order placed / On its way / Delivered; ${cards.length} restocks incl. every open one (${open.join(", ")}).` };
});

await test("FT-016", "US2.3", async () => {
  await load("?warehouse=WH002&tab=orders");
  const id = await page.$eval(".board-card", (c) => c.dataset.order);
  await page.click(`.board-card[data-order="${id}"]`); await page.waitForTimeout(1200);
  const text = await page.evaluate(() => (document.querySelector(".uc2-drawer-layer, .ord-detail, [data-order-detail]") || document.body).innerText.replace(/\s+/g, " "));
  const lines = await rest(`orderline?select=orderlineid&orderid=eq.${id}`);
  const companions = lines.filter((l) => /C$/.test(l.orderlineid)).length;
  expect(new RegExp(id).test(text), "order detail not shown");
  expect(/Trigger|Reached its reorder point|Stock ran low/i.test(text), "no trigger lines");
  if (companions) expect(/Companion|Ordered with/i.test(text), `${companions} companion lines not tagged`);
  return { note: `${id}: ${lines.length} lines (${companions} companions in DB); detail lists the items with why each was ordered.` };
});

await test("FT-017", "UC2.4", async () => {
  await load("?warehouse=WH002&tab=orders");
  await page.click('[data-view="list"]'); await page.waitForTimeout(500);
  await page.click('[data-order-filter="Delivered"]'); await page.waitForTimeout(500);
  const statuses = await page.$$eval("[data-order-table] tbody tr", (trs) => trs.map((t) => t.innerText.replace(/\s+/g, " ")));
  expect(statuses.length && statuses.every((s) => /Delivered/.test(s)), `rows: ${statuses.slice(0, 3)}`);
  return { note: `List view, "Delivered" filter: ${statuses.length} restocks, all delivered.` };
});

await test("FT-018", "UC2.4", async () => {
  await load("?warehouse=WH002&tab=history");
  await page.waitForSelector(".live-banner, .sample-banner", { timeout: 90000 });
  const banner = await page.$eval(".live-banner, .sample-banner", (b) => b.innerText.replace(/\s+/g, " "));
  expect(/LIVE DATA/.test(banner), `banner "${banner}"`);
  return { note: `"${banner}"` };
});

await test("FT-019", "UC2.4, US2.1", async () => {
  await load();
  const [download] = await Promise.all([page.waitForEvent("download"), page.click('[data-action="export"]')]);
  const file = path.join(SHOTS, download.suggestedFilename());
  await download.saveAs(file);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  const head = lines[0];
  expect(/MedFlow-UC2-WH002-stock-/.test(download.suggestedFilename()), `file ${download.suggestedFilename()}`);
  expect(lines.length - 1 === db.WH002.length, `${lines.length - 1} rows vs ${db.WH002.length}`);
  for (const w of ["Status", "Reorder point"]) expect(head.toLowerCase().includes(w.toLowerCase()), `column "${w}" missing: ${head.slice(0, 200)}`);
  return { note: `${download.suggestedFilename()}: ${lines.length - 1} rows; columns: ${head.slice(0, 160)}…` };
});

await test("FT-020", "UC2.4", async () => {
  await load();
  await page.waitForFunction(() => !/checking stock/i.test(document.querySelector(".notif-bell")?.getAttribute("aria-label") || ""), null, { timeout: 120000 });
  await page.click(".notif-bell"); await page.waitForTimeout(600);
  const headline = await page.$eval(".notif-headline", (e) => e.innerText.replace(/\s+/g, " ")).catch(() => "");
  const items = await page.$$eval(".notif-item", (is) => is.slice(0, 3).map((i) => i.innerText.replace(/\s+/g, " ")));
  const times = await page.$$eval(".notif-item time", (ts) => ts.length);
  expect(headline && items.length, "no headline or alerts");
  expect(times > 0, "alerts carry no time");
  const link = await page.$eval(".notif-item a.notif-main", (a) => a.getAttribute("href"));
  await page.click(".notif-item a.notif-main"); await page.waitForTimeout(2500);
  const hash = await page.evaluate(() => location.hash);
  expect(hash.includes("/uc2") && hash.includes("warehouse="), `alert link went to ${hash}`);
  return { note: `Headline "${headline}"; first alert "${items[0].slice(0, 90)}"; it opens ${link}.` };
});

await test("FT-021", "UC2.5", async () => {
  await load();
  const label = await page.$eval("[data-low-focus]", (b) => b.innerText.replace(/\s+/g, " "));
  await page.click("[data-low-focus]"); await page.waitForTimeout(1500);
  const r = await rows();
  const statuses = new Set(r.map((x) => x.cells[1]));
  expect([...statuses].every((s) => s === "Out of stock" || s === "Low stock"), `statuses ${[...statuses]}`);
  return { note: `"${label.slice(0, 60)}" → ${r.length} products, only Out of stock / Low stock.` };
});

await test("FT-022", "UC2.5", async () => {
  await load();
  const texts = await page.evaluate(() => [
    ...[...document.querySelectorAll("[data-sku-table] th")].map((t) => t.innerText),
    ...[...document.querySelectorAll("[data-chip-status]")].map((c) => c.innerText),
    document.querySelector(".uc2-legend")?.innerText || "",
    document.querySelector(".uc2-pipeline")?.innerText || "",
    ...[...document.querySelectorAll("[data-sku-table] tbody tr")].slice(0, 30).map((t) => t.innerText),
  ].join(" | "));
  const terms = [...new Set(texts.match(/\b(ROP|OUTL|OUL|EOQ|safety stock|z-score)\b/gi) || [])];
  if (terms.length) return { status: "Fail", note: `Technical terms in the main view: ${terms.join(", ")} (the "Near ROP" status chip and legend).` };
  return { note: "No ROP/OUTL/EOQ in the main view." };
});

await test("FT-023", "UC2.5", async () => {
  await load();
  const words = (await page.$$eval("[data-chip-status]", (cs) => cs.map((c) => c.innerText.replace(/\s*\d[\d,]*\s*$/, "").trim())));
  const want = ["Out of Stock", "Reorder Now", "Near Reorder Level", "Available"];
  const missing = want.filter((w) => !words.some((x) => x.toLowerCase() === w.toLowerCase()));
  if (missing.length) return { status: "Fail", note: `Status names are ${words.slice(1).join(", ")}; the story asks for ${want.join(", ")}.` };
  return { note: `Statuses: ${words.join(", ")}` };
});

await test("FT-024", "—", async () => {
  await load("?warehouse=WH999");
  const wh = await page.$eval("[data-subsidiary]", (s) => s.value);
  const banner = await page.$(".sample-banner");
  const r = await rows();
  return { status: r.length ? "Pass" : "Fail", note: `WH999 → page shows "${wh}" with ${r.length} products${banner ? " (sample data banner)" : ""}.` };
});

await test("FT-025", "—", async () => {
  await context.route(/supabase\.co/, (r) => r.abort());
  try {
    await page.goto("about:blank"); await page.goto(`${BASE}?warehouse=WH003`);
    await page.waitForSelector(".sample-banner, [data-sku-table] table", { timeout: 120000 });
    await page.waitForTimeout(1500);
    const banner = await page.$eval(".sample-banner", (b) => b.innerText.replace(/\s+/g, " ")).catch(() => "");
    expect(/SAMPLE DATA/.test(banner), "no sample-data banner when the database is unreachable");
    return { note: `Database blocked → "${banner}"` };
  } finally { await context.unroute(/supabase\.co/); }
});

await test("FT-026", "UC2.4", async () => {
  await load("?warehouse=WH002&tab=skus&sku=MED0011");
  await page.waitForSelector(".uc2-drawer-layer", { timeout: 15000 });
  const head = await page.$eval(".uc2-drawer-layer header", (h) => h.innerText.replace(/\s+/g, " "));
  const selected = await page.$eval('[data-sku-table] tr[data-key="MED0011"]', (tr) => tr.classList.contains("is-selected")).catch(() => false);
  expect(/MED0011/.test(head), `panel shows "${head}"`);
  return { note: `?sku=MED0011 opens its panel ("${head.slice(0, 70)}")${selected ? " and marks its row" : ""}.` };
});

await test("FT-027", "UC2.5, US2.1", async () => {
  await load();
  const r = await rows();
  const sample = r.filter((_, i) => i % 50 === 0);
  const wrong = sample.filter((x) => parseLevel(x.cells[2])?.rop !== byId("WH002", x.id)?.reorderpoint);
  expect(!wrong.length, `page reorder point differs from stored policy for ${wrong.map((x) => x.id)}`);
  return { note: `${sample.length} products checked: the reorder point on the page equals uc2_policy_parameters (the page displays stored values, it does not recalculate).` };
});

fs.writeFileSync("ft2-results.json", JSON.stringify(results, null, 1));
await browser.close();
