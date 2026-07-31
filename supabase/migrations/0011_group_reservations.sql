-- Reception — multi-unit (group) reservations
--
-- One reservation, N allocations: four backpackers taking four dorm beds is ONE
-- booking. The whole thing commits or rolls back together.
--
-- WHY plpgsql: @supabase/supabase-js issues one statement per request, so four
-- sequential inserts from the client would leave 2 of 4 beds allocated to a
-- reservation that then fails. The inserts live inside one function body — and
-- inside a subtransaction, so a 23P01 on the third bed unwinds the first two.
--
-- Supersedes the single-unit create_reservation from 0010. Nothing in 0001-0010
-- is edited; the frozen exclusion constraint on allocations is what makes this safe.

-- ------------------------------------------------------------------ guests
-- Required by the reception booking signature. `gender` is captured for
-- registration and reporting; it is NOT used for inventory allocation.
alter table guests add column if not exists nationality text;
alter table guests add column if not exists gender text;

alter table guests drop constraint if exists guests_gender_check;
alter table guests add constraint guests_gender_check
  check (gender is null or gender in ('female', 'male', 'other'));

-- ------------------------------------------------- retire the single-unit API
-- Leaving it callable would let a caller book one bed for a group of four.
drop function if exists public.create_reservation(uuid, date, date, text, uuid, integer, integer, text, boolean);

-- ---------------------------------------------------------------- allocator
-- Free units of a type for a stay, ordered by the assignment rules:
--   1. clean before dirty
--   2. lowest room number
--   3. stable unit id, so assignment is deterministic and testable
-- (Same-room preference for groups is applied on top of this, in pick_units.)
--
-- Dorms are mixed-gender: guest gender plays no part in selecting a bed.
-- `room_types.gender_policy` exists in the frozen foundation but is not read here.
create or replace function public.free_units_for_stay(
  p_room_type_id uuid,
  p_checkin      date,
  p_checkout     date
)
returns table (unit_id uuid, room_id uuid, room_number text, is_clean boolean)
language sql
stable
set search_path = public
as $$
  select u.id, u.room_id, r.number, (r.housekeeping = 'clean')
    from units u
    join rooms r on r.id = u.room_id
   where u.room_type_id = p_room_type_id
     and u.active
     and r.active
     and not exists (
       select 1 from allocations a
        where a.unit_id = u.id
          and a.stay && daterange(p_checkin, p_checkout, '[)')
     )
   order by (r.housekeeping = 'clean') desc, r.number, u.id;
$$;

-- Pick `p_qty` units, preferring a single room so a group stays together.
-- Falls back to spreading across rooms when no one room can hold them all.
create or replace function public.pick_units(
  p_room_type_id uuid,
  p_checkin      date,
  p_checkout     date,
  p_qty          integer
)
returns uuid[]
language plpgsql
stable
set search_path = public
as $$
declare
  v_room  uuid;
  v_units uuid[];
begin
  if p_qty < 1 then
    return array[]::uuid[];
  end if;

  -- Rule: qty > 1 on a per_bed type prefers beds in the same room.
  if p_qty > 1 then
    select f.room_id into v_room
      from public.free_units_for_stay(p_room_type_id, p_checkin, p_checkout) f
     group by f.room_id
    having count(*) >= p_qty
     -- Same tiebreak as the unit ordering: cleanest room first, then lowest number.
     order by bool_and(f.is_clean) desc, min(f.room_number)
     limit 1;

    if v_room is not null then
      select array_agg(x.unit_id order by x.room_number, x.unit_id) into v_units
        from (
          select f.* from public.free_units_for_stay(p_room_type_id, p_checkin, p_checkout) f
           where f.room_id = v_room
           limit p_qty
        ) x;
      return coalesce(v_units, array[]::uuid[]);
    end if;
  end if;

  -- Fallback (or qty = 1): take them in rule order wherever they are.
  select array_agg(x.unit_id) into v_units
    from (
      select f.unit_id from public.free_units_for_stay(p_room_type_id, p_checkin, p_checkout) f
       limit p_qty
    ) x;

  return coalesce(v_units, array[]::uuid[]);
end;
$$;

