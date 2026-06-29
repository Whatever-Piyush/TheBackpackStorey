import type { Metadata } from "next";
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
    <PortalPlaceholder
      title="Stays — Lite PMS"
      phase="Phase 3"
      role={role}
      intro="A 14-day occupancy board, check-in with ID, check-out with the balance cleared, and a housekeeping board — right-sized for a six-bed dorm and a few rooms."
      screens={[
        "Occupancy board (rooms + dorm beds × 14 days)",
        "New / edit booking — guest, dates, source",
        "Check-in — capture ID, mark in-house",
        "Check-out — settle balance, room → dirty",
        "Housekeeping board — clean / dirty / in-progress",
        "Guests — searchable log with stay history",
      ]}
    />
  );
}
