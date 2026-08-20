/**
 * Deposit computation + payment-intent authority (Phase 9, Phase 4).
 *
 * The deposit is computed server-side from the rate calendar (never a client value),
 * stored on payment_intents, and is the exact amount the Razorpay order must use.
 * Money is integer paise; reservations.status and the allocations exclusion
 * constraint are untouched; payments has no status column.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

let db: Client;
let channelCode: string;
let typeId: string;
let CI: string;
let CO: string;

async function createHold(qty = 1): Promise<{ id: string }> {
  const { rows } = await db.query<{ r: { ok: boolean; reservation?: { id: string } } }>(
    `select create_reservation(
        p_guest := $1::jsonb, p_checkin := $2, p_checkout := $3,
        p_lines := $4::jsonb, p_source := $5, p_hold_minutes := 15) as r`,
    [
      JSON.stringify({ name: "Pay Test", phone: "9990003333", notes: "PHASE4_TEST" }),
      CI, CO,
      JSON.stringify([{ roomTypeId: typeId, ratePlanId: null, qty }]),
      channelCode,
    ],
  );
  assert.ok(rows[0].r.ok, "hold created");
  return { id: rows[0].r.reservation!.id };
}
async function cleanup() {
  await db.query(`delete from reservations where notes = 'PHASE4_TEST'`);
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '15s'");
  const { rows: ch } = await db.query<{ code: string }>(
    `select code from channels where active and not public.is_ota_channel(code)
      order by (code='website') desc, code limit 1`,
  );
  channelCode = ch[0].code;
  const dates = await db.query<{ ci: string; co: string }>(
    `select (current_date + 45)::text as ci, (current_date + 47)::text as co`,
  );
  CI = dates.rows[0].ci;
  CO = dates.rows[0].co;
  const { rows } = await db.query<{ id: string }>(
    `select rt.id from room_types rt join units u on u.room_type_id = rt.id and u.active
      where rt.active and exists (select 1 from rates r join rate_plans rp on rp.id=r.rate_plan_id
              where r.room_type_id=rt.id and rp.active and not r.closed and r.stay_date=$1::date)
      group by rt.id having count(u.*) >= 2 order by count(u.*) desc limit 1`,
    [CI],
  );
  typeId = rows[0].id;
});
beforeEach(cleanup);
after(async () => {
  await cleanup();
  await db.end();
});

describe("deposit is server-authoritative", () => {
  it("2/3/4. deposit is exactly 20% of the stay total, in integer paise", async () => {
    const { id } = await createHold(1);
    const { rows } = await db.query<{ d: { ok: boolean; totalPaise: number; depositPaise: number; percent: string; currency: string } }>(
      `select deposit_for_reservation($1) as d`, [id]);
    const d = rows[0].d;
    assert.equal(d.ok, true);
    assert.ok(Number.isInteger(d.totalPaise) && d.totalPaise > 0, "total is integer paise");
    assert.ok(Number.isInteger(d.depositPaise), "deposit is integer paise");
    assert.equal(d.depositPaise, Math.round(d.totalPaise * 0.2), "deposit is exactly 20%");
    assert.equal(Number(d.percent), 20);
    assert.equal(d.currency, "INR");
  });

  it("4/5/6. the Razorpay order amount is exactly the stored payment_intent amount (no client value)", async () => {
    const { id } = await createHold(1);
    const { rows: dr } = await db.query<{ d: { depositPaise: number; percent: number } }>(
      `select deposit_for_reservation($1) as d`, [id]);
    const deposit = dr[0].d.depositPaise;
    // create_payment_intent takes the SERVER amount + percent; no client-amount input.
    await db.query(`select create_payment_intent($1, $2, $3, $4, 'INR')`,
      [id, `order_${id.slice(0, 8)}`, deposit, dr[0].d.percent]);
    const { rows } = await db.query<{ amount_paise: number; status: string; accepted: boolean }>(
      `select pi.amount_paise, pi.status,
              (select policy_accepted_at is not null from reservations where id=$1) as accepted
         from payment_intents pi where pi.reservation_id=$1`, [id]);
    assert.equal(rows[0].amount_paise, deposit, "intent amount = server deposit; the order uses this");
    assert.equal(rows[0].status, "ordered");
    assert.equal(rows[0].accepted, true, "policy acceptance recorded");
  });

  it("deposit_for_reservation derives the amount from the reservation only (no overridable amount arg)", async () => {
    const { rows } = await db.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='deposit_for_reservation'`,
    );
    assert.match(rows[0].args, /^p_reservation_id uuid$/, "amount cannot be supplied by a caller/client");
  });
});

describe("money-model invariants", () => {
  it("payment_intents/refunds amounts are integer paise; payments has NO status column", async () => {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.columns
        where table_schema='public'
          and ((table_name='payment_intents' and column_name='amount_paise')
            or (table_name='refunds' and column_name='amount_paise'))
          and data_type='integer'`,
    );
    assert.equal(rows[0].n, 2, "both amount columns are integer paise");
    const { rows: st } = await db.query<{ n: number }>(
      `select count(*)::int as n from information_schema.columns
        where table_schema='public' and table_name='payments' and column_name='status'`,
    );
    assert.equal(st[0].n, 0, "payments must not gain a status column");
  });

  it("35/36. reservations.status keeps six values; allocations exclusion constraint unchanged", async () => {
    const { rows } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c
         join pg_class t on t.oid=c.conrelid
        where t.relname='reservations' and c.contype='c' and pg_get_constraintdef(c.oid) ilike '%status%'`,
    );
    const def = rows.map((r) => r.def).join(" ");
    for (const v of ["hold", "confirmed", "checked_in", "checked_out", "cancelled", "no_show"]) {
      assert.ok(def.includes(`'${v}'`), `status keeps ${v}`);
    }
    for (const bad of ["payment_pending", "paid", "payment_failed", "refund_pending", "refunded"]) {
      assert.ok(!def.includes(bad), `status must not contain ${bad}`);
    }
    const { rows: ex } = await db.query<{ def: string }>(
      `select pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid=c.conrelid
        where t.relname='allocations' and c.conname='allocations_no_overlap'`,
    );
    assert.match(ex[0].def.replace(/\s+/g, " "), /EXCLUDE USING gist \(unit_id WITH =, stay WITH &&\)/i);
  });
});
