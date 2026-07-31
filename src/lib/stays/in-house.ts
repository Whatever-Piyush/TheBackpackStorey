import { createClient } from "@/lib/supabase/server";
import type { Folio } from "@/lib/stays/departures";

/** In-house stays (ROADMAP M2 item 4). */

export type StayUnit = {
  allocationId: string;
  unitId: string;
  roomTypeId: string;
  typeName: string;
  room: string;
  bed: string | null;
  from: string;
  to: string;
};

export type InHouseStay = {
  reservationId: string;
  code: string;
  checkin: string;
  checkout: string;
  nights: number;
  nightsLeft: number;
  dueOutToday: boolean;
  guestName: string;
  guestPhone: string | null;
  guests: number;
  units: StayUnit[];
  folio: Folio;
};

export type InHouseData = {
  today: string;
  search: string | null;
  stays: InHouseStay[];
};

/** A unit that could take the stay when a straight extension is refused. */
export type UnitOption = { unitId: string; label: string };

export type BlockedAllocation = {
  allocationId: string;
  unit: string;
  /** Free for the WHOLE stay — the guest keeps one bed. */
  moveOptions: UnitOption[];
  /** Free for the EXTRA nights only — the guest changes beds. */
  splitOptions: UnitOption[];
};

export async function getInHouse(search?: string): Promise<InHouseData> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stays_in_house", {
    p_search: search ?? null,
  });
  if (error) throw new Error(`Couldn't load in-house guests: ${error.message}`);
  return data as InHouseData;
}
