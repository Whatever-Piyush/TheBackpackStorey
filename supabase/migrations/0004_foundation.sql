-- Backpackers Storey — data foundation
--
-- Three concerns, all additive and idempotent (safe to re-run):
--   1. Audit timestamps  — a shared `updated_at` trigger on every table.
--   2. Soft deletes      — `deleted_at` on catalogue tables (the ones staff edit).
--   3. Room types        — nightly rates move OUT of TypeScript and INTO the DB.
--
-- Nothing here drops or rewrites existing data. `rooms.type` is deliberately
-- KEPT alongside the new `rooms.room_type_id` so existing reads keep working;
-- retiring it is a follow-up once every caller uses the foreign key.

-- ------------------------------------------------------- 1. audit timestamps
-- One shared trigger function rather than one per table.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ----------------------------------------------------------- 2. room types
-- The sellable unit's commercial record. Rate lives here, not on `rooms`:
-- a rate belongs to the type, so storing it per-room would duplicate the same
-- price across every room of that type.
--
-- `code` intentionally has NO check constraint — adding a fifth room type must
-- be an INSERT by staff, not a schema migration.
create table if not exists room_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  -- Dorm: per bed / night. Private rooms: per room / night.
  base_rate_paise integer not null default 0 check (base_rate_paise >= 0),
  -- Guests per *sellable unit* — a dorm bed sleeps 1, a family room sleeps 4.
  max_occupancy integer not null default 1 check (max_occupancy > 0),
  is_dorm boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Seeded from the values that were hardcoded in src/lib/booking/rates.ts, and
-- occupancy from src/lib/site.ts ROOMS.sleeps. These were flagged in-code as
-- PLACEHOLDERS — they are now editable data, so correct them in the portal
-- rather than in a migration.
insert into room_types (code, name, base_rate_paise, max_occupancy, is_dorm, sort_order)
select v.code, v.name, v.rate, v.occupancy, v.is_dorm, v.sort
from (values
  ('dorm',    'Six-Bed Dormitory',  60000, 1, true,  1),
  ('deluxe',  'Deluxe Room',       180000, 2, false, 2),
  ('premium', 'Premium Room',      250000, 3, false, 3),
  ('family',  'Family Room',       320000, 4, false, 4)
) as v(code, name, rate, occupancy, is_dorm, sort)
where not exists (select 1 from room_types rt where rt.code = v.code);

-- Link physical rooms to their type, backfilling from the existing text column.
alter table rooms add column if not exists room_type_id uuid
  references room_types (id) on delete restrict;

update rooms r
   set room_type_id = rt.id
  from room_types rt
 where rt.code = r.type
   and r.room_type_id is null;

create index if not exists rooms_room_type_idx on rooms (room_type_id);

-- ------------------------------------------------------- 3. booking guests
-- The public booking form has always collected a guest count and then thrown it
-- away (it only reached the WhatsApp confirmation text). Persist it.
alter table bookings add column if not exists guests integer not null default 1
  check (guests > 0);

-- ------------------------------------------- apply audit timestamps to all
do $$
declare
  t text;
begin
  foreach t in array array[
    'profiles', 'menu_categories', 'menu_items', 'room_types', 'rooms', 'beds',
    'guests', 'bookings', 'housekeeping', 'orders', 'order_items', 'payments'
  ] loop
    execute format(
      'alter table public.%I add column if not exists updated_at timestamptz not null default now()', t);
    execute format('drop trigger if exists set_updated_at on public.%I', t);
    execute format(
      'create trigger set_updated_at before update on public.%I
         for each row execute function public.set_updated_at()', t);
  end loop;
end $$;

-- ------------------------------------------------- apply soft deletes
-- Only on catalogue/reference tables staff curate. Transactional rows
-- (bookings, orders, order_items, payments) are NOT soft-deleted: they already
-- reach terminal states (void / cancelled / checked_out) and a financial ledger
-- should never disappear from a query.
do $$
declare
  t text;
begin
  foreach t in array array[
    'menu_categories', 'menu_items', 'room_types', 'rooms', 'beds', 'guests'
  ] loop
    execute format('alter table public.%I add column if not exists deleted_at timestamptz', t);
    -- Partial index: every "live rows only" query hits this.
    execute format(
      'create index if not exists %I on public.%I (id) where deleted_at is null',
      t || '_active_idx', t);
  end loop;
end $$;

-- ----------------------------------------------------------------- 4. RLS
-- Mirrors the existing `rooms` policy pair: all staff read, management writes.
-- Public website reads go through the service-role client, which bypasses RLS,
-- so no anon policy is needed (and none is granted).
alter table room_types enable row level security;

drop policy if exists room_types_read on room_types;
create policy room_types_read on room_types for select to authenticated
  using (public.user_role() is not null);

drop policy if exists room_types_write on room_types;
create policy room_types_write on room_types for all to authenticated
  using (public.user_role() in ('owner', 'manager'))
  with check (public.user_role() in ('owner', 'manager'));
