import type { ChannelProvider } from "../provider.ts";
import {
  ChannelPayloadError,
  type AvailabilitySnapshot,
  type InboundCancellation,
  type InboundModification,
  type InboundReservation,
  type RateSnapshot,
  type ReservationSnapshot,
  type SyncResult,
} from "../types.ts";

/**
 * Distribution by human (docs/Channel_manager.md §9b).
 *
 * When no Channel Manager is installed, STAFF are the transport. This provider
 * "delivers" by leaving the change on /stays/channel with the numbers to type
 * into each extranet, to be acknowledged once done.
 *
 * The point is that manual distribution is NOT a special case in the codebase:
 * same outbox, same retry visibility, same acknowledgement. Signing a Channel
 * Manager contract changes which provider the registry returns and nothing else.
 */
export class ManualProvider implements ChannelProvider {
  readonly id = "manual";
  readonly label = "Manual (staff update extranets)";

  async syncAvailability(s: AvailabilitySnapshot): Promise<SyncResult> {
    const tightest = s.nights.reduce(
      (min, n) => Math.min(min, n.freeUnits),
      Number.POSITIVE_INFINITY,
    );
    return {
      ok: true,
      requiresAck: true,
      detail: `${s.roomTypeName}: as low as ${Number.isFinite(tightest) ? tightest : 0} free between ${s.from} and ${s.to}. Update each extranet.`,
    };
  }

  async syncRates(s: RateSnapshot): Promise<SyncResult> {
    return {
      ok: true,
      requiresAck: true,
      detail: `Rates changed for ${s.roomTypeCode}, ${s.from} to ${s.to}. Update each extranet.`,
    };
  }

  async reservationCreated(r: ReservationSnapshot): Promise<SyncResult> {
    // Availability already carries the number to change; a per-reservation task
    // would just be noise on the same screen.
    return { ok: true, detail: `Reservation ${r.code} recorded.` };
  }

  async reservationModified(r: ReservationSnapshot): Promise<SyncResult> {
    return { ok: true, detail: `Reservation ${r.code} changed.` };
  }

  async reservationCancelled(r: ReservationSnapshot): Promise<SyncResult> {
    return { ok: true, detail: `Reservation ${r.code} cancelled.` };
  }

  /*
   * Nothing can arrive automatically without a Channel Manager. The parameters
   * are omitted rather than ignored — an implementation may take fewer than the
   * interface declares, and unused names are just noise.
   */
  verify(): boolean {
    return false;
  }
  receiveReservation(): InboundReservation {
    throw new ChannelPayloadError("Manual distribution receives no webhooks.");
  }
  receiveCancellation(): InboundCancellation {
    throw new ChannelPayloadError("Manual distribution receives no webhooks.");
  }
  receiveModification(): InboundModification {
    throw new ChannelPayloadError("Manual distribution receives no webhooks.");
  }
}
