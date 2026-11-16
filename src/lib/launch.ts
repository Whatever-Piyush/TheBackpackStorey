/**
 * Launch switch for the portfolio release (2026-11). Client-safe: a plain
 * constant, importable from client components (the header CTA).
 *
 * BOOKING_PAUSED — the public booking engine (/book, /booking/[code], the
 * availability calendar on room pages, POST /api/book and the booking-lookup
 * action) is paused for the portfolio launch. Every booking CTA becomes a
 * WhatsApp enquiry instead. Flip this to `false` to restore the original flow
 * unchanged — the host then needs the Supabase env vars again. Nothing was
 * deleted; see docs/Netlify_deploy.md.
 *
 * It is a code constant rather than an env var on purpose: it has to be readable
 * in client components, and it must not be re-enabled by a stray dashboard
 * variable.
 *
 * The staff-portal switch is server-only and lives in `launch-server.ts`.
 */
export const BOOKING_PAUSED: boolean = true;
