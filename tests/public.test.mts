/**
 * Public availability and quoting (ROADMAP M3 item 1).
 *
 * These are the ONLY functions granted to `anon`, so what they refuse to return
 * matters as much as what they do.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

const TAG = `PUB_${Date.now().toString(36).toUpperCase()}`;
const RATE = 50000; // ₹500/night

let db: Client;
let typeId: string;
let planId: string;

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

type Night = { date: string; free: number; bookable: boolean; pricePaise: number | null };

async function availability(from?: string, to?: string) {
  const { rows } = await db.query<{ a: { ok: boolean; from: string; to: string; nights: Night[] } }>(
    `select public_availability($1, $2::date, $3::date) as a`,
    [typeId, from ?? null, to ?? null],
  );
  return rows[0].a;
}

async function quote(from: string, to: string, units = 1) {
  const { rows } = await db.query<{ q: Record<string, unknown> }>(
    `select public_quote($1, $2::date, $3::date, $4) as q`,
    [typeId, from, to, units],
  );
  return rows[0].q as {
    ok: boolean;
    code?: string;
    nights?: number;
    unitTotalPaise?: number;
    totalPaise?: number;
    perNight?: { date: string; pricePaise: number }[];
  };
}

/** Set the direct allotment for a date range. */
async function allot(units: number, from: string, days: number) {
  await db.query(
    `insert into direct_allotment (room_type_id, stay_date, units_for_direct)
     select $1, d::date, $2 from generate_series($3::date, $3::date + $4::int, interval '1 day') d
     on conflict (room_type_id, stay_date) do update set units_for_direct = excluded.units_for_direct`,
    [typeId, units, from, days],
  );
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '10s'");

  const { rows } = await db.query<{ id: string }>(
    `insert into room_types (code, name, sell_mode, base_occupancy, max_occupancy, sort_order)
     values ($1, $1, 'per_bed', 1, 4, 993) returning id`,
    [TAG],
  );
  typeId = rows[0].id;

  const { rows: room } = await db.query<{ id: string }>(
    `insert into rooms (room_type_id, number, name, type, total_beds, is_dorm)
     values ($1, $2, $2, 'dorm', 4, true) returning id`,
    [typeId, `${TAG}-D`],
  );
  for (let i = 1; i <= 4; i += 1) {
    await db.query(`insert into beds (room_id, label) values ($1, $2)`, [room[0].id, `B${i}`]);
  }

  const { rows: plan } = await db.query<{ id: string }>(
    `insert into rate_plans (room_type_id, name) values ($1, 'Direct Flex') returning id`,
    [typeId],
  );
  planId = plan[0].id;
  await db.query(
    `insert into rates (room_type_id, rate_plan_id, stay_date, price_paise)
     select $1, $2, d::date, $3
       from generate_series(current_date, current_date + 60, interval '1 day') d`,
    [typeId, planId, RATE],
  );
  await allot(4, todayISO(), 60);
});

after(async () => {
  await db.query(`delete from direct_allotment where room_type_id = $1`, [typeId]);
  await db.query(`delete from rates where room_type_id = $1`, [typeId]);
  await db.query(`delete from rate_plans where room_type_id = $1`, [typeId]);
  await db.query(
    `delete from allocations where unit_id in (select id from units where room_type_id = $1)`,
    [typeId],
  );
  await db.query(`delete from units where room_type_id = $1`, [typeId]);
  await db.query(
    `delete from beds where room_id in (select id from rooms where room_type_id = $1)`,
    [typeId],
  );
  await db.query(`delete from rooms where room_type_id = $1`, [typeId]);
  await db.query(`delete from room_types where id = $1`, [typeId]);
  await db.end();
});

