/**
 * Booking API support (ROADMAP M4).
 *
 * Rate limiting, idempotency and the guest lookup. These are the parts that stop
 * a public write endpoint from being abused or double-firing, so they are tested
 * at the database level where they actually live.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

const TAG = `API_${Date.now().toString(36).toUpperCase()}`;

let db: Client;
let typeId: string;

/**
 * "Today" as the DATABASE sees it — Asia/Kolkata, which every server function
 * uses. `new Date().toISOString()` is UTC, so between 18:30 and 24:00 UTC it
 * names the previous day and these tests would ask about the wrong date.
 * IST is a fixed +5:30 with no DST, so the offset is safe to hard-code.
 */
const todayISO = () =>
  new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
function plus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function limit(bucket: string, max: number, windowSeconds = 60) {
  const { rows } = await db.query<{ allowed: boolean }>(
    `select check_rate_limit($1, $2, $3) as allowed`,
    [bucket, max, windowSeconds],
  );
  return rows[0].allowed;
}

async function claim(key: string, fingerprint: string) {
  const { rows } = await db.query<{ c: Record<string, unknown> }>(
    `select claim_idempotency_key($1, $2) as c`,
    [key, fingerprint],
  );
  return rows[0].c as {
    claimed: boolean;
    code?: string;
    status?: string;
    response?: { ref?: string };
  };
}

async function lookup(code: string, phone: string) {
  const { rows } = await db.query<{ r: Record<string, unknown> }>(
    `select public_booking_lookup($1, $2) as r`,
    [code, phone],
  );
  return rows[0].r as { ok: boolean; code?: string; guestName?: string; totalPaise?: number };
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '10s'");

  const { rows } = await db.query<{ id: string }>(
    `insert into room_types (code, name, sell_mode, base_occupancy, max_occupancy, sort_order)
     values ($1, $1, 'per_room', 1, 2, 992) returning id`,
    [TAG],
  );
  typeId = rows[0].id;

  for (let n = 1; n <= 4; n += 1) {
    await db.query(
      `insert into rooms (room_type_id, number, name, type, total_beds, is_dorm)
       values ($1, $2, $2, 'deluxe', 1, false)`,
      [typeId, `${TAG}-${n}`],
    );
  }
  const { rows: plan } = await db.query<{ id: string }>(
    `insert into rate_plans (room_type_id, name) values ($1, 'Direct Flex') returning id`,
    [typeId],
  );
  await db.query(
    `insert into rates (room_type_id, rate_plan_id, stay_date, price_paise)
     select $1, $2, d::date, 100000
       from generate_series(current_date, current_date + 60, interval '1 day') d`,
    [typeId, plan[0].id],
  );
  await db.query(
    `insert into direct_allotment (room_type_id, stay_date, units_for_direct)
     select $1, d::date, 4 from generate_series(current_date, current_date + 60, interval '1 day') d
     on conflict (room_type_id, stay_date) do update set units_for_direct = 4`,
    [typeId],
  );
});

after(async () => {
  await db.query(`delete from rate_limit_hits where bucket like $1`, [`%${TAG}%`]);
  await db.query(`delete from booking_idempotency where key like $1`, [`%${TAG}%`]);
  await db.query(`delete from direct_allotment where room_type_id = $1`, [typeId]);
  await db.query(
    `delete from folio_items where folio_id in (
       select f.id from folios f join reservations r on r.id = f.reservation_id
        where r.guest_id in (select id from guests where name like $1))`,
    [`%${TAG}`],
  );
  await db.query(
    `delete from folios where reservation_id in (
       select id from reservations where guest_id in (select id from guests where name like $1))`,
    [`%${TAG}`],
  );
  await db.query(
    `delete from allocations where unit_id in (select id from units where room_type_id = $1)`,
    [typeId],
  );
  await db.query(
    `delete from reservation_guests where guest_id in (select id from guests where name like $1)`,
    [`%${TAG}`],
  );
  await db.query(
    `delete from reservations where guest_id in (select id from guests where name like $1)`,
    [`%${TAG}`],
  );
  await db.query(`delete from guests where name like $1`, [`%${TAG}`]);
  await db.query(`delete from rates where room_type_id = $1`, [typeId]);
  await db.query(`delete from rate_plans where room_type_id = $1`, [typeId]);
  await db.query(`delete from units where room_type_id = $1`, [typeId]);
  await db.query(`delete from rooms where room_type_id = $1`, [typeId]);
  await db.query(`delete from room_types where id = $1`, [typeId]);
  await db.end();
});

