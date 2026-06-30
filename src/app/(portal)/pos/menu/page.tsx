import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { getMenu } from "@/lib/pos/menu";
import { MenuManager } from "@/components/pos/menu-manager";

export const metadata: Metadata = {
  title: "Menu management",
  robots: { index: false, follow: false },
};

export default async function MenuPage() {
  await requireRole(["owner", "manager", "reception"]);
  const categories = await getMenu();

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:px-8">
      <Link href="/pos" className="font-data text-xs text-sage transition-colors hover:text-amber">
        ← POS
      </Link>
      <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-paper">
        Menu management
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-sage">
        Set real prices, switch items on or off, and add new ones. Prices are entered
        in rupees and stored to the paisa. Changes go live for the café POS immediately.
      </p>

      <div className="mt-8">
        <MenuManager categories={categories} />
      </div>
    </div>
  );
}
