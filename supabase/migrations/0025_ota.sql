-- OTA control — allotment grid and fast OTA entry (ROADMAP M5)
--
-- The website may sell only its allotment; everything else belongs to the OTAs.
-- The database enforces the direct side of that, but it CANNOT stop an OTA
-- selling a bed you forgot to close in their extranet — that booking arrives as
-- an email, not an insert. Hence the banner, and hence fast manual entry.

-- An OTA's own confirmation number. Two staff reading the same email must not
-- both type it in.
alter table reservations add column if not exists external_ref text;

create unique index if not exists reservations_external_ref_key
  on reservations (source, external_ref)
  where external_ref is not null;

-- ------------------------------------------- OTA bookings price themselves
-- `ensure_room_charges` bills from OUR rate calendar. An OTA booking was priced
-- by the OTA, and its amount is posted at entry — so letting the calendar post
-- as well would charge the guest twice.
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

  -- The OTA set the price; our calendar has nothing to say about it.
  if v_res.source like 'ota\_%' then
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
       where r.room_type_id = v_type
         and r.stay_date = v_date
         and rp.active
         and not r.closed
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

-- ------------------------------------------------------------ allotment grid
create or replace function public.stays_allotment(
  p_from date default null,
  p_days integer default 30
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date;
  v_days integer;
begin
  -- Owner-only: this decides what the public engine is allowed to sell.
  if coalesce(public.user_role(), '') not in ('owner', 'manager') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  v_from := coalesce(p_from, (now() at time zone 'Asia/Kolkata')::date);
  v_days := least(greatest(coalesce(p_days, 30), 1), 90);

  return jsonb_build_object(
    'from', v_from,
    'days', v_days,
    'today', (now() at time zone 'Asia/Kolkata')::date,
    'dates', (
      select jsonb_agg(d::date order by d)
        from generate_series(v_from, v_from + v_days - 1, interval '1 day') as d
    ),
    'types', coalesce((
      select jsonb_agg(x order by x ->> 'sortOrder', x ->> 'name')
        from (
          select jsonb_build_object(
                   'roomTypeId', rt.id,
                   'code', rt.code,
                   'name', rt.name,
                   'sellMode', rt.sell_mode,
                   'sortOrder', rt.sort_order,
                   'unitNoun', case when rt.sell_mode = 'per_bed' then 'bed' else 'room' end,
                   -- The physical ceiling: an allotment above this is fiction.
                   'totalUnits', (
                     select count(*) from units u
                      join rooms rm on rm.id = u.room_id
                     where u.room_type_id = rt.id and u.active and rm.active
                   ),
                   'days', coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'date', d.stay_date,
                              'allotted', coalesce(da.units_for_direct, 0),
                              -- What the direct engine can actually sell today.
                              'available', greatest(0, least(
                                (select count(*) from units u
                                   join rooms rm on rm.id = u.room_id
                                  where u.room_type_id = rt.id and u.active and rm.active
                                    and not exists (
                                      select 1 from allocations a
                                       where a.unit_id = u.id
                                         and a.stay @> d.stay_date)),
                                coalesce(da.units_for_direct, 0) - (
                                  select count(*)
                                    from allocations a
                                    join units u on u.id = a.unit_id
                                    join reservations r on r.id = a.reservation_id
                                   where u.room_type_id = rt.id
                                     and a.stay @> d.stay_date
                                     and r.source not like 'ota\_%'
                                     and r.status in ('hold','confirmed','checked_in'))
                              )))
                            order by d.stay_date)
                       from (
                         select g::date as stay_date
                           from generate_series(v_from, v_from + v_days - 1, interval '1 day') g
                       ) d
                       left join direct_allotment da
                         on da.room_type_id = rt.id and da.stay_date = d.stay_date
                   ), '[]'::jsonb)
                 ) as x
            from room_types rt
           where rt.active
        ) s
    ), '[]'::jsonb)
  );
end;
$$;

