import { createHash } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { nights, today } from "@/lib/dates";
import { createOrder, razorpayKeyId } from "@/lib/payments/razorpay";

/**
 * POST /api/book — the public booking endpoint (Phase 9).
 *
 * Runs on the SERVICE ROLE and is never called with the anon key from a browser:
 * `reservations` and `allocations` are deny-by-default, so the browser could not
 * write them even if it tried.
 *
 * A website booking creates a 15-minute HOLD (no folio, no room charges, no payment),
 * computes the 20% deposit SERVER-SIDE, creates a Razorpay order for exactly that
 * amount, and returns the Checkout parameters. It never confirms the reservation:
 * confirmation happens only through the verified Razorpay webhook → confirm_hold().
 *
 * Protections, in order:
 *   1. rate limit by IP        — a booking form is a free write endpoint
 *   2. Zod validation          — nothing reaches the database unshaped
 *   3. idempotency key         — a double-click or a retry must not book (or order) twice
 */

export const dynamic = "force-dynamic";

const HOLD_MINUTES = 15;

const BookRequest = z.object({
  idempotencyKey: z.string().uuid(),
  roomTypeCode: z.string().min(1).max(64),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  units: z.number().int().min(1).max(10),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(6).max(24),
  email: z.string().trim().email().max(160).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  // The guest must accept the cancellation policy shown at checkout before paying.
  acceptedPolicy: z.literal(true),
});

type BookRequest = z.infer<typeof BookRequest>;

const RATE_LIMIT = 8;
const RATE_WINDOW_SECONDS = 600;

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/** Everything that defines "the same booking", so a key can't be reused. */
function fingerprint(body: BookRequest): string {
  return createHash("sha256")
    .update(
      [
        body.roomTypeCode,
        body.checkIn,
        body.checkOut,
        body.units,
        body.name.toLowerCase(),
        body.phone.replace(/\D/g, ""),
      ].join("|"),
    )
    .digest("hex");
}

