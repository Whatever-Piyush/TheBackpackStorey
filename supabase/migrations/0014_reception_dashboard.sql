-- Reception — dashboard (Step 4)
--
-- ONE round trip. Internet in Bir is patchy and eight queries is eight chances
-- to fail, so every widget is assembled here and returned as a single JSON
-- document.
--
-- SECURITY DEFINER because the underlying tables are deny-by-default; the caller
-- is the authenticated user's JWT (NOT the service role), and membership of
-- `staff` is verified before any data is read.
--
-- Occupancy follows docs/reception-definitions.md §2: blocked and out-of-order
-- units are excluded from BOTH numerator and denominator.

create or replace function public.reception_dashboard(p_date date default null)
returns jsonb
language plpgsql
stable                       -- read-only, no side effects
security definer
set search_path = public, pg_temp
as $$
declare
  v_date     date;
  v_next     date;
  v_night    daterange;
  v_sold     integer;
  v_sellable integer;
  v_result   jsonb;
begin
  if not public.is_staff() then
    raise exception 'not reception staff' using errcode = 'insufficient_privilege';
  end if;

  -- "Today" is always Asia/Kolkata, computed here. Never the browser clock:
  -- a tablet with a wrong timezone must not change which arrivals are shown.
  v_date := coalesce(p_date, (now() at time zone 'Asia/Kolkata')::date);
  v_next := v_date + 1;
  v_night := daterange(v_date, v_next, '[)');

  -- ---- occupancy (unit-nights for the single night) ----
  select count(*) into v_sold
    from allocations a
    join units u on u.id = a.unit_id
    join rooms r on r.id = u.room_id
    join reservations res on res.id = a.reservation_id
   where a.reason = 'booking'
     and a.stay && v_night
     and u.active and r.active
     and res.status in ('hold', 'confirmed', 'checked_in', 'checked_out');

  select count(*) into v_sellable
    from units u
    join rooms r on r.id = u.room_id
   where u.active
     and r.active
     and r.housekeeping <> 'out_of_order'
     and not exists (
       select 1 from allocations b
        where b.unit_id = u.id
          and b.reason <> 'booking'      -- maintenance / owner_use / hold
          and b.stay && v_night
     );

  select jsonb_build_object(
    'date', v_date,

    -- ---- today's arrivals ----
    'arrivals', coalesce((
      select jsonb_agg(x order by x ->> 'code')
        from (
          select jsonb_build_object(
                   'reservationId', res.id,
                   'code', res.code,
                   'guestName', coalesce(g.name, 'Guest'),
                   'guestPhone', g.phone,
                   'status', res.status,
                   'nights', res.checkout - res.checkin,
                   'adults', res.adults,
                   'children', res.children,
                   'units', count(a.id),
                   'rooms', coalesce(jsonb_agg(distinct rm.number)
                                     filter (where rm.number is not null), '[]'::jsonb)
                 ) as x
            from reservations res
            left join guests g on g.id = res.guest_id
            left join allocations a on a.reservation_id = res.id
            left join units u on u.id = a.unit_id
            left join rooms rm on rm.id = u.room_id
           where res.checkin = v_date
             and res.status in ('hold', 'confirmed')
           group by res.id, g.name, g.phone
        ) s
    ), '[]'::jsonb),

    -- ---- today's departures ----
    'departures', coalesce((
      select jsonb_agg(x order by x ->> 'code')
        from (
          select jsonb_build_object(
                   'reservationId', res.id,
                   'code', res.code,
                   'guestName', coalesce(g.name, 'Guest'),
                   'guestPhone', g.phone,
                   'status', res.status,
                   'units', count(a.id),
                   'rooms', coalesce(jsonb_agg(distinct rm.number)
                                     filter (where rm.number is not null), '[]'::jsonb)
                 ) as x
            from reservations res
            left join guests g on g.id = res.guest_id
            left join allocations a on a.reservation_id = res.id
            left join units u on u.id = a.unit_id
            left join rooms rm on rm.id = u.room_id
           where res.checkout = v_date
             and res.status in ('confirmed', 'checked_in')
           group by res.id, g.name, g.phone
        ) s
    ), '[]'::jsonb),

    -- ---- in-house ----
    'inHouse', (
      select jsonb_build_object(
               'reservations', count(*),
               'guests', coalesce(sum(res.adults + res.children), 0))
        from reservations res
       where res.status = 'checked_in'
         and daterange(res.checkin, res.checkout, '[)') && v_night
    ),

    -- ---- occupancy ----
    'occupancy', jsonb_build_object(
      'sold', v_sold,
      'sellable', v_sellable,
      'pct', case when v_sellable > 0
                  then round((v_sold::numeric / v_sellable) * 100, 1)
                  else 0 end),

    -- ---- available units by room type (tonight) ----
    'availableByType', coalesce((
      select jsonb_agg(x order by x ->> 'sortOrder', x ->> 'name')
        from (
          select jsonb_build_object(
                   'roomTypeId', rt.id,
                   'code', rt.code,
                   'name', rt.name,
                   'sellMode', rt.sell_mode,
                   'sortOrder', rt.sort_order,
                   'total', count(u.id) filter (where u.active),
                   'available', count(u.id) filter (
                     where u.active and not exists (
                       select 1 from allocations a
                        where a.unit_id = u.id and a.stay && v_night))
                 ) as x
            from room_types rt
            left join units u on u.room_type_id = rt.id
            left join rooms r on r.id = u.room_id and r.active
           where rt.active
           group by rt.id
        ) s
    ), '[]'::jsonb),

    -- ---- units needing cleaning ----
    'needsCleaning', coalesce((
      select jsonb_agg(x order by x ->> 'number')
        from (
          select jsonb_build_object(
                   'roomId', r.id,
                   'number', r.number,
                   'housekeeping', r.housekeeping,
                   'units', count(u.id)
                 ) as x
            from rooms r
            left join units u on u.room_id = r.id and u.active
           where r.active and r.housekeeping in ('dirty', 'out_of_order')
           group by r.id
        ) s
    ), '[]'::jsonb),

    -- ---- open folios carrying a balance (integer paise) ----
    'openFolios', coalesce((
      select jsonb_agg(x order by (x ->> 'balancePaise')::bigint desc)
        from (
          select jsonb_build_object(
                   'folioId', f.id,
                   'reservationId', f.reservation_id,
                   'code', res.code,
                   'guestName', coalesce(g.name, 'Walk-in'),
                   'tableNo', f.table_no,
                   'balancePaise', coalesce(items.total, 0) - coalesce(paid.total, 0)
                 ) as x
            from folios f
            left join reservations res on res.id = f.reservation_id
            left join guests g on g.id = res.guest_id
            left join lateral (
              select sum(fi.amount_paise) as total from folio_items fi where fi.folio_id = f.id
            ) items on true
            left join lateral (
              select sum(p.amount_paise) as total from payments p where p.folio_id = f.id
            ) paid on true
           where f.status = 'open'
             and coalesce(items.total, 0) - coalesce(paid.total, 0) > 0
        ) s
    ), '[]'::jsonb),

    -- ---- last 20 reception events ----
    'events', coalesce((
      select jsonb_agg(x order by x ->> 'at' desc)
        from (
          select jsonb_build_object(
                   'id', e.id,
                   'at', e.at,
                   'kind', e.kind,
                   'actorLabel', e.actor_label,
                   'summary', e.summary,
                   'reservationId', e.reservation_id
                 ) as x
            from events e
           order by e.at desc
           limit 20
        ) s
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function public.reception_dashboard(date) from public;
revoke execute on function public.reception_dashboard(date) from anon;
grant execute on function public.reception_dashboard(date) to authenticated;
