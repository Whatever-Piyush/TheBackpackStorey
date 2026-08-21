/**
 * Café POS settlement (ROADMAP M1).
 *
 * Money is the reason these exist: a counter sale and a charge-to-room must land
 * on a folio correctly, or the café takes cash against nothing, or a guest is
 * billed twice at checkout.
 *
 * Requires a Postgres with every migration applied — see tests/inventory.test.mts.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

const TAG = `POS_${Date.now().toString(36).toUpperCase()}`;
const OWNER = "44444444-4444-4444-4444-444444444444";

let db: Client;
let coffeeItem: string;
let foodItem: string;

/**
 * An order with one drink and one dish, already sent to the kitchen.
 *
 * The header totals are DERIVED from the item lines, exactly as createOrder does
 * it — an order whose subtotal disagrees with its items can never exist in the
 * app, and a fixture that fakes one tests nothing real.
 */
const DRINK_PAISE = 12000;
const DISH_PAISE = 16000;
const ITEMS_PAISE = DRINK_PAISE * 2 + DISH_PAISE; // 40000

async function makeOrder(discountPaise = 0): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into orders (type, table_label, status, subtotal_paise, discount_paise, total_paise)
     values ('dine_in', $1, 'sent', $2, $3, $4) returning id`,
    [TAG, ITEMS_PAISE, discountPaise, ITEMS_PAISE - discountPaise],
  );
  const orderId = rows[0].id;
  await db.query(
    `insert into order_items (order_id, menu_item_id, qty, price_paise, status)
     values ($1, $2, 2, $4, 'ready'), ($1, $3, 1, $5, 'ready')`,
    [orderId, coffeeItem, foodItem, DRINK_PAISE, DISH_PAISE],
  );
  return orderId;
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();

  await db.query(
    `insert into auth.users (id, email) values ($1, 'pos-test@local')
     on conflict (id) do nothing`,
    [OWNER],
  );
  await db.query(
    `insert into profiles (id, full_name, role) values ($1, 'POS Test', 'owner')
     on conflict (id) do update set role = 'owner'`,
    [OWNER],
  );
  // pos_* functions authorise off user_role(), which reads auth.uid().
  await db.query(`set request.jwt.claim.sub = '${OWNER}'`);

  const coffee = await db.query<{ id: string }>(
    `select id from menu_items where kitchen_station = 'coffee' limit 1`,
  );
  const food = await db.query<{ id: string }>(
    `select id from menu_items where kitchen_station = 'main' limit 1`,
  );
  coffeeItem = coffee.rows[0].id;
  foodItem = food.rows[0].id;
});

after(async () => {
  await db.query(
    `delete from folio_items where folio_id in (
       select folio_id from orders where table_label = $1 and folio_id is not null)`,
    [TAG],
  );
  await db.query(
    `delete from payments where folio_id in (
       select folio_id from orders where table_label = $1 and folio_id is not null)`,
    [TAG],
  );
  await db.query(`delete from order_items where order_id in (select id from orders where table_label = $1)`, [TAG]);
  // Orders must go BEFORE folios: orders.folio_id references folios, so the
  // reverse order raises 23503 and an error thrown in after() stalls the run.
  const { rows: folios } = await db.query<{ folio_id: string }>(
    `select folio_id from orders where table_label = $1 and folio_id is not null`,
    [TAG],
  );
  await db.query(`delete from orders where table_label = $1`, [TAG]);
  if (folios.length > 0) {
    await db.query(`delete from folios where id = any($1::uuid[])`, [folios.map((f) => f.folio_id)]);
  }

  // Reservations this run created, via their guests. Without this the fixture
  // room type stays booked and the NEXT run has no inventory to work with.
  const mine = `%${TAG}`;
  await db.query(
    `delete from allocations where reservation_id in (
       select r.id from reservations r join guests g on g.id = r.guest_id where g.name like $1)`,
    [mine],
  );
  await db.query(
    `delete from folios where reservation_id in (
       select r.id from reservations r join guests g on g.id = r.guest_id where g.name like $1)`,
    [mine],
  );
  await db.query(
    `delete from reservations where guest_id in (select id from guests where name like $1)`,
    [mine],
  );
  await db.query(`delete from guests where name like $1`, [mine]);

  // Own the fixtures fully: this owner profile has no staff row, and a leaked one
  // trips grants-matrix's whole-table isolation invariant. Orders (which reference
  // it via created_by) are already deleted above, so this is FK-safe.
  await db.query(`delete from profiles where id = $1`, [OWNER]);
  await db.end();
});

describe("counter settlement", () => {
  it("posts the order onto a settled walk-in folio with a matching payment", async () => {
    const orderId = await makeOrder(4000);

    const { rows } = await db.query<{ result: { ok: boolean; folioId: string } }>(
      `select pos_settle_order($1, 'upi', $2) as result`,
      [orderId, OWNER],
    );
    assert.equal(rows[0].result.ok, true);
    const folioId = rows[0].result.folioId;

    // Drinks and food are separated; the discount is a negative line, not a
    // reduced unit price, so the original prices stay visible.
    const { rows: lines } = await db.query<{ kind: string; amount_paise: number }>(
      `select kind, amount_paise from folio_items where folio_id = $1 order by kind`,
      [folioId],
    );
    const kinds = lines.map((l) => l.kind).sort();
    assert.deepEqual(kinds, ["beverage", "discount", "food"]);
    assert.ok(
      lines.find((l) => l.kind === "discount")!.amount_paise < 0,
      "discount must be negative",
    );

    // Folio arithmetic must equal what the till actually took.
    const { rows: balance } = await db.query<{ items: string; paid: string; status: string }>(
      `select coalesce((select sum(amount_paise) from folio_items where folio_id = f.id), 0) as items,
              coalesce((select sum(amount_paise) from payments    where folio_id = f.id), 0) as paid,
              f.status
         from folios f where f.id = $1`,
      [folioId],
    );
    assert.equal(balance[0].items, balance[0].paid, "folio must balance to zero");
    assert.equal(Number(balance[0].paid), ITEMS_PAISE - 4000);
    assert.equal(balance[0].status, "settled");

    const { rows: order } = await db.query<{ status: string; folio_id: string }>(
      `select status, folio_id from orders where id = $1`,
      [orderId],
    );
    assert.equal(order[0].status, "paid");
    assert.equal(order[0].folio_id, folioId);
  });

  it("refuses to settle the same order twice", async () => {
    const orderId = await makeOrder();
    await db.query(`select pos_settle_order($1, 'cash', $2)`, [orderId, OWNER]);

    const { rows } = await db.query<{ result: { ok: boolean; code: string } }>(
      `select pos_settle_order($1, 'cash', $2) as result`,
      [orderId, OWNER],
    );
    assert.equal(rows[0].result.ok, false);
    assert.equal(rows[0].result.code, "ALREADY_CLOSED");
  });

  it("rejects a payment method the folio engine doesn't accept", async () => {
    const orderId = await makeOrder();
    const { rows } = await db.query<{ result: { ok: boolean; code: string } }>(
      `select pos_settle_order($1, 'bitcoin', $2) as result`,
      [orderId, OWNER],
    );
    assert.equal(rows[0].result.code, "BAD_METHOD");
  });
});

describe("charge to room", () => {
  let reservationId: string;

  before(async () => {
    const { rows } = await db.query<{ result: { ok: boolean; reservation?: { id: string } } }>(
      `select create_reservation(
         jsonb_build_object('name', $1::text, 'phone', '+919000000000'),
         current_date, current_date + 2,
         jsonb_build_array(jsonb_build_object(
           'roomTypeId', (select id from room_types where code = 'premium'),
           'ratePlanId', null, 'qty', 1)),
         'walk_in', null, null, 'T') as result`,
      [`Guest ${TAG}`],
    );
    assert.ok(
      rows[0].result?.reservation?.id,
      `fixture reservation failed: ${JSON.stringify(rows[0].result)}`,
    );
    reservationId = rows[0].result.reservation.id;
    await db.query(`update reservations set status = 'checked_in' where id = $1`, [
      reservationId,
    ]);
  });

  it("posts onto the guest's OPEN folio and takes no payment", async () => {
    const orderId = await makeOrder();

    const { rows } = await db.query<{ result: { ok: boolean; folioId: string } }>(
      `select pos_charge_to_room($1, $2, $3, 'Café') as result`,
      [orderId, reservationId, OWNER],
    );
    assert.equal(rows[0].result.ok, true);
    const folioId = rows[0].result.folioId;

    const { rows: folio } = await db.query<{
      status: string;
      reservation_id: string;
      payments: string;
      items: string;
    }>(
      `select f.status, f.reservation_id,
              (select count(*) from payments p where p.folio_id = f.id) as payments,
              -- Café lines only: the same folio also carries room nights, which
              -- are posted when the guest checks in.
              coalesce((select sum(amount_paise) from folio_items fi
                         where fi.folio_id = f.id and fi.source = 'pos'), 0) as items
         from folios f where f.id = $1`,
      [folioId],
    );
    assert.equal(folio[0].reservation_id, reservationId, "must be the guest's folio");
    assert.equal(folio[0].status, "open", "stays open until checkout");
    assert.equal(folio[0].payments, "0", "the counter takes no money");
    assert.equal(Number(folio[0].items), ITEMS_PAISE, "café lines total the menu prices");
  });

  it("reuses the same folio for a second order rather than opening another", async () => {
    const before = await db.query<{ n: string }>(
      `select count(*) as n from folios where reservation_id = $1`,
      [reservationId],
    );
    const orderId = await makeOrder();
    await db.query(`select pos_charge_to_room($1, $2, $3, 'Café')`, [
      orderId,
      reservationId,
      OWNER,
    ]);
    const after = await db.query<{ n: string }>(
      `select count(*) as n from folios where reservation_id = $1`,
      [reservationId],
    );
    assert.equal(after.rows[0].n, before.rows[0].n, "one folio per stay");
  });

  it("writes exactly one event so reception sees it at checkout", async () => {
    const orderId = await makeOrder();
    const before = await db.query<{ n: string }>(
      `select count(*) as n from events where kind = 'order.charged_to_room'`,
    );
    await db.query(`select pos_charge_to_room($1, $2, $3, 'Café')`, [
      orderId,
      reservationId,
      OWNER,
    ]);
    const after = await db.query<{ n: string }>(
      `select count(*) as n from events where kind = 'order.charged_to_room'`,
    );
    assert.equal(Number(after.rows[0].n), Number(before.rows[0].n) + 1);
  });

  it("refuses a guest who is not checked in", async () => {
    const orderId = await makeOrder();
    // Create one explicitly rather than hoping a stray reservation exists.
    const { rows: made } = await db.query<{ result: { ok: boolean; reservation?: { id: string } } }>(
      `select create_reservation(
         jsonb_build_object('name', $1::text, 'phone', '+919000000001'),
         current_date + 30, current_date + 32,
         jsonb_build_array(jsonb_build_object(
           'roomTypeId', (select id from room_types where code = 'family'),
           'ratePlanId', null, 'qty', 1)),
         'walk_in', null, null, 'T') as result`,
      [`Future ${TAG}`],
    );
    assert.ok(made[0].result?.reservation?.id, "fixture reservation failed");
    const other = [{ id: made[0].result.reservation!.id }];
    const { rows } = await db.query<{ result: { ok: boolean; code: string } }>(
      `select pos_charge_to_room($1, $2, $3, 'Café') as result`,
      [orderId, other[0].id, OWNER],
    );
    assert.equal(rows[0].result.ok, false);
    assert.equal(rows[0].result.code, "NOT_CHECKED_IN");
  });
});

describe("day close", () => {
  it("refuses while any bill is still open", async () => {
    await makeOrder(); // left unsettled on purpose
    const { rows } = await db.query<{ result: { ok: boolean; code: string } }>(
      `select pos_close_day(null, $1, 'Owner') as result`,
      [OWNER],
    );
    assert.equal(rows[0].result.ok, false);
    assert.equal(rows[0].result.code, "OPEN_ORDERS");
  });

  it("separates counter takings from charges pushed to rooms", async () => {
    const { rows } = await db.query<{ summary: Record<string, number> }>(
      `select pos_today() -> 'summary' as summary`,
    );
    const s = rows[0].summary;
    // Room charges are revenue, but they are NOT money in the till today.
    assert.ok(s.toRoomPaise > 0, "room charges recorded");
    assert.ok(s.grossPaise >= s.toRoomPaise, "gross includes room charges");
    assert.ok(s.open > 0, "the unsettled bill is still counted as open");
  });
});
