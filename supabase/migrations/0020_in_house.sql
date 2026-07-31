-- Stays — in-house, extend, shorten, manual charges (ROADMAP M2 item 4)
--
-- Extending is the interesting one. A stay is N allocations, each a daterange
-- guarded by the frozen exclusion constraint. Widening them is an UPDATE that
-- either succeeds or raises 23P01 — we never look first and hope.
--
-- When it is refused, reception gets choices rather than an error:
--   move  — the whole stay shifts to a unit free for the WHOLE new range
--   split — they keep their bed for the booked nights and change to another for
--           the extra ones. This is a worse guest experience, so the caller has
--           to ask for it explicitly and the UI says so out loud.

-- ---------------------------------------------------------------- in-house
create or replace function public.stays_in_house(p_search text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_q     text;
  v_today date;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  v_q     := nullif(btrim(coalesce(p_search, '')), '');
  v_today := (now() at time zone 'Asia/Kolkata')::date;

  return jsonb_build_object(
    'today', v_today,
    'search', v_q,
    'stays', coalesce((
      select jsonb_agg(x order by x ->> 'checkout', x ->> 'guestName')
        from (
          select jsonb_build_object(
                   'reservationId', res.id,
                   'code', res.code,
                   'checkin', res.checkin,
                   'checkout', res.checkout,
                   'nights', res.checkout - res.checkin,
                   'nightsLeft', greatest(0, res.checkout - v_today),
                   'dueOutToday', res.checkout = v_today,
                   'guestName', coalesce(g.name, 'Guest'),
                   'guestPhone', g.phone,
                   'guests', (select count(*) from reservation_guests rg
                               where rg.reservation_id = res.id),
                   'units', coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'allocationId', a.id,
                              'unitId', u.id,
                              'roomTypeId', u.room_type_id,
                              'typeName', rt.name,
                              'room', rm.number,
                              'bed', b.label,
                              'from', lower(a.stay),
                              'to', upper(a.stay))
                            order by rm.number, b.label nulls first)
                       from allocations a
                       join units u on u.id = a.unit_id
                       join room_types rt on rt.id = u.room_type_id
                       join rooms rm on rm.id = u.room_id
                       left join beds b on b.id = u.bed_id
                      where a.reservation_id = res.id and a.reason = 'booking'
                   ), '[]'::jsonb),
                   'folio', public.stays_folio(res.id)
                 ) as x
            from reservations res
            left join guests g on g.id = res.guest_id
           where res.status = 'checked_in'
             and (
               v_q is null
               or g.name ilike '%' || v_q || '%'
               or g.phone ilike '%' || v_q || '%'
               or res.code ilike '%' || v_q || '%'
             )
        ) s
    ), '[]'::jsonb)
  );
end;
$$;

