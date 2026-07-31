/**
 * Inventory concurrency tests.
 *
 * These exercise the SQL functions directly, because that is where the atomicity
 * and concurrency contract lives — `createReservation` in src/lib/inventory/ is a
 * typed wrapper that passes the jsonb result through. Testing via PostgREST would
 * add a network hop and prove strictly less.
 *
 * Requires a Postgres with every migration applied:
 *
 *   docker run -d --name hotelos -p 55432:5432 \
 *     -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=app postgres:17-alpine
 *   # apply supabase/migrations in order, then:
 *   npm test
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

/** Unique per run so a failed run never poisons the next one. */
const TAG = `TEST_${Date.now().toString(36).toUpperCase()}`;

let admin: Client;

type BookingResult = {
  ok: boolean;
  code?: string;
  roomTypeId?: string;
  requested?: number;
  available?: number;
  reservation?: { id: string; code: string };
  allocations?: { unitId: string }[];
};

/**
 * Block until the backend on `pid` is genuinely waiting on a lock. Without this
 * the race is timing-dependent: if the second transaction starts after the first
 * commits it simply finds nothing free, instead of losing the race.
 */
async function waitUntilBlocked(pid: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await admin.query<{ blocked: boolean }>(
      `select wait_event_type = 'Lock' as blocked from pg_stat_activity where pid = $1`,
      [pid],
    );
    if (rows[0]?.blocked) return;
  }
  throw new Error(`backend ${pid} never blocked on a lock within ${timeoutMs}ms`);
}

/** Create an isolated room type so each test controls its own free-bed count. */
async function makeType(
  suffix: string,
  sellMode: "per_bed" | "per_room",
  rooms: { number: string; beds: number }[],
): Promise<string> {
  const code = `${TAG}_${suffix}`;
  const { rows } = await admin.query<{ id: string }>(
    `insert into room_types (code, name, sell_mode, base_occupancy, max_occupancy, sort_order)
     values ($1, $1, $2, 1, 6, 999) returning id`,
    [code, sellMode],
  );
  const typeId = rows[0].id;

  for (const room of rooms) {
    const { rows: r } = await admin.query<{ id: string }>(
      `insert into rooms (room_type_id, number, name, type, total_beds, is_dorm)
       values ($1, $2, $2, $3, $4, $5) returning id`,
      [
        typeId,
        `${code}-${room.number}`,
        sellMode === "per_bed" ? "dorm" : "deluxe",
        room.beds,
        sellMode === "per_bed",
      ],
    );
    for (let i = 1; i <= room.beds; i += 1) {
      await admin.query(`insert into beds (room_id, label) values ($1, $2)`, [
        r[0].id,
        `B${i}`,
      ]);
    }
  }
  return typeId;
}

/** `create_reservation` with allotment bypassed, so tests target the constraint. */
async function reserve(
  client: Client,
  typeId: string,
  checkIn: string,
  checkOut: string,
  qty = 1,
): Promise<BookingResult> {
  const { rows } = await client.query<{ result: BookingResult }>(
    `select create_reservation(
        $1::jsonb, $2::date, $3::date,
        jsonb_build_array(jsonb_build_object('roomTypeId', $4::text, 'ratePlanId', null, 'qty', $5::int)),
        'website', null, null, 'T') as result`,
    [
      JSON.stringify({ name: `Guest ${TAG}`, phone: "+910000000000", notes: TAG }),
      checkIn,
      checkOut,
      typeId,
      qty,
    ],
  );
  return rows[0].result;
}

/** Take specific units off sale, to engineer an exact free-bed count. */
async function blockUnits(unitIds: string[], checkIn: string, checkOut: string) {
  for (const id of unitIds) {
    await admin.query(
      `insert into allocations (unit_id, reason, stay)
       values ($1, 'maintenance', daterange($2::date, $3::date, '[)'))`,
      [id, checkIn, checkOut],
    );
  }
}

async function freeUnits(typeId: string, checkIn: string, checkOut: string) {
  const { rows } = await admin.query<{ unit_id: string; room_id: string }>(
    `select unit_id, room_id from free_units_for_stay($1, $2, $3)`,
    [typeId, checkIn, checkOut],
  );
  return rows;
}

