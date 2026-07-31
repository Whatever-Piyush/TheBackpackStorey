/**
 * The normalised vocabulary spoken between the PMS and any Channel Manager.
 *
 * NOTHING vendor-specific belongs in this file. If a type here ever mentions
 * STAAH, SiteMinder or a field name from someone's API, the abstraction has
 * failed — a provider's job is to translate INTO these shapes, not to leak its
 * own outward.
 */

/* ----------------------------------------------------------------- outbound */

/** One night of pooled inventory: physical units minus allocations. */
export type InventoryNight = {
  date: string;
  totalUnits: number;
  freeUnits: number;
  pricePaise: number | null;
  closed: boolean;
};

export type AvailabilitySnapshot = {
  roomTypeId: string;
  roomTypeCode: string;
  roomTypeName: string;
  /** `per_bed` sells beds; `per_room` sells the room. */
  sellMode: "per_bed" | "per_room";
  from: string;
  to: string;
  nights: InventoryNight[];
};

export type RateSnapshot = {
  roomTypeId: string;
  roomTypeCode: string;
  from: string;
  to: string;
  nights: { date: string; pricePaise: number | null; closed: boolean }[];
};

export type ReservationSnapshot = {
  reservationId: string;
  code: string;
  /** Channel CODE, never a vendor name. */
  source: string;
  status: string;
  checkin: string;
  checkout: string;
  guestName: string | null;
  units: { roomTypeId: string; roomTypeCode: string; count: number }[];
  externalRef: string | null;
};

/* ------------------------------------------------------------------ inbound */

/**
 * What a provider must produce from a vendor payload. This is exactly what the
 * reservation engine needs and nothing more — no vendor ids, no raw payload.
 */
export type InboundReservation = {
  /** The Channel Manager's id for this message. Used to deduplicate. */
  externalId: string;
  /** OUR channel code, e.g. `ota_agoda`. The provider maps its own name to this. */
  channel: string;
  /** The OTA's own confirmation number, shown to staff. */
  externalRef: string | null;
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  checkin: string;
  checkout: string;
  roomTypeCode: string;
  units: number;
  /** What the guest already paid the marketplace, in paise. */
  amountPaise: number;
};

export type InboundCancellation = {
  externalId: string;
  channel: string;
  /** Either identifies the booking; providers supply whichever they have. */
  externalRef: string | null;
  reservationCode: string | null;
};

export type InboundModification = {
  externalId: string;
  channel: string;
  externalRef: string | null;
  reservationCode: string | null;
  checkin: string;
  checkout: string;
};

/* ------------------------------------------------------------------ results */

export type SyncResult =
  | { ok: true; detail?: string; requiresAck?: boolean }
  | { ok: false; error: string; retryable: boolean };

/** What a provider sees of an incoming HTTP request. Never the Request object. */
export type IncomingRequest = {
  headers: Record<string, string>;
  rawBody: string;
};

export class ChannelPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChannelPayloadError";
  }
}
