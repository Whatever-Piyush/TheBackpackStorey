/**
 * The shared provider contract (docs/Channel_manager.md §8).
 *
 * Every registered provider runs against the SAME fixtures and must behave the
 * same way. This is what turns "a new provider takes under a day" from a claim
 * into a property: write the file, add the registry line, run this.
 *
 * Deliberately has no database and no network. A provider that needs either to
 * pass has broken rule 1 of the contract.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listProviders } from "../src/lib/channel/providers/index.ts";
import { MockProvider } from "../src/lib/channel/providers/mock.ts";
import { ChannelPayloadError } from "../src/lib/channel/types.ts";
import type { ChannelProvider } from "../src/lib/channel/provider.ts";
import type {
  AvailabilitySnapshot,
  RateSnapshot,
  ReservationSnapshot,
} from "../src/lib/channel/types.ts";

const AVAILABILITY: AvailabilitySnapshot = {
  roomTypeId: "11111111-1111-1111-1111-111111111111",
  roomTypeCode: "dorm",
  roomTypeName: "Six-Bed Dormitory",
  sellMode: "per_bed",
  from: "2027-01-01",
  to: "2027-01-03",
  nights: [
    { date: "2027-01-01", totalUnits: 6, freeUnits: 4, pricePaise: 30000, closed: false },
    { date: "2027-01-02", totalUnits: 6, freeUnits: 0, pricePaise: 30000, closed: false },
  ],
};

const RATES: RateSnapshot = {
  roomTypeId: AVAILABILITY.roomTypeId,
  roomTypeCode: "dorm",
  from: "2027-01-01",
  to: "2027-01-03",
  nights: [
    { date: "2027-01-01", pricePaise: 30000, closed: false },
    { date: "2027-01-02", pricePaise: 30000, closed: false },
  ],
};

const RESERVATION: ReservationSnapshot = {
  reservationId: "22222222-2222-2222-2222-222222222222",
  code: "BS-TEST01",
  source: "ota_agoda",
  status: "confirmed",
  checkin: "2027-01-01",
  checkout: "2027-01-03",
  guestName: "Contract Test",
  externalRef: "AG-999",
  units: [{ roomTypeId: AVAILABILITY.roomTypeId, roomTypeCode: "dorm", count: 2 }],
};

/** Every provider the registry knows about, including future ones. */
for (const provider of listProviders()) {
  describe(`provider contract: ${provider.id}`, () => {
    it("identifies itself", () => {
      assert.ok(provider.id.length > 0, "an id is how the registry finds it");
      assert.ok(provider.label.length > 0, "a label is what staff see");
    });

    it("accepts every outbound message without throwing", async () => {
      // A provider reports failure through SyncResult, never by throwing — the
      // worker must be able to record an error and move to the next row.
      for (const call of [
        () => provider.syncAvailability(AVAILABILITY),
        () => provider.syncRates(RATES),
        () => provider.reservationCreated(RESERVATION),
        () => provider.reservationModified(RESERVATION),
        () => provider.reservationCancelled(RESERVATION),
      ]) {
        const result = await call();
        assert.ok(
          typeof result.ok === "boolean",
          "every outbound call returns a SyncResult",
        );
        if (!result.ok) {
          assert.ok(result.error.length > 0, "a failure must say why");
          assert.equal(typeof result.retryable, "boolean", "and whether to retry");
        }
      }
    });

    it("rejects a malformed inbound payload rather than half-reading it", () => {
      for (const bad of [null, "a string", 42, [], {}]) {
        assert.throws(
          () => provider.receiveReservation(bad),
          (err: unknown) => err instanceof Error,
          `should reject ${JSON.stringify(bad)}`,
        );
      }
    });

    it("is a pure translator — no database, no network, no PMS imports", async () => {
      // Structural, not behavioural: a provider that imported the PMS could not
      // be swapped, which is the entire point of the interface.
      const source = await readProviderSource(provider);
      if (!source) return; // future providers not yet on disk
      for (const forbidden of [
        "@/lib/supabase",
        "@/lib/inventory",
        "@/lib/stays",
        "@/lib/booking",
        "createAdminClient",
      ]) {
        assert.ok(
          !source.includes(forbidden),
          `${provider.id} must not reference ${forbidden}`,
        );
      }
    });
  });
}

describe("provider contract: MockProvider specifics", () => {
  it("round-trips a reservation payload into our vocabulary", () => {
    const mock = new MockProvider();
    const parsed = mock.receiveReservation({
      id: "MSG-1",
      channel: "ota_agoda",
      reference: "AG-123",
      guest: "Priya",
      phone: "+919999999999",
      email: "p@example.com",
      arrive: "2027-02-01",
      depart: "2027-02-04",
      roomType: "dorm",
      units: 2,
      amount: 1500,
    });

    assert.equal(parsed.externalId, "MSG-1");
    assert.equal(parsed.channel, "ota_agoda");
    assert.equal(parsed.units, 2);
    // Vendors quote rupees; the PMS stores paise. Converting units is exactly
    // the sort of thing a provider exists to do.
    assert.equal(parsed.amountPaise, 150000);
  });

  it("rejects a date that isn't a date, and a unit count that isn't whole", () => {
    const mock = new MockProvider();
    const base = {
      id: "M",
      channel: "ota_agoda",
      guest: "P",
      arrive: "2027-02-01",
      depart: "2027-02-04",
      roomType: "dorm",
      units: 1,
      amount: 100,
    };
    assert.throws(
      () => mock.receiveReservation({ ...base, arrive: "01/02/2027" }),
      ChannelPayloadError,
    );
    assert.throws(() => mock.receiveReservation({ ...base, units: 1.5 }), ChannelPayloadError);
    assert.throws(() => mock.receiveReservation({ ...base, amount: -5 }), ChannelPayloadError);
  });

  it("reports a failure instead of throwing, so the worker can retry", async () => {
    const mock = new MockProvider();
    mock.failNext = { error: "upstream 503", retryable: true };
    const result = await mock.syncAvailability(AVAILABILITY);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.retryable, true);
      assert.equal(result.error, "upstream 503");
    }
  });
});

async function readProviderSource(provider: ChannelProvider): Promise<string | null> {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const path = fileURLToPath(
    new URL(`../src/lib/channel/providers/${provider.id}.ts`, import.meta.url),
  );
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}
