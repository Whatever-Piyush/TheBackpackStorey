/**
 * Refund reconciliation (Phase 9, Step 5B).
 *
 * A refundable cancellation opens a refunds row ('requested') and the app then asks
 * Razorpay to refund OUTSIDE the DB transaction. These tests prove the recovery of a
 * refund stranded by a failed or LOST provider call — without ever violating the
 * money invariant: a negative payment appears only on a provider-confirmed
 * 'processed' refund (never on an API 200), and a retry never creates a second
 * refund. They exercise the DB primitives the reconcile route orchestrates
 * (claim_refunds_for_reconcile, attach_refund_provider, record_refund_reconcile_attempt,
 * apply_razorpay_refund_result + self-heal), simulating the provider's answers — the
 * same convention as payments/razorpay-webhook tests. Core runs as `postgres`.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION = process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

let db: Client;
let channelCode: string;
let typeId: string;
let planId: string;
let n = 0;
let win = 0; // each booking gets its own date window, so inventory never collides
const uid = (p: string) => `${p}_recon_${++n}_${Date.now()}`;

/** Book one unit in a fresh, self-priced window (rate upserted so it never depends on seed coverage). */
async function createHold(): Promise<string> {
  const base = 80 + win * 4;
  win += 1;
  const { rows: dd } = await db.query<{ ci: string; co: string }>(
    `select (current_date+${base})::text ci, (current_date+${base + 2})::text co`);
  for (let d = 0; d < 2; d++) {
    await db.query(
      `insert into rates (room_type_id, rate_plan_id, stay_date, price_paise, closed)
       values ($1,$2,(current_date+${base + d})::date,90000,false)
       on conflict (room_type_id, rate_plan_id, stay_date) do update set price_paise=90000, closed=false`,
      [typeId, planId]);
  }
  const { rows } = await db.query<{ r: { reservation?: { id: string } } }>(
    `select create_reservation(p_guest:=$1::jsonb, p_checkin:=$2, p_checkout:=$3, p_lines:=$4::jsonb,
        p_source:=$5, p_hold_minutes:=15) as r`,
    [JSON.stringify({ name: "Recon", phone: "9", notes: "RECON_TEST" }), dd[0].ci, dd[0].co,
     JSON.stringify([{ roomTypeId: typeId, ratePlanId: planId, qty: 1 }]), channelCode]);
  return rows[0].r.reservation!.id;
}
async function paidReservation(): Promise<{ id: string; deposit: number }> {
  const id = await createHold();
  const { rows: dr } = await db.query<{ d: { depositPaise: number; percent: number } }>(
    `select deposit_for_reservation($1) as d`, [id]);
  const deposit = dr[0].d.depositPaise;
  const orderId = uid("order");
  await db.query(`select create_payment_intent($1,$2,$3,$4,'INR')`, [id, orderId, deposit, dr[0].d.percent]);
  await db.query(`select apply_razorpay_capture($1,$2,$3,'INR',$4,'{}'::jsonb)`,
    [orderId, uid("pay"), deposit, uid("evt")]);
  return { id, deposit };
}
/** A refundable cancellation → a 'requested' refund with a NULL provider_refund_id. */
async function refundableCancel(): Promise<{
  resId: string; refundId: string; refundPaise: number; paymentId: string;
}> {
  const { id } = await paidReservation();
  const { rows } = await db.query<{ r: {
    refundable: boolean; refundId: string; refundPaise: number; paymentId: string;
  } }>(`select cancel_reservation_with_policy($1,null,'Test','guest',false,null) as r`, [id]);
  assert.equal(rows[0].r.refundable, true, "cancellation before cutoff must be refundable");
  return { resId: id, refundId: rows[0].r.refundId, refundPaise: rows[0].r.refundPaise, paymentId: rows[0].r.paymentId };
}
async function negativePayments(resId: string): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*) n from payments p join folios f on f.id=p.folio_id
      where f.reservation_id=$1 and p.method='razorpay' and p.amount_paise < 0`, [resId]);
  return Number(rows[0].n);
}
async function refundRow(refundId: string) {
  const { rows } = await db.query<{ status: string; provider_refund_id: string | null; attempts: number; last_reconciled_at: string | null }>(
    `select status, provider_refund_id, attempts, last_reconciled_at from refunds where id=$1`, [refundId]);
  return rows[0];
}
/** The refund.processed webhook body, with our refunds.id carried in the entity notes. */
function processedPayload(providerRefundId: string, ourRefundId: string, amountPaise: number) {
  return JSON.stringify({
    event: "refund.processed",
    payload: { refund: { entity: {
      id: providerRefundId, amount: amountPaise, status: "processed",
      receipt: ourRefundId, notes: { refund_id: ourRefundId },
    } } },
  });
}

async function cleanup() {
  await db.query(`delete from payment_events where provider_event_id like '%_recon_%' or provider_event_id like 'reconcile:%'`);
  await db.query(`delete from reservations where notes = 'RECON_TEST'`);
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '20s'");
  const { rows: ch } = await db.query<{ code: string }>(
    `select code from channels where active and not public.is_ota_channel(code) order by (code='website') desc, code limit 1`);
  channelCode = ch[0].code;
  const { rows } = await db.query<{ id: string; plan: string }>(
    `select rt.id, (select r.rate_plan_id from rates r join rate_plans rp on rp.id=r.rate_plan_id
                     where r.room_type_id=rt.id and rp.active limit 1) as plan
       from room_types rt join units u on u.room_type_id=rt.id and u.active
      where rt.active and exists (select 1 from rates r join rate_plans rp on rp.id=r.rate_plan_id
              where r.room_type_id=rt.id and rp.active)
      group by rt.id having count(u.*)>=1 order by count(u.*) desc limit 1`);
  typeId = rows[0].id; planId = rows[0].plan;
});
beforeEach(cleanup);
after(async () => { await cleanup(); await db.end(); });

// ---------------------------------------------------------------------------
describe("webhook self-heal (lost create-response)", () => {
  it("attaches by notes.refund_id and posts exactly one negative; a duplicate does nothing", async () => {
    // Step 5B item 6: refund created at Razorpay, our response lost → provider_refund_id NULL.
    const { resId, refundId, refundPaise } = await refundableCancel();
    assert.equal((await refundRow(refundId)).provider_refund_id, null, "starts unattached");
    assert.equal(await negativePayments(resId), 0, "no negative before provider confirmation");

    const rfnd = uid("rfnd");
    const r = await db.query<{ r: { ok: boolean; code: string } }>(
      `select apply_razorpay_refund_result($1,'processed',$2,$3::jsonb) as r`,
      [rfnd, uid("evt"), processedPayload(rfnd, refundId, refundPaise)]);
    assert.equal(r.rows[0].r.code, "REFUND_PROCESSED");

    const row = await refundRow(refundId);
    assert.equal(row.status, "processed", "self-healed to processed");
    assert.equal(row.provider_refund_id, rfnd, "provider id now attached");
    assert.equal(await negativePayments(resId), 1, "exactly one negative payment");

    // A redelivery of the same event → no second effect.
    await db.query(`select apply_razorpay_refund_result($1,'processed',$2,$3::jsonb)`,
      [rfnd, uid("evt"), processedPayload(rfnd, refundId, refundPaise)]);
    assert.equal(await negativePayments(resId), 1, "duplicate webhook posts no second negative");
  });

  it("never guesses: no correlation id, wrong id, or amount mismatch → REFUND_NOT_FOUND, no money", async () => {
    const { resId, refundId, refundPaise } = await refundableCancel();

    // (a) no notes.refund_id at all
    const noNotes = JSON.stringify({ payload: { refund: { entity: { id: uid("rfnd"), amount: refundPaise } } } });
    assert.equal((await db.query<{ r: { code: string } }>(
      `select apply_razorpay_refund_result($1,'processed',$2,$3::jsonb) as r`,
      [uid("rfnd"), uid("evt"), noNotes])).rows[0].r.code, "REFUND_NOT_FOUND");

    // (b) wrong correlation id (a random uuid)
    const wrongId = "00000000-0000-0000-0000-0000000000ff";
    assert.equal((await db.query<{ r: { code: string } }>(
      `select apply_razorpay_refund_result($1,'processed',$2,$3::jsonb) as r`,
      [uid("rfnd"), uid("evt"), processedPayload(uid("rfnd"), wrongId, refundPaise)])).rows[0].r.code, "REFUND_NOT_FOUND");

    // (c) right id but WRONG amount → refuse to correlate
    assert.equal((await db.query<{ r: { code: string } }>(
      `select apply_razorpay_refund_result($1,'processed',$2,$3::jsonb) as r`,
      [uid("rfnd"), uid("evt"), processedPayload(uid("rfnd"), refundId, refundPaise + 1)])).rows[0].r.code, "REFUND_NOT_FOUND");

    assert.equal((await refundRow(refundId)).status, "requested", "row untouched");
    assert.equal((await refundRow(refundId)).provider_refund_id, null, "still unattached");
    assert.equal(await negativePayments(resId), 0, "no negative payment on any un-correlatable event");
  });
});

// ---------------------------------------------------------------------------
describe("reconciler discovery (failed initial request / webhook never arrives)", () => {
  it("submits once when the provider has none, then settles to one negative", async () => {
    // Item 7: initiateRefund failed → no provider refund → discover none → submit once.
    const { resId, refundId, refundPaise } = await refundableCancel();
    assert.equal((await refundRow(refundId)).attempts, 0);

    // Reconciler, having found NO refund at the provider, records the attempt + submits.
    await db.query(`select record_refund_reconcile_attempt($1)`, [refundId]);
    const rfnd = uid("rfnd");
    await db.query(`select attach_refund_provider($1,$2)`, [refundId, rfnd]); // provider accepted

    const mid = await refundRow(refundId);
    assert.equal(mid.attempts, 1, "one submit attempt counted");
    assert.equal(mid.status, "processing", "moves to processing once accepted");
    assert.equal(await negativePayments(resId), 0, "still no negative — only accepted, not processed");

    // Provider confirms → exactly one negative.
    await db.query(`select apply_razorpay_refund_result($1,'processed',$2,$3::jsonb)`,
      [rfnd, uid("evt"), processedPayload(rfnd, refundId, refundPaise)]);
    assert.equal((await refundRow(refundId)).status, "processed");
    assert.equal(await negativePayments(resId), 1, "exactly one negative after provider confirmation");
  });

  it("discovers an already-processed provider refund (webhook never arrived) and settles once", async () => {
    // Item 8: refund exists + processed at Razorpay; no webhook reached us.
    const { resId, refundId, refundPaise } = await refundableCancel();
    const rfnd = uid("rfnd"); // the id the reconciler reads from listPaymentRefunds

    await db.query(`select attach_refund_provider($1,$2)`, [refundId, rfnd]);
    await db.query(`select apply_razorpay_refund_result($1,'processed',$2,$3::jsonb)`,
      [rfnd, `reconcile:${rfnd}:processed`, processedPayload(rfnd, refundId, refundPaise)]);

    assert.equal((await refundRow(refundId)).status, "processed");
    assert.equal(await negativePayments(resId), 1, "one negative from the reconcile-driven processed state");

    // A late real webhook for the same provider refund → deduped, no second negative.
    await db.query(`select apply_razorpay_refund_result($1,'processed',$2,$3::jsonb)`,
      [rfnd, uid("evt"), processedPayload(rfnd, refundId, refundPaise)]);
    assert.equal(await negativePayments(resId), 1, "late webhook adds nothing");
  });

  it("attach failure recovers on a later pass without a second provider refund", async () => {
    // Item 9: provider refund exists but attach failed; a later pass attaches it.
    const { resId, refundId, refundPaise } = await refundableCancel();
    const rfnd = uid("rfnd");
    // First pass "fails" to attach (simulated: we simply don't call attach).
    assert.equal((await refundRow(refundId)).provider_refund_id, null);
    // Later pass discovers the SAME provider refund and attaches — coalesce is idempotent.
    await db.query(`select attach_refund_provider($1,$2)`, [refundId, rfnd]);
    await db.query(`select attach_refund_provider($1,$2)`, [refundId, rfnd]); // idempotent re-attach
    assert.equal((await refundRow(refundId)).provider_refund_id, rfnd, "attached exactly once");
    await db.query(`select apply_razorpay_refund_result($1,'processed',$2,$3::jsonb)`,
      [rfnd, uid("evt"), processedPayload(rfnd, refundId, refundPaise)]);
    assert.equal(await negativePayments(resId), 1, "one negative; no duplicate refund/negative");
  });
});

// ---------------------------------------------------------------------------
describe("claim_refunds_for_reconcile (bounded, spaced, concurrent, terminal-safe)", () => {
  async function extraRequestedRefund(): Promise<string> {
    // A directly-inserted 'requested' refund on a real captured intent (claim mechanics
    // only — no money path needed here).
    const { id } = await paidReservation();
    const { rows: pi } = await db.query<{ id: string }>(
      `select id from payment_intents where reservation_id=$1 and status='captured' limit 1`, [id]);
    const { rows } = await db.query<{ id: string }>(
      `insert into refunds (payment_intent_id, reservation_id, amount_paise, status, reason)
       values ($1,$2,5000,'requested','guest') returning id`, [pi[0].id, id]);
    return rows[0].id;
  }

  it("returns at most p_limit rows and stamps last_reconciled_at", async () => {
    for (let i = 0; i < 3; i++) await extraRequestedRefund();
    const { rows } = await db.query<{ n: string }>(
      `select count(*) n from claim_refunds_for_reconcile(2, 0)`);
    assert.equal(Number(rows[0].n), 2, "bounded batch honours p_limit");
    // Two were claimed + stamped; at least one open row remains unstamped.
    const { rows: notStamped } = await db.query<{ n: string }>(
      `select count(*) n from refunds r join reservations res on res.id=r.reservation_id
        where res.notes='RECON_TEST' and r.status='requested' and r.last_reconciled_at is null`);
    assert.ok(Number(notStamped[0].n) >= 1, "unclaimed rows keep a null last_reconciled_at");
  });

  it("does not re-claim within the min-age window (a re-run submits nothing new)", async () => {
    await extraRequestedRefund();
    const first = await db.query<{ n: string }>(`select count(*) n from claim_refunds_for_reconcile(10, 120)`);
    assert.ok(Number(first.rows[0].n) >= 1, "first pass claims the open refund");
    const second = await db.query<{ n: string }>(`select count(*) n from claim_refunds_for_reconcile(10, 120)`);
    assert.equal(Number(second.rows[0].n), 0, "second immediate pass claims nothing (spacing)");
  });

  it("two concurrent claims take DISJOINT rows (FOR UPDATE SKIP LOCKED)", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 4; i++) ids.add(await extraRequestedRefund());

    const other = new Client({ connectionString: CONNECTION });
    await other.connect();
    try {
      await db.query("begin");
      const a = await db.query<{ refund_id: string }>(`select refund_id from claim_refunds_for_reconcile(2, 0)`);
      // While A holds its transaction (rows locked), B claims — must skip A's locked rows.
      const b = await other.query<{ refund_id: string }>(`select refund_id from claim_refunds_for_reconcile(10, 0)`);
      await db.query("commit");

      const setA = a.rows.map((r) => r.refund_id);
      const setB = b.rows.map((r) => r.refund_id);
      assert.equal(setA.length, 2, "A claims its bounded 2");
      assert.equal(setA.filter((x) => setB.includes(x)).length, 0, "no row claimed by both");
    } finally {
      await other.query(`reset role`).catch(() => {});
      await other.end();
    }
  });

  it("never claims a provider-confirmed 'failed' refund (terminal, needs a human)", async () => {
    const { refundId } = await refundableCancel();
    const rfnd = uid("rfnd");
    await db.query(`select attach_refund_provider($1,$2)`, [refundId, rfnd]);
    await db.query(`select apply_razorpay_refund_result($1,'failed',$2,$3::jsonb)`,
      [rfnd, uid("evt"), JSON.stringify({ payload: { refund: { entity: { id: rfnd, error: "x" } } } })]);
    assert.equal((await refundRow(refundId)).status, "failed");
    const { rows } = await db.query<{ n: string }>(
      `select count(*) n from claim_refunds_for_reconcile(50, 0) c where c.refund_id=$1`, [refundId]);
    assert.equal(Number(rows[0].n), 0, "a failed refund is not auto-reconciled");
  });
});

// ---------------------------------------------------------------------------
describe("money invariant", () => {
  it("attach alone (an API-200 accept) posts NO negative; only 'processed' does", async () => {
    const { resId, refundId, refundPaise } = await refundableCancel();
    const rfnd = uid("rfnd");
    await db.query(`select attach_refund_provider($1,$2)`, [refundId, rfnd]);
    assert.equal(await negativePayments(resId), 0, "acceptance is not confirmation");
    // 'failed' also posts nothing.
    // (fresh refund for the failed case)
    const f = await refundableCancel();
    const frf = uid("rfnd");
    await db.query(`select attach_refund_provider($1,$2)`, [f.refundId, frf]);
    await db.query(`select apply_razorpay_refund_result($1,'failed',$2,$3::jsonb)`,
      [frf, uid("evt"), JSON.stringify({ payload: { refund: { entity: { id: frf, error: "x" } } } })]);
    assert.equal(await negativePayments(f.resId), 0, "failed posts no negative");
    // Only processed does.
    await db.query(`select apply_razorpay_refund_result($1,'processed',$2,$3::jsonb)`,
      [rfnd, uid("evt"), processedPayload(rfnd, refundId, refundPaise)]);
    assert.equal(await negativePayments(resId), 1, "processed posts exactly one negative");
  });
});
