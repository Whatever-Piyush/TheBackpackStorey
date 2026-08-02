"use server";

import { revalidatePath } from "next/cache";
import { requireRole, type Role } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rupeesToPaise } from "@/lib/money";

/**
 * Manual OTA booking entry.
 *
 * Whoever reads the email types it in. Target is under thirty seconds, so the
 * form is deliberately flat — no search, no availability step, no confirmation
 * dialog. The exclusion constraint is what makes that safe.
 *
 * This is the FALLBACK path: with a Channel Manager configured, the same
 * reservation arrives through the provider webhook instead and nobody types
 * anything. It stays for channels the manager doesn't carry, and for the hours
 * after an outage.
 */

const DESK_ROLES: Role[] = ["owner", "manager", "reception"];

/**
 * Channels come from the database now, so a new marketplace is an INSERT into
 * `channels` — no code change, no migration, no redeploy.
 */
export async function listBookableChannels(): Promise<{ value: string; label: string }[]> {
  await requireRole(DESK_ROLES);
  const supabase = await createClient();
  const { data } = await supabase
    .from("channels")
    .select("code, name, kind")
    .eq("active", true)
    .in("kind", ["ota", "manual"])
    .order("sort_order");
  return (data ?? []).map((c) => ({ value: c.code as string, label: c.name as string }));
}

export type OtaResult =
  | { ok: true; message: string; code: string }
  | { ok: false; error: string };

export async function createOtaBooking(
  _prev: OtaResult | null,
  formData: FormData,
): Promise<OtaResult> {
  const session = await requireRole(DESK_ROLES);

  const source = String(formData.get("source") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();
  const checkIn = String(formData.get("checkin") ?? "");
  const checkOut = String(formData.get("checkout") ?? "");
  const roomTypeId = String(formData.get("room_type_id") ?? "");
  const units = Math.max(1, Number(formData.get("units") ?? 1) || 1);
  const reference = String(formData.get("reference") ?? "").trim();
  const amountPaise = rupeesToPaise(formData.get("amount")) ?? 0;

  if (!name) return { ok: false, error: "The guest's name is required." };
  if (!checkIn || !checkOut) return { ok: false, error: "Both dates are required." };
  if (checkOut <= checkIn) return { ok: false, error: "Check-out must be after check-in." };
  if (!roomTypeId) return { ok: false, error: "Pick a room type." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_channel_reservation", {
    p_channel: source,
    p_guest_name: name,
    p_phone: phone || null,
    p_checkin: checkIn,
    p_checkout: checkOut,
    p_room_type_id: roomTypeId,
    p_units: units,
    p_external_ref: reference || null,
    p_amount_paise: amountPaise,
    // A person at the desk. The function checks user_role() for this source, so
    // it cannot be used to bypass the staff check.
    p_source: "reception",
    p_actor_id: session.userId,
    p_actor_label: session.fullName || session.email || "Reception",
  });
  if (error) return { ok: false, error: error.message };

  const result = data as {
    ok: boolean;
    code?: string;
    reference?: string;
    available?: number;
  };

  if (!result?.ok) {
    const messages: Record<string, string> = {
      DUPLICATE_REFERENCE: `${result.reference} is already entered — someone got there first.`,
      UNITS_TAKEN: "Not enough beds free for those dates. Check the board.",
      UNKNOWN_CHANNEL: "Pick which channel this came from.",
      NAME_REQUIRED: "The guest's name is required.",
      UNKNOWN_ROOM_TYPE: "That room type isn't available.",
      BAD_AMOUNT: "Enter a valid amount.",
    };
    return { ok: false, error: messages[result?.code ?? ""] ?? "Couldn't enter that booking." };
  }

  revalidatePath("/stays/ota");
  revalidatePath("/stays/board");
  revalidatePath("/stays/arrivals");
  return {
    ok: true,
    code: result.code!,
    message: `Entered as ${result.code}. Nothing to collect at checkout.`,
  };
}