async function allocationCount(typeId: string): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(
    `select count(*) as n from allocations
      where unit_id in (select id from units where room_type_id = $1)`,
    [typeId],
  );
  return Number(rows[0].n);
}

/** Events written for a given reservation. */
async function eventsFor(reservationId: string) {
  const { rows } = await admin.query<{ kind: string; summary: string; payload: unknown }>(
    `select kind, summary, payload from events where reservation_id = $1 order by at`,
    [reservationId],
  );
  return rows;
}

/** Total events, for proving a rollback left none behind. */
async function eventCount(): Promise<number> {
  const { rows } = await admin.query<{ n: string }>(`select count(*) as n from events`);
  return Number(rows[0].n);
}

before(async () => {
  admin = new Client({ connectionString: CONNECTION });
  await admin.connect();
});

after(async () => {
  // Children first: allocations -> reservations -> units -> beds -> rooms -> types.
  await admin.query(
    `delete from allocations where unit_id in (
       select u.id from units u join room_types rt on rt.id = u.room_type_id
        where rt.code like $1)`,
    [`${TAG}%`],
  );
  await admin.query(`delete from reservations where notes = $1`, [TAG]);
  await admin.query(
    `delete from units where room_type_id in (select id from room_types where code like $1)`,
    [`${TAG}%`],
  );
  await admin.query(
    `delete from beds where room_id in (
       select r.id from rooms r join room_types rt on rt.id = r.room_type_id where rt.code like $1)`,
    [`${TAG}%`],
  );
  await admin.query(
    `delete from rooms where room_type_id in (select id from room_types where code like $1)`,
    [`${TAG}%`],
  );
  await admin.query(`delete from guests where name = $1`, [`Guest ${TAG}`]);
  await admin.query(`delete from room_types where code like $1`, [`${TAG}%`]);
  // Events are deliberately NOT cleaned up: they are immutable by design, and
  // the DELETE trigger would refuse anyway.
  await admin.end();
});

describe("events", () => {
  it("a group booking of four beds writes exactly ONE event", async () => {
    const typeId = await makeType("EV_GROUP", "per_bed", [{ number: "A", beds: 6 }]);
    const result = await reserve(admin, typeId, "2027-09-01", "2027-09-03", 4);
    assert.equal(result.ok, true);
    assert.equal(result.allocations?.length, 4);

    // Four allocations, one desk action, one event.
    const evts = await eventsFor(result.reservation!.id);
    assert.equal(evts.length, 1, "one event per operation, not per allocation");
    assert.equal(evts[0].kind, "reservation.created");
    assert.equal((evts[0].payload as { units: number }).units, 4);
  });

  it("a booking that rolls back writes NO event", async () => {
    const typeId = await makeType("EV_FAIL", "per_bed", [{ number: "A", beds: 2 }]);
    const before = await eventCount();

    // Ask for more beds than exist: the subtransaction unwinds, event included.
    const result = await reserve(admin, typeId, "2027-09-05", "2027-09-07", 3);
    assert.equal(result.ok, false);
    assert.equal(result.code, "UNITS_TAKEN");

    assert.equal(
      await eventCount(),
      before,
      "a failed booking must leave no trace in the feed",
    );
  });

  it("a failed group booking leaves zero events, allocations and orphan reservations", async () => {
    const typeId = await makeType("EV_ATOMIC", "per_bed", [{ number: "A", beds: 2 }]);
    const beforeEvents = await eventCount();

    const result = await reserve(admin, typeId, "2027-09-11", "2027-09-13", 3);
    assert.equal(result.ok, false);
    assert.equal(result.code, "UNITS_TAKEN");

    assert.equal(await eventCount(), beforeEvents, "zero events");
    assert.equal(await allocationCount(typeId), 0, "zero allocations");

    const { rows } = await admin.query<{ n: string }>(
      `select count(*) as n from reservations r
        where r.notes = $1 and r.status <> 'cancelled'
          and not exists (select 1 from allocations a where a.reservation_id = r.id)`,
      [TAG],
    );
    assert.equal(rows[0].n, "0", "zero orphan reservations");
  });

  it("cancel, move and block each write exactly one event", async () => {
    const typeId = await makeType("EV_OPS", "per_bed", [
      { number: "A", beds: 2 },
      { number: "B", beds: 2 },
    ]);

    // --- create
    const booked = await reserve(admin, typeId, "2027-10-01", "2027-10-03", 1);
    assert.equal(booked.ok, true);
    const resId = booked.reservation!.id;

    // --- move to a free unit in the other room
    const { rows: alloc } = await admin.query<{ id: string }>(
      `select id from allocations where reservation_id = $1`,
      [resId],
    );
    const free = await freeUnits(typeId, "2027-10-01", "2027-10-03");
    const { rows: moved } = await admin.query<{ result: { ok: boolean } }>(
      `select move_allocation($1, $2, null, 'Reception') as result`,
      [alloc[0].id, free[0].unit_id],
    );
    assert.equal(moved[0].result.ok, true);

    // --- block another unit
    const stillFree = await freeUnits(typeId, "2027-10-01", "2027-10-03");
    const { rows: blocked } = await admin.query<{ result: { ok: boolean } }>(
      `select block_unit($1, '2027-10-01', '2027-10-03', 'maintenance', null, 'Reception') as result`,
      [stillFree[0].unit_id],
    );
    assert.equal(blocked[0].result.ok, true);

    // --- cancel
    const { rows: cancelled } = await admin.query<{ result: { ok: boolean } }>(
      `select cancel_reservation($1, null, 'Reception') as result`,
      [resId],
    );
    assert.equal(cancelled[0].result.ok, true);

    const kinds = (await eventsFor(resId)).map((e) => e.kind);
    assert.deepEqual(
      kinds,
      ["reservation.created", "allocation.moved", "reservation.cancelled"],
      "one event per operation, in order",
    );

    // block_unit has no reservation, so it is counted separately.
    const { rows: blocks } = await admin.query<{ n: string }>(
      `select count(*) as n from events where kind = 'unit.blocked' and unit_id = $1`,
      [stillFree[0].unit_id],
    );
    assert.equal(blocks[0].n, "1");
  });
});

