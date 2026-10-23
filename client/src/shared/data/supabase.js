import { createClient } from "@supabase/supabase-js";

/** Vite loads VITE_* from repo-root .env.local (vite.config.js envDir). */
export function getSupabaseEnv() {
  const url = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const missing = [];
  if (!url) missing.push("VITE_SUPABASE_URL");
  if (!anonKey) missing.push("VITE_SUPABASE_ANON_KEY");
  return { url, anonKey, missing };
}

export function envError() {
  const { missing } = getSupabaseEnv();
  if (!missing.length) return null;
  return (
    `Missing ${missing.join(", ")} in .env.local at the repo root. ` +
    "Restart Vite after saving the file."
  );
}

const { url, anonKey } = getSupabaseEnv();

/** Browser client. Null until VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set. */
export const supabase = url && anonKey ? createClient(url, anonKey) : null;

export function requireSupabase() {
  if (!supabase) {
    const { missing } = getSupabaseEnv();
    throw new Error(
      `Supabase is not configured (${missing.join(", ") || "missing env"}). ` +
        "Put VITE_* keys in repo-root .env.local and restart Vite.",
    );
  }
  return supabase;
}
