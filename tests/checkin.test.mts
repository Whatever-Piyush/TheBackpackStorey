/**
 * Arrivals and check-in (ROADMAP M2 item 2), plus a regression guarding the
 * role checks themselves.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

const TAG = `CHECKIN_${Date.now().toString(36).toUpperCase()}`;
const DESK = "66666666-6666-6666-6666-666666666666";
const GHOST = "77777777-7777-7777-7777-777777777777";

let db: Client;
let typeId: string;

async function book(name: string, nationality: string | null, qty: number, from: string, to: string) {
  const { rows } = await db.query<{
    r: { ok: boolean; reservation?: { id: string; code: string } };
  }>(
    `select create_reservation(
       jsonb_build_object('name', $1::text, 'phone', '+910000000002',
                          'nationality', $2::text, 'notes', $3::text),
       $4::date, $5::date,
       jsonb_build_array(jsonb_build_object('roomTypeId', $6::text, 'ratePlanId', null, 'qty', $7::int)),
       'website', null, null, 'T') as r`,
    [name, nationality, TAG, from, to, typeId, qty],
  );
  assert.ok(rows[0].r.ok, `fixture booking failed: ${JSON.stringify(rows[0].r)}`);
  return rows[0].r.reservation!;
}

/** The lead guest already linked at booking time — what the drawer prefills. */
async function leadGuestId(reservationId: string): Promise<string> {
  const { rows } = await db.query<{ guest_id: string }>(
    `select guest_id from reservation_guests where reservation_id = $1 and is_lead`,
    [reservationId],
  );
  return rows[0].guest_id;
}

const arrivalsFor = async (code: string) => {
  const { rows } = await db.query<{ a: { arrivals: Record<string, unknown>[] } }>(
    `select stays_arrivals(null, $1) as a`,
    [code],
  );
  return rows[0].a.arrivals;
};

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '10s'");

  for (const [id, name, role] of [
    [DESK, "Desk Test", "reception"],
    [GHOST, "Ghost", null],
  ] as const) {
    await db.query(
      `insert into auth.users (id, email) values ($1::uuid, $1::text || '@local') on conflict (id) do nothing`,
      [id],
    );
    if (role) {
      await db.query(
        `insert into profiles (id, full_name, role) values ($1, $2, $3)
         on conflict (id) do update set role = excluded.role`,
        [id, name, role],
      );
    } else {
      // A signed-in user with NO profile row — the bypass case.
      await db.query(`delete from profiles where id = $1`, [id]);
    }
  }
  await db.query(`set request.jwt.claim.sub = '${DESK}'`);

  // Plenty of beds of our own: these tests all book around today, so a small
  // dorm would exhaust itself halfway through the suite.
  const { rows } = await db.query<{ id: string }>(
    `insert into room_types (code, name, sell_mode, base_occupancy, max_occupancy, sort_order)
     values ($1, $1, 'per_bed', 1, 6, 997) returning id`,
    [TAG],
  );
  typeId = rows[0].id;
  const { rows: room } = await db.query<{ id: string }>(
    `insert into rooms (room_type_id, number, name, type, total_beds, is_dorm)
     values ($1, $2, $2, 'dorm', 24, true) returning id`,
    [typeId, `${TAG}-D`],
  );
  for (let i = 1; i <= 24; i += 1) {
    await db.query(`insert into beds (room_id, label) values ($1, $2)`, [room[0].id, `B${i}`]);
  }
});

after(async () => {
  await db.query(
    `delete from allocations where unit_id in (select id from units where room_type_id = $1)`,
    [typeId],
  );
  await db.query(
    `delete from guest_documents where guest_id in (select id from guests where name like $1)`,
    [`%${TAG}`],
  );
  await db.query(
    `delete from folios where reservation_id in (
       select r.id from reservations r join guests g on g.id = r.guest_id where g.name like $1)`,
    [`%${TAG}`],
  );
  await db.query(
    `delete from reservation_guests where reservation_id in (
       select id from reservations where notes = $1)`,
    [TAG],
  );
  await db.query(`delete from reservations where notes = $1`, [TAG]);
  await db.query(`delete from guests where name like $1`, [`%${TAG}`]);
  await db.query(`delete from units where room_type_id = $1`, [typeId]);
  await db.query(`delete from beds where room_id in (select id from rooms where room_type_id = $1)`, [typeId]);
  await db.query(`delete from rooms where room_type_id = $1`, [typeId]);
  await db.query(`delete from room_types where id = $1`, [typeId]);
  await db.end();
});