describe("events are immutable", () => {
  let eventId: string;

  before(async () => {
    const typeId = await makeType("EV_IMMUT", "per_room", [{ number: "1", beds: 0 }]);
    const booked = await reserve(admin, typeId, "2027-11-01", "2027-11-03", 1);
    assert.equal(booked.ok, true);
    const { rows } = await admin.query<{ id: string }>(
      `select id from events where reservation_id = $1`,
      [booked.reservation!.id],
    );
    eventId = rows[0].id;
  });

  /** Run a statement as a specific Postgres role, then restore. */
  async function asRole(role: string, sql: string) {
    const client = new Client({ connectionString: CONNECTION });
    await client.connect();
    try {
      await client.query("set statement_timeout = '10s'");
      await client.query(`set role ${role}`);
      await client.query(sql, [eventId]);
      return null;
    } catch (err) {
      return err as { code?: string; message: string };
    } finally {
      await client.end();
    }
  }

  it("UPDATE is refused for authenticated (permission denied)", async () => {
    const err = await asRole("authenticated", `update events set summary = 'tampered' where id = $1`);
    assert.ok(err, "update must fail");
    // 42501 = insufficient_privilege, i.e. the GRANT was revoked.
    assert.equal(err!.code, "42501", `expected permission denied, got ${err!.message}`);
  });

  it("DELETE is refused for authenticated (permission denied)", async () => {
    const err = await asRole("authenticated", `delete from events where id = $1`);
    assert.ok(err, "delete must fail");
    assert.equal(err!.code, "42501", `expected permission denied, got ${err!.message}`);
  });

  it("UPDATE is refused for service_role (BEFORE UPDATE trigger)", async () => {
    // service_role has the grant, so this reaches — and must be stopped by — the trigger.
    const err = await asRole("service_role", `update events set summary = 'tampered' where id = $1`);
    assert.ok(err, "update must fail");
    assert.match(err!.message, /immutable/i, `expected the trigger, got ${err!.message}`);
  });

  it("DELETE is refused for service_role (BEFORE DELETE trigger)", async () => {
    const err = await asRole("service_role", `delete from events where id = $1`);
    assert.ok(err, "delete must fail");
    assert.match(err!.message, /immutable/i, `expected the trigger, got ${err!.message}`);
  });

  it("the event survived every attempt unchanged", async () => {
    const { rows } = await admin.query<{ summary: string }>(
      `select summary from events where id = $1`,
      [eventId],
    );
    assert.equal(rows.length, 1, "event must still exist");
    assert.notEqual(rows[0].summary, "tampered");
  });
});

