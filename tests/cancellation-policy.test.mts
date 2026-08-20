/**
 * Cancellation policy + deposit configuration (Phase 9, Phase 2).
 *
 * Logic tests, run as `postgres` (the harness convention for anything that is about
 * behaviour rather than access control): deterministic policy resolution across the
 * two independent date dimensions, the server-side IST cutoff, snapshot immutability,
 * the deposit math, and the no-GST / integer-paise invariants.
 *
 * Fixtures use versions in the 9000+ range and clean themselves up, so they never
 * collide with the seeded standard policy (version 1), whose effective_from is set
 * far in the past and therefore always loses a "latest effective_from" tiebreak to a
 * real dated fixture.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

let db: Client;
let channelCode: string;

type PolicyFixture = {
  version: number;
  effFrom: string;
  effTo?: string | null;
  stayFrom?: string | null;
  stayTo?: string | null;
  cutoff?: number;
  refund?: number;
  body?: string;
};

async function addPolicy(p: PolicyFixture): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into cancellation_policies
       (version, effective_from, effective_to, stay_from, stay_to, cutoff_hours, refund_percent, body_text)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [
      p.version, p.effFrom, p.effTo ?? null, p.stayFrom ?? null, p.stayTo ?? null,
      p.cutoff ?? 24, p.refund ?? 100, p.body ?? `fixture v${p.version}`,
    ],
  );
  return rows[0].id;
}
async function delPolicies(versions: number[]): Promise<void> {
  await db.query(`delete from cancellation_policies where version = any($1)`, [versions]);
}
async function resolve(bookedAt: string, checkin: string) {
  const { rows } = await db.query<{ version: number; body_text: string }>(
    `select version, body_text from resolve_cancellation_policy($1,$2)`,
    [bookedAt, checkin],
  );
  return rows[0] ?? null;
}
async function bool(sql: string, params: unknown[] = []): Promise<boolean> {
  const { rows } = await db.query<{ ok: boolean }>(sql, params);
  return rows[0].ok;
}
/** Insert a bare reservation carrying a snapshot; returns its id. Marked for cleanup. */
async function addReservation(fields: Record<string, unknown>): Promise<string> {
  const cols = ["source", "checkin", "checkout", "notes", ...Object.keys(fields)];
  const vals = [channelCode, "2026-12-12", "2026-12-14", "PHASE2_TEST", ...Object.values(fields)];
  const ph = vals.map((_, i) => `$${i + 1}`).join(",");
  const { rows } = await db.query<{ id: string }>(
    `insert into reservations (${cols.join(",")}) values (${ph}) returning id`,
    vals,
  );
  return rows[0].id;
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '10s'");
  const { rows } = await db.query<{ code: string }>(
    `select code from channels where active order by code limit 1`,
  );
  assert.ok(rows[0]?.code, "test needs at least one active channel for the source FK");
  channelCode = rows[0].code;
  // Safety net: clear any fixtures a crashed run left behind.
  await db.query(`delete from reservations where notes = 'PHASE2_TEST'`);
  await delPolicies([9003, 9007, 9008, 9010, 9011, 9012, 9013, 9100]);
  await db.query(`delete from deposit_config where version = 9100`);
});

after(async () => {
  await db.query(`delete from reservations where notes = 'PHASE2_TEST'`);
  await delPolicies([9003, 9007, 9008, 9010, 9011, 9012, 9013, 9100]);
  await db.query(`delete from deposit_config where version = 9100`);
  await db.end();
});

