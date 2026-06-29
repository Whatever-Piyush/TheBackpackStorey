import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { requireSupabaseEnv } from "./config";

/**
 * Server (Server Component / Route Handler / Server Action) Supabase client.
 * cookies() is async in Next 16. Cookie writes from a Server Component throw —
 * we swallow that, since proxy.ts refreshes the session on every request.
 */
export async function createClient() {
  const { url, key } = requireSupabaseEnv();
  const cookieStore = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          );
        } catch {
          // Called from a Server Component — ignore; proxy handles the refresh.
        }
      },
    },
  });
}