describe("allocations exclusion constraint", () => {
  it("two concurrent reservations for the last unit: exactly one wins", async () => {
    const typeId = await makeType("SINGLE", "per_room", [{ number: "1", beds: 0 }]);
    const a = new Client({ connectionString: CONNECTION });
    const b = new Client({ connectionString: CONNECTION });
    await a.connect();
    await b.connect();

    try {
      const { rows: bPid } = await b.query<{ pid: number }>("select pg_backend_pid() as pid");
      await a.query("begin");
      await b.query("begin");

      const aResult = await reserve(a, typeId, "2027-03-01", "2027-03-04");
      assert.equal(aResult.ok, true, "first caller should win");

      // B still sees the unit free (A uncommitted), attempts the insert, blocks.
      const bPending = reserve(b, typeId, "2027-03-01", "2027-03-04");
      await waitUntilBlocked(bPid[0].pid);
      await a.query("commit");

      const bResult = await bPending;
      await b.query("commit");

      assert.equal(bResult.ok, false, "second caller must lose");
      assert.equal(bResult.code, "UNITS_TAKEN");
      assert.equal(await allocationCount(typeId), 1, "unit held exactly once");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("a stay ending on the 4th does not collide with one starting on the 4th", async () => {
    const typeId = await makeType("ADJACENT", "per_room", [{ number: "1", beds: 0 }]);

    // Half-open [) ranges: check-out day is free for the next guest.
    const leaving = await reserve(admin, typeId, "2027-04-01", "2027-04-04");
    assert.equal(leaving.ok, true, "departing stay should be created");

    const arriving = await reserve(admin, typeId, "2027-04-04", "2027-04-06");
    assert.equal(arriving.ok, true, "arrival on the departure date must not be blocked");

    // Same single unit reused — proves no false overlap, not a second unit.
    assert.equal(
      arriving.allocations?.[0].unitId,
      leaving.allocations?.[0].unitId,
      "both stays should occupy the same unit",
    );

    const overlapping = await reserve(admin, typeId, "2027-04-03", "2027-04-05");
    assert.equal(overlapping.ok, false, "a genuinely overlapping stay must be rejected");
    assert.equal(overlapping.code, "UNITS_TAKEN");
  });
});

describe("group reservations", () => {
  it("a 4-bed group and a 1-bed booking racing for the last bed: one wins, one UNITS_TAKEN", async () => {
    // A 6-bed dorm with exactly 4 beds free.
    const typeId = await makeType("RACE", "per_bed", [{ number: "A", beds: 6 }]);
    const all = await freeUnits(typeId, "2027-05-01", "2027-05-03");
    await blockUnits(all.slice(0, 2).map((u) => u.unit_id), "2027-05-01", "2027-05-03");

    const a = new Client({ connectionString: CONNECTION });
    const b = new Client({ connectionString: CONNECTION });
    await a.connect();
    await b.connect();

    try {
      const { rows: bPid } = await b.query<{ pid: number }>("select pg_backend_pid() as pid");
      await a.query("begin");
      await b.query("begin");

      // The group takes all four remaining beds, uncommitted.
      const group = await reserve(a, typeId, "2027-05-01", "2027-05-03", 4);
      assert.equal(group.ok, true, "group of 4 should get the last four beds");
      assert.equal(group.allocations?.length, 4);

      // The solo traveller still sees a free bed, tries to take it, blocks.
      const soloPending = reserve(b, typeId, "2027-05-01", "2027-05-03", 1);
      await waitUntilBlocked(bPid[0].pid);
      await a.query("commit");

      const solo = await soloPending;
      await b.query("commit");

      assert.equal(solo.ok, false, "solo booking must lose the race");
      assert.equal(solo.code, "UNITS_TAKEN");
      assert.equal(solo.requested, 1);

      // 2 maintenance blocks + 4 group beds, and nothing from the loser.
      assert.equal(await allocationCount(typeId), 6);
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("a group booking that fails on its third unit leaves ZERO allocations", async () => {
    // Three beds free; a concurrent transaction steals the third mid-booking.
    const typeId = await makeType("PARTIAL", "per_bed", [{ number: "A", beds: 3 }]);
    const ordered = await freeUnits(typeId, "2027-06-01", "2027-06-03");
    assert.equal(ordered.length, 3);
    const thirdUnit = ordered[2].unit_id; // the one the allocator takes last

    const thief = new Client({ connectionString: CONNECTION });
    const group = new Client({ connectionString: CONNECTION });
    await thief.connect();
    await group.connect();

    try {
      const { rows: gPid } = await group.query<{ pid: number }>(
        "select pg_backend_pid() as pid",
      );

      // Thief holds the third bed, uncommitted.
      await thief.query("begin");
      await thief.query(
        `insert into allocations (unit_id, reason, stay)
         values ($1, 'maintenance', daterange('2027-06-01','2027-06-03','[)'))`,
        [thirdUnit],
      );

      // The group still sees all three free; beds 1 and 2 insert fine, bed 3 blocks.
      await group.query("begin");
      const pending = reserve(group, typeId, "2027-06-01", "2027-06-03", 3);
      await waitUntilBlocked(gPid[0].pid);
      await thief.query("commit");

      const result = await pending;
      await group.query("commit");

      assert.equal(result.ok, false, "the group booking must fail");
      assert.equal(result.code, "UNITS_TAKEN");
      assert.equal(result.requested, 3);

      // The whole point: beds 1 and 2 must NOT be left allocated.
      assert.equal(
        await allocationCount(typeId),
        1,
        "only the thief's block should remain — zero partial allocations",
      );
      // An orphan is a LIVE reservation holding no inventory. A cancelled one
      // legitimately has none — cancelling releases its allocations by design.
      const { rows: orphans } = await admin.query<{ n: string }>(
        `select count(*) as n from reservations r
          where r.notes = $1
            and r.status <> 'cancelled'
            and not exists (select 1 from allocations a where a.reservation_id = r.id)`,
        [TAG],
      );
      assert.equal(orphans[0].n, "0", "no orphaned reservation either");
    } finally {
      await thief.end();
      await group.end();
    }
  });

  it("allocates regardless of gender_policy — dorms are mixed", async () => {
    const typeId = await makeType("MIXED", "per_bed", [{ number: "A", beds: 2 }]);
    // Even with the strictest policy set on the type, and no gender on the guest,
    // allocation must proceed: gender_policy is not read by the allocator.
    await admin.query(`update room_types set gender_policy = 'female_only' where id = $1`, [
      typeId,
    ]);

    const result = await reserve(admin, typeId, "2027-08-01", "2027-08-03", 2);
    assert.equal(result.ok, true, "gender must not influence allocation");
    assert.equal(result.allocations?.length, 2);
  });

  it("a group of 4 with 4 free beds in one room gets all 4 in the same room", async () => {
    // Two dorm rooms. Room A can only fit 3; room B fits all 4.
    const typeId = await makeType("SAMEROOM", "per_bed", [
      { number: "A", beds: 6 },
      { number: "B", beds: 6 },
    ]);
    const all = await freeUnits(typeId, "2027-07-01", "2027-07-03");
    const byRoom = new Map<string, string[]>();
    for (const u of all) {
      byRoom.set(u.room_id, [...(byRoom.get(u.room_id) ?? []), u.unit_id]);
    }
    const [roomA, roomB] = [...byRoom.keys()];
    // Leave A with 3 free and B with 4 free.
    await blockUnits(
      [...byRoom.get(roomA)!.slice(0, 3), ...byRoom.get(roomB)!.slice(0, 2)],
      "2027-07-01",
      "2027-07-03",
    );

    const result = await reserve(admin, typeId, "2027-07-01", "2027-07-03", 4);
    assert.equal(result.ok, true, "the group should be placed");
    assert.equal(result.allocations?.length, 4);

    const { rows } = await admin.query<{ rooms: string }>(
      `select count(distinct u.room_id) as rooms from units u where u.id = any($1::uuid[])`,
      [result.allocations!.map((a) => a.unitId)],
    );
    assert.equal(rows[0].rooms, "1", "all four beds must be in one room");

    // And specifically the room that could hold them — not the 3-bed remainder.
    const { rows: which } = await admin.query<{ room_id: string }>(
      `select distinct room_id from units where id = any($1::uuid[])`,
      [result.allocations!.map((a) => a.unitId)],
    );
    assert.equal(which[0].room_id, roomB, "should pick the room with enough beds");
  });
});
