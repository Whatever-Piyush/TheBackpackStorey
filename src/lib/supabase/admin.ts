import { createClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client using the service-role key. **Bypasses RLS** —
 * use exclusively in Server Actions / Route Handlers for trusted server logic
 * (e.g. public website bookings), never in a Client Component. DB CHECK and
 * exclusion constraints still apply, so double-booking is still impossible.
 */
export function createAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Supabase admin env missing (URL / SERVICE_ROLE_KEY).");
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
