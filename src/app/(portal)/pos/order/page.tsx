import type { Metadata } from "next";
import Link from "next/link";
import { requireRole } from "@/lib/auth";
import { getMenu } from "@/lib/pos/menu";
import { createClient } from "@/lib/supabase/server";
import { OrderBuilder } from "@/components/pos/order-builder";

export const metadata: Metadata = {
  title: "New order",
  robots: { index: false, follow: false },
};

export default async function NewOrderPage() {
  await requireRole(["owner", "manager", "reception"]);

  const supabase = await createClient();
  const [categories, roomsRes] = await Promise.all([
    getMenu(),
    supabase.from("rooms").select("id, name").order("name"),
  ]);
  const rooms = (roomsRes.data ?? []) as { id: string; name: string }[];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <Link href="/pos" className="font-data text-xs text-sage transition-colors hover:text-amber">
        ← POS
      </Link>
      <h1 className="mt-3 font-display text-3xl font-extrabold tracking-tight text-paper">
        New order
      </h1>
      <p className="mt-2 text-sm text-sage">
        Tap items to build the ticket, then send it straight to the kitchen.
      </p>

      <OrderBuilder categories={categories} rooms={rooms} />
    </div>
  );
}