describe("public_availability", () => {
  it("returns a night per date, with free counts and prices", async () => {
    const a = await availability(todayISO(), plus(todayISO(), 3));
    assert.equal(a.ok, true);
    assert.equal(a.nights.length, 3);
    assert.equal(a.nights[0].free, 4);
    assert.equal(a.nights[0].pricePaise, RATE);
    assert.equal(a.nights[0].bookable, true);
  });

  it("leaks nothing but counts and prices", async () => {
    const a = await availability(todayISO(), plus(todayISO(), 2));
    const keys = Object.keys(a.nights[0]).sort();
    assert.deepEqual(
      keys,
      ["bookable", "date", "free", "pricePaise"],
      "a public endpoint must not return unit or reservation ids",
    );
  });

  it("shows every physically free bed — inventory is pooled", async () => {
    // An allotment row must have no effect: since the channel-manager redesign
    // inventory is always physical units minus allocations, and only the way it
    // is DISTRIBUTED varies.
    await allot(2, todayISO(), 3);
    const a = await availability(todayISO(), plus(todayISO(), 2));
    assert.equal(a.nights[0].free, 4, "all four beds, not the old allotment's two");
    await allot(4, todayISO(), 60);
  });

  it("refuses to look into the past and clamps a silly range", async () => {
    const a = await availability(plus(todayISO(), -30), plus(todayISO(), 5));
    assert.equal(a.from, todayISO(), "the past is not sellable");

    const wide = await availability(todayISO(), plus(todayISO(), 5000));
    assert.ok(wide.nights.length <= 400, "the window is capped");
  });

  it("marks a night unbookable when it has no price", async () => {
    const gap = plus(todayISO(), 10);
    await db.query(`delete from rates where room_type_id = $1 and stay_date = $2`, [typeId, gap]);

    const a = await availability(gap, plus(gap, 1));
    assert.equal(a.nights[0].pricePaise, null);
    assert.equal(a.nights[0].bookable, false, "no price means not for sale");

    await db.query(
      `insert into rates (room_type_id, rate_plan_id, stay_date, price_paise) values ($1,$2,$3,$4)`,
      [typeId, planId, gap, RATE],
    );
  });

  it("rejects an unknown room type instead of returning an empty calendar", async () => {
    const { rows } = await db.query<{ a: { ok: boolean; code: string } }>(
      `select public_availability('00000000-0000-0000-0000-000000000000'::uuid) as a`,
    );
    assert.equal(rows[0].a.ok, false);
    assert.equal(rows[0].a.code, "UNKNOWN_ROOM_TYPE");
  });
});

describe("public_quote", () => {
  it("prices a stay from the rate calendar, per night", async () => {
    const q = await quote(todayISO(), plus(todayISO(), 3));
    assert.equal(q.ok, true);
    assert.equal(q.nights, 3, "three nights — checkout day is not a night");
    assert.equal(q.perNight!.length, 3);
    assert.equal(q.unitTotalPaise, RATE * 3);
    assert.equal(q.totalPaise, RATE * 3);
  });

  it("multiplies by the number of beds", async () => {
    const q = await quote(todayISO(), plus(todayISO(), 2), 3);
    assert.equal(q.ok, true);
    assert.equal(q.unitTotalPaise, RATE * 2, "per bed");
    assert.equal(q.totalPaise, RATE * 2 * 3, "for three beds");
  });

  it("refuses when the allotment can't cover the request", async () => {
    const q = await quote(todayISO(), plus(todayISO(), 2), 9);
    assert.equal(q.ok, false);
    assert.equal(q.code, "NOT_AVAILABLE");
  });

  it("refuses rather than guessing when a night has no rate", async () => {
    const gap = plus(todayISO(), 12);
    await db.query(`delete from rates where room_type_id = $1 and stay_date = $2`, [typeId, gap]);

    const q = await quote(plus(gap, -1), plus(gap, 1));
    assert.equal(q.ok, false);
    assert.equal(q.code, "NO_RATE", "a wrong price is worse than no price");

    await db.query(
      `insert into rates (room_type_id, rate_plan_id, stay_date, price_paise) values ($1,$2,$3,$4)`,
      [typeId, planId, gap, RATE],
    );
  });

  it("refuses past dates, reversed dates and absurd lengths", async () => {
    assert.equal((await quote(plus(todayISO(), -2), todayISO())).code, "IN_THE_PAST");
    assert.equal((await quote(plus(todayISO(), 3), plus(todayISO(), 1))).code, "INVALID_DATES");
    assert.equal((await quote(todayISO(), plus(todayISO(), 90))).code, "TOO_LONG");
  });

  it("stops quoting a night once it is actually booked out", async () => {
    const from = plus(todayISO(), 20);
    const to = plus(from, 1);

    const before = await quote(from, to, 1);
    assert.equal(before.ok, true, "beds are sellable");

    // Take every physical bed: pooled inventory runs out only when the beds do.
    const { rows: res } = await db.query<{ r: { ok: boolean; reservation: { id: string } } }>(
      `select create_reservation(
         jsonb_build_object('name', $1::text, 'phone', '+91'),
         $2::date, $3::date,
         jsonb_build_array(jsonb_build_object('roomTypeId', $4::text, 'ratePlanId', null, 'qty', 4)),
         'website', null, null, 'T') as r`,
      [`Taker ${TAG}`, from, to, typeId],
    );
    assert.equal(res[0].r.ok, true, "the booking itself succeeded");

    const after = await quote(from, to, 1);
    assert.equal(after.ok, false, "there is genuinely nothing left");
    assert.equal(after.code, "NOT_AVAILABLE");

    // Guests are referenced by reservations, so unwind in dependency order.
    const resId = res[0].r.reservation.id;
    await db.query(`delete from allocations where reservation_id = $1`, [resId]);
    await db.query(`delete from reservation_guests where reservation_id = $1`, [resId]);
    await db.query(`delete from reservations where id = $1`, [resId]);
    await db.query(`delete from guests where name = $1`, [`Taker ${TAG}`]);
    await allot(4, todayISO(), 60);
  });
});
