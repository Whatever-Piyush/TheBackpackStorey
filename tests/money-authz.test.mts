/**
 * Money authorization boundary (Phase 9, Phase 1).
 *
 * Proves the one thing this phase is for: aggregate money is visible to owner and
 * manager and to nobody else, the boundary is enforced in the DATABASE (it RAISES,
 * it does not quietly return an empty report), reception keeps the transactional
 * access it has today, and — the most important check — a non-owner cannot rewrite
 * their own profiles.role to promote themselves into money visibility.
 *
 * Same harness as grants-matrix.test.mts: run as the roles that actually connect,
 * switching `set role` and the JWT subject, because `postgres` bypasses RLS and
 * grants and so can never prove access control.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

// One account per profiles.role.
const USERS: Record<string, string> = {
  owner: "99990000-0000-0000-0000-000000000001",
  manager: "99990000-0000-0000-0000-000000000002",
  reception: "99990000-0000-0000-0000-000000000003",
  kitchen: "99990000-0000-0000-0000-000000000004",
  housekeeping: "99990000-0000-0000-0000-000000000005",
};
const MONEY_ROLES = ["owner", "manager"];
const NON_MONEY = ["reception", "kitchen", "housekeeping"];

let db: Client;

/** Runs `fn` as `role`, with an optional JWT subject, then resets. */
async function as<T>(role: string, sub: string | null, fn: () => Promise<T>): Promise<T> {
  if (sub) await db.query(`set request.jwt.claim.sub = '${sub}'`);
  else await db.query(`reset request.jwt.claim.sub`);
  await db.query(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.query(`reset role`);
  }
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '10s'");

  for (const [role, id] of Object.entries(USERS)) {
    await db.query(
      `insert into auth.users (id, email) values ($1,$2) on conflict (id) do nothing`,
      [id, `${role}@money`],
    );
    await db.query(
      `insert into profiles (id, full_name, role) values ($1,$2,$3)
       on conflict (id) do update set role = excluded.role, full_name = excluded.full_name`,
      [id, `Money ${role}`, role],
    );
  }
});

after(async () => {
  await db.query(`reset role`);
  const ids = Object.values(USERS);
  await db.query(`delete from profiles where id = any($1)`, [ids]);
  await db.query(`delete from auth.users where id = any($1)`, [ids]);
  await db.end();
});

describe("can_view_money() — the canonical predicate", () => {
  it("is true for owner and manager", async () => {
    for (const role of MONEY_ROLES) {
      await as("authenticated", USERS[role], async () => {
        const { rows } = await db.query<{ v: boolean }>(`select public.can_view_money() as v`);
        assert.equal(rows[0].v, true, `${role} should see money`);
      });
    }
  });

  it("is false for reception, kitchen and housekeeping", async () => {
    for (const role of NON_MONEY) {
      await as("authenticated", USERS[role], async () => {
        const { rows } = await db.query<{ v: boolean }>(`select public.can_view_money() as v`);
        assert.equal(rows[0].v, false, `${role} must NOT see money`);
      });
    }
  });

  it("fails closed for a signed-in user with no profile", async () => {
    await as("authenticated", "99990000-0000-0000-0000-0000000000ff", async () => {
      const { rows } = await db.query<{ v: boolean }>(`select public.can_view_money() as v`);
      assert.equal(rows[0].v, false, "no profile row must resolve to false, not null/true");
    });
  });

  it("anonymous cannot even execute it", async () => {
    await as("anon", null, async () => {
      await assert.rejects(() => db.query(`select public.can_view_money()`), /permission denied/);
    });
  });
});

