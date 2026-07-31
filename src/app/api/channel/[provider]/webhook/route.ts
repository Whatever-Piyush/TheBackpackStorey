import { getProvider } from "@/lib/channel/registry";
import {
  ingestCancellation,
  ingestModification,
  ingestReservation,
} from "@/lib/channel/ingest";
import { ChannelPayloadError } from "@/lib/channel/types";

/**
 * Inbound from a Channel Manager.
 *
 * The route knows no vendor: it looks the provider up by id, asks it to verify
 * the signature, asks it to translate the payload, and hands the result to the
 * ingest layer. Swapping vendors changes nothing in this file.
 */
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider: providerId } = await params;
  const provider = getProvider(providerId);
  if (!provider) {
    return Response.json({ ok: false, error: "Unknown provider." }, { status: 404 });
  }

  const rawBody = await request.text();
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  // Verify BEFORE parsing: an unsigned payload is not worth reading.
  if (!provider.verify({ headers, rawBody })) {
    return Response.json({ ok: false, error: "Bad signature." }, { status: 401 });
  }

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
        ? await ingestCancellation(providerId, provider.receiveCancellation(payload))
        : kind === "modification"
          ? await ingestModification(providerId, provider.receiveModification(payload))
          : await ingestReservation(providerId, provider.receiveReservation(payload));

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
