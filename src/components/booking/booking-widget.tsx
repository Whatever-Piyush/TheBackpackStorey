"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowLeft, Check, MessageCircle } from "lucide-react";
import { AvailabilityCalendar } from "@/components/booking/availability-calendar";
import { formatPaise } from "@/lib/money";
import { nights as nightsBetween } from "@/lib/dates";
import type { NightAvailability } from "@/lib/booking/availability";

/**
 * Booking widget (ROADMAP M3 item 3).
 *
 * Room type first, because availability is per type and a calendar is
 * meaningless without one. Unavailable nights cannot be picked at all rather
 * than being rejected after the fact, and the quote is the sum of the actual
 * nightly rates — the same rows the folio will bill from.
 *
 * Beds and occupancy are separate ideas: a dorm sells beds, a private room
 * sells the room. The old single "Guests" spinner conflated them.
 */

export type BookableType = {
  code: string;
  name: string;
  isDorm: boolean;
  /** Most units one booking may take — the direct allotment caps this anyway. */
  maxUnits: number;
  nights: NightAvailability[];
};

type Step = "dates" | "details" | "done";

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
  const [done, setDone] = useState<{
    ref: string;
    totalPaise: number;
    whatsapp: string;
    emailed: boolean;
  } | null>(null);

  /**
   * Stable across retries so a double-click, or a re-submit after the
   * connection drops, is the SAME booking to the server. Regenerated only once
   * a booking has actually been made.
   */
  const [idempotencyKey, setIdempotencyKey] = useState<string>(() =>
    crypto.randomUUID(),
  );

  const type = types.find((t) => t.code === typeCode) ?? types[0];

  const byDate = useMemo(
    () => new Map((type?.nights ?? []).map((n) => [n.date, n])),
    [type],
  );

  /** Nightly breakdown for the chosen range, straight from the rate calendar. */
  const quote = useMemo(() => {
    if (!checkIn || !checkOut) return null;
    const count = nightsBetween(checkIn, checkOut);
    if (count < 1) return null;

    const lines: { date: string; pricePaise: number }[] = [];
    const cursor = new Date(`${checkIn}T00:00:00Z`);
    for (let i = 0; i < count; i += 1) {
      const iso = cursor.toISOString().slice(0, 10);
      const night = byDate.get(iso);
      // A gap or a full night means we can't price this stay — refuse to guess.
      if (!night || night.pricePaise === null || night.free < units) return null;
      lines.push({ date: iso, pricePaise: night.pricePaise });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    const perUnit = lines.reduce((s, l) => s + l.pricePaise, 0);
    return { lines, nights: count, perUnit, total: perUnit * units };
  }, [checkIn, checkOut, byDate, units]);

  function pick(date: string) {
    setError(null);
    // First click sets arrival; the next sets departure, unless it's earlier.
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

  if (step === "done" && done) {
    return (
      <div className="rounded-card border hairline bg-forest/40 p-6 text-center sm:p-10">
        <Check size={28} className="mx-auto text-amber" aria-hidden />
        <h2 className="mt-4 font-display text-2xl font-extrabold text-paper">
          You&apos;re booked
        </h2>
        <p className="font-data mt-2 text-sm uppercase tracking-[0.16em] text-amber">
          {done.ref}
        </p>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-sage">
          {formatPaise(done.totalPaise)} to pay when you arrive. Keep that
          reference — it&apos;s how we find your booking.
        </p>
        {done.emailed && (
          <p className="mt-2 text-xs text-sage/70">A copy is on its way to your email.</p>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <a
            href={done.whatsapp}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-pine transition-colors hover:bg-amber/90"
          >
            <MessageCircle size={16} aria-hidden />
            Confirm on WhatsApp
          </a>
          <Link
            href={`/booking/${done.ref}`}
            className="rounded-full border hairline px-5 py-2.5 text-sm text-paper transition-colors hover:border-amber hover:text-amber"
          >
            View booking
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Always visible: the room is never hidden just because dates are full. */}
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
              {!checkIn
                ? "Pick your arrival"
                : !checkOut
                  ? "Pick your departure"
                  : "Your dates"}
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
              <p className="mt-3 text-xs text-sage/70">
                Pay when you arrive. No card needed now.
              </p>
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
            const data = new FormData(e.currentTarget);
            start(async () => {
              let result: {
                ok: boolean;
                error?: string;
                code?: string;
                availability?: { nights: NightAvailability[] };
                ref?: string;
                totalPaise?: number;
                whatsapp?: string;
                emailed?: boolean;
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
                    name: String(data.get("name") ?? ""),
                    phone: String(data.get("phone") ?? ""),
                    email: String(data.get("email") ?? ""),
                    notes: String(data.get("notes") ?? ""),
                  }),
                });
                result = await response.json();
              } catch {
                // Never a stack trace: the booking may or may not have landed,
                // and the idempotency key makes retrying safe either way.
                setError(
                  "We couldn't reach the server. Check your connection and press Book again — it won't book you twice.",
                );
                return;
              }

              if (!result.ok) {
                setError(result.error ?? "Something went wrong.");
                if (result.code === "UNITS_TAKEN") {
                  setTaken(result.availability?.nights ?? []);
                  setStep("dates");
                }
                return;
              }
              setDone({
                ref: result.ref!,
                totalPaise: result.totalPaise ?? 0,
                whatsapp: result.whatsapp!,
                emailed: result.emailed ?? false,
              });
              // Rotate only once a booking actually landed, so every retry of
              // THIS booking reuses the key and can never double-book.
              setIdempotencyKey(crypto.randomUUID());
              setStep("done");
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
            {units === 1 ? "" : "s"} · {checkIn} → {checkOut} ·{" "}
            <span className="text-paper">{formatPaise(quote.total)}</span>
          </p>

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

          {error && <p className="text-sm text-amber">{error}</p>}

          <button
            type="submit"
            disabled={pending}
            className="w-full rounded-full bg-amber px-5 py-3 text-sm font-medium text-pine transition-colors hover:bg-amber/90 disabled:opacity-50"
          >
            {pending ? "Booking…" : `Book · ${formatPaise(quote.total)}`}
          </button>
        </form>
      )}
    </div>
  );
}
