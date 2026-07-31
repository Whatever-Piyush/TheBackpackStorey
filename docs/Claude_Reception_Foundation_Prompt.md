# Claude Code Prompt --- Reception Foundation (Steps 2--5)

Read these documents before writing any code:

1.  `docs/foundation.md`
2.  `docs/reception-definitions.md`

The foundation is frozen.

Do **NOT** modify:

-   Existing migrations (0001--0011)
-   Inventory model
-   Allocation algorithm
-   Exclusion constraints
-   Reservation business rules
-   Group reservation behaviour
-   RLS policies

If you believe anything in the foundation is incorrect, stop and explain
why. Do **not** work around it.

All schema changes from this point onward must be additive (0012+).

Before writing code, list every file you intend to modify and one
sentence describing the purpose of each file.

------------------------------------------------------------------------

# STEP 2 --- EVENTS

Implement the reception activity feed exactly as defined in
`docs/reception-definitions.md`.

## Requirements

-   Create additive migration **0012**.
-   Create the `events` table exactly as defined.
-   Events are a reception activity feed, **not** an audit log.
-   Exactly **ONE** event is written for every successful business
    operation.
-   Failed or rolled-back operations write **ZERO** events.
-   Events are immutable.
-   `actor_label` is a snapshot.
-   `summary` is written at log time.
-   `payload` stores structured metadata.
-   Use the `noun.verb` naming convention.

The reservation mutation functions are PL/pgSQL and execute as a single
database transaction.

Therefore:

-   `log_event(...)` **MUST** be a PL/pgSQL function.
-   It **MUST** be called from inside the mutation functions.
-   **Do NOT** implement a TypeScript logger.

A TypeScript helper executes in a separate transaction and would leave
phantom events if a reservation rolls back.

You are explicitly permitted to `CREATE OR REPLACE` the existing
PL/pgSQL mutation functions in migration **0012** for the sole purpose
of calling `log_event()`.

Do **NOT** change:

-   allocation logic
-   exclusion constraint behaviour
-   23P01 handling
-   business rules
-   return payloads

Show the old and new function bodies side by side so only the
`log_event()` call differs.

The actor is passed into the function.

Do **NOT** use `auth.uid()`.

Mutations run under the **service role**, so `auth.uid()` is null there.

If any of these operations are **not** PL/pgSQL functions:

-   create_reservation
-   cancel_reservation
-   move_allocation
-   block_unit

STOP.

Report which ones are still implemented in TypeScript.

Do not silently move them. Do not implement a TypeScript logger.

Enable RLS on the new events table.

No permissive read policy.

Reads must go through `reception_dashboard()`.

``` sql
alter table events enable row level security;

revoke update, delete on events from anon, authenticated;
revoke all on events from anon;
```

Enforce immutability with:

-   BEFORE UPDATE trigger → raise exception
-   BEFORE DELETE trigger → raise exception

Implement logging for:

-   reservation.created
-   reservation.cancelled
-   allocation.moved
-   unit.blocked

Do **NOT** implement check-in or checkout events yet.

------------------------------------------------------------------------

# STEP 3 --- RECEPTION SHELL

Create the authenticated Reception application shell.

Requirements:

-   `/reception` route group
-   Middleware authentication
-   Redirect unauthenticated users
-   Staff table mapping `auth.users`

Roles:

-   owner
-   staff

Owner additionally sees:

-   Rates
-   Direct Allotment
-   Daily Close

Everything else is shared.

Tablet-first layout.

Build:

-   Header
-   Navigation
-   Sidebar / Drawer
-   Content area
-   User menu
-   Logout

Do **NOT** build business screens yet.

------------------------------------------------------------------------

# STEP 4 --- RECEPTION DASHBOARD

Implement **ONLY** the dashboard.

Create:

``` sql
reception_dashboard(p_date date default null)
```

Requirements:

-   SECURITY DEFINER
-   `SET search_path = public, pg_temp`
-   Read-only
-   No side effects
-   Returns JSON
-   Server Components only
-   ONE RPC call only

When `p_date IS NULL` compute:

``` sql
(now() at time zone 'Asia/Kolkata')::date
```

inside PostgreSQL.

The dashboard RPC is called using the **user-scoped server client**
(`createServerClient` with cookies), **not** the service role.

This is intentional:

-   Mutations → service role + explicit actor.
-   Dashboard → authenticated user's JWT.

Do **NOT** use the service role for dashboard reads.

Verify the caller belongs to the `staff` table before returning data.

Function permissions:

``` sql
revoke execute on function reception_dashboard(date) from public;
revoke execute on function reception_dashboard(date) from anon;
grant execute on function reception_dashboard(date) to authenticated;
```

Widgets:

-   Today's arrivals
-   Today's departures
-   Current in-house guests
-   Occupancy %
-   Occupancy numerator / denominator
-   Available units by room type
-   Units needing cleaning
-   Open folios carrying balance
-   Last 20 reception events

Quick actions:

-   Walk-in Booking
-   Check-in by Booking Code
-   Block Unit

Support:

-   loading.tsx
-   Suspense
-   error.tsx
-   reset()

Only the retry control may be a Client Component.

Do **NOT** fetch dashboard data from the browser.

------------------------------------------------------------------------

# STEP 5 --- TESTS

Extend the existing test suite.

Verify:

1.  Successful 4-bed group booking → exactly ONE `reservation.created`
    event.
2.  Failed group booking on the third unit → ZERO events, ZERO
    allocations, ZERO orphan reservations.
3.  UPDATE against events fails:
    -   once via permission denial
    -   once using `service_role` so the BEFORE UPDATE trigger is
        exercised.
4.  DELETE against events fails:
    -   once via permission denial
    -   once using `service_role` so the BEFORE DELETE trigger is
        exercised.

Existing tests must continue passing.

Tests must remain deterministic.

------------------------------------------------------------------------

# DO NOT BUILD

-   Arrivals screen
-   Departures screen
-   Walk-in booking flow
-   Occupancy board
-   Check-in
-   Check-out
-   Housekeeping
-   Maintenance
-   Restaurant
-   Guest Portal
-   Reports
-   Daily Close

------------------------------------------------------------------------

# STOP

After completion, provide:

1.  Migration diff
2.  Changed files
3.  Architectural decisions
4.  Dashboard JSON schema
5.  Build output
6.  Test output

Wait for approval before implementing the next module.
