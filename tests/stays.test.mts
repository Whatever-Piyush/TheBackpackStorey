/**
 * Occupancy board and unit moves (ROADMAP M2 item 1).
 *
 * The board itself is a read, but `move_allocation` writes — and the roadmap is
 * specific that a refused move must say WHICH reservation is in the way, because
 * reception is standing in front of a guest when it happens.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

const TAG = `BOARD_${Date.now().toString(36).toUpperCase()}`;
const OWNER = "55555555-5555-5555-5555-555555555555";

let db: Client;
let typeId: string;
let units: { unitId: string; number: string }[] = [];

async function reserve(name: string, from: string, to: string) {
  const { rows } = await db.query<{
    r: { ok: boolean; reservation?: { id: string; code: string }; allocations?: { unitId: string }[] };
  }>(
    `select create_reservation(
       jsonb_build_object('name', $1::text, 'phone', '+910000000000', 'notes', $2::text),
       $3::date, $4::date,
       jsonb_build_array(jsonb_build_object('roomTypeId', $5::text, 'ratePlanId', null, 'qty', 1)),
       'walk_in', null, null, 'T') as r`,
    [name, TAG, from, to, typeId],
  );
  assert.ok(rows[0].r.ok, `fixture booking failed: ${JSON.stringify(rows[0].r)}`);
  return rows[0].r;
}

async function allocationOf(reservationId: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `select id from allocations where reservation_id = $1 limit 1`,
    [reservationId],
  );
  return rows[0].id;
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '10s'");

  await db.query(
    `insert into auth.users (id, email) values ($1, 'board@local') on conflict (id) do nothing`,
    [OWNER],
  );
  await db.query(
    `insert into profiles (id, full_name, role) values ($1, 'Board Test', 'owner')
     on conflict (id) do update set role = 'owner'`,
    [OWNER],
  );
  await db.query(`set request.jwt.claim.sub = '${OWNER}'`);

  // Two private rooms of one isolated type, so a move has somewhere to go.
  const { rows } = await db.query<{ id: string }>(
    `insert into room_types (code, name, sell_mode, base_occupancy, max_occupancy, sort_order)
     values ($1, $1, 'per_room', 1, 2, 998) returning id`,
    [TAG],
  );
  typeId = rows[0].id;

  for (const n of ["A", "B"]) {
    await db.query(
      `insert into rooms (room_type_id, number, name, type, total_beds, is_dorm)
       values ($1, $2, $2, 'deluxe', 1, false)`,
      [typeId, `${TAG}-${n}`],
    );
  }
  const { rows: u } = await db.query<{ unitId: string; number: string }>(
    `select u.id as "unitId", r.number from units u join rooms r on r.id = u.room_id
      where u.room_type_id = $1 order by r.number`,
    [typeId],
  );
  units = u;
  assert.equal(units.length, 2, "fixture should have two units");
});

after(async () => {
  await db.query(
    `delete from allocations where unit_id in (select id from units where room_type_id = $1)`,
    [typeId],
  );
  await db.query(
    `delete from folios where reservation_id in (
       select r.id from reservations r join guests g on g.id = r.guest_id where g.name like $1)`,
    [`%${TAG}`],
  );
  await db.query(`delete from reservations where notes = $1`, [TAG]);
  await db.query(`delete from guests where name like $1`, [`%${TAG}`]);
  await db.query(`delete from units where room_type_id = $1`, [typeId]);
  await db.query(`delete from rooms where room_type_id = $1`, [typeId]);
  await db.query(`delete from room_types where id = $1`, [typeId]);
  await db.end();
});

describe("stays_board", () => {
  it("returns the window, its dates, and dorm beds nested under their room", async () => {
    const { rows } = await db.query<{ b: Record<string, unknown> }>(
      `select stays_board('2027-12-01', 14) as b`,
    );
    const board = rows[0].b as {
      from: string;
      days: number;
      dates: string[];
      rooms: { number: string; sellMode: string; units: { label: string | null }[] }[];
    };

    assert.equal(board.from, "2027-12-01");
    assert.equal(board.days, 14);
    assert.equal(board.dates.length, 14, "one column per night");
    assert.equal(board.dates[13], "2027-12-14");

    // The seeded six-bed dorm must arrive as ONE room carrying six units.
    const dorm = board.rooms.find((r) => r.sellMode === "per_bed");
    assert.ok(dorm, "the dorm should be on the board");
    assert.equal(dorm!.units.length, 6, "six beds nested under one room");
    assert.ok(
      dorm!.units.every((u) => u.label !== null),
      "each dorm unit is a labelled bed",
    );

    // A private room is a single unit whose label is null — the room IS the unit.
    const priv = board.rooms.find((r) => r.sellMode === "per_room");
    assert.equal(priv!.units.length, 1);
    assert.equal(priv!.units[0].label, null);
  });

  it("includes stays overlapping the window and excludes those outside it", async () => {
    const inside = await reserve(`Inside ${TAG}`, "2027-12-05", "2027-12-08");
    await reserve(`Outside ${TAG}`, "2028-02-01", "2028-02-03");

    const { rows } = await db.query<{ b: { allocations: { reservationId: string }[] } }>(
      `select stays_board('2027-12-01', 14) as b`,
    );
    const ids = rows[0].b.allocations.map((a) => a.reservationId);

    assert.ok(ids.includes(inside.reservation!.id), "overlapping stay is shown");
    assert.equal(
      rows[0].b.allocations.filter((a) => a.reservationId === null).length,
      0,
      "no stray blocks in this fixture",
    );
  });
});

describe("moving a booking", () => {
  it("moves to a free unit of the same type", async () => {
    const booking = await reserve(`Mover ${TAG}`, "2027-12-20", "2027-12-22");
    const allocId = await allocationOf(booking.reservation!.id);
    const currentUnit = booking.allocations![0].unitId;
    const target = units.find((u) => u.unitId !== currentUnit)!;

    const { rows } = await db.query<{ r: { ok: boolean } }>(
      `select move_allocation($1, $2, $3, 'Reception') as r`,
      [allocId, target.unitId, OWNER],
    );
    assert.equal(rows[0].r.ok, true);

    const { rows: after } = await db.query<{ unit_id: string }>(
      `select unit_id from allocations where id = $1`,
      [allocId],
    );
    assert.equal(after[0].unit_id, target.unitId, "the allocation actually moved");
  });

  it("refuses a clashing move and NAMES the reservation in the way", async () => {
    // Two stays on the same nights, one in each unit.
    const stay = await reserve(`Stayer ${TAG}`, "2028-01-10", "2028-01-14");
    const other = await reserve(`Blocker ${TAG}`, "2028-01-10", "2028-01-14");

    const stayAlloc = await allocationOf(stay.reservation!.id);
    const occupiedUnit = other.allocations![0].unitId;

    const { rows } = await db.query<{
      r: {
        ok: boolean;
        code: string;
        toRoom: string;
        conflict: { reason: string; code: string; guestName: string; from: string; to: string } | null;
      };
    }>(`select move_allocation($1, $2, $3, 'Reception') as r`, [
      stayAlloc,
      occupiedUnit,
      OWNER,
    ]);

    assert.equal(rows[0].r.ok, false);
    assert.equal(rows[0].r.code, "UNIT_TAKEN");

    // The whole point: reception must be told who is in the way.
    const c = rows[0].r.conflict;
    assert.ok(c, "conflict details must be returned");
    assert.equal(c!.reason, "booking");
    assert.equal(c!.guestName, `Blocker ${TAG}`);
    assert.equal(c!.code, other.reservation!.code);
    assert.equal(c!.from, "2028-01-10");

    // And the losing move changed nothing.
    const { rows: unchanged } = await db.query<{ unit_id: string }>(
      `select unit_id from allocations where id = $1`,
      [stayAlloc],
    );
    assert.notEqual(unchanged[0].unit_id, occupiedUnit);
  });

  it("allows a move into a unit whose previous stay ends that morning", async () => {
    // Half-open ranges: checkout day is free for the next guest.
    const leaving = await reserve(`Leaving ${TAG}`, "2028-03-01", "2028-03-04");
    const arriving = await reserve(`Arriving ${TAG}`, "2028-03-04", "2028-03-06");

    const arrivingAlloc = await allocationOf(arriving.reservation!.id);
    const leavingUnit = leaving.allocations![0].unitId;

    const { rows } = await db.query<{ r: { ok: boolean; code?: string } }>(
      `select move_allocation($1, $2, $3, 'Reception') as r`,
      [arrivingAlloc, leavingUnit, OWNER],
    );
    assert.equal(
      rows[0].r.ok,
      true,
      `arrival on the departure date must be allowed, got ${JSON.stringify(rows[0].r)}`,
    );
  });

  it("reports a maintenance block as the obstruction, not a phantom guest", async () => {
    const stay = await reserve(`Blocked ${TAG}`, "2028-04-10", "2028-04-12");
    const stayAlloc = await allocationOf(stay.reservation!.id);
    const target = units.find((u) => u.unitId !== stay.allocations![0].unitId)!;

    await db.query(
      `insert into allocations (unit_id, reason, stay)
       values ($1, 'maintenance', daterange('2028-04-10','2028-04-12','[)'))`,
      [target.unitId],
    );

    const { rows } = await db.query<{
      r: { ok: boolean; conflict: { reason: string; guestName: string | null } | null };
    }>(`select move_allocation($1, $2, $3, 'Reception') as r`, [
      stayAlloc,
      target.unitId,
      OWNER,
    ]);

    assert.equal(rows[0].r.ok, false);
    assert.equal(rows[0].r.conflict?.reason, "maintenance");
    assert.equal(rows[0].r.conflict?.guestName, null, "a block has no guest");
  });
});
