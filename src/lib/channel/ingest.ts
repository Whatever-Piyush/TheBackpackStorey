import { createAdminClient } from "@/lib/supabase/admin";
import type {
  InboundCancellation,
  InboundModification,
  InboundReservation,
} from "@/lib/channel/types";

/**
 * Inbound: a translated message becomes a reservation.
 *
 * By the time anything here runs the provider has already turned a vendor
 * payload into our vocabulary, so this file contains no vendor knowledge at all
 * — it deduplicates, calls the SAME engine the website calls, and records what
 * happened.
 *
 * A message that cannot be applied is recorded as `failed`, never dropped. With
 * pooled inventory a genuine overbooking is possible (a Channel Manager takes
 * seconds to propagate), and a human has to resolve it.
 */

export type IngestOutcome =
  | { status: "applied"; reservationCode: string }
  | { status: "duplicate"; reservationId: string | null }
  | { status: "failed"; error: string };

export async function ingestReservation(
  providerId: string,
  message: InboundReservation,
): Promise<IngestOutcome> {
  const db = createAdminClient();

  const { data: claim } = await db.rpc("claim_channel_inbound", {
    p_provider_id: providerId,
    p_external_id: message.externalId,
    p_kind: "reservation",
    p_channel: message.channel,
    p_payload: message as unknown as Record<string, unknown>,
  });
  const claimed = claim as { fresh: boolean; reservationId?: string | null } | null;

  // A webhook retry is normal operation, not an error.
  if (!claimed?.fresh) {
    return { status: "duplicate", reservationId: claimed?.reservationId ?? null };
  }

  const fail = async (error: string): Promise<IngestOutcome> => {
    await db.rpc("complete_channel_inbound", {
      p_provider_id: providerId,
      p_external_id: message.externalId,
      p_status: "failed",
      p_reservation_id: null,
      p_error: error,
    });
    return { status: "failed", error };
  };

  const { data: type } = await db
    .from("room_types")
    .select("id")
    .eq("code", message.roomTypeCode)
    .eq("active", true)
    .maybeSingle();
  if (!type) return fail(`Unknown room type "${message.roomTypeCode}".`);

  const { data: channel } = await db
    .from("channels")
    .select("code")
    .eq("code", message.channel)
    .eq("active", true)
    .maybeSingle();
  if (!channel) return fail(`Unknown channel "${message.channel}".`);

  const { data, error } = await db.rpc("create_channel_reservation", {
    p_channel: message.channel,
    p_guest_name: message.guestName,
    p_phone: message.guestPhone,
    p_checkin: message.checkin,
    p_checkout: message.checkout,
    p_room_type_id: type.id,
    p_units: message.units,
    p_external_ref: message.externalRef,
    p_amount_paise: message.amountPaise,
    p_actor_id: null,
    p_actor_label: `Channel: ${providerId}`,
  });
  if (error) return fail(error.message);

  const result = data as {
    ok: boolean;
    code?: string;
    reservationId?: string;
    available?: number;
  };

  if (!result?.ok) {
    if (result?.code === "UNITS_TAKEN") {
      // The overbooking case. Recorded loudly for staff — the alternative is a
      // guest who holds a confirmation for a bed that does not exist.
      return fail(
        `Overbooking: the channel sold ${message.units} unit(s) we no longer have (${result.available ?? 0} free).`,
      );
    }
    if (result?.code === "DUPLICATE_REFERENCE") {
      await db.rpc("complete_channel_inbound", {
        p_provider_id: providerId,
        p_external_id: message.externalId,
        p_status: "duplicate",
        p_reservation_id: null,
        p_error: null,
      });
      return { status: "duplicate", reservationId: null };
    }
    return fail(`Reservation refused: ${result?.code ?? "unknown"}.`);
  }

  await db.rpc("complete_channel_inbound", {
    p_provider_id: providerId,
    p_external_id: message.externalId,
    p_status: "applied",
    p_reservation_id: result.reservationId,
    p_error: null,
  });

  return { status: "applied", reservationCode: result.code! };
}

