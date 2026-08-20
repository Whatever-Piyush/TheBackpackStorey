/**
 * Execute grants cannot silently reopen (ROADMAP §4 item 3).
 *
 * The finding this guards against: migrations 0010–0012 revoked create_reservation
 * from PUBLIC, then 0028 created a NEW signature and the revokes — which name a
 * signature, not a name — did not apply to it. The function came back with the
 * default PUBLIC grant and nobody noticed for four migrations.
 *
 * Three assertions, because no single one of them is sufficient:
 *
 *   1. NULL proacl        — the default grant, invisible to aclexplode()
 *   2. explicit PUBLIC    — `GRANT ... TO PUBLIC` produces a non-NULL acl that
 *                           still lets anon in, so test 1 would pass and the
 *                           function would still be exposed
 *   3. anon allowlist     — anon EXECUTE is legitimate for the public booking
 *                           engine and nothing else
 *
 * Extension-owned functions (pgcrypto, btree_gist) are excluded throughout: their
 * grants belong to the extension, not to us, and there are hundreds of them.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

/**
 * The only functions the public booking engine may reach with the anon key.
 * ROADMAP M3 §1: they return counts and prices, never guest data.
 *
 * public_booking_lookup is on this list until item 5 moves it behind the Next.js
 * route; when that lands, delete the entry and this test will enforce it.
 *
 * public_cancellation_policy (Phase 9, Phase 2) returns the published cancellation
 * wording for /policies/cancellation — public text, no guest data — so anon EXECUTE
 * is deliberate and safe.
 */
const ANON_ALLOWED = [
  "public_availability",
  "public_booking_lookup",
  "public_cancellation_policy",
  "public_quote",
];

/** Functions created by an extension are that extension's business, not ours. */
const NOT_FROM_EXTENSION = `
  not exists (
    select 1 from pg_depend d
     where d.objid = p.oid
       and d.classid = 'pg_proc'::regclass
       and d.deptype = 'e'
  )`;

let db: Client;

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '10s'");
});

after(async () => {
  await db.end();
});

describe("function execute grants", () => {
  it("no function relies on the default PUBLIC grant", async () => {
    const { rows } = await db.query<{ signature: string }>(
      `select p.proname || '(' || pg_get_function_arguments(p.oid) || ')' as signature
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proacl is null
          and ${NOT_FROM_EXTENSION}
        order by 1`,
    );

    assert.deepEqual(
      rows.map((r) => r.signature),
      [],
      "These functions have a NULL proacl, which means PUBLIC — and therefore anon — " +
        "can execute them. Add a revoke to the newest migration:\n" +
        rows.map((r) => `  revoke all on function public.${r.signature} from public, anon, authenticated;`).join("\n"),
    );
  });

  it("no function grants EXECUTE to PUBLIC explicitly", async () => {
    // aclexplode() returns nothing for a NULL acl, so this cannot replace the
    // test above — and the test above cannot replace this one, because an
    // explicit `GRANT TO PUBLIC` leaves a perfectly non-NULL acl.
    const { rows } = await db.query<{ signature: string }>(
      `select p.proname || '(' || pg_get_function_arguments(p.oid) || ')' as signature
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace,
              lateral aclexplode(p.proacl) a
        where n.nspname = 'public'
          and a.privilege_type = 'EXECUTE'
          and a.grantee = 0
          and ${NOT_FROM_EXTENSION}
        order by 1`,
    );

    assert.deepEqual(rows.map((r) => r.signature), [], "granted to PUBLIC");
  });

  it("only the public booking endpoints are executable by anon", async () => {
    const { rows } = await db.query<{ proname: string }>(
      `select distinct p.proname
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace,
              lateral aclexplode(p.proacl) a
        where n.nspname = 'public'
          and a.privilege_type = 'EXECUTE'
          and a.grantee = (select oid from pg_roles where rolname = 'anon')
          and ${NOT_FROM_EXTENSION}
        order by 1`,
    );

    assert.deepEqual(
      rows.map((r) => r.proname),
      ANON_ALLOWED,
      "A function became anon-callable. If that is deliberate, add it to " +
        "ANON_ALLOWED and say why; if not, revoke it.",
    );
  });

  it("the two functions the review found are no longer reachable by anon", async () => {
    // Named explicitly so a regression reads as itself rather than as a diff of
    // a long list.
    for (const [name, args] of [
      ["sync_units_for_room", "uuid"],
      ["create_reservation", "jsonb, date, date, jsonb, text, uuid[], uuid, text, integer"],
    ] as const) {
      const { rows } = await db.query<{ ok: boolean }>(
        `select has_function_privilege('anon', $1, 'EXECUTE') as ok`,
        [`public.${name}(${args})`],
      );
      assert.equal(rows[0].ok, false, `anon can still execute ${name}`);
    }
  });

  it("still lets the roles that need these functions use them", async () => {
    // A revoke that also breaks the application is not a fix. service_role runs
    // /api/book; authenticated is what the 19 RLS policies calling user_role()
    // are evaluated as.
    const checks: [string, string][] = [
      ["service_role", "public.create_reservation(jsonb, date, date, jsonb, text, uuid[], uuid, text, integer)"],
      ["authenticated", "public.user_role()"],
      ["service_role", "public.user_role()"],
    ];
    for (const [role, signature] of checks) {
      const { rows } = await db.query<{ ok: boolean }>(
        `select has_function_privilege($1, $2, 'EXECUTE') as ok`,
        [role, signature],
      );
      assert.equal(rows[0].ok, true, `${role} lost EXECUTE on ${signature}`);
    }
  });
});
