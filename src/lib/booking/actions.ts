"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { RATES, nights } from "@/lib/booking/rates";
import type { AvailOption, AvailabilityResult, BookingResult } from "@/lib/booking/types";
import { SITE, type RoomType } from "@/lib/site";

const ACTIVE = ["reserved", "checked_in"];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Which room types have space for the given dates, and at what price. */
export async function searchAvailability(input: {
  checkIn: string;
  checkOut: string;
}): Promise<AvailabilityResult> {
  const { checkIn, checkOut } = input;
  if (!checkIn || !checkOut) return { ok: false, error: "Pick both dates." };
  if (checkIn < today()) return { ok: false, error: "Check-in can't be in the past." };
  const n = nights(checkIn, checkOut);
  if (n < 1) return { ok: false, error: "Check-out must be after check-in." };

  const db = createAdminClient();

  const { data: rooms, error: rErr } = await db
    .from("rooms")
    .select("id, name, type, is_dorm, total_beds");
  if (rErr) return { ok: false, error: rErr.message };

  // Active bookings that overlap [checkIn, checkOut).
  const { data: booked, error: bErr } = await db
    .from("bookings")
    .select("room_id, bed_id")
    .in("status", ACTIVE)
    .lt("check_in", checkOut)
    .gt("check_out", checkIn);
  if (bErr) return { ok: false, error: bErr.message };

  const options: AvailOption[] = (rooms ?? []).map((room) => {
    const overlaps = (booked ?? []).filter((b) => b.room_id === room.id);
    let free: number;
    if (room.is_dorm) {
      const takenBeds = new Set(
        overlaps.filter((b) => b.bed_id).map((b) => b.bed_id),
      ).size;
      free = Math.max(0, room.total_beds - takenBeds);
    } else {
      free = overlaps.length > 0 ? 0 : 1;
    }
    return {
      type: room.type as RoomType,
      name: room.name as string,
      isDorm: room.is_dorm as boolean,
      ratePaise: RATES[room.type as RoomType] ?? 0,
      freeUnits: free,
      unitLabel: room.is_dorm ? "bed" : "room",
    };
  });

  return { ok: true, nights: n, options };
}

/** Create a website reservation (status 'reserved'; pay at property). */
export async function createBooking(input: {
  roomType: RoomType;
  checkIn: string;
  checkOut: string;
  guests: number;
  name: string;
  phone: string;
  email?: string;
  notes?: string;
}): Promise<BookingResult> {
  const name = input.name?.trim();
  const phone = input.phone?.trim();
  if (!name) return { ok: false, error: "Your name is required." };
  if (!phone) return { ok: false, error: "A phone number is required." };
  if (input.checkIn < today()) return { ok: false, error: "Check-in can't be in the past." };
  const n = nights(input.checkIn, input.checkOut);
  if (n < 1) return { ok: false, error: "Check-out must be after check-in." };

  const db = createAdminClient();

  const { data: room, error: rErr } = await db
    .from("rooms")
    .select("id, is_dorm")
    .eq("type", input.roomType)
    .maybeSingle();
  if (rErr) return { ok: false, error: rErr.message };
  if (!room) return { ok: false, error: "That room type wasn't found." };

  const { data: booked, error: bErr } = await db
    .from("bookings")
    .select("bed_id")
    .eq("room_id", room.id)
    .in("status", ACTIVE)
    .lt("check_in", input.checkOut)
    .gt("check_out", input.checkIn);
  if (bErr) return { ok: false, error: bErr.message };

  let bedId: string | null = null;
  if (room.is_dorm) {
    const { data: beds } = await db.from("beds").select("id").eq("room_id", room.id);
    const taken = new Set((booked ?? []).map((b) => b.bed_id).filter(Boolean));
    const freeBed = (beds ?? []).find((b) => !taken.has(b.id));
    if (!freeBed) return { ok: false, error: "Sorry — the dorm is full for those dates." };
    bedId = freeBed.id;
  } else if ((booked ?? []).length > 0) {
    return { ok: false, error: "Sorry — that room is already booked for those dates." };
  }

  const total = (RATES[input.roomType] ?? 0) * n;

  const { data: guest, error: gErr } = await db
    .from("guests")
    .insert({ name, phone, email: input.email?.trim() || null })
    .select("id")
    .single();
  if (gErr || !guest) return { ok: false, error: gErr?.message ?? "Couldn't save your details." };

  const { data: bk, error: insErr } = await db
    .from("bookings")
    .insert({
      guest_id: guest.id,
      room_id: room.id,
      bed_id: bedId,
      check_in: input.checkIn,
      check_out: input.checkOut,
      status: "reserved",
      source: "website",
      amount_paise: total,
      balance_paise: total,
      notes: input.notes?.trim() || null,
    })
    .select("id")
    .single();

  if (insErr || !bk) {
    // 23P01 = exclusion violation (someone grabbed it first), 23505 = unique.
    const clash = insErr?.code === "23P01" || insErr?.code === "23505";
    return {
      ok: false,
      error: clash
        ? "Those dates were just taken — please try different dates."
        : insErr?.message ?? "Couldn't create the booking.",
    };
  }

  const ref = String(bk.id).slice(0, 8).toUpperCase();
  const waDigits = SITE.whatsapp.replace(/[^\d]/g, "");
  const msg =
    `Hi Backpackers Storey! I've requested a booking (ref ${ref}): ` +
    `${input.roomType} for ${n} night${n > 1 ? "s" : ""}, ` +
    `${input.checkIn} → ${input.checkOut}, ${input.guests} guest${input.guests > 1 ? "s" : ""}. ` +
    `Name: ${name}. Please confirm.`;
  const whatsapp = `https://wa.me/${waDigits}?text=${encodeURIComponent(msg)}`;

  return { ok: true, ref, total, whatsapp };
}