-- ------------------------------------------------------------ set allotment
create or replace function public.set_allotment(
  p_room_type_id uuid,
  p_from         date,
  p_to           date,
  p_units        integer,
  p_actor_id     uuid default null,
  p_actor_label  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type  record;
  v_total integer;
  v_days  integer;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  select * into v_type from room_types where id = p_room_type_id and active;
  if v_type is null then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ROOM_TYPE');
  end if;
  if p_to < p_from then
    return jsonb_build_object('ok', false, 'code', 'INVALID_RANGE');
  end if;
  if p_to - p_from > 400 then
    return jsonb_build_object('ok', false, 'code', 'RANGE_TOO_LONG');
  end if;
  if p_units < 0 then
    return jsonb_build_object('ok', false, 'code', 'NEGATIVE');
  end if;

  select count(*) into v_total
    from units u join rooms rm on rm.id = u.room_id
   where u.room_type_id = p_room_type_id and u.active and rm.active;

  -- Promising more than exists is how a website oversells.
  if p_units > v_total then
    return jsonb_build_object('ok', false, 'code', 'ABOVE_CAPACITY',
                              'totalUnits', v_total);
  end if;

  insert into direct_allotment (room_type_id, stay_date, units_for_direct)
  select p_room_type_id, d::date, p_units
    from generate_series(p_from, p_to, interval '1 day') d
  on conflict (room_type_id, stay_date)
  do update set units_for_direct = excluded.units_for_direct;

  v_days := (p_to - p_from) + 1;

  perform public.log_event(
    'allotment.set',
    format('%s set to %s direct %s for %s day%s from %s',
           v_type.name, p_units,
           case when v_type.sell_mode = 'per_bed' then 'bed(s)' else 'room(s)' end,
           v_days, case when v_days = 1 then '' else 's' end, p_from),
    p_actor_id, p_actor_label, null, null, null,
    jsonb_build_object('roomTypeId', p_room_type_id, 'units', p_units,
                       'from', p_from, 'to', p_to));

  return jsonb_build_object('ok', true, 'days', v_days, 'units', p_units,
                            'totalUnits', v_total);
end;
$$;

-- --------------------------------------------------------- OTA booking entry
-- One call: reservation, folio, the OTA's amount, and a prepaid payment so the
-- guest never sees a balance at checkout for money they already handed over.
create or replace function public.create_ota_booking(
  p_source       text,
  p_guest_name   text,
  p_phone        text,
  p_checkin      date,
  p_checkout     date,
  p_room_type_id uuid,
  p_units        integer,
  p_reference    text,
  p_amount_paise integer,
  p_actor_id     uuid default null,
  p_actor_label  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type  record;
  v_res   jsonb;
  v_id    uuid;
  v_code  text;
  v_folio uuid;
  v_name  text;
  v_ref   text;
  v_nights integer;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  if p_source not like 'ota\_%' and p_source <> 'other' then
    return jsonb_build_object('ok', false, 'code', 'BAD_SOURCE');
  end if;

  v_name := nullif(btrim(coalesce(p_guest_name, '')), '');
  if v_name is null then
    return jsonb_build_object('ok', false, 'code', 'NAME_REQUIRED');
  end if;
  if coalesce(p_amount_paise, 0) < 0 then
    return jsonb_build_object('ok', false, 'code', 'BAD_AMOUNT');
  end if;

  v_ref := nullif(btrim(coalesce(p_reference, '')), '');
  -- Three staff read the same OTA email; only one booking should result.
  if v_ref is not null and exists (
    select 1 from reservations
     where source = p_source and external_ref = v_ref
  ) then
    return jsonb_build_object('ok', false, 'code', 'DUPLICATE_REFERENCE',
                              'reference', v_ref);
  end if;

  select * into v_type from room_types where id = p_room_type_id and active;
  if v_type is null then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ROOM_TYPE');
  end if;

  -- OTA inventory sits OUTSIDE the direct allotment, so it isn't capped by it.
  -- The exclusion constraint still guarantees no bed is sold twice.
  v_res := public.create_reservation(
    jsonb_build_object('name', v_name, 'phone', nullif(btrim(coalesce(p_phone, '')), '')),
    p_checkin, p_checkout,
    jsonb_build_array(jsonb_build_object(
      'roomTypeId', p_room_type_id, 'ratePlanId', null, 'qty', greatest(1, p_units))),
    p_source, null, false, p_actor_id, p_actor_label);

  if not (v_res ->> 'ok')::boolean then
    return v_res;
  end if;

  v_id   := (v_res -> 'reservation' ->> 'id')::uuid;
  v_code := v_res -> 'reservation' ->> 'code';
  v_nights := p_checkout - p_checkin;

  update reservations set external_ref = v_ref where id = v_id;

  insert into folios (reservation_id, status) values (v_id, 'open')
  returning id into v_folio;

  if p_amount_paise > 0 then
    insert into folio_items (folio_id, kind, description, qty,
                             unit_price_paise, amount_paise, source, posted_by)
    values (v_folio, 'room_night',
            format('%s via %s%s — %s night%s',
                   v_type.name, replace(p_source, 'ota_', ''),
                   coalesce(' ' || v_ref, ''), v_nights,
                   case when v_nights = 1 then '' else 's' end),
            1, p_amount_paise, p_amount_paise, 'ota', p_actor_id);

    -- Already paid to the OTA, so checkout shows nothing owing.
    insert into payments (folio_id, method, amount_paise, reference, received_by)
    values (v_folio, 'ota_prepaid', p_amount_paise, v_ref, p_actor_id);
  end if;

  perform public.log_event(
    'reservation.ota_entered',
    format('%s booking for %s entered%s',
           replace(p_source, 'ota_', ''), v_name,
           coalesce(' (' || v_ref || ')', '')),
    p_actor_id, p_actor_label, v_id, null, v_folio,
    jsonb_build_object('source', p_source, 'reference', v_ref,
                       'amountPaise', p_amount_paise, 'units', p_units));

  return jsonb_build_object('ok', true, 'reservationId', v_id, 'code', v_code,
                            'folioId', v_folio);
end;
$$;

revoke all on function public.stays_allotment(date, integer) from public, anon;
revoke all on function public.set_allotment(uuid, date, date, integer, uuid, text) from public, anon;
revoke all on function public.create_ota_booking(text, text, text, date, date, uuid, integer, text, integer, uuid, text)
  from public, anon;

grant execute on function public.stays_allotment(date, integer) to authenticated;
grant execute on function public.set_allotment(uuid, date, date, integer, uuid, text) to authenticated;
grant execute on function public.create_ota_booking(text, text, text, date, date, uuid, integer, text, integer, uuid, text)
  to authenticated;
