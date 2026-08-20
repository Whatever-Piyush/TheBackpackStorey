"use client";

import { useActionState, useState } from "react";
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

type CancelPreview = {
  refundable: boolean;
  refundPaise: number;
  forfeitPaise: number;
  cutoffAt: string | null;
  policyText: string | null;
  cancellable: boolean;
};
type CancelState = {
  step: "idle" | "preview" | "done";
  busy: boolean;
  preview?: CancelPreview;
  result?: { refundable: boolean; refundPaise: number; forfeitPaise: number };
  error?: string;
};

export function BookingLookup({ code }: { code: string }) {
  const [state, action, pending] = useActionState<LookupResult | null, FormData>(lookupBooking, null);
  const [phone, setPhone] = useState("");
  const [cxl, setCxl] = useState<CancelState>({ step: "idle", busy: false });

  async function cancelRequest(doCancel: boolean) {
    setCxl((c) => ({ ...c, busy: true, error: undefined }));
    try {
      const res = await fetch(`/api/booking/${encodeURIComponent(bookingCode)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, action: doCancel ? "cancel" : undefined }),
      });
      const data = await res.json();
      if (!data.ok) {
        setCxl((c) => ({ ...c, busy: false, error: data.error ?? "Something went wrong." }));
        return;
      }
      if (doCancel) setCxl({ step: "done", busy: false, result: data });
      else setCxl({ step: "preview", busy: false, preview: data.preview });
    } catch {
      setCxl((c) => ({ ...c, busy: false, error: "We couldn't reach the server. Please try again." }));
    }
  }

  const bookingCode = state?.ok ? state.booking.code : code;

  if (state?.ok) {
    const b = state.booking;
    const canCancel = b.status === "confirmed" || b.status === "hold";
    return (
      <div className="rounded-card border hairline bg-forest/40 p-5 sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="font-data text-[0.65rem] uppercase tracking-[0.18em] text-amber">{b.code}</p>
            <h2 className="mt-1 font-display text-2xl font-extrabold text-paper">{b.guestName}</h2>
          </div>
          <span className="font-data rounded-full border hairline px-3 py-1 text-[0.6rem] uppercase tracking-[0.14em] text-sage">
            {STATUS_LABEL[b.status] ?? b.status}
          </span>
        </div>

        <dl className="mt-5 space-y-2 border-t hairline pt-4 text-sm">
          <Row label="Arrive" value={b.checkin} />
          <Row label="Leave" value={b.checkout} />
          <Row label="Nights" value={`${b.nights} · ${b.units} unit${b.units === 1 ? "" : "s"}`} />
          <Row label="Room" value={b.rooms.join(", ") || "—"} />
          <Row
            label="Guests"
            value={`${b.adults} adult${b.adults === 1 ? "" : "s"}${b.children ? `, ${b.children} children` : ""}`}
          />
        </dl>

        <div className="mt-4 flex items-baseline justify-between gap-3 border-t hairline pt-4">
          <span className={labelCls}>To pay on arrival</span>
          <span className="font-display text-xl font-extrabold text-amber">{state.balance}</span>
        </div>
        {b.paidPaise > 0 && (
          <p className="mt-1 text-right text-xs text-sage">{formatPaise(b.paidPaise)} already received</p>
        )}

        {/* Cancellation — the server decides refundability and amounts. */}
        {canCancel && cxl.step === "done" && cxl.result && (
          <div className="mt-5 rounded-xl border hairline bg-pine/40 p-4 text-sm">
            <p className="font-medium text-paper">Booking cancelled.</p>
            <p className="mt-1 text-sage">
              {cxl.result.refundable
                ? `We're refunding your ${formatPaise(cxl.result.refundPaise)} deposit — it can take a few working days to reach you.`
                : `As this was after the cancellation deadline, the ${formatPaise(cxl.result.forfeitPaise)} deposit is retained.`}
            </p>
          </div>
        )}

        {canCancel && cxl.step !== "done" && (
          <div className="mt-5 border-t hairline pt-4">
            {cxl.step === "idle" && (
              <button
                type="button"
                onClick={() => cancelRequest(false)}
                disabled={cxl.busy}
                className="text-sm text-sage underline underline-offset-4 hover:text-amber disabled:opacity-50"
              >
                {cxl.busy ? "Checking…" : "Cancel this booking"}
              </button>
            )}
            {cxl.step === "preview" && cxl.preview && (
              <div className="rounded-xl border border-amber/40 bg-amber/5 p-4 text-sm">
                <p className="text-paper">
                  {cxl.preview.refundable
                    ? `You're within the free-cancellation window — your ${formatPaise(cxl.preview.refundPaise)} deposit will be refunded.`
                    : `The cancellation deadline has passed, so the ${formatPaise(cxl.preview.forfeitPaise)} deposit would be forfeited.`}
                </p>
                <p className="mt-1 text-xs text-sage">
                  See the full <a href="/policies/cancellation" target="_blank" className="text-amber underline">cancellation policy</a>.
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => cancelRequest(true)}
                    disabled={cxl.busy}
                    className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-pine hover:bg-amber/90 disabled:opacity-50"
                  >
                    {cxl.busy ? "Cancelling…" : "Confirm cancellation"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCxl({ step: "idle", busy: false })}
                    className="rounded-full border hairline px-4 py-2 text-sm text-paper hover:border-amber hover:text-amber"
                  >
                    Keep my booking
                  </button>
                </div>
              </div>
            )}
            {cxl.error && <p className="mt-2 text-sm text-amber">{cxl.error}</p>}
          </div>
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
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
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
