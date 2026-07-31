import type { Metadata } from "next";
import Link from "next/link";
import { BedDouble, CalendarRange, Globe, LogIn, LogOut, Radio } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { PortalPlaceholder } from "@/components/portal/placeholder";

export const metadata: Metadata = {
  title: "Stays",
  robots: { index: false, follow: false },
};

export default async function StaysPage() {
  // Housekeeping sees the housekeeping board; front desk run the whole desk.
  const { role } = await requireRole(["owner", "manager", "reception", "housekeeping"]);

  return (
    <>
      <div className="mx-auto grid max-w-3xl gap-3 px-5 pt-12 sm:grid-cols-2 sm:px-8">
        <Link
          href="/stays/board"
          className="flex items-center gap-3 rounded-card border hairline bg-forest p-5 transition-colors hover:border-amber"
        >
          <CalendarRange size={22} strokeWidth={1.6} className="text-amber" aria-hidden />
          <span>
            <span className="block font-display text-lg font-bold text-paper">
              Occupancy board
            </span>
            <span className="mt-0.5 block text-sm text-sage">
              14 days across every bed and room — move a stay, or block a unit.
            </span>
          </span>
        </Link>

        <Link
          href="/stays/arrivals"
          className="flex items-center gap-3 rounded-card border hairline bg-forest p-5 transition-colors hover:border-amber"
        >
          <LogIn size={22} strokeWidth={1.6} className="text-amber" aria-hidden />
          <span>
            <span className="block font-display text-lg font-bold text-paper">
              Arrivals &amp; check-in
            </span>
            <span className="mt-0.5 block text-sm text-sage">
              Today plus anyone still to arrive — capture ID and check them in.
            </span>
          </span>
        </Link>

        <Link
          href="/stays/departures"
          className="flex items-center gap-3 rounded-card border hairline bg-forest p-5 transition-colors hover:border-amber"
        >
          <LogOut size={22} strokeWidth={1.6} className="text-amber" aria-hidden />
          <span>
            <span className="block font-display text-lg font-bold text-paper">
              Departures &amp; checkout
            </span>
            <span className="mt-0.5 block text-sm text-sage">
              Read the bill, take payment, settle the folio.
            </span>
          </span>
        </Link>

        <Link
          href="/stays/in-house"
          className="flex items-center gap-3 rounded-card border hairline bg-forest p-5 transition-colors hover:border-amber"
        >
          <BedDouble size={22} strokeWidth={1.6} className="text-amber" aria-hidden />
          <span>
            <span className="block font-display text-lg font-bold text-paper">
              In-house
            </span>
            <span className="mt-0.5 block text-sm text-sage">
              Extend or shorten a stay, and post extras to the folio.
            </span>
          </span>
        </Link>

        <Link
          href="/stays/ota"
          className="flex items-center gap-3 rounded-card border hairline bg-forest p-5 transition-colors hover:border-amber"
        >
          <Globe size={22} strokeWidth={1.6} className="text-amber" aria-hidden />
          <span>
            <span className="block font-display text-lg font-bold text-paper">
              Channel booking
            </span>
            <span className="mt-0.5 block text-sm text-sage">
              Type in a Booking.com, MMT, Goibibo or Airbnb reservation.
            </span>
          </span>
        </Link>

        <Link
          href="/stays/channel"
          className="flex items-center gap-3 rounded-card border hairline bg-forest p-5 transition-colors hover:border-amber"
        >
          <Radio size={22} strokeWidth={1.6} className="text-amber" aria-hidden />
          <span>
            <span className="block font-display text-lg font-bold text-paper">
              Channel sync
            </span>
            <span className="mt-0.5 block text-sm text-sage">
              What still needs publishing, and anything that failed.
            </span>
          </span>
        </Link>
      </div>

      <PortalPlaceholder
      title="Stays — Lite PMS"
      phase="Phase 3"
      role={role}
      intro="A 14-day occupancy board, check-in with ID, check-out with the balance cleared, and a housekeeping board — right-sized for a six-bed dorm and a few rooms."
      screens={[
        "New / edit booking — guest, dates, source",
        "Housekeeping board — clean / dirty / in-progress",
        "Guests — searchable log with stay history",
        "Housekeeping — board filter + clean/dirty toggle",
      ]}
      />
    </>
  );
}
