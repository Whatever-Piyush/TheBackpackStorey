import { createBrowserClient } from "@supabase/ssr";
import { requireSupabaseEnv } from "./config";

/** Browser (Client Component) Supabase client. */
export function createClient() {
  const { url, key } = requireSupabaseEnv();
  return createBrowserClient(url, key);
}
