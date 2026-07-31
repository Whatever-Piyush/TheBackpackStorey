import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveDistribution } from "@/lib/channel/registry";
import type {
  AvailabilitySnapshot,
  RateSnapshot,
  ReservationSnapshot,
  SyncResult,
} from "@/lib/channel/types";

/**
 * Drains the transactional outbox.
 *
 * The database has already recorded WHAT changed, in the same transaction as the
 * change. This turns each row into a provider call and records the outcome. It
 * runs out of band, so a Channel Manager outage delays a sync and never blocks a
 * booking — and because the intent is durable, no sync can be lost.
 */

type OutboxRow = {
  id: string;
  kind:
    | "availability"
    | "rates"
    | "reservation_created"
    | "reservation_modified"
    | "reservation_cancelled";
  room_type_id: string | null;
  from_date: string | null;
  to_date: string | null;
  reservation_id: string | null;
  sequence: number;
};

export type DrainSummary = {
  mode: "manual" | "channel_manager";
  providerId: string;
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
};

export async function drainOutbox(limit = 20): Promise<DrainSummary> {
  const db = createAdminClient();
  const { mode, provider } = await getActiveDistribution();

  const { data, error } = await db.rpc("claim_channel_sync", { p_limit: limit });
  if (error) throw new Error(`Couldn't claim sync work: ${error.message}`);

  const rows = (data ?? []) as OutboxRow[];
  const summary: DrainSummary = {
    mode,
    providerId: provider.id,
    claimed: rows.length,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  // Newest-wins per scope: an old availability number must never land after a
  // fresh one, so anything superseded within this batch is dropped unsent.
  const newestForScope = new Map<string, number>();
  for (const row of rows) {
    const scope = scopeKey(row);
    const seen = newestForScope.get(scope);
    if (seen === undefined || row.sequence > seen) newestForScope.set(scope, row.sequence);
  }

  for (const row of rows) {
    if (newestForScope.get(scopeKey(row)) !== row.sequence) {
      // Coalescing happens HERE rather than at enqueue time, so the booking
      // transaction never takes a lock another booking could wait on.
      await db.rpc("supersede_channel_sync", { p_id: row.id });
      summary.skipped += 1;
      continue;
    }

    let result: SyncResult;
    try {
      result = await dispatch(row, provider);
    } catch (err) {
      // A provider that throws is a provider that failed; it must not take the
      // worker down with it or the queue stops for everyone.
      result = {
        ok: false,
        error: err instanceof Error ? err.message : "provider threw",
        retryable: true,
      };
    }

    await db.rpc("complete_channel_sync", {
      p_id: row.id,
      p_ok: result.ok,
      p_error: result.ok ? null : result.error,
      p_provider_id: provider.id,
    });

    if (result.ok) summary.sent += 1;
    else summary.failed += 1;
  }

  return summary;
}

function scopeKey(row: OutboxRow): string {
  // Reservation events are per reservation; availability and rates per type.
  return row.reservation_id
    ? `${row.kind}:${row.reservation_id}`
    : `${row.kind}:${row.room_type_id}`;
}

async function dispatch(
  row: OutboxRow,
  provider: Awaited<ReturnType<typeof getActiveDistribution>>["provider"],
): Promise<SyncResult> {
  switch (row.kind) {
    case "availability": {
      const snapshot = await buildAvailability(row);
      return snapshot
        ? provider.syncAvailability(snapshot)
        : { ok: true, detail: "room type no longer exists" };
    }
    case "rates": {
      const snapshot = await buildRates(row);
      return snapshot
        ? provider.syncRates(snapshot)
        : { ok: true, detail: "room type no longer exists" };
    }
    default: {
      const snapshot = await buildReservation(row);
      if (!snapshot) return { ok: true, detail: "reservation no longer exists" };
      if (row.kind === "reservation_created") return provider.reservationCreated(snapshot);
      if (row.kind === "reservation_modified") return provider.reservationModified(snapshot);
      return provider.reservationCancelled(snapshot);
    }
  }
}

/* ---- snapshot builders: PMS shapes in, normalised DTOs out ---- */

async function buildAvailability(row: OutboxRow): Promise<AvailabilitySnapshot | null> {
  if (!row.room_type_id || !row.from_date || !row.to_date) return null;
  const db = createAdminClient();

  const { data: type } = await db
    .from("room_types")
    .select("id, code, name, sell_mode")
    .eq("id", row.room_type_id)
    .maybeSingle();
  if (!type) return null;

  const { data: nights } = await db.rpc("inventory_snapshot", {
    p_room_type: row.room_type_id,
    p_from: row.from_date,
    p_to: row.to_date,
  });

  type Night = {
    stay_date: string;
    total_units: number;
    free_units: number;
    price_paise: number | null;
    closed: boolean;
  };

  return {
    roomTypeId: type.id as string,
    roomTypeCode: type.code as string,
    roomTypeName: type.name as string,
    sellMode: type.sell_mode as "per_bed" | "per_room",
    from: row.from_date,
    to: row.to_date,
    nights: ((nights ?? []) as Night[]).map((n) => ({
      date: n.stay_date,
      totalUnits: n.total_units,
      freeUnits: Math.max(0, n.free_units),
      pricePaise: n.price_paise,
      closed: n.closed,
    })),
  };
}

async function buildRates(row: OutboxRow): Promise<RateSnapshot | null> {
  const availability = await buildAvailability(row);
  if (!availability) return null;
  return {
    roomTypeId: availability.roomTypeId,
    roomTypeCode: availability.roomTypeCode,
    from: availability.from,
    to: availability.to,
    nights: availability.nights.map((n) => ({
      date: n.date,
      pricePaise: n.pricePaise,
      closed: n.closed,
    })),
  };
}

async function buildReservation(row: OutboxRow): Promise<ReservationSnapshot | null> {
  if (!row.reservation_id) return null;
  const db = createAdminClient();

  const { data: res } = await db
    .from("reservations")
    .select("id, code, source, status, checkin, checkout, external_ref, guests(name)")
    .eq("id", row.reservation_id)
    .maybeSingle();
  if (!res) return null;

  const { data: allocs } = await db
    .from("allocations")
    .select("units(room_type_id, room_types(code))")
    .eq("reservation_id", row.reservation_id);

  type AllocRow = { units: { room_type_id: string; room_types: { code: string } } | null };
  const counts = new Map<string, { code: string; count: number }>();
  for (const a of (allocs ?? []) as unknown as AllocRow[]) {
    const typeId = a.units?.room_type_id;
    if (!typeId) continue;
    const existing = counts.get(typeId);
    counts.set(typeId, {
      code: a.units?.room_types?.code ?? "",
      count: (existing?.count ?? 0) + 1,
    });
  }

  const guest = res.guests as unknown as { name: string } | null;

  return {
    reservationId: res.id as string,
    code: res.code as string,
    source: res.source as string,
    status: res.status as string,
    checkin: res.checkin as string,
    checkout: res.checkout as string,
    guestName: guest?.name ?? null,
    externalRef: (res.external_ref as string) ?? null,
    units: [...counts.entries()].map(([roomTypeId, v]) => ({
      roomTypeId,
      roomTypeCode: v.code,
      count: v.count,
    })),
  };
}
