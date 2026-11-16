/**
 * Server-only launch switch. Never import this from a client component: it
 * reads process.env and belongs in the server bundle only (the client-safe
 * BOOKING_PAUSED constant is in `launch.ts`).
 *
 * STAFF_PORTAL_ENABLED — /login, /pos, /stays, /reception, the Form C export and
 * /api/channel/* exist only where this env var is "true" (local development:
 * set it in .env.local). It is unset on the public Netlify deployment, so the
 * proxy answers those paths with 404 before any page code runs, the layouts and
 * route handlers repeat the check, and the proxy never touches Supabase.
 */
export const STAFF_PORTAL_ENABLED = process.env.STAFF_PORTAL_ENABLED === "true";
