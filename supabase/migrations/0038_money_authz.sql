-- Money authorization — one canonical predicate (Phase 9, gateway & policies)
--
-- The audit (docs/phase9-audit.md) confirmed there is no canonical money-visibility
-- predicate: pos_today() spelled the rule inline as
-- `user_role() in ('owner','manager')`, and the /pos/today page spelled a DIFFERENT,
-- tighter rule (`owner` only) in TypeScript. This migration replaces the inline SQL
-- rule with a single function so "who may see aggregate money" is defined once.
--
-- Scope is deliberately small and additive:
--   • create can_view_money()  — owner + manager, and nobody else
--   • route pos_today() through it (the only aggregate-money RPC today)
-- It does NOT touch transactional money (stays_folio, stays_checkout,
-- pos_settle_order, pos_charge_to_room), pos_can_operate(), or pos_close_day()
-- (owner-only day sign-off, redesigned in a later phase). staff.role is the
-- reception-console vocabulary and is not used for portal financial authorization.

-- --------------------------------------------------------- can_view_money()
-- May the caller see AGGREGATE financial information (revenue, by-method splits,
-- day totals)? True only for owner and manager.
--
-- SECURITY DEFINER + pinned search_path, exactly like user_role()/pos_can_operate:
-- it reads profiles.role for auth.uid() and never trusts a client-supplied role.
-- coalesce is load-bearing — `NULL in (...)` is NULL, not FALSE, so a user with no
-- profiles row must resolve to '' and fail closed rather than slip through.
create or replace function public.can_view_money()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.user_role(), '') in ('owner', 'manager');
$$;

revoke all on function public.can_view_money() from public, anon;
grant execute on function public.can_view_money() to authenticated, service_role;

-- ------------------------------------------------------------ pos_today()
-- Identical to 0015's definition except the inline
-- `user_role() in ('owner','manager')` guard is now can_view_money(). The report
-- shape and every figure are unchanged; only the authorization spelling moves.
--
-- It still RAISES (insufficient_privilege) rather than returning an empty report:
-- an empty result is indistinguishable from a genuinely quiet day and would teach a
-- refused caller nothing.
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
  if not public.can_view_money() then
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

-- create or replace preserves the existing ACL, but re-affirm it so this file reads
-- as the whole authorization story for pos_today.
revoke all on function public.pos_today(date) from public, anon;
grant execute on function public.pos_today(date) to authenticated;
