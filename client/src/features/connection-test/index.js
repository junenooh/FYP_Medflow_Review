import { getSupabaseEnv, requireSupabase } from "@shared/data/supabase.js";
import { DATABASE_NAME, TABLE_NAMES, TABLES, WAREHOUSE } from "@shared/data/tables.js";
import { renderPageHead } from "@shared/components/page-frame.js";
import { escapeHtml } from "@shared/utils/html.js";

export async function renderTest(root) {
  const { url, missing } = getSupabaseEnv();
  root.innerHTML = `
    <section class="test-page">
      ${renderPageHead({
        kicker: "System · Supabase",
        title: "Connection test",
        subtitle: "Validate the Vite environment, anon key, table access and WH001 scope.",
        actions: [{ label: "Run test", kind: "btn-p" }],
      })}
      <div class="connection-status is-checking" id="connection-status">
        <span class="connection-indicator" aria-hidden="true"></span>
        <div>
          <span class="connection-eyebrow">Connection status</span>
          <strong>Checking Supabase…</strong>
          <small>Testing environment variables and anonymous read access.</small>
        </div>
      </div>
      <section class="connection-details" aria-labelledby="connection-details-title">
        <header>
          <h2 id="connection-details-title">Environment details</h2>
          <p>Browser runtime configuration</p>
        </header>
        <dl>
          <div>
            <dt>Database</dt>
            <dd>${DATABASE_NAME}</dd>
          </div>
          <div>
            <dt>Project endpoint</dt>
            <dd class="mono">${url || "Not configured"}</dd>
          </div>
          <div>
            <dt>API role</dt>
            <dd>Anonymous <span aria-hidden="true">/</span> read only</dd>
          </div>
          <div>
            <dt>Warehouse scope</dt>
            <dd class="mono">${WAREHOUSE.central} <span aria-hidden="true">/</span> CENTRAL</dd>
          </div>
        </dl>
      </section>
      <section class="database-browser" aria-labelledby="database-browser-title">
        <header>
          <div>
            <span class="connection-eyebrow">Anonymous read access</span>
            <h2 id="database-browser-title">Database browser</h2>
          </div>
          <div class="database-browser-controls">
            <label for="database-table">Table</label>
            <select id="database-table">
              ${TABLE_NAMES.map((table) => `<option value="${table}"${table === TABLES.product ? " selected" : ""}>${table}</option>`).join("")}
            </select>
            <button class="btn btn-s" id="load-database-table" type="button">Load table</button>
          </div>
        </header>
        <div class="database-preview is-loading" id="database-preview" aria-live="polite">
          <p>Loading product rows…</p>
        </div>
      </section>
      <div class="panel connection-log">
        <div class="l">Diagnostic output</div>
        <pre id="test-log">Checking…</pre>
      </div>
    </section>
  `;
  root.querySelector(".page-actions .btn")?.addEventListener("click", () => renderTest(root));
  const log = root.querySelector("#test-log");
  const status = root.querySelector("#connection-status");
  if (missing.length) {
    log.textContent = `Missing ${missing.join(", ")} in repo-root .env.local. Restart Vite after saving.`;
    setConnectionStatus(status, "error", "Configuration missing", "Add the missing VITE_* values to .env.local, then restart Vite.");
    return;
  }
  try {
    const db = requireSupabase();
    const product = await db.from(TABLES.product).select("productid,productname").order("productid");
    const warehouse = await db.from(TABLES.warehouse).select("warehouseid,warehouserole");
    if (product.error) throw product.error;
    const productLines = (product.data || []).map((row) => `${row.productid}  ${row.productname}`);
    const warehouseRows = warehouse.error
      ? `warehouse: ${warehouse.error.message}`
      : `warehouse rows: ${warehouse.data?.length ?? 0} (0 usually means paste sql/policies/002_anon_read.sql)`;
    log.textContent = [
      `product rows: ${product.data?.length ?? 0}`,
      ...productLines,
      "",
      warehouseRows,
    ].join("\n");
    setConnectionStatus(
      status,
      "ok",
      "Supabase connection successful",
      `${product.data?.length ?? 0} products readable with the anonymous key.`,
    );

    const tableSelect = root.querySelector("#database-table");
    const loadButton = root.querySelector("#load-database-table");
    const preview = root.querySelector("#database-preview");
    const loadSelectedTable = () => loadTablePreview(db, tableSelect.value, preview, loadButton);
    tableSelect.addEventListener("change", loadSelectedTable);
    loadButton.addEventListener("click", loadSelectedTable);
    await loadSelectedTable();
  } catch (err) {
    log.textContent = String(err.message || err);
    setConnectionStatus(status, "error", "Supabase connection failed", "Review the diagnostic output and anonymous read policy.");
  }
}

function setConnectionStatus(root, kind, title, detail) {
  root.className = `connection-status is-${kind}`;
  root.querySelector("strong").textContent = title;
  root.querySelector("small").textContent = detail;
}

async function loadTablePreview(db, tableName, root, button) {
  root.className = "database-preview is-loading";
  root.innerHTML = `<p>Loading <strong>${escapeHtml(tableName)}</strong>…</p>`;
  button.disabled = true;

  try {
    const { data, error, count } = await db
      .from(tableName)
      .select("*", { count: "exact" })
      .limit(50);
    if (error) throw error;

    const rows = data || [];
    if (!rows.length) {
      root.className = "database-preview is-empty";
      root.innerHTML = `
        <div class="database-preview-message">
          <strong>No visible rows in ${escapeHtml(tableName)}</strong>
          <span>The table may be empty, or its RLS policy may block anonymous reads.</span>
        </div>
      `;
      return;
    }

    const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
    root.className = "database-preview";
    root.innerHTML = `
      <div class="database-preview-meta">
        <span><strong>${escapeHtml(tableName)}</strong></span>
        <span>${rows.length} shown${Number.isInteger(count) ? ` · ${count} total` : ""}</span>
      </div>
      <div class="database-table-scroll">
        <table class="data database-table">
          <thead>
            <tr>${columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>
          </thead>
          <tbody>
            ${rows
              .map(
                (row) =>
                  `<tr>${columns.map((column) => `<td>${formatCell(row[column])}</td>`).join("")}</tr>`,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (error) {
    root.className = "database-preview is-error";
    root.innerHTML = `
      <div class="database-preview-message">
        <strong>Could not read ${escapeHtml(tableName)}</strong>
        <span>${escapeHtml(error.message || String(error))}</span>
      </div>
    `;
  } finally {
    button.disabled = false;
  }
}

function formatCell(value) {
  if (value === null || value === undefined || value === "") return '<span class="database-null">—</span>';
  if (typeof value === "object") return escapeHtml(JSON.stringify(value));
  return escapeHtml(String(value));
}
