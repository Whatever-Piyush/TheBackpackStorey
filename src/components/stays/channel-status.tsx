"use client";

import { useActionState } from "react";
import { AlertTriangle, Check, Inbox, RefreshCw, Radio } from "lucide-react";
import {
  acknowledgeSync,
  resolveInbound,
  type ChannelActionResult,
  type ChannelStatus,
} from "@/lib/channel/status";

/**
 * Sync status with retry visibility.
 *
 * In manual distribution the "queue" is a to-do list: the numbers changed, go
 * type them into each extranet, tick it off. In channel-manager mode the same
 * screen shows what failed to push, how many times it has been tried, and when
 * it will be tried again — so a silent outage is impossible to miss.
 */

const KIND_LABEL: Record<string, string> = {
  availability: "Availability",
  rates: "Rates",
  reservation_created: "New reservation",
  reservation_modified: "Reservation changed",
  reservation_cancelled: "Reservation cancelled",
};

function when(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function ChannelStatusView({ status }: { status: ChannelStatus }) {
  const manual = status.distributionMode === "manual";

  return (
    <div className="space-y-5">
      <div
        className={`rounded-card border p-4 ${
          manual ? "border-amber/50 bg-amber/5" : "hairline bg-forest/40"
        }`}
      >
        <p className="flex items-center gap-2 font-display text-sm font-bold text-paper">
          <Radio size={16} className={manual ? "text-amber" : "text-emerald-400"} aria-hidden />
          {manual
            ? "Distribution is manual — staff update the extranets"
            : `Publishing through ${status.provider?.label ?? "a channel manager"}`}
        </p>
        <p className="mt-1.5 text-sm text-sage">
          {manual
            ? "Inventory is recalculated automatically. Every change below still has to be typed into Booking.com, MMT, Goibibo, Agoda, Hostelworld and Airbnb by hand."
            : "Inventory is recalculated and published automatically. Nothing needs typing into an extranet."}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Waiting" value={status.queue.pending} />
        <Stat label={manual ? "To type in" : "Needs a look"} value={status.queue.awaitingAck} warn />
        <Stat label="Failed" value={status.queue.failed} warn={status.queue.failed > 0} />
        <Stat label="Sent today" value={status.queue.sentToday} />
      </div>

      {status.lastSent && Object.keys(status.lastSent).length > 0 && (
        <div className="rounded-card border hairline bg-forest/30 p-4">
          <p className="font-data text-[0.6rem] uppercase tracking-[0.14em] text-sage">
            Last published
          </p>
          <ul className="mt-2 grid gap-1 sm:grid-cols-2">
            {Object.entries(status.lastSent).map(([kind, at]) => (
              <li key={kind} className="flex justify-between gap-3 text-sm">
                <span className="text-sage">{KIND_LABEL[kind] ?? kind}</span>
                <span className="text-paper">{when(at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <section>
        <h2 className="font-data text-[0.65rem] uppercase tracking-[0.16em] text-sage">
          {manual ? "To update in the extranets" : "Needs attention"}
        </h2>
        {status.attention.length === 0 ? (
          <p className="mt-3 rounded-card border hairline bg-forest/30 p-8 text-center text-sm text-sage">
            Nothing outstanding — every change has been published.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {status.attention.map((a) => (
              <AttentionRow key={a.id} item={a} />
            ))}
          </ul>
        )}
      </section>

      {status.inboundFailures.length > 0 && (
        <section>
          <h2 className="flex items-center gap-2 font-data text-[0.65rem] uppercase tracking-[0.16em] text-amber">
            <Inbox size={13} aria-hidden />
            Arrived but could not be booked
          </h2>
          <p className="mt-1.5 text-xs text-sage">
            Usually an overbooking: the channel sold something we no longer had.
            Nothing is ever dropped — decide what to do, then clear it.
          </p>
          <ul className="mt-3 space-y-2">
            {status.inboundFailures.map((f) => (
              <InboundRow key={f.id} item={f} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="rounded-card border hairline bg-forest/40 p-4">
      <p className="font-data text-[0.6rem] uppercase tracking-[0.14em] text-sage">{label}</p>
      <p
        className={`mt-1.5 font-display text-2xl font-extrabold ${
          warn && value > 0 ? "text-amber" : "text-paper"
        }`}
      >
        {value}
      </p>
    </div>
  );
}

function AttentionRow({ item }: { item: ChannelStatus["attention"][number] }) {
  const [state, action, pending] = useActionState<ChannelActionResult | null, FormData>(
    acknowledgeSync,
    null,
  );

  return (
    <li className="rounded-card border hairline bg-forest/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-paper">
            {KIND_LABEL[item.kind] ?? item.kind}
            {item.roomType && <span className="text-sage"> · {item.roomType}</span>}
          </p>
          <p className="font-data mt-1 text-[0.62rem] uppercase tracking-[0.14em] text-sage">
            {item.from && item.to ? `${item.from} → ${item.to} · ` : ""}
            {when(item.createdAt)}
          </p>
          {item.status === "failed" && (
            <p className="mt-2 text-xs text-amber">
              {item.lastError ?? "Push failed."} · {item.attempts} attempt
              {item.attempts === 1 ? "" : "s"} · next try {when(item.nextAttemptAt)}
            </p>
          )}
        </div>

        {item.requiresAck && (
          <form action={action} className="shrink-0">
            <input type="hidden" name="id" value={item.id} />
            <button
              type="submit"
              disabled={pending}
              className="inline-flex items-center gap-1.5 rounded-xl border hairline px-3 py-2 text-xs text-paper transition-colors hover:border-amber hover:text-amber disabled:opacity-50"
            >
              <Check size={13} aria-hidden />
              {pending ? "…" : "Updated"}
            </button>
          </form>
        )}
        {item.status === "failed" && !item.requiresAck && (
          <span className="font-data inline-flex shrink-0 items-center gap-1 rounded-full border border-amber/50 px-2 py-1 text-[0.55rem] uppercase tracking-[0.14em] text-amber">
            <RefreshCw size={10} aria-hidden /> retrying
          </span>
        )}
      </div>
      {state && !state.ok && <p className="mt-2 text-xs text-amber">{state.error}</p>}
    </li>
  );
}

function InboundRow({ item }: { item: ChannelStatus["inboundFailures"][number] }) {
  const [state, action, pending] = useActionState<ChannelActionResult | null, FormData>(
    resolveInbound,
    null,
  );

  return (
    <li className="rounded-card border border-amber/40 bg-amber/5 p-4">
      <p className="flex items-center gap-2 text-sm text-paper">
        <AlertTriangle size={14} className="text-amber" aria-hidden />
        {item.channel ?? item.providerId} · {item.kind}
      </p>
      <p className="mt-1 text-xs text-amber">{item.error}</p>
      <p className="font-data mt-1 text-[0.6rem] uppercase tracking-[0.14em] text-sage">
        {item.externalId} · {when(item.receivedAt)}
      </p>
      <form action={action} className="mt-3 flex gap-2">
        <input type="hidden" name="id" value={item.id} />
        <input
          name="resolution"
          required
          placeholder="What did you do about it?"
          className="min-w-0 flex-1 rounded-xl border hairline bg-pine px-3 py-2 text-sm text-paper outline-none focus:border-amber"
        />
        <button
          type="submit"
          disabled={pending}
          className="shrink-0 rounded-xl border hairline px-3 py-2 text-xs text-paper transition-colors hover:border-amber hover:text-amber disabled:opacity-50"
        >
          {pending ? "…" : "Clear"}
        </button>
      </form>
      {state && !state.ok && <p className="mt-2 text-xs text-amber">{state.error}</p>}
    </li>
  );
}
