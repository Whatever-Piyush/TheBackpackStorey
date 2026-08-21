/**
 * Inbound webhook security (ROADMAP §4, review items 3 and 4).
 *
 * These two ship together and are tested together, because after the guard fix
 * the signature check is the ONLY thing between the public internet and injected
 * reservations. Previously the broken guard was holding that line by accident.
 *
 * Part 1 covers the provider's signature verification — pure, no database.
 * Part 2 covers the database guard, which must distinguish a machine caller from
 * a browser session no matter what the caller CLAIMS to be.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";
import { MockProvider } from "../src/lib/channel/providers/mock.ts";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

const SECRET = "test-secret-value";
const BODY = JSON.stringify({ id: "M1", channel: "ota_agoda" });

function sign(body: string, at: number, secret = SECRET) {
  return createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
}

function request(overrides: Record<string, unknown> = {}) {
  const at = Date.now();
  return {
    headers: {
      "x-mock-timestamp": String(at),
      "x-mock-signature": sign(BODY, at),
    },
    rawBody: BODY,
    receivedAt: at,
    ...overrides,
  };
}

describe("webhook signature verification", () => {
  const provider = new MockProvider();

  it("FAILS CLOSED when no secret is configured", () => {
    delete process.env.CHANNEL_MOCK_SECRET;
    assert.equal(
      provider.verify(request()),
      false,
      "an unconfigured provider must reject everything, not accept everything — " +
        "this is the defect, not the missing secret",
    );
  });

  it("accepts a correctly signed request", () => {
    process.env.CHANNEL_MOCK_SECRET = SECRET;
    assert.equal(provider.verify(request()), true);
  });

  it("rejects a wrong signature, and a signature from a different secret", () => {
    process.env.CHANNEL_MOCK_SECRET = SECRET;
    const at = Date.now();
    assert.equal(
      provider.verify({
        headers: { "x-mock-timestamp": String(at), "x-mock-signature": "deadbeef" },
        rawBody: BODY,
        receivedAt: at,
      }),
      false,
    );
    assert.equal(
      provider.verify({
        headers: {
          "x-mock-timestamp": String(at),
          "x-mock-signature": sign(BODY, at, "someone-elses-secret"),
        },
        rawBody: BODY,
        receivedAt: at,
      }),
      false,
    );
  });

  it("rejects a tampered body even when the signature is well-formed", () => {
    process.env.CHANNEL_MOCK_SECRET = SECRET;
    const at = Date.now();
    assert.equal(
      provider.verify({
        headers: { "x-mock-timestamp": String(at), "x-mock-signature": sign(BODY, at) },
        rawBody: JSON.stringify({ id: "M1", channel: "ota_agoda", units: 99 }),
        receivedAt: at,
      }),
      false,
    );
  });

  it("rejects a replayed request outside the window, in both directions", () => {
    process.env.CHANNEL_MOCK_SECRET = SECRET;
    const at = Date.now();
    const signed = { "x-mock-timestamp": String(at), "x-mock-signature": sign(BODY, at) };

    // Captured six minutes ago and replayed now.
    assert.equal(
      provider.verify({ headers: signed, rawBody: BODY, receivedAt: at + 6 * 60_000 }),
      false,
      "a stale request must not be accepted",
    );
    // Clock skew far into the future is equally suspect.
    assert.equal(
      provider.verify({ headers: signed, rawBody: BODY, receivedAt: at - 6 * 60_000 }),
      false,
    );
    // Well inside the window still works.
    assert.equal(
      provider.verify({ headers: signed, rawBody: BODY, receivedAt: at + 60_000 }),
      true,
    );
  });

  it("rejects a request with no timestamp or no signature", () => {
    process.env.CHANNEL_MOCK_SECRET = SECRET;
    const at = Date.now();
    const incomplete: Record<string, string>[] = [
      {},
      { "x-mock-timestamp": String(at) },
      { "x-mock-signature": sign(BODY, at) },
      { "x-mock-timestamp": "not-a-number", "x-mock-signature": sign(BODY, at) },
    ];
    for (const headers of incomplete) {
      assert.equal(provider.verify({ headers, rawBody: BODY, receivedAt: at }), false);
    }
  });

  it("does not register the mock provider in production", () => {
    // Evaluated at module load, so this needs a fresh process to mean anything.
    const script =
      "import('./src/lib/channel/providers/index.ts')" +
      ".then(m => console.log(Object.keys(m.PROVIDERS).join(',')))";
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, NODE_ENV: "production" },
      encoding: "utf8",
    }).trim();
    assert.equal(out, "manual", `production registry should be manual only, got "${out}"`);
  });
});

describe("webhook replay inside the signature window", () => {
  /**
   * A signature proves a request was genuine ONCE. Replaying a captured payload
   * inside the ±5 minute window presents a perfectly valid signature every time,
   * so the timestamp narrows the window but cannot close it. The database has to.
   */
  let db: Client;
  let roomTypeId: string;
  const GUEST_NAME = "Replay Fixture";
  const EXTERNAL_ID = "REPLAY-MSG-1";
  const BOOKING_REF = "REPLAY-BOOKING-1";

  before(async () => {
    db = new Client({ connectionString: CONNECTION });
    await db.connect();
    await db.query("set statement_timeout = '10s'");
    await db.query(`reset request.jwt.claim.sub`);
    const { rows } = await db.query<{ id: string }>(
      `select id from room_types where active order by sort_order limit 1`,
    );
    roomTypeId = rows[0].id;
  });

  after(async () => {
    await db.query(`delete from channel_inbox where external_id = $1`, [EXTERNAL_ID]);
    for (const sql of [
      `delete from payments where folio_id in (select f.id from folios f
         join reservations r on r.id = f.reservation_id
         join guests g on g.id = r.guest_id where g.name = $1)`,
      `delete from folio_items where folio_id in (select f.id from folios f
         join reservations r on r.id = f.reservation_id
         join guests g on g.id = r.guest_id where g.name = $1)`,
      `delete from folios where reservation_id in (select r.id from reservations r
         join guests g on g.id = r.guest_id where g.name = $1)`,
      `delete from allocations where reservation_id in (select r.id from reservations r
         join guests g on g.id = r.guest_id where g.name = $1)`,
      `delete from reservations where guest_id in (select id from guests where name = $1)`,
      `delete from guests where name = $1`,
    ]) {
      await db.query(sql, [GUEST_NAME]);
    }
    await db.end();
  });

  it("the same signature verifies repeatedly — which is exactly why the DB must dedup", () => {
    process.env.CHANNEL_MOCK_SECRET = SECRET;
    const provider = new MockProvider();
    const at = Date.now();
    const headers = {
      "x-mock-timestamp": String(at),
      "x-mock-signature": sign(BODY, at),
    };
    // Three deliveries, one captured signature, all inside the window.
    for (let i = 0; i < 3; i += 1) {
      assert.equal(
        provider.verify({ headers, rawBody: BODY, receivedAt: at + i * 1000 }),
        true,
        "a replayed request is cryptographically indistinguishable from the first",
      );
    }
  });

  it("three identical deliveries produce exactly ONE reservation", async () => {
    // The real inbound sequence: claim the message, then apply it.
    const deliver = async () => {
      const { rows: claim } = await db.query<{ c: { fresh: boolean } }>(
        `select claim_channel_inbound('mock', $1, 'reservation', 'ota_booking', '{}'::jsonb) as c`,
        [EXTERNAL_ID],
      );
      if (!claim[0].c.fresh) return { skipped: true as const };

      const { rows } = await db.query<{ r: { ok: boolean; code?: string } }>(
        `select create_channel_reservation('ota_booking', $1, null,
           current_date + 410, current_date + 412, $2::uuid, 1, $3, 0, 'webhook') as r`,
        [GUEST_NAME, roomTypeId, BOOKING_REF],
      );
      return { skipped: false as const, result: rows[0].r };
    };

    const first = await deliver();
    assert.equal(first.skipped, false, "the first delivery is genuine work");
    assert.equal(first.skipped === false && first.result.ok, true);

    const second = await deliver();
    const third = await deliver();
    assert.equal(second.skipped, true, "a replay is stopped at the inbox");
    assert.equal(third.skipped, true);

    const { rows: count } = await db.query<{ n: string }>(
      `select count(*) as n from reservations where external_ref = $1`,
      [BOOKING_REF],
    );
    assert.equal(count[0].n, "1", "three signed deliveries, one reservation");
  });

  it("a retry with a fresh envelope id still cannot create a second booking", async () => {
    // A Channel Manager that regenerates its message id on retry bypasses the
    // inbox dedup entirely, so the reservation-level constraint has to catch it.
    const { rows } = await db.query<{
      r: { ok: boolean; code?: string; reservationId?: string; reservationCode?: string };
    }>(
      `select create_channel_reservation('ota_booking', $1, null,
         current_date + 410, current_date + 412, $2::uuid, 1, $3, 0, 'webhook') as r`,
      [GUEST_NAME, roomTypeId, BOOKING_REF],
    );

    assert.equal(rows[0].r.ok, false);
    assert.equal(rows[0].r.code, "DUPLICATE_REFERENCE");
    // And it must say WHICH booking, or the sender cannot reconcile and retries forever.
    assert.ok(rows[0].r.reservationId, "the duplicate must name the existing reservation");
    assert.match(rows[0].r.reservationCode ?? "", /^BS-/);

    const { rows: count } = await db.query<{ n: string }>(
      `select count(*) as n from reservations where external_ref = $1`,
      [BOOKING_REF],
    );
    assert.equal(count[0].n, "1", "still exactly one");
  });
});