describe("role guards", () => {
  it("refuses a signed-in user who has no profile row", async () => {
    // `NULL not in (...)` is NULL, so an unguarded check would SILENTLY PASS.
    await db.query(`set request.jwt.claim.sub = '${GHOST}'`);
    const { rows } = await db.query<{ role: string | null }>(
      `select public.user_role() as role`,
    );
    assert.equal(rows[0].role, null, "the ghost really has no role");

    for (const call of [
      `select stays_arrivals()`,
      `select stays_board()`,
      `select pos_today()`,
      `select pos_close_day()`,
      `select foreign_guest_register(current_date, current_date + 1)`,
    ]) {
      await assert.rejects(
        () => db.query(call),
        /not permitted/,
        `${call} must refuse a roleless caller`,
      );
    }
    await db.query(`set request.jwt.claim.sub = '${DESK}'`);
  });
});

describe("arrivals list", () => {
  it("shows an expected arrival with every unit on the booking", async () => {
    const res = await book(`Group ${TAG}`, "India", 3, todayISO(), plus(todayISO(), 2));
    const [row] = await arrivalsFor(res.code);

    assert.ok(row, "the booking should appear");
    assert.equal((row.units as unknown[]).length, 3, "all three beds listed");
    assert.equal(row.overdue, false);

    // A brand-new booking already shows its booker as a party of one.
    const party = row.party as { isForeign: boolean; isLead: boolean }[];
    assert.equal(party.length, 1, "the booker is linked from the moment of booking");
    assert.equal(party[0].isLead, true);
    assert.equal(party[0].isForeign, false, "Indian nationality is not foreign");
  });

  it("flags a foreign national and keeps an overdue arrival on the list", async () => {
    const res = await book(`Lena ${TAG}`, "Germany", 1, plus(todayISO(), -2), plus(todayISO(), 1));
    const [row] = await arrivalsFor(res.code);

    const party = row.party as { isForeign: boolean }[];
    assert.equal(party[0].isForeign, true, "Germany is foreign");
    assert.equal(
      row.overdue,
      true,
      "an arrival expected earlier must not drop off the list",
    );
  });

  it("finds a booking by code, and ignores one that doesn't match", async () => {
    const res = await book(`Searchable ${TAG}`, "India", 1, todayISO(), plus(todayISO(), 1));
    assert.equal((await arrivalsFor(res.code)).length, 1);
    assert.equal((await arrivalsFor("BS-NOTREAL")).length, 0);
  });
});