describe("policy resolution", () => {
  it("1. the standard seeded policy resolves for a normal booking", async () => {
    const p = await resolve("2026-09-15T10:00:00+05:30", "2026-10-12");
    assert.equal(p?.version, 1, "a normal booking must resolve the standard policy (v1)");
  });

  it("2. a September booking for a December arrival keeps the September-era version and the December rule", async () => {
    await addPolicy({ version: 9003, effFrom: "2026-06-01", stayFrom: "2026-12-01", stayTo: "2026-12-31", body: "DEC-EARLY" });
    await addPolicy({ version: 9007, effFrom: "2026-10-01", stayFrom: "2026-12-01", stayTo: "2026-12-31", body: "DEC-LATE" });
    try {
      const p = await resolve("2026-09-15T10:00:00+05:30", "2026-12-12");
      // The December-specific rule, but the version live in September (9003), NOT the
      // one that only became effective in October (9007).
      assert.equal(p?.version, 9003, "must resolve the December rule effective in September");
      assert.equal(p?.body_text, "DEC-EARLY");
    } finally {
      await delPolicies([9003, 9007]);
    }
  });

  it("8. a specific stay window wins over a general policy", async () => {
    await addPolicy({ version: 9008, effFrom: "2026-06-01", stayFrom: "2026-12-01", stayTo: "2026-12-31", body: "DECEMBER" });
    try {
      const p = await resolve("2026-08-01T00:00:00+05:30", "2026-12-12");
      assert.equal(p?.version, 9008, "the December-specific policy must beat the general v1");
    } finally {
      await delPolicies([9008]);
    }
  });

  it("9. the specific window wins deterministically (stable across calls, never the general)", async () => {
    await addPolicy({ version: 9008, effFrom: "2026-06-01", stayFrom: "2026-12-01", stayTo: "2026-12-31", body: "DECEMBER" });
    try {
      const a = await resolve("2026-08-01T00:00:00+05:30", "2026-12-12");
      const b = await resolve("2026-08-01T00:00:00+05:30", "2026-12-12");
      assert.equal(a?.version, b?.version, "resolution must not depend on row order");
      assert.equal(a?.version, 9008);
      assert.notEqual(a?.version, 1);
    } finally {
      await delPolicies([9008]);
    }
  });

  it("10. latest effective_from wins when specificity is equal", async () => {
    await addPolicy({ version: 9010, effFrom: "2026-06-01", body: "OLDER" });
    await addPolicy({ version: 9011, effFrom: "2026-07-01", body: "NEWER" });
    try {
      const p = await resolve("2026-08-01T00:00:00+05:30", "2026-10-12");
      assert.equal(p?.version, 9011, "the later effective_from must win among equally-general policies");
    } finally {
      await delPolicies([9010, 9011]);
    }
  });

  it("11. latest version is the final deterministic tiebreak", async () => {
    await addPolicy({ version: 9012, effFrom: "2026-06-01", body: "TIE-A" });
    await addPolicy({ version: 9013, effFrom: "2026-06-01", body: "TIE-B" });
    try {
      const p = await resolve("2026-08-01T00:00:00+05:30", "2026-10-12");
      assert.equal(p?.version, 9013, "with equal specificity and effective_from, the newest version wins");
    } finally {
      await delPolicies([9012, 9013]);
    }
  });
});

describe("cutoff — 14:00 IST, server-side", () => {
  it("5. lands at 14:00 IST the day before arrival for the standard 24h rule", async () => {
    assert.ok(
      await bool(`select cancellation_cutoff('2026-10-12', 24) = timestamptz '2026-10-11 14:00:00+05:30' as ok`),
      "12 Oct arrival → 11 Oct 14:00 IST",
    );
  });
  it("6. crosses a month boundary correctly", async () => {
    assert.ok(
      await bool(`select cancellation_cutoff('2026-11-01', 24) = timestamptz '2026-10-31 14:00:00+05:30' as ok`),
      "1 Nov arrival → 31 Oct 14:00 IST",
    );
  });
  it("7. crosses a year boundary correctly", async () => {
    assert.ok(
      await bool(`select cancellation_cutoff('2027-01-01', 24) = timestamptz '2026-12-31 14:00:00+05:30' as ok`),
      "1 Jan 2027 arrival → 31 Dec 2026 14:00 IST",
    );
  });
});

