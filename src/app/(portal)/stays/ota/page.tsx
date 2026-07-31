import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { listBookableChannels } from "@/lib/stays/ota";
import { OtaForm, type OtaRoomType } from "@/components/stays/ota-form";

export const metadata: Metadata = {
  title: "OTA booking",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function OtaPage() {
  await requireRole(["owner", "manager", "reception"]);

  const supabase = await createClient();
  const { data } = await supabase
    .from("room_types")
    .select("id, name, sell_mode")
    .eq("active", true)
    .order("sort_order");

  const channels = await listBookableChannels();

  const types: OtaRoomType[] = (data ?? []).map((t) => ({
    roomTypeId: t.id as string,
    name: t.name as string,
    unitNoun: t.sell_mode === "per_bed" ? "bed" : "room",
  }));

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6">
      <Link
        href="/stays"
        className="inline-flex items-center gap-1.5 text-sm text-sage hover:text-paper"
      >
        <ArrowLeft size={16} aria-hidden /> Stays
      </Link>

      <h1 className="mt-4 font-display text-2xl font-extrabold tracking-tight text-paper sm:text-3xl">
        Enter a channel booking
      </h1>
      <p className="mt-1.5 text-sm text-sage">
        Type in what arrived by email. It lands on the board immediately and shows
        no balance at checkout.
      </p>

      <div className="mt-6">
        <OtaForm types={types} channels={channels} />
      </div>
    </div>
  );
}
