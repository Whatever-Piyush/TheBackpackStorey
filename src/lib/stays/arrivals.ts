import { createClient } from "@/lib/supabase/server";

/** Arrivals + check-in data (ROADMAP M2 item 2). */

export type ArrivalUnit = {
  allocationId: string;
  unitId: string;
  roomTypeId: string;
  room: string;
  bed: string | null;
};

/** One person on the booking. Everyone needs ID before check-in can complete. */
export type PartyGuest = {
  guestId: string;
  name: string;
  phone: string | null;
  email: string | null;
  nationality: string | null;
  isForeign: boolean;
  isLead: boolean;
  idProofType: string | null;
  idProofNumber: string | null;
  passportNumber: string | null;
  passportIssueDate: string | null;
  passportExpiry: string | null;
  visaNumber: string | null;
  visaType: string | null;
  visaExpiry: string | null;
  arrivedInIndiaOn: string | null;
  arrivedFrom: string | null;
  nextDestination: string | null;
  /** ID number, passport, or a scan on file. */
  hasId: boolean;
  documents: number;
};

export type Arrival = {
  reservationId: string;
  code: string;
  status: string;
  checkin: string;
  checkout: string;
  nights: number;
  /** Expected before today and still not arrived — surfaced first, never dropped. */
  overdue: boolean;
  adults: number;
  children: number;
  source: string;
  guestId: string | null;
  guestName: string;
  guestPhone: string | null;
  guestEmail: string | null;
  party: PartyGuest[];
  units: ArrivalUnit[];
};

export type ArrivalsData = {
  date: string;
  search: string | null;
  arrivals: Arrival[];
};

export async function getArrivals(date?: string, search?: string): Promise<ArrivalsData> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stays_arrivals", {
    p_date: date ?? null,
    p_search: search ?? null,
  });
  if (error) throw new Error(`Couldn't load arrivals: ${error.message}`);
  return data as ArrivalsData;
}
