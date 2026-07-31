import { createAdminClient } from "@/lib/supabase/admin";
import type { ChannelProvider } from "@/lib/channel/provider";
import { getProvider, PROVIDERS } from "@/lib/channel/providers";

/**
 * The ONLY file that maps a provider id to an implementation.
 *
 * Adding STAAH is: write `providers/staah.ts`, add one line here, insert a row
 * in `channel_providers`. Nothing in the reservation engine, the website or the
 * schema changes — that is the whole point of the indirection.
 */

// The map itself lives in ./providers so it stays free of database imports.
const manual = PROVIDERS.manual;

export { getProvider, listProviders } from "@/lib/channel/providers";

export type ActiveDistribution = {
  mode: "manual" | "channel_manager";
  provider: ChannelProvider;
};

/**
 * Which provider handles outbound work right now.
 *
 * In `manual` mode this is always the ManualProvider, whatever is configured —
 * staff are the transport until someone flips the mode. In `channel_manager`
 * mode with nothing configured (or an unknown id) it falls back to manual and
 * says so, because silently dropping availability updates is the worst outcome.
 */
export async function getActiveDistribution(): Promise<ActiveDistribution> {
  const db = createAdminClient();

  const { data: settings } = await db
    .from("property_settings")
    .select("distribution_mode")
    .eq("id", 1)
    .maybeSingle();

  const mode = (settings?.distribution_mode as ActiveDistribution["mode"]) ?? "manual";
  if (mode !== "channel_manager") return { mode: "manual", provider: manual };

  const { data: configured } = await db
    .from("channel_providers")
    .select("provider_id")
    .eq("active", true)
    .maybeSingle();

  const provider = configured ? getProvider(configured.provider_id as string) : null;
  if (!provider) return { mode: "manual", provider: manual };

  return { mode: "channel_manager", provider };
}
