-- Public availability and quoting (ROADMAP M3 item 1)
--
-- The only functions in the system granted to `anon`. They return COUNTS AND
-- PRICES AND NOTHING ELSE — no unit ids, no reservation ids, no guest data. A
-- public endpoint that leaks which bed is free is a public endpoint that leaks
-- who is in it.
--
-- Availability is `min(physical free, direct allotment − direct bookings)`, so
-- the website can never sell inventory reserved for the OTAs (foundation §5).

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

  -- Never trust the caller with a range. The past is not sellable and the
  -- window is capped so this can't be used to scrape a year of data per call.
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
               'date', d.stay_date,
               'free', greatest(0, d.available),
               -- Sellable only with inventory AND an open price for that night.
               'bookable', d.available > 0
                           and r.price_paise is not null
                           and not coalesce(r.closed, false),
               'pricePaise', r.price_paise)
             order by d.stay_date)
        from public.direct_availability(p_room_type, v_from, v_to) d
        left join lateral (
          select ra.price_paise, ra.closed
            from rates ra
            join rate_plans rp on rp.id = ra.rate_plan_id
           where ra.room_type_id = p_room_type
             and ra.stay_date = d.stay_date
             and rp.active
           order by rp.min_nights, ra.price_paise
           limit 1
        ) r on true
    ), '[]'::jsonb)
  );
end;
$$;

-- ------------------------------------------------------------------ quote
-- Per-night breakdown for a specific stay. Refuses rather than guessing when a
-- night has no price, and refuses when the allotment can't cover the request.
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

  select jsonb_agg(jsonb_build_object('date', n.stay_date, 'pricePaise', n.price)
                   order by n.stay_date),
         count(*) filter (where n.price is null),
         count(*) filter (where n.available < v_units),
         sum(coalesce(n.price, 0)),
         count(*)
    into v_nights, v_missing, v_short, v_total, v_count
    from (
      select d.stay_date, d.available, r.price_paise as price
        from public.direct_availability(p_room_type, p_checkin, p_checkout) d
        left join lateral (
          select ra.price_paise
            from rates ra
            join rate_plans rp on rp.id = ra.rate_plan_id
           where ra.room_type_id = p_room_type
             and ra.stay_date = d.stay_date
             and rp.active
             and not ra.closed
           order by rp.min_nights, ra.price_paise
           limit 1
        ) r on true
    ) n;

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
    -- Per-unit and grand total: a dorm quote for 3 beds is 3 × the nightly sum.
    'unitTotalPaise', v_total,
    'totalPaise', v_total * v_units);
end;
$$;

-- The public site is unauthenticated, so these two are the exception.
revoke all on function public.public_availability(uuid, date, date) from public;
revoke all on function public.public_quote(uuid, date, date, integer) from public;
grant execute on function public.public_availability(uuid, date, date) to anon, authenticated;
grant execute on function public.public_quote(uuid, date, date, integer) to anon, authenticated;
