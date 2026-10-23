/**
 * Read and project one persisted UC3 recommendation run.  This adapter is
 * deliberately fail-closed: the Recommended map is never assembled from a
 * partial, stale, or mixed-run result.
 */
import { envError, requireSupabase } from "../../shared/data/supabase.js";
import { TABLES } from "../../shared/data/tables.js";
import { mapLayoutRecommendation } from "../../shared/data/mappers.js";
import { classifyFetchError } from "../../shared/utils/feedback-state.js";
import { projectRecommendedLayout as projectLayout, selectLatestUc3Run } from "./recommended-layout-projection.js";

// Supabase's Data API caps an unbounded select at 1,000 rows.  UC3 emits one
// row per bin move and a valid run can exceed that cap, so a partial response
// would make a complete swap/cycle appear to have an occupied destination.
const RECOMMENDATION_PAGE_SIZE = 1000;

function rowsOrThrow(result) {
  if (result?.error) throw result.error;
  return result?.data || [];
}

function batchId(run) {
  return /batch=([0-9a-f-]+)/i.exec(run?.parametersignature || "")?.[1] || "";
}

function paybackDays(run) {
  const value = /payback_days=(\d+)/.exec(run?.parametersignature || "")?.[1];
  return value ? Number(value) : null;
}

async function readRecommendationRows(db, warehouseId, runId) {
  const rows = [];
  for (let from = 0; ; from += RECOMMENDATION_PAGE_SIZE) {
    const page = rowsOrThrow(await db
      .from(TABLES.layoutrecommendation)
      .select("movefieldid,warehouseid,productid,velocityclass,movedirection,reason,distanceimprovementm,timesavedseconds,distanceimprovementpct,priority,avgdailydemand,lift,currentbin,recommendedbin,runid,lastupdated")
      .eq("warehouseid", warehouseId)
      .eq("runid", runId)
      // Stable tie-breakers are required so every page represents the same
      // saved run and no move is skipped or duplicated between requests.
      .order("productid", { ascending: true })
      .order("currentbin", { ascending: true })
      .order("movefieldid", { ascending: true })
      .range(from, from + RECOMMENDATION_PAGE_SIZE - 1));
    rows.push(...page);
    if (page.length < RECOMMENDATION_PAGE_SIZE) return rows;
  }
}

/** The engine commits modelrun and its UC3 rows atomically, so a UC3 row is a completed run. */
export async function fetchRecommendedLayout(currentLayout, { runId } = {}) {
  const missing = envError();
  if (missing) return { ok: false, state: "error", kind: "permission", message: missing, run: null, moves: [], layout: null };
  try {
    const db = requireSupabase();
    let runQuery = db
      .from(TABLES.modelrun)
      .select("runid,runtype,generatedate,algorithmversion,parametersignature")
      .eq("runtype", "UC3")
      .order("generatedate", { ascending: false })
      .order("runid", { ascending: false })
      .limit(1);
    if (runId) runQuery = db.from(TABLES.modelrun).select("runid,runtype,generatedate,algorithmversion,parametersignature").eq("runtype", "UC3").eq("runid", runId).limit(1);
    let run = selectLatestUc3Run(rowsOrThrow(await runQuery));
    if (!run) return { ok: true, state: "no-run", kind: null, message: "Run the UC3 heuristic to create a recommended layout.", run: null, moves: [], layout: null };
    // uc3-slotting-2.0 writes one run per payback preset, tied by a batch id in the signature.
    // Offer the whole batch as presets; without an explicit runId, show the 30-day preset.
    const batch = /batch=([0-9a-f-]+)/i.exec(run.parametersignature || "")?.[1];
    let presets = [];
    if (batch) {
      const batchRuns = rowsOrThrow(await db
        .from(TABLES.modelrun)
        .select("runid,runtype,generatedate,algorithmversion,parametersignature")
        .eq("runtype", "UC3")
        .like("parametersignature", `%batch=${batch}%`));
      presets = batchRuns
        .map((row) => ({ runid: row.runid, payback: Number(/payback_days=(\d+)/.exec(row.parametersignature || "")?.[1]) || null, row }))
        .filter((preset) => preset.payback)
        .sort((a, b) => a.payback - b.payback);
      if (!runId && presets.length) run = (presets.find((preset) => preset.payback === 30) || presets[0]).row;
    }
    const withPresets = (result) => ({ ...result, presets: presets.map(({ runid, payback }) => ({ runid, payback })) });
    const rows = await readRecommendationRows(db, currentLayout.warehouse.id, run.runid);
    const moves = rows.map(mapLayoutRecommendation);
    if (!moves.length) return withPresets({ ok: true, state: "zero-changes", kind: null, message: "This UC3 run produced no changed assignments.", run, moves, layout: currentLayout });
    const projection = projectLayout(currentLayout, moves);
    return withPresets({ ...projection, run, moves });
  } catch (error) {
    return { ok: false, state: "error", kind: classifyFetchError(error), message: String(error?.message || error), run: null, moves: [], layout: null };
  }
}

/**
 * One read-only history entry per New UC3 batch. The 30-day run represents a
 * batch because it is the reader's existing balanced default; older one-run
 * records remain individually selectable.
 */
export async function fetchUc3History() {
  const missing = envError();
  if (missing) return { ok: false, rows: [], message: missing };
  try {
    const db = requireSupabase();
    const rows = rowsOrThrow(await db
      .from(TABLES.modelrun)
      .select("runid,runtype,generatedate,algorithmversion,parametersignature")
      .eq("runtype", "UC3")
      .order("generatedate", { ascending: false })
      .order("runid", { ascending: false })
      .limit(120));
    const batches = new Map();
    for (const row of rows) {
      const key = batchId(row) || row.runid;
      const group = batches.get(key) || [];
      group.push(row);
      batches.set(key, group);
    }
    const representatives = [...batches.values()].map((group) =>
      group.find((row) => paybackDays(row) === 30) || group[0],
    ).sort((a, b) => String(b.generatedate).localeCompare(String(a.generatedate)) || String(b.runid).localeCompare(String(a.runid)));
    return {
      ok: true,
      rows: representatives.map((row) => ({
        ...row,
        historyBatchId: batchId(row) || row.runid,
      })),
    };
  } catch (error) {
    return { ok: false, rows: [], message: String(error?.message || error) };
  }
}
