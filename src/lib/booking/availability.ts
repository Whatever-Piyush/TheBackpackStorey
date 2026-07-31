import { createPublicClient } from "@/lib/supabase/public";
import { isSupabaseConfigured } from "@/lib/supabase/config";

/**
 * Public availability and quoting (ROADMAP M3).
 *
 * Reads the two anon-granted functions. They return counts and prices only, so
 * nothing here can leak who is staying or which bed is free.
 *
 * Everything degrades to `null` rather than throwing: a room page must render
 * and read well even when the database is unreachable. What it must never do is
 * invent a price or claim a bed is free.
 *
 * Uses the cookie-free anon client so these reads don't force marketing pages
 * out of static rendering.
 */

export type NightAvailability = {
  date: string;
  free: number;
  bookable: boolean;
  pricePaise: number | null;
};

export type Availability = {
  roomTypeId: string;
  from: string;
  to: string;
  nights: NightAvailability[];
};

export type QuoteNight = { date: string; pricePaise: number };

export type Quote =
  | {
      ok: true;
      units: number;
      nights: number;
      perNight: QuoteNight[];
      unitTotalPaise: number;
      totalPaise: number;
    }
  | { ok: false; code: "NO_RATE" | "NOT_AVAILABLE" | "INVALID_DATES" | "IN_THE_PAST" | "TOO_LONG" | "UNKNOWN_ROOM_TYPE"; requested?: number };

/** Room type id for a marketing slug (`dorm`, `deluxe`, …), or null. */
export async function roomTypeIdForCode(code: string): Promise<string | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const supabase = createPublicClient();
    const { data } = await supabase
      .from("room_types")
      .select("id")
      .eq("code", code)
      .eq("active", true)
      .maybeSingle();
    return (data?.id as string) ?? null;
  } catch {
    return null;
  }
}

export async function getAvailability(
  roomTypeId: string,
  from?: string,
  to?: string,
): Promise<Availability | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const supabase = createPublicClient();
    const { data, error } = await supabase.rpc("public_availability", {
      p_room_type: roomTypeId,
      p_from: from ?? null,
      p_to: to ?? null,
    });
    if (error || !data) return null;
    const result = data as Availability & { ok: boolean };
    return result.ok ? result : null;
  } catch {
    return null;
  }
}

export async function getQuote(
  roomTypeId: string,
  checkIn: string,
  checkOut: string,
  units = 1,
): Promise<Quote | null> {
  if (!isSupabaseConfigured) return null;
  try {
    const supabase = createPublicClient();
    const { data, error } = await supabase.rpc("public_quote", {
      p_room_type: roomTypeId,
      p_checkin: checkIn,
      p_checkout: checkOut,
      p_units: units,
    });
    if (error || !data) return null;
    return data as Quote;
  } catch {
    return null;
  }
}
