import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Download, Search } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { getArrivals, type ArrivalsData } from "@/lib/stays/arrivals";
import { ArrivalsList } from "@/components/stays/arrivals-list";

export const metadata: Metadata = {
  title: "Arrivals",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ArrivalsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; date?: string }>;
}) {
  const { role } = await requireRole(["owner", "manager", "reception"]);
  const { q, date } = await searchParams;

  let data: ArrivalsData;
  try {
    data = await getArrivals(date, q);
  } catch {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <p className="rounded-card border hairline bg-forest/40 p-6 text-center text-sage">
          Couldn&apos;t load arrivals.{" "}
          <Link href="/stays/arrivals" className="text-amber hover:underline">
            Try again
          </Link>
        </p>
      </div>
    );
  }

  const overdue = data.arrivals.filter((a) => a.overdue).length;
  const foreign = data.arrivals.filter((a) => a.party.some((p) => p.isForeign)).length;

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
            Arrivals
          </h1>
          <p className="mt-1 text-sm text-sage">
            {data.date} · {data.arrivals.length} expected
            {overdue > 0 && <span className="text-amber"> · {overdue} overdue</span>}
            {foreign > 0 && ` · ${foreign} foreign`}
          </p>
        </div>

        {(role === "owner" || role === "manager") && (
          <Link
            href="/stays/arrivals/form-c"
            className="inline-flex items-center gap-1.5 rounded-xl border hairline px-3 py-2.5 text-sm text-sage transition-colors hover:border-amber hover:text-amber"
          >
            <Download size={15} aria-hidden />
            Foreign register (CSV)
          </Link>
        )}
      </div>

      {/* Plain GET so search works with or without JavaScript. */}
      <form className="mt-5 flex gap-2" action="/stays/arrivals">
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

      <datalist id="nationality-options">
        {["India", "Germany", "France", "United Kingdom", "Israel", "Russia", "United States", "Australia"].map(
          (n) => (
            <option key={n} value={n} />
          ),
        )}
      </datalist>

      <ArrivalsList arrivals={data.arrivals} />
    </div>
  );
}
