import type { Metadata } from "next";
import { requireRole } from "@/lib/auth";
import { PortalPlaceholder } from "@/components/portal/placeholder";

export const metadata: Metadata = {
  title: "Café POS",
  robots: { index: false, follow: false },
};

export default async function PosPage() {
  // Kitchen sees the POS (for the KOT); front desk run the whole flow.
  const { role } = await requireRole(["owner", "manager", "reception", "kitchen"]);

  return (
    <PortalPlaceholder
      title="Café POS"
      phase="Phase 2"
      role={role}
      intro="Take an order, send it to the kitchen live, settle the bill in cash or UPI — built for speed on a phone at the counter."
      screens={[
        "Menu management (categories, items, availability)",
        "New order — dine-in / takeaway / room",
        "Kitchen display (KOT) — realtime, tap to advance",
        "Billing — discount, settle, printable receipt",
        "Today — totals by method, open vs paid",
      ]}
    />
  );
}
