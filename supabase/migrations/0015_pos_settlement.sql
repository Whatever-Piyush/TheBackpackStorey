-- Café POS — settlement, charge-to-room, and the day report (ROADMAP M1)
--
-- Since 0007 `payments.folio_id` is NOT NULL, so café money flows through the
-- SAME folio engine as room charges (foundation §6). A counter sale opens a
-- walk-in folio, posts its lines, takes a payment and settles in one call;
-- "charge to room" posts the same lines onto the guest's OPEN folio instead, and
-- the money is collected at checkout.
--
-- These are SECURITY DEFINER because folios / folio_items / payments are
-- deny-by-default and the POS runs on the authenticated (not service-role)
-- client. Each one re-checks `public.user_role()` internally.

-- Which folio a café order was posted to. Nullable: an unsettled order has none.
alter table orders add column if not exists folio_id uuid references folios (id);
create index if not exists orders_folio_idx on orders (folio_id);

-- ------------------------------------------------------------ day close
create table if not exists pos_day_closes (
  id           uuid primary key default gen_random_uuid(),
  close_date   date not null unique,
  closed_by    uuid references auth.users (id),
  closed_label text,
  closed_at    timestamptz not null default now(),
  -- Snapshot of the totals as they stood at close. Kept verbatim so a late
  -- edit can never silently rewrite a day that was already signed off.
  totals       jsonb not null
);

alter table pos_day_closes enable row level security;
revoke all on pos_day_closes from anon, authenticated;

-- --------------------------------------------------------------- helpers
-- Front-desk roles that may operate the till.
create or replace function public.pos_can_operate()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  -- coalesce is load-bearing: `NULL not in (...)` is NULL, not TRUE, so a user
  -- with no profiles row would sail through an unguarded check.
  select coalesce(public.user_role(), '') in ('owner', 'manager', 'reception');
$$;

/**
 * A café line's folio kind. Drinks post as 'beverage' so the folio (and any
 * future tax treatment) can tell them apart from food.
 */
create or replace function public.pos_item_kind(p_station text)
returns text
language sql
immutable
as $$
  select case when p_station in ('bar', 'coffee') then 'beverage' else 'food' end;
$$;

/** Post an order's lines onto a folio. Assumes the caller opened a transaction. */
create or replace function public.pos_post_lines(p_order_id uuid, p_folio_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_discount integer;
begin
  insert into folio_items (folio_id, kind, description, qty,
                           unit_price_paise, amount_paise, source)
  select p_folio_id,
         public.pos_item_kind(mi.kitchen_station),
         mi.name,
         oi.qty,
         oi.price_paise,
         oi.price_paise * oi.qty,
         'pos'
    from order_items oi
    join menu_items mi on mi.id = oi.menu_item_id
   where oi.order_id = p_order_id;

  select discount_paise into v_discount from orders where id = p_order_id;
  if coalesce(v_discount, 0) > 0 then
    -- Discounts are negative folio lines, never a reduced unit price: the
    -- original price stays visible on the guest's statement.
    insert into folio_items (folio_id, kind, description, qty,
                             unit_price_paise, amount_paise, source)
    values (p_folio_id, 'discount', 'Café discount', 1, -v_discount, -v_discount, 'pos');
  end if;
end;
$$;

-- ----------------------------------------------------- checked-in guests
-- The charge-to-room picker. `reservations` is deny-by-default, so the POS
-- cannot read it directly; this returns the minimum needed to choose a guest.
create or replace function public.pos_checked_in_guests()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.pos_can_operate() then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(x order by x ->> 'guestName')
      from (
        select jsonb_build_object(
                 'reservationId', res.id,
                 'code', res.code,
                 'guestName', coalesce(g.name, 'Guest'),
                 'rooms', coalesce(jsonb_agg(distinct rm.number)
                                   filter (where rm.number is not null), '[]'::jsonb)
               ) as x
          from reservations res
          left join guests g on g.id = res.guest_id
          left join allocations a on a.reservation_id = res.id
          left join units u on u.id = a.unit_id
          left join rooms rm on rm.id = u.room_id
         where res.status = 'checked_in'
         group by res.id, g.name
      ) s
  ), '[]'::jsonb);
end;
$$;

