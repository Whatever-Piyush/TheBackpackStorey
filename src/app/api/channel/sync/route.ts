import { drainOutbox } from "@/lib/channel/outbox";

/**
 * Drains the channel outbox. Invoked by a cron, and nudged after a booking.
 *
 * Guarded by a shared secret rather than a user session: it is called by
 * machines. If CHANNEL_SYNC_SECRET is unset the route refuses outright — an
 * unauthenticated endpoint that talks to a Channel Manager is not something to
 * leave open by default.
 */
export const dynamic = "force-dynamic";

function authorised(request: Request): boolean {
  const secret = process.env.CHANNEL_SYNC_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    return Response.json({ ok: false, error: "Unauthorised." }, { status: 401 });
  }
  try {
    const summary = await drainOutbox();
    return Response.json(
      { ok: true, ...summary },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "Sync failed." },
      { status: 500 },
    );
  }
}
