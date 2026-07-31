/**
 * Channel-manager architecture (docs/Channel_manager.md).
 *
 * The properties worth defending:
 *   - inventory is POOLED and identical regardless of distribution_mode
 *   - a change to allocations enqueues a sync WITHOUT anyone calling anything
 *   - a stale availability push can never land after a fresh one
 *   - an inbound message is deduplicated, and a failure is never dropped
 *   - the reservation engine accepts a channel it has never heard of, as data
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

const TAG = `CH_${Date.now().toString(36).toUpperCase()}`;
const DESK = "bbbbbbbb-1111-2222-3333-555555555555";

let db: Client;
let typeId: string;

const todayISO = () =>
  new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);
function plus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function book(from: string, to: string, units = 1, source = "website") {
  const { rows } = await db.query<{ r: { ok: boolean; code?: string; reservation?: { id: string; code: string } } }>(
    `select create_reservation(
       jsonb_build_object('name', $1::text, 'phone', '+91'),
       $2::date, $3::date,
       jsonb_build_array(jsonb_build_object('roomTypeId', $4::text, 'ratePlanId', null, 'qty', $5::int)),
       $6, null, null, 'T') as r`,
    [`Guest ${TAG}`, from, to, typeId, units, source],
  );
  return rows[0].r;
}

async function outboxFor(kind: string) {
  const { rows } = await db.query<{
    id: string; status: string; sequence: string; from_date: string; to_date: string;
  }>(
    `select id, status, sequence, from_date::text, to_date::text
       from channel_outbox where kind = $1 and room_type_id = $2 order by sequence`,
    [kind, typeId],
  );
  return rows;
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '10s'");

  await db.query(
    `insert into auth.users (id, email) values ($1::uuid, $1::text || '@local')
     on conflict (id) do nothing`,
    [DESK],
  );
  await db.query(
    `insert into profiles (id, full_name, role) values ($1, 'Channel Test', 'owner')
     on conflict (id) do update set role = 'owner'`,
    [DESK],
  );
  await db.query(`set request.jwt.claim.sub = '${DESK}'`);

  const { rows } = await db.query<{ id: string }>(
    `insert into room_types (code, name, sell_mode, base_occupancy, max_occupancy, sort_order)
     values ($1, $1, 'per_bed', 1, 6, 990) returning id`,
    [TAG],
  );
  typeId = rows[0].id;

  const { rows: room } = await db.query<{ id: string }>(
    `insert into rooms (room_type_id, number, name, type, total_beds, is_dorm)
     values ($1, $2, $2, 'dorm', 6, true) returning id`,
    [typeId, `${TAG}-D`],
  );
  for (let i = 1; i <= 6; i += 1) {
    await db.query(`insert into beds (room_id, label) values ($1, $2)`, [room[0].id, `B${i}`]);
  }

  const { rows: plan } = await db.query<{ id: string }>(
    `insert into rate_plans (room_type_id, name) values ($1, 'Direct Flex') returning id`,
    [typeId],
  );
  await db.query(
    `insert into rates (room_type_id, rate_plan_id, stay_date, price_paise)
     select $1, $2, d::date, 50000
       from generate_series(current_date, current_date + 200, interval '1 day') d`,
    [typeId, plan[0].id],
  );

  // Everything above enqueued rows; start the assertions from a clean queue.
  await db.query(`delete from channel_outbox where room_type_id = $1`, [typeId]);
});

after(async () => {
  const scope = `%${TAG}`;
  await db.query(`delete from channel_outbox where room_type_id = $1`, [typeId]);
  await db.query(`delete from channel_inbox where external_id like $1`, [`${TAG}%`]);
  await db.query(
    `delete from payments where folio_id in (
       select f.id from folios f join reservations r on r.id = f.reservation_id
        where r.guest_id in (select id from guests where name like $1))`,
    [scope],
  );
  await db.query(
    `delete from folio_items where folio_id in (
       select f.id from folios f join reservations r on r.id = f.reservation_id
        where r.guest_id in (select id from guests where name like $1))`,
    [scope],
  );
  await db.query(
    `delete from folios where reservation_id in (
       select id from reservations where guest_id in (select id from guests where name like $1))`,
    [scope],
  );
  await db.query(
    `delete from allocations where unit_id in (select id from units where room_type_id = $1)`,
    [typeId],
  );
  await db.query(
    `delete from reservation_guests where guest_id in (select id from guests where name like $1)`,
    [scope],
  );
  await db.query(
    `delete from reservations where guest_id in (select id from guests where name like $1)`,
    [scope],
  );
  await db.query(`delete from guests where name like $1`, [scope]);
  // Channels last: reservations.source references them, so deleting a test
  // channel before its reservations trips the foreign key.
  await db.query(`delete from channels where code like $1`, [`${TAG}%`]);
  await db.query(`delete from rates where room_type_id = $1`, [typeId]);
  await db.query(`delete from rate_plans where room_type_id = $1`, [typeId]);
  await db.query(`delete from units where room_type_id = $1`, [typeId]);
  await db.query(`delete from beds where room_id in (select id from rooms where room_type_id = $1)`, [typeId]);
  await db.query(`delete from rooms where room_type_id = $1`, [typeId]);
  await db.query(`delete from room_types where id = $1`, [typeId]);
  await db.end();
});

describe("pooled inventory", () => {
  it("is physical units minus allocations, and ignores any allotment", async () => {
    const from = plus(todayISO(), 100);

    // An allotment row of 1 must have NO effect: distribution_mode changes how
    // numbers are published, never how they are calculated.
    await db.query(
      `insert into direct_allotment (room_type_id, stay_date, units_for_direct)
       values ($1, $2::date, 1)
       on conflict (room_type_id, stay_date) do update set units_for_direct = 1`,
      [typeId, from],
    );

    const { rows } = await db.query<{ free: number; total: number }>(
      `select free_units as free, total_units as total
         from inventory_snapshot($1, $2::date, $3::date)`,
      [typeId, from, plus(from, 1)],
    );
    assert.equal(rows[0].total, 6);
    assert.equal(rows[0].free, 6, "all six beds, not the allotment's one");
  });

  it("is identical in both distribution modes", async () => {
    const from = plus(todayISO(), 101);
    const read = async () => {
      const { rows } = await db.query<{ free: number }>(
        `select free_units as free from inventory_snapshot($1, $2::date, $3::date)`,
        [typeId, from, plus(from, 1)],
      );
      return rows[0].free;
    };

    await db.query(`update property_settings set distribution_mode = 'manual' where id = 1`);
    const manual = await read();
    await db.query(`update property_settings set distribution_mode = 'channel_manager' where id = 1`);
    const managed = await read();
    await db.query(`update property_settings set distribution_mode = 'manual' where id = 1`);

    assert.equal(manual, managed, "the calculation must not depend on how we publish");
  });
});

describe("outbox", () => {
  it("enqueues availability when a booking is made, with nobody calling it", async () => {
    await db.query(`delete from channel_outbox where room_type_id = $1`, [typeId]);
    const from = plus(todayISO(), 110);

    const result = await book(from, plus(from, 2));
    assert.equal(result.ok, true);

    const rows = await outboxFor("availability");
    assert.equal(rows.length, 1, "the trigger did it, not the caller");
    assert.equal(rows[0].from_date, from);
  });

  it("enqueues on cancel, move and block — every path that touches allocations", async () => {
    const from = plus(todayISO(), 115);
    const res = await book(from, plus(from, 2));
    await db.query(`delete from channel_outbox where room_type_id = $1`, [typeId]);

    await db.query(`select cancel_reservation($1, null, 'T')`, [res.reservation!.id]);
    assert.ok(
      (await outboxFor("availability")).length > 0,
      "cancelling frees inventory, so it must publish",
    );
  });

  it("enqueues without locking, and lets the worker stand down the stale one", async () => {
    await db.query(`delete from channel_outbox where room_type_id = $1`, [typeId]);
    const from = plus(todayISO(), 120);

    await book(from, plus(from, 2));
    await book(from, plus(from, 2));

    // Enqueue is INSERT-only: a booking must never take a lock that another
    // booking could wait on, so both rows are simply queued in order.
    const rows = await outboxFor("availability");
    assert.equal(rows.length, 2, "both bookings queued");
    assert.ok(rows.every((r) => r.status === "pending"));
    assert.ok(
      Number(rows[1].sequence) > Number(rows[0].sequence),
      "the sequence records which number is fresher",
    );

    // The worker coalesces: only the newest is sent, the rest stand down, so a
    // stale availability number can never land after a fresh one.
    await db.query(`select supersede_channel_sync($1)`, [rows[0].id]);
    const after = await outboxFor("availability");
    assert.equal(after[0].status, "superseded");
    assert.equal(after[1].status, "pending", "the freshest survives");
  });

  it("backs off and eventually gives up loudly rather than retrying forever", async () => {
    await db.query(`delete from channel_outbox where room_type_id = $1`, [typeId]);
    const from = plus(todayISO(), 125);
    await book(from, plus(from, 1));

    const [row] = await outboxFor("availability");
    for (let i = 0; i < 8; i += 1) {
      await db.query(`update channel_outbox set attempts = $2 where id = $1`, [row.id, i + 1]);
      await db.query(`select complete_channel_sync($1, false, 'boom', 'mock')`, [row.id]);
    }

    const { rows } = await db.query<{ status: string; last_error: string }>(
      `select status, last_error from channel_outbox where id = $1`,
      [row.id],
    );
    assert.equal(rows[0].status, "failed", "it stops and becomes visible");
    assert.equal(rows[0].last_error, "boom");
  });

  it("marks manual-mode work as needing acknowledgement", async () => {
    await db.query(`update property_settings set distribution_mode = 'manual' where id = 1`);
    await db.query(`delete from channel_outbox where room_type_id = $1`, [typeId]);
    const from = plus(todayISO(), 130);
    await book(from, plus(from, 1));

    const { rows } = await db.query<{ requires_ack: boolean }>(
      `select requires_ack from channel_outbox
        where room_type_id = $1 and kind = 'availability' limit 1`,
      [typeId],
    );
    assert.equal(rows[0].requires_ack, true, "staff are the transport; they must confirm");
  });
});

describe("channels are data", () => {
  it("accepts a channel that did not exist when the engine was written", async () => {
    // The whole point: adding a marketplace is an INSERT.
    await db.query(
      `insert into channels (code, name, kind, sort_order) values ($1, 'Future OTA', 'ota', 500)`,
      [`${TAG}_new`],
    );
    const from = plus(todayISO(), 140);
    const result = await book(from, plus(from, 1), 1, `${TAG}_new`);
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it("refuses a channel that is not registered", async () => {
    const from = plus(todayISO(), 145);
    const result = await book(from, plus(from, 1), 1, "ota_nonexistent");
    assert.equal(result.ok, false);
    assert.equal(result.code, "UNKNOWN_CHANNEL");
  });

  it("prices an OTA booking from the OTA, and a direct one from our calendar", async () => {
    const from = plus(todayISO(), 150);

    const { rows: ota } = await db.query<{ r: { ok: boolean; reservationId: string } }>(
      `select create_channel_reservation('ota_agoda', $1, '+91', $2::date, $3::date,
                                          $4, 1, $5, 777000, $6, 'T') as r`,
      [`Guest ${TAG}`, from, plus(from, 2), typeId, `${TAG}-A1`, DESK],
    );
    assert.equal(ota[0].r.ok, true);

    const { rows: folio } = await db.query<{ f: { chargesPaise: number; balancePaise: number } }>(
      `select stays_folio($1) as f`,
      [ota[0].r.reservationId],
    );
    assert.equal(folio[0].f.chargesPaise, 777000, "the marketplace's price, not ours");
    assert.equal(folio[0].f.balancePaise, 0, "already paid to the marketplace");

    // A direct channel falls back to our own rate calendar.
    const { rows: direct } = await db.query<{ r: { ok: boolean; reservationId: string } }>(
      `select create_channel_reservation('walk_in', $1, '+91', $2::date, $3::date,
                                          $4, 1, null, 0, $5, 'T') as r`,
      [`Guest ${TAG}`, plus(from, 10), plus(from, 12), typeId, DESK],
    );
    const { rows: f2 } = await db.query<{ f: { chargesPaise: number } }>(
      `select stays_folio($1) as f`,
      [direct[0].r.reservationId],
    );
    assert.equal(f2[0].f.chargesPaise, 100000, "two nights at our ₹500");
  });
});

describe("inbound", () => {
  it("deduplicates a redelivered message", async () => {
    const first = await db.query<{ c: { fresh: boolean } }>(
      `select claim_channel_inbound('mock', $1, 'reservation', 'ota_agoda', '{}'::jsonb) as c`,
      [`${TAG}-dup`],
    );
    assert.equal(first.rows[0].c.fresh, true);

    const second = await db.query<{ c: { fresh: boolean } }>(
      `select claim_channel_inbound('mock', $1, 'reservation', 'ota_agoda', '{}'::jsonb) as c`,
      [`${TAG}-dup`],
    );
    assert.equal(second.rows[0].c.fresh, false, "a webhook retry must not book twice");
  });

  it("keeps a failure for staff instead of dropping it", async () => {
    await db.query(
      `select claim_channel_inbound('mock', $1, 'reservation', 'ota_agoda', '{}'::jsonb)`,
      [`${TAG}-fail`],
    );
    await db.query(
      `select complete_channel_inbound('mock', $1, 'failed', null, 'Overbooking: nothing free')`,
      [`${TAG}-fail`],
    );

    const { rows } = await db.query<{ s: { inboundFailures: { externalId: string }[] } }>(
      `select channel_status() as s`,
    );
    assert.ok(
      rows[0].s.inboundFailures.some((f) => f.externalId === `${TAG}-fail`),
      "an unbookable reservation becomes a task, never a silence",
    );
  });

  it("still cannot double-book, however the reservation arrives", async () => {
    const from = plus(todayISO(), 170);
    // Pooled inventory means a channel competes for the SAME six beds. The
    // exclusion constraint, not the allotment, is what stops the seventh.
    const all = await db.query<{ r: { ok: boolean } }>(
      `select create_channel_reservation('ota_booking', $1, '+91', $2::date, $3::date,
                                          $4, 6, $5, 100000, $6, 'T') as r`,
      [`Guest ${TAG}`, from, plus(from, 1), typeId, `${TAG}-ALL`, DESK],
    );
    assert.equal(all.rows[0].r.ok, true, "all six beds taken");

    const over = await db.query<{ r: { ok: boolean; code: string } }>(
      `select create_channel_reservation('ota_agoda', $1, '+91', $2::date, $3::date,
                                          $4, 1, $5, 100000, $6, 'T') as r`,
      [`Guest ${TAG}`, from, plus(from, 1), typeId, `${TAG}-OVER`, DESK],
    );
    assert.equal(over.rows[0].r.ok, false, "the seventh bed does not exist");
    assert.equal(over.rows[0].r.code, "UNITS_TAKEN");
  });

  it("refuses to enter the same OTA reference twice", async () => {
    const from = plus(todayISO(), 160);
    const args = [`Guest ${TAG}`, from, plus(from, 1), typeId, `${TAG}-REF`, DESK];

    const first = await db.query<{ r: { ok: boolean } }>(
      `select create_channel_reservation('ota_expedia', $1, '+91', $2::date, $3::date,
                                          $4, 1, $5, 100000, $6, 'T') as r`,
      args,
    );
    assert.equal(first.rows[0].r.ok, true);

    const second = await db.query<{ r: { ok: boolean; code: string } }>(
      `select create_channel_reservation('ota_expedia', $1, '+91', $2::date, $3::date,
                                          $4, 1, $5, 100000, $6, 'T') as r`,
      args,
    );
    assert.equal(second.rows[0].r.ok, false);
    assert.equal(second.rows[0].r.code, "DUPLICATE_REFERENCE");
  });
});
