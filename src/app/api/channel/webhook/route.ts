import { getActiveDistribution } from "@/lib/channel/registry";
import {
  ingestCancellation,
  ingestModification,
  ingestReservation,
} from "@/lib/channel/ingest";
import { ChannelPayloadError } from "@/lib/channel/types";
import { STAFF_PORTAL_ENABLED } from "@/lib/launch-server";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Inbound from a Channel Manager.
 *
 * The route knows no vendor: it asks the CONFIGURED provider to verify the
 * signature, asks it to translate the payload, and hands the result to the
 * ingest layer. Swapping vendors changes nothing in this file.
 *
 * It replaces /api/channel/[provider]/webhook, which took the provider from the
 * URL. That let anyone choose which implementation handled their request — so a
 * request to /api/channel/mock/webhook was served by the mock provider whether or
 * not the mock was configured, and the mock accepted unsigned requests. The
 * provider is now server configuration, and the URL is just an address.
 *
 * After the guard fix in 0033, the signature check below is the only thing
 * between the public internet and injected reservations. Everything here fails
 * closed.
 */
export const dynamic = "force-dynamic";

/** A reservation payload is a few hundred bytes. This is room to spare. */
const MAX_BODY_BYTES = 64 * 1024;

const RATE_LIMIT = 120;
const RATE_WINDOW_SECONDS = 60;

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: Request) {
  // ---- 0. PMS machine endpoint: absent on the public portfolio deployment ----
  if (!STAFF_PORTAL_ENABLED) return new Response(null, { status: 404 });

  // ---- 1. is anyone expecting webhooks at all? ------------------------------
  //
  // In manual mode staff type OTA bookings in by hand and no Channel Manager is
  // connected, so there is no legitimate inbound request to accept.
  const { mode, provider } = await getActiveDistribution();
  if (mode !== "channel_manager") {
    return Response.json(
      { ok: false, error: "Not accepting channel webhooks." },
      { status: 404 },
    );
  }

  // ---- 2. size cap, before reading the body into memory ---------------------
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: "Payload too large." }, { status: 413 });
  }

  const rawBody = await request.text();
  // Content-Length is a claim, not a fact. Check what actually arrived too.
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: "Payload too large." }, { status: 413 });
  }

  // ---- 3. rate limit --------------------------------------------------------
  //
  // Generous: a Channel Manager pushing a busy morning's changes is normal, and
  // throttling a real vendor loses bookings. This is here to stop a flood, not
  // to shape legitimate traffic.
  const db = createAdminClient();
  const { data: allowed } = await db.rpc("check_rate_limit", {
    p_bucket: `channel-webhook:${clientIp(request)}`,
    p_limit: RATE_LIMIT,
    p_window_seconds: RATE_WINDOW_SECONDS,
  });
  if (allowed === false) {
    return Response.json({ ok: false, error: "Too many requests." }, { status: 429 });
  }

  // ---- 4. signature ---------------------------------------------------------
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Verify BEFORE parsing: an unsigned payload is not worth reading. A provider
  // with no secret configured returns false here, so an unconfigured deployment
  // rejects everything rather than accepting everything.
  if (!provider.verify({ headers, rawBody, receivedAt: Date.now() })) {
    return Response.json({ ok: false, error: "Bad signature." }, { status: 401 });
  }

  // ---- 5. translate and apply ----------------------------------------------
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return Response.json({ ok: false, error: "Malformed JSON." }, { status: 400 });
  }

  const kind = new URL(request.url).searchParams.get("kind") ?? "reservation";

  try {
    const outcome =
      kind === "cancellation"
        ? await ingestCancellation(provider.id, provider.receiveCancellation(payload))
        : kind === "modification"
          ? await ingestModification(provider.id, provider.receiveModification(payload))
          : await ingestReservation(provider.id, provider.receiveReservation(payload));

    // A duplicate is a success from the sender's point of view — otherwise the
    // Channel Manager retries forever.
    const status =
      outcome.status === "failed" ? 422 : outcome.status === "duplicate" ? 200 : 201;
    return Response.json({ ok: outcome.status !== "failed", ...outcome }, { status });
  } catch (err) {
    if (err instanceof ChannelPayloadError) {
      return Response.json({ ok: false, error: err.message }, { status: 400 });
    }
    return Response.json({ ok: false, error: "Could not process." }, { status: 500 });
  }
}
