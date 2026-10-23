/**
 * Read-only UC3 current-layout adapter.
 *
 * This keeps the database's warehouse / zone / bin / inventory shape out of
 * the 2.5D renderer.  Inventory is stored at lot grain, so this adapter
 * reads the latest live CENTRAL lot snapshot and aggregates only for display.
 * It never synthesizes a location or uses recommendation output as a source
 * layout.
 */
import { envError, requireSupabase } from "@shared/data/supabase.js";
import { TABLES } from "@shared/data/tables.js";
import { classifyFetchError } from "@shared/utils/feedback-state.js";
import { mapCurrentLayout } from "./current-layout-projection.js";

export { mapCurrentLayout } from "./current-layout-projection.js";

const PAGE_SIZE = 1000;
const PAGE_CONCURRENCY = 4;
const SNAPSHOT_PAGE_SIZE = 400;

function asError(result) {
  if (result?.error) throw result.error;
  return result?.data ?? [];
}

async function readAll(db, table, columns, configure = (query) => query, {
  pageSize = PAGE_SIZE,
  concurrency = PAGE_CONCURRENCY,
} = {}) {
  const readPage = async (pageIndex) =>
    asError(
      await configure(db.from(table).select(columns))
        .range(pageIndex * pageSize, (pageIndex + 1) * pageSize - 1),
    );

  // Count requests on the large inventory-history table can time out. Fetch
  // read-only ranges until one is short instead. A bounded group of requests
  // keeps the map responsive without assuming that the planner count is exact.
  const pages = [];
  for (let pageStart = 0; ; pageStart += concurrency) {
    const pageIndexes = Array.from(
      { length: concurrency },
      (_, offset) => pageStart + offset,
    );
    const batch = await Promise.all(pageIndexes.map((pageIndex) => readPage(pageIndex)));
    pages.push(...batch);
    if (batch.some((page) => page.length < pageSize)) return pages.flat();
  }
}

/**
 * Prefer the local UC3 controller's exact product-bin snapshot. It uses the
 * same bounded, read-only DISTINCT ON query as the heuristic. The browser's
 * fallback keeps the map usable when the controller is intentionally absent
 * (for example, a read-only `npm run dev` session), but is not used for a
 * generated recommendation.
 */
async function readCurrentBinSnapshots(db, warehouseId) {
  const products = await readAll(
    db,
    TABLES.product,
    "productid,productname,velocityclass",
    (query) => query.order("productid", { ascending: true }),
    { pageSize: SNAPSHOT_PAGE_SIZE, concurrency: 1 },
  );
  try {
    const response = await fetch("/api/uc3/current-snapshot", { credentials: "same-origin" });
    const snapshot = await response.json().catch(() => null);
    if (response.ok && snapshot?.warehouseid === warehouseId && Array.isArray(snapshot.inventory)) {
      return { products, inventory: snapshot.inventory };
    }
  } catch {
    // The regular Vite-only dashboard intentionally has no controller.
  }

  const rows = await readAll(
    db,
    TABLES.product,
    "productid,productname,velocityclass,inventory!inner(inventoryid,warehouseid,productid,binid,qtyonhand,expirydate,inventorystatus,lastupdated)",
    (query) => query
      .eq("inventory.warehouseid", warehouseId)
      .not("inventory.binid", "is", null)
      .order("productid", { ascending: true })
      .order("lastupdated", { ascending: false, referencedTable: "inventory" })
      .order("inventoryid", { ascending: false, referencedTable: "inventory" })
      .limit(1, { referencedTable: "inventory" }),
    { pageSize: SNAPSHOT_PAGE_SIZE, concurrency: 1 },
  );
  return {
    products,
    inventory: rows.flatMap((row) => row.inventory || []),
  };
}

/**
 * Load the one CENTRAL warehouse and all of its physical slots. This module
 * intentionally performs SELECTs only and does not touch model-run outputs.
 */
export async function fetchCurrentLayout() {
  const missing = envError();
  if (missing) {
    return { ok: false, kind: "permission", message: missing, state: "error", layout: null };
  }

  try {
    const db = requireSupabase();
    const centralWarehouses = asError(
      await db
        .from(TABLES.warehouse)
        .select("warehouseid,warehousename,warehouserole")
        .eq("warehouserole", "CENTRAL")
        .limit(2),
    );

    if (!centralWarehouses.length) {
      return { ok: true, kind: null, message: null, state: "no-central-warehouse", layout: null };
    }
    if (centralWarehouses.length !== 1) {
      return {
        ok: false,
        kind: "error",
        message: "Expected exactly one CENTRAL warehouse, but more than one was returned.",
        state: "error",
        layout: null,
      };
    }

    const warehouse = centralWarehouses[0];
    const [zones, bins] = await Promise.all([
      readAll(db, TABLES.zone, "zoneid,warehouseid,zonename,zonetype", (query) =>
        query.eq("warehouseid", warehouse.warehouseid).order("zoneid", { ascending: true }),
      ),
      readAll(db, TABLES.bin, "binid,capacityvolume,status,position_x,position_y,position_z,warehouseid", (query) =>
        query.eq("warehouseid", warehouse.warehouseid).order("binid", { ascending: true }),
      ),
    ]);

    if (!bins.length) {
      return {
        ok: true,
        kind: null,
        message: null,
        state: "no-bins",
        layout: { warehouse: { id: warehouse.warehouseid, label: warehouse.warehousename || warehouse.warehouseid }, bins: [], missingCoordinates: [], missingZones: [], unmappedBins: [], unmappedInventory: [], velocityMismatches: [] },
      };
    }

    const { products, inventory } = await readCurrentBinSnapshots(db, warehouse.warehouseid);
    const layout = mapCurrentLayout({ warehouse, zones, bins, inventory, products });
    if (layout.unmappedInventory.length) {
      return {
        ok: false,
        kind: "invalid-inventory",
        message: `${layout.unmappedInventory.length} live inventory lot${layout.unmappedInventory.length === 1 ? "" : "s"} do not reference a physical CENTRAL bin. The layout was not partially rendered.`,
        state: "invalid-inventory",
        layout: null,
      };
    }
    return {
      ok: true,
      kind: null,
      message: null,
      state: "ready",
      layout,
    };
  } catch (err) {
    return {
      ok: false,
      kind: classifyFetchError(err),
      message: String(err.message || err),
      state: "error",
      layout: null,
    };
  }
}
