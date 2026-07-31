"use server";

import { revalidatePath } from "next/cache";
import { requireRole, type Role } from "@/lib/auth";
import { addDays } from "@/lib/dates";
import { blockUnit, moveAllocation } from "@/lib/inventory";
import type { MoveConflict } from "@/lib/inventory/types";

/**
 * Board actions. Every move goes through `moveAllocation` — the exclusion
 * constraint is the authority on whether a unit is free, so nothing here
 * pre-checks availability and hopes.
 */

const DESK_ROLES: Role[] = ["owner", "manager", "reception"];

export type BoardActionResult =
  | { ok: true; message: string }
  | { ok: false; error: string; conflict?: MoveConflict | null };

function describe(c: MoveConflict | null | undefined): string {
  if (!c) return "something else is already there";
  const who =
    c.reason === "booking"
      ? `${c.guestName ?? "a booking"}${c.code ? ` (${c.code})` : ""}`
      : c.reason.replace("_", " ");
  // `to` is the checkout date, so the last occupied night is the day before.
  return `${who}, ${c.from} → ${c.to}`;
}

/** Move a stay to another unit of the same type. */
export async function moveBooking(
  _prev: BoardActionResult | null,
  formData: FormData,
): Promise<BoardActionResult> {
  const session = await requireRole(DESK_ROLES);

  const allocationId = String(formData.get("allocation_id") ?? "");
  const toUnitId = String(formData.get("to_unit_id") ?? "");
  if (!allocationId) return { ok: false, error: "Missing allocation." };
  if (!toUnitId) return { ok: false, error: "Pick a unit to move to." };

  const result = await moveAllocation({
    allocationId,
    toUnitId,
    actor: {
      id: session.userId,
      label: session.fullName || session.email || "Reception",
    },
  });

  if (result.ok) {
    revalidatePath("/stays/board");
    return { ok: true, message: "Moved." };
  }

  if (result.code === "UNIT_TAKEN") {
    return {
      ok: false,
      error: `${result.toRoom} isn't free — ${describe(result.conflict)}.`,
      conflict: result.conflict,
    };
  }
  return {
    ok: false,
    error: result.code === "NOT_FOUND" ? "That booking no longer exists." : "Unknown unit.",
  };
}

/** Take a unit off sale — maintenance, owner use, or a manual hold. */
export async function blockCell(
  _prev: BoardActionResult | null,
  formData: FormData,
): Promise<BoardActionResult> {
  const session = await requireRole(DESK_ROLES);

  const unitId = String(formData.get("unit_id") ?? "");
  const from = String(formData.get("from") ?? "");
  const nights = Math.max(1, Math.min(60, Number(formData.get("nights") ?? 1) || 1));
  const reason = String(formData.get("reason") ?? "maintenance");
  if (!unitId || !from) return { ok: false, error: "Missing unit or date." };

  const to = addDays(from, nights);

  const result = await blockUnit({
    unitId,
    checkIn: from,
    checkOut: to,
    reason: reason === "owner_use" ? "owner_use" : "maintenance",
    actor: {
      id: session.userId,
      label: session.fullName || session.email || "Reception",
    },
  });

  if (result.ok) {
    revalidatePath("/stays/board");
    return { ok: true, message: `Blocked ${nights} night${nights === 1 ? "" : "s"}.` };
  }
  return {
    ok: false,
    error:
      result.code === "UNIT_TAKEN"
        ? "Something is already booked on those nights."
        : "Couldn't block that unit.",
  };
}
