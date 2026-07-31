import { createAdminClient } from "@/lib/supabase/admin";
import { addDays, nights as nightsBetween } from "@/lib/dates";
import {
  type Actor,
  type BlockReason,
  type BlockUnitResult,
  type CancelReservationResult,
  type CreateReservationInput,
  type CreateReservationResult,
  type MoveAllocationResult,
  type NightAvailability,
  type QuoteNight,
  type QuoteResult,
  type Unit,
} from "@/lib/inventory/types";

/**
 * Inventory data layer (docs/foundation.md §2–§5).
 *
 * Everything reads and writes `units` / `allocations` and never branches on
 * dorm-vs-private. Writes use the service-role client because §1 puts all
 * operational writes in server-side routes; RLS is deny-by-default.
 *
 * Every mutating function delegates to a SQL function, so the mutation and its
 * event (docs/reception-definitions.md §1) commit or roll back together —
 * see 0011_group_reservations.sql and 0012_events.sql.
 */

/** A daterange literal for a hotel stay: check-out day is free for the next guest. */
function stayRange(checkIn: string, checkOut: string): string {
  return `[${checkIn},${checkOut})`;
}

// --------------------------------------------------------------- availability

/** Units of a type with no allocation overlapping [checkIn, checkOut). */
export async function availableUnits(input: {
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
}): Promise<Unit[]> {
  const { roomTypeId, checkIn, checkOut } = input;
  if (nightsBetween(checkIn, checkOut) < 1) return [];

  const db = createAdminClient();

  const { data: taken, error: aErr } = await db
    .from("allocations")
    .select("unit_id")
    .overlaps("stay", stayRange(checkIn, checkOut));
  if (aErr) throw new Error(`Failed to read allocations: ${aErr.message}`);

  const busy = new Set((taken ?? []).map((a) => a.unit_id as string));

  const { data: units, error: uErr } = await db
    .from("units")
    .select("id, room_id, bed_id, rooms(number), beds(label)")
    .eq("room_type_id", roomTypeId)
    .eq("active", true);
  if (uErr) throw new Error(`Failed to read units: ${uErr.message}`);

  type Row = {
    id: string;
    room_id: string;
    bed_id: string | null;
    rooms: { number: string } | null;
    beds: { label: string } | null;
  };

  return (units ?? [])
    .filter((u) => !busy.has((u as unknown as Row).id))
    .map((raw) => {
      const u = raw as unknown as Row;
      return {
        id: u.id,
        roomId: u.room_id,
        bedId: u.bed_id,
        roomNumber: u.rooms?.number ?? "",
        bedLabel: u.beds?.label ?? null,
      };
    });
}

/**
 * Per-night pooled availability: physical units minus allocations.
 *
 * There is one inventory pool and every channel sells from it. What varies is
 * only how the recalculated numbers are DISTRIBUTED — see docs/Channel_manager.md.
 */
export async function poolAvailability(input: {
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
}): Promise<NightAvailability[]> {
  const { roomTypeId, checkIn, checkOut } = input;
  if (nightsBetween(checkIn, checkOut) < 1) return [];

  const db = createAdminClient();
  const { data, error } = await db.rpc("inventory_snapshot", {
    p_room_type: roomTypeId,
    p_from: checkIn,
    p_to: checkOut,
  });
  if (error) throw new Error(`Failed to compute availability: ${error.message}`);

  type Row = {
    stay_date: string;
    total_units: number;
    free_units: number;
    price_paise: number | null;
    closed: boolean;
  };

  return ((data ?? []) as Row[]).map((r) => ({
    stayDate: r.stay_date,
    totalUnits: r.total_units,
    freeUnits: Math.max(0, r.free_units),
    pricePaise: r.price_paise,
    closed: r.closed,
  }));
}

// ---------------------------------------------------------------------- rates

/**
 * Price a stay by summing the rate calendar (§4) — no rule engine at read time.
 * Refuses to quote when any night is missing a rate or is closed, rather than
 * inventing a number.
 */
export async function quoteStay(input: {
  roomTypeId: string;
  checkIn: string;
  checkOut: string;
  ratePlanId?: string;
}): Promise<QuoteResult> {
  const { roomTypeId, checkIn, checkOut } = input;
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1) return { status: "INVALID_DATES" };

  const db = createAdminClient();

  let planId = input.ratePlanId;
  let minNights = 1;

  if (planId) {
    const { data: plan, error } = await db
      .from("rate_plans")
      .select("id, min_nights")
      .eq("id", planId)
      .eq("active", true)
      .maybeSingle();
    if (error) throw new Error(`Failed to read rate plan: ${error.message}`);
    if (!plan) return { status: "NO_RATE_PLAN" };
    minNights = plan.min_nights as number;
  } else {
    // Cheapest sensible default: the first active plan for the type.
    const { data: plans, error } = await db
      .from("rate_plans")
      .select("id, min_nights")
      .eq("room_type_id", roomTypeId)
      .eq("active", true)
      .order("min_nights")
      .limit(1);
    if (error) throw new Error(`Failed to read rate plans: ${error.message}`);
    if (!plans || plans.length === 0) return { status: "NO_RATE_PLAN" };
    planId = plans[0].id as string;
    minNights = plans[0].min_nights as number;
  }

  if (nights < minNights) return { status: "MIN_NIGHTS", minNights };

  const { data: rows, error: rErr } = await db
    .from("rates")
    .select("stay_date, price_paise, closed")
    .eq("room_type_id", roomTypeId)
    .eq("rate_plan_id", planId)
    .gte("stay_date", checkIn)
    .lt("stay_date", checkOut)
    .order("stay_date");
  if (rErr) throw new Error(`Failed to read rates: ${rErr.message}`);

  type RateRow = { stay_date: string; price_paise: number; closed: boolean };
  const rates = (rows ?? []) as RateRow[];

  const closedDates = rates.filter((r) => r.closed).map((r) => r.stay_date);
  if (closedDates.length > 0) return { status: "CLOSED", closedDates };

  if (rates.length !== nights) {
    const present = new Set(rates.map((r) => r.stay_date));
    const missingDates: string[] = [];
    for (let i = 0; i < nights; i += 1) {
      const iso = addDays(checkIn, i);
      if (!present.has(iso)) missingDates.push(iso);
    }
    return { status: "NO_RATE", missingDates };
  }

  const perNight: QuoteNight[] = rates.map((r) => ({
    stayDate: r.stay_date,
    pricePaise: r.price_paise,
  }));

  return {
    status: "OK",
    ratePlanId: planId,
    nights,
    totalPaise: perNight.reduce((sum, n) => sum + n.pricePaise, 0),
    perNight,
  };
}

