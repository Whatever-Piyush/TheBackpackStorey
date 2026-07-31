import type {
  AvailabilitySnapshot,
  InboundCancellation,
  InboundModification,
  InboundReservation,
  IncomingRequest,
  RateSnapshot,
  ReservationSnapshot,
  SyncResult,
} from "./types.ts";

/**
 * The contract every Channel Manager implementation satisfies.
 *
 * A provider is a TRANSLATOR. It converts our normalised shapes into a vendor's
 * payloads and back. It has three hard rules:
 *
 *   1. It never touches the database. Not once.
 *   2. Its inbound methods are PURE — they parse and validate, they do not
 *      write. A vendor bug then stays a parsing bug instead of becoming a
 *      data-integrity bug, and can be tested against a recorded payload.
 *   3. It never imports from `@/lib/inventory`, `@/lib/stays` or any PMS module.
 *
 * Swapping vendors means writing one of these and changing one line in the
 * registry. Nothing in the reservation engine moves.
 */
export interface ChannelProvider {
  readonly id: string;
  readonly label: string;

  /* outbound — the PMS tells the world what it now has */
  syncAvailability(snapshot: AvailabilitySnapshot): Promise<SyncResult>;
  syncRates(snapshot: RateSnapshot): Promise<SyncResult>;
  reservationCreated(reservation: ReservationSnapshot): Promise<SyncResult>;
  reservationModified(reservation: ReservationSnapshot): Promise<SyncResult>;
  reservationCancelled(reservation: ReservationSnapshot): Promise<SyncResult>;

  /* inbound — the world tells the PMS. Pure: parse, validate, return. */
  verify(request: IncomingRequest): boolean;
  receiveReservation(raw: unknown): InboundReservation;
  receiveCancellation(raw: unknown): InboundCancellation;
  receiveModification(raw: unknown): InboundModification;
}
