import type { ChannelProvider } from "../provider.ts";
import {
  ChannelPayloadError,
  type AvailabilitySnapshot,
  type InboundCancellation,
  type InboundModification,
  type InboundReservation,
  type IncomingRequest,
  type RateSnapshot,
  type ReservationSnapshot,
  type SyncResult,
} from "../types.ts";

/**
 * A Channel Manager that isn't one.
 *
 * Exists so the whole pipeline — trigger, outbox, worker, provider, inbound
 * webhook — can be exercised before any contract is signed, and so the shared
 * provider contract suite has something to run against.
 *
 * Its payload shape is deliberately NOT modelled on any real vendor. If it were,
 * the tests would quietly bake one vendor's assumptions into the contract.
 */
export class MockProvider implements ChannelProvider {
  readonly id = "mock";
  readonly label = "Mock channel manager";

  /** Everything it was told to send, for assertions. */
  readonly sent: { method: string; payload: unknown }[] = [];

  /** Set to make outbound calls fail, so retry behaviour can be tested. */
  failNext: { error: string; retryable: boolean } | null = null;

  private record(method: string, payload: unknown): SyncResult {
    if (this.failNext) {
      const failure = this.failNext;
      this.failNext = null;
      return { ok: false, ...failure };
    }
    this.sent.push({ method, payload });
    return { ok: true, detail: `${method} accepted` };
  }

  async syncAvailability(s: AvailabilitySnapshot) {
    return this.record("syncAvailability", s);
  }
  async syncRates(s: RateSnapshot) {
    return this.record("syncRates", s);
  }
  async reservationCreated(r: ReservationSnapshot) {
    return this.record("reservationCreated", r);
  }
  async reservationModified(r: ReservationSnapshot) {
    return this.record("reservationModified", r);
  }
  async reservationCancelled(r: ReservationSnapshot) {
    return this.record("reservationCancelled", r);
  }

  /* ---- inbound: pure translation, no database, no side effects ---- */

  verify(request: IncomingRequest): boolean {
    const secret = process.env.CHANNEL_MOCK_SECRET;
    // Unset in development; a real provider would never be this forgiving.
    if (!secret) return true;
    return request.headers["x-mock-signature"] === secret;
  }

  receiveReservation(raw: unknown): InboundReservation {
    const p = asObject(raw);
    return {
      externalId: str(p, "id"),
      channel: str(p, "channel"),
      externalRef: optional(p, "reference"),
      guestName: str(p, "guest"),
      guestPhone: optional(p, "phone"),
      guestEmail: optional(p, "email"),
      checkin: date(p, "arrive"),
      checkout: date(p, "depart"),
      roomTypeCode: str(p, "roomType"),
      units: int(p, "units"),
      // Vendors quote rupees; the PMS stores paise. Translating units is
      // exactly the kind of thing that belongs in a provider.
      amountPaise: Math.round(num(p, "amount") * 100),
    };
  }

  receiveCancellation(raw: unknown): InboundCancellation {
    const p = asObject(raw);
    return {
      externalId: str(p, "id"),
      channel: str(p, "channel"),
      externalRef: optional(p, "reference"),
      reservationCode: optional(p, "code"),
    };
  }

  receiveModification(raw: unknown): InboundModification {
    const p = asObject(raw);
    return {
      externalId: str(p, "id"),
      channel: str(p, "channel"),
      externalRef: optional(p, "reference"),
      reservationCode: optional(p, "code"),
      checkin: date(p, "arrive"),
      checkout: date(p, "depart"),
    };
  }
}

/* Parsing helpers. A malformed payload throws BEFORE anything is written. */

function asObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ChannelPayloadError("Payload is not an object.");
  }
  return raw as Record<string, unknown>;
}

function str(p: Record<string, unknown>, key: string): string {
  const v = p[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new ChannelPayloadError(`Missing or empty "${key}".`);
  }
  return v.trim();
}

function optional(p: Record<string, unknown>, key: string): string | null {
  const v = p[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function date(p: Record<string, unknown>, key: string): string {
  const v = str(p, key);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    throw new ChannelPayloadError(`"${key}" must be YYYY-MM-DD.`);
  }
  return v;
}

function num(p: Record<string, unknown>, key: string): number {
  const v = p[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new ChannelPayloadError(`"${key}" must be a non-negative number.`);
  }
  return v;
}

function int(p: Record<string, unknown>, key: string): number {
  const v = num(p, key);
  if (!Number.isInteger(v) || v < 1) {
    throw new ChannelPayloadError(`"${key}" must be a whole number of at least 1.`);
  }
  return v;
}