-- --------------------------------------------------------- settle (counter)
create or replace function public.pos_settle_order(
  p_order_id uuid,
  p_method   text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order  record;
  v_folio  uuid;
begin
  if not public.pos_can_operate() then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;
  if p_method not in ('cash', 'upi', 'card') then
    return jsonb_build_object('ok', false, 'code', 'BAD_METHOD');
  end if;

  select * into v_order from orders where id = p_order_id;
  if v_order is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_order.status in ('paid', 'void') then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CLOSED',
                              'status', v_order.status);
  end if;

  -- A counter sale is a walk-in folio: no reservation, settled immediately.
  insert into folios (reservation_id, table_no, status)
  values (null, v_order.table_label, 'settled')
  returning id into v_folio;

  perform public.pos_post_lines(p_order_id, v_folio);

  insert into payments (folio_id, method, amount_paise, reference, received_by)
  values (v_folio, p_method, v_order.total_paise,
          'pos.' || left(p_order_id::text, 8), p_actor_id);

  update orders set status = 'paid', folio_id = v_folio where id = p_order_id;

  return jsonb_build_object('ok', true, 'folioId', v_folio,
                            'totalPaise', v_order.total_paise);
end;
$$;

-- ------------------------------------------------------- charge to room
create or replace function public.pos_charge_to_room(
  p_order_id       uuid,
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
  v_order record;
  v_res   record;
  v_guest text;
  v_folio uuid;
begin
  if not public.pos_can_operate() then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  select * into v_order from orders where id = p_order_id;
  if v_order is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_order.status in ('paid', 'void') then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CLOSED',
                              'status', v_order.status);
  end if;

  select res.*, coalesce(g.name, 'Guest') as guest_name into v_res
    from reservations res
    left join guests g on g.id = res.guest_id
   where res.id = p_reservation_id;

  if v_res is null then
    return jsonb_build_object('ok', false, 'code', 'NO_RESERVATION');
  end if;
  -- Only an in-house guest has a room to charge to.
  if v_res.status <> 'checked_in' then
    return jsonb_build_object('ok', false, 'code', 'NOT_CHECKED_IN',
                              'status', v_res.status);
  end if;
  v_guest := v_res.guest_name;

  -- Reuse the guest's open folio; open one if this is their first charge.
  select id into v_folio
    from folios
   where reservation_id = p_reservation_id and status = 'open'
   order by created_at
   limit 1;

  if v_folio is null then
    insert into folios (reservation_id, status) values (p_reservation_id, 'open')
    returning id into v_folio;
  end if;

  perform public.pos_post_lines(p_order_id, v_folio);

  -- No payments row: the money is collected at checkout, not at the counter.
  update orders set status = 'paid', folio_id = v_folio where id = p_order_id;

  -- Reception must see this before they settle the guest at checkout.
  perform public.log_event(
    'order.charged_to_room',
    format('Café order %s (%s) charged to %s',
           upper(left(p_order_id::text, 8)),
           to_char(v_order.total_paise / 100.0, 'FM₹999999990.00'),
           v_guest),
    p_actor_id, p_actor_label, p_reservation_id, null, v_folio,
    jsonb_build_object('orderId', p_order_id, 'totalPaise', v_order.total_paise));

  return jsonb_build_object('ok', true, 'folioId', v_folio,
                            'guestName', v_guest, 'totalPaise', v_order.total_paise);
end;
$$;

