"use server";

import { revalidatePath } from "next/cache";
import { requireRole, type Role } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { rupeesToPaise } from "@/lib/money";
import type { BlockedAllocation } from "@/lib/stays/in-house";

/** Extend, shorten, charge, no-show. */

const DESK_ROLES: Role[] = ["owner", "manager", "reception"];

export type StayResult =
  | { ok: true; message: string; split?: boolean }
  | { ok: false; error: string; blocked?: BlockedAllocation[] };

function refresh() {
  revalidatePath("/stays/in-house");
  revalidatePath("/stays/board");
  revalidatePath("/stays/departures");
}

/**
 * Extend a stay.
 *
 * With no plan this simply tries to widen the allocations; the exclusion
 * constraint decides. If it refuses, the caller gets the blocked allocations
 * back with two kinds of alternative and picks one — we never silently move a
 * guest between beds.
 */
export async function extendStay(
  _prev: StayResult | null,
  formData: FormData,
): Promise<StayResult> {
  const session = await requireRole(DESK_ROLES);

  const reservationId = String(formData.get("reservation_id") ?? "");
  const newCheckout = String(formData.get("checkout") ?? "");
  if (!reservationId || !newCheckout) return { ok: false, error: "Missing dates." };

  // Set by the drawer once reception has chosen a move or a split.
  const rawPlan = String(formData.get("plan") ?? "").trim();
  let plan: unknown = null;
  if (rawPlan) {
    try {
      plan = JSON.parse(rawPlan);
    } catch {
      return { ok: false, error: "Couldn't read the chosen units." };
    }
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stays_extend", {
    p_reservation_id: reservationId,
    p_new_checkout: newCheckout,
    p_plan: plan,
    p_actor_id: session.userId,
    p_actor_label: session.fullName || session.email || "Reception",
  });
  if (error) return { ok: false, error: error.message };

  const result = data as {
    ok: boolean;
    code?: string;
    split?: boolean;
    checkout?: string;
    currentCheckout?: string;
    options?: { blocked: BlockedAllocation[] };
  };

  if (!result?.ok) {
    if (result?.code === "UNITS_TAKEN") {
      return {
        ok: false,
        error: "Those nights aren't free in the current bed. Pick another unit below.",
        blocked: result.options?.blocked ?? [],
      };
    }
    if (result?.code === "NOT_LATER") {
      return { ok: false, error: `Pick a date after ${result.currentCheckout}.` };
    }
    return { ok: false, error: "Couldn't extend the stay." };
  }

  refresh();
  return {
    ok: true,
    split: result.split,
    message: result.split
      ? `Extended to ${result.checkout} — the guest changes beds partway.`
      : `Extended to ${result.checkout}.`,
  };
}

/** Shorten a stay and un-bill the nights they no longer stay. */
export async function shortenStay(
  _prev: StayResult | null,
  formData: FormData,
): Promise<StayResult> {
  const session = await requireRole(DESK_ROLES);

  const reservationId = String(formData.get("reservation_id") ?? "");
  const newCheckout = String(formData.get("checkout") ?? "");
  if (!reservationId || !newCheckout) return { ok: false, error: "Missing dates." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stays_shorten", {
    p_reservation_id: reservationId,
    p_new_checkout: newCheckout,
    p_actor_id: session.userId,
    p_actor_label: session.fullName || session.email || "Reception",
  });
  if (error) return { ok: false, error: error.message };

  const result = data as {
    ok: boolean;
    code?: string;
    chargesRemoved?: number;
    checkin?: string;
    currentCheckout?: string;
  };
  if (!result?.ok) {
    const messages: Record<string, string> = {
      NOT_EARLIER: `Pick a date before ${result.currentCheckout}.`,
      TOO_SHORT: `They arrived on ${result.checkin} — checkout has to be after that.`,
      FOLIO_SETTLED: "That bill is already settled, so it can't be reduced here.",
    };
    return { ok: false, error: messages[result?.code ?? ""] ?? "Couldn't shorten the stay." };
  }

  refresh();
  return {
    ok: true,
    message: `Shortened. ${result.chargesRemoved} night charge${
      result.chargesRemoved === 1 ? "" : "s"
    } removed.`,
  };
}

/** Post something extra onto the folio. */
export async function addCharge(
  _prev: StayResult | null,
  formData: FormData,
): Promise<StayResult> {
  const session = await requireRole(DESK_ROLES);

  const reservationId = String(formData.get("reservation_id") ?? "");
  const description = String(formData.get("description") ?? "").trim();
  const amountPaise = rupeesToPaise(formData.get("amount"));

  if (!reservationId) return { ok: false, error: "Missing reservation." };
  if (!description) return { ok: false, error: "What is the charge for?" };
  if (!amountPaise) return { ok: false, error: "Enter an amount." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stays_add_charge", {
    p_reservation_id: reservationId,
    p_description: description,
    p_amount_paise: amountPaise,
    p_kind: "extra",
    p_actor_id: session.userId,
    p_actor_label: session.fullName || session.email || "Reception",
  });
  if (error) return { ok: false, error: error.message };

  const result = data as { ok: boolean; code?: string };
  if (!result?.ok) return { ok: false, error: "Couldn't post that charge." };

  refresh();
  return { ok: true, message: "Charge posted." };
}

/** A booking that never arrived. Releases the beds. */
export async function markNoShow(
  _prev: StayResult | null,
  formData: FormData,
): Promise<StayResult> {
  const session = await requireRole(DESK_ROLES);

  const reservationId = String(formData.get("reservation_id") ?? "");
  if (!reservationId) return { ok: false, error: "Missing reservation." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stays_mark_no_show", {
    p_reservation_id: reservationId,
    p_actor_id: session.userId,
    p_actor_label: session.fullName || session.email || "Reception",
  });
  if (error) return { ok: false, error: error.message };

  const result = data as { ok: boolean; code?: string; unitsReleased?: number };
  if (!result?.ok) {
    return {
      ok: false,
      error:
        result?.code === "NOT_PENDING"
          ? "They're already checked in — that isn't a no-show."
          : "Couldn't mark that as a no-show.",
    };
  }

  revalidatePath("/stays/arrivals");
  revalidatePath("/stays/board");
  return {
    ok: true,
    message: `Marked no-show. ${result.unitsReleased} unit${
      result.unitsReleased === 1 ? "" : "s"
    } released.`,
  };
}
