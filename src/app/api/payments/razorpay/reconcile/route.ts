import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { initiateRefund, listPaymentRefunds } from "@/lib/payments/razorpay";

/**
 * POST /api/payments/razorpay/reconcile — refund recovery (Phase 9, Step 5B).
 *
 * A server-only sweep that resolves refunds stranded by a failed or lost
 * initiateRefund() call. NOT for guests or normal authenticated users: it is gated
 * by a dedicated shared secret (REFUND_RECONCILE_SECRET), meant to be driven by a
 * cron/scheduler exactly like /api/channel/sync. Fails closed if the secret is unset.
 *
 * For each leased open refund (bounded batch; FOR UPDATE SKIP LOCKED so concurrent
 * runs take disjoint work):
 *   - ask Razorpay what refunds exist for the payment, matched to OUR refunds.id via
 *     the receipt / notes.refund_id we always send;
 *   - if ours exists → attach its provider id and, only on a provider-confirmed
 *     'processed'/'failed', drive the existing refund lifecycle (one negative payment,
 *     guarded by the same UNIQUE constraints);
 *   - if ours does NOT exist and the row is genuinely still 'requested' with no
 *     provider id → submit exactly one refund, carrying the same correlation;
 *   - anything ambiguous is left for the next pass — never a blind second refund.
 *
 * Money invariant preserved: the negative payment is created only from a
 * provider-confirmed 'processed' state, never from an API 200.
 */
export const dynamic = "force-dynamic";

const MAX_BATCH = 20;
const MIN_AGE_SECONDS = 120;
const RATE_LIMIT = 30;
const RATE_WINDOW_SECONDS = 60;

type ClaimedRefund = {
  refund_id: string;
  reservation_id: string;
  amount_paise: number;
  status: string;
  provider_refund_id: string | null;
  provider_payment_id: string | null;
};

function authorized(request: Request): boolean {
  const secret = process.env.REFUND_RECONCILE_SECRET ?? "";
  const provided = request.headers.get("x-reconcile-secret") ?? "";
  if (!secret || !provided) return false; // fail closed
  const a = Buffer.from(secret, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const json = (payload: unknown, status = 200) =>
  Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request) {
  if (!authorized(request)) return json({ ok: false }, 401);

  const db = createAdminClient();

  const { data: allowed } = await db.rpc("check_rate_limit", {
    p_bucket: "refund-reconcile",
    p_limit: RATE_LIMIT,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (allowed === false) return json({ ok: false, error: "rate_limited" }, 429);

  const { data: claimedData, error: claimError } = await db.rpc("claim_refunds_for_reconcile", {
    p_limit: MAX_BATCH,
    p_min_age_seconds: MIN_AGE_SECONDS,
  });
  if (claimError) return json({ ok: false }, 500);
  const claimed = (claimedData ?? []) as ClaimedRefund[];

  let processed = 0;
  let submitted = 0;
  let attached = 0;
  let skipped = 0;

  for (const r of claimed) {
    if (!r.provider_payment_id) {
      skipped += 1;
      continue;
    }

    const list = await listPaymentRefunds(r.provider_payment_id);
    if (!list.ok) {
      // Provider unreachable — leave everything untouched for the next pass.
      skipped += 1;
      continue;
    }

    // Find OUR refund at the provider: receipt / notes.refund_id carry refunds.id,
    // and an already-attached provider id is matched directly.
    const mine = list.refunds.find(
      (x) =>
        x.receipt === r.refund_id ||
        x.notes?.refund_id === r.refund_id ||
        (r.provider_refund_id != null && x.id === r.provider_refund_id),
    );

    if (mine) {
      if (!r.provider_refund_id) {
        await db.rpc("attach_refund_provider", {
          p_refund_id: r.refund_id,
          p_provider_refund_id: mine.id,
        });
        attached += 1;
      }
      // Only a provider-CONFIRMED terminal state drives the ledger. 'pending' waits.
      if (mine.status === "processed" || mine.status === "failed") {
        await db.rpc("apply_razorpay_refund_result", {
          p_provider_refund_id: mine.id,
          p_result: mine.status,
          // Deterministic id keeps a re-sweep idempotent; a later real webhook is
          // deduped by refund status + payments.reference UNIQUE regardless.
          p_event_id: `reconcile:${mine.id}:${mine.status}`,
          p_payload: { source: "reconcile", payload: { refund: { entity: mine } } },
        });
        processed += 1;
      }
      continue;
    }

    // Not at the provider. Only resubmit when the row is genuinely un-sent.
    if (r.status === "requested" && !r.provider_refund_id) {
      await db.rpc("record_refund_reconcile_attempt", { p_refund_id: r.refund_id });
      const sub = await initiateRefund(r.provider_payment_id, r.amount_paise, {
        receipt: r.refund_id,
        notes: { refund_id: r.refund_id },
      });
      if (sub.ok) {
        await db.rpc("attach_refund_provider", {
          p_refund_id: r.refund_id,
          p_provider_refund_id: sub.refundId,
        });
        submitted += 1;
      } else {
        // DUPLICATE_RECEIPT (a race created it) or a transient failure — the next
        // pass will discover/attach it. Never a blind second refund.
        skipped += 1;
      }
    } else {
      // 'processing' but the provider list doesn't show it yet (eventual
      // consistency), or otherwise ambiguous — do not guess.
      skipped += 1;
    }
  }

  return json({ ok: true, claimed: claimed.length, processed, submitted, attached, skipped });
}