describe("rate limiting", () => {
  it("allows up to the limit, then refuses", async () => {
    const bucket = `book:${TAG}:a`;
    for (let i = 0; i < 3; i += 1) {
      assert.equal(await limit(bucket, 3), true, `attempt ${i + 1} should pass`);
    }
    assert.equal(await limit(bucket, 3), false, "the fourth is refused");
  });

  it("keeps buckets independent, so one guest can't lock out another", async () => {
    const a = `book:${TAG}:x`;
    const b = `book:${TAG}:y`;
    assert.equal(await limit(a, 1), true);
    assert.equal(await limit(a, 1), false, "a is spent");
    assert.equal(await limit(b, 1), true, "b is untouched");
  });

  it("forgets hits outside the window", async () => {
    const bucket = `book:${TAG}:w`;
    await limit(bucket, 1);
    assert.equal(await limit(bucket, 1), false);
    // Backdate the hit past the window rather than sleeping in a test.
    await db.query(`update rate_limit_hits set at = now() - interval '2 hours' where bucket = $1`, [
      bucket,
    ]);
    assert.equal(await limit(bucket, 1, 60), true, "the window has moved on");
  });
});

describe("idempotency", () => {
  it("claims a key once; a second claim is told it's already running", async () => {
    const key = `${TAG}-k1`;
    assert.equal((await claim(key, "fp1")).claimed, true, "first claim wins");

    const second = await claim(key, "fp1");
    assert.equal(second.claimed, false, "a double-click cannot claim it too");
    assert.equal(second.status, "pending");
  });

  it("replays the stored response instead of booking again", async () => {
    const key = `${TAG}-k2`;
    await claim(key, "fp2");
    await db.query(`select complete_idempotency_key($1, $2::jsonb)`, [
      key,
      JSON.stringify({ ok: true, ref: "BS-REPLAY" }),
    ]);

    const replay = await claim(key, "fp2");
    assert.equal(replay.claimed, false);
    assert.equal(replay.status, "done");
    assert.equal(replay.response?.ref, "BS-REPLAY", "the first answer is returned verbatim");
  });

  it("refuses a key reused for different details", async () => {
    const key = `${TAG}-k3`;
    await claim(key, "fp-original");
    const reused = await claim(key, "fp-different");
    assert.equal(reused.claimed, false);
    assert.equal(reused.code, "FINGERPRINT");
  });

  it("releases a claim so a genuine failure can be retried", async () => {
    const key = `${TAG}-k4`;
    await claim(key, "fp4");
    await db.query(`select release_idempotency_key($1)`, [key]);
    assert.equal((await claim(key, "fp4")).claimed, true, "retry is allowed");
  });

  it("never releases a completed key", async () => {
    const key = `${TAG}-k5`;
    await claim(key, "fp5");
    await db.query(`select complete_idempotency_key($1, $2::jsonb)`, [
      key,
      JSON.stringify({ ok: true, ref: "BS-KEEP" }),
    ]);
    await db.query(`select release_idempotency_key($1)`, [key]);

    const after = await claim(key, "fp5");
    assert.equal(after.status, "done", "a finished booking stays finished");
    assert.equal(after.response?.ref, "BS-KEEP");
  });
});

describe("guest lookup", () => {
  let code: string;

  before(async () => {
    const { rows } = await db.query<{ r: { ok: boolean; reservation: { id: string; code: string } } }>(
      `select create_reservation(
         jsonb_build_object('name', $1::text, 'phone', '+91 98166 10852'),
         $2::date, $3::date,
         jsonb_build_array(jsonb_build_object('roomTypeId', $4::text, 'ratePlanId', null, 'qty', 1)),
         'website', null, null, 'T') as r`,
      [`Lookup ${TAG}`, plus(todayISO(), 5), plus(todayISO(), 7), typeId],
    );
    assert.ok(rows[0].r.ok, "fixture booking failed");
    code = rows[0].r.reservation.code;
    // The API posts room charges after booking, so the total is real.
    await db.query(`select ensure_room_charges($1)`, [rows[0].r.reservation.id]);
  });

  it("returns the stay for the right code and phone", async () => {
    const r = await lookup(code, "+91 98166 10852");
    assert.equal(r.ok, true);
    assert.equal(r.guestName, `Lookup ${TAG}`);
    assert.equal(r.totalPaise, 200000, "two nights at ₹1,000");
  });

  it("matches the phone however it was typed", async () => {
    for (const variant of ["9816610852", "098166 10852", "+919816610852"]) {
      assert.equal((await lookup(code, variant)).ok, true, `should match ${variant}`);
    }
  });

  it("refuses the right code with the wrong phone", async () => {
    const r = await lookup(code, "+91 90000 00000");
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_FOUND");
  });

  it("gives an identical answer for a wrong code, so codes can't be enumerated", async () => {
    const wrongCode = await lookup("BS-XXXXXX", "+91 98166 10852");
    const wrongPhone = await lookup(code, "+91 90000 00000");
    assert.deepEqual(
      wrongCode,
      wrongPhone,
      "a bad code and a bad phone must be indistinguishable",
    );
  });

  it("returns no internal identifiers", async () => {
    const r = (await lookup(code, "+91 98166 10852")) as Record<string, unknown>;
    const leaked = Object.keys(r).filter((k) =>
      /reservationid|unitid|guestid|folioid|allocationid/i.test(k),
    );
    assert.deepEqual(leaked, [], "the guest sees their stay, not our ids");
  });
});
