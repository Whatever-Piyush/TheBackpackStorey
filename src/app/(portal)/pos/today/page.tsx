import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Lock } from "lucide-react";
import { requireCanViewMoney } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatPaise } from "@/lib/money";
import { CloseDayButton } from "@/components/pos/close-day";
import { PAYMENT_METHODS, type DayReport } from "@/lib/pos/types";

export const metadata: Metadata = {
  title: "Today",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** One RPC for the whole report — the same one-round-trip rule as the dashboard. */
async function getDay(date?: string): Promise<DayReport> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("pos_today", { p_date: date ?? null });
  if (error) throw new Error(error.message);
  return data as DayReport;
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-card border hairline bg-forest/40 p-4">
      <p className="font-data text-[0.62rem] uppercase tracking-[0.16em] text-sage">{label}</p>
      <p className="mt-1.5 font-display text-2xl font-extrabold text-paper">{value}</p>
      {sub && <p className="mt-1 text-xs text-sage/80">{sub}</p>}
    </div>
  );
}

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string }>;
}) {
  // Aggregate takings are visible to the money-visible roles (owner + manager),
  // matching the database gate can_view_money(). Managers were previously locked
  // out of the one revenue screen even though pos_today() already admitted them.
  await requireCanViewMoney();
  const { date } = await searchParams;

  let day: DayReport;
  try {
    day = await getDay(date);
  } catch {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <p className="rounded-card border hairline bg-forest/40 p-6 text-center text-sage">
          Couldn&apos;t load today&apos;s numbers.{" "}
          <Link href="/pos/today" className="text-amber hover:underline">
            Try again
          </Link>
        </p>
      </div>
    );
  }

  const byMethod = PAYMENT_METHODS.map((m) => ({
    ...m,
    row: day.byMethod.find((b) => b.method === m.value),
  }));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link
        href="/pos"
        className="inline-flex items-center gap-1.5 text-sm text-sage hover:text-paper"
      >
        <ArrowLeft size={16} aria-hidden /> Counter
      </Link>

      <div className="mt-4 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-display text-2xl font-extrabold tracking-tight text-paper sm:text-3xl">
          Today
        </h1>
        <p className="font-data text-[0.65rem] uppercase tracking-[0.16em] text-amber">
          {/* Computed in Postgres, Asia/Kolkata. */}
          {day.date}
        </p>
      </div>

      {day.closed && (
        <p className="mt-4 inline-flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/5 px-4 py-2.5 text-sm text-emerald-400">
          <Lock size={15} aria-hidden />
          Closed {new Date(day.closed.at).toLocaleTimeString("en-IN", {
            timeZone: "Asia/Kolkata",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
          {day.closed.by ? ` by ${day.closed.by}` : ""}
        </p>
      )}

      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Taken" value={formatPaise(day.summary.grossPaise)} sub={`${day.summary.settled} settled`} />
        <Stat label="Open" value={formatPaise(day.summary.openPaise)} sub={`${day.summary.open} bill${day.summary.open === 1 ? "" : "s"}`} />
        <Stat label="To rooms" value={formatPaise(day.summary.toRoomPaise)} sub="settled at checkout" />
        <Stat label="Discounts" value={formatPaise(day.summary.discountPaise)} sub={`${day.summary.orders} orders`} />
      </div>

      <section className="mt-6">
        <h2 className="font-data text-[0.68rem] uppercase tracking-[0.16em] text-sage">
          By payment method
        </h2>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {byMethod.map((m) => (
            <div key={m.value} className="rounded-xl border hairline bg-forest/40 px-4 py-3">
              <p className="text-sm text-paper">{m.label}</p>
              <p className="mt-0.5 font-display text-lg font-bold text-paper">
                {formatPaise(m.row?.totalPaise ?? 0)}
              </p>
              <p className="font-data text-[0.6rem] uppercase tracking-[0.14em] text-sage">
                {m.row?.count ?? 0} order{(m.row?.count ?? 0) === 1 ? "" : "s"}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="font-data text-[0.68rem] uppercase tracking-[0.16em] text-sage">
          Orders
        </h2>
        {day.orders.length === 0 ? (
          <p className="mt-3 rounded-card border hairline bg-forest/30 p-8 text-center text-sage">
            Nothing rung up yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-white/5 rounded-card border hairline bg-forest/40 px-4">
            {day.orders.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm text-paper">
                    {o.tableLabel ? `Table ${o.tableLabel}` : o.type.replace("_", " ")}
                  </p>
                  <p className="font-data mt-0.5 text-[0.6rem] uppercase tracking-[0.14em] text-sage">
                    {o.ref} · {o.items} item{o.items === 1 ? "" : "s"} ·{" "}
                    {o.status === "paid"
                      ? o.chargedToRoom
                        ? "to room"
                        : (o.method ?? "settled")
                      : o.status === "void"
                        ? "void"
                        : "open"}
                  </p>
                </div>
                <span className="shrink-0 font-display text-sm font-bold text-paper">
                  {formatPaise(o.totalPaise)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!day.closed && <CloseDayButton date={day.date} openOrders={day.summary.open} />}
    </div>
  );
}
