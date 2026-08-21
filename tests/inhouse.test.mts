/**
 * In-house: extend, shorten, manual charges, no-show (ROADMAP M2 item 4).
 *
 * Extending is where the exclusion constraint bites hardest — the interesting
 * cases are the refusals and what reception is offered instead.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

const TAG = `INH_${Date.now().toString(36).toUpperCase()}`;
const DESK = "99999999-0000-0000-0000-000000000001";
const RATE = 80000; // ₹800/night

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

async function book(name: string, from: string, to: string, qty = 1) {
  const { rows } = await db.query<{
    r: { ok: boolean; reservation?: { id: string; code: string } };
  }>(
    `select create_reservation(
       jsonb_build_object('name', $1::text, 'phone', '+910000000004', 'notes', $2::text),
       $3::date, $4::date,
       jsonb_build_array(jsonb_build_object('roomTypeId', $5::text, 'ratePlanId', null, 'qty', $6::int)),
       'walk_in', null, null, 'T') as r`,
    [name, TAG, from, to, typeId, qty],
  );
  assert.ok(rows[0].r.ok, `fixture booking failed: ${JSON.stringify(rows[0].r)}`);
  return rows[0].r.reservation!;
}

async function checkedIn(name: string, from: string, to: string, qty = 1) {
  const res = await book(name, from, to, qty);
  await db.query(`select check_in_reservation($1, $2::jsonb, $3, 'Desk')`, [
    res.id,
    JSON.stringify([{ name, idProofNumber: `ID-${TAG}` }]),
    DESK,
  ]);
  return res;
}

/**
 * Each extend test gets its own date window. The room pool is shared, so a
 * stay auto-assigned for one window can already be occupied in another — and
 * the maintenance block these tests insert would then collide during SETUP,
 * which looks exactly like a product bug and isn't one.
 */
function window(offset: number) {
  return {
    from: plus(todayISO(), offset),
    to: plus(todayISO(), offset + 2),
    extended: plus(todayISO(), offset + 4),
  };
}

const extend = async (id: string, to: string, plan: unknown = null) => {
  const { rows } = await db.query<{ r: Record<string, unknown> }>(
    `select stays_extend($1, $2::date, $3::jsonb, $4, 'Desk') as r`,
    [id, to, plan ? JSON.stringify(plan) : null, DESK],
  );
  return rows[0].r as {
    ok: boolean;
    code?: string;
    split?: boolean;
    checkout?: string;
    options?: { blocked: { allocationId: string; moveOptions: { unitId: string }[]; splitOptions: { unitId: string }[] }[] };
  };
};

const folioOf = async (id: string) => {
  const { rows } = await db.query<{ f: { chargesPaise: number; items: { kind: string }[] } }>(
    `select stays_folio($1) as f`,
    [id],
  );
  return rows[0].f;
};

const allocationsOf = async (id: string) => {
  const { rows } = await db.query<{ id: string; unit_id: string; lo: string; hi: string }>(
    `select id, unit_id, lower(stay)::text as lo, upper(stay)::text as hi
       from allocations where reservation_id = $1 order by lo`,
    [id],
  );
  return rows;
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
    `insert into profiles (id, full_name, role) values ($1, 'InHouse Test', 'owner')
     on conflict (id) do update set role = 'owner'`,
    [DESK],
  );
  await db.query(`set request.jwt.claim.sub = '${DESK}'`);

  const { rows } = await db.query<{ id: string }>(
    `insert into room_types (code, name, sell_mode, base_occupancy, max_occupancy, sort_order)
     values ($1, $1, 'per_room', 1, 2, 995) returning id`,
    [TAG],
  );
  typeId = rows[0].id;

  for (let n = 1; n <= 12; n += 1) {
    await db.query(
      `insert into rooms (room_type_id, number, name, type, total_beds, is_dorm)
       values ($1, $2, $2, 'deluxe', 1, false)`,
      [typeId, `${TAG}-${String(n).padStart(2, "0")}`],
    );
  }

  const { rows: plan } = await db.query<{ id: string }>(
    `insert into rate_plans (room_type_id, name) values ($1, 'Flex') returning id`,
    [typeId],
  );
  await db.query(
    `insert into rates (room_type_id, rate_plan_id, stay_date, price_paise)
     select $1, $2, d::date, $3
       from generate_series(current_date - 30, current_date + 150, interval '1 day') d`,
    [typeId, plan[0].id, RATE],
  );
});