function json(payload: unknown, status = 200) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json({ ok: false, error: "Malformed request." }, 400);
  }

  const parsed = BookRequest.safeParse(raw);
  if (!parsed.success) {
    return json(
      {
        ok: false,
        error: "Please check the details and try again.",
        // Field names only — never echo the submitted values back.
        fields: parsed.error.issues.map((i) => i.path.join(".")),
      },
      400,
    );
  }
  const body = parsed.data;

  if (body.checkIn < today()) {
    return json({ ok: false, error: "Check-in can't be in the past." }, 400);
  }
  const nightCount = nights(body.checkIn, body.checkOut);
  if (nightCount < 1) {
    return json({ ok: false, error: "Check-out must be after check-in." }, 400);
  }
  if (nightCount > 60) {
    return json({ ok: false, error: "Please call us for stays over 60 nights." }, 400);
  }

  const db = createAdminClient();

  // ---- 1. rate limit -------------------------------------------------------
  const { data: allowed } = await db.rpc("check_rate_limit", {
    p_bucket: `book:${clientIp(request)}`,
    p_limit: RATE_LIMIT,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (allowed === false) {
    return json(
      { ok: false, error: "Too many attempts. Please wait a few minutes, or call us." },
      429,
    );
  }

  // ---- 2. idempotency ------------------------------------------------------
  const print = fingerprint(body);
  const { data: claim } = await db.rpc("claim_idempotency_key", {
    p_key: body.idempotencyKey,
    p_fingerprint: print,
  });
  const claimed = claim as {
    claimed: boolean;
    code?: string;
    status?: string;
    response?: unknown;
  } | null;

  if (!claimed?.claimed) {
    if (claimed?.code === "FINGERPRINT") {
      return json(
        { ok: false, error: "Those details changed — please refresh and book again." },
        409,
      );
    }
    if (claimed?.status === "done") {
      // A replay: hand back exactly what the first attempt returned.
      return json(claimed.response);
    }
    return json(
      { ok: false, error: "That booking is already going through. Give it a moment." },
      409,
    );
  }

  // From here the key is ours; release it on any path that doesn't produce a
  // booking, so the guest can genuinely retry.
  const release = async () => {
    await db.rpc("release_idempotency_key", { p_key: body.idempotencyKey });
  };

  try {
    const { data: type } = await db
      .from("room_types")
      .select("id, name, sell_mode")
      .eq("code", body.roomTypeCode)
      .eq("active", true)
      .maybeSingle();

    if (!type) {
      await release();
      return json({ ok: false, error: "That room isn't available to book." }, 400);
    }

    // ---- 3. the booking ----------------------------------------------------
    const { data, error } = await db.rpc("create_reservation", {
      p_guest: {
        name: body.name,
        phone: body.phone,
        email: body.email || null,
        notes: body.notes || null,
      },
      p_checkin: body.checkIn,
      p_checkout: body.checkOut,
      p_lines: [{ roomTypeId: type.id, ratePlanId: null, qty: body.units }],
      p_source: "website",
      p_unit_ids: null,
      p_actor_id: null,
      p_actor_label: "Website",
      // Website booking is a 15-minute HOLD: reserves inventory, no folio/charge/payment.
      p_hold_minutes: HOLD_MINUTES,
    });

    if (error) {
      await release();
      return json({ ok: false, error: "We couldn't complete that booking." }, 500);
    }

    const result = data as {
      ok: boolean;
      code?: string;
      available?: number;
      reservation?: { id: string; code: string; status: string; holdExpiresAt: string | null };
    };

    if (!result?.ok) {
      await release();

      // "You just missed it" — hand back what IS still free for those dates so
      // the guest can pick again without starting over.
      if (result?.code === "UNITS_TAKEN" || result?.code === "NO_ALLOTMENT") {
        const { data: fresh } = await db.rpc("public_availability", {
          p_room_type: type.id,
          p_from: body.checkIn,
          p_to: body.checkOut,
        });
        return json(
          {
            ok: false,
            code: "UNITS_TAKEN",
            error: "Someone just booked that — here's what's still free for your dates.",
            availability: fresh,
          },
          409,
        );
      }
      return json({ ok: false, error: "We couldn't complete that booking." }, 409);
    }

    const reservationId = result.reservation!.id;
    const ref = result.reservation!.code;
    const holdExpiresAt = result.reservation!.holdExpiresAt;

    // ---- 4. server-side deposit (never a client amount) --------------------
    // The 20% deposit is priced from the same rate calendar confirm_hold() will
    // bill; NO room charges are posted while the reservation is a HOLD.
    const { data: quote } = await db.rpc("deposit_for_reservation", {
      p_reservation_id: reservationId,
    });
    const q = quote as
      | { ok: true; totalPaise: number; depositPaise: number; percent: number; currency: string }
      | { ok: false; code: string }
      | null;
    if (!q?.ok) {
      // The hold is left to lazy-expire; no charge, no order, no payment.
      await release();
      return json({ ok: false, error: "We couldn't price that stay. Please try again." }, 409);
    }

    // ---- 5. Razorpay order for EXACTLY the server-computed deposit ----------
    const order = await createOrder(q.depositPaise, q.currency, ref);
    if (!order.ok) {
      // No payment, no confirmation, no charges — the hold lazy-expires.
      await release();
      return json(
        { ok: false, error: "We couldn't start the payment. Please try again in a moment." },
        502,
      );
    }

    // ---- 6. persist the intent (authoritative amount) + record acceptance --
    const { error: intentError } = await db.rpc("create_payment_intent", {
      p_reservation_id: reservationId,
      p_order_id: order.orderId,
      p_amount_paise: q.depositPaise,
      p_deposit_percent: q.percent,
      p_currency: q.currency,
    });
    if (intentError) {
      await release();
      return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
    }

    // Checkout parameters only — no secrets. keyId is the publishable key.
    const payload = {
      ok: true as const,
      ref,
      status: "hold" as const,
      holdExpiresAt,
      nights: nightCount,
      units: body.units,
      roomName: type.name as string,
      totalPaise: q.totalPaise,
      depositPaise: q.depositPaise,
      remainingPaise: q.totalPaise - q.depositPaise,
      currency: q.currency,
      razorpay: { keyId: razorpayKeyId(), orderId: order.orderId, amountPaise: q.depositPaise },
    };

    await db.rpc("complete_idempotency_key", {
      p_key: body.idempotencyKey,
      p_response: payload,
    });

    return json(payload, 201);
  } catch {
    await release();
    return json({ ok: false, error: "Something went wrong. Please try again." }, 500);
  }
}
