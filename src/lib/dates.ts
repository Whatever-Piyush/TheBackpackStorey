/**
 * Date helpers. Stay dates are plain `YYYY-MM-DD` strings (Postgres `date`),
 * never `Date` objects with a time component — a hotel night has no timezone.
 */

/**
 * Parse a YYYY-MM-DD as UTC midnight.
 *
 * `new Date("2026-07-31T00:00:00")` (no Z) is parsed in the SERVER'S timezone.
 * Add a day east of UTC and `toISOString()` hands back the same date, because
 * midnight local is still the previous day in UTC. Every date here is a calendar
 * date with no time component, so UTC is the only safe anchor.
 */
function utcDay(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}

/** Add (or subtract) whole days to a YYYY-MM-DD date, timezone-proof. */
export function addDays(iso: string, days: number): string {
  const d = utcDay(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole nights between two YYYY-MM-DD dates (0 if invalid / non-positive). */
export function nights(checkIn: string, checkOut: string): number {
  const a = utcDay(checkIn);
  const b = utcDay(checkOut);
  const ms = b.getTime() - a.getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(ms / 86_400_000));
}

/** Today as YYYY-MM-DD, for "no bookings in the past" guards. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
