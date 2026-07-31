-- Stays — departures and checkout (ROADMAP M2 item 3)
--
-- NO TAX LINE AND NO INVOICE NUMBER. The property IS GST-registered, but the
-- slab treatment is deferred by decision: a ₹600 dorm bed is exempt while an
-- ₹1,800 room is at 5%, and the real rates aren't confirmed. `folio_items.tax_rate`
-- already exists per line and defaults to 0, so adding tax later is data, not
-- schema. Do not issue these as tax invoices until that lands.
--
-- Also closes a gap: nothing has ever posted ROOM NIGHTS to a folio, so a stay
-- with no café charges had no folio at all. Foundation §6 says room nights post
-- to the folio; ensure_room_charges() below does it, priced from the calendar.

-- Room-night lines need to say which unit and which night they are, both so the
-- statement reads correctly and so posting can be idempotent.
alter table folio_items add column if not exists unit_id uuid references units (id);
alter table folio_items add column if not exists stay_date date;

-- One line per unit per night. Re-running the poster can never double-charge.
create unique index if not exists folio_items_room_night_key
  on folio_items (folio_id, unit_id, stay_date)
  where kind = 'room_night';

-- ------------------------------------------------------- post room nights
-- Prices each night from the rate calendar. Refuses rather than guessing when a
-- night has no rate: a wrong bill handed to a guest is worse than a blocked one.
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

    -- Half-open: the checkout day is not a night.
    for v_date in
      select d::date from generate_series(lower(v_alloc.stay), upper(v_alloc.stay) - 1,
                                          interval '1 day') d
    loop
      -- The cheapest active plan for the type, matching quoteStay's default.
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

-- --------------------------------------------- post charges on arrival
-- The bill must be readable the moment a guest is in-house, not conjured at the
-- desk when they ask what they owe. A trigger covers every path into
-- 'checked_in' instead of each one remembering to post.
--
-- Deliberately does NOT fail check-in: if a night has no rate the charge is
-- simply not posted, and the same function refuses again at checkout, where the
-- gap actually matters.
create or replace function public.post_room_charges_on_checkin()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'checked_in' and coalesce(old.status, '') <> 'checked_in' then
    perform public.ensure_room_charges(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_post_room_charges on reservations;
create trigger reservations_post_room_charges
  after update of status on reservations
  for each row execute function public.post_room_charges_on_checkin();

-- ------------------------------------------------------------ folio view
-- The statement reception reads out at the desk.
create or replace function public.stays_folio(p_reservation_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_folio uuid;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  select id into v_folio from folios
   where reservation_id = p_reservation_id
   order by (status = 'open') desc, created_at limit 1;

  return jsonb_build_object(
    'folioId', v_folio,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', fi.id, 'kind', fi.kind, 'description', fi.description,
               'qty', fi.qty, 'unitPricePaise', fi.unit_price_paise,
               'amountPaise', fi.amount_paise, 'stayDate', fi.stay_date,
               'source', fi.source, 'postedAt', fi.posted_at)
             order by fi.stay_date nulls last, fi.posted_at)
        from folio_items fi where fi.folio_id = v_folio
    ), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', p.id, 'method', p.method, 'amountPaise', p.amount_paise,
               'reference', p.reference, 'receivedAt', p.received_at)
             order by p.received_at)
        from payments p where p.folio_id = v_folio
    ), '[]'::jsonb),
    'chargesPaise', coalesce((select sum(amount_paise) from folio_items where folio_id = v_folio), 0),
    'paidPaise',    coalesce((select sum(amount_paise) from payments    where folio_id = v_folio), 0),
    'balancePaise',
      coalesce((select sum(amount_paise) from folio_items where folio_id = v_folio), 0)
      - coalesce((select sum(amount_paise) from payments where folio_id = v_folio), 0),
    -- Shown, never hidden: an unsettled café order blocks checkout.
    'openOrders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id, 'ref', upper(left(o.id::text, 8)),
               'status', o.status, 'totalPaise', o.total_paise,
               'where', coalesce('Table ' || o.table_label, rm.number, o.type))
             order by o.created_at)
        from orders o
        left join rooms rm on rm.id = o.room_id
       where o.status not in ('paid', 'void')
         and (
           o.folio_id = v_folio
           or o.room_id in (
             select u.room_id from allocations a join units u on u.id = a.unit_id
              where a.reservation_id = p_reservation_id)
         )
    ), '[]'::jsonb)
  );
end;
$$;

