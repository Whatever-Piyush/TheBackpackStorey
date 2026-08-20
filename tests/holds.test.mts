/**
 * Booking holds + lazy expiry (Phase 9, Phase 3).
 *
 * Logic + concurrency tests, run as `postgres`. A hold is an inventory claim, not a
 * financial event: creating one reserves units but posts no folio, no room charge,
 * no payment. Expiry is lazy — an expired hold stops blocking inventory with no
 * sweep. confirm_hold() is the atomic, idempotent promotion that snapshots the
 * policy/deposit and posts room charges exactly once.
 *
 * Fixtures mark themselves with guest notes 'PHASE3_TEST' and are reaped between
 * tests, so shared type/date availability stays deterministic.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

let db: Client;
let channelCode: string;
let typeId: string;
let unitCount: number;
let CI: string;
let CO: string;

type ReservationResult = {
  ok: boolean;
  code?: string;
  reservation?: { id: string; code: string; status: string; holdExpiresAt: string | null };
  available?: number;
};

async function createRes(qty: number, holdMinutes: number | null): Promise<ReservationResult> {
  const { rows } = await db.query<{ r: ReservationResult }>(
    `select create_reservation(
        p_guest := $1::jsonb, p_checkin := $2, p_checkout := $3,
        p_lines := $4::jsonb, p_source := $5, p_hold_minutes := $6) as r`,
    [
      JSON.stringify({ name: "Hold Test", phone: "9990001111", notes: "PHASE3_TEST" }),
      CI, CO,
      JSON.stringify([{ roomTypeId: typeId, ratePlanId: null, qty }]),
      channelCode, holdMinutes,
    ],
  );
  return rows[0].r;
}
async function freeUnits(): Promise<number> {
  const { rows } = await db.query<{ f: number }>(
    `select min(free_units)::int as f from inventory_snapshot($1,$2,$3)`,
    [typeId, CI, CO],
  );
  return rows[0].f;
}
async function cleanup(): Promise<void> {
  // Deleting the reservation cascades allocations + folios + folio_items.
  await db.query(`delete from reservations where notes = 'PHASE3_TEST'`);
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '15s'");

  // A DIRECT channel — holds are the website booking path. An OTA source would make
  // ensure_room_charges skip room charges (marketplace-priced), which is not this flow.
  const { rows: ch } = await db.query<{ code: string }>(
    `select code from channels
      where active and not public.is_ota_channel(code)
      order by (code = 'website') desc, code
      limit 1`,
  );
  assert.ok(ch[0]?.code, "test needs an active direct (non-OTA) channel");
  channelCode = ch[0].code;

  const dates = await db.query<{ ci: string; co: string }>(
    `select (current_date + 40)::text as ci, (current_date + 42)::text as co`,
  );
  CI = dates.rows[0].ci;
  CO = dates.rows[0].co;

  // A type with rates on the stay AND at least two units, so we can exhaust to one.
  const { rows } = await db.query<{ id: string; units: number }>(
    `select rt.id, count(u.*)::int as units
       from room_types rt
       join units u on u.room_type_id = rt.id and u.active
      where rt.active
        and exists (select 1 from rates r join rate_plans rp on rp.id = r.rate_plan_id
                     where r.room_type_id = rt.id and rp.active and not r.closed
                       and r.stay_date = $1::date)
      group by rt.id
     having count(u.*) >= 2
      order by count(u.*) desc
      limit 1`,
    [CI],
  );
  assert.ok(rows[0]?.id, "test needs an active type with rates and >= 2 units");
  typeId = rows[0].id;
  unitCount = rows[0].units;
});

beforeEach(cleanup);
after(async () => {
  await cleanup();
  await db.end();
});

describe("hold creation", () => {
  it("1/6/7. a valid booking creates a HOLD with a server-generated expires_at (~15 min)", async () => {
    const r = await createRes(1, 15);
    assert.equal(r.ok, true);
    assert.equal(r.reservation?.status, "hold");
    const { rows } = await db.query<{ within: boolean; expires: string }>(
      `select hold_expires_at is not null
              and hold_expires_at between now() + interval '14 minutes'
                                      and now() + interval '16 minutes' as within,
              hold_expires_at as expires
         from reservations where id = $1`,
      [r.reservation!.id],
    );
    // The client passes no expires_at anywhere — it is derived from the server clock.
    assert.equal(rows[0].within, true, "expires_at must be server-set to ~now()+15m");
  });

  it("8/9. a HOLD creates no folio, no room charges, and no payment", async () => {
    const r = await createRes(1, 15);
    const { rows } = await db.query<{ folios: number; items: number; payments: number }>(
      `select
         (select count(*) from folios f where f.reservation_id = $1)::int as folios,
         (select count(*) from folio_items fi
            join folios f on f.id = fi.folio_id where f.reservation_id = $1)::int as items,
         (select count(*) from payments p
            join folios f on f.id = p.folio_id where f.reservation_id = $1)::int as payments`,
      [r.reservation!.id],
    );
    assert.equal(rows[0].folios, 0, "a hold must not open a folio");
    assert.equal(rows[0].items, 0, "a hold must not post room charges");
    assert.equal(rows[0].payments, 0, "a hold must not create a payment");
  });
});

describe("lazy expiry — inventory", () => {
  it("2/4. an active HOLD blocks inventory", async () => {
    const before = await freeUnits();
    const r = await createRes(1, 15);
    assert.equal(r.ok, true);
    assert.equal(await freeUnits(), before - 1, "an active hold occupies a unit");
  });

  it("5. a CONFIRMED reservation blocks inventory", async () => {
    const before = await freeUnits();
    const r = await createRes(1, null);
    assert.equal(r.reservation?.status, "confirmed");
    assert.equal(await freeUnits(), before - 1);
  });

  it("3. MANDATORY lazy-expiry reclaim: expired hold → normal booking succeeds, no sweep, old hold becomes cancelled/hold_expired", async () => {
    const financialRecords = async (id: string) =>
      Number((await db.query<{ n: string }>(
        `select ((select count(*) from folios where reservation_id=$1)
               + (select count(*) from folio_items fi join folios f on f.id=fi.folio_id where f.reservation_id=$1)
               + (select count(*) from payments p join folios f on f.id=p.folio_id where f.reservation_id=$1))::int as n`,
        [id])).rows[0].n);

    // 1-2. a website HOLD allocates a unit.
    const hold = await createRes(1, 15);
    assert.equal(hold.reservation?.status, "hold");
    const holdId = hold.reservation!.id;
    const before = await freeUnits();
    const { rows: held } = await db.query<{ unit_id: string }>(
      `select unit_id from allocations where reservation_id=$1`, [holdId]);
    assert.equal(held.length, 1, "hold allocated exactly one unit");

    // 10a. no financial records for a hold.
    assert.equal(await financialRecords(holdId), 0, "a hold creates no folio/charge/payment");

    // 3. advance beyond the 15-minute expiry (server clock; no client input).
    await db.query(`update reservations set hold_expires_at = now() - interval '1 second' where id=$1`, [holdId]);

    // 4. BOTH read paths now consider the unit available — with no sweep having run.
    assert.equal(await freeUnits(), before + 1, "inventory_snapshot frees the expired hold's unit");
    const { rows: picks } = await db.query<{ n: string }>(
      `select count(*)::int as n from pick_units($1,$2,$3,1) as u(id)`, [typeId, CI, CO]);
    assert.ok(Number(picks[0].n) >= 1, "pick_units offers a free unit for the expired hold's slot");

    // 5-7. book the SAME slot through the NORMAL create_reservation path — it succeeds.
    const reclaim = await createRes(1, null);
    assert.equal(reclaim.ok, true, "the normal booking path reclaims the expired hold's slot");
    assert.equal(
      (await db.query(`select 1 from allocations where reservation_id=$1`, [reclaim.reservation!.id])).rowCount,
      1, "the reclaiming booking owns a unit");

    // 8-9. the old hold no longer blocks (its allocation is gone), remains as history,
    //      and is now cancelled / hold_expired.
    const { rows: old } = await db.query<{ status: string; cancellation_reason: string; allocs: string }>(
      `select status, cancellation_reason,
              (select count(*) from allocations where reservation_id=$1)::int as allocs
         from reservations where id=$1`, [holdId]);
    assert.equal(Number(old[0].allocs), 0, "expired hold no longer holds any allocation (constraint unblocked)");
    assert.equal(old[0].status, "cancelled", "expired reclaimed hold becomes cancelled");
    assert.equal(old[0].cancellation_reason, "hold_expired", "cancellation_reason recorded");

    // 10b. neither the expired hold nor its cleanup created any financial record.
    assert.equal(await financialRecords(holdId), 0, "no financial records for the expired hold or its cleanup");
  });
});

describe("hold → confirmed promotion", () => {
  async function makeAndConfirm() {
    const r = await createRes(1, 15);
    const { rows } = await db.query<{ c: Record<string, unknown> }>(
      `select confirm_hold($1) as c`, [r.reservation!.id]);
    return { id: r.reservation!.id, confirm: rows[0].c as { ok: boolean; depositPaise: number; totalPaise: number } };
  }

  it("10/11/12. promotion snapshots policy, deposit percent, and deposit amount", async () => {
    const { id, confirm } = await makeAndConfirm();
    assert.equal(confirm.ok, true);
    const { rows } = await db.query(
      `select status, policy_version_id, policy_text_snapshot, cancellation_cutoff_at,
              deposit_percent_snapshot, deposit_amount_paise
         from reservations where id=$1`,
      [id],
    );
    const s = rows[0];
    assert.equal(s.status, "confirmed");
    assert.ok(s.policy_version_id, "policy_version_id snapshotted");
    assert.ok(s.policy_text_snapshot, "policy_text snapshotted");
    assert.ok(s.cancellation_cutoff_at, "cutoff snapshotted");
    assert.equal(Number(s.deposit_percent_snapshot), 20, "20% from active deposit_config");
    assert.equal(s.deposit_amount_paise, confirm.depositPaise);
    assert.equal(s.deposit_amount_paise, Math.round((confirm.totalPaise * 20) / 100));
  });

  it("13/15. promotion posts room charges exactly once (idempotent folio lines)", async () => {
    const { id } = await makeAndConfirm();
    const countLines = async () =>
      (await db.query<{ n: number }>(
        `select count(*)::int as n from folio_items fi
           join folios f on f.id = fi.folio_id
          where f.reservation_id=$1 and fi.kind='room_night'`, [id])).rows[0].n;
    const first = await countLines();
    assert.equal(first, 2, "1 unit x 2 nights = 2 room-night lines");
    // Confirm again: must not duplicate.
    await db.query(`select confirm_hold($1)`, [id]);
    assert.equal(await countLines(), first, "re-confirming must not duplicate folio lines");
  });

  it("14. repeating confirm_hold is an idempotent no-op success", async () => {
    const { id } = await makeAndConfirm();
    const { rows } = await db.query<{ c: { ok: boolean; alreadyConfirmed: boolean } }>(
      `select confirm_hold($1) as c`, [id]);
    assert.equal(rows[0].c.ok, true);
    assert.equal(rows[0].c.alreadyConfirmed, true);
  });

  it("16. an expired hold cannot be confirmed", async () => {
    const r = await createRes(1, 15);
    await db.query(`update reservations set hold_expires_at = now() - interval '1 minute' where id=$1`, [
      r.reservation!.id,
    ]);
    const { rows } = await db.query<{ c: { ok: boolean; code: string } }>(
      `select confirm_hold($1) as c`, [r.reservation!.id]);
    assert.equal(rows[0].c.ok, false);
    assert.equal(rows[0].c.code, "EXPIRED");
  });
});

describe("concurrency + invariants", () => {
  it("17. two concurrent bookings cannot obtain the same unit", async () => {
    // Exhaust to exactly one free unit, then race two single-unit holds.
    if (unitCount > 1) {
      const occupy = await createRes(unitCount - 1, null);
      assert.equal(occupy.ok, true, "setup: occupy all but one unit");
    }
    assert.equal(await freeUnits(), 1, "exactly one unit free before the race");

    const db2 = new Client({ connectionString: CONNECTION });
    await db2.connect();
    try {
      const call = (c: Client) =>
        c.query<{ r: ReservationResult }>(
          `select create_reservation(
              p_guest := $1::jsonb, p_checkin := $2, p_checkout := $3,
              p_lines := $4::jsonb, p_source := $5, p_hold_minutes := 15) as r`,
          [
            JSON.stringify({ name: "Race", phone: "9990002222", notes: "PHASE3_TEST" }),
            CI, CO,
            JSON.stringify([{ roomTypeId: typeId, ratePlanId: null, qty: 1 }]),
            channelCode,
          ],
        );
      const [a, b] = await Promise.all([call(db), call(db2)]);
      const results = [a.rows[0].r, b.rows[0].r];
      const wins = results.filter((r) => r.ok).length;
      const taken = results.filter((r) => !r.ok && r.code === "UNITS_TAKEN").length;
      assert.equal(wins, 1, "exactly one booking may win the last unit");
      assert.equal(taken, 1, "the other must fail cleanly with UNITS_TAKEN");
    } finally {
      await db2.end();
    }
  });

  it("18/19. reservations.status keeps exactly its six values — no payment states", async () => {
    const { rows } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
        where t.relname='reservations' and c.contype='c'
          and pg_get_constraintdef(c.oid) ilike '%status%'`,
    );
    const def = rows.map((r) => r.def).join(" ");
    for (const v of ["hold", "confirmed", "checked_in", "checked_out", "cancelled", "no_show"]) {
      assert.ok(def.includes(`'${v}'`), `status must still allow ${v}`);
    }
    for (const bad of ["payment_pending", "payment_authorized", "payment_captured", "payment_failed", "payment_expired"]) {
      assert.ok(!def.includes(bad), `status must NOT contain ${bad}`);
    }
  });

  it("25. deposit amounts are integer paise", async () => {
    const { rows } = await db.query<{ data_type: string }>(
      `select data_type from information_schema.columns
        where table_schema='public' and table_name='reservations' and column_name='deposit_amount_paise'`,
    );
    assert.equal(rows[0].data_type, "integer");
  });

  it("MANDATORY: the allocations exclusion constraint is intact (not weakened, removed, or bypassed)", async () => {
    // Lazy expiry frees inventory by removing the blocking ROW, never by touching the
    // constraint. Assert the constraint still exists, exactly as the frozen foundation
    // defined it.
    const { rows } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def
         from pg_constraint c join pg_class t on t.oid = c.conrelid
        where t.relname = 'allocations' and c.conname = 'allocations_no_overlap'`,
    );
    assert.ok(rows[0], "allocations_no_overlap must still exist");
    assert.match(
      rows[0].def.replace(/\s+/g, " "),
      /EXCLUDE USING gist \(unit_id WITH =, stay WITH &&\)/i,
      "the exclusion constraint definition must be unchanged",
    );
  });
});
