import { createHash } from "node:crypto";
import { z } from "zod";
import { createAdminClient } from "@/lib/supabase/admin";
import { nights, today } from "@/lib/dates";
import { BOOKING_PAUSED } from "@/lib/launch";
import { sendConfirmationEmail, whatsappLink } from "@/lib/booking/notify";

/**
 * POST /api/book — the public booking endpoint (ROADMAP M4).
 *
 * Runs on the SERVICE ROLE and is never called with the anon key from a browser:
 * `reservations` and `allocations` are deny-by-default, so the browser could not
 * write them even if it tried.
 *
 * Three protections, in order:
 *   1. rate limit by IP        — a booking form is a free write endpoint
 *   2. Zod validation          — nothing reaches the database unshaped
 *   3. idempotency key         — a double-click, or a retry after the connection
 *                                drops on hill internet, must not book twice
 */

export const dynamic = "force-dynamic";

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
  // Paused for the portfolio launch (src/lib/launch.ts): answer before the body
  // is read and before any database client exists. Nothing can be reserved.
  if (BOOKING_PAUSED) {
    return json({ ok: false, error: "Online booking is paused. Please WhatsApp us." }, 503);
  }

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
      // Inventory is pooled: the website may sell every free unit, and the
      // Channel Manager closes them elsewhere.
      p_actor_id: null,
      p_actor_label: "Website",
    });

    if (error) {
      await release();
      return json({ ok: false, error: "We couldn't complete that booking." }, 500);
    }

    const result = data as {
      ok: boolean;
      code?: string;
      available?: number;
      reservation?: { id: string; code: string };
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

    // Put the room nights on a folio now, so the confirmation shows a real
    // total and reception sees the bill before the guest arrives. Idempotent,
    // and check-in re-runs it, so a failure here is recoverable.
    let totalPaise = 0;
    const { data: charges } = await db.rpc("ensure_room_charges", {
      p_reservation_id: reservationId,
    });
    const folioId = (charges as { folioId?: string } | null)?.folioId;
    if (folioId) {
      const { data: items } = await db
        .from("folio_items")
        .select("amount_paise")
        .eq("folio_id", folioId);
      totalPaise = (items ?? []).reduce(
        (sum, i) => sum + (i.amount_paise as number),
        0,
      );
    }

    const confirmation = {
      ref,
      guestName: body.name,
      email: body.email || null,
      roomName: type.name as string,
      units: body.units,
      unitNoun: type.sell_mode === "per_bed" ? "bed" : "room",
      checkIn: body.checkIn,
      checkOut: body.checkOut,
      nights: nightCount,
      totalPaise,
    };

    // Best effort: the booking is already committed and must not be reported as
    // failed because a mail provider is down.
    const emailed = await sendConfirmationEmail(confirmation);

    const payload = {
      ok: true as const,
      ref,
      totalPaise,
      nights: nightCount,
      units: body.units,
      whatsapp: whatsappLink(confirmation),
      emailed,
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
