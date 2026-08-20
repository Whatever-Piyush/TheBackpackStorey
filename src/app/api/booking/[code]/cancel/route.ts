import { createAdminClient } from "@/lib/supabase/admin";
import { initiateRefund } from "@/lib/payments/razorpay";

/**
 * POST /api/booking/[code]/cancel — guest cancellation.
 *
 * Preserves the booking-lookup boundary: the code (URL) + the phone it was booked
 * with must match, exactly as public_booking_lookup. Rate limited. The client never
 * supplies the refund/forfeiture amounts or eligibility — the server computes them
 * from the reservation snapshot (public_cancellation_preview) and the atomic
 * cancel_reservation_with_policy. The Razorpay refund is initiated AFTER the DB
 * transaction commits, using the existing Phase 4 provider infrastructure.
 *
 *   { phone }                 → preview (refundable? amounts, deadline, policy)
 *   { phone, action:'cancel'} → cancel + (if refundable) initiate the refund
 */
export const dynamic = "force-dynamic";

const RATE_LIMIT = 10;
const RATE_WINDOW_SECONDS = 600;

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
function json(payload: unknown, status = 200) {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

type Preview = {
  ok: boolean;
  reservationId?: string;
  cancellable?: boolean;
  refundable?: boolean;
  depositPaise?: number;
  refundPaise?: number;
  forfeitPaise?: number;
  cutoffAt?: string;
  policyText?: string;
  status?: string;
};

export async function POST(request: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  let body: { phone?: string; action?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Malformed request." }, 400);
  }
  const phone = String(body?.phone ?? "");
  const doCancel = body?.action === "cancel";

  const db = createAdminClient();
  const { data: allowed } = await db.rpc("check_rate_limit", {
    p_bucket: `cancel:${clientIp(request)}`,
    p_limit: RATE_LIMIT,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (allowed === false) {
    return json({ ok: false, error: "Too many attempts. Please wait a few minutes, or call us." }, 429);
  }

  // Code + phone gate (identical answer for a wrong code and a wrong phone).
  const { data: pv } = await db.rpc("public_cancellation_preview", { p_code: code, p_phone: phone });
  const preview = pv as Preview | null;
  if (!preview?.ok) {
    return json({ ok: false, error: "We couldn't find a booking with that reference and phone." }, 404);
  }

  // What the browser is allowed to see — never the reservation id.
  const shown = {
    status: preview.status,
    cancellable: preview.cancellable,
    refundable: preview.refundable,
    depositPaise: preview.depositPaise,
    refundPaise: preview.refundPaise,
    forfeitPaise: preview.forfeitPaise,
    cutoffAt: preview.cutoffAt,
    policyText: preview.policyText,
  };

  if (!doCancel) return json({ ok: true, preview: shown });

  if (!preview.cancellable) {
    return json({ ok: false, error: "This booking can no longer be cancelled online.", preview: shown }, 409);
  }

  const { data: c } = await db.rpc("cancel_reservation_with_policy", {
    p_reservation_id: preview.reservationId,
    p_actor_id: null,
    p_actor_label: "Website guest",
    p_reason: "guest",
    p_waive_fee: false,
    p_note: null,
  });
  const result = c as
    | { ok: boolean; refundable: boolean; refundId?: string | null; refundPaise?: number; paymentId?: string | null; forfeitPaise?: number }
    | null;
  if (!result?.ok) {
    return json({ ok: false, error: "We couldn't cancel that just now. Please contact us." }, 500);
  }

  // Provider refund happens OUTSIDE the (already-committed) DB transaction. A failure
  // here leaves the refunds row visible/retryable; it never blocks the cancellation.
  if (result.refundable && result.refundId && result.paymentId && (result.refundPaise ?? 0) > 0) {
    const refund = await initiateRefund(result.paymentId, result.refundPaise!);
    if (refund.ok) {
      await db.rpc("attach_refund_provider", {
        p_refund_id: result.refundId,
        p_provider_refund_id: refund.refundId,
      });
    }
  }

  return json({
    ok: true,
    cancelled: true,
    refundable: result.refundable,
    refundPaise: result.refundPaise ?? 0,
    forfeitPaise: result.forfeitPaise ?? 0,
  });
}
