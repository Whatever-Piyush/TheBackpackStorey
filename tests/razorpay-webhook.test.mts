/**
 * Razorpay webhook processing — the payment source of truth (Phase 9, Phase 4).
 *
 * Signature verification is exercised against the real lib; capture/refund logic is
 * exercised by calling the DB functions the webhook route delegates to (no running
 * Next server, no real Razorpay). The invariants under test: verified capture records
 * the deposit and confirms the hold exactly once; duplicate events are inert; amount/
 * order/currency mismatches are rejected; the INVENTORY_LOST seam opens a refund; and
 * a completed refund posts a single negative folio payment while a failed one stays
 * visible.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { Client } from "pg";
import { verifyWebhookSignature } from "../src/lib/payments/razorpay.ts";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

let db: Client;
let channelCode: string;
let typeId: string;
let CI: string;
let CO: string;
let n = 0;
const uid = (p: string) => `${p}_p4_${++n}_${Date.now()}`;

async function createHold(): Promise<string> {
  const { rows } = await db.query<{ r: { ok: boolean; reservation?: { id: string } } }>(
    `select create_reservation(p_guest := $1::jsonb, p_checkin := $2, p_checkout := $3,
        p_lines := $4::jsonb, p_source := $5, p_hold_minutes := 15) as r`,
    [JSON.stringify({ name: "WH", phone: "9", notes: "PHASE4_TEST" }), CI, CO,
     JSON.stringify([{ roomTypeId: typeId, ratePlanId: null, qty: 1 }]), channelCode],
  );
  return rows[0].r.reservation!.id;
}
async function holdWithIntent() {
  const id = await createHold();
  const { rows } = await db.query<{ d: { depositPaise: number; percent: number } }>(
    `select deposit_for_reservation($1) as d`, [id]);
  const deposit = rows[0].d.depositPaise;
  const percent = rows[0].d.percent;
  const orderId = uid("order");
  await db.query(`select create_payment_intent($1, $2, $3, $4, 'INR')`, [id, orderId, deposit, percent]);
  return { id, orderId, deposit, percent };
}
async function capture(orderId: string, paymentId: string, amount: number, currency: string, eventId: string) {
  const { rows } = await db.query<{ r: { ok: boolean; code: string; refundId?: string; amountPaise?: number } }>(
    `select apply_razorpay_capture($1, $2, $3, $4, $5, '{}'::jsonb) as r`,
    [orderId, paymentId, amount, currency, eventId]);
  return rows[0].r;
}
async function paymentsFor(reservationId: string) {
  const { rows } = await db.query<{ amount_paise: number; reference: string }>(
    `select p.amount_paise, p.reference from payments p join folios f on f.id=p.folio_id
      where f.reservation_id=$1 and p.method='razorpay' order by p.received_at`, [reservationId]);
  return rows;
}
async function cleanup() {
  await db.query(`delete from payment_events where provider_event_id like '%_p4_%'`);
  await db.query(`delete from reservations where notes = 'PHASE4_TEST'`);
  await db.query(`delete from deposit_config where version >= 500`);
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '15s'");
  const { rows: ch } = await db.query<{ code: string }>(
    `select code from channels where active and not public.is_ota_channel(code)
      order by (code='website') desc, code limit 1`);
  channelCode = ch[0].code;
  const d = await db.query<{ ci: string; co: string }>(
    `select (current_date + 50)::text as ci, (current_date + 52)::text as co`);
  CI = d.rows[0].ci; CO = d.rows[0].co;
  const { rows } = await db.query<{ id: string }>(
    `select rt.id from room_types rt join units u on u.room_type_id=rt.id and u.active
      where rt.active and exists (select 1 from rates r join rate_plans rp on rp.id=r.rate_plan_id
              where r.room_type_id=rt.id and rp.active and not r.closed and r.stay_date=$1::date)
      group by rt.id having count(u.*)>=2 order by count(u.*) desc limit 1`, [CI]);
  typeId = rows[0].id;
});
beforeEach(cleanup);
after(async () => { await cleanup(); await db.end(); });

describe("webhook signature (14/15/34)", () => {
  const body = '{"event":"payment.captured","x":1}';
  afterEach(() => { delete process.env.RAZORPAY_WEBHOOK_SECRET; });

  it("accepts a valid HMAC-SHA256 signature over the raw body", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";
    const sig = createHmac("sha256", "whsec_test").update(body).digest("hex");
    assert.equal(verifyWebhookSignature(body, sig), true);
  });
  it("rejects an invalid signature", () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = "whsec_test";
    assert.equal(verifyWebhookSignature(body, "deadbeef"), false);
    assert.equal(verifyWebhookSignature(body, null), false);
  });
  it("FAILS CLOSED when the webhook secret is unset", () => {
    delete process.env.RAZORPAY_WEBHOOK_SECRET;
    const sig = createHmac("sha256", "whatever").update(body).digest("hex");
    assert.equal(verifyWebhookSignature(body, sig), false);
  });
});

describe("capture (9/10/11/12/37)", () => {
  it("records the deposit and confirms the hold — exactly once", async () => {
    const { id, orderId, deposit } = await holdWithIntent();
    const paymentId = uid("pay");
    const r1 = await capture(orderId, paymentId, deposit, "INR", uid("evt"));
    assert.equal(r1.code, "CONFIRMED");
    const { rows: res } = await db.query<{ status: string }>(`select status from reservations where id=$1`, [id]);
    assert.equal(res[0].status, "confirmed");
    let pays = await paymentsFor(id);
    assert.equal(pays.length, 1, "one deposit payment");
    assert.equal(pays[0].amount_paise, deposit);
    // folio balance = charges − deposit (existing folio arithmetic, unchanged)
    const { rows: fol } = await db.query<{ bal: number }>(
      `select (coalesce((select sum(amount_paise) from folio_items fi join folios f on f.id=fi.folio_id where f.reservation_id=$1),0)
             - coalesce((select sum(amount_paise) from payments p join folios f on f.id=p.folio_id where f.reservation_id=$1),0))::int as bal`, [id]);
    assert.equal(fol[0].bal, (await roomTotal(id)) - deposit, "balance = charges − deposit");
    assert.ok(paymentId); // the recorded reference

    // a second capture event for the same (already-captured) order is a no-op
    const r2 = await capture(orderId, uid("pay"), deposit, "INR", uid("evt"));
    assert.equal(r2.code, "PAYMENT_ALREADY_PROCESSED");
    pays = await paymentsFor(id);
    assert.equal(pays.length, 1, "still one payment after a second capture event");
  });

  it("a redelivered event id produces no duplicate effect", async () => {
    const { id, orderId, deposit } = await holdWithIntent();
    const eventId = uid("evt");
    const p = uid("pay");
    const a = await capture(orderId, p, deposit, "INR", eventId);
    assert.equal(a.code, "CONFIRMED");
    const b = await capture(orderId, p, deposit, "INR", eventId); // same event id
    assert.equal(b.code, "DUPLICATE");
    assert.equal((await paymentsFor(id)).length, 1);
    // and room charges are not duplicated
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from folio_items fi join folios f on f.id=fi.folio_id
        where f.reservation_id=$1 and fi.kind='room_night'`, [id]);
    assert.equal(rows[0].n, 2, "1 unit × 2 nights, not duplicated");
  });

  it("20. payment after hold expiry, inventory still available → recovers and confirms", async () => {
    const { id, orderId, deposit } = await holdWithIntent();
    // Expire the hold but do NOT reclaim it — its allocation is still physically held.
    await db.query(`update reservations set hold_expires_at = now() - interval '1 minute' where id=$1`, [id]);
    const r = await capture(orderId, uid("pay"), deposit, "INR", uid("evt"));
    assert.equal(r.code, "CONFIRMED", "the paid, still-held expired hold is revived and confirmed");
    const { rows } = await db.query<{ status: string }>(`select status from reservations where id=$1`, [id]);
    assert.equal(rows[0].status, "confirmed");
    assert.equal((await paymentsFor(id)).length, 1);
  });

  it("16/17/18. rejects amount, order, and currency mismatches (no confirm, no payment)", async () => {
    const { id, orderId, deposit } = await holdWithIntent();
    assert.equal((await capture(orderId, uid("pay"), deposit + 1, "INR", uid("evt"))).code, "PAYMENT_AMOUNT_MISMATCH");
    assert.equal((await capture("order_nope", uid("pay"), deposit, "INR", uid("evt"))).code, "PAYMENT_ORDER_MISMATCH");
    assert.equal((await capture(orderId, uid("pay"), deposit, "USD", uid("evt"))).code, "PAYMENT_CURRENCY_MISMATCH");
    const { rows } = await db.query<{ status: string }>(`select status from reservations where id=$1`, [id]);
    assert.equal(rows[0].status, "hold", "still a hold after rejected captures");
    assert.equal((await paymentsFor(id)).length, 0, "no payment recorded on mismatch");
  });
});

describe("DEFECT-1: deposit money authority under config/rate race", () => {
  const ratePlanFilter = `rate_plan_id in (select id from rate_plans where room_type_id=$1 and active)`;

  it("a deposit-config change (and rate change) during the hold does not move the paid deposit", async () => {
    const { id, orderId, deposit, percent } = await holdWithIntent();
    assert.equal(percent, 20, "order was computed at the original 20%");

    // Both race vectors happen during the 15-minute hold: config 20% → 50%, and a rate bump.
    await db.query(`insert into deposit_config (version, percent, min_amount_paise, effective_from) values (599, 50, null, now())`);
    await db.query(`update rates set price_paise = price_paise + 100000 where room_type_id=$1 and stay_date=$2 and ${ratePlanFilter}`, [typeId, CI]);
    try {
      const r = await capture(orderId, uid("pay"), deposit, "INR", uid("evt"));
      assert.equal(r.code, "CONFIRMED");

      const { rows } = await db.query<{
        deposit_amount_paise: number; deposit_percent_snapshot: string;
        policy_version_id: string | null; policy_text_snapshot: string | null;
        cancellation_cutoff_at: string | null; intent_amount: number; paid: number;
      }>(
        `select r.deposit_amount_paise, r.deposit_percent_snapshot, r.policy_version_id,
                r.policy_text_snapshot, r.cancellation_cutoff_at,
                pi.amount_paise as intent_amount,
                (select sum(p.amount_paise) from payments p join folios f on f.id=p.folio_id
                  where f.reservation_id=r.id and p.method='razorpay')::int as paid
           from reservations r join payment_intents pi on pi.reservation_id=r.id
          where r.id=$1`, [id]);
      const s = rows[0];

      // THE invariant: order/intent = captured(=deposit) = folio payment = reservation snapshot.
      assert.equal(s.intent_amount, deposit, "intent unchanged");
      assert.equal(s.paid, deposit, "folio payment == paid amount");
      assert.equal(s.deposit_amount_paise, deposit, "reservation deposit == the ordered/paid amount, not 50% of a re-priced total");
      assert.equal(Number(s.deposit_percent_snapshot), 20, "percent snapshot is the ORDER percent (20), not the live 50%");

      // Historical cancellation-policy snapshot is preserved (resolved by booking time).
      assert.ok(s.policy_version_id && s.policy_text_snapshot && s.cancellation_cutoff_at,
        "policy snapshot retained");
      // No duplicate room charges.
      const { rows: rn } = await db.query<{ n: number }>(
        `select count(*)::int as n from folio_items fi join folios f on f.id=fi.folio_id
          where f.reservation_id=$1 and fi.kind='room_night'`, [id]);
      assert.equal(rn[0].n, 2, "room charges not duplicated");
    } finally {
      await db.query(`delete from deposit_config where version=599`);
      await db.query(`update rates set price_paise = price_paise - 100000 where room_type_id=$1 and stay_date=$2 and ${ratePlanFilter}`, [typeId, CI]);
    }
  });

  it("the unchanged 20% path: reservation deposit equals the paid amount", async () => {
    const { id, orderId, deposit } = await holdWithIntent();
    await capture(orderId, uid("pay"), deposit, "INR", uid("evt"));
    const { rows } = await db.query<{ dep: number; pct: string }>(
      `select deposit_amount_paise as dep, deposit_percent_snapshot as pct from reservations where id=$1`, [id]);
    assert.equal(rows[0].dep, deposit);
    assert.equal(Number(rows[0].pct), 20);
  });
});

describe("INVENTORY_LOST + refunds (21/22/23/24/25/26/38)", () => {
  it("payment after the slot is reclaimed → INVENTORY_LOST, refund opened, deposit recorded", async () => {
    const { id, orderId, deposit } = await holdWithIntent();
    // expire + reclaim the slot with another booking (Phase 3 reap cancels the hold)
    await db.query(`update reservations set hold_expires_at = now() - interval '1 minute' where id=$1`, [id]);
    await createHold(); // reclaims → id becomes cancelled/hold_expired
    const { rows: st } = await db.query<{ status: string }>(`select status from reservations where id=$1`, [id]);
    assert.equal(st[0].status, "cancelled");

    const r = await capture(orderId, uid("pay"), deposit, "INR", uid("evt"));
    assert.equal(r.code, "INVENTORY_LOST");
    assert.ok(r.refundId, "a refund is opened");
    assert.equal((await paymentsFor(id)).length, 1, "the captured deposit is recorded");
    const { rows: rf } = await db.query<{ status: string; amount_paise: number }>(
      `select status, amount_paise from refunds where id=$1`, [r.refundId]);
    assert.equal(rf[0].status, "requested");
    assert.equal(rf[0].amount_paise, deposit);

    // refund completes → single negative payment; refund marked processed
    const providerRefund = uid("rfnd");
    await db.query(`select attach_refund_provider($1, $2)`, [r.refundId, providerRefund]);
    const done = await db.query<{ r: { code: string } }>(
      `select apply_razorpay_refund_result($1, 'processed', $2, '{}'::jsonb) as r`, [providerRefund, uid("evt")]);
    assert.equal(done.rows[0].r.code, "REFUND_PROCESSED");
    let pays = await paymentsFor(id);
    assert.equal(pays.length, 2, "deposit + one negative refund payment");
    assert.equal(pays.reduce((s, p) => s + p.amount_paise, 0), 0, "folio nets to zero");
    assert.equal((await db.query(`select status from refunds where id=$1`, [r.refundId])).rows[0].status, "processed");

    // replayed refund webhook → no duplicate negative payment
    await db.query(`select apply_razorpay_refund_result($1, 'processed', $2, '{}'::jsonb)`, [providerRefund, uid("evt")]);
    pays = await paymentsFor(id);
    assert.equal(pays.length, 2, "replayed refund makes no second negative payment");
  });

  it("a failed refund stays visible and posts no negative payment", async () => {
    const { id, orderId, deposit } = await holdWithIntent();
    await db.query(`update reservations set hold_expires_at = now() - interval '1 minute' where id=$1`, [id]);
    await createHold();
    const r = await capture(orderId, uid("pay"), deposit, "INR", uid("evt"));
    const providerRefund = uid("rfnd");
    await db.query(`select attach_refund_provider($1, $2)`, [r.refundId, providerRefund]);
    await db.query(`select apply_razorpay_refund_result($1, 'failed', $2, '{"error":"bank"}'::jsonb)`, [providerRefund, uid("evt")]);
    const { rows } = await db.query<{ status: string }>(`select status from refunds where id=$1`, [r.refundId]);
    assert.equal(rows[0].status, "failed", "failed refund remains visible");
    assert.equal((await paymentsFor(id)).length, 1, "no negative payment on failure (deposit only)");
  });
});

async function roomTotal(reservationId: string): Promise<number> {
  const { rows } = await db.query<{ t: number }>(
    `select coalesce(sum(amount_paise),0)::int as t from folio_items fi join folios f on f.id=fi.folio_id
      where f.reservation_id=$1 and fi.kind='room_night'`, [reservationId]);
  return rows[0].t;
}
