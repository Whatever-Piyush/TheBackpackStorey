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
  | { ok: false; code: "REFUND_FAILED" };

/**
 * Ask Razorpay to refund `amountPaise` of a captured payment. A 200 here means the
 * refund was ACCEPTED, not completed — completion arrives later as a refund webhook,
 * which is the only thing that posts the negative folio payment.
 */
export async function initiateRefund(paymentId: string, amountPaise: number): Promise<RefundResult> {
  if (!keyId() || !keySecret()) return { ok: false, code: "REFUND_FAILED" };
  try {
    const res = await fetch(`${API}/payments/${encodeURIComponent(paymentId)}/refund`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basicAuth() },
      body: JSON.stringify({ amount: amountPaise, speed: "normal" }),
    });
    if (!res.ok) return { ok: false, code: "REFUND_FAILED" };
    const data = (await res.json()) as { id: string; status: string };
    if (!data?.id) return { ok: false, code: "REFUND_FAILED" };
    return { ok: true, refundId: data.id, status: data.status };
  } catch {
    return { ok: false, code: "REFUND_FAILED" };
  }
}
