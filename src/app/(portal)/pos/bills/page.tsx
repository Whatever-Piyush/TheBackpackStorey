import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { getCheckedInGuests, getOpenOrders } from "@/lib/pos/kitchen";
import { BillActions } from "@/components/pos/bill-actions";
import type { CheckedInGuest, OpenOrder } from "@/lib/pos/types";

export const metadata: Metadata = {
  title: "Bills",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  open: "Not sent",
  sent: "In the kitchen",
  served: "Ready to collect",
};

export default async function BillsPage() {
  await requireRole(["owner", "manager", "reception"]);

  let orders: OpenOrder[];
  let guests: CheckedInGuest[];
  try {
    [orders, guests] = await Promise.all([getOpenOrders(), getCheckedInGuests()]);
  } catch {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <p className="rounded-card border hairline bg-forest/40 p-6 text-center text-sage">
          Couldn&apos;t load open bills.{" "}
          <Link href="/pos/bills" className="text-amber hover:underline">
            Try again
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <Link
        href="/pos"
        className="inline-flex items-center gap-1.5 text-sm text-sage hover:text-paper"
      >
        <ArrowLeft size={16} aria-hidden /> Counter
      </Link>

      <h1 className="mt-4 font-display text-2xl font-extrabold tracking-tight text-paper sm:text-3xl">
        Open bills
      </h1>
      <p className="mt-1.5 text-sm text-sage">
        Take payment at the counter, or put it on an in-house guest&apos;s folio to
        settle at checkout.
      </p>

      {orders.length === 0 ? (
        <p className="mt-8 rounded-card border hairline bg-forest/30 p-10 text-center text-sage">
          Nothing outstanding.
        </p>
      ) : (
        <div className="mt-6 space-y-3">
          {orders.map((o) => (
            <article key={o.id} className="rounded-card border hairline bg-forest/40 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <h2 className="font-display text-lg font-bold text-paper">{o.where}</h2>
                <span className="font-data text-[0.62rem] uppercase tracking-[0.14em] text-sage">
                  {STATUS_LABEL[o.status] ?? o.status}
                </span>
              </div>
              <p className="font-data mt-0.5 text-[0.62rem] uppercase tracking-[0.14em] text-sage">
                {o.ref} · {o.itemCount} item{o.itemCount === 1 ? "" : "s"} ·{" "}
                {new Date(o.createdAt).toLocaleTimeString("en-IN", {
                  timeZone: "Asia/Kolkata",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </p>

              <BillActions order={o} guests={guests} />
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