describe("aggregate money RPC (pos_today) routes through the predicate", () => {
  it("owner and manager succeed and get a real report", async () => {
    for (const role of MONEY_ROLES) {
      await as("authenticated", USERS[role], async () => {
        const { rows } = await db.query<{ d: Record<string, unknown> }>(
          `select pos_today() as d`,
        );
        assert.ok(rows[0].d && "summary" in rows[0].d, `${role} must get the takings report`);
      });
    }
  });

  it("reception, kitchen and housekeeping are REFUSED — a raise, not an empty report", async () => {
    for (const role of NON_MONEY) {
      await as("authenticated", USERS[role], async () => {
        await assert.rejects(() => db.query(`select pos_today()`), /not permitted/, role);
      });
    }
  });

  it("anonymous is refused", async () => {
    await as("anon", null, async () => {
      await assert.rejects(
        () => db.query(`select pos_today()`),
        /permission denied|not permitted/,
      );
    });
  });
});

describe("transactional access is unchanged (NOT aggregate money)", () => {
  it("reception can still read an individual guest's folio balance", async () => {
    await as("authenticated", USERS.reception, async () => {
      // A missing reservation returns an empty statement (balance 0), never a raise
      // — so a successful call proves reception retains folio access.
      const { rows } = await db.query<{ f: Record<string, unknown> }>(
        `select stays_folio(gen_random_uuid()) as f`,
      );
      assert.ok(rows[0].f && "balancePaise" in rows[0].f, "reception must reach a folio balance");
    });
  });

  it("kitchen and housekeeping cannot reach a guest folio", async () => {
    for (const role of ["kitchen", "housekeeping"]) {
      await as("authenticated", USERS[role], async () => {
        await assert.rejects(() => db.query(`select stays_folio(gen_random_uuid())`), /not permitted/, role);
      });
    }
  });

  it("café POS operation is unchanged: owner/manager/reception operate, kitchen/housekeeping do not", async () => {
    // pos_can_operate() is an internal predicate (revoked from authenticated); its
    // boundary is exercised through a real client entry point that gates on it. This
    // is the exact Phase 1 requirement — reception keeps operating the café POS.
    for (const role of ["owner", "manager", "reception"]) {
      await as("authenticated", USERS[role], async () => {
        const { rows } = await db.query<{ g: unknown }>(`select pos_checked_in_guests() as g`);
        assert.ok(Array.isArray(rows[0].g), `${role} must be able to operate the café POS`);
      });
    }
    for (const role of ["kitchen", "housekeeping"]) {
      await as("authenticated", USERS[role], async () => {
        await assert.rejects(() => db.query(`select pos_checked_in_guests()`), /not permitted/, role);
      });
    }
  });
});

describe("privilege escalation via profiles — the check that makes the rest matter", () => {
  it("a non-owner CANNOT promote their own role", async () => {
    for (const role of NON_MONEY) {
      await as("authenticated", USERS[role], async () => {
        // RLS profiles_write.using requires the CALLER to already be owner/manager,
        // so this matches zero rows (or is denied) — either way the role must not move.
        const res = await db
          .query(`update profiles set role = 'manager' where id = $1`, [USERS[role]])
          .catch((e: Error) => ({ rowCount: -1, error: e.message }));
        assert.notEqual(
          (res as { rowCount: number }).rowCount,
          1,
          `${role} must not be able to update its own role`,
        );
      });
      // Confirm authoritatively (as postgres) that the role is still what it was.
      const { rows } = await db.query<{ role: string }>(
        `select role from profiles where id = $1`,
        [USERS[role]],
      );
      assert.equal(rows[0].role, role, `${role}'s role was changed — escalation!`);
    }
  });

  it("a non-owner CANNOT promote someone else either", async () => {
    await as("authenticated", USERS.reception, async () => {
      await db
        .query(`update profiles set role = 'owner' where id = $1`, [USERS.kitchen])
        .catch(() => undefined);
    });
    const { rows } = await db.query<{ role: string }>(
      `select role from profiles where id = $1`,
      [USERS.kitchen],
    );
    assert.equal(rows[0].role, "kitchen", "reception must not be able to promote kitchen");
  });
});
