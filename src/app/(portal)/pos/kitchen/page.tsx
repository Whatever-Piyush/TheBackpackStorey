import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { requireRole } from "@/lib/auth";
import { getTickets } from "@/lib/pos/kitchen";
import { advanceItem } from "@/lib/pos/settlement";
import { KitchenLive } from "@/components/pos/kitchen-live";
import {
  ITEM_STATUS_LABEL,
  STATIONS,
  nextItemStatus,
  type Ticket,
  type TicketItem,
} from "@/lib/pos/types";

export const metadata: Metadata = {
  title: "Kitchen",
  robots: { index: false, follow: false },
};

// Tickets change constantly; never serve a cached board.
export const dynamic = "force-dynamic";

/** Deliberately no prices anywhere on this screen — the kitchen doesn't bill. */
function ItemRow({ item }: { item: TicketItem }) {
  const next = nextItemStatus(item.status);
  const done = item.status === "ready";

  return (
    <li>
      <form action={advanceItem}>
        <input type="hidden" name="item_id" value={item.id} />
        <input type="hidden" name="current" value={item.status} />
        <button
          type="submit"
          disabled={done}
          className={`flex w-full items-center justify-between gap-3 rounded-xl border px-4 py-4 text-left transition-colors ${
            done
              ? "cursor-default border-transparent bg-forest/30 opacity-60"
              : item.status === "preparing"
                ? "border-amber/60 bg-amber/10 hover:border-amber"
                : "hairline bg-forest/60 hover:border-amber"
          }`}
        >
          <span className="min-w-0">
            <span className="flex items-baseline gap-2">
              <span className="font-display text-lg font-bold text-paper">{item.qty}×</span>
              <span className="truncate text-base text-paper">{item.name}</span>
            </span>
            {item.notes && (
              <span className="mt-1 block text-sm italic text-amber">{item.notes}</span>
            )}
          </span>

          <span className="font-data shrink-0 text-[0.62rem] uppercase tracking-[0.14em]">
            {done ? (
              <span className="inline-flex items-center gap-1 text-emerald-400">
                <Check size={14} aria-hidden /> {ITEM_STATUS_LABEL.ready}
              </span>
            ) : (
              <span className="text-sage">
                {ITEM_STATUS_LABEL[item.status]} →{" "}
                <span className="text-amber">{ITEM_STATUS_LABEL[next!]}</span>
              </span>
            )}
          </span>
        </button>
      </form>
    </li>
  );
}

function TicketCard({ ticket }: { ticket: Ticket }) {
  // Group by the station already stored on each menu item.
  const groups = STATIONS.map((s) => ({
    ...s,
    items: ticket.items.filter((i) => i.station === s.value),
  })).filter((g) => g.items.length > 0);

  const allReady = ticket.items.every((i) => i.status === "ready");

  return (
    <article
      className={`rounded-card border p-4 ${
        allReady ? "border-emerald-500/40 bg-emerald-500/5" : "hairline bg-forest/40"
      }`}
    >
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold text-paper">{ticket.where}</h2>
          <p className="font-data mt-0.5 text-[0.62rem] uppercase tracking-[0.14em] text-sage">
            {ticket.ref} ·{" "}
            {new Date(ticket.createdAt).toLocaleTimeString("en-IN", {
              timeZone: "Asia/Kolkata",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}
          </p>
        </div>
        {allReady && (
          <span className="font-data text-[0.62rem] uppercase tracking-[0.14em] text-emerald-400">
            Ready
          </span>
        )}
      </header>

      <div className="mt-3 space-y-3">
        {groups.map((g) => (
          <div key={g.value}>
            <p className="font-data text-[0.6rem] uppercase tracking-[0.18em] text-amber">
              {g.label}
            </p>
            <ul className="mt-1.5 space-y-2">
              {g.items.map((i) => (
                <ItemRow key={i.id} item={i} />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </article>
  );
}

export default async function KitchenPage() {
  await requireRole(["owner", "manager", "reception", "kitchen"]);

  let tickets: Ticket[];
  try {
    tickets = await getTickets();
  } catch {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <p className="rounded-card border hairline bg-forest/40 p-6 text-center text-sage">
          Couldn&apos;t load the kitchen board.{" "}
          <Link href="/pos/kitchen" className="text-amber hover:underline">
            Try again
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <div className="flex items-center justify-between gap-3">
        <Link
          href="/pos"
          className="inline-flex items-center gap-1.5 text-sm text-sage hover:text-paper"
        >
          <ArrowLeft size={16} aria-hidden /> Counter
        </Link>
        <KitchenLive />
      </div>

      <h1 className="mt-4 font-display text-2xl font-extrabold tracking-tight text-paper sm:text-3xl">
        Kitchen
      </h1>
      <p className="mt-1.5 text-sm text-sage">
        Tap an item to move it on. A ticket turns green when everything is ready.
      </p>

      {tickets.length === 0 ? (
        <p className="mt-8 rounded-card border hairline bg-forest/30 p-10 text-center text-sage">
          No tickets right now.
        </p>
      ) : (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {tickets.map((t) => (
            <TicketCard key={t.id} ticket={t} />
          ))}
        </div>
      )}
    </div>
  );
}
