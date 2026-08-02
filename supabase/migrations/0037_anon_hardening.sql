-- Item 6 cleanup, and removal of the permissive anon defaults
--
-- Gated on the production anon probe passing with 0036's explicit grants already
-- in place. Every revoke below was checked against the actual callers first, not
-- after — a blanket revoke on nine tables is nine chances to take a live page
-- down, and `rooms` already demonstrated that when 0036's column-level grant made
-- `select=*` start returning 401.
--
-- The caller audit, from src/:
--
--   ONE file uses the anon client at all: src/lib/booking/availability.ts.
--   It touches room_types (select id) and the two public_* RPCs. Nothing else.
--
--   table            readers                                    client
--   ---------------- ------------------------------------------ -------------
--   guests           none                                       —
--   bookings         none                                       —
--   housekeeping     none                                       —
--   payments_legacy  none                                       —
--   profiles         lib/auth.ts                                authenticated
--   orders           lib/pos/{actions,kitchen}.ts               authenticated
--   order_items      lib/pos/{actions,settlement}.ts            authenticated
--   menu_items       lib/pos/{actions,menu}.ts                  authenticated
--   menu_categories  lib/pos/{actions,menu}.ts                  authenticated
--
-- The public café menu is NOT database-backed — it renders from CAFE in
-- src/lib/site.ts — so revoking menu_items/menu_categories cannot take it off the
-- website. That was the specific risk worth checking, and it does not apply.
--
-- components/pos/kitchen-live.tsx runs in the browser, but only calls .channel();
-- realtime resolves as `authenticated` for a signed-in staffer, which 0036 covers.

-- ------------------------------------------------------------------- item 6
--
-- direct_allotment: deprecated since 0028, which left the table in place with its
-- data but removed every reader. Confirmed live — anon could still download the
-- whole allotment grid. Nothing in src/ reads it; only test fixtures write to it,
-- and they connect as the owner.
revoke all on direct_allotment from anon;

-- room_types: anon held every column, including base_rate_paise, gender_policy and
-- deleted_at. The booking engine needs `id`, and filters on `code` and `active` —
-- and Postgres requires SELECT on a column to filter by it, so all three are
-- necessary and sufficient. Prices reach the public through public_availability(),
-- which is SECURITY DEFINER and needs no table grant.
revoke all on room_types from anon;
grant select (id, code, active) on room_types to anon;

-- user_role() was already revoked from PUBLIC and anon in 0032, pulled forward
-- because the grants regression test could not pass while any function still
-- carried the default. Nothing left to do here.

-- ------------------------------------- the permissive defaults, table by table
--
-- These grants came from Supabase's project bootstrap, not from this schema. RLS
-- has been the only thing protecting them: on production, anon could reach
-- `guests` and `profiles` at the grant level and got back [] purely because no
-- policy admitted it. Defence in depth means not relying on that alone.
--
-- Each of these has zero anon callers, verified above.

revoke all on guests          from anon;  -- guest names, phones, passport fields
revoke all on profiles        from anon;  -- staff identities and roles
revoke all on bookings        from anon;  -- legacy reservations, still populated
revoke all on payments_legacy from anon;  -- legacy money
revoke all on housekeeping    from anon;  -- legacy room status
revoke all on orders          from anon;  -- café orders
revoke all on order_items     from anon;
revoke all on menu_items      from anon;  -- POS-managed; public menu is site.ts
revoke all on menu_categories from anon;

-- NOT done here: `authenticated` still holds the same permissive defaults on these
-- tables. It is a smaller exposure — a signed-in non-staff user, still filtered by
-- RLS on every row — and 0036 already grants authenticated exactly the privileges
-- its policies allow. Revoking the defaults there means revoke-then-regrant on a
-- working system for no change in effective privilege, so it is deliberately left
-- as a separate exercise rather than bundled into a change that must not break the
-- live site.
