import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Search } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { formatPaise } from "@/lib/money";
import { getDepartures, type DeparturesData } from "@/lib/stays/departures";
import { DeparturesList } from "@/components/stays/departures-list";

export const metadata: Metadata = {
  title: "Departures",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function DeparturesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; date?: string }>;
}) {
  await requireRole(["owner", "manager", "reception"]);
  const { q, date } = await searchParams;

  let data: DeparturesData;
  try {
    data = await getDepartures(date, q);
  } catch {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <p className="rounded-card border hairline bg-forest/40 p-6 text-center text-sage">
          Couldn&apos;t load departures.{" "}
          <Link href="/stays/departures" className="text-amber hover:underline">
            Try again
          </Link>
        </p>
      </div>
    );
  }

  const outstanding = data.departures.reduce((s, d) => s + d.folio.balancePaise, 0);
  const overdue = data.departures.filter((d) => d.overdue).length;
  const blocked = data.departures.filter((d) => d.folio.openOrders.length > 0).length;

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
            Departures
          </h1>
          <p className="mt-1 text-sm text-sage">
            {data.date} · {data.departures.length} due out
            {overdue > 0 && <span className="text-amber"> · {overdue} overdue</span>}
            {blocked > 0 && <span className="text-amber"> · {blocked} with café open</span>}
          </p>
        </div>
        {outstanding > 0 && (
          <p className="font-display text-lg font-bold text-amber">
            {formatPaise(outstanding)}{" "}
            <span className="font-data text-[0.6rem] uppercase tracking-[0.14em] text-sage">
              to collect
            </span>
          </p>
        )}
      </div>

      {/* Plain GET so search works with or without JavaScript. */}
      <form className="mt-5 flex gap-2" action="/stays/departures">
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

      <DeparturesList departures={data.departures} />
    </div>
  );
}
