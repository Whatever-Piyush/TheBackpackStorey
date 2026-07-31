-- Pooled inventory everywhere (docs/Channel_manager.md §9b)
--
-- One calculation. `public_availability`, `public_quote` and the reservation
-- engine now all derive availability from `inventory_snapshot()` — physical
-- units minus allocations — and nothing consults `direct_allotment`.
--
-- This REMOVES the allotment cap. The website may now sell every free unit.
-- In `manual` distribution mode the protection against double-selling is the
-- outbox reminder on /stays/channel, not an artificial cap on the website.
--
-- `direct_allotment` is left in place with its data, unread, pending removal
-- once this has run in production for a while.

-- ------------------------------------------------- reservation engine, pooled
-- Identical to 0012's version except: the allotment block is gone, and with it
-- the `p_respect_allotment` parameter. There is nothing left to respect.
drop function if exists public.create_reservation(jsonb, date, date, jsonb, text, uuid[], boolean, uuid, text);

create or replace function public.create_reservation(
  p_guest       jsonb,
  p_checkin     date,
  p_checkout    date,
  p_lines       jsonb,
  p_source      text,
  p_unit_ids    uuid[] default null,
  p_actor_id    uuid   default null,
  p_actor_label text   default null
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
  v_cursor      integer := 1;
  v_gender      text;
  v_result      jsonb;
  v_allocs      jsonb := '[]'::jsonb;
  v_total       integer := 0;
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
  -- Channels are data now, so an unknown one is a caller error, not a CHECK.
  if not exists (select 1 from channels where code = p_source and active) then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_CHANNEL',
                              'source', p_source);
  end if;

  v_gender := nullif(p_guest ->> 'gender', '');

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_type_id := (v_line ->> 'roomTypeId')::uuid;
    if not exists (select 1 from room_types rt where rt.id = v_type_id) then
      return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ROOM_TYPE',
                                'roomTypeId', v_type_id);
    end if;
  end loop;

  begin
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
        v_units := p_unit_ids[v_cursor : v_cursor + v_qty - 1];
        v_cursor := v_cursor + v_qty;
      else
        v_units := public.pick_units(v_type_id, p_checkin, p_checkout, v_qty);
      end if;

      if coalesce(array_length(v_units, 1), 0) < v_qty then
        raise exception using errcode = '23P01';
      end if;

      foreach v_unit in array v_units loop
        insert into allocations (unit_id, reservation_id, reason, stay)
        values (v_unit, v_res_id, 'booking', daterange(p_checkin, p_checkout, '[)'));

        v_allocs := v_allocs || jsonb_build_object(
          'unitId', v_unit, 'roomTypeId', v_type_id, 'ratePlanId', v_plan_id);
        v_total := v_total + 1;
      end loop;
    end loop;

    perform public.log_event(
      'reservation.created',
      format('%s booked %s unit%s, %s to %s',
             coalesce(nullif(p_guest ->> 'name', ''), 'Guest'),
             v_total, case when v_total = 1 then '' else 's' end,
             p_checkin, p_checkout),
      p_actor_id, p_actor_label, v_res_id, null, null,
      jsonb_build_object('code', v_code, 'source', p_source,
                         'units', v_total, 'lines', p_lines));

    v_result := jsonb_build_object(
      'ok', true,
      'reservation', jsonb_build_object(
        'id', v_res_id, 'code', v_code, 'guestId', v_guest_id,
        'checkin', p_checkin, 'checkout', p_checkout, 'source', p_source),
      'allocations', v_allocs);

  exception when exclusion_violation then
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

-- ------------------------------------------------------- public availability
create or replace function public.public_availability(
  p_room_type uuid,
  p_from      date default null,
  p_to        date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_from  date;
  v_to    date;
begin
  if p_room_type is null
     or not exists (select 1 from room_types where id = p_room_type and active) then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ROOM_TYPE');
  end if;

  v_from := greatest(coalesce(p_from, v_today), v_today);
  v_to   := least(coalesce(p_to, v_from + 31), v_from + 400);
  if v_to <= v_from then
    v_to := v_from + 1;
  end if;

  return jsonb_build_object(
    'ok', true,
    'roomTypeId', p_room_type,
    'from', v_from,
    'to', v_to,
    'nights', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', s.stay_date,
               -- Pooled: every free unit is sellable here. The Channel Manager
               -- closes the others; we do not hold any back.
               'free', greatest(0, s.free_units),
               'bookable', s.free_units > 0
                           and s.price_paise is not null
                           and not s.closed,
               'pricePaise', s.price_paise)
             order by s.stay_date)
        from public.inventory_snapshot(p_room_type, v_from, v_to) s
    ), '[]'::jsonb)
  );
end;
$$;

