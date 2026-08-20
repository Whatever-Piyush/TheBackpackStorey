import { createAdminClient } from "@/lib/supabase/admin";
import { verifyWebhookSignature, initiateRefund } from "@/lib/payments/razorpay";

/**
 * Razorpay webhook — the payment SOURCE OF TRUTH.
 *
 * The browser Checkout callback is UX only and never reaches this route. Everything
 * here fails closed: an unset webhook secret or a bad signature is rejected before
 * the body is parsed. Reuses the hardened shape of the channel webhook — size cap,
 * the DB rate limiter, raw-body-first, verify-before-parse — and the DB UNIQUE on
 * (provider, event id) inside apply_* is the final dedupe boundary, so a redelivered
 * event produces no duplicate effect.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 64 * 1024;
const RATE_LIMIT = 240;
const RATE_WINDOW_SECONDS = 60;

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

const ack = () => Response.json({ ok: true }, { status: 200 });

export async function POST(request: Request) {
  // ---- size cap (before and after reading) --------------------------------
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json({ ok: false }, { status: 413 });
  }
  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return Response.json({ ok: false }, { status: 413 });
  }

  const db = createAdminClient();

  // ---- rate limit ---------------------------------------------------------
  const { data: allowed } = await db.rpc("check_rate_limit", {
    p_bucket: `razorpay-webhook:${clientIp(request)}`,
    p_limit: RATE_LIMIT,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (allowed === false) return Response.json({ ok: false }, { status: 429 });

  // ---- verify signature over the RAW body, BEFORE parsing (fail closed) ----
  if (!verifyWebhookSignature(rawBody, request.headers.get("x-razorpay-signature"))) {
    return Response.json({ ok: false, error: "Bad signature." }, { status: 401 });
  }

  const eventId = request.headers.get("x-razorpay-event-id");
  if (!eventId) return Response.json({ ok: false }, { status: 400 });

  let payload: {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; amount?: number; currency?: string } };
      refund?: { entity?: { id?: string; amount?: number } };
    };
  };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ ok: false }, { status: 400 });
  }

  try {
    if (payload.event === "payment.captured") {
      const p = payload.payload?.payment?.entity;
      if (!p?.order_id || !p?.id) return Response.json({ ok: false }, { status: 400 });
      const { data } = await db.rpc("apply_razorpay_capture", {
        p_order_id: p.order_id,
        p_payment_id: p.id,
        p_amount_paise: p.amount,
        p_currency: p.currency,
        p_event_id: eventId,
        p_payload: payload,
      });
      const result = data as { code?: string; refundId?: string; amountPaise?: number } | null;
      // INVENTORY_LOST: the refund row is already open; ask Razorpay to refund, then
      // record the provider refund id. Best-effort — a failure leaves the row visible.
      if (result?.code === "INVENTORY_LOST" && result.refundId) {
        const refund = await initiateRefund(p.id, result.amountPaise ?? p.amount ?? 0);
        if (refund.ok) {
          await db.rpc("attach_refund_provider", {
            p_refund_id: result.refundId,
            p_provider_refund_id: refund.refundId,
          });
        }
      }
      return ack();
    }

    if (payload.event === "refund.processed" || payload.event === "refund.failed") {
      const r = payload.payload?.refund?.entity;
      if (!r?.id) return Response.json({ ok: false }, { status: 400 });
      await db.rpc("apply_razorpay_refund_result", {
        p_provider_refund_id: r.id,
        p_result: payload.event === "refund.processed" ? "processed" : "failed",
        p_event_id: eventId,
        p_payload: payload,
      });
      return ack();
    }

    // Any other event type: acknowledge so Razorpay stops retrying; we take no action.
    return ack();
  } catch {
    // Never leak internal details; a 500 lets Razorpay retry, and the event dedupe
    // makes the retry safe.
    return Response.json({ ok: false }, { status: 500 });
  }
}
