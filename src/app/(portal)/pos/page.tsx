import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3, BookOpen, ChefHat, ShoppingCart } from "lucide-react";
import { requireRole, type Role } from "@/lib/auth";

export const metadata: Metadata = {
  title: "Café POS",
  robots: { index: false, follow: false },
};

type Card = {
  href: string;
  label: string;
  blurb: string;
  icon: typeof BookOpen;
  roles: Role[];
  live: boolean;
};

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
    live: false,
  },
  {
    href: "/pos/kitchen",
    label: "Kitchen (KOT)",
    blurb: "Live tickets — tap to advance each item.",
    icon: ChefHat,
    roles: ["owner", "manager", "reception", "kitchen"],
    live: false,
  },
  {
    href: "/pos/today",
    label: "Today",
    blurb: "Totals by method, open vs paid.",
    icon: BarChart3,
    roles: ["owner", "manager"],
    live: false,
  },
];

export default async function PosPage() {
  const { role } = await requireRole(["owner", "manager", "reception", "kitchen"]);
  const cards = CARDS.filter((c) => role !== null && c.roles.includes(role));

  return (
    <div className="mx-auto max-w-3xl px-5 py-12 sm:px-8">
      <p className="font-data text-xs uppercase tracking-[0.2em] text-amber">Café POS</p>
      <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-paper sm:text-4xl">
        Counter
      </h1>
      <p className="mt-3 max-w-xl leading-relaxed text-sage">
        Run the rooftop café — manage the menu, take orders, send them to the kitchen
        live, and settle the bill.
      </p>

      <div className="mt-8 grid gap-3 sm:grid-cols-2">
        {cards.map((c) => {
          const body = (
            <>
              <div className="flex items-center justify-between">
                <c.icon size={22} strokeWidth={1.6} className="text-amber" aria-hidden />
                {c.live ? null : (
                  <span className="font-data text-[0.6rem] uppercase tracking-[0.18em] text-sage/70">
                    Soon
                  </span>
                )}
              </div>
              <h2 className="mt-4 font-display text-lg font-bold text-paper">{c.label}</h2>
              <p className="mt-1 text-sm text-sage">{c.blurb}</p>
            </>
          );

          return c.live ? (
            <Link
              key={c.href}
              href={c.href}
              className="rounded-card border hairline bg-forest p-5 transition-colors hover:border-amber"
            >
              {body}
            </Link>
          ) : (
            <div
              key={c.href}
              className="rounded-card border hairline bg-forest/50 p-5 opacity-70"
            >
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
