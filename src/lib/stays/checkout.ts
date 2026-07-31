"use server";

import { revalidatePath } from "next/cache";
import { requireRole, type Role } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rupeesToPaise } from "@/lib/money";

/**
 * Checkout.
 *
 * All of the arithmetic and every refusal live in `stays_checkout` so the money
 * side is one transaction: charges posted, discount applied, payments taken,
 * folio settled, stay closed and rooms marked dirty either all happen or none do.
 */

const DESK_ROLES: Role[] = ["owner", "manager", "reception"];

export type CheckoutResult =
  | { ok: true; message: string }
  | { ok: false; error: string; balancePaise?: number; openOrders?: number };

export async function checkOut(
  _prev: CheckoutResult | null,
  formData: FormData,
): Promise<CheckoutResult> {
  const session = await requireRole(DESK_ROLES);

  const reservationId = String(formData.get("reservation_id") ?? "");
  if (!reservationId) return { ok: false, error: "Missing reservation." };

  const discountPaise = rupeesToPaise(formData.get("discount")) ?? 0;
  const discountReason = String(formData.get("discount_reason") ?? "").trim();
  if (discountPaise > 0 && !discountReason) {
    return { ok: false, error: "A discount needs a reason." };
  }

  // One row per method actually collected; a zero is simply not sent.
  const payments = (["cash", "upi", "card"] as const)
    .map((method) => ({ method, amountPaise: rupeesToPaise(formData.get(method)) ?? 0 }))
    .filter((p) => p.amountPaise > 0);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stays_checkout", {
    p_reservation_id: reservationId,
    p_payments: payments,
    p_discount_paise: discountPaise,
    p_discount_reason: discountReason || null,
    p_actor_id: session.userId,
    p_actor_label: session.fullName || session.email || "Reception",
  });
  if (error) return { ok: false, error: error.message };

  const result = data as {
    ok: boolean;
    code?: string;
    balancePaise?: number;
    open?: number;
    rooms?: string;
    paidPaise?: number;
  };

  if (!result?.ok) {
    switch (result?.code) {
      case "BALANCE_DUE":
        return {
          ok: false,
          error: "There's still a balance — take the rest, or add a discount with a reason.",
          balancePaise: result.balancePaise,
        };
      case "OPEN_ORDERS":
        return {
          ok: false,
          error: `${result.open} café order${result.open === 1 ? "" : "s"} still open against this stay. Settle ${result.open === 1 ? "it" : "them"} in the POS first.`,
          openOrders: result.open,
        };
      case "REASON_REQUIRED":
        return { ok: false, error: "A discount needs a reason." };
      case "NO_RATE":
        return {
          ok: false,
          error: "Some nights have no rate in the calendar, so the bill can't be totalled.",
        };
      case "ALREADY_CHECKED_OUT":
        return { ok: false, error: "They're already checked out." };
      case "NOT_IN_HOUSE":
        return { ok: false, error: "That stay isn't in-house." };
      default:
        return { ok: false, error: "Couldn't check them out." };
    }
  }

  revalidatePath("/stays/departures");
  revalidatePath("/stays/board");
  return { ok: true, message: `Checked out of ${result.rooms}. Rooms marked dirty.` };
}
