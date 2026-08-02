import { createHmac, timingSafeEqual } from "node:crypto";
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

  /**
   * Fails closed.
   *
   * The previous version returned `true` when the secret was unset, which made an
   * unconfigured deployment accept any unsigned request — and the fix for that is
   * not "remember to set the secret", because the next environment, the next
   * rotation, or a typo in a variable name reopens it silently.
   *
   * Signature is HMAC-SHA256 over `timestamp + "." + rawBody`, so the timestamp
   * is covered and cannot be swapped to replay an old body.
   */
  verify(request: IncomingRequest): boolean {
    const secret = process.env.CHANNEL_MOCK_SECRET;
    if (!secret) return false;

    const timestamp = request.headers["x-mock-timestamp"];
    const signature = request.headers["x-mock-signature"];
    if (!timestamp || !signature) return false;

    const sentAt = Number(timestamp);
    if (!Number.isFinite(sentAt)) return false;

    const now = request.receivedAt ?? Date.now();
    if (Math.abs(now - sentAt) > REPLAY_WINDOW_MS) return false;

    const expected = createHmac("sha256", secret)
      .update(`${timestamp}.${request.rawBody}`)
      .digest("hex");

    return timingSafeEqualHex(expected, signature);
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

/**
 * How far out of date a signed request may be. Long enough to survive hill
 * internet and a retry, short enough that a captured request stops working.
 */
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

/**
 * Compares two hex digests without leaking, through timing, how much of the
 * prefix matched. `timingSafeEqual` throws on a length mismatch, so the lengths
 * are checked first — that comparison is not secret, the digest length is fixed.
 */
function timingSafeEqualHex(expected: string, provided: string): boolean {
  if (expected.length !== provided.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(provided, "hex"));
  } catch {
    // Not valid hex — not a signature we produced.
    return false;
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
