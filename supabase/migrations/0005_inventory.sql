-- Hotel OS foundation — §2 Inventory schema (docs/foundation.md)
--
-- Evolves the existing room_types / rooms / beds into the shape the OS needs and
-- introduces `units`: the ONE thing availability and allocation read, so no query
-- ever branches on dorm-vs-private again.
--
-- Additive by design. `rooms.name / type / total_beds / is_dorm` are KEPT even
-- though §2 omits them, because the live booking flow (src/lib/booking/actions.ts)
-- still reads all four and this task must not touch app code. They are deprecated
-- from here on; retire them in the cutover task.

create extension if not exists btree_gist;

-- ------------------------------------------------------------- room_types
-- §2 adds sell_mode (the decision that replaces is_dorm branching everywhere).
alter table room_types add column if not exists sell_mode text;
alter table room_types add column if not exists gender_policy text not null default 'any';
alter table room_types add column if not exists base_occupancy integer not null default 1;
alter table room_types add column if not exists active boolean not null default true;

-- Backfill sell_mode from the legacy is_dorm flag before enforcing NOT NULL.
update room_types set sell_mode = case when is_dorm then 'per_bed' else 'per_room' end
 where sell_mode is null;

-- 0004 gave these tables `deleted_at`; §2 uses an `active` flag. `active` is
-- authoritative from here on — keep them agreeing for any already-soft-deleted row.
update room_types set active = false where deleted_at is not null and active;

do $$
begin
  alter table room_types alter column sell_mode set not null;
exception when others then
  raise exception 'room_types.sell_mode could not be set NOT NULL — some row has no sell_mode';
end $$;

alter table room_types drop constraint if exists room_types_sell_mode_check;
alter table room_types add constraint room_types_sell_mode_check
  check (sell_mode in ('per_bed', 'per_room'));

alter table room_types drop constraint if exists room_types_gender_policy_check;
alter table room_types add constraint room_types_gender_policy_check
  check (gender_policy in ('any', 'female_only', 'male_only'));

alter table room_types drop constraint if exists room_types_base_occupancy_check;
alter table room_types add constraint room_types_base_occupancy_check
  check (base_occupancy > 0);

-- ------------------------------------------------------------------ rooms
alter table rooms add column if not exists number text;
alter table rooms add column if not exists floor text;
alter table rooms add column if not exists housekeeping text not null default 'clean';
alter table rooms add column if not exists active boolean not null default true;

-- `number` is what reception says out loud. Seed it from the existing name.
update rooms set number = name where number is null;

-- Fold the standalone housekeeping table into the room row (§2). The old table
-- has no app-code readers or writers, so this loses nothing.
-- 'in_progress' has no §2 equivalent; a room mid-clean is still not sellable → 'dirty'.
update rooms r
   set housekeeping = case h.status when 'in_progress' then 'dirty' else h.status end
  from housekeeping h
 where h.room_id = r.id;

update rooms set active = false where deleted_at is not null and active;
update rooms r set room_type_id = rt.id from room_types rt
 where rt.code = r.type and r.room_type_id is null;

do $$
declare
  orphans int;
begin
  select count(*) into orphans from rooms where room_type_id is null;
  if orphans > 0 then
    raise exception
      '% room(s) have no matching room_types.code for rooms.type — fix before migrating', orphans;
  end if;
end $$;

alter table rooms alter column room_type_id set not null;
alter table rooms alter column number set not null;

alter table rooms drop constraint if exists rooms_number_key;
alter table rooms add constraint rooms_number_key unique (number);

alter table rooms drop constraint if exists rooms_housekeeping_check;
alter table rooms add constraint rooms_housekeeping_check
  check (housekeeping in ('clean', 'dirty', 'inspected', 'out_of_order'));

-- ------------------------------------------------------------------- beds
alter table beds add column if not exists position text;
alter table beds add column if not exists active boolean not null default true;

update beds set active = false where deleted_at is not null and active;

alter table beds drop constraint if exists beds_position_check;
alter table beds add constraint beds_position_check
  check (position is null or position in ('lower', 'upper', 'single'));

