import { createClient } from "@/lib/supabase/server";

/**
 * Reception dashboard (0014_reception_dashboard.sql).
 *
 * ONE RPC call assembles every widget — internet in Bir is patchy, and eight
 * round trips is eight chances to fail.
 *
 * Deliberately uses the USER-SCOPED server client (cookies → the staffer's JWT),
 * not the service role: the function is SECURITY DEFINER and checks `is_staff()`
 * against `auth.uid()`, which is null under the service role. Mutations are the
 * mirror image — service role plus an explicit actor.
 */

export type ArrivalRow = {
  reservationId: string;
  code: string;
  guestName: string;
  guestPhone: string | null;
  status: string;
  nights?: number;
  adults?: number;
  children?: number;
  units: number;
  rooms: string[];
};

export type DashboardData = {
  date: string;
  arrivals: ArrivalRow[];
  departures: ArrivalRow[];
  inHouse: { reservations: number; guests: number };
  occupancy: { sold: number; sellable: number; pct: number };
  availableByType: {
    roomTypeId: string;
    code: string;
    name: string;
    sellMode: "per_bed" | "per_room";
    total: number;
    available: number;
  }[];
  needsCleaning: {
    roomId: string;
    number: string;
    housekeeping: string;
    units: number;
  }[];
  openFolios: {
    folioId: string;
    reservationId: string | null;
    code: string | null;
    guestName: string;
    tableNo: string | null;
    balancePaise: number;
  }[];
  events: {
    id: string;
    at: string;
    kind: string;
    actorLabel: string | null;
    summary: string;
    reservationId: string | null;
  }[];
};

/**
 * Throws on failure so the route's error.tsx can offer a retry — a blank
 * dashboard is worse than an honest error at a reception desk.
 */
export async function getDashboard(date?: string): Promise<DashboardData> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("reception_dashboard", {
    p_date: date ?? null,
  });

  if (error) throw new Error(`Dashboard unavailable: ${error.message}`);
  if (!data) throw new Error("Dashboard returned no data.");

  return data as DashboardData;
}
