/**
 * Read persisted engine tables. Pages must not re-run ARM / ROP / SA in the browser.
 */
import { envError, requireSupabase } from "./supabase.js";
import { TABLES, WAREHOUSE } from "./tables.js";
import { classifyFetchError } from "@shared/utils/feedback-state.js";
import {
  mapLayoutRecommendation,
  mapProductRelationship,
  mapReplenishment,
} from "./mappers.js";

const RELATIONSHIP_ID_BATCH_SIZE = 100;

function asError(result) {
  if (result?.error) throw result.error;
  return result?.data ?? [];
}

export async function fetchLatestRun() {
  const missing = envError();
  if (missing) {
    return { ok: false, kind: "permission", message: missing, run: null };
  }
  try {
    const db = requireSupabase();
    const result = await db
      .from(TABLES.modelrun)
      .select("runid,runtype,generatedate,algorithmversion")
      .order("generatedate", { ascending: false })
      .limit(1);
    const rows = asError(result);
    return { ok: true, kind: null, run: rows[0] ?? null, message: null };
  } catch (err) {
    return {
      ok: false,
      kind: classifyFetchError(err),
      run: null,
      message: String(err.message || err),
    };
  }
}

async function readTable(name, columns, { warehouseId, warehouseIds, relationshipIds, limit = 200 } = {}) {
  const missing = envError();
  if (missing) {
    const err = new Error(missing);
    err.status = 401;
    throw err;
  }
  const db = requireSupabase();
  let query = db.from(name).select(columns).limit(limit);
  if (warehouseIds?.length) query = query.in("warehouseid", warehouseIds);
  else if (warehouseId) query = query.eq("warehouseid", warehouseId);
  if (relationshipIds?.length) query = query.in("relationshipid", relationshipIds);
  return asError(await query);
}

export async function fetchWarehouses() {
  try {
    const rows = await readTable(
      TABLES.warehouse,
      "warehouseid,warehousename,warehouserole",
      { limit: 100 },
    );
    return { ok: true, rows, message: null };
  } catch (err) {
    return { ok: false, rows: [], message: String(err.message || err) };
  }
}

export async function fetchOverviewCounts() {
  const missing = envError();
  if (missing) {
    return { ok: false, kind: "permission", message: missing, counts: null };
  }
  try {
    const db = requireSupabase();
    const [products, relationships, replenishment, layout, run] = await Promise.all([
      db.from(TABLES.product).select("productid", { count: "exact", head: true }),
      db.from(TABLES.productrelationship).select("relationshipid", { count: "exact", head: true }),
      db.from(TABLES.replenishmentrecommendation).select("recommendationid", { count: "exact", head: true }),
      db.from(TABLES.layoutrecommendation).select("movefieldid", { count: "exact", head: true }),
      fetchLatestRun(),
    ]);
    for (const result of [products, relationships, replenishment, layout]) {
      if (result.error) throw result.error;
    }
    return {
      ok: true,
      kind: null,
      message: null,
      counts: {
        products: products.count ?? 0,
        relationships: relationships.count ?? 0,
        replenishment: replenishment.count ?? 0,
        layout: layout.count ?? 0,
      },
      run: run.run,
    };
  } catch (err) {
    return {
      ok: false,
      kind: classifyFetchError(err),
      message: String(err.message || err),
      counts: null,
      run: null,
    };
  }
}

