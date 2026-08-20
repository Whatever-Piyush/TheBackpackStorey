/**
 * Table grants, exercised as the roles that actually connect.
 *
 * Every other DB test in this suite runs as `postgres`, which owns the schema and
 * bypasses both grants and RLS — so it can prove logic but can never prove access
 * control. This file switches role and asks the questions a real client asks.
 *
 * Three identities:
 *   anon                     the public website, holding the publishable key
 *   authenticated (no staff) a signed-in user with no profiles row
 *   authenticated (staff)    a real staff member with a profiles AND staff row
 *
 * The last test is the one that matters most: it asserts a staff user can load
 * the reception dashboard. That is precisely the check that would have caught the
 * empty-staff-table lockout before it reached production, instead of after.
 */

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Client } from "pg";

const CONNECTION =
  process.env.DATABASE_URL ?? "postgres://postgres:pw@localhost:55432/app";

const STAFF_ID = "77777777-0000-0000-0000-00000000000a";
const OUTSIDER_ID = "77777777-0000-0000-0000-00000000000b";

/** Tables no browser session may touch directly; reached only via definer functions. */
const SERVER_ONLY = [
  "allocations",
  "reservations",
  "folios",
  "folio_items",
  "payments",
  "events",
  "guest_documents",
  "reservation_guests",
  "units",
  "channel_inbox",
  "channel_outbox",
  "property_settings",
  "booking_idempotency",
  "rate_limit_hits",
];

let db: Client;

/** Runs `fn` as `role`, with an optional JWT subject, then resets. */
async function as<T>(
  role: string,
  sub: string | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (sub) await db.query(`set request.jwt.claim.sub = '${sub}'`);
  else await db.query(`reset request.jwt.claim.sub`);
  await db.query(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.query(`reset role`);
  }
}

