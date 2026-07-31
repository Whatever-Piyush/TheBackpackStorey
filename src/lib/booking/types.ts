/** Client-safe booking types (kept out of the "use server" actions file). */

export type BookingResult =
  | { ok: true; ref: string; total: number; whatsapp: string }
  | { ok: false; error: string };
