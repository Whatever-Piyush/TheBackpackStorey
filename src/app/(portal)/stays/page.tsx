import type { Metadata } from "next";
import { BedDouble, CalendarRange, Globe, LogIn, LogOut, Radio } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { HubGrid, HubHeader, type HubTile } from "@/components/portal/hub";
import { PortalPlaceholder } from "@/components/portal/placeholder";

export const metadata: Metadata = {
  title: "Stays",
  robots: { index: false, follow: false },
};

const TILES: HubTile[] = [
  {
    href: "/stays/board",
    label: "Occupancy board",
    blurb: "14 days across every bed and room — move a stay, or block a unit.",
    icon: CalendarRange,
    live: true,
  },
  {
    href: "/stays/arrivals",
    label: "Arrivals & check-in",
    blurb: "Today plus anyone still to arrive — capture ID and check them in.",
    icon: LogIn,
    live: true,
  },
  {
    href: "/stays/departures",
    label: "Departures & checkout",
    blurb: "Read the bill, take payment, settle the folio.",
    icon: LogOut,
    live: true,
  },
  {
    href: "/stays/in-house",
    label: "In-house",
    blurb: "Extend or shorten a stay, and post extras to the folio.",
    icon: BedDouble,
    live: true,
  },
  {
    href: "/stays/ota",
    label: "Channel booking",
    blurb: "Type in a Booking.com, MMT, Goibibo or Airbnb reservation.",
    icon: Globe,
    live: true,
  },
  {
    href: "/stays/channel",
    label: "Channel sync",
    blurb: "What still needs publishing, and anything that failed.",
    icon: Radio,
    live: true,
  },
];

export default async function StaysPage() {
  // Housekeeping sees the housekeeping board; front desk run the whole desk.
  const { role } = await requireRole(["owner", "manager", "reception", "housekeeping"]);

  return (
    <>
      <div className="mx-auto max-w-5xl px-5 py-14 sm:px-8 sm:py-16">
        <HubHeader
          eyebrow="Stays"
          title="Front desk"
          intro="The whole desk in one place — who is arriving, who is leaving, who is in a bed tonight, and what the channels still owe us."
        />

        <div className="mt-10">
          <HubGrid tiles={TILES} />
        </div>
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