after(async () => {
  await db.query(
    `delete from payments where folio_id in (
       select f.id from folios f join reservations r on r.id = f.reservation_id where r.notes = $1)`,
    [TAG],
  );
  await db.query(
    `delete from folio_items where folio_id in (
       select f.id from folios f join reservations r on r.id = f.reservation_id where r.notes = $1)`,
    [TAG],
  );
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
  await db.query(`delete from guests where name like $1`, [`%${TAG}`]);
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

async function eventCount(kind: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*) as n from events where kind = $1`,
    [kind],
  );
  return Number(rows[0].n);
}

describe("extend", () => {
  it("widens the stay and bills the extra nights at the calendar rate", async () => {
    const w = window(20);
    const res = await checkedIn(`Ext ${TAG}`, w.from, w.to);
    assert.equal((await folioOf(res.id)).chargesPaise, RATE * 2);

    const result = await extend(res.id, w.extended);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.split, false, "no bed change needed");

    const [alloc] = await allocationsOf(res.id);
    assert.equal(alloc.hi, w.extended, "the allocation widened");
    assert.equal((await folioOf(res.id)).chargesPaise, RATE * 4, "two extra nights billed");
  });

  it("refuses when the bed is taken, and offers a move and a split", async () => {
    const w = window(30);
    const res = await checkedIn(`Blocked ${TAG}`, w.from, w.to);
    const [alloc] = await allocationsOf(res.id);

    // Someone else has that exact bed for the nights being asked for.
    await db.query(
      `insert into allocations (unit_id, reason, stay)
       values ($1, 'maintenance', daterange($2::date, $3::date, '[)'))`,
      [alloc.unit_id, w.to, w.extended],
    );

    const result = await extend(res.id, w.extended);
    assert.equal(result.ok, false);
    assert.equal(result.code, "UNITS_TAKEN");

    const blocked = result.options!.blocked;
    assert.equal(blocked.length, 1, "the one conflicting allocation is named");
    assert.ok(blocked[0].moveOptions.length > 0, "somewhere free for the whole stay");
    assert.ok(blocked[0].splitOptions.length > 0, "somewhere free for the extra nights");

    // Refused means nothing changed.
    const { rows } = await db.query<{ checkout: string }>(
      `select checkout::text from reservations where id = $1`,
      [res.id],
    );
    assert.equal(rows[0].checkout, w.to, "checkout untouched");
    assert.equal((await folioOf(res.id)).chargesPaise, RATE * 2, "nothing extra billed");
  });

  it("extends by MOVING the whole stay to a free unit", async () => {
    const w = window(40);
    const res = await checkedIn(`Move ${TAG}`, w.from, w.to);
    const [alloc] = await allocationsOf(res.id);
    await db.query(
      `insert into allocations (unit_id, reason, stay)
       values ($1, 'maintenance', daterange($2::date, $3::date, '[)'))`,
      [alloc.unit_id, w.to, w.extended],
    );

    const options = await extend(res.id, w.extended);
    const target = options.options!.blocked[0].moveOptions[0].unitId;

    const result = await extend(res.id, w.extended, [
      { allocationId: alloc.id, action: "move", unitId: target },
    ]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.split, false, "one bed for the whole stay");

    const after = await allocationsOf(res.id);
    assert.equal(after.length, 1, "still a single allocation");
    assert.equal(after[0].unit_id, target, "moved to the free unit");
    assert.equal(after[0].lo, w.from, "the whole stay came with them");
    assert.equal(after[0].hi, w.extended);
  });

  it("extends by SPLITTING, leaving the guest in two beds", async () => {
    const w = window(50);
    const res = await checkedIn(`Split ${TAG}`, w.from, w.to);
    const [alloc] = await allocationsOf(res.id);
    await db.query(
      `insert into allocations (unit_id, reason, stay)
       values ($1, 'maintenance', daterange($2::date, $3::date, '[)'))`,
      [alloc.unit_id, w.to, w.extended],
    );

    const options = await extend(res.id, w.extended);
    const target = options.options!.blocked[0].splitOptions[0].unitId;

    const result = await extend(res.id, w.extended, [
      { allocationId: alloc.id, action: "split", unitId: target },
    ]);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.split, true, "the caller is told beds change");

    const after = await allocationsOf(res.id);
    assert.equal(after.length, 2, "original nights plus the extra nights");
    assert.equal(after[0].hi, w.to, "original bed keeps its dates");
    assert.equal(after[1].lo, w.to, "the second bed picks up exactly there");
    assert.equal(after[1].unit_id, target);

    // Both stretches are billed.
    assert.equal((await folioOf(res.id)).chargesPaise, RATE * 4);
  });

  it("refuses a checkout that isn't actually later", async () => {
    const w = window(60);
    const res = await checkedIn(`NoOp ${TAG}`, w.from, w.to);
    const result = await extend(res.id, w.to);
    assert.equal(result.ok, false);
    assert.equal(result.code, "NOT_LATER");
  });
});

describe("shorten", () => {
  it("clips the stay and removes the charges for nights not stayed", async () => {
    const res = await checkedIn(`Short ${TAG}`, plus(todayISO(), -1), plus(todayISO(), 3));
    assert.equal((await folioOf(res.id)).chargesPaise, RATE * 4);

    const { rows } = await db.query<{ r: { ok: boolean; chargesRemoved: number } }>(
      `select stays_shorten($1, $2::date, $3, 'Desk') as r`,
      [res.id, plus(todayISO(), 1), DESK],
    );
    assert.equal(rows[0].r.ok, true);
    assert.equal(rows[0].r.chargesRemoved, 2, "two nights un-billed");

    assert.equal((await folioOf(res.id)).chargesPaise, RATE * 2, "guest pays only for nights stayed");
    const [alloc] = await allocationsOf(res.id);
    assert.equal(alloc.hi, plus(todayISO(), 1));
  });

  it("refuses to shorten past the arrival date", async () => {
    const res = await checkedIn(`Tiny ${TAG}`, plus(todayISO(), -1), plus(todayISO(), 1));
    const { rows } = await db.query<{ r: { ok: boolean; code: string } }>(
      `select stays_shorten($1, $2::date, $3, 'Desk') as r`,
      [res.id, plus(todayISO(), -1), DESK],
    );
    assert.equal(rows[0].r.ok, false);
    assert.equal(rows[0].r.code, "TOO_SHORT");
  });

  it("frees the bed it gives back", async () => {
    const res = await checkedIn(`Free ${TAG}`, plus(todayISO(), -1), plus(todayISO(), 3));
    const [alloc] = await allocationsOf(res.id);
    await db.query(`select stays_shorten($1, $2::date, $3, 'Desk')`, [
      res.id,
      plus(todayISO(), 1),
      DESK,
    ]);

    // Somebody else can now have those nights.
    const { rows } = await db.query<{ n: string }>(
      `select count(*) as n from free_units_for_stay($1, $2::date, $3::date) f
        where f.unit_id = $4`,
      [typeId, plus(todayISO(), 1), plus(todayISO(), 3), alloc.unit_id],
    );
    assert.equal(rows[0].n, "1", "the released nights are sellable again");
  });
});

describe("manual charges", () => {
  it("posts a charge onto the folio", async () => {
    const res = await checkedIn(`Charge ${TAG}`, plus(todayISO(), -1), plus(todayISO(), 1));
    const before = (await folioOf(res.id)).chargesPaise;

    const { rows } = await db.query<{ r: { ok: boolean } }>(
      `select stays_add_charge($1, 'Laundry', 15000, 'extra', $2, 'Desk') as r`,
      [res.id, DESK],
    );
    assert.equal(rows[0].r.ok, true);
    assert.equal((await folioOf(res.id)).chargesPaise, before + 15000);
  });

  it("refuses a charge with no description", async () => {
    const res = await checkedIn(`Blank ${TAG}`, plus(todayISO(), -1), plus(todayISO(), 1));
    const { rows } = await db.query<{ r: { ok: boolean; code: string } }>(
      `select stays_add_charge($1, '   ', 15000, 'extra', $2, 'Desk') as r`,
      [res.id, DESK],
    );
    assert.equal(rows[0].r.ok, false);
    assert.equal(rows[0].r.code, "DESCRIPTION_REQUIRED");
  });
});

describe("no-show", () => {
  it("releases the inventory and records why", async () => {
    const res = await book(`Ghost ${TAG}`, plus(todayISO(), -1), plus(todayISO(), 1));
    const [alloc] = await allocationsOf(res.id);

    const { rows } = await db.query<{ r: { ok: boolean; unitsReleased: number } }>(
      `select stays_mark_no_show($1, $2, 'Desk') as r`,
      [res.id, DESK],
    );
    assert.equal(rows[0].r.ok, true);
    assert.equal(rows[0].r.unitsReleased, 1);

    const { rows: st } = await db.query<{ status: string }>(
      `select status from reservations where id = $1`,
      [res.id],
    );
    assert.equal(st[0].status, "no_show");

    const { rows: free } = await db.query<{ n: string }>(
      `select count(*) as n from free_units_for_stay($1, $2::date, $3::date) f
        where f.unit_id = $4`,
      [typeId, plus(todayISO(), -1), plus(todayISO(), 1), alloc.unit_id],
    );
    assert.equal(free[0].n, "1", "the bed is sellable again");
  });

  it("refuses to mark someone in-house as a no-show", async () => {
    const res = await checkedIn(`Present ${TAG}`, plus(todayISO(), -1), plus(todayISO(), 1));
    const { rows } = await db.query<{ r: { ok: boolean; code: string } }>(
      `select stays_mark_no_show($1, $2, 'Desk') as r`,
      [res.id, DESK],
    );
    assert.equal(rows[0].r.ok, false);
    assert.equal(rows[0].r.code, "NOT_PENDING");
  });
});

describe("housekeeping", () => {
  it("sets a room's status and logs who did it", async () => {
    const { rows: room } = await db.query<{ id: string }>(
      `select id from rooms where room_type_id = $1 order by number limit 1`,
      [typeId],
    );
    const before = await eventCount("room.housekeeping");

    const { rows } = await db.query<{ r: { ok: boolean; status: string } }>(
      `select set_room_housekeeping($1, 'dirty', $2, 'HK') as r`,
      [room[0].id, DESK],
    );
    assert.equal(rows[0].r.ok, true);
    assert.equal(rows[0].r.status, "dirty");
    assert.equal(await eventCount("room.housekeeping"), before + 1, "one event");
  });

  it("says nothing and logs nothing when the status is unchanged", async () => {
    const { rows: room } = await db.query<{ id: string }>(
      `select id from rooms where room_type_id = $1 order by number limit 1`,
      [typeId],
    );
    await db.query(`select set_room_housekeeping($1, 'clean', $2, 'HK')`, [room[0].id, DESK]);
    const before = await eventCount("room.housekeeping");

    const { rows } = await db.query<{ r: { ok: boolean; unchanged: boolean } }>(
      `select set_room_housekeeping($1, 'clean', $2, 'HK') as r`,
      [room[0].id, DESK],
    );
    assert.equal(rows[0].r.unchanged, true);
    assert.equal(await eventCount("room.housekeeping"), before, "no noise in the feed");
  });

  it("rejects a status that isn't one of the four", async () => {
    const { rows: room } = await db.query<{ id: string }>(
      `select id from rooms where room_type_id = $1 limit 1`,
      [typeId],
    );
    const { rows } = await db.query<{ r: { ok: boolean; code: string } }>(
      `select set_room_housekeeping($1, 'sparkling', $2, 'HK') as r`,
      [room[0].id, DESK],
    );
    assert.equal(rows[0].r.ok, false);
    assert.equal(rows[0].r.code, "BAD_STATUS");
  });

  it("warns that out-of-order alone does NOT stop the room selling", async () => {
    const { rows: room } = await db.query<{ id: string }>(
      `select id from rooms where room_type_id = $1 order by number desc limit 1`,
      [typeId],
    );
    const { rows } = await db.query<{ r: { ok: boolean; needsBlock: boolean } }>(
      `select set_room_housekeeping($1, 'out_of_order', $2, 'HK') as r`,
      [room[0].id, DESK],
    );
    assert.equal(rows[0].r.ok, true);
    assert.equal(
      rows[0].r.needsBlock,
      true,
      "a label is not a sales block — the caller must be told",
    );

    // Block it properly and the warning goes away.
    const { rows: unit } = await db.query<{ id: string }>(
      `select id from units where room_id = $1 limit 1`,
      [room[0].id],
    );
    await db.query(
      `insert into allocations (unit_id, reason, stay)
       values ($1, 'maintenance', daterange(current_date, current_date + 2, '[)'))`,
      [unit[0].id],
    );
    await db.query(`select set_room_housekeeping($1, 'clean', $2, 'HK')`, [room[0].id, DESK]);
    const { rows: again } = await db.query<{ r: { needsBlock: boolean } }>(
      `select set_room_housekeeping($1, 'out_of_order', $2, 'HK') as r`,
      [room[0].id, DESK],
    );
    assert.equal(again[0].r.needsBlock, false, "genuinely off sale now");
  });

  it("checkout leaves the room dirty, and housekeeping can clear it", async () => {
    const w = window(70);
    const res = await checkedIn(`HK ${TAG}`, w.from, w.to);
    const { rows: f } = await db.query<{ f: { balancePaise: number } }>(
      `select stays_folio($1) as f`,
      [res.id],
    );
    await db.query(`select stays_checkout($1, $2::jsonb, 0, null, $3, 'Desk')`, [
      res.id,
      JSON.stringify([{ method: "cash", amountPaise: f[0].f.balancePaise }]),
      DESK,
    ]);

    const { rows: room } = await db.query<{ id: string; housekeeping: string }>(
      `select rm.id, rm.housekeeping from rooms rm
        where rm.id in (select u.room_id from allocations a join units u on u.id = a.unit_id
                         where a.reservation_id = $1) limit 1`,
      [res.id],
    );
    assert.equal(room[0].housekeeping, "dirty", "checkout dirties the room");

    await db.query(`select set_room_housekeeping($1, 'clean', $2, 'HK')`, [room[0].id, DESK]);
    const { rows: after } = await db.query<{ housekeeping: string }>(
      `select housekeeping from rooms where id = $1`,
      [room[0].id],
    );
    assert.equal(after[0].housekeeping, "clean");
  });
});

describe("in-house list", () => {
  it("shows a checked-in stay with nights left and its balance", async () => {
    const res = await checkedIn(`Listed ${TAG}`, plus(todayISO(), -1), plus(todayISO(), 2));
    const { rows } = await db.query<{ d: { stays: Record<string, unknown>[] } }>(
      `select stays_in_house($1) as d`,
      [res.code],
    );
    const row = rows[0].d.stays[0] as {
      code: string;
      nightsLeft: number;
      folio: { balancePaise: number };
    };
    assert.equal(row.code, res.code);
    assert.equal(row.nightsLeft, 2, "two nights still to run");
    assert.equal(row.folio.balancePaise, RATE * 3);
  });
});
