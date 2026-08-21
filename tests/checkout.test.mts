/**
 * Departures and checkout (ROADMAP M2 item 3).
 *
 * This is the point where a guest hands over money, so the arithmetic and the
 * refusals matter more than the screen does.
 *
 * NOTE: no tax assertions. The property is GST-registered but slab treatment is
 * deferred by decision — `tax_rate` stays 0 on every line for now.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

const TAG = `OUT_${Date.now().toString(36).toUpperCase()}`;
const DESK = "88888888-8888-8888-8888-888888888888";
const RATE = 90000; // ₹900/night, seeded for this test's own room type

let db: Client;
let typeId: string;
let planId: string;

function plus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
/**
 * "Today" as the DATABASE sees it — Asia/Kolkata, which every server function
 * uses. `new Date().toISOString()` is UTC, so between 18:30 and 24:00 UTC it
 * names the previous day and these tests would ask about the wrong date.
 * IST is a fixed +5:30 with no DST, so the offset is safe to hard-code.
 */
const todayISO = () =>
  new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

/** A stay that has already started, so it can be checked in and then out. */
async function stay(name: string, qty = 1, nights = 2) {
  const from = plus(todayISO(), -nights);
  const to = todayISO();
  const { rows } = await db.query<{
    r: { ok: boolean; reservation?: { id: string; code: string } };
  }>(
    `select create_reservation(
       jsonb_build_object('name', $1::text, 'phone', '+910000000003', 'notes', $2::text),
       $3::date, $4::date,
       jsonb_build_array(jsonb_build_object('roomTypeId', $5::text, 'ratePlanId', null, 'qty', $6::int)),
       'walk_in', null, null, 'T') as r`,
    [name, TAG, from, to, typeId, qty],
  );
  assert.ok(rows[0].r.ok, `fixture booking failed: ${JSON.stringify(rows[0].r)}`);
  const res = rows[0].r.reservation!;

  await db.query(`select check_in_reservation($1, $2::jsonb, $3, 'Desk')`, [
    res.id,
    JSON.stringify([{ name, idProofNumber: `ID-${TAG}` }]),
    DESK,
  ]);
  return { ...res, nights, qty };
}

const folioOf = async (reservationId: string) => {
  const { rows } = await db.query<{ f: Record<string, unknown> }>(
    `select stays_folio($1) as f`,
    [reservationId],
  );
  return rows[0].f as {
    folioId: string;
    chargesPaise: number;
    paidPaise: number;
    balancePaise: number;
    items: { kind: string; amountPaise: number }[];
    openOrders: unknown[];
  };
};

const checkout = async (
  reservationId: string,
  payments: { method: string; amountPaise: number }[] = [],
  discountPaise = 0,
  reason: string | null = null,
) => {
  const { rows } = await db.query<{ r: Record<string, unknown> }>(
    `select stays_checkout($1, $2::jsonb, $3, $4, $5, 'Desk') as r`,
    [reservationId, JSON.stringify(payments), discountPaise, reason, DESK],
  );
  return rows[0].r as { ok: boolean; code?: string; balancePaise?: number; paidPaise?: number; open?: number };
};

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
    `insert into profiles (id, full_name, role) values ($1, 'Checkout Test', 'owner')
     on conflict (id) do update set role = 'owner'`,
    [DESK],
  );
  await db.query(`set request.jwt.claim.sub = '${DESK}'`);

  const { rows } = await db.query<{ id: string }>(
    `insert into room_types (code, name, sell_mode, base_occupancy, max_occupancy, sort_order)
     values ($1, $1, 'per_room', 1, 2, 996) returning id`,
    [TAG],
  );
  typeId = rows[0].id;

  // Every test books an overlapping window ending today, so the fixture needs
  // enough rooms for the whole suite at once.
  for (let n = 1; n <= 20; n += 1) {
    await db.query(
      `insert into rooms (room_type_id, number, name, type, total_beds, is_dorm)
       values ($1, $2, $2, 'deluxe', 1, false)`,
      [typeId, `${TAG}-${String(n).padStart(2, "0")}`],
    );
  }

  // Its own rate plan and calendar, so the arithmetic is predictable.
  const { rows: plan } = await db.query<{ id: string }>(
    `insert into rate_plans (room_type_id, name) values ($1, 'Test Flex') returning id`,
    [typeId],
  );
  planId = plan[0].id;
  await db.query(
    `insert into rates (room_type_id, rate_plan_id, stay_date, price_paise)
     select $1, $2, d::date, $3
       from generate_series(current_date - 30, current_date + 30, interval '1 day') d`,
    [typeId, planId, RATE],
  );
});

