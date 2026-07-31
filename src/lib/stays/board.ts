import { createClient } from "@/lib/supabase/server";

/**
 * Occupancy board data (ROADMAP M2 item 1).
 *
 * ONE RPC for the whole visible range — 9 units × 14 days is small enough that
 * fetching it in one document is both simpler and faster than paging.
 */

export type BoardUnit = {
  unitId: string;
  /** Bed label for a dorm bed; null when the whole room is the unit. */
  label: string | null;
};

export type BoardRoom = {
  roomId: string;
  number: string;
  roomTypeId: string;
  typeName: string;
  typeCode: string;
  sellMode: "per_bed" | "per_room";
  housekeeping: string;
  units: BoardUnit[];
};

export type BoardAllocation = {
  id: string;
  unitId: string;
  reason: "booking" | "maintenance" | "owner_use" | "hold";
  /** Half-open: `to` is the checkout date, which is NOT an occupied night. */
  from: string;
  to: string;
  reservationId: string | null;
  code: string | null;
  status: string | null;
  guestName: string | null;
  guestPhone: string | null;
  adults: number | null;
  children: number | null;
  unitsOnReservation: number;
};

export type BoardData = {
  from: string;
  days: number;
  today: string;
  dates: string[];
  rooms: BoardRoom[];
  allocations: BoardAllocation[];
};

export async function getBoard(from?: string, days = 14): Promise<BoardData> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stays_board", {
    p_from: from ?? null,
    p_days: days,
  });
  if (error) throw new Error(`Couldn't load the board: ${error.message}`);
  if (!data) throw new Error("The board returned no data.");
  return data as BoardData;
}
