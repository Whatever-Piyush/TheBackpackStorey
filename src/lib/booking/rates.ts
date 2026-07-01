import type { RoomType } from "@/lib/site";

/**
 * Nightly rates in integer paise. Dorm is priced per bed; private rooms per room.
 * These are editable placeholders until rate management lands in the PMS —
 * change the numbers here and bookings pick them up immediately.
 */
export const RATES: Record<RoomType, number> = {
  dorm: 60000, //   ₹600  per bed / night
  deluxe: 180000, // ₹1,800 per room / night
  premium: 250000, //₹2,500 per room / night
  family: 320000, // ₹3,200 per room / night
};

/** Whole nights between two YYYY-MM-DD dates (0 if invalid / non-positive). */
export function nights(checkIn: string, checkOut: string): number {
  const a = new Date(`${checkIn}T00:00:00`);
  const b = new Date(`${checkOut}T00:00:00`);
  const ms = b.getTime() - a.getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.round(ms / 86_400_000));
}
