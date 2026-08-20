"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, Check } from "lucide-react";
import { AvailabilityCalendar } from "@/components/booking/availability-calendar";
import { formatPaise } from "@/lib/money";
import { nights as nightsBetween } from "@/lib/dates";
import type { NightAvailability } from "@/lib/booking/availability";

/**
 * Booking widget (Phase 9).
 *
 * A website booking is a 15-minute HOLD confirmed by a 20% Razorpay deposit. The
 * server computes the deposit and creates the order; the browser only opens Razorpay
 * Checkout and shows progress. The Checkout callback is UX only — the reservation is
 * confirmed by the verified webhook, never by the browser, so this widget never says
 * "Booked" on a callback; it says "confirming".
 */

export type BookableType = {
  code: string;
  name: string;
  isDorm: boolean;
  maxUnits: number;
  nights: NightAvailability[];
};

type Step = "dates" | "details" | "done";

/** Display-only estimate; the server is authoritative for the charged amount. */
const DEPOSIT_PCT = 0.2;

type RazorpayResponse = { razorpay_payment_id: string; razorpay_order_id: string };
type RazorpayOptions = {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  handler: (r: RazorpayResponse) => void;
  prefill?: { name?: string; contact?: string; email?: string };
  theme?: { color?: string };
  modal?: { ondismiss?: () => void };
};
declare global {
  interface Window {
    Razorpay?: new (o: RazorpayOptions) => { open: () => void };
  }
}