-- ------------------------------------------------------------- day report
-- "Today" is Asia/Kolkata, computed here (docs/reception-definitions.md §3).
create or replace function public.pos_today(p_date date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_date date;
  v_from timestamptz;
  v_to   timestamptz;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  v_date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date);
  v_from := (v_date::timestamp at time zone 'Asia/Kolkata');
  v_to   := ((v_date + 1)::timestamp at time zone 'Asia/Kolkata');

  return jsonb_build_object(
    'date', v_date,

    'orders', coalesce((
      select jsonb_agg(x order by x ->> 'createdAt' desc)
        from (
          select jsonb_build_object(
                   'id', o.id,
                   'ref', upper(left(o.id::text, 8)),
                   'type', o.type,
                   'tableLabel', o.table_label,
                   'status', o.status,
                   'createdAt', o.created_at,
                   'totalPaise', o.total_paise,
                   'discountPaise', o.discount_paise,
                   'items', (select count(*) from order_items oi where oi.order_id = o.id),
                   'chargedToRoom', (o.folio_id is not null and not exists (
                       select 1 from payments p where p.folio_id = o.folio_id)),
                   'method', (select p.method from payments p
                               where p.folio_id = o.folio_id limit 1)
                 ) as x
            from orders o
           where o.created_at >= v_from and o.created_at < v_to
        ) s
    ), '[]'::jsonb),

    -- Cash / UPI / card actually taken at the counter today.
    'byMethod', coalesce((
      select jsonb_agg(jsonb_build_object('method', m.method,
                                          'count', m.n,
                                          'totalPaise', m.total)
                       order by m.method)
        from (
          select p.method, count(*) as n, sum(p.amount_paise) as total
            from payments p
            join orders o on o.folio_id = p.folio_id
           where o.created_at >= v_from and o.created_at < v_to
           group by p.method
        ) m
    ), '[]'::jsonb),

    'summary', (
      select jsonb_build_object(
        'orders',        count(*),
        'open',          count(*) filter (where o.status not in ('paid', 'void')),
        'settled',       count(*) filter (where o.status = 'paid'),
        'void',          count(*) filter (where o.status = 'void'),
        'grossPaise',    coalesce(sum(o.total_paise) filter (where o.status = 'paid'), 0),
        'openPaise',     coalesce(sum(o.total_paise) filter (where o.status not in ('paid','void')), 0),
        'discountPaise', coalesce(sum(o.discount_paise), 0),
        'toRoomPaise',   coalesce(sum(o.total_paise) filter (
                           where o.status = 'paid' and o.folio_id is not null
                             and not exists (select 1 from payments p where p.folio_id = o.folio_id)), 0))
        from orders o
       where o.created_at >= v_from and o.created_at < v_to
    ),

    'closed', (
      select case when dc.id is null then null
                  else jsonb_build_object('at', dc.closed_at, 'by', dc.closed_label)
             end
        from pos_day_closes dc where dc.close_date = v_date
    )
  );
end;
$$;

-- ---------------------------------------------------------------- close day
create or replace function public.pos_close_day(
  p_date        date default null,
  p_actor_id    uuid default null,
  p_actor_label text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_date   date;
  v_totals jsonb;
  v_open   integer;
begin
  -- Signing off the day's takings is an owner action.
  if coalesce(public.user_role(), '') <> 'owner' then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  v_date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date);

  if exists (select 1 from pos_day_closes where close_date = v_date) then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CLOSED');
  end if;

  v_totals := public.pos_today(v_date);
  v_open := (v_totals -> 'summary' ->> 'open')::int;

  -- Closing with unsettled orders would bake a wrong number into the snapshot.
  if v_open > 0 then
    return jsonb_build_object('ok', false, 'code', 'OPEN_ORDERS', 'open', v_open);
  end if;

  insert into pos_day_closes (close_date, closed_by, closed_label, totals)
  values (v_date, p_actor_id, p_actor_label, v_totals -> 'summary');

  return jsonb_build_object('ok', true, 'date', v_date,
                            'totals', v_totals -> 'summary');
end;
$$;

-- --------------------------------------------------------------- privileges
revoke all on function public.pos_can_operate() from public, anon;
revoke all on function public.pos_post_lines(uuid, uuid) from public, anon, authenticated;
revoke all on function public.pos_checked_in_guests() from public, anon;
revoke all on function public.pos_settle_order(uuid, text, uuid) from public, anon;
revoke all on function public.pos_charge_to_room(uuid, uuid, uuid, text) from public, anon;
revoke all on function public.pos_today(date) from public, anon;
revoke all on function public.pos_close_day(date, uuid, text) from public, anon;

grant execute on function public.pos_checked_in_guests() to authenticated;
grant execute on function public.pos_settle_order(uuid, text, uuid) to authenticated;
grant execute on function public.pos_charge_to_room(uuid, uuid, uuid, text) to authenticated;
grant execute on function public.pos_today(date) to authenticated;
grant execute on function public.pos_close_day(date, uuid, text) to authenticated;
