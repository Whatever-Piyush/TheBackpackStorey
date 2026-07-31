"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatPaise } from "@/lib/money";
import type { NightAvailability } from "@/lib/booking/availability";

/**
 * Month calendar for a room page (ROADMAP M3 item 2).
 *
 * The room is always visible; only the dates change. Available nights are
 * green and priced, full nights grey, closed nights struck through. Twelve
 * months are fetched once on the server, so paging never waits on a request —
 * the café is on hill internet and so are the guests.
 */

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

function monthKey(iso: string) {
  return iso.slice(0, 7);
}

function monthLabel(key: string) {
  return new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Monday-first offset for the 1st of a month. */
function leadingBlanks(key: string) {
  const first = new Date(`${key}-01T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return (first + 6) % 7;
}

export function AvailabilityCalendar({
  nights,
  unitNoun,
  selectable = false,
  minFree = 1,
  checkIn,
  checkOut,
  onPick,
}: {
  nights: NightAvailability[];
  unitNoun: string;
  /** Booking page: dates become clickable and a range can be chosen. */
  selectable?: boolean;
  /** A night only counts as open if it has at least this many units free. */
  minFree?: number;
  checkIn?: string | null;
  checkOut?: string | null;
  onPick?: (date: string) => void;
}) {
  const byMonth = useMemo(() => {
    const map = new Map<string, NightAvailability[]>();
    for (const n of nights) {
      map.set(monthKey(n.date), [...(map.get(monthKey(n.date)) ?? []), n]);
    }
    return map;
  }, [nights]);

  const months = useMemo(() => [...byMonth.keys()].sort(), [byMonth]);
  const [index, setIndex] = useState(0);

  if (months.length === 0) {
    return (
      <p className="rounded-card border hairline bg-forest/30 p-6 text-center text-sm text-sage">
        Live availability isn&apos;t loading right now — call or message us and
        we&apos;ll check for you.
      </p>
    );
  }

  const key = months[Math.min(index, months.length - 1)];
  const days = byMonth.get(key) ?? [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const daysInMonth = new Date(
    Number(key.slice(0, 4)),
    Number(key.slice(5, 7)),
    0,
  ).getDate();

  return (
    <div className="rounded-card border hairline bg-forest/30 p-4">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setIndex((i) => Math.max(0, i - 1))}
          disabled={index === 0}
          className="rounded-lg border hairline p-2 text-sage transition-colors hover:border-amber hover:text-amber disabled:opacity-30"
          aria-label="Previous month"
        >
          <ChevronLeft size={15} aria-hidden />
        </button>
        <p className="font-display text-sm font-bold text-paper">{monthLabel(key)}</p>
        <button
          type="button"
          onClick={() => setIndex((i) => Math.min(months.length - 1, i + 1))}
          disabled={index >= months.length - 1}
          className="rounded-lg border hairline p-2 text-sage transition-colors hover:border-amber hover:text-amber disabled:opacity-30"
          aria-label="Next month"
        >
          <ChevronRight size={15} aria-hidden />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-7 gap-1">
        {WEEKDAYS.map((d, i) => (
          <span
            key={i}
            className="font-data pb-1 text-center text-[0.55rem] uppercase tracking-[0.1em] text-sage/70"
          >
            {d}
          </span>
        ))}

        {Array.from({ length: leadingBlanks(key) }).map((_, i) => (
          <span key={`blank-${i}`} aria-hidden />
        ))}

        {Array.from({ length: daysInMonth }).map((_, i) => {
          const date = `${key}-${String(i + 1).padStart(2, "0")}`;
          const night = byDate.get(date);
          const dayNum = i + 1;

          // Outside the fetched window: nothing to claim either way.
          if (!night) {
            return (
              <span
                key={date}
                className="flex h-9 items-center justify-center rounded-lg text-xs text-sage/25"
              >
                {dayNum}
              </span>
            );
          }

          const closed = night.pricePaise === null;
          // On the booking page a night is only open if it can take the whole
          // party, so a 3-bed request greys out nights with 2 beds left.
          const full = !closed && (!night.bookable || night.free < minFree);
          const open = !closed && !full;

          const isStart = checkIn === date;
          const isEnd = checkOut === date;
          // Checkout day is not a night, so the range highlight stops before it.
          const inRange =
            !!checkIn && !!checkOut && date > checkIn && date < checkOut;

          if (selectable) {
            return (
              <button
                key={date}
                type="button"
                disabled={!open}
                onClick={() => onPick?.(date)}
                aria-pressed={isStart || isEnd}
                title={
                  closed
                    ? "Not open for booking"
                    : full
                      ? `Not enough ${unitNoun}s free`
                      : `${formatPaise(night.pricePaise!)} · ${night.free} left`
                }
                className={`flex h-9 items-center justify-center rounded-lg text-xs transition-colors ${
                  isStart || isEnd
                    ? "bg-amber font-bold text-pine"
                    : inRange
                      ? "bg-amber/25 text-paper"
                      : closed
                        ? "cursor-not-allowed text-sage/30 line-through"
                        : full
                          ? "cursor-not-allowed bg-forest/60 text-sage/40"
                          : "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/30"
                }`}
              >
                {dayNum}
              </button>
            );
          }

          return (
            <span
              key={date}
              title={
                closed
                  ? "Not open for booking"
                  : full
                    ? "Fully booked"
                    : `${formatPaise(night.pricePaise!)} · ${night.free} ${unitNoun}${
                        night.free === 1 ? "" : "s"
                      } left`
              }
              className={`flex h-9 cursor-default items-center justify-center rounded-lg text-xs transition-colors ${
                closed
                  ? "text-sage/30 line-through"
                  : full
                    ? "bg-forest/60 text-sage/50"
                    : "bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
              }`}
            >
              {dayNum}
            </span>
          );
        })}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 border-t hairline pt-3 text-[0.65rem] text-sage">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-emerald-500/20" aria-hidden /> Available
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-3 rounded bg-forest/60" aria-hidden /> Full
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="line-through opacity-50" aria-hidden>
            00
          </span>{" "}
          Closed
        </span>
        <span className="ml-auto">Hover a date for the nightly price.</span>
      </div>
    </div>
  );
}