-- ------------------------------------------------------- create_reservation
-- p_guest : {id?, name, phone, email?, nationality?, gender?}
-- p_lines : [{roomTypeId, ratePlanId, qty}]
-- returns : {ok:true, reservation, allocations}
--         | {ok:false, code:'UNITS_TAKEN', roomTypeId, requested, available}
create or replace function public.create_reservation(
  p_guest             jsonb,
  p_checkin           date,
  p_checkout          date,
  p_lines             jsonb,
  p_source            text,
  p_unit_ids          uuid[] default null,
  p_respect_allotment boolean default true
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_guest_id    uuid;
  v_res_id      uuid;
  v_code        text;
  v_line        jsonb;
  v_type_id     uuid;
  v_plan_id     uuid;
  v_qty         integer;
  v_units       uuid[];
  v_unit        uuid;
  v_cursor      integer := 1;          -- position within p_unit_ids
  v_gender      text;
  v_result      jsonb;
  v_allocs      jsonb := '[]'::jsonb;
  -- Carried out of the subtransaction on failure: plpgsql variables are memory,
  -- so they survive the rollback that discards the inserts.
  v_failed_type uuid;
  v_failed_qty  integer;
  v_available   integer;
begin
  if p_checkout <= p_checkin then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DATES');
  end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_LINES');
  end if;

  -- Stored on the guest for registration and reporting only. Backpackers Storey
  -- runs mixed dorms, so gender never influences allocation.
  v_gender := nullif(p_guest ->> 'gender', '');

  -- Validate every line points at a real room type before anything is written.
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_type_id := (v_line ->> 'roomTypeId')::uuid;
    if not exists (select 1 from room_types rt where rt.id = v_type_id) then
      return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ROOM_TYPE',
                                'roomTypeId', v_type_id);
    end if;
  end loop;

  -- Direct allotment (§5) still caps the public engine.
  if p_respect_allotment then
    for v_line in select * from jsonb_array_elements(p_lines) loop
      v_type_id := (v_line ->> 'roomTypeId')::uuid;
      v_qty     := coalesce((v_line ->> 'qty')::int, 1);
      select min(d.available) into v_available
        from public.direct_availability(v_type_id, p_checkin, p_checkout) d;
      if coalesce(v_available, 0) < v_qty then
        return jsonb_build_object(
          'ok', false, 'code', 'NO_ALLOTMENT', 'roomTypeId', v_type_id,
          'requested', v_qty, 'available', coalesce(v_available, 0));
      end if;
    end loop;
  end if;

  -- ---- everything below is one subtransaction: all-or-nothing ----
  begin
    -- Guest: use the given one, otherwise create.
    v_guest_id := nullif(p_guest ->> 'id', '')::uuid;
    if v_guest_id is null then
      insert into guests (name, phone, email, nationality, gender)
      values (p_guest ->> 'name', p_guest ->> 'phone', nullif(p_guest ->> 'email', ''),
              nullif(p_guest ->> 'nationality', ''), v_gender)
      returning id into v_guest_id;
    end if;

    insert into reservations (guest_id, status, source, checkin, checkout, adults, children, notes)
    values (v_guest_id, 'confirmed', p_source, p_checkin, p_checkout,
            greatest(1, coalesce((p_guest ->> 'adults')::int,
                                 (select sum(coalesce((l ->> 'qty')::int, 1))
                                    from jsonb_array_elements(p_lines) l))),
            0, nullif(p_guest ->> 'notes', ''))
    returning id, reservations.code into v_res_id, v_code;

    for v_line in select * from jsonb_array_elements(p_lines) loop
      v_type_id := (v_line ->> 'roomTypeId')::uuid;
      v_plan_id := nullif(v_line ->> 'ratePlanId', '')::uuid;
      v_qty     := coalesce((v_line ->> 'qty')::int, 1);

      v_failed_type := v_type_id;
      v_failed_qty  := v_qty;

      if p_unit_ids is not null then
        -- Reception overrode the allocator: take the next v_qty from the array.
        v_units := p_unit_ids[v_cursor : v_cursor + v_qty - 1];
        v_cursor := v_cursor + v_qty;
      else
        v_units := public.pick_units(v_type_id, p_checkin, p_checkout, v_qty);
      end if;

      if coalesce(array_length(v_units, 1), 0) < v_qty then
        -- Not enough free units even before attempting the insert.
        raise exception using errcode = '23P01';
      end if;

      foreach v_unit in array v_units loop
        insert into allocations (unit_id, reservation_id, reason, stay)
        values (v_unit, v_res_id, 'booking', daterange(p_checkin, p_checkout, '[)'));

        v_allocs := v_allocs || jsonb_build_object(
          'unitId', v_unit, 'roomTypeId', v_type_id, 'ratePlanId', v_plan_id);
      end loop;
    end loop;

    v_result := jsonb_build_object(
      'ok', true,
      'reservation', jsonb_build_object(
        'id', v_res_id, 'code', v_code, 'guestId', v_guest_id,
        'checkin', p_checkin, 'checkout', p_checkout, 'source', p_source),
      'allocations', v_allocs);

  exception when exclusion_violation then
    -- The subtransaction is gone: reservation, guest and every allocation made
    -- in this call are rolled back. Zero partial state.
    select count(*) into v_available
      from public.free_units_for_stay(v_failed_type, p_checkin, p_checkout);

    v_result := jsonb_build_object(
      'ok', false, 'code', 'UNITS_TAKEN',
      'roomTypeId', v_failed_type,
      'requested', v_failed_qty,
      'available', coalesce(v_available, 0));
  end;

  return v_result;
end;
$$;

revoke all on function public.free_units_for_stay(uuid, date, date) from public, anon, authenticated;
revoke all on function public.pick_units(uuid, date, date, integer) from public, anon, authenticated;
revoke all on function public.create_reservation(jsonb, date, date, jsonb, text, uuid[], boolean)
  from public, anon, authenticated;