function loadRazorpay(): Promise<boolean> {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

const field =
  "w-full rounded-xl border hairline bg-pine px-3.5 py-2.5 text-paper outline-none focus:border-amber";
const labelCls = "font-data text-xs uppercase tracking-[0.16em] text-sage";

export function BookingWidget({
  types,
  initialType,
}: {
  types: BookableType[];
  initialType?: string;
}) {
  const [pending, start] = useTransition();
  const [step, setStep] = useState<Step>("dates");
  const [typeCode, setTypeCode] = useState(initialType ?? types[0]?.code ?? "");
  const [checkIn, setCheckIn] = useState<string | null>(null);
  const [checkOut, setCheckOut] = useState<string | null>(null);
  const [units, setUnits] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<NightAvailability[] | null>(null);
  const [accepted, setAccepted] = useState(false);
  // Set only after a payment callback — the reservation is still being confirmed
  // server-side by the webhook, so this is deliberately NOT a "booked" state.
  const [outcome, setOutcome] = useState<{ ref: string } | null>(null);

  const [idempotencyKey, setIdempotencyKey] = useState<string>(() => crypto.randomUUID());

  const type = types.find((t) => t.code === typeCode) ?? types[0];

  const byDate = useMemo(
    () => new Map((type?.nights ?? []).map((n) => [n.date, n])),
    [type],
  );

  const quote = useMemo(() => {
    if (!checkIn || !checkOut) return null;
    const count = nightsBetween(checkIn, checkOut);
    if (count < 1) return null;
    const lines: { date: string; pricePaise: number }[] = [];
    const cursor = new Date(`${checkIn}T00:00:00Z`);
    for (let i = 0; i < count; i += 1) {
      const iso = cursor.toISOString().slice(0, 10);
      const night = byDate.get(iso);
      if (!night || night.pricePaise === null || night.free < units) return null;
      lines.push({ date: iso, pricePaise: night.pricePaise });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const perUnit = lines.reduce((s, l) => s + l.pricePaise, 0);
    const total = perUnit * units;
    const deposit = Math.round(total * DEPOSIT_PCT);
    return { lines, nights: count, perUnit, total, deposit, remaining: total - deposit };
  }, [checkIn, checkOut, byDate, units]);

  function pick(date: string) {
    setError(null);
    if (!checkIn || checkOut || date <= checkIn) {
      setCheckIn(date);
      setCheckOut(null);
      return;
    }
    setCheckOut(date);
  }

  function changeType(code: string) {
    setTypeCode(code);
    setCheckIn(null);
    setCheckOut(null);
    setUnits(1);
    setError(null);
  }

  if (types.length === 0) {
    return (
      <p className="rounded-card border hairline bg-forest/30 p-8 text-center text-sage">
        Online booking is briefly unavailable — call or WhatsApp us and we&apos;ll
        sort it out.
      </p>
    );
  }

  if (step === "done" && outcome) {
    return (
      <div className="rounded-card border hairline bg-forest/40 p-6 text-center sm:p-10">
        <Check size={28} className="mx-auto text-amber" aria-hidden />
        <h2 className="mt-4 font-display text-2xl font-extrabold text-paper">
          Payment received
        </h2>
        <p className="font-data mt-2 text-sm uppercase tracking-[0.16em] text-amber">
          {outcome.ref}
        </p>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-sage">
          We&apos;re confirming your booking now — this takes a moment. Keep that
          reference, and check its status any time.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <Link
            href={`/booking/${outcome.ref}`}
            className="rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90"
          >
            View booking status
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <p className={labelCls}>Room</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {types.map((t) => (
            <button
              key={t.code}
              type="button"
              onClick={() => changeType(t.code)}
              className={`rounded-xl border px-4 py-2.5 text-sm transition-colors ${
                t.code === typeCode
                  ? "border-amber bg-amber text-pine"
                  : "hairline text-paper hover:border-amber hover:text-amber"
              }`}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>

      {step === "dates" && type && (
        <>
          <div>
            <p className={labelCls}>{type.isDorm ? "How many beds" : "How many rooms"}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {Array.from({ length: Math.max(1, type.maxUnits) }).map((_, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setUnits(i + 1);
                    setError(null);
                  }}
                  className={`h-11 w-11 rounded-xl border text-sm transition-colors ${
                    units === i + 1
                      ? "border-amber bg-amber text-pine"
                      : "hairline text-paper hover:border-amber hover:text-amber"
                  }`}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs text-sage/70">
              {type.isDorm
                ? "One bed per person in the shared dorm."
                : "Nights with fewer rooms free are greyed out."}
            </p>
          </div>

          <div>
            <p className={labelCls}>
              {!checkIn ? "Pick your arrival" : !checkOut ? "Pick your departure" : "Your dates"}
            </p>
            <div className="mt-2 max-w-md">
              <AvailabilityCalendar
                nights={type.nights}
                unitNoun={type.isDorm ? "bed" : "room"}
                selectable
                minFree={units}
                checkIn={checkIn}
                checkOut={checkOut}
                onPick={pick}
              />
            </div>
          </div>

          {quote && (
            <div className="rounded-card border hairline bg-forest/40 p-4">
              <div className="flex items-baseline justify-between gap-3">
                <p className={labelCls}>
                  {quote.nights} night{quote.nights === 1 ? "" : "s"} · {units}{" "}
                  {type.isDorm ? "bed" : "room"}
                  {units === 1 ? "" : "s"}
                </p>
                <p className="font-display text-xl font-extrabold text-amber">
                  {formatPaise(quote.total)}
                </p>
              </div>
              <ul className="mt-3 space-y-1 border-t hairline pt-3">
                {quote.lines.map((l) => (
                  <li key={l.date} className="flex justify-between text-sm text-sage">
                    <span>
                      {new Date(`${l.date}T00:00:00Z`).toLocaleDateString("en-IN", {
                        weekday: "short",
                        day: "numeric",
                        month: "short",
                        timeZone: "UTC",
                      })}
                    </span>
                    <span className="tabular-nums">
                      {formatPaise(l.pricePaise)}
                      {units > 1 && <span className="text-sage/60"> × {units}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div className="rounded-card border border-amber/40 bg-amber/5 p-4">
              <p className="text-sm text-amber">{error}</p>
              {taken && (
                <p className="mt-2 text-xs text-sage">
                  {taken.filter((n) => n.bookable).length > 0
                    ? "The calendar above is up to date — the green nights are still open."
                    : "Nothing is free for those exact dates. Try shifting them by a night."}
                </p>
              )}
            </div>
          )}

          <button
            type="button"
            disabled={!quote}
            onClick={() => setStep("details")}
            className="w-full rounded-full bg-amber px-5 py-3 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {quote ? "Continue" : checkIn ? "Pick a departure date" : "Pick your dates"}
          </button>
        </>
      )}

      {step === "details" && type && quote && (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            setTaken(null);
            if (!accepted) {
              setError("Please accept the cancellation policy to continue.");
              return;
            }
            const data = new FormData(e.currentTarget);
            const name = String(data.get("name") ?? "");
            const phone = String(data.get("phone") ?? "");
            const email = String(data.get("email") ?? "");
            start(async () => {
              let result: {
                ok: boolean;
                error?: string;
                code?: string;
                availability?: { nights: NightAvailability[] };
                ref?: string;
                currency?: string;
                razorpay?: { keyId: string; orderId: string; amountPaise: number };
              };
              try {
                const response = await fetch("/api/book", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    idempotencyKey,
                    roomTypeCode: type.code,
                    checkIn,
                    checkOut,
                    units,
                    name,
                    phone,
                    email,
                    notes: String(data.get("notes") ?? ""),
                    acceptedPolicy: true,
                  }),
                });
                result = await response.json();
              } catch {
                setError(
                  "We couldn't reach the server. Check your connection and press Pay again — it won't book you twice.",
                );
                return;
              }

              if (!result.ok || !result.razorpay) {
                setError(result.error ?? "Something went wrong.");
                if (result.code === "UNITS_TAKEN") {
                  setTaken(result.availability?.nights ?? []);
                  setStep("dates");
                }
                return;
              }

              const loaded = await loadRazorpay();
              if (!loaded || !window.Razorpay) {
                setError("We couldn't open the payment window. Please try again.");
                return;
              }
              const rzp = result.razorpay;
              const checkout = new window.Razorpay({
                key: rzp.keyId,
                order_id: rzp.orderId,
                amount: rzp.amountPaise,
                currency: result.currency ?? "INR",
                name: "Backpackers Storey",
                description: `Deposit · booking ${result.ref}`,
                prefill: { name, contact: phone, email: email || undefined },
                theme: { color: "#eaa53f" },
                // UX ONLY. The webhook confirms the booking; this just moves the UI on.
                handler: () => {
                  setOutcome({ ref: result.ref! });
                  setIdempotencyKey(crypto.randomUUID());
                  setStep("done");
                },
                modal: {
                  ondismiss: () =>
                    setError(
                      "Payment cancelled — your hold is open for a few more minutes if you'd like to try again.",
                    ),
                },
              });
              checkout.open();
            });
          }}
        >
          <button
            type="button"
            onClick={() => setStep("dates")}
            className="inline-flex items-center gap-1.5 text-sm text-sage hover:text-paper"
          >
            <ArrowLeft size={15} aria-hidden /> Change dates
          </button>

          <p className="text-sm text-sage">
            {type.name} · {units} {type.isDorm ? "bed" : "room"}
            {units === 1 ? "" : "s"} · {checkIn} → {checkOut}
          </p>

          {/* What's paid now vs at the property. */}
          <div className="rounded-card border hairline bg-forest/40 p-4 text-sm">
            <div className="flex justify-between text-sage">
              <span>Total for your stay</span>
              <span className="tabular-nums text-paper">{formatPaise(quote.total)}</span>
            </div>
            <div className="mt-2 flex justify-between font-medium text-paper">
              <span>Pay now (deposit, 20%)</span>
              <span className="tabular-nums text-amber">{formatPaise(quote.deposit)}</span>
            </div>
            <div className="mt-2 flex justify-between text-sage">
              <span>Pay at the property (cash / UPI)</span>
              <span className="tabular-nums">{formatPaise(quote.remaining)}</span>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelCls} htmlFor="name">
                Your name
              </label>
              <input id="name" name="name" required className={`mt-1.5 ${field}`} />
            </div>
            <div>
              <label className={labelCls} htmlFor="phone">
                Phone
              </label>
              <input id="phone" name="phone" type="tel" required className={`mt-1.5 ${field}`} />
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="email">
              Email (optional)
            </label>
            <input id="email" name="email" type="email" className={`mt-1.5 ${field}`} />
          </div>
          <div>
            <label className={labelCls} htmlFor="notes">
              Anything we should know?
            </label>
            <textarea id="notes" name="notes" rows={2} className={`mt-1.5 ${field}`} />
          </div>

          <label className="flex items-start gap-2.5 text-sm text-sage">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(e) => setAccepted(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-amber"
            />
            <span>
              I&apos;ve read and accept the{" "}
              <Link href="/policies/cancellation" target="_blank" className="text-amber underline">
                cancellation policy
              </Link>
              , and understand the 20% deposit is charged now.
            </span>
          </label>

          {error && <p className="text-sm text-amber">{error}</p>}

          <button
            type="submit"
            disabled={pending || !accepted}
            className="w-full rounded-full bg-amber px-5 py-3 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Starting payment…" : `Pay deposit · ${formatPaise(quote.deposit)}`}
          </button>
        </form>
      )}
    </div>
  );
}