describe("snapshots are historical, not live", () => {
  it("3. editing the live policy does not move an existing reservation's snapshot", async () => {
    const policyId = await addPolicy({ version: 9100, effFrom: "2026-01-01", body: "ORIGINAL" });
    const cutoff = "2026-12-11T14:00:00+05:30";
    const resId = await addReservation({
      policy_version_id: policyId,
      policy_text_snapshot: "ORIGINAL SNAPSHOT",
      deposit_percent_snapshot: 20,
      deposit_amount_paise: 12345,
      cancellation_cutoff_at: cutoff,
    });
    try {
      await db.query(`update cancellation_policies set body_text='CHANGED', cutoff_hours=48 where id=$1`, [policyId]);
      const { rows } = await db.query(
        `select policy_text_snapshot, deposit_percent_snapshot, deposit_amount_paise,
                cancellation_cutoff_at = timestamptz '2026-12-11 14:00:00+05:30' as cutoff_ok
           from reservations where id=$1`,
        [resId],
      );
      assert.equal(rows[0].policy_text_snapshot, "ORIGINAL SNAPSHOT");
      assert.equal(Number(rows[0].deposit_percent_snapshot), 20);
      assert.equal(rows[0].deposit_amount_paise, 12345);
      assert.equal(rows[0].cutoff_ok, true, "the stored cutoff must not move when the policy is edited");
    } finally {
      await db.query(`delete from reservations where id=$1`, [resId]);
      await delPolicies([9100]);
    }
  });

  it("4. changing deposit_config does not move an existing reservation's deposit snapshot", async () => {
    const resId = await addReservation({ deposit_percent_snapshot: 20, deposit_amount_paise: 12345 });
    await db.query(`insert into deposit_config (version, percent, min_amount_paise) values (9100, 20, null)`);
    try {
      await db.query(`update deposit_config set percent=50, min_amount_paise=500000 where version=9100`);
      const { rows } = await db.query(
        `select deposit_percent_snapshot, deposit_amount_paise from reservations where id=$1`,
        [resId],
      );
      assert.equal(Number(rows[0].deposit_percent_snapshot), 20);
      assert.equal(rows[0].deposit_amount_paise, 12345);
    } finally {
      await db.query(`delete from reservations where id=$1`, [resId]);
      await db.query(`delete from deposit_config where version=9100`);
    }
  });
});

describe("deposit math + invariants", () => {
  it("12. no minimum is applied while min_amount_paise is NULL; a set minimum floors it", async () => {
    const { rows } = await db.query<{ no_min: number; with_min: number; seed_min: number | null }>(
      `select compute_deposit_paise(10000, 20, null) as no_min,
              compute_deposit_paise(10000, 20, 5000) as with_min,
              (select min_amount_paise from deposit_config where version=1) as seed_min`,
    );
    assert.equal(rows[0].no_min, 2000, "20% of 10000 paise, no floor");
    assert.equal(rows[0].with_min, 5000, "a configured minimum floors the deposit");
    assert.equal(rows[0].seed_min, null, "the seeded config has no minimum");
  });

  it("13. monetary values are integer paise (amounts integer; percentages are rates)", async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(
      `select table_name, column_name, data_type
         from information_schema.columns
        where table_schema='public'
          and (table_name='deposit_config' and column_name='min_amount_paise'
            or table_name='reservations'   and column_name='deposit_amount_paise')`,
    );
    for (const r of rows) {
      assert.equal(r.data_type, "integer", `${r.table_name}.${r.column_name} must be integer paise`);
    }
    assert.ok(
      await bool(`select pg_typeof(compute_deposit_paise(10000,20,null))::text = 'integer' as ok`),
      "compute_deposit_paise returns integer",
    );
  });

  it("14. no GST/tax is introduced (no such columns, no such wording, folio tax_rate untouched)", async () => {
    const { rows: taxCols } = await db.query<{ n: string }>(
      `select count(*) as n from information_schema.columns
        where table_schema='public'
          and table_name in ('deposit_config','cancellation_policies')
          and (column_name ilike '%tax%' or column_name ilike '%gst%')`,
    );
    assert.equal(taxCols[0].n, "0", "policy/config tables must carry no tax/gst columns");
    assert.ok(
      await bool(`select body_text !~* '(gst|\\mtax\\M)' as ok from cancellation_policies where version=1`),
      "the published policy wording must not mention GST/tax",
    );
    assert.ok(
      await bool(`select column_default = '0' as ok
                    from information_schema.columns
                   where table_schema='public' and table_name='folio_items' and column_name='tax_rate'`),
      "folio_items.tax_rate must remain, defaulting to 0",
    );
  });
});
