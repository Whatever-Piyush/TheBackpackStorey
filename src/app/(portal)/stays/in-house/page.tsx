import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { formatPaise } from "@/lib/money";
import { getInHouse, type InHouseData } from "@/lib/stays/in-house";
import { InHouseList } from "@/components/stays/in-house-list";

export const metadata: Metadata = {
  title: "In-house",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function InHousePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireRole(["owner", "manager", "reception"]);
  const { q } = await searchParams;

  let data: InHouseData;
  try {
    data = await getInHouse(q);
  } catch {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <p className="rounded-card border hairline bg-forest/40 p-6 text-center text-sage">
          Couldn&apos;t load in-house guests.{" "}
          <Link href="/stays/in-house" className="text-amber hover:underline">
            Try again
          </Link>
        </p>
      </div>
    );
  }

  const heads = data.stays.reduce((s, x) => s + x.guests, 0);
  const outstanding = data.stays.reduce((s, x) => s + x.folio.balancePaise, 0);
  const dueOut = data.stays.filter((s) => s.dueOutToday).length;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link
        href="/stays"
        className="inline-flex items-center gap-1.5 text-sm text-sage hover:text-paper"
      >
        <ArrowLeft size={16} aria-hidden /> Stays
      </Link>

      <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-paper sm:text-3xl">
            In-house
          </h1>
          <p className="mt-1 text-sm text-sage">
            {data.stays.length} stay{data.stays.length === 1 ? "" : "s"} · {heads} guest
            {heads === 1 ? "" : "s"}
            {dueOut > 0 && <span className="text-amber"> · {dueOut} out today</span>}
          </p>
        </div>
        {outstanding > 0 && (
          <p className="font-display text-lg font-bold text-paper">
            {formatPaise(outstanding)}{" "}
            <span className="font-data text-[0.6rem] uppercase tracking-[0.14em] text-sage">
              on folios
            </span>
          </p>
        )}
      </div>

      {/* Plain GET so search works with or without JavaScript. */}
      <form className="mt-5 flex gap-2" action="/stays/in-house">
        <div className="relative flex-1">
          <Search
            size={15}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sage"
          />
          <input
            type="search"
            name="q"
            defaultValue={data.search ?? ""}
            placeholder="Name, phone or booking code"
            className="w-full rounded-xl border hairline bg-pine py-2.5 pl-9 pr-3 text-sm text-paper outline-none focus:border-amber"
          />
        </div>
        <button
          type="submit"
          className="rounded-xl border hairline px-4 py-2.5 text-sm text-paper transition-colors hover:border-amber hover:text-amber"
        >
          Search
        </button>
      </form>

      <InHouseList stays={data.stays} />
    </div>
  );
}
