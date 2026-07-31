-- Stays — occupancy board (ROADMAP M2 item 1)
--
-- ONE query for the whole visible range: the board is a single JSON document,
-- same rule as reception_dashboard. A 8-9 row × 14 day grid needs no paging, no
-- virtualisation and no drag-and-drop library.
--
-- Also replaces move_allocation so a rejected move can SAY WHICH reservation is
-- in the way. Returning a bare UNIT_TAKEN makes reception guess, and at a desk
-- with a guest standing there, guessing is the expensive part.

-- ------------------------------------------------------------------- board
create or replace function public.stays_board(
  p_from date default null,
  p_days integer default 14
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from  date;
  v_days  integer;
  v_to    date;
  v_range daterange;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception', 'housekeeping') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  -- Default window starts today in Asia/Kolkata, never the browser's clock.
  v_from  := coalesce(p_from, (now() at time zone 'Asia/Kolkata')::date);
  v_days  := least(greatest(coalesce(p_days, 14), 1), 60);
  v_to    := v_from + v_days;
  v_range := daterange(v_from, v_to, '[)');

  return jsonb_build_object(
    'from', v_from,
    'days', v_days,
    'today', (now() at time zone 'Asia/Kolkata')::date,

    'dates', (
      select jsonb_agg(d::date order by d)
        from generate_series(v_from, v_to - 1, interval '1 day') as d
    ),

    -- Rooms with their sellable units. A dorm's beds nest under the dorm room;
    -- a private room has exactly one unit whose label is null.
    'rooms', coalesce((
      select jsonb_agg(x order by x ->> 'number')
        from (
          select jsonb_build_object(
                   'roomId', r.id,
                   'number', r.number,
                   'roomTypeId', rt.id,
                   'typeName', rt.name,
                   'typeCode', rt.code,
                   'sellMode', rt.sell_mode,
                   'housekeeping', r.housekeeping,
                   'units', coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'unitId', u.id,
                              'label', b.label)
                            order by b.label nulls first)
                       from units u
                       left join beds b on b.id = u.bed_id
                      where u.room_id = r.id and u.active
                   ), '[]'::jsonb)
                 ) as x
            from rooms r
            join room_types rt on rt.id = r.room_type_id
           where r.active and rt.active
        ) s
    ), '[]'::jsonb),

    -- Every allocation touching the window: bookings AND blocks.
    'allocations', coalesce((
      select jsonb_agg(x order by x ->> 'from')
        from (
          select jsonb_build_object(
                   'id', a.id,
                   'unitId', a.unit_id,
                   'reason', a.reason,
                   'from', lower(a.stay),
                   'to', upper(a.stay),
                   'reservationId', a.reservation_id,
                   'code', res.code,
                   'status', res.status,
                   'guestName', coalesce(g.name, null),
                   'guestPhone', g.phone,
                   'adults', res.adults,
                   'children', res.children,
                   -- Units on the same reservation, so the drawer can say
                   -- "3 beds" instead of showing one bar in isolation.
                   'unitsOnReservation', (
                     select count(*) from allocations sib
                      where sib.reservation_id = a.reservation_id
                   )
                 ) as x
            from allocations a
            left join reservations res on res.id = a.reservation_id
            left join guests g on g.id = res.guest_id
           where a.stay && v_range
        ) s
    ), '[]'::jsonb)
  );
end;
$$;

-- ------------------------------------------------- move_allocation, upgraded
-- Identical behaviour, except the UNIT_TAKEN payload now carries the conflict.
create or replace function public.move_allocation(
  p_allocation_id uuid,
  p_to_unit_id    uuid,
  p_actor_id      uuid default null,
  p_actor_label   text default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_res_id  uuid;
  v_from    uuid;
  v_stay    daterange;
  v_from_no text;
  v_to_no   text;
  v_clash   jsonb;
begin
  select a.reservation_id, a.unit_id, a.stay into v_res_id, v_from, v_stay
    from allocations a where a.id = p_allocation_id;
  if v_from is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select r.number into v_from_no from units u join rooms r on r.id = u.room_id where u.id = v_from;
  select r.number into v_to_no   from units u join rooms r on r.id = u.room_id where u.id = p_to_unit_id;
  if v_to_no is null then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_UNIT');
  end if;

  begin
    update allocations set unit_id = p_to_unit_id where id = p_allocation_id;

    perform public.log_event(
      'allocation.moved',
      format('Moved from %s to %s', v_from_no, v_to_no),
      p_actor_id, p_actor_label, v_res_id, p_to_unit_id, null,
      jsonb_build_object('fromUnitId', v_from, 'toUnitId', p_to_unit_id));

    return jsonb_build_object('ok', true);
  exception when exclusion_violation then
    -- Name the obstruction. The subtransaction has rolled back, so this reads
    -- committed state.
    select jsonb_build_object(
             'reason', a.reason,
             'code', res.code,
             'guestName', coalesce(g.name, null),
             'from', lower(a.stay),
             'to', upper(a.stay))
      into v_clash
      from allocations a
      left join reservations res on res.id = a.reservation_id
      left join guests g on g.id = res.guest_id
     where a.unit_id = p_to_unit_id and a.stay && v_stay
     limit 1;

    return jsonb_build_object('ok', false, 'code', 'UNIT_TAKEN',
                              'toRoom', v_to_no, 'conflict', v_clash);
  end;
end;
$$;

revoke all on function public.stays_board(date, integer) from public, anon;
grant execute on function public.stays_board(date, integer) to authenticated;
revoke all on function public.move_allocation(uuid, uuid, uuid, text) from public, anon, authenticated;