-- ------------------------------------------------------------------ units
-- One row per sellable thing: a whole private room, or a single dorm bed.
--
-- NOTE ON THE UNIQUE CONSTRAINT: §2 specifies `unique (room_id, bed_id)`, but
-- Postgres treats NULLs as DISTINCT in a unique index, so that would permit
-- unlimited duplicate (room_id, NULL) rows — i.e. one private room could sprout
-- ten units and availability would silently over-sell it. `nulls not distinct`
-- (PG15+; Supabase is PG17) is what actually enforces the intent.
create table if not exists units (
  id           uuid primary key default gen_random_uuid(),
  room_type_id uuid not null references room_types (id),
  room_id      uuid not null references rooms (id) on delete cascade,
  bed_id       uuid references beds (id) on delete cascade,
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint units_room_bed_key unique nulls not distinct (room_id, bed_id)
);

create index if not exists units_type_active_idx on units (room_type_id) where active;
create index if not exists units_room_idx on units (room_id);

drop trigger if exists set_updated_at on units;
create trigger set_updated_at before update on units
  for each row execute function public.set_updated_at();

-- ------------------------------------------------- units sync (§2 "by trigger")
-- per_room types get one unit per room; per_bed types get one unit per bed.
create or replace function public.sync_units_for_room(p_room_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type_id uuid;
  v_mode    text;
  v_active  boolean;
begin
  select r.room_type_id, rt.sell_mode, r.active
    into v_type_id, v_mode, v_active
    from rooms r join room_types rt on rt.id = r.room_type_id
   where r.id = p_room_id;

  if v_type_id is null then
    return;
  end if;

  if v_mode = 'per_room' then
    -- The room itself is the unit; any bed-level units for it are wrong.
    delete from units where room_id = p_room_id and bed_id is not null;
    insert into units (room_type_id, room_id, bed_id, active)
    values (v_type_id, p_room_id, null, v_active)
    on conflict (room_id, bed_id)
      do update set room_type_id = excluded.room_type_id, active = excluded.active;
  else
    -- Beds are the units; a whole-room unit for a dorm is wrong.
    delete from units where room_id = p_room_id and bed_id is null;
    insert into units (room_type_id, room_id, bed_id, active)
    select v_type_id, p_room_id, b.id, (v_active and b.active)
      from beds b
     where b.room_id = p_room_id
    on conflict (room_id, bed_id)
      do update set room_type_id = excluded.room_type_id, active = excluded.active;
  end if;
end;
$$;

create or replace function public.units_room_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_units_for_room(new.id);
  return new;
end;
$$;

create or replace function public.units_bed_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sync_units_for_room(coalesce(new.room_id, old.room_id));
  return coalesce(new, old);
end;
$$;

drop trigger if exists units_sync_on_room on rooms;
create trigger units_sync_on_room
  after insert or update of room_type_id, active on rooms
  for each row execute function public.units_room_sync();

drop trigger if exists units_sync_on_bed on beds;
create trigger units_sync_on_bed
  after insert or update of active, room_id on beds
  for each row execute function public.units_bed_sync();

-- A room type flipping sell_mode has to rebuild every unit under it.
create or replace function public.units_type_sync()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r uuid;
begin
  if new.sell_mode is distinct from old.sell_mode then
    for r in select id from rooms where room_type_id = new.id loop
      perform public.sync_units_for_room(r);
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists units_sync_on_type on room_types;
create trigger units_sync_on_type
  after update of sell_mode on room_types
  for each row execute function public.units_type_sync();

-- Backfill units for everything that already exists.
do $$
declare
  r uuid;
begin
  for r in select id from rooms loop
    perform public.sync_units_for_room(r);
  end loop;
end $$;

-- ------------------------------------------------------------------- RLS
-- §1: deny-by-default. Operational reads/writes go through server-side routes on
-- the service-role key (which bypasses RLS). The only grant is public read of the
-- inventory the booking engine has to show.
--
-- This DROPS the permissive staff policies 0002 created on rooms/beds. Verified
-- safe: every rooms/beds access in the app already goes through the admin client.
-- Consequence: the reception console must read via service-role routes too.
alter table units enable row level security;

drop policy if exists rooms_read on rooms;
drop policy if exists rooms_write on rooms;
drop policy if exists beds_read on beds;
drop policy if exists beds_write on beds;

revoke all on room_types from anon;
revoke all on rooms from anon;
revoke all on beds from anon;
revoke all on units from anon;

-- §8: "public anon SELECT only on room_types, rooms (id/number/type), ..."
grant select on room_types to anon;
grant select (id, number, room_type_id, type) on rooms to anon;

drop policy if exists room_types_anon_read on room_types;
create policy room_types_anon_read on room_types for select to anon
  using (active);

drop policy if exists rooms_anon_read on rooms;
create policy rooms_anon_read on rooms for select to anon
  using (active);

-- beds and units stay fully private: no policy, no grant.
