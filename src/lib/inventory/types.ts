/**
 * Inventory layer types. Every operation returns a discriminated `status` rather
 * than throwing, so callers must handle contention explicitly — losing a race for
 * the last bed is normal operation, not an exception.
 *
 * Money is integer paise (see src/lib/money.ts).
 */

/**
 * Who performed an action, recorded on the event. Passed explicitly because
 * mutations run under the service role, where `auth.uid()` is null.
 * `label` is snapshotted so the feed survives a staff account being deleted.
 */
export type Actor = {
  id?: string | null;
  label?: string | null;
};

export type BlockReason = "maintenance" | "owner_use" | "hold";

export type ReservationSource =
  | "website"
  | "walk_in"
  | "phone"
  | "ota_booking"
  | "ota_goibibo"
  | "ota_hostelworld"
  | "ota_airbnb"
  | "other";

export type Unit = {
  id: string;
  roomId: string;
  bedId: string | null;
  roomNumber: string;
  bedLabel: string | null;
};

/** One night of the pooled inventory calculation. */
export type NightAvailability = {
  stayDate: string;
  totalUnits: number;
  freeUnits: number;
  pricePaise: number | null;
  closed: boolean;
};

export type QuoteNight = { stayDate: string; pricePaise: number };

export type QuoteResult =
  | {
      status: "OK";
      ratePlanId: string;
      nights: number;
      totalPaise: number;
      perNight: QuoteNight[];
    }
  | { status: "INVALID_DATES" }
  | { status: "NO_RATE_PLAN" }
  /** Some night in the range has no rate row — refuse to guess a price. */
  | { status: "NO_RATE"; missingDates: string[] }
  | { status: "CLOSED"; closedDates: string[] }
  | { status: "MIN_NIGHTS"; minNights: number };

export type GuestGender = "female" | "male" | "other";

export type GuestInput = {
  id?: string;
  name: string;
  phone: string;
  email?: string;
  nationality?: string;
  /**
   * Registration and reporting only. Backpackers Storey runs mixed dorms, so
   * gender never influences bed selection.
   */
  gender?: GuestGender;
};

/** One room type on a booking. Four dorm beds is a single line with qty 4. */
export type ReservationLine = {
  roomTypeId: string;
  ratePlanId: string;
  qty: number;
};

export type CreateReservationInput = {
  guest: GuestInput;
  checkin: string;
  checkout: string;
  lines: ReservationLine[];
  source: ReservationSource;
  /** Reception overriding auto-assignment, flattened in line order. */
  unitIds?: string[];
  /** Who made the booking; recorded on the event. */
  actor?: Actor;
};

export type CreatedReservation = {
  id: string;
  code: string;
  guestId: string;
  checkin: string;
  checkout: string;
  source: ReservationSource;
};

export type CreatedAllocation = {
  unitId: string;
  roomTypeId: string;
  ratePlanId: string | null;
};

export type CreateReservationResult =
  | { ok: true; reservation: CreatedReservation; allocations: CreatedAllocation[] }
  /**
   * Not enough units for a line — whether lost to a concurrent booking or never
   * there. Nothing is written: a group that fails on its third bed leaves zero
   * allocations behind.
   */
  | { ok: false; code: "UNITS_TAKEN"; roomTypeId: string; requested: number; available: number }
  | { ok: false; code: "UNKNOWN_CHANNEL"; source: string }
  | { ok: false; code: "UNKNOWN_ROOM_TYPE"; roomTypeId: string }
  | { ok: false; code: "INVALID_DATES" }
  | { ok: false; code: "NO_LINES" };

/** Who is already holding the unit a move was refused for. */
export type MoveConflict = {
  reason: BlockReason | "booking";
  code: string | null;
  guestName: string | null;
  from: string;
  to: string;
};

export type MoveAllocationResult =
  | { ok: true }
  /** The exclusion constraint refused it — `conflict` names what is in the way. */
  | { ok: false; code: "UNIT_TAKEN"; toRoom: string; conflict: MoveConflict | null }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "UNKNOWN_UNIT" };

export type BlockUnitResult =
  | { ok: true; allocationId: string }
  | { ok: false; code: "UNIT_TAKEN" }
  | { ok: false; code: "UNKNOWN_UNIT" }
  | { ok: false; code: "INVALID_DATES" };

export type CancelReservationResult =
  | { ok: true; unitsReleased: number }
  | { ok: false; code: "NOT_FOUND" }
  | { ok: false; code: "ALREADY_CLOSED"; status: string };