export async function fetchRelationshipOutputs({ warehouseId, warehouseIds } = {}) {
  try {
    const rows = await readTable(
      TABLES.productrelationship,
      "relationshipid,warehouseid,consequent_productid,itemsetsize,support,confidence,lift,strength,ordercount,rulesource,runid,lastupdated",
      { warehouseId, warehouseIds, limit: 5000 },
    );
    const relationshipIds = rows.map((row) => row.relationshipid);
    const [antecedents, products, run] = await Promise.all([
      Promise.all(
        Array.from(
          { length: Math.ceil(relationshipIds.length / RELATIONSHIP_ID_BATCH_SIZE) },
          (_, index) =>
            readTable(
              TABLES.productrelationshipantecedent,
              "relationshipid,antecedent_productid",
              {
                relationshipIds: relationshipIds.slice(
                  index * RELATIONSHIP_ID_BATCH_SIZE,
                  (index + 1) * RELATIONSHIP_ID_BATCH_SIZE,
                ),
                limit: 1000,
              },
            ),
        ),
      ).then((batches) => batches.flat()),
      readTable(TABLES.product, "productid,productname,velocityclass,status"),
      fetchLatestRun(),
    ]);
    const names = Object.fromEntries(products.map((p) => [p.productid, p.productname]));
    const antByRel = antecedents.reduce((acc, row) => {
      (acc[row.relationshipid] ||= []).push(row.antecedent_productid);
      return acc;
    }, {});
    const mapped = rows.map((row) =>
      mapProductRelationship({
        ...row,
        antecedents: antByRel[row.relationshipid] || [],
        antecedentNames: (antByRel[row.relationshipid] || []).map(
          (productId) => names[productId] || productId,
        ),
        consequentName: names[row.consequent_productid] || row.consequent_productid,
      }),
    );
    return { ok: true, kind: null, rows: mapped, run: run.run, message: null };
  } catch (err) {
    return {
      ok: false,
      kind: classifyFetchError(err),
      rows: [],
      run: null,
      message: String(err.message || err),
    };
  }
}

export async function fetchReplenishmentOutputs() {
  try {
    const [rows, products, run] = await Promise.all([
      readTable(
        TABLES.replenishmentrecommendation,
        "recommendationid,runid,warehouseid,productid,qtyonhand,reorderpoint,safetystock,orderuptolevel,recommendedorderqty,inventorystatus,status,fulfillmentstatus,copickskus,copicklift,recommendationreason",
      ),
      readTable(TABLES.product, "productid,productname,status"),
      fetchLatestRun(),
    ]);
    const names = Object.fromEntries(products.map((p) => [p.productid, p.productname]));
    const mapped = rows.map((row) =>
      mapReplenishment({ ...row, productname: names[row.productid] || row.productid }),
    );
    return { ok: true, kind: null, rows: mapped, run: run.run, message: null };
  } catch (err) {
    return {
      ok: false,
      kind: classifyFetchError(err),
      rows: [],
      run: null,
      message: String(err.message || err),
    };
  }
}

export async function fetchLayoutOutputs() {
  try {
    const [moves, bins, zones, inventory, products, run] = await Promise.all([
      readTable(
        TABLES.layoutrecommendation,
        "movefieldid,warehouseid,productid,velocityclass,movedirection,reason,distanceimprovementm,timesavedseconds,distanceimprovementpct,priority,avgdailydemand,currentbin,recommendedbin,runid,lastupdated",
        { warehouseId: WAREHOUSE.central },
      ),
      readTable(
        TABLES.bin,
        "binid,zoneid,capacityvolume,status,position_x,position_y,warehouseid",
        { warehouseId: WAREHOUSE.central, limit: 400 },
      ),
      readTable(TABLES.zone, "zoneid,warehouseid,zonename,zonetype", {
        warehouseId: WAREHOUSE.central,
        limit: 80,
      }),
      readTable(
        TABLES.inventory,
        "inventoryid,warehouseid,productid,binid,qtyonhand,inventorystatus",
        { warehouseId: WAREHOUSE.central, limit: 400 },
      ),
      readTable(TABLES.product, "productid,productname,velocityclass,status,category"),
      fetchLatestRun(),
    ]);
    const names = Object.fromEntries(products.map((p) => [p.productid, p.productname]));
    const mappedMoves = moves.map((row) =>
      mapLayoutRecommendation({
        ...row,
        productname: names[row.productid] || row.productid,
      }),
    );
    return {
      ok: true,
      kind: null,
      message: null,
      moves: mappedMoves,
      bins,
      zones,
      inventory,
      products,
      run: run.run,
    };
  } catch (err) {
    return {
      ok: false,
      kind: classifyFetchError(err),
      message: String(err.message || err),
      moves: [],
      bins: [],
      zones: [],
      inventory: [],
      products: [],
      run: null,
    };
  }
}