export async function ingestCancellation(
  providerId: string,
  message: InboundCancellation,
): Promise<IngestOutcome> {
  const db = createAdminClient();

  const { data: claim } = await db.rpc("claim_channel_inbound", {
    p_provider_id: providerId,
    p_external_id: message.externalId,
    p_kind: "cancellation",
    p_channel: message.channel,
    p_payload: message as unknown as Record<string, unknown>,
  });
  if (!(claim as { fresh: boolean } | null)?.fresh) {
    return { status: "duplicate", reservationId: null };
  }

  const reservation = await findReservation(message.channel, message.externalRef, message.reservationCode);
  if (!reservation) {
    await db.rpc("complete_channel_inbound", {
      p_provider_id: providerId,
      p_external_id: message.externalId,
      p_status: "failed",
      p_reservation_id: null,
      p_error: "No matching reservation to cancel.",
    });
    return { status: "failed", error: "No matching reservation to cancel." };
  }

  const { data } = await db.rpc("cancel_reservation", {
    p_reservation_id: reservation,
    p_actor_id: null,
    p_actor_label: `Channel: ${providerId}`,
  });
  const result = data as { ok: boolean; code?: string };

  // Cancelling something already closed is fine — the outcome matches intent.
  const settled = result?.ok || result?.code === "ALREADY_CLOSED";
  await db.rpc("complete_channel_inbound", {
    p_provider_id: providerId,
    p_external_id: message.externalId,
    p_status: settled ? "applied" : "failed",
    p_reservation_id: reservation,
    p_error: settled ? null : `Cancel refused: ${result?.code ?? "unknown"}.`,
  });

  return settled
    ? { status: "applied", reservationCode: message.reservationCode ?? "" }
    : { status: "failed", error: `Cancel refused: ${result?.code ?? "unknown"}.` };
}

export async function ingestModification(
  providerId: string,
  message: InboundModification,
): Promise<IngestOutcome> {
  const db = createAdminClient();

  const { data: claim } = await db.rpc("claim_channel_inbound", {
    p_provider_id: providerId,
    p_external_id: message.externalId,
    p_kind: "modification",
    p_channel: message.channel,
    p_payload: message as unknown as Record<string, unknown>,
  });
  if (!(claim as { fresh: boolean } | null)?.fresh) {
    return { status: "duplicate", reservationId: null };
  }

  const reservation = await findReservation(message.channel, message.externalRef, message.reservationCode);
  const done = async (status: string, error: string | null) => {
    await db.rpc("complete_channel_inbound", {
      p_provider_id: providerId,
      p_external_id: message.externalId,
      p_status: status,
      p_reservation_id: reservation,
      p_error: error,
    });
  };

  if (!reservation) {
    await done("failed", "No matching reservation to modify.");
    return { status: "failed", error: "No matching reservation to modify." };
  }

  const { data: current } = await db
    .from("reservations")
    .select("checkout")
    .eq("id", reservation)
    .maybeSingle();
  if (!current) {
    await done("failed", "Reservation vanished.");
    return { status: "failed", error: "Reservation vanished." };
  }

  // Lengthening can be refused by the exclusion constraint; shortening cannot.
  const fn = message.checkout > (current.checkout as string) ? "stays_extend" : "stays_shorten";
  const args =
    fn === "stays_extend"
      ? {
          p_reservation_id: reservation,
          p_new_checkout: message.checkout,
          p_plan: null,
          p_actor_id: null,
          p_actor_label: `Channel: ${providerId}`,
        }
      : {
          p_reservation_id: reservation,
          p_new_checkout: message.checkout,
          p_actor_id: null,
          p_actor_label: `Channel: ${providerId}`,
        };

  const { data } = await db.rpc(fn, args);
  const result = data as { ok: boolean; code?: string };

  if (!result?.ok) {
    const error = `Modification refused: ${result?.code ?? "unknown"}.`;
    await done("failed", error);
    return { status: "failed", error };
  }

  await done("applied", null);
  return { status: "applied", reservationCode: message.reservationCode ?? "" };
}

/** Find a reservation by the channel's own reference, or by our code. */
async function findReservation(
  channel: string,
  externalRef: string | null,
  code: string | null,
): Promise<string | null> {
  const db = createAdminClient();

  if (externalRef) {
    const { data } = await db
      .from("reservations")
      .select("id")
      .eq("source", channel)
      .eq("external_ref", externalRef)
      .maybeSingle();
    if (data) return data.id as string;
  }
  if (code) {
    const { data } = await db
      .from("reservations")
      .select("id")
      .eq("code", code.toUpperCase())
      .maybeSingle();
    if (data) return data.id as string;
  }
  return null;
}