/** Returns the row count, or the Postgres error message. */
async function trySelect(table: string): Promise<{ rows: number } | { error: string }> {
  try {
    const { rows } = await db.query<{ n: string }>(`select count(*) as n from ${table}`);
    return { rows: Number(rows[0].n) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

before(async () => {
  db = new Client({ connectionString: CONNECTION });
  await db.connect();
  await db.query("set statement_timeout = '10s'");

  await db.query(
    `insert into auth.users (id, email) values ($1,'staff@grants'),($2,'outsider@grants')
     on conflict (id) do nothing`,
    [STAFF_ID, OUTSIDER_ID],
  );
  // A real staff member needs BOTH rows — see docs/RUNBOOK.md §4.
  await db.query(
    `insert into profiles (id, full_name, role) values ($1,'Grants Staff','reception')
     on conflict (id) do update set role = 'reception', full_name = 'Grants Staff'`,
    [STAFF_ID],
  );
  await db.query(
    `insert into staff (user_id, display_name, role, active) values ($1,'Grants Staff','staff',true)
     on conflict (user_id) do update set active = true`,
    [STAFF_ID],
  );
  // The outsider is signed in but has no profile and no staff row.
  await db.query(`delete from staff where user_id = $1`, [OUTSIDER_ID]);
  await db.query(`delete from profiles where id = $1`, [OUTSIDER_ID]);
});

after(async () => {
  await db.query(`reset role`);
  await db.query(`delete from staff where user_id in ($1,$2)`, [STAFF_ID, OUTSIDER_ID]);
  await db.query(`delete from profiles where id in ($1,$2)`, [STAFF_ID, OUTSIDER_ID]);
  await db.end();
});

describe("anon — the public website", () => {
  it("can read what the booking engine renders", async () => {
    await as("anon", null, async () => {
      for (const table of ["room_types", "rates"]) {
        const result = await trySelect(table);
        assert.ok("rows" in result, `anon must be able to read ${table}: ${JSON.stringify(result)}`);
      }
      // rooms is column-level: these four and no others.
      const { rows } = await db.query(`select id, number, room_type_id, type from rooms limit 1`);
      assert.ok(Array.isArray(rows));
    });
  });

  it("cannot read the columns of rooms it was not granted", async () => {
    await as("anon", null, async () => {
      await assert.rejects(
        () => db.query(`select housekeeping from rooms limit 1`),
        /permission denied/,
        "housekeeping state is not the public's business",
      );
    });
  });

  it("cannot reach guest data by ANY route", async () => {
    await as("anon", null, async () => {
      for (const table of ["guests", ...SERVER_ONLY]) {
        const result = await trySelect(table);
        const reachable = "rows" in result && result.rows > 0;
        assert.equal(reachable, false, `anon read ${result && "rows" in result ? result.rows : 0} rows from ${table}`);
      }
    });
  });

  it("cannot execute the money predicate or the takings RPC", async () => {
    // Phase 9: every money-bearing function is revoked from anon. Hiding a nav link
    // is not access control — a bare session (or the publishable key) can hit
    // /rest/v1/rpc/ directly, so the grant is the boundary.
    await as("anon", null, async () => {
      for (const call of ["select can_view_money()", "select pos_today()"]) {
        await assert.rejects(() => db.query(call), /permission denied/, call);
      }
    });
  });
});

describe("authenticated, but not staff", () => {
  it("gets no rows from guest data — grant or policy, either is fine", async () => {
    await as("authenticated", OUTSIDER_ID, async () => {
      for (const table of ["guests", ...SERVER_ONLY]) {
        const result = await trySelect(table);
        const reachable = "rows" in result && result.rows > 0;
        assert.equal(reachable, false, `outsider read from ${table}`);
      }
    });
  });

  it("is refused by the staff-gated functions, by name", async () => {
    await as("authenticated", OUTSIDER_ID, async () => {
      for (const call of [
        `select reception_dashboard()`,
        `select stays_board(current_date, 7)`,
        `select stays_arrivals()`,
        `select pos_today()`,
      ]) {
        await assert.rejects(() => db.query(call), /not permitted|not reception staff/, call);
      }
    });
  });
});

describe("authenticated staff", () => {
  it("CAN LOAD THE RECEPTION DASHBOARD", async () => {
    // Proves the gate works for a correctly provisioned staffer.
    //
    // NOTE: this alone would NOT have caught the production lockout, because the
    // fixture above inserts its own staff row — so it passes even when the table
    // is otherwise empty. Verified by emptying `staff` and watching this stay
    // green. The invariant test below is the one that catches it.
    await as("authenticated", STAFF_ID, async () => {
      const { rows } = await db.query<{ d: Record<string, unknown> }>(
        `select reception_dashboard() as d`,
      );
      assert.ok(rows[0].d, "a staff member must be able to load /reception");
      for (const key of ["date", "arrivals", "departures", "occupancy", "needsCleaning"]) {
        assert.ok(key in rows[0].d, `dashboard is missing "${key}"`);
      }
    });
  });

  it("can run the stays console", async () => {
    await as("authenticated", STAFF_ID, async () => {
      const { rows: board } = await db.query<{ b: { days: number } }>(
        `select stays_board(current_date, 7) as b`,
      );
      assert.equal(board[0].b.days, 7);

      const { rows: arrivals } = await db.query<{ a: Record<string, unknown> }>(
        `select stays_arrivals() as a`,
      );
      assert.ok(arrivals[0].a, "reception must see today's arrivals");
    });
  });

  it("is held out of the owner-only takings screen", async () => {
    // pos_today gates on ('owner','manager') — the day's money is not every
    // staffer's business (ROADMAP M1 §3). The fixture staffer is 'reception', so
    // this asserts the narrower gate really is narrower, rather than assuming it.
    await as("authenticated", STAFF_ID, async () => {
      await assert.rejects(() => db.query(`select pos_today()`), /not permitted/);
    });
  });

  it("still cannot select guest tables directly — only through the functions", async () => {
    // The grant matrix and the definer functions are doing different jobs. Staff
    // read a folio via stays_folio(); the browser never touches folio_items, so a
    // stolen session cannot enumerate other guests' bills.
    await as("authenticated", STAFF_ID, async () => {
      for (const table of ["folio_items", "payments", "allocations", "reservations"]) {
        const result = await trySelect(table);
        const reachable = "rows" in result && result.rows > 0;
        assert.equal(reachable, false, `staff read ${table} directly`);
      }
    });
  });

  it("no profile with a role is missing its staff row", async () => {
    // THIS is the check that catches the lockout. It asserts a property of the
    // deployed data, not of a fixture: after 0035, every account that can sign in
    // and hold a role must also be on the roster, or /reception refuses them.
    //
    // Deliberately fixture-free. Emptying `staff` turns this red; the dashboard
    // test above stays green, which is exactly why both exist.
    const { rows } = await db.query<{ id: string; role: string }>(
      `select p.id, p.role
         from profiles p
        where p.role is not null
          and not exists (select 1 from staff s where s.user_id = p.id)
        order by p.role`,
    );
    assert.deepEqual(
      rows.map((r) => `${r.role}:${r.id}`),
      [],
      "These accounts have a profile but no staff row, so /reception will refuse " +
        "them with 'not reception staff'. Re-run 0035_staff_backfill.sql, or see " +
        "docs/RUNBOOK.md §4 — adding a staff member takes TWO rows.",
    );
  });

  it("can read its own staff row and its own profile", async () => {
    await as("authenticated", STAFF_ID, async () => {
      const { rows: staff } = await db.query<{ n: string }>(
        `select count(*) as n from staff where user_id = $1`,
        [STAFF_ID],
      );
      assert.equal(staff[0].n, "1", "a staffer must see their own roster row");

      const { rows: me } = await db.query<{ role: string }>(
        `select role from profiles where id = $1`,
        [STAFF_ID],
      );
      assert.equal(me[0]?.role, "reception");
    });
  });
});
