/**
 * Guest cancellation, forfeiture & refund accounting (Phase 9, Phase 5).
 *
 * Reverse-never-delete: cancellation posts new negative folio lines and the original
 * room_night rows survive. Eligibility comes from the reservation snapshot, never the
 * live policy. Forfeiture nets the folio to zero; a refundable cancellation opens the
 * Phase-4 refund lifecycle (the negative payment appears only on refund.processed).
 * Core cancellation runs as `postgres`; the role-gated staff/no-show paths run as an
 * owner (jwt sub + profile), the harness convention.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION = process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

let db: Client;
let channelCode: string;
let typeId: string;
let CI: string;
let CO: string;
let n = 0;
const uid = (p: string) => `${p}_p5_${++n}_${Date.now()}`;
const OWNER = "88880000-0000-0000-0000-000000000001";
const KITCHEN = "88880000-0000-0000-0000-000000000002";

async function asRole(sub: string, fn: () => Promise<void>) {
  await db.query(`set request.jwt.claim.sub = '${sub}'`);
  await db.query(`set role authenticated`);
  try { await fn(); } finally { await db.query(`reset role`); await db.query(`reset request.jwt.claim.sub`); }
}
async function createHold(): Promise<string> {
  const { rows } = await db.query<{ r: { reservation?: { id: string } } }>(
    `select create_reservation(p_guest:=$1::jsonb, p_checkin:=$2, p_checkout:=$3, p_lines:=$4::jsonb,
        p_source:=$5, p_hold_minutes:=15) as r`,
    [JSON.stringify({ name: "Cxl", phone: "9", notes: "PHASE5_TEST" }), CI, CO,
     JSON.stringify([{ roomTypeId: typeId, ratePlanId: null, qty: 1 }]), channelCode]);
  return rows[0].r.reservation!.id;
}
async function paidReservation(): Promise<{ id: string; deposit: number; total: number }> {
  const id = await createHold();
  const { rows: dr } = await db.query<{ d: { depositPaise: number; totalPaise: number; percent: number } }>(
    `select deposit_for_reservation($1) as d`, [id]);
  const deposit = dr[0].d.depositPaise, total = dr[0].d.totalPaise;
  const orderId = uid("order");
  await db.query(`select create_payment_intent($1,$2,$3,$4,'INR')`, [id, orderId, deposit, dr[0].d.percent]);
  await db.query(`select apply_razorpay_capture($1,$2,$3,'INR',$4,'{}'::jsonb)`, [orderId, uid("pay"), deposit, uid("evt")]);
  return { id, deposit, total };
}
async function cancel(id: string, reason = "guest", waive = false) {
  const { rows } = await db.query<{ r: Record<string, unknown> }>(
    `select cancel_reservation_with_policy($1, null, 'Test', $2, $3, null) as r`, [id, reason, waive]);
  return rows[0].r as { ok: boolean; code: string; refundable: boolean; refundId: string | null; refundPaise: number; forfeitPaise: number };
}
async function folioLines(id: string) {
  const { rows } = await db.query<{ kind: string; amount_paise: number }>(
    `select fi.kind, fi.amount_paise from folio_items fi join folios f on f.id=fi.folio_id where f.reservation_id=$1 order by fi.posted_at`, [id]);
  return rows;
}
async function balance(id: string): Promise<number> {
  const { rows } = await db.query<{ b: number }>(
    `select (coalesce((select sum(amount_paise) from folio_items fi join folios f on f.id=fi.folio_id where f.reservation_id=$1),0)
           - coalesce((select sum(amount_paise) from payments p join folios f on f.id=p.folio_id where f.reservation_id=$1),0))::int as b`, [id]);
  return rows[0].b;
}
async function razorpayPayments(id: string) {
  const { rows } = await db.query<{ amount_paise: number }>(
    `select p.amount_paise from payments p join folios f on f.id=p.folio_id where f.reservation_id=$1 and p.method='razorpay' order by p.received_at`, [id]);
  return rows;
}
async function cleanup() {
  await db.query(`delete from payment_events where provider_event_id like '%_p5_%'`);
  await db.query(`delete from reservations where notes = 'PHASE5_TEST'`);
  await db.query(`delete from cancellation_policies where version >= 500`);
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '15s'");
  const { rows: ch } = await db.query<{ code: string }>(
    `select code from channels where active and not public.is_ota_channel(code) order by (code='website') desc, code limit 1`);
  channelCode = ch[0].code;
  const d = await db.query<{ ci: string; co: string }>(`select (current_date+70)::text as ci, (current_date+72)::text as co`);
  CI = d.rows[0].ci; CO = d.rows[0].co;
  const { rows } = await db.query<{ id: string }>(
    `select rt.id from room_types rt join units u on u.room_type_id=rt.id and u.active
      where rt.active and exists (select 1 from rates r join rate_plans rp on rp.id=r.rate_plan_id
              where r.room_type_id=rt.id and rp.active and not r.closed and r.stay_date=$1::date)
      group by rt.id having count(u.*)>=2 order by count(u.*) desc limit 1`, [CI]);
  typeId = rows[0].id;
  for (const [id, role] of [[OWNER, "owner"], [KITCHEN, "kitchen"]] as const) {
    await db.query(`insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`, [id, `${role}@p5`]);
    await db.query(`insert into profiles (id, full_name, role) values ($1,$2,$3) on conflict (id) do update set role=excluded.role`, [id, role, role]);
  }
});
beforeEach(cleanup);
after(async () => {
  await cleanup();
  await db.query(`delete from profiles where id in ($1,$2)`, [OWNER, KITCHEN]);
  await db.query(`delete from auth.users where id in ($1,$2)`, [OWNER, KITCHEN]);
  await db.end();
});

describe("cancellation eligibility (snapshot-authoritative)", () => {
  it("before cutoff → refundable; after cutoff → forfeited; snapshot survives a live-policy change", async () => {
    const { id } = await paidReservation();
    // Natural cutoff is ~69 days out → refundable.
    assert.equal((await db.query<{ r: { refundable: boolean } }>(`select cancellation_preview($1) as r`, [id])).rows[0].r.refundable, true);
    // Change the LIVE policy (new version, 50% refund, 1000h cutoff). Snapshot must not move.
    await db.query(`insert into cancellation_policies (version, effective_from, cutoff_hours, refund_percent, body_text)
                    values (599, now(), 1000, 50, 'CHANGED')`);
    const before = (await db.query<{ c: string; p: string }>(`select cancellation_cutoff_at::text as c, policy_text_snapshot as p from reservations where id=$1`, [id])).rows[0];
    const p = await cancel(id);
    assert.equal(p.refundable, true, "still refundable per the SNAPSHOT, not the changed live policy");
    const after = (await db.query<{ c: string; p: string }>(`select cancellation_cutoff_at::text as c, policy_text_snapshot as p from reservations where id=$1`, [id])).rows[0];
    assert.equal(after.c, before.c, "cutoff snapshot unchanged");
    assert.equal(after.p, before.p, "policy text snapshot unchanged");
  });
});

describe("forfeiture accounting (reverse-never-delete)", () => {
  it("late cancellation: original charges kept, reversal + fee, folio nets to zero, second cancel adds nothing", async () => {
    const { id, deposit, total } = await paidReservation();
    await db.query(`update reservations set cancellation_cutoff_at = now() - interval '1 hour' where id=$1`, [id]);
    const p = await cancel(id);
    assert.equal(p.refundable, false);
    assert.equal(p.forfeitPaise, deposit);

    const lines = await folioLines(id);
    const room = lines.filter((l) => l.kind === "room_night").reduce((s, l) => s + l.amount_paise, 0);
    assert.equal(room, total, "original room charges remain visible (+total)");
    assert.equal(lines.find((l) => l.kind === "reversal")?.amount_paise, -total, "one reversal = −total");
    assert.equal(lines.find((l) => l.kind === "cancellation_fee")?.amount_paise, deposit, "fee = retained deposit");
    assert.equal(await balance(id), 0, "folio nets to exactly zero");
    assert.equal((await db.query<{ s: string; r: string }>(`select status s, cancellation_reason r from reservations where id=$1`, [id])).rows[0].s, "cancelled");

    // Second cancellation cannot add another reversal / fee / anything.
    const second = await cancel(id);
    assert.equal(second.ok, false);
    assert.equal(second.code, "NOT_CANCELLABLE");
    assert.equal((await folioLines(id)).filter((l) => l.kind === "reversal").length, 1, "no duplicate reversal");
    assert.equal((await folioLines(id)).filter((l) => l.kind === "cancellation_fee").length, 1, "no duplicate fee");
  });
});

describe("refund lifecycle (refundable cancellation)", () => {
  it("one refund requested, no negative payment until refund.processed, then exactly one", async () => {
    const { id, deposit } = await paidReservation();
    const p = await cancel(id);
    assert.equal(p.refundable, true);
    assert.ok(p.refundId, "one refund opened");
    assert.equal(p.refundPaise, deposit);
    assert.equal((await db.query<{ s: string }>(`select status s from refunds where id=$1`, [p.refundId])).rows[0].s, "requested");
    // No negative payment on the request.
    assert.equal((await razorpayPayments(id)).length, 1, "only the deposit payment; no negative yet");
    assert.equal(await balance(id), -deposit, "folio shows the property owes the deposit, pending refund");

    // Provider confirms → exactly one negative payment; folio to zero.
    const provider = uid("rfnd");
    await db.query(`select attach_refund_provider($1,$2)`, [p.refundId, provider]);
    await db.query(`select apply_razorpay_refund_result($1,'processed',$2,'{}'::jsonb)`, [provider, uid("evt")]);
    assert.equal((await razorpayPayments(id)).length, 2, "deposit + one negative refund payment");
    assert.equal(await balance(id), 0, "folio nets to zero after refund");
    // Duplicate refund webhook → nothing more.
    await db.query(`select apply_razorpay_refund_result($1,'processed',$2,'{}'::jsonb)`, [provider, uid("evt")]);
    assert.equal((await razorpayPayments(id)).length, 2, "duplicate refund webhook makes no second negative payment");
  });

  it("refund.failed stays visible and posts no negative payment", async () => {
    const { id } = await paidReservation();
    const p = await cancel(id);
    const provider = uid("rfnd");
    await db.query(`select attach_refund_provider($1,$2)`, [p.refundId, provider]);
    await db.query(`select apply_razorpay_refund_result($1,'failed',$2,'{"error":"x"}'::jsonb)`, [provider, uid("evt")]);
    assert.equal((await db.query<{ s: string }>(`select status s from refunds where id=$1`, [p.refundId])).rows[0].s, "failed");
    assert.equal((await razorpayPayments(id)).length, 1, "no negative payment on failure");
  });
});

describe("inventory + reservation history", () => {
  it("cancellation releases inventory immediately; exclusion constraint unchanged; reservation kept", async () => {
    const before = (await db.query<{ f: number }>(`select min(free_units)::int f from inventory_snapshot($1,$2,$3)`, [typeId, CI, CO])).rows[0].f;
    const { id } = await paidReservation();
    assert.equal((await db.query<{ f: number }>(`select min(free_units)::int f from inventory_snapshot($1,$2,$3)`, [typeId, CI, CO])).rows[0].f, before - 1);
    await cancel(id);
    assert.equal((await db.query<{ n: number }>(`select count(*)::int n from allocations where reservation_id=$1`, [id])).rows[0].n, 0, "allocations released");
    assert.equal((await db.query<{ f: number }>(`select min(free_units)::int f from inventory_snapshot($1,$2,$3)`, [typeId, CI, CO])).rows[0].f, before, "inventory free again immediately");
    assert.ok((await db.query(`select 1 from reservations where id=$1`, [id])).rowCount, "reservation kept as history");
    assert.match((await db.query<{ d: string }>(`select pg_get_constraintdef(c.oid) d from pg_constraint c join pg_class t on t.oid=c.conrelid where t.relname='allocations' and c.conname='allocations_no_overlap'`)).rows[0].d.replace(/\s+/g, " "), /EXCLUDE USING gist \(unit_id WITH =, stay WITH &&\)/i);
  });

  it("concurrency guard: a cancelled reservation cannot be transitioned (e.g. checked_in)", async () => {
    const { id } = await paidReservation();
    await cancel(id);
    await assert.rejects(() => db.query(`update reservations set status='checked_in' where id=$1`, [id]),
      /cannot change|check_violation/i, "terminal-status trigger blocks the overwrite");
  });
});

describe("no-show", () => {
  it("a paid no-show forfeits (reversal + fee, folio zero); a no-deposit no-show keeps prior behaviour", async () => {
    const { id, deposit, total } = await paidReservation();
    await asRole(OWNER, async () => { await db.query(`select stays_mark_no_show($1, $2, 'Owner')`, [id, OWNER]); });
    const lines = await folioLines(id);
    assert.equal(lines.find((l) => l.kind === "reversal")?.amount_paise, -total);
    assert.equal(lines.find((l) => l.kind === "cancellation_fee")?.amount_paise, deposit);
    assert.equal(await balance(id), 0, "paid no-show nets to zero");
    assert.equal((await db.query<{ s: string; r: string }>(`select status s, cancellation_reason r from reservations where id=$1`, [id])).rows[0].s, "no_show");

    // No-deposit confirmed reservation (walk-in style): no financial records on no-show.
    const bare = await createHold();
    await db.query(`update reservations set status='confirmed', hold_expires_at=null where id=$1`, [bare]);
    await asRole(OWNER, async () => { await db.query(`select stays_mark_no_show($1, $2, 'Owner')`, [bare, OWNER]); });
    assert.equal((await folioLines(bare)).length, 0, "no-deposit no-show creates no folio lines");
    assert.equal((await db.query<{ s: string }>(`select status s from reservations where id=$1`, [bare])).rows[0].s, "no_show");
  });
});

describe("security + staff override", () => {
  it("wrong phone cannot preview/cancel another booking", async () => {
    const { id } = await paidReservation();
    const code = (await db.query<{ c: string }>(`select code c from reservations where id=$1`, [id])).rows[0].c;
    assert.equal((await db.query<{ r: { ok: boolean } }>(`select public_cancellation_preview($1,'0000000000') as r`, [code])).rows[0].r.ok, false);
  });

  it("cancellation takes no client amount — the fee/refund derive from the snapshot only", async () => {
    const { rows } = await db.query<{ args: string }>(
      `select pg_get_function_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='cancel_reservation_with_policy'`);
    assert.ok(!/amount|paise/i.test(rows[0].args), "no client-supplied amount parameter exists");
  });

  it("staff cancel is role-gated and a fee waiver requires a reason", async () => {
    const { id } = await paidReservation();
    await db.query(`update reservations set cancellation_cutoff_at = now() - interval '1 hour' where id=$1`, [id]);
    // kitchen cannot cancel
    await asRole(KITCHEN, async () => {
      await assert.rejects(() => db.query(`select stays_cancel($1,$2,'Kitchen',false,null)`, [id, KITCHEN]), /not permitted/);
    });
    // owner waiver without a reason is rejected
    await asRole(OWNER, async () => {
      const r = (await db.query<{ r: { ok: boolean; code: string } }>(`select stays_cancel($1,$2,'Owner',true,null) as r`, [id, OWNER])).rows[0].r;
      assert.equal(r.ok, false); assert.equal(r.code, "REASON_REQUIRED");
      // with a reason, the waiver refunds (no forfeiture) even after cutoff
      const w = (await db.query<{ r: { ok: boolean; refundable: boolean } }>(`select stays_cancel($1,$2,'Owner',true,'goodwill') as r`, [id, OWNER])).rows[0].r;
      assert.equal(w.ok, true); assert.equal(w.refundable, true, "waiver makes it refundable");
    });
    assert.equal((await db.query<{ r: string }>(`select cancellation_reason r from reservations where id=$1`, [id])).rows[0].r, "staff");
  });
});
