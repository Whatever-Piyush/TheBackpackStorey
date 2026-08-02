-- Explicit table grants
--
-- ADD ONLY. This migration contains no REVOKE, deliberately.
--
-- Why it exists at all, when production seems not to need it:
--
-- The live project was created through the Supabase dashboard, so it carries
-- Supabase's default privileges — `anon` and `authenticated` hold broad grants on
-- every table in `public`, and RLS is what actually protects the data. Measured on
-- a restored replica: anon has SELECT/INSERT/UPDATE/DELETE on bookings, guests,
-- profiles, orders, order_items, menu_items, menu_categories, housekeeping and
-- payments_legacy.
--
-- A restore into a FRESH project does not reliably reproduce those defaults. The
-- tables arrive from the dump, the ALTER DEFAULT PRIVILEGES that would have
-- covered them was never replayed, and the result is a database that looks
-- perfect and that nobody can log into — `permission denied for table profiles`
-- the moment the app reads a role. The backup would restore, and the property
-- would still be down.
--
-- So: state the grants the application actually needs, explicitly, in the schema.
-- On production every one of these is already implied and this is a no-op. On a
-- fresh restore it is the difference between a working system and a locked one.
--
-- Removing the over-broad defaults is SEPARATE hardening, gated on the anon probe
-- passing with these explicit grants in place. Revoking here would be a behaviour
-- change on a working database, dressed up as a restore fix.

-- ------------------------------------------------------------------- schema
grant usage on schema public to anon, authenticated, service_role;

-- -------------------------------------------------------------- service_role
--
-- The server identity: every operational write goes through it (docs/foundation.md
-- §1). It bypasses RLS, so grants are not a security boundary for it — they are
-- only about whether the app functions at all.
grant all on all tables      in schema public to service_role;
grant all on all sequences   in schema public to service_role;
grant execute on all functions in schema public to service_role;

-- ------------------------------------------------------------- authenticated
--
-- Mirrors the RLS policies exactly: a grant without a matching policy is dead
-- weight, and a policy without a matching grant is a table nobody can read.
-- Derived from pg_policies rather than guessed.

-- Read-only for staff.
grant select on backup_runs to authenticated;
grant select on channels    to authenticated;
grant select on staff       to authenticated;

-- Read/write, still filtered by RLS on every row.
grant select, insert, update, delete on bookings        to authenticated;
grant select, insert, update, delete on guests          to authenticated;
grant select, insert, update, delete on housekeeping    to authenticated;
grant select, insert, update, delete on menu_categories to authenticated;
grant select, insert, update, delete on menu_items      to authenticated;
grant select, insert, update, delete on order_items     to authenticated;
grant select, insert, update, delete on orders          to authenticated;
grant select, insert, update, delete on payments_legacy to authenticated;
grant select, insert, update, delete on profiles        to authenticated;
grant select, insert, update, delete on room_types      to authenticated;

grant usage, select on all sequences in schema public to authenticated;

-- Deliberately NOT granted to authenticated: allocations, reservations, folios,
-- folio_items, payments, events, guest_documents, reservation_guests, units,
-- rooms, beds, rates, rate_plans, channel_inbox, channel_outbox,
-- channel_providers, property_settings, booking_idempotency, rate_limit_hits,
-- pos_day_closes, direct_allotment.
--
-- Those are reached only through SECURITY DEFINER functions that check the
-- caller's role first. A staff member reads the folio through stays_folio(), not
-- by selecting from folio_items — so the browser needs no privilege on the table,
-- and a compromised session cannot read one guest's folio by guessing another's id.

-- ---------------------------------------------------------------------- anon
--
-- The public booking engine, and nothing else. Counts and prices only — no guest
-- data, no unit ids, no reservations (ROADMAP M3 §1).
grant select on room_types to anon;
grant select on rates      to anon;
-- Column-level, as established in 0005: the site renders a room's number and
-- type, and has no business reading housekeeping state or occupancy.
grant select (id, number, room_type_id, type) on rooms to anon;

-- --------------------------------------------------------- future migrations
--
-- `all tables in schema public` is evaluated NOW, so a table created by a later
-- migration is not covered. These defaults close that gap for anything created
-- subsequently by this role, so the next table does not silently arrive
-- unreachable in a restored project.
alter default privileges in schema public grant all on tables      to service_role;
alter default privileges in schema public grant all on sequences   to service_role;
alter default privileges in schema public grant execute on functions to service_role;