// --------------------------------------------------------------- reservations

/**
 * Create a reservation covering one or more units — a group of four sharing a
 * dorm is ONE reservation with FOUR allocations.
 *
 * Atomic by construction: the whole booking is a single plpgsql call
 * (0011_group_reservations.sql), so a clash on the third bed rolls back the
 * first two. Never checks availability and hopes — it inserts, and a `23P01`
 * from the frozen exclusion constraint surfaces as `UNITS_TAKEN`.
 *
 * Inventory is pooled — every channel competes for the same units, and the
 * exclusion constraint is the arbiter.
 */
export async function createReservation(
  input: CreateReservationInput,
): Promise<CreateReservationResult> {
  if (nightsBetween(input.checkin, input.checkout) < 1) {
    return { ok: false, code: "INVALID_DATES" };
  }
  if (input.lines.length === 0) return { ok: false, code: "NO_LINES" };

  const db = createAdminClient();
  const { data, error } = await db.rpc("create_reservation", {
    p_guest: input.guest,
    p_checkin: input.checkin,
    p_checkout: input.checkout,
    p_lines: input.lines,
    p_source: input.source,
    p_unit_ids: input.unitIds ?? null,
    p_actor_id: input.actor?.id ?? null,
    p_actor_label: input.actor?.label ?? null,
  });
  if (error) throw new Error(`Failed to create reservation: ${error.message}`);
  if (!data) throw new Error("create_reservation returned no payload");

  // The function returns the discriminated union directly as jsonb.
  return data as CreateReservationResult;
}

/** Cancel a reservation and release its inventory, atomically. Logs one event. */
export async function cancelReservation(
  reservationId: string,
  actor?: Actor,
): Promise<CancelReservationResult> {
  const db = createAdminClient();
  const { data, error } = await db.rpc("cancel_reservation", {
    p_reservation_id: reservationId,
    p_actor_id: actor?.id ?? null,
    p_actor_label: actor?.label ?? null,
  });
  if (error) throw new Error(`Failed to cancel reservation: ${error.message}`);
  if (!data) throw new Error("cancel_reservation returned no payload");
  return data as CancelReservationResult;
}

// ---------------------------------------------------------------- allocations

/**
 * Move a stay to a different unit — reception shuffling rooms.
 *
 * Goes through plpgsql so the move and its event share one transaction; as a
 * client-side UPDATE the event could be lost after the row already changed.
 */
export async function moveAllocation(input: {
  allocationId: string;
  toUnitId: string;
  actor?: Actor;
}): Promise<MoveAllocationResult> {
  const db = createAdminClient();
  const { data, error } = await db.rpc("move_allocation", {
    p_allocation_id: input.allocationId,
    p_to_unit_id: input.toUnitId,
    p_actor_id: input.actor?.id ?? null,
    p_actor_label: input.actor?.label ?? null,
  });
  if (error) throw new Error(`Failed to move allocation: ${error.message}`);
  if (!data) throw new Error("move_allocation returned no payload");
  return data as MoveAllocationResult;
}

/**
 * Take a unit off sale for a date range (foundation §3: "the Maintenance module
 * becomes one button"). An allocation with no reservation. Logs one event.
 */
export async function blockUnit(input: {
  unitId: string;
  checkIn: string;
  checkOut: string;
  reason?: BlockReason;
  actor?: Actor;
}): Promise<BlockUnitResult> {
  if (nightsBetween(input.checkIn, input.checkOut) < 1) {
    return { ok: false, code: "INVALID_DATES" };
  }

  const db = createAdminClient();
  const { data, error } = await db.rpc("block_unit", {
    p_unit_id: input.unitId,
    p_checkin: input.checkIn,
    p_checkout: input.checkOut,
    p_reason: input.reason ?? "maintenance",
    p_actor_id: input.actor?.id ?? null,
    p_actor_label: input.actor?.label ?? null,
  });
  if (error) throw new Error(`Failed to block unit: ${error.message}`);
  if (!data) throw new Error("block_unit returned no payload");
  return data as BlockUnitResult;
}
