import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Razorpay — server-only.
 *
 * No SDK: order creation and refunds are plain REST calls, and webhook signatures
 * are HMAC-SHA256 over the RAW body, using Node's crypto. This file must never be
 * imported by client code — it reads RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET,
 * which are server-only. Only razorpayKeyId() (the publishable key) is safe to hand
 * to the browser, and it is returned through the API response, never NEXT_PUBLIC_*.
 */

const API = "https://api.razorpay.com/v1";

const keyId = () => process.env.RAZORPAY_KEY_ID ?? "";
const keySecret = () => process.env.RAZORPAY_KEY_SECRET ?? "";
const webhookSecret = () => process.env.RAZORPAY_WEBHOOK_SECRET ?? "";
const basicAuth = () => `Basic ${Buffer.from(`${keyId()}:${keySecret()}`).toString("base64")}`;

/** The publishable key id. Safe to send to the browser. */
export function razorpayKeyId(): string {
  return keyId();
}

/**
 * Verify a Razorpay webhook signature against the RAW request body.
 * FAILS CLOSED: returns false when the webhook secret is unset — an unconfigured
 * deployment rejects everything rather than accepting anything.
 */
export function verifyWebhookSignature(rawBody: string, signature: string | null | undefined): boolean {
  const secret = webhookSecret();
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type OrderResult =
  | { ok: true; orderId: string; amount: number; currency: string }
  | { ok: false; code: "PAYMENT_CREATION_FAILED" };

/** Create a Razorpay order for exactly `amountPaise` (server-controlled). */
export async function createOrder(
  amountPaise: number,
  currency: string,
  receipt: string,
): Promise<OrderResult> {
  if (!keyId() || !keySecret()) return { ok: false, code: "PAYMENT_CREATION_FAILED" };
  try {
    const res = await fetch(`${API}/orders`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth() },
      body: JSON.stringify({ amount: amountPaise, currency, receipt, payment_capture: 1 }),
    });
    if (!res.ok) return { ok: false, code: "PAYMENT_CREATION_FAILED" };
    const data = (await res.json()) as { id: string; amount: number; currency: string };
    if (!data?.id) return { ok: false, code: "PAYMENT_CREATION_FAILED" };
    return { ok: true, orderId: data.id, amount: data.amount, currency: data.currency };
  } catch {
    return { ok: false, code: "PAYMENT_CREATION_FAILED" };
  }
}

export type RefundResult =
  | { ok: true; refundId: string; status: string }
  // DUPLICATE_RECEIPT: Razorpay rejected the receipt because a refund with this
  // receipt already exists for this payment — the request was NOT a new refund, so
  // the caller must reconcile (fetch + attach), never treat it as a plain failure.
  | { ok: false; code: "REFUND_FAILED" | "DUPLICATE_RECEIPT" };

/** Correlation carried to Razorpay so a lost response is always recoverable. */
export type RefundCorrelation = {
  /** Razorpay `receipt` — its per-payment idempotency key (reuse ⇒ 400 duplicate). */
  receipt?: string;
  /** Razorpay `notes` — echoed back on the entity + webhook; used for self-heal. */
  notes?: Record<string, string>;
};

/**
 * Ask Razorpay to refund `amountPaise` of a captured payment. A 200 here means the
 * refund was ACCEPTED, not completed — completion arrives later as a refund webhook
 * (or is discovered by reconciliation), which is the only thing that posts the
 * negative folio payment.
 *
 * `receipt` is Razorpay's per-payment idempotency key: reusing it for the same
 * payment returns HTTP 400 "Duplicate receipt found for this refund request", which
 * we surface as DUPLICATE_RECEIPT so a retry can never create a second refund.
 */
export async function initiateRefund(
  paymentId: string,
  amountPaise: number,
  correlation: RefundCorrelation = {},
): Promise<RefundResult> {
  if (!keyId() || !keySecret()) return { ok: false, code: "REFUND_FAILED" };
  try {
    const body: Record<string, unknown> = { amount: amountPaise, speed: "normal" };
    if (correlation.receipt) body.receipt = correlation.receipt;
    if (correlation.notes) body.notes = correlation.notes;
    const res = await fetch(`${API}/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth() },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      // A duplicate-receipt 400 means Razorpay already has our refund — signal the
      // caller to reconcile rather than resubmit.
      const err = (await res.json().catch(() => null)) as
        | { error?: { description?: string } }
        | null;
      if (res.status === 400 && /receipt/i.test(err?.error?.description ?? "")) {
        return { ok: false, code: "DUPLICATE_RECEIPT" };
      }
      return { ok: false, code: "REFUND_FAILED" };
    }
    const data = (await res.json()) as { id: string; status: string };
    if (!data?.id) return { ok: false, code: "REFUND_FAILED" };
    return { ok: true, refundId: data.id, status: data.status };
  } catch {
    return { ok: false, code: "REFUND_FAILED" };
  }
}

export type ProviderRefund = {
  id: string;
  status: string; // 'pending' | 'processed' | 'failed'
  amount: number;
  receipt: string | null;
  notes: Record<string, string> | null;
};
export type ListRefundsResult =
  | { ok: true; refunds: ProviderRefund[] }
  | { ok: false; code: "LOOKUP_FAILED" };

/**
 * Fetch the refunds Razorpay holds for a payment (last 100). Reconciliation uses
 * this to discover whether OUR refund already exists — matched on `receipt` /
 * `notes.refund_id` (= our refunds.id) — so it can attach and settle it without ever
 * submitting a second refund. Read-only; never moves money.
 */
export async function listPaymentRefunds(paymentId: string): Promise<ListRefundsResult> {
  if (!keyId() || !keySecret()) return { ok: false, code: "LOOKUP_FAILED" };
  try {
    const res = await fetch(
      `${API}/payments/${encodeURIComponent(paymentId)}/refunds?count=100`,
      { headers: { Authorization: basicAuth() } },
    );
    if (!res.ok) return { ok: false, code: "LOOKUP_FAILED" };
    const data = (await res.json()) as { items?: ProviderRefund[] };
    return { ok: true, refunds: Array.isArray(data?.items) ? data.items : [] };
  } catch {
    return { ok: false, code: "LOOKUP_FAILED" };
  }
}
