import { createClient } from "@supabase/supabase-js";
import { supabaseAnonKey, supabaseUrl } from "./config";

/**
 * Anon client with NO cookies.
 *
 * Reading `cookies()` opts a route out of static rendering, which would turn the
 * marketing room pages into per-request renders for data that is identical for
 * every visitor. Public availability has no session, so it doesn't need one —
 * this keeps those pages cacheable.
 *
 * Only ever use it for data that is genuinely public. Anything guest-specific
 * belongs on the SSR client in `server.ts`.
 */
export function createPublicClient() {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error("Supabase public env missing (URL / ANON_KEY).");
  }
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
