"use server";

import { revalidatePath } from "next/cache";
import { requireRole, type Role } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Housekeeping status. Includes the housekeeping role, which cannot touch
 * bookings but is the whole point of this control.
 */

const HK_ROLES: Role[] = ["owner", "manager", "reception", "housekeeping"];

export type HousekeepingStatus = "clean" | "dirty" | "inspected" | "out_of_order";

export const HOUSEKEEPING_LABEL: Record<HousekeepingStatus, string> = {
  clean: "Clean",
  dirty: "Dirty",
  inspected: "Inspected",
  out_of_order: "Out of order",
};

export type HousekeepingResult =
  | { ok: true; message: string; needsBlock?: boolean }
  | { ok: false; error: string };

export async function setHousekeeping(
  _prev: HousekeepingResult | null,
  formData: FormData,
): Promise<HousekeepingResult> {
  const session = await requireRole(HK_ROLES);

  const roomId = String(formData.get("room_id") ?? "");
  const status = String(formData.get("status") ?? "") as HousekeepingStatus;
  if (!roomId) return { ok: false, error: "Missing room." };
  if (!(status in HOUSEKEEPING_LABEL)) return { ok: false, error: "Unknown status." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("set_room_housekeeping", {
    p_room_id: roomId,
    p_status: status,
    p_actor_id: session.userId,
    p_actor_label: session.fullName || session.email || "Housekeeping",
  });
  if (error) return { ok: false, error: error.message };

  const result = data as {
    ok: boolean;
    code?: string;
    number?: string;
    needsBlock?: boolean;
  };
  if (!result?.ok) return { ok: false, error: "Couldn't update that room." };

  revalidatePath("/stays/board");
  revalidatePath("/reception");

  return {
    ok: true,
    needsBlock: result.needsBlock,
    message: result.needsBlock
      ? // Out of order is a label, not a sales block — say so rather than let
        // someone assume the room is safe.
        `${result.number} marked out of order. It can still be sold — block it on the board to stop that.`
      : `${result.number} marked ${HOUSEKEEPING_LABEL[status].toLowerCase()}.`,
  };
}
