"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireRole, type Role } from "@/lib/auth";
import { nextItemStatus, type ItemStatus, type PaymentMethod } from "@/lib/pos/types";

/**
 * Kitchen and till actions.
 *
 * Settlement goes through the plpgsql functions in 0015 rather than writing
 * folios/payments from here: posting the lines, taking the payment and closing
 * the order must commit together, or the café takes money against a folio that
 * has no items on it.
 */

const TILL_ROLES: Role[] = ["owner", "manager", "reception"];
const KITCHEN_ROLES: Role[] = ["owner", "manager", "reception", "kitchen"];

export type PosResult = { ok: true; message?: string } | { ok: false; error: string };

const VALID_METHODS: PaymentMethod[] = ["cash", "upi", "card"];

/** Advance one ticket item: queued → preparing → ready. */
export async function advanceItem(formData: FormData): Promise<void> {
  await requireRole(KITCHEN_ROLES);

  const id = String(formData.get("item_id") ?? "");
  const current = String(formData.get("current") ?? "") as ItemStatus;
  const next = nextItemStatus(current);
  if (!id || !next) return;

  const supabase = await createClient();
  // Kitchen staff may only ever write order_items (RLS). A trigger flips the
  // parent order to 'served' once every item is ready.
  await supabase.from("order_items").update({ status: next }).eq("id", id);

  revalidatePath("/pos/kitchen");
  revalidatePath("/pos/bills");
}

/** Take payment at the counter. Opens a walk-in folio and settles it. */
export async function settleOrder(
  _prev: PosResult | null,
  formData: FormData,
): Promise<PosResult> {
  const session = await requireRole(TILL_ROLES);

  const orderId = String(formData.get("order_id") ?? "");
  const method = String(formData.get("method") ?? "") as PaymentMethod;
  if (!orderId) return { ok: false, error: "Missing order." };
  if (!VALID_METHODS.includes(method)) return { ok: false, error: "Pick a payment method." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("pos_settle_order", {
    p_order_id: orderId,
    p_method: method,
    p_actor_id: session.userId,
  });
  if (error) return { ok: false, error: error.message };

  const result = data as { ok: boolean; code?: string };
  if (!result?.ok) {
    return {
      ok: false,
      error:
        result?.code === "ALREADY_CLOSED"
          ? "That order was already settled."
          : "Couldn't settle the order.",
    };
  }

  revalidatePath("/pos/bills");
  revalidatePath("/pos/today");
  return { ok: true, message: "Settled." };
}

/** Post the order onto an in-house guest's open folio; they pay at checkout. */
export async function chargeToRoom(
  _prev: PosResult | null,
  formData: FormData,
): Promise<PosResult> {
  const session = await requireRole(TILL_ROLES);

  const orderId = String(formData.get("order_id") ?? "");
  const reservationId = String(formData.get("reservation_id") ?? "");
  if (!orderId) return { ok: false, error: "Missing order." };
  if (!reservationId) return { ok: false, error: "Pick a guest." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("pos_charge_to_room", {
    p_order_id: orderId,
    p_reservation_id: reservationId,
    p_actor_id: session.userId,
    p_actor_label: session.fullName || session.email || "Café",
  });
  if (error) return { ok: false, error: error.message };

  const result = data as { ok: boolean; code?: string; guestName?: string };
  if (!result?.ok) {
    const messages: Record<string, string> = {
      ALREADY_CLOSED: "That order was already settled.",
      NOT_CHECKED_IN: "That guest isn't checked in any more.",
      NO_RESERVATION: "That booking no longer exists.",
    };
    return { ok: false, error: messages[result?.code ?? ""] ?? "Couldn't charge to the room." };
  }

  revalidatePath("/pos/bills");
  revalidatePath("/pos/today");
  return { ok: true, message: `Charged to ${result.guestName ?? "the room"}.` };
}

/** Owner-only: freeze today's totals. Refuses while anything is unsettled. */
export async function closeDay(
  _prev: PosResult | null,
  formData: FormData,
): Promise<PosResult> {
  const session = await requireRole(["owner"]);

  const date = String(formData.get("date") ?? "") || null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("pos_close_day", {
    p_date: date,
    p_actor_id: session.userId,
    p_actor_label: session.fullName || session.email || "Owner",
  });
  if (error) return { ok: false, error: error.message };

  const result = data as { ok: boolean; code?: string; open?: number };
  if (!result?.ok) {
    if (result?.code === "OPEN_ORDERS") {
      return {
        ok: false,
        error: `${result.open} order${result.open === 1 ? "" : "s"} still open — settle them first.`,
      };
    }
    if (result?.code === "ALREADY_CLOSED") {
      return { ok: false, error: "That day is already closed." };
    }
    return { ok: false, error: "Couldn't close the day." };
  }

  revalidatePath("/pos/today");
  return { ok: true, message: "Day closed." };
}
