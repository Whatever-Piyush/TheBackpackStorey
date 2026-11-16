"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { BOOKING_PAUSED } from "@/lib/launch";
import { formatPaise } from "@/lib/money";

/**
 * Guest-facing booking lookup.
 *
 * Rate limited by code, because the pair is guessable in principle: without a
 * limit this is an oracle for "which references exist". A wrong code and a wrong
 * phone return exactly the same answer.
 */

const LOOKUP_LIMIT = 10;
const LOOKUP_WINDOW_SECONDS = 600;

export type BookingView = {
  code: string;
  guestName: string;
  status: string;
  checkin: string;
  checkout: string;
  nights: number;
  adults: number;
  children: number;
  rooms: string[];
  units: number;
  totalPaise: number;
  paidPaise: number;
};

export type LookupResult =
  | { ok: true; booking: BookingView; balance: string }
  | { ok: false; error: string };

export async function lookupBooking(
  _prev: LookupResult | null,
  formData: FormData,
): Promise<LookupResult> {
  // Paused for the portfolio launch: no lookups, no admin client.
  if (BOOKING_PAUSED) {
    return { ok: false, error: "Online booking is paused. Please WhatsApp or call us." };
  }

  const code = String(formData.get("code") ?? "").trim();
  const phone = String(formData.get("phone") ?? "").trim();

  if (!code || !phone) {
    return { ok: false, error: "Enter the phone number you booked with." };
  }

  const db = createAdminClient();

  const { data: allowed } = await db.rpc("check_rate_limit", {
    p_bucket: `lookup:${code.toUpperCase()}`,
    p_limit: LOOKUP_LIMIT,
    p_window_seconds: LOOKUP_WINDOW_SECONDS,
  });
  if (allowed === false) {
    return { ok: false, error: "Too many attempts. Please wait a few minutes, or call us." };
  }

  const { data, error } = await db.rpc("public_booking_lookup", {
    p_code: code,
    p_phone: phone,
  });
  if (error) return { ok: false, error: "We couldn't check that just now." };

  const result = data as ({ ok: true } & BookingView) | { ok: false; code: string };
  if (!result?.ok) {
    // Deliberately identical for a wrong code and a wrong phone.
    return {
      ok: false,
      error: "No booking matches that reference and phone number.",
    };
  }

  // Mapped explicitly rather than spread, so exactly what a guest can see is
  // visible here and an added column can't leak by accident.
  const booking: BookingView = {
    code: result.code,
    guestName: result.guestName,
    status: result.status,
    checkin: result.checkin,
    checkout: result.checkout,
    nights: result.nights,
    adults: result.adults,
    children: result.children,
    rooms: result.rooms,
    units: result.units,
    totalPaise: result.totalPaise,
    paidPaise: result.paidPaise,
  };

  return {
    ok: true,
    booking,
    balance: formatPaise(booking.totalPaise - booking.paidPaise),
  };
}
