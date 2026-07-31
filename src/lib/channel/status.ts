"use server";

import { revalidatePath } from "next/cache";
import { requireRole, type Role } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/** Data and actions for the sync status screen. */

const DESK_ROLES: Role[] = ["owner", "manager", "reception"];

export type ChannelStatus = {
  distributionMode: "manual" | "channel_manager";
  provider: { providerId: string; label: string } | null;
  queue: { pending: number; failed: number; awaitingAck: number; sentToday: number };
  lastSent: Record<string, string> | null;
  /** Failed pushes and manual tasks awaiting acknowledgement. */
  attention: {
    id: string;
    kind: string;
    status: string;
    roomType: string | null;
    from: string | null;
    to: string | null;
    attempts: number;
    nextAttemptAt: string;
    lastError: string | null;
    requiresAck: boolean;
    createdAt: string;
  }[];
  /** Inbound messages that could not be applied — overbookings and bad payloads. */
  inboundFailures: {
    id: string;
    providerId: string;
    externalId: string;
    kind: string;
    channel: string | null;
    error: string | null;
    receivedAt: string;
  }[];
};

export type ChannelActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

export async function getChannelStatus(): Promise<ChannelStatus> {
  await requireRole(DESK_ROLES);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("channel_status", { p_limit: 25 });
  if (error) throw new Error(`Couldn't load channel status: ${error.message}`);
  return data as ChannelStatus;
}

/** Staff confirming they typed the new numbers into the extranets. */
export async function acknowledgeSync(
  _prev: ChannelActionResult | null,
  formData: FormData,
): Promise<ChannelActionResult> {
  const session = await requireRole(DESK_ROLES);
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: "Missing task." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("acknowledge_channel_sync", {
    p_id: id,
    p_actor_id: session.userId,
  });
  if (error) return { ok: false, error: error.message };
  if (!(data as { ok: boolean })?.ok) return { ok: false, error: "That task is gone." };

  revalidatePath("/stays/channel");
  return { ok: true, message: "Marked done." };
}

/** Staff clearing an inbound message they have handled by hand. */
export async function resolveInbound(
  _prev: ChannelActionResult | null,
  formData: FormData,
): Promise<ChannelActionResult> {
  const session = await requireRole(DESK_ROLES);
  const id = String(formData.get("id") ?? "");
  const resolution = String(formData.get("resolution") ?? "").trim();
  if (!id) return { ok: false, error: "Missing message." };
  if (!resolution) return { ok: false, error: "Say what you did about it." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("resolve_channel_inbound", {
    p_id: id,
    p_resolution: resolution,
    p_actor_id: session.userId,
  });
  if (error) return { ok: false, error: error.message };
  if (!(data as { ok: boolean })?.ok) return { ok: false, error: "That message is gone." };

  revalidatePath("/stays/channel");
  return { ok: true, message: "Cleared." };
}