describe("create_channel_reservation authorization", () => {
  let db: Client;
  let roomTypeId: string;
  const OWNER = "55555555-5555-5555-5555-555555555555";
  const OUTSIDER = "deadbeef-0000-0000-0000-000000000000";
  const GUEST_NAME = "Webhook Guard Fixture";

  before(async () => {
    db = new Client({ connectionString: CONNECTION });
    await db.connect();
    await db.query("set statement_timeout = '10s'");

    await db.query(
      `insert into auth.users (id, email) values ($1,'owner@local'),($2,'outsider@local')
       on conflict (id) do nothing`,
      [OWNER, OUTSIDER],
    );
    await db.query(
      `insert into profiles (id, full_name, role) values ($1,'Guard Owner','owner')
       on conflict (id) do update set role = 'owner'`,
      [OWNER],
    );
    // The outsider must have NO profile row: a signed-in user who is not staff.
    await db.query(`delete from profiles where id = $1`, [OUTSIDER]);

    const { rows } = await db.query<{ id: string }>(
      `select id from room_types where active order by sort_order limit 1`,
    );
    roomTypeId = rows[0].id;
  });

  after(async () => {
    await db.query(`reset role`);
    // Own the fixtures fully: the guard's owner profile has no staff row, and a
    // leaked role-bearing profile trips grants-matrix's isolation invariant. Only
    // orders/housekeeping FK-reference profiles and neither is created here, so
    // deleting the profile before the business rows below is safe.
    await db.query(`delete from profiles where id = $1`, [OWNER]);
    for (const sql of [
      `delete from payments where folio_id in (select f.id from folios f
         join reservations r on r.id = f.reservation_id
         join guests g on g.id = r.guest_id where g.name = $1)`,
      `delete from folio_items where folio_id in (select f.id from folios f
         join reservations r on r.id = f.reservation_id
         join guests g on g.id = r.guest_id where g.name = $1)`,
      `delete from folios where reservation_id in (select r.id from reservations r
         join guests g on g.id = r.guest_id where g.name = $1)`,
      `delete from allocations where reservation_id in (select r.id from reservations r
         join guests g on g.id = r.guest_id where g.name = $1)`,
      `delete from reservations where guest_id in (select id from guests where name = $1)`,
      `delete from guests where name = $1`,
    ]) {
      await db.query(sql, [GUEST_NAME]);
    }
    await db.end();
  });

  /** Calls the function as a given role/session and returns the result or the error. */
  async function call(
    session: { role: string; sub: string | null },
    source: string,
    ref: string,
  ): Promise<{ ok: boolean; code?: string } | { error: string }> {
    if (session.sub) await db.query(`set request.jwt.claim.sub = '${session.sub}'`);
    else await db.query(`reset request.jwt.claim.sub`);
    await db.query(`set role ${session.role}`);
    try {
      const { rows } = await db.query(
        `select create_channel_reservation('ota_booking', $1, null,
           current_date + 300, current_date + 302, $2::uuid, 1, $3, 0, $4) as r`,
        [GUEST_NAME, roomTypeId, ref, source],
      );
      return rows[0].r;
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      await db.query(`reset role`);
    }
  }

  it("lets a machine caller with no user session apply a webhook reservation", async () => {
    const r = await call({ role: "service_role", sub: null }, "webhook", "GUARD-OK-1");
    assert.equal("ok" in r && r.ok, true, `service_role must succeed, got ${JSON.stringify(r)}`);
  });

  it("refuses a signed-in non-staff user, whatever source they claim", async () => {
    for (const source of ["webhook", "reception"]) {
      const r = await call({ role: "authenticated", sub: OUTSIDER }, source, `GUARD-NO-${source}`);
      assert.equal("error" in r, true, `source=${source} should be refused`);
      assert.match((r as { error: string }).error, /not permitted/);
    }
  });

  it("lets staff enter an OTA booking from the desk", async () => {
    const r = await call({ role: "authenticated", sub: OWNER }, "reception", "GUARD-OK-2");
    assert.equal("ok" in r && r.ok, true, `owner must succeed, got ${JSON.stringify(r)}`);
  });

  it("will not let even an owner claim to be a webhook", async () => {
    // The audit trail is only worth keeping if the source cannot be forged. This
    // is also the assertion that caught current_user being the function OWNER
    // inside a SECURITY DEFINER function rather than the caller.
    const r = await call({ role: "authenticated", sub: OWNER }, "webhook", "GUARD-NO-3");
    assert.equal("error" in r, true, "a browser session must never pass as a webhook");
  });

  it("rejects a source it does not recognise", async () => {
    const r = await call({ role: "authenticated", sub: OWNER }, "smuggled", "GUARD-NO-4");
    assert.equal("ok" in r && r.code, "BAD_SOURCE");
  });

  it("is not executable by anon at all", async () => {
    const { rows } = await db.query<{ ok: boolean }>(
      `select has_function_privilege('anon',
         'public.create_channel_reservation(text,text,text,date,date,uuid,integer,text,integer,text,uuid,text)',
         'EXECUTE') as ok`,
    );
    assert.equal(rows[0].ok, false);
  });
});
