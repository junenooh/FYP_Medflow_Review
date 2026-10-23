/** Shared loading / empty / permission / data-error model for every UC page. */

export const FEEDBACK_KINDS = Object.freeze(["loading", "empty", "permission", "error"]);

export const FEEDBACK_COPY = Object.freeze({
  loading: {
    title: "Reading persisted engine output",
    body: "The planner reads saved model runs from Supabase. It does not recalculate FP-Growth, (s,S) or slotting in the browser.",
  },
  empty: {
    title: "No engine output yet",
    body: "Run the Python engines so this page can show saved rows. Until then the frame, filters and states stay in place.",
  },
  permission: {
    title: "This key cannot read engine output",
    body: "The dashboard uses the anon key. Paste sql/policies/002_anon_read.sql in the Supabase SQL editor, or check VITE_SUPABASE_ANON_KEY in .env.local.",
  },
  error: {
    title: "Could not load engine output",
    body: "The warehouse tables are reachable in principle, but this request failed. Retry without changing the model in the browser.",
  },
});

export function isPermissionError(err) {
  const code = err?.code ?? err?.status ?? err?.statusCode;
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    code === 401 ||
    code === 403 ||
    code === "401" ||
    code === "403" ||
    code === "42501" ||
    msg.includes("permission") ||
    msg.includes("row-level security") ||
    msg.includes("rls") ||
    msg.includes("not authorized") ||
    msg.includes("jwt") ||
    msg.includes("invalid api key")
  );
}

export function classifyFetchError(err) {
  if (!err) return "error";
  if (isPermissionError(err)) return "permission";
  return "error";
}

/** `?feedback=` lets a planner preview states without breaking the database. */
export function resolveFeedback({ override, loading, loadState, rowCount }) {
  if (override && FEEDBACK_KINDS.includes(override)) return override;
  if (loading) return "loading";
  if (loadState === "permission" || loadState === "error") return loadState;
  if (!rowCount) return "empty";
  return null;
}