after(async () => {
  const scope = `%${TAG}`;
  await db.query(
    `delete from payments where folio_id in (
       select f.id from folios f join reservations r on r.id = f.reservation_id
        where r.notes = $1)`,
    [TAG],
  );
  await db.query(
    `delete from folio_items where folio_id in (
       select f.id from folios f join reservations r on r.id = f.reservation_id
        where r.notes = $1)`,
    [TAG],
  );
  await db.query(`update orders set folio_id = null where table_label = $1`, [TAG]);
  await db.query(`delete from order_items where order_id in (select id from orders where table_label = $1)`, [TAG]);
  await db.query(`delete from orders where table_label = $1`, [TAG]);
  await db.query(
    `delete from folios where reservation_id in (select id from reservations where notes = $1)`,
    [TAG],
  );
  await db.query(
    `delete from allocations where unit_id in (select id from units where room_type_id = $1)`,
    [typeId],
  );
  await db.query(
    `delete from reservation_guests where reservation_id in (select id from reservations where notes = $1)`,
    [TAG],
  );
  await db.query(`delete from reservations where notes = $1`, [TAG]);
  await db.query(`delete from guests where name like $1`, [scope]);
  await db.query(`delete from rates where room_type_id = $1`, [typeId]);
  await db.query(`delete from rate_plans where room_type_id = $1`, [typeId]);
  await db.query(`delete from units where room_type_id = $1`, [typeId]);
  await db.query(`delete from rooms where room_type_id = $1`, [typeId]);
  await db.query(`delete from room_types where id = $1`, [typeId]);
  // Own the fixtures fully: this role-bearing profile has no staff row, and a
  // leaked one trips grants-matrix's whole-table isolation invariant.
  await db.query(`delete from profiles where id = $1`, [DESK]);
  await db.end();
});

describe("room charges", () => {
  it("posts one line per unit per night, priced from the calendar", async () => {
    const res = await stay(`Nights ${TAG}`, 1, 3);
    const folio = await folioOf(res.id);

    const nights = folio.items.filter((i) => i.kind === "room_night");
    assert.equal(nights.length, 3, "three nights, three lines");
    assert.equal(folio.chargesPaise, RATE * 3);
    // Checkout day is not a night.
    assert.ok(
      !folio.items.some((i) => i.kind === "room_night" && i.amountPaise !== RATE),
      "every night at the calendar rate",
    );
  });

  it("charges each unit of a group booking", async () => {
    const res = await stay(`Group ${TAG}`, 3, 2);
    const folio = await folioOf(res.id);
    assert.equal(folio.items.filter((i) => i.kind === "room_night").length, 6, "3 rooms × 2 nights");
    assert.equal(folio.chargesPaise, RATE * 6);
  });

  it("never double-charges when posting runs twice", async () => {
    const res = await stay(`Twice ${TAG}`, 1, 2);
    const before = (await folioOf(res.id)).chargesPaise;
    await db.query(`select ensure_room_charges($1)`, [res.id]);
    await db.query(`select ensure_room_charges($1)`, [res.id]);
    assert.equal((await folioOf(res.id)).chargesPaise, before, "idempotent");
  });
});

