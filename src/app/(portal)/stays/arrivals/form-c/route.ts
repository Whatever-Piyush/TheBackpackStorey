import { requireRole } from "@/lib/auth";
import { STAFF_PORTAL_ENABLED } from "@/lib/launch-server";
import { createClient } from "@/lib/supabase/server";
import { addDays } from "@/lib/dates";

/**
 * Foreign-guest register, as CSV.
 *
 * Export only. Nothing here submits to any authority — the roadmap is explicit
 * that automated submission waits until the current process is confirmed.
 */

type Row = Record<string, string | number | null>;

const COLUMNS: { key: string; header: string }[] = [
  { key: "code", header: "Booking" },
  { key: "guestName", header: "Name" },
  { key: "nationality", header: "Nationality" },
  { key: "passportNumber", header: "Passport no." },
  { key: "passportIssueDate", header: "Passport issued" },
  { key: "passportExpiry", header: "Passport expiry" },
  { key: "visaNumber", header: "Visa no." },
  { key: "visaType", header: "Visa type" },
  { key: "visaExpiry", header: "Visa expiry" },
  { key: "arrivedInIndiaOn", header: "Arrived in India" },
  { key: "arrivedFrom", header: "Arrived from" },
  { key: "nextDestination", header: "Next destination" },
  { key: "checkin", header: "Check-in" },
  { key: "checkout", header: "Check-out" },
  { key: "rooms", header: "Room(s)" },
];

/** RFC 4180: quote everything, double any internal quote. */
function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

export async function GET(request: Request) {
  // Route handlers bypass the (portal) layout gate, so repeat it here.
  if (!STAFF_PORTAL_ENABLED) return new Response(null, { status: 404 });

  await requireRole(["owner", "manager"]);

  const url = new URL(request.url);
  const today = new Date().toISOString().slice(0, 10);
  // Default window: the last 30 days of arrivals.
  const from = url.searchParams.get("from") ?? addDays(today, -30);
  const to = url.searchParams.get("to") ?? addDays(today, 1);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("foreign_guest_register", {
    p_from: from,
    p_to: to,
  });
  if (error) {
    return new Response(`Could not build the register: ${error.message}`, { status: 500 });
  }

  const rows = (data ?? []) as Row[];
  const csv = [
    COLUMNS.map((c) => csvCell(c.header)).join(","),
    ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c.key])).join(",")),
  ].join("\r\n");

  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="foreign-guests-${from}-to-${to}.csv"`,
      // Contains passport numbers: never cached, never stored by an intermediary.
      "Cache-Control": "no-store, private",
    },
  });
}