-- ------------------------------------------------------------ departures
create or replace function public.stays_departures(
  p_date   date default null,
  p_search text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_date date;
  v_q    text;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  v_date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date);
  v_q    := nullif(btrim(coalesce(p_search, '')), '');

  return jsonb_build_object(
    'date', v_date,
    'search', v_q,
    'departures', coalesce((
      select jsonb_agg(x order by (x ->> 'overdue')::boolean desc, x ->> 'guestName')
        from (
          select jsonb_build_object(
                   'reservationId', res.id,
                   'code', res.code,
                   'status', res.status,
                   'checkin', res.checkin,
                   'checkout', res.checkout,
                   -- Still in-house past their checkout date.
                   'overdue', res.checkout < v_date,
                   'guestName', coalesce(g.name, 'Guest'),
                   'guestPhone', g.phone,
                   'guests', (select count(*) from reservation_guests rg
                               where rg.reservation_id = res.id),
                   'rooms', coalesce((
                     select jsonb_agg(distinct rm.number)
                       from allocations a
                       join units u on u.id = a.unit_id
                       join rooms rm on rm.id = u.room_id
                      where a.reservation_id = res.id
                   ), '[]'::jsonb),
                   'folio', public.stays_folio(res.id)
                 ) as x
            from reservations res
            left join guests g on g.id = res.guest_id
           where res.status = 'checked_in'
             and res.checkout <= v_date
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

-- -------------------------------------------------------------- checkout
create or replace function public.stays_checkout(
  p_reservation_id uuid,
  p_payments       jsonb default '[]'::jsonb,
  p_discount_paise integer default 0,
  p_discount_reason text default null,
  p_actor_id       uuid default null,
  p_actor_label    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res      record;
  v_folio    uuid;
  v_charges  jsonb;
  v_p        jsonb;
  v_open     integer;
  v_balance  integer;
  v_rooms    text;
  v_guest    text;
  v_paid     integer := 0;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  select * into v_res from reservations where id = p_reservation_id;
  if v_res is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_res.status = 'checked_out' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CHECKED_OUT');
  end if;
  if v_res.status <> 'checked_in' then
    return jsonb_build_object('ok', false, 'code', 'NOT_IN_HOUSE', 'status', v_res.status);
  end if;

  -- A discount without a stated reason is how a till leaks.
  if coalesce(p_discount_paise, 0) > 0
     and nullif(btrim(coalesce(p_discount_reason, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'REASON_REQUIRED');
  end if;

  -- Make sure the room nights are on the bill before anyone pays it.
  v_charges := public.ensure_room_charges(p_reservation_id);
  if not (v_charges ->> 'ok')::boolean then
    return v_charges;
  end if;
  v_folio := (v_charges ->> 'folioId')::uuid;

  -- Show it, don't hide it: an unsettled café order stops checkout.
  select count(*) into v_open
    from orders o
   where o.status not in ('paid', 'void')
     and (o.folio_id = v_folio
          or o.room_id in (select u.room_id from allocations a
                             join units u on u.id = a.unit_id
                            where a.reservation_id = p_reservation_id));
  if v_open > 0 then
    return jsonb_build_object('ok', false, 'code', 'OPEN_ORDERS', 'open', v_open,
                              'folio', public.stays_folio(p_reservation_id));
  end if;

  if coalesce(p_discount_paise, 0) > 0 then
    insert into folio_items (folio_id, kind, description, qty, unit_price_paise,
                             amount_paise, source)
    values (v_folio, 'discount', btrim(p_discount_reason), 1,
            -p_discount_paise, -p_discount_paise, 'reception');
  end if;

  for v_p in select * from jsonb_array_elements(coalesce(p_payments, '[]'::jsonb)) loop
    if (v_p ->> 'method') not in ('cash', 'upi', 'card', 'razorpay', 'ota_prepaid') then
      return jsonb_build_object('ok', false, 'code', 'BAD_METHOD',
                                'method', v_p ->> 'method');
    end if;
    insert into payments (folio_id, method, amount_paise, reference, received_by)
    values (v_folio, v_p ->> 'method', (v_p ->> 'amountPaise')::int,
            nullif(v_p ->> 'reference', ''), p_actor_id);
    v_paid := v_paid + (v_p ->> 'amountPaise')::int;
  end loop;

  select coalesce((select sum(amount_paise) from folio_items where folio_id = v_folio), 0)
       - coalesce((select sum(amount_paise) from payments where folio_id = v_folio), 0)
    into v_balance;

  -- Nobody leaves owing money without an explicit decision to write it off.
  if v_balance > 0 then
    return jsonb_build_object('ok', false, 'code', 'BALANCE_DUE',
                              'balancePaise', v_balance,
                              'folio', public.stays_folio(p_reservation_id));
  end if;

  update folios set status = 'settled' where id = v_folio;

  update reservations set status = 'checked_out' where id = p_reservation_id;

  -- Every room they occupied now needs cleaning.
  update rooms set housekeeping = 'dirty'
   where id in (select u.room_id from allocations a join units u on u.id = a.unit_id
                 where a.reservation_id = p_reservation_id);

  select string_agg(distinct rm.number, ', ' order by rm.number) into v_rooms
    from allocations a join units u on u.id = a.unit_id join rooms rm on rm.id = u.room_id
   where a.reservation_id = p_reservation_id;

  select g.name into v_guest from guests g where g.id = v_res.guest_id;

  perform public.log_event(
    'guest.checked_out',
    format('%s checked out of %s, %s settled',
           coalesce(v_guest, 'Guest'), coalesce(v_rooms, '—'),
           to_char(v_paid / 100.0, 'FM₹999999990.00')),
    p_actor_id, p_actor_label, p_reservation_id, null, v_folio,
    jsonb_build_object('code', v_res.code, 'paidPaise', v_paid,
                       'discountPaise', coalesce(p_discount_paise, 0),
                       'rooms', v_rooms));

  return jsonb_build_object('ok', true, 'folioId', v_folio, 'paidPaise', v_paid,
                            'rooms', v_rooms, 'code', v_res.code);
end;
$$;

revoke all on function public.ensure_room_charges(uuid) from public, anon;
revoke all on function public.stays_folio(uuid) from public, anon;
revoke all on function public.stays_departures(date, text) from public, anon;
revoke all on function public.stays_checkout(uuid, jsonb, integer, text, uuid, text) from public, anon;

grant execute on function public.stays_folio(uuid) to authenticated;
grant execute on function public.stays_departures(date, text) to authenticated;
grant execute on function public.stays_checkout(uuid, jsonb, integer, text, uuid, text) to authenticated;