describe("checkout", () => {
  it("settles the folio, checks out, and marks the rooms dirty", async () => {
    const res = await stay(`Settle ${TAG}`, 1, 2);
    const due = (await folioOf(res.id)).balancePaise;
    assert.equal(due, RATE * 2);

    const result = await checkout(res.id, [{ method: "upi", amountPaise: due }]);
    assert.equal(result.ok, true, JSON.stringify(result));

    const folio = await folioOf(res.id);
    assert.equal(folio.balancePaise, 0, "nothing left owing");
    assert.equal(folio.paidPaise, due);

    const { rows: st } = await db.query<{ status: string; fstatus: string }>(
      `select r.status, f.status as fstatus from reservations r
         join folios f on f.reservation_id = r.id where r.id = $1`,
      [res.id],
    );
    assert.equal(st[0].status, "checked_out");
    assert.equal(st[0].fstatus, "settled");

    const { rows: hk } = await db.query<{ n: string }>(
      `select count(*) as n from rooms rm
        where rm.id in (select u.room_id from allocations a join units u on u.id = a.unit_id
                         where a.reservation_id = $1)
          and rm.housekeeping = 'dirty'`,
      [res.id],
    );
    assert.ok(Number(hk[0].n) > 0, "occupied rooms are now dirty");
  });

  it("refuses to let anyone leave owing money", async () => {
    const res = await stay(`Owing ${TAG}`, 1, 2);
    const due = (await folioOf(res.id)).balancePaise;

    const short = await checkout(res.id, [{ method: "cash", amountPaise: due - 10000 }]);
    assert.equal(short.ok, false);
    assert.equal(short.code, "BALANCE_DUE");
    assert.equal(short.balancePaise, 10000);

    const { rows } = await db.query<{ status: string }>(
      `select status from reservations where id = $1`,
      [res.id],
    );
    assert.equal(rows[0].status, "checked_in", "still in-house");
  });

  it("accepts a split payment across two methods", async () => {
    const res = await stay(`Split ${TAG}`, 1, 2);
    const due = (await folioOf(res.id)).balancePaise;

    const result = await checkout(res.id, [
      { method: "cash", amountPaise: 50000 },
      { method: "upi", amountPaise: due - 50000 },
    ]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await folioOf(res.id)).balancePaise, 0);
  });

  it("requires a reason for a discount, and records it as a negative line", async () => {
    const res = await stay(`Disc ${TAG}`, 1, 2);
    const due = (await folioOf(res.id)).balancePaise;

    const noReason = await checkout(res.id, [{ method: "cash", amountPaise: due - 20000 }], 20000, null);
    assert.equal(noReason.ok, false);
    assert.equal(noReason.code, "REASON_REQUIRED", "a discount without a reason is refused");

    const ok = await checkout(
      res.id,
      [{ method: "cash", amountPaise: due - 20000 }],
      20000,
      "Long-stay goodwill",
    );
    assert.equal(ok.ok, true, JSON.stringify(ok));

    const folio = await folioOf(res.id);
    const discount = folio.items.find((i) => i.kind === "discount")!;
    assert.ok(discount, "a discount line exists");
    assert.equal(discount.amountPaise, -20000, "discounts are negative lines");
    assert.equal(folio.balancePaise, 0);
  });

  it("blocks checkout while a café order for the room is still open, and shows it", async () => {
    const res = await stay(`Cafe ${TAG}`, 1, 2);
    const { rows: room } = await db.query<{ room_id: string }>(
      `select u.room_id from allocations a join units u on u.id = a.unit_id
        where a.reservation_id = $1 limit 1`,
      [res.id],
    );
    await db.query(
      `insert into orders (type, table_label, room_id, status, subtotal_paise, total_paise)
       values ('room', $1, $2, 'sent', 24000, 24000)`,
      [TAG, room[0].room_id],
    );

    const due = (await folioOf(res.id)).balancePaise;
    const blocked = await checkout(res.id, [{ method: "cash", amountPaise: due }]);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "OPEN_ORDERS");
    assert.equal(blocked.open, 1);

    // Shown, not hidden: the statement carries the offending order.
    const folio = await folioOf(res.id);
    assert.equal(folio.openOrders.length, 1, "the open order is visible on the folio");

    // No money was taken while blocked.
    assert.equal(folio.paidPaise, 0, "nothing charged on a blocked checkout");
  });

  it("includes a café charge-to-room on the bill", async () => {
    const res = await stay(`Charged ${TAG}`, 1, 2);
    const { rows: order } = await db.query<{ id: string }>(
      `insert into orders (type, table_label, status, subtotal_paise, total_paise)
       values ('dine_in', $1, 'served', 18000, 18000) returning id`,
      [TAG],
    );
    const { rows: item } = await db.query<{ id: string }>(
      `select id from menu_items limit 1`,
    );
    await db.query(
      `insert into order_items (order_id, menu_item_id, qty, price_paise, status)
       values ($1, $2, 1, 18000, 'ready')`,
      [order[0].id, item[0].id],
    );
    await db.query(`select pos_charge_to_room($1, $2, $3, 'Café')`, [
      order[0].id,
      res.id,
      DESK,
    ]);

    const folio = await folioOf(res.id);
    assert.equal(folio.chargesPaise, RATE * 2 + 18000, "room nights plus the café charge");

    const result = await checkout(res.id, [
      { method: "card", amountPaise: folio.balancePaise },
    ]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal((await folioOf(res.id)).balancePaise, 0);
  });

  it("refuses a second checkout", async () => {
    const res = await stay(`Again ${TAG}`, 1, 2);
    const due = (await folioOf(res.id)).balancePaise;
    await checkout(res.id, [{ method: "cash", amountPaise: due }]);

    const second = await checkout(res.id, []);
    assert.equal(second.ok, false);
    assert.equal(second.code, "ALREADY_CHECKED_OUT");
  });

  it("refuses to check out someone who never checked in", async () => {
    const { rows } = await db.query<{ r: { ok: boolean; reservation: { id: string } } }>(
      `select create_reservation(
         jsonb_build_object('name', $1::text, 'phone', '+91', 'notes', $2::text),
         current_date + 20, current_date + 22,
         jsonb_build_array(jsonb_build_object('roomTypeId', $3::text, 'ratePlanId', null, 'qty', 1)),
         'walk_in', null, null, 'T') as r`,
      [`Future ${TAG}`, TAG, typeId],
    );
    const result = await checkout(rows[0].r.reservation.id, []);
    assert.equal(result.ok, false);
    assert.equal(result.code, "NOT_IN_HOUSE");
  });

  it("writes exactly one checkout event", async () => {
    const res = await stay(`Event ${TAG}`, 1, 2);
    const due = (await folioOf(res.id)).balancePaise;
    const { rows: before } = await db.query<{ n: string }>(
      `select count(*) as n from events where kind = 'guest.checked_out'`,
    );
    await checkout(res.id, [{ method: "cash", amountPaise: due }]);
    const { rows: after } = await db.query<{ n: string }>(
      `select count(*) as n from events where kind = 'guest.checked_out'`,
    );
    assert.equal(Number(after[0].n), Number(before[0].n) + 1);
  });
});

describe("departures list", () => {
  it("lists an in-house stay due out today with its balance", async () => {
    const res = await stay(`Due ${TAG}`, 1, 2);
    const { rows } = await db.query<{ d: { departures: Record<string, unknown>[] } }>(
      `select stays_departures(null, $1) as d`,
      [res.code],
    );
    const row = rows[0].d.departures[0] as {
      code: string;
      folio: { balancePaise: number };
    };
    assert.ok(row, "the stay is due out");
    assert.equal(row.code, res.code);
    assert.equal(row.folio.balancePaise, RATE * 2, "the bill is ready to read out");
  });

  it("drops the stay once it is checked out", async () => {
    const res = await stay(`Left ${TAG}`, 1, 2);
    const due = (await folioOf(res.id)).balancePaise;
    await checkout(res.id, [{ method: "cash", amountPaise: due }]);

    const { rows } = await db.query<{ d: { departures: unknown[] } }>(
      `select stays_departures(null, $1) as d`,
      [res.code],
    );
    assert.equal(rows[0].d.departures.length, 0);
  });
});
