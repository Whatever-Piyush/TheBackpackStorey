import type { Metadata } from "next";
import { BookOpen, ChartColumn, ChefHat, ReceiptIndianRupee, ShoppingCart } from "lucide-react";
import { requireRole, type Role } from "@/lib/auth";
import { HubGrid, HubHeader, type HubTile } from "@/components/portal/hub";

export const metadata: Metadata = {
  title: "Café POS",
  robots: { index: false, follow: false },
};

type Card = HubTile & { roles: Role[] };

const CARDS: Card[] = [
  {
    href: "/pos/menu",
    label: "Menu management",
    blurb: "Prices, availability, categories and items.",
    icon: BookOpen,
    roles: ["owner", "manager", "reception"],
    live: true,
  },
  {
    href: "/pos/order",
    label: "New order",
    blurb: "Dine-in, takeaway or room — build the bill.",
    icon: ShoppingCart,
    roles: ["owner", "manager", "reception"],
    live: true,
  },
  {
    href: "/pos/kitchen",
    label: "Kitchen (KOT)",
    blurb: "Live tickets — tap to advance each item.",
    icon: ChefHat,
    roles: ["owner", "manager", "reception", "kitchen"],
    live: true,
  },
  {
    href: "/pos/bills",
    label: "Open bills",
    blurb: "Settle by cash, UPI or card — or charge to a room.",
    icon: ReceiptIndianRupee,
    roles: ["owner", "manager", "reception"],
    live: true,
  },
  {
    href: "/pos/today",
    label: "Today",
    blurb: "Totals by method, open vs settled, close the day.",
    icon: ChartColumn,
    roles: ["owner"],
    live: true,
  },
];

export default async function PosPage() {
  const { role } = await requireRole(["owner", "manager", "reception", "kitchen"]);
  const cards = CARDS.filter((c) => role !== null && c.roles.includes(role));

  return (
    <div className="mx-auto max-w-5xl px-5 py-14 sm:px-8 sm:py-16">
      <HubHeader
        eyebrow="Café POS"
        title="Counter"
        intro="Run the rooftop café — manage the menu, take orders, send them to the kitchen live, and settle the bill."
      />

      <div className="mt-10">
        <HubGrid tiles={cards} />
      </div>
    </div>
  );
}