describe("check-in", () => {
  it("checks a 3-bed group in with ONE action and writes ONE event", async () => {
    const res = await book(`OneAction ${TAG}`, "India", 3, todayISO(), plus(todayISO(), 2));
    const before = await eventCount();

    const { rows } = await db.query<{ r: { ok: boolean; units: number; rooms: string } }>(
      `select check_in_reservation($1, $2::jsonb, $3, 'Reception') as r`,
      [res.id, JSON.stringify([{ guestId: await leadGuestId(res.id), name: `OneAction ${TAG}`, idProofNumber: "AADH-1" }]), DESK],
    );
    assert.equal(rows[0].r.ok, true);
    assert.equal(rows[0].r.units, 3, "all three beds covered by one action");

    const { rows: after } = await db.query<{ status: string; checked_in_at: string | null }>(
      `select status, checked_in_at from reservations where id = $1`,
      [res.id],
    );
    assert.equal(after[0].status, "checked_in");
    assert.ok(after[0].checked_in_at, "arrival time recorded");

    assert.equal(await eventCount(), before + 1, "exactly one event, not one per bed");
  });

  it("stores passport and journey details, and the register picks them up", async () => {
    const res = await book(`Register ${TAG}`, "Germany", 1, todayISO(), plus(todayISO(), 2));

    await db.query(
      `select check_in_reservation($1, $2::jsonb, $3, 'Reception')`,
      [
        res.id,
        JSON.stringify([
          {
            guestId: await leadGuestId(res.id),
            name: `Register ${TAG}`,
            nationality: "Germany",
            passportNumber: "C01X00T47",
            passportExpiry: "2031-04-02",
            arrivedInIndiaOn: "2026-07-01",
            arrivedFrom: "Delhi",
            nextDestination: "Manali",
          },
        ]),
        DESK,
      ],
    );

    await db.query(`set request.jwt.claim.sub = '${DESK}'`);
    await db.query(`update profiles set role = 'owner' where id = $1`, [DESK]);
    const { rows } = await db.query<{ reg: Record<string, string>[] }>(
      `select foreign_guest_register($1::date, $2::date) as reg`,
      [plus(todayISO(), -1), plus(todayISO(), 1)],
    );
    await db.query(`update profiles set role = 'reception' where id = $1`, [DESK]);

    const mine = rows[0].reg.find((r) => r.code === res.code);
    assert.ok(mine, "the foreign guest is on the register");
    assert.equal(mine!.passportNumber, "C01X00T47");
    assert.equal(mine!.arrivedFrom, "Delhi");
    assert.equal(mine!.nextDestination, "Manali");
  });

  it("never blanks details that were captured at booking time", async () => {
    const res = await book(`Keep ${TAG}`, "France", 1, todayISO(), plus(todayISO(), 1));
    // Empty strings must be ignored, not written over the existing nationality.
    // The lead guest already exists, so pass their id and blank the fields.
    const { rows: lead } = await db.query<{ guest_id: string }>(
      `select guest_id from reservations where id = $1`,
      [res.id],
    );
    await db.query(
      `select check_in_reservation($1, $2::jsonb, $3, 'Reception')`,
      [
        res.id,
        JSON.stringify([
          { guestId: lead[0].guest_id, name: `Keep ${TAG}`, nationality: "", phone: "", idProofNumber: "AADH-2" },
        ]),
        DESK,
      ],
    );
    const { rows } = await db.query<{ nationality: string; phone: string }>(
      `select g.nationality, g.phone from guests g
        join reservations r on r.guest_id = g.id where r.id = $1`,
      [res.id],
    );
    assert.equal(rows[0].nationality, "France");
    assert.equal(rows[0].phone, "+910000000002");
  });

  it("refuses a second check-in", async () => {
    const res = await book(`Twice ${TAG}`, "India", 1, todayISO(), plus(todayISO(), 1));
    const party = JSON.stringify([{ name: `Twice ${TAG}`, idProofNumber: "AADH-3" }]);
    await db.query(`select check_in_reservation($1, $2::jsonb, $3, 'R')`, [res.id, party, DESK]);

    const { rows } = await db.query<{ r: { ok: boolean; code: string } }>(
      `select check_in_reservation($1, $2::jsonb, $3, 'R') as r`,
      [res.id, party, DESK],
    );
    assert.equal(rows[0].r.ok, false);
    assert.equal(rows[0].r.code, "ALREADY_CHECKED_IN");
  });

  it("refuses a cancelled booking", async () => {
    const res = await book(`Gone ${TAG}`, "India", 1, todayISO(), plus(todayISO(), 1));
    await db.query(`select cancel_reservation($1, $2, 'R')`, [res.id, DESK]);

    const { rows } = await db.query<{ r: { ok: boolean; code: string } }>(
      `select check_in_reservation($1, $2::jsonb, $3, 'R') as r`,
      [res.id, JSON.stringify([{ name: `Gone ${TAG}`, idProofNumber: "AADH-4" }]), DESK],
    );
    assert.equal(rows[0].r.ok, false);
    assert.equal(rows[0].r.code, "NOT_ARRIVABLE");
  });

  it("refuses check-in when any guest has no ID, and writes NOTHING", async () => {
    const res = await book(`NoId ${TAG}`, "India", 2, todayISO(), plus(todayISO(), 1));
    const before = await eventCount();

    const { rows } = await db.query<{ r: { ok: boolean; code: string; missing: string[] } }>(
      `select check_in_reservation($1, $2::jsonb, $3, 'R') as r`,
      [
        res.id,
        JSON.stringify([
          { guestId: await leadGuestId(res.id), name: `HasId ${TAG}`, idProofNumber: "AADH-9" },
          { name: `NoId ${TAG}` },
        ]),
        DESK,
      ],
    );
    assert.equal(rows[0].r.ok, false);
    assert.equal(rows[0].r.code, "ID_REQUIRED");
    assert.deepEqual(rows[0].r.missing, [`NoId ${TAG}`], "names the person who is missing ID");

    // The booker is linked from booking time; what must NOT happen is the
    // second person being recorded, or the stay going in-house.
    const { rows: linked } = await db.query<{ n: string }>(
      `select count(*) as n from reservation_guests where reservation_id = $1`,
      [res.id],
    );
    assert.equal(linked[0].n, "1", "only the booker, nobody added");
    const { rows: st } = await db.query<{ status: string }>(
      `select status from reservations where id = $1`,
      [res.id],
    );
    assert.equal(st[0].status, "confirmed", "still not checked in");
    assert.equal(await eventCount(), before, "no event either");
  });

  it("records every person on a group booking, with one lead", async () => {
    const res = await book(`Party ${TAG}`, "India", 3, todayISO(), plus(todayISO(), 2));

    const { rows } = await db.query<{ r: { ok: boolean; guests: number } }>(
      `select check_in_reservation($1, $2::jsonb, $3, 'R') as r`,
      [
        res.id,
        JSON.stringify([
          { guestId: await leadGuestId(res.id), name: `Lead ${TAG}`, idProofNumber: "P-1", isLead: true },
          { name: `Second ${TAG}`, nationality: "France", passportNumber: "FR-2" },
          { name: `Third ${TAG}`, idProofNumber: "P-3" },
        ]),
        DESK,
      ],
    );
    assert.equal(rows[0].r.ok, true);
    assert.equal(rows[0].r.guests, 3, "three people recorded");

    const { rows: linked } = await db.query<{ n: string; leads: string }>(
      `select count(*) as n, count(*) filter (where is_lead) as leads
         from reservation_guests where reservation_id = $1`,
      [res.id],
    );
    assert.equal(linked[0].n, "3");
    assert.equal(linked[0].leads, "1", "exactly one lead");

    // Each person is their own row, so each carries their own passport.
    const { rows: fr } = await db.query<{ passport_number: string }>(
      `select g.passport_number from reservation_guests rg
         join guests g on g.id = rg.guest_id
        where rg.reservation_id = $1 and g.nationality = 'France'`,
      [res.id],
    );
    assert.equal(fr[0].passport_number, "FR-2");
  });

  it("puts every foreign guest on the register, not just the lead", async () => {
    const res = await book(`Mixed ${TAG}`, "India", 2, todayISO(), plus(todayISO(), 2));
    await db.query(
      `select check_in_reservation($1, $2::jsonb, $3, 'R')`,
      [
        res.id,
        JSON.stringify([
          { guestId: await leadGuestId(res.id), name: `IndianLead ${TAG}`, nationality: "India",
            idProofNumber: "AADH-7", isLead: true },
          { name: `GermanFriend ${TAG}`, nationality: "Germany", passportNumber: "DE-77",
            arrivedFrom: "Delhi", nextDestination: "Manali" },
        ]),
        DESK,
      ],
    );

    await db.query(`update profiles set role = 'owner' where id = $1`, [DESK]);
    const { rows } = await db.query<{ reg: Record<string, string>[] }>(
      `select foreign_guest_register($1::date, $2::date) as reg`,
      [plus(todayISO(), -1), plus(todayISO(), 1)],
    );
    await db.query(`update profiles set role = 'reception' where id = $1`, [DESK]);

    const mine = rows[0].reg.filter((r) => r.code === res.code);
    assert.equal(mine.length, 1, "only the foreign national is listed");
    assert.equal(mine[0].guestName, `GermanFriend ${TAG}`, "the non-lead foreigner");
    assert.equal(mine[0].arrivedFrom, "Delhi");
  });

  it("drops a checked-in guest off the arrivals list", async () => {
    const res = await book(`Vanish ${TAG}`, "India", 1, todayISO(), plus(todayISO(), 1));
    assert.equal((await arrivalsFor(res.code)).length, 1);
    await db.query(`select check_in_reservation($1, $2::jsonb, $3, 'R')`, [
      res.id,
      JSON.stringify([{ name: `Vanish ${TAG}`, idProofNumber: "AADH-5" }]),
      DESK,
    ]);
    assert.equal((await arrivalsFor(res.code)).length, 0, "no longer expected");
  });
});

async function eventCount(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`select count(*) as n from events`);
  return Number(rows[0].n);
}

/**
 * "Today" as the DATABASE sees it — Asia/Kolkata, which every server function
 * uses. `new Date().toISOString()` is UTC, so between 18:30 and 24:00 UTC it
 * names the previous day and these tests would ask about the wrong date.
 * IST is a fixed +5:30 with no DST, so the offset is safe to hard-code.
 */
const todayISO = () =>
  new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

/** UTC-anchored, matching addDays() in src/lib/dates.ts. */
function plus(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
