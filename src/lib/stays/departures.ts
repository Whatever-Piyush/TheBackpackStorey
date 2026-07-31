import { createClient } from "@/lib/supabase/server";

/** Departures and the folio statement (ROADMAP M2 item 3). */

export type FolioItem = {
  id: string;
  kind: "room_night" | "food" | "beverage" | "extra" | "discount" | "tax";
  description: string;
  qty: number;
  unitPricePaise: number;
  amountPaise: number;
  stayDate: string | null;
  source: string | null;
  postedAt: string;
};

export type FolioPayment = {
  id: string;
  method: string;
  amountPaise: number;
  reference: string | null;
  receivedAt: string;
};

/** An unsettled café order against the stay. Shown, never hidden. */
export type OpenOrder = {
  id: string;
  ref: string;
  status: string;
  totalPaise: number;
  where: string;
};

export type Folio = {
  folioId: string | null;
  items: FolioItem[];
  payments: FolioPayment[];
  chargesPaise: number;
  paidPaise: number;
  balancePaise: number;
  openOrders: OpenOrder[];
};

export type Departure = {
  reservationId: string;
  code: string;
  status: string;
  checkin: string;
  checkout: string;
  /** Still in-house past their checkout date. */
  overdue: boolean;
  guestName: string;
  guestPhone: string | null;
  guests: number;
  rooms: string[];
  folio: Folio;
};

export type DeparturesData = {
  date: string;
  search: string | null;
  departures: Departure[];
};

export async function getDepartures(date?: string, search?: string): Promise<DeparturesData> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("stays_departures", {
    p_date: date ?? null,
    p_search: search ?? null,
  });
  if (error) throw new Error(`Couldn't load departures: ${error.message}`);
  return data as DeparturesData;
}
