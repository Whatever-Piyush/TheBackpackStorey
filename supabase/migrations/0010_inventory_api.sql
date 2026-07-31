-- Hotel OS foundation — atomic inventory operations
--
-- WHY THESE ARE SQL FUNCTIONS, NOT TYPESCRIPT:
-- Creating a reservation is two inserts (reservation + allocation) that must
-- commit or fail together — otherwise a 23P01 on the allocation leaves an
-- orphaned reservation holding no inventory. PostgREST gives one statement per
-- request, so the transaction has to live in the database. The TypeScript layer
-- in src/lib/inventory/ is a typed wrapper over these.
--
-- Security: SECURITY INVOKER (the default) so RLS still applies to whoever calls.
-- These are for service-role server routes; EXECUTE is revoked from anon and
-- authenticated at the bottom.

-- ------------------------------------------------- direct availability (§5)
-- available = min( physical units free , allotment − direct reservations holding )
--
-- A date with no direct_allotment row yields allotment 0, i.e. NOT sellable
-- direct. That is deliberate: never sell inventory nobody has allotted. The seed
-- covers 400 days, so extend it before selling further out.
create or replace function public.direct_availability(
  p_room_type_id uuid,
  p_from         date,
  p_to           date
)
returns table (
  stay_date     date,
  physical_free integer,
  allotment     integer,
  direct_held   integer,
  available     integer
)
language sql
stable
set search_path = public
as $$
  with nights as (
    select d::date as stay_date
      from generate_series(p_from, p_to - 1, interval '1 day') as d
  ),
  total as (
    select count(*)::int as units
      from units
     where room_type_id = p_room_type_id and active
  ),
  per_night as (
    select
      n.stay_date,
      (select t.units from total t) - (
        select count(*)::int
          from allocations a
          join units u on u.id = a.unit_id
         where u.room_type_id = p_room_type_id
           and u.active
           and a.stay @> n.stay_date
      ) as physical_free,
      coalesce(da.units_for_direct, 0) as allotment,
      (
        select count(*)::int
          from allocations a
          join units u on u.id = a.unit_id
          join reservations r on r.id = a.reservation_id
         where u.room_type_id = p_room_type_id
           and a.stay @> n.stay_date
           -- "direct" = every channel that isn't an OTA
           and r.source not like 'ota\_%'
           and r.status in ('hold', 'confirmed', 'checked_in')
      ) as direct_held
    from nights n
    left join direct_allotment da
      on da.room_type_id = p_room_type_id and da.stay_date = n.stay_date
  )
  select
    stay_date,
    physical_free,
    allotment,
    direct_held,
    greatest(0, least(physical_free, allotment - direct_held)) as available
  from per_night
  order by stay_date;
$$;

-- ------------------------------------------------------- create_reservation
-- Walks the free units for a type and takes the first one that survives the
-- exclusion constraint. Both inserts sit inside the exception block, so a clash
-- rolls the reservation back too and the next candidate starts clean.
create or replace function public.create_reservation(
  p_room_type_id      uuid,
  p_checkin           date,
  p_checkout          date,
  p_source            text,
  p_guest_id          uuid    default null,
  p_adults            integer default 1,
  p_children          integer default 0,
  p_notes             text    default null,
  p_respect_allotment boolean default true
)
returns table (status text, reservation_id uuid, code text, unit_id uuid)
language plpgsql
set search_path = public
as $$
declare
  v_unit       record;
  v_res_id     uuid;
  v_code       text;
  v_candidates integer := 0;
begin
  if p_checkout <= p_checkin then
    return query select 'INVALID_DATES'::text, null::uuid, null::text, null::uuid;
    return;
  end if;

  -- The direct booking engine may only sell its allotment; reception (walk-in,
  -- phone) can be told to ignore it and use the whole house.
  if p_respect_allotment and exists (
    select 1 from public.direct_availability(p_room_type_id, p_checkin, p_checkout)
     where available <= 0
  ) then
    return query select 'NO_ALLOTMENT'::text, null::uuid, null::text, null::uuid;
    return;
  end if;

  for v_unit in
    select u.id
      from units u
     where u.room_type_id = p_room_type_id
       and u.active
       and not exists (
         select 1 from allocations a
          where a.unit_id = u.id
            and a.stay && daterange(p_checkin, p_checkout, '[)')
       )
     order by u.id
  loop
    v_candidates := v_candidates + 1;
    begin
      insert into reservations (guest_id, status, source, checkin, checkout,
                                adults, children, notes)
      values (p_guest_id, 'confirmed', p_source, p_checkin, p_checkout,
              p_adults, p_children, p_notes)
      returning id, reservations.code into v_res_id, v_code;

      insert into allocations (unit_id, reservation_id, reason, stay)
      values (v_unit.id, v_res_id, 'booking', daterange(p_checkin, p_checkout, '[)'));

      return query select 'OK'::text, v_res_id, v_code, v_unit.id;
      return;
    exception when exclusion_violation then
      -- Another transaction took this unit between our scan and our insert.
      -- The subtransaction rolled back, so the reservation row is gone too.
      null;
    end;
  end loop;

  if v_candidates = 0 then
    return query select 'NO_AVAILABILITY'::text, null::uuid, null::text, null::uuid;
  else
    return query select 'UNIT_TAKEN'::text, null::uuid, null::text, null::uuid;
  end if;
end;
$$;

-- ------------------------------------------------------- cancel_reservation
-- Status change and inventory release must be atomic: cancelling without freeing
-- the unit strands a bed, freeing without cancelling double-sells it.
create or replace function public.cancel_reservation(p_reservation_id uuid)
returns table (status text)
language plpgsql
set search_path = public
as $$
declare
  v_current text;
begin
  select r.status into v_current from reservations r where r.id = p_reservation_id;

  if v_current is null then
    return query select 'NOT_FOUND'::text;
    return;
  end if;

  if v_current in ('cancelled', 'checked_out', 'no_show') then
    return query select 'ALREADY_CLOSED'::text;
    return;
  end if;

  delete from allocations where reservation_id = p_reservation_id;
  update reservations set status = 'cancelled' where id = p_reservation_id;

  return query select 'OK'::text;
end;
$$;

-- --------------------------------------------------------------- privileges
-- §1: operational writes happen in server-side routes on the service-role key.
revoke all on function public.direct_availability(uuid, date, date) from public, anon, authenticated;
revoke all on function public.create_reservation(uuid, date, date, text, uuid, integer, integer, text, boolean)
  from public, anon, authenticated;
revoke all on function public.cancel_reservation(uuid) from public, anon, authenticated;