-- --------------------------------------------------------------- public quote
create or replace function public.public_quote(
  p_room_type uuid,
  p_checkin   date,
  p_checkout  date,
  p_units     integer default 1
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_today   date := (now() at time zone 'Asia/Kolkata')::date;
  v_units   integer := greatest(1, least(coalesce(p_units, 1), 20));
  v_nights  jsonb;
  v_missing integer;
  v_short   integer;
  v_total   bigint;
  v_count   integer;
begin
  if p_room_type is null
     or not exists (select 1 from room_types where id = p_room_type and active) then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ROOM_TYPE');
  end if;
  if p_checkin is null or p_checkout is null or p_checkout <= p_checkin then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DATES');
  end if;
  if p_checkin < v_today then
    return jsonb_build_object('ok', false, 'code', 'IN_THE_PAST');
  end if;
  if p_checkout - p_checkin > 60 then
    return jsonb_build_object('ok', false, 'code', 'TOO_LONG');
  end if;

  select jsonb_agg(jsonb_build_object('date', n.stay_date, 'pricePaise', n.price_paise)
                   order by n.stay_date),
         count(*) filter (where n.price_paise is null or n.closed),
         count(*) filter (where n.free_units < v_units),
         sum(coalesce(n.price_paise, 0)),
         count(*)
    into v_nights, v_missing, v_short, v_total, v_count
    from public.inventory_snapshot(p_room_type, p_checkin, p_checkout) n;

  if coalesce(v_count, 0) = 0 or v_missing > 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_RATE');
  end if;
  if v_short > 0 then
    return jsonb_build_object('ok', false, 'code', 'NOT_AVAILABLE',
                              'requested', v_units);
  end if;

  return jsonb_build_object(
    'ok', true,
    'units', v_units,
    'nights', v_count,
    'perNight', v_nights,
    'unitTotalPaise', v_total,
    'totalPaise', v_total * v_units);
end;
$$;

-- ------------------------------------------- OTA pricing check, without LIKE
-- `source like 'ota\_%'` was string-matching a convention. Channels know their
-- own kind now, so a new OTA with any code behaves correctly.
create or replace function public.ensure_room_charges(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res     record;
  v_folio   uuid;
  v_alloc   record;
  v_date    date;
  v_price   integer;
  v_type    uuid;
  v_label   text;
  v_missing text[] := array[]::text[];
  v_posted  integer := 0;
begin
  select * into v_res from reservations where id = p_reservation_id;
  if v_res is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select id into v_folio from folios
   where reservation_id = p_reservation_id and status = 'open'
   order by created_at limit 1;

  if v_folio is null then
    insert into folios (reservation_id, status) values (p_reservation_id, 'open')
    returning id into v_folio;
  end if;

  -- The marketplace set the price; our calendar has nothing to say about it.
  if public.is_ota_channel(v_res.source) then
    return jsonb_build_object('ok', true, 'folioId', v_folio, 'posted', 0,
                              'skipped', 'ota_priced');
  end if;

  for v_alloc in
    select a.id, a.unit_id, a.stay, u.room_type_id, rm.number, b.label
      from allocations a
      join units u on u.id = a.unit_id
      join rooms rm on rm.id = u.room_id
      left join beds b on b.id = u.bed_id
     where a.reservation_id = p_reservation_id and a.reason = 'booking'
  loop
    v_type  := v_alloc.room_type_id;
    v_label := v_alloc.number || coalesce(' · ' || v_alloc.label, '');

    for v_date in
      select d::date from generate_series(lower(v_alloc.stay), upper(v_alloc.stay) - 1,
                                          interval '1 day') d
    loop
      select r.price_paise into v_price
        from rates r
        join rate_plans rp on rp.id = r.rate_plan_id
       where r.room_type_id = v_type and r.stay_date = v_date
         and rp.active and not r.closed
       order by rp.min_nights, r.price_paise
       limit 1;

      if v_price is null then
        v_missing := v_missing || to_char(v_date, 'YYYY-MM-DD');
        continue;
      end if;

      insert into folio_items (folio_id, kind, description, qty, unit_price_paise,
                               amount_paise, source, unit_id, stay_date)
      values (v_folio, 'room_night',
              format('%s — %s', v_label, to_char(v_date, 'DD Mon')),
              1, v_price, v_price, 'booking', v_alloc.unit_id, v_date)
      on conflict (folio_id, unit_id, stay_date) where kind = 'room_night'
      do nothing;

      if found then v_posted := v_posted + 1; end if;
    end loop;
  end loop;

  if array_length(v_missing, 1) > 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_RATE',
                              'folioId', v_folio, 'missing', to_jsonb(v_missing));
  end if;

  return jsonb_build_object('ok', true, 'folioId', v_folio, 'posted', v_posted);
end;
$$;

-- ---------------------------------------------------- retire the allotment
-- Nothing reads `direct_allotment` any more. The functions that managed it are
-- removed so no screen can present a number that does nothing; the TABLE and its
-- data are kept until this has run in production for a while.
drop function if exists public.direct_availability(uuid, date, date);
drop function if exists public.stays_allotment(date, integer);
drop function if exists public.set_allotment(uuid, date, date, integer, uuid, text);

comment on table direct_allotment is
  'DEPRECATED (0028): inventory is pooled; nothing reads this. Kept for its data pending removal.';