-- --------------------------------------------------------- extend options
-- What reception can offer when a straight extension is refused.
create or replace function public.stays_extend_options(
  p_reservation_id uuid,
  p_new_checkout   date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_res     record;
  v_alloc   record;
  v_blocked jsonb := '[]'::jsonb;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  select * into v_res from reservations where id = p_reservation_id;
  if v_res is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  for v_alloc in
    select a.id, a.unit_id, a.stay, u.room_type_id, rm.number, b.label
      from allocations a
      join units u on u.id = a.unit_id
      join rooms rm on rm.id = u.room_id
      left join beds b on b.id = u.bed_id
     where a.reservation_id = p_reservation_id and a.reason = 'booking'
  loop
    -- Can this unit simply keep the guest for the extra nights?
    if exists (
      select 1 from allocations x
       where x.unit_id = v_alloc.unit_id
         and x.id <> v_alloc.id
         and x.stay && daterange(upper(v_alloc.stay), p_new_checkout, '[)')
    ) then
      v_blocked := v_blocked || jsonb_build_object(
        'allocationId', v_alloc.id,
        'unit', v_alloc.number || coalesce(' · ' || v_alloc.label, ''),
        -- Free for the WHOLE stay: the guest keeps one bed throughout.
        'moveOptions', coalesce((
          select jsonb_agg(jsonb_build_object('unitId', f.unit_id,
                                              'label', f.room_number))
            from public.free_units_for_stay(v_alloc.room_type_id,
                                            lower(v_alloc.stay), p_new_checkout) f
        ), '[]'::jsonb),
        -- Free for the EXTRA nights only: the guest changes beds mid-stay.
        'splitOptions', coalesce((
          select jsonb_agg(jsonb_build_object('unitId', f.unit_id,
                                              'label', f.room_number))
            from public.free_units_for_stay(v_alloc.room_type_id,
                                            upper(v_alloc.stay), p_new_checkout) f
        ), '[]'::jsonb));
    end if;
  end loop;

  return jsonb_build_object('ok', true, 'blocked', v_blocked);
end;
$$;

-- ---------------------------------------------------------------- extend
-- p_plan (optional): [{allocationId, action:'move'|'split', unitId}]
create or replace function public.stays_extend(
  p_reservation_id uuid,
  p_new_checkout   date,
  p_plan           jsonb default null,
  p_actor_id       uuid  default null,
  p_actor_label    text  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res    record;
  v_alloc  record;
  v_step   jsonb;
  v_action text;
  v_unit   uuid;
  v_split  boolean := false;
  -- Allocations covered by a split keep their ORIGINAL dates: the new
  -- allocation carries the extra nights. Widening them would re-hit the very
  -- conflict the split exists to avoid.
  v_keep   uuid[] := array[]::uuid[];
  v_charge jsonb;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  select * into v_res from reservations where id = p_reservation_id;
  if v_res is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_res.status not in ('checked_in', 'confirmed', 'hold') then
    return jsonb_build_object('ok', false, 'code', 'NOT_EXTENDABLE', 'status', v_res.status);
  end if;
  if p_new_checkout <= v_res.checkout then
    return jsonb_build_object('ok', false, 'code', 'NOT_LATER',
                              'currentCheckout', v_res.checkout);
  end if;

  begin
    -- Any explicit moves happen first, so the widen below has room.
    if p_plan is not null then
      for v_step in select * from jsonb_array_elements(p_plan) loop
        v_action := v_step ->> 'action';
        v_unit   := (v_step ->> 'unitId')::uuid;

        if v_action = 'move' then
          update allocations set unit_id = v_unit
           where id = (v_step ->> 'allocationId')::uuid;
        elsif v_action = 'split' then
          -- The guest keeps their bed for the booked nights and takes another
          -- for the extra ones.
          insert into allocations (unit_id, reservation_id, reason, stay)
          values (v_unit, p_reservation_id, 'booking',
                  daterange(v_res.checkout, p_new_checkout, '[)'));
          v_keep  := v_keep || (v_step ->> 'allocationId')::uuid;
          v_split := true;
        end if;
      end loop;
    end if;

    -- Widen every allocation that still ends on the old checkout date. A split
    -- allocation already covers the extra nights and is left alone.
    for v_alloc in
      select a.id, a.stay from allocations a
       where a.reservation_id = p_reservation_id
         and a.reason = 'booking'
         and upper(a.stay) = v_res.checkout
         and not (a.id = any(v_keep))
    loop
      update allocations
         set stay = daterange(lower(v_alloc.stay), p_new_checkout, '[)')
       where id = v_alloc.id;
    end loop;

    update reservations set checkout = p_new_checkout where id = p_reservation_id;

  exception when exclusion_violation then
    -- Nothing moved, nothing widened. Hand back the choices instead.
    return jsonb_build_object(
      'ok', false, 'code', 'UNITS_TAKEN',
      'options', public.stays_extend_options(p_reservation_id, p_new_checkout));
  end;

  -- Extra nights are billed at the CURRENT calendar rate, not the booked one.
  v_charge := public.ensure_room_charges(p_reservation_id);

  perform public.log_event(
    'stay.extended',
    format('%s extended to %s%s',
           v_res.code, p_new_checkout,
           case when v_split then ' (changing beds)' else '' end),
    p_actor_id, p_actor_label, p_reservation_id, null, null,
    jsonb_build_object('from', v_res.checkout, 'to', p_new_checkout, 'split', v_split));

  return jsonb_build_object('ok', true, 'checkout', p_new_checkout,
                            'split', v_split, 'charges', v_charge);
end;
$$;

-- --------------------------------------------------------------- shorten
-- Narrowing can never violate the exclusion constraint, but it MUST remove the
-- room-night charges for nights the guest no longer stays, or they are billed
-- for a bed they were never in.
create or replace function public.stays_shorten(
  p_reservation_id uuid,
  p_new_checkout   date,
  p_actor_id       uuid default null,
  p_actor_label    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res     record;
  v_folio   uuid;
  v_removed integer := 0;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  select * into v_res from reservations where id = p_reservation_id;
  if v_res is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_res.status not in ('checked_in', 'confirmed', 'hold') then
    return jsonb_build_object('ok', false, 'code', 'NOT_EXTENDABLE', 'status', v_res.status);
  end if;
  if p_new_checkout >= v_res.checkout then
    return jsonb_build_object('ok', false, 'code', 'NOT_EARLIER',
                              'currentCheckout', v_res.checkout);
  end if;
  if p_new_checkout <= v_res.checkin then
    return jsonb_build_object('ok', false, 'code', 'TOO_SHORT',
                              'checkin', v_res.checkin);
  end if;

  select id into v_folio from folios
   where reservation_id = p_reservation_id and status = 'open'
   order by created_at limit 1;

  -- Refuse rather than silently editing a bill somebody has already paid.
  if v_folio is null and exists (
    select 1 from folios where reservation_id = p_reservation_id
  ) then
    return jsonb_build_object('ok', false, 'code', 'FOLIO_SETTLED');
  end if;

  -- Drop any allocation that now starts after the new checkout (a split tail),
  -- and clip the rest.
  delete from allocations
   where reservation_id = p_reservation_id
     and reason = 'booking'
     and lower(stay) >= p_new_checkout;

  update allocations
     set stay = daterange(lower(stay), p_new_checkout, '[)')
   where reservation_id = p_reservation_id
     and reason = 'booking'
     and upper(stay) > p_new_checkout;

  if v_folio is not null then
    delete from folio_items
     where folio_id = v_folio
       and kind = 'room_night'
       and stay_date >= p_new_checkout;
    get diagnostics v_removed = row_count;
  end if;

  update reservations set checkout = p_new_checkout where id = p_reservation_id;

  perform public.log_event(
    'stay.shortened',
    format('%s shortened to %s, %s night charge%s removed',
           v_res.code, p_new_checkout, v_removed,
           case when v_removed = 1 then '' else 's' end),
    p_actor_id, p_actor_label, p_reservation_id, null, v_folio,
    jsonb_build_object('from', v_res.checkout, 'to', p_new_checkout,
                       'chargesRemoved', v_removed));

  return jsonb_build_object('ok', true, 'checkout', p_new_checkout,
                            'chargesRemoved', v_removed);
end;
$$;

-- --------------------------------------------------------- manual charge
create or replace function public.stays_add_charge(
  p_reservation_id uuid,
  p_description    text,
  p_amount_paise   integer,
  p_kind           text default 'extra',
  p_actor_id       uuid default null,
  p_actor_label    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_folio uuid;
  v_desc  text;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  v_desc := nullif(btrim(coalesce(p_description, '')), '');
  if v_desc is null then
    return jsonb_build_object('ok', false, 'code', 'DESCRIPTION_REQUIRED');
  end if;
  if coalesce(p_amount_paise, 0) = 0 then
    return jsonb_build_object('ok', false, 'code', 'AMOUNT_REQUIRED');
  end if;
  if p_kind not in ('extra', 'food', 'beverage', 'discount') then
    return jsonb_build_object('ok', false, 'code', 'BAD_KIND');
  end if;

  select id into v_folio from folios
   where reservation_id = p_reservation_id and status = 'open'
   order by created_at limit 1;

  if v_folio is null then
    if not exists (select 1 from reservations where id = p_reservation_id) then
      return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
    end if;
    insert into folios (reservation_id, status) values (p_reservation_id, 'open')
    returning id into v_folio;
  end if;

  insert into folio_items (folio_id, kind, description, qty,
                           unit_price_paise, amount_paise, source, posted_by)
  values (v_folio, p_kind, v_desc, 1, p_amount_paise, p_amount_paise,
          'reception', p_actor_id);

  perform public.log_event(
    'folio.charged',
    format('%s posted to the folio: %s',
           to_char(p_amount_paise / 100.0, 'FM₹999999990.00'), v_desc),
    p_actor_id, p_actor_label, p_reservation_id, null, v_folio,
    jsonb_build_object('kind', p_kind, 'amountPaise', p_amount_paise));

  return jsonb_build_object('ok', true, 'folioId', v_folio);
end;
$$;

-- ---------------------------------------------------------------- no-show
-- For a booking that never arrived. Releases the inventory, same as a cancel,
-- but records WHY so the source can be judged later.
create or replace function public.stays_mark_no_show(
  p_reservation_id uuid,
  p_actor_id       uuid default null,
  p_actor_label    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res   record;
  v_freed integer;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  select * into v_res from reservations where id = p_reservation_id;
  if v_res is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  -- Someone standing in the building is not a no-show.
  if v_res.status <> 'confirmed' and v_res.status <> 'hold' then
    return jsonb_build_object('ok', false, 'code', 'NOT_PENDING', 'status', v_res.status);
  end if;

  delete from allocations where reservation_id = p_reservation_id;
  get diagnostics v_freed = row_count;

  update reservations set status = 'no_show' where id = p_reservation_id;

  perform public.log_event(
    'guest.no_show',
    format('%s marked no-show, %s unit%s released',
           v_res.code, v_freed, case when v_freed = 1 then '' else 's' end),
    p_actor_id, p_actor_label, p_reservation_id, null, null,
    jsonb_build_object('code', v_res.code, 'unitsReleased', v_freed));

  return jsonb_build_object('ok', true, 'unitsReleased', v_freed);
end;
$$;

revoke all on function public.stays_in_house(text) from public, anon;
revoke all on function public.stays_extend_options(uuid, date) from public, anon;
revoke all on function public.stays_extend(uuid, date, jsonb, uuid, text) from public, anon;
revoke all on function public.stays_shorten(uuid, date, uuid, text) from public, anon;
revoke all on function public.stays_add_charge(uuid, text, integer, text, uuid, text) from public, anon;
revoke all on function public.stays_mark_no_show(uuid, uuid, text) from public, anon;

grant execute on function public.stays_in_house(text) to authenticated;
grant execute on function public.stays_extend_options(uuid, date) to authenticated;
grant execute on function public.stays_extend(uuid, date, jsonb, uuid, text) to authenticated;
grant execute on function public.stays_shorten(uuid, date, uuid, text) to authenticated;
grant execute on function public.stays_add_charge(uuid, text, integer, text, uuid, text) to authenticated;
grant execute on function public.stays_mark_no_show(uuid, uuid, text) to authenticated;
