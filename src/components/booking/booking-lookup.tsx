"use client";

import { useActionState } from "react";
import { Search } from "lucide-react";
import { lookupBooking, type LookupResult } from "@/lib/booking/lookup";
import { formatPaise } from "@/lib/money";

const field =
  "w-full rounded-xl border hairline bg-pine px-3.5 py-2.5 text-paper outline-none focus:border-amber";
const labelCls = "font-data text-xs uppercase tracking-[0.16em] text-sage";

const STATUS_LABEL: Record<string, string> = {
  hold: "Held",
  confirmed: "Confirmed",
  checked_in: "You're checked in",
  checked_out: "Stay complete",
  cancelled: "Cancelled",
  no_show: "Not arrived",
};

export function BookingLookup({ code }: { code: string }) {
  const [state, action, pending] = useActionState<LookupResult | null, FormData>(
    lookupBooking,
    null,
  );

  if (state?.ok) {
    const b = state.booking;
    return (
      <div className="rounded-card border hairline bg-forest/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="font-data text-[0.65rem] uppercase tracking-[0.18em] text-amber">
              {b.code}
            </p>
            <h2 className="mt-1 font-display text-2xl font-extrabold text-paper">
              {b.guestName}
            </h2>
          </div>
          <span className="font-data rounded-full border hairline px-3 py-1 text-[0.6rem] uppercase tracking-[0.14em] text-sage">
            {STATUS_LABEL[b.status] ?? b.status}
          </span>
        </div>

        <dl className="mt-5 space-y-2 border-t hairline pt-4 text-sm">
          <Row label="Arrive" value={b.checkin} />
          <Row label="Leave" value={b.checkout} />
          <Row
            label="Nights"
            value={`${b.nights} · ${b.units} unit${b.units === 1 ? "" : "s"}`}
          />
          <Row label="Room" value={b.rooms.join(", ") || "—"} />
          <Row
            label="Guests"
            value={`${b.adults} adult${b.adults === 1 ? "" : "s"}${
              b.children ? `, ${b.children} children` : ""
            }`}
          />
        </dl>

        <div className="mt-4 flex items-baseline justify-between gap-3 border-t hairline pt-4">
          <span className={labelCls}>To pay on arrival</span>
          <span className="font-display text-xl font-extrabold text-amber">
            {state.balance}
          </span>
        </div>
        {b.paidPaise > 0 && (
          <p className="mt-1 text-right text-xs text-sage">
            {formatPaise(b.paidPaise)} already received
          </p>
        )}
      </div>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <div>
        <label className={labelCls} htmlFor="code">
          Reference
        </label>
        <input id="code" name="code" defaultValue={code} required className={`mt-1.5 ${field}`} />
      </div>
      <div>
        <label className={labelCls} htmlFor="phone">
          Phone you booked with
        </label>
        <input
          id="phone"
          name="phone"
          type="tel"
          required
          placeholder="+91 …"
          className={`mt-1.5 ${field}`}
        />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="flex w-full items-center justify-center gap-2 rounded-full bg-amber px-5 py-3 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-50"
      >
        <Search size={16} aria-hidden />
        {pending ? "Looking…" : "Find my booking"}
      </button>
      {state && !state.ok && <p className="text-sm text-amber">{state.error}</p>}
    </form>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className={labelCls}>{label}</dt>
      <dd className="text-right text-paper">{value}</dd>
    </div>
  );
}
