-- Booking holds + lazy expiry (Phase 9, Phase 3)
--
-- A HOLD is an INVENTORY CLAIM, never a financial event. Creating a hold reserves
-- units (the frozen exclusion constraint arbitrates the race) but posts NO room
-- charges, NO folio, NO payment. Room charges appear only when a hold is promoted to
-- confirmed. Payment state never enters reservations.status — the lifecycle stays
-- hold / confirmed / checked_in / checked_out / cancelled / no_show, unchanged.
--
-- Expiry is LAZY: an expired hold (hold_expires_at <= now()) simply stops blocking
-- inventory. There is no sweep, cron, or worker — correctness never depends on a
-- background process. The reservation row is kept (historical); only its ability to
-- block inventory ends. Two mechanisms make that consistent:
--   • inventory_snapshot IGNORES expired-hold allocations (availability display);
--   • create_reservation REAPS overlapping expired-hold allocations just-in-time,
--     before it allocates, so the exclusion constraint agrees with availability.

-- --------------------------------------------------------- hold_expires_at
-- NULL for confirmed/walk-in/OTA and once a hold is promoted; set to a server time
-- for a website hold. Additive, no change to the status enum.
alter table reservations add column if not exists hold_expires_at timestamptz;

-- Why a reservation reached 'cancelled'. Set to 'hold_expired' when a lapsed hold's
-- slot is reclaimed by a new booking (below). Additive column, NOT a status value;
-- the remaining reasons are for the Phase 5 cancellation flow. Nullable.
alter table reservations add column if not exists cancellation_reason text
  check (cancellation_reason is null
         or cancellation_reason in ('guest', 'hold_expired', 'no_show', 'staff', 'payment_failed'));

-- ------------------------------------------------------ reap expired holds
-- The reclaim step of lazy expiry, called from the create_reservation WRITE PATH
-- (below) inside the SAME transaction as the new allocation. For every expired hold
-- still holding a unit of this type over the requested window it:
--   1. removes ALL of that hold's allocations, so the frozen exclusion constraint no
--      longer blocks the unit (the constraint is never touched — the blocking ROW is);
--   2. records the terminal state: status='cancelled', cancellation_reason='hold_expired'.
-- The reservation is kept as history. NO financial record is created or touched — a
-- hold never had a folio, charge, or payment. SECURITY DEFINER so the delete/update
-- run as owner past the deny-by-default RLS. Idempotent; safe when nothing expired.
create or replace function public.release_expired_holds(
  p_room_type_id uuid,
  p_checkin      date,
  p_checkout     date
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ids uuid[];
  v_n   integer;
begin
  select array_agg(distinct r.id) into v_ids
    from reservations r
    join allocations a on a.reservation_id = r.id
    join units u       on u.id = a.unit_id
   where r.status = 'hold'
     and r.hold_expires_at is not null
     and r.hold_expires_at <= now()
     and a.reason = 'booking'
     and u.room_type_id = p_room_type_id
     and a.stay && daterange(p_checkin, p_checkout, '[)');

  if v_ids is null then
    return 0;
  end if;

  delete from allocations where reservation_id = any(v_ids);
  get diagnostics v_n = row_count;

  update reservations
     set status = 'cancelled', cancellation_reason = 'hold_expired'
   where id = any(v_ids);

  return v_n;
end;
$$;

-- ---------------------------------------------- free units ignore expired holds
-- 0011's version, but an allocation belonging to an EXPIRED hold no longer counts as
-- occupying its unit — so pick_units (which reads this) offers the unit as available
-- the instant the hold lapses, matching inventory_snapshot. The still-present row is
-- removed by release_expired_holds before the new allocation is inserted.
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
         left join reservations res on res.id = a.reservation_id
        where a.unit_id = u.id
          and a.stay && daterange(p_checkin, p_checkout, '[)')
          and not coalesce(res.status = 'hold' and res.hold_expires_at <= now(), false)
     )
   order by (r.housekeeping = 'clean') desc, r.number, u.id;
$$;

-- ---------------------------------------------------- pooled inventory snapshot
-- Identical to 0027 except the allocation count now IGNORES expired-hold
-- allocations, so a lapsed hold's bed reads as free the instant it expires — no job
-- required. An allocation counts UNLESS its reservation is a hold past its expiry;
-- maintenance/owner blocks (reservation_id null) and active holds still block.
create or replace function public.inventory_snapshot(
  p_room_type uuid,
  p_from      date,
  p_to        date
)
returns table (
  stay_date   date,
  total_units integer,
  free_units  integer,
  price_paise integer,
  closed      boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with nights as (
    select d::date as stay_date
      from generate_series(p_from, p_to - 1, interval '1 day') as d
  ),
  total as (
    select count(*)::int as units
      from units u
      join rooms r on r.id = u.room_id
     where u.room_type_id = p_room_type and u.active and r.active
  )
  select
    n.stay_date,
    (select t.units from total t),
    (select t.units from total t) - (
      select count(*)::int
        from allocations a
        join units u on u.id = a.unit_id
        join rooms r on r.id = u.room_id
        left join reservations res on res.id = a.reservation_id
       where u.room_type_id = p_room_type
         and u.active and r.active
         and a.stay @> n.stay_date
         -- Lazy expiry: an expired hold no longer occupies the unit.
         and not coalesce(res.status = 'hold' and res.hold_expires_at <= now(), false)
    ),
    rt.price_paise,
    coalesce(rt.closed, false)
  from nights n
  left join lateral (
    select ra.price_paise, ra.closed
      from rates ra
      join rate_plans rp on rp.id = ra.rate_plan_id
     where ra.room_type_id = p_room_type
       and ra.stay_date = n.stay_date
       and rp.active
     order by rp.min_nights, ra.price_paise
     limit 1
  ) rt on true
  order by n.stay_date;
$$;

-- ------------------------------------------------------- create_reservation
-- 0028's engine, plus:
--   • p_hold_minutes — when set (server-controlled; the website booking path passes
--     it), the reservation is created as a HOLD expiring now()+p_hold_minutes and NO
--     room charges are posted. When NULL (walk-in/phone/OTA), behaviour is unchanged:
--     an immediately-confirmed reservation. The client never supplies this or an
--     expiry — the server decides.
--   • a just-in-time reap of expired-hold allocations before each line is allocated,
--     so a unit freed by a lapsed hold can be re-taken without any sweep.
-- Allocations are still created at hold time; the frozen exclusion constraint remains
-- the sole arbiter of the inventory race, before any money is involved.
drop function if exists public.create_reservation(jsonb, date, date, jsonb, text, uuid[], uuid, text);

create or replace function public.create_reservation(
  p_guest        jsonb,
  p_checkin      date,
  p_checkout     date,
  p_lines        jsonb,
  p_source       text,
  p_unit_ids     uuid[]  default null,
  p_actor_id     uuid    default null,
  p_actor_label  text    default null,
  p_hold_minutes integer default null
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
  v_status      text;
  v_expires     timestamptz;
begin
  if p_checkout <= p_checkin then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DATES');
  end if;
  if p_lines is null or jsonb_array_length(p_lines) = 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_LINES');
  end if;
  if not exists (select 1 from channels where code = p_source and active) then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_CHANNEL', 'source', p_source);
  end if;

  -- A hold, or an immediate confirmation. The expiry is a server time; there is no
  -- client-supplied expires_at anywhere in this path.
  if p_hold_minutes is not null then
    v_status  := 'hold';
    v_expires := now() + make_interval(mins => p_hold_minutes);
  else
    v_status  := 'confirmed';
    v_expires := null;
  end if;

  v_gender := nullif(p_guest ->> 'gender', '');

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_type_id := (v_line ->> 'roomTypeId')::uuid;
    if not exists (select 1 from room_types rt where rt.id = v_type_id) then
      return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ROOM_TYPE', 'roomTypeId', v_type_id);
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

    insert into reservations (guest_id, status, hold_expires_at, source, checkin, checkout, adults, children, notes)
    values (v_guest_id, v_status, v_expires, p_source, p_checkin, p_checkout,
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

      -- Free any units this type is holding under an expired hold, so a lapsed hold
      -- never blocks a fresh booking even though no sweep has run.
      perform public.release_expired_holds(v_type_id, p_checkin, p_checkout);

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
      format('%s %s %s unit%s, %s to %s',
             coalesce(nullif(p_guest ->> 'name', ''), 'Guest'),
             case when v_status = 'hold' then 'held' else 'booked' end,
             v_total, case when v_total = 1 then '' else 's' end,
             p_checkin, p_checkout),
      p_actor_id, p_actor_label, v_res_id, null, null,
      jsonb_build_object('code', v_code, 'source', p_source, 'status', v_status,
                         'units', v_total, 'lines', p_lines));

    v_result := jsonb_build_object(
      'ok', true,
      'reservation', jsonb_build_object(
        'id', v_res_id, 'code', v_code, 'guestId', v_guest_id,
        'status', v_status, 'holdExpiresAt', v_expires,
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

-- --------------------------------------------------------------- confirm_hold
-- The promotion primitive Phase 4 will call once a deposit is captured. Atomic and
-- idempotent: a hold becomes confirmed, its policy/deposit are snapshotted, and its
-- room charges are posted — exactly once. Calling it again is a no-op success.
--
-- Room charges are created ONLY here (after confirmation), never at hold time, and
-- ensure_room_charges' unique index (folio_id, unit_id, stay_date) is the real guard
-- against duplicate folio lines — not an application "if not exists".
create or replace function public.confirm_hold(p_reservation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res     reservations%rowtype;
  v_policy  cancellation_policies%rowtype;
  v_pct     numeric;
  v_min     integer;
  v_charges jsonb;
  v_folio   uuid;
  v_total   integer;
  v_deposit integer;
  v_cutoff  timestamptz;
begin
  select * into v_res from reservations where id = p_reservation_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  -- Idempotent: already promoted (confirmed with a snapshot) → return what exists,
  -- touch nothing.
  if v_res.status = 'confirmed' and v_res.policy_version_id is not null then
    return jsonb_build_object('ok', true, 'alreadyConfirmed', true,
                              'reservationId', v_res.id, 'code', v_res.code,
                              'status', 'confirmed',
                              'depositPaise', v_res.deposit_amount_paise);
  end if;
  if v_res.status <> 'hold' then
    return jsonb_build_object('ok', false, 'code', 'NOT_A_HOLD', 'status', v_res.status);
  end if;
  if v_res.hold_expires_at is null or v_res.hold_expires_at <= now() then
    return jsonb_build_object('ok', false, 'code', 'EXPIRED');
  end if;
  if not exists (select 1 from allocations a
                  where a.reservation_id = p_reservation_id and a.reason = 'booking') then
    return jsonb_build_object('ok', false, 'code', 'NO_INVENTORY');
  end if;

  -- Resolve the policy from the ACTUAL booking time and arrival date (Phase 2).
  select * into v_policy
    from public.resolve_cancellation_policy(v_res.created_at, v_res.checkin);
  if v_policy.id is null then
    raise exception 'no cancellation policy resolves for reservation %', p_reservation_id;
  end if;

  select dc.percent, dc.min_amount_paise into v_pct, v_min
    from deposit_config dc
   where dc.effective_from <= now() and (dc.effective_to is null or now() < dc.effective_to)
   order by dc.effective_from desc, dc.version desc
   limit 1;
  if v_pct is null then
    raise exception 'no active deposit configuration';
  end if;

  -- Promote first, THEN post room charges (charges exist only after confirmation).
  update reservations set status = 'confirmed', hold_expires_at = null
   where id = p_reservation_id;

  v_charges := public.ensure_room_charges(p_reservation_id);
  if not (v_charges ->> 'ok')::boolean then
    -- A missing rate must not leave a half-confirmed booking: roll the whole thing back.
    raise exception 'ensure_room_charges failed for %: %', p_reservation_id, v_charges;
  end if;
  v_folio := (v_charges ->> 'folioId')::uuid;

  select coalesce(sum(amount_paise), 0) into v_total
    from folio_items where folio_id = v_folio;
  v_deposit := public.compute_deposit_paise(v_total, v_pct, v_min);
  v_cutoff  := public.cancellation_cutoff(v_res.checkin, v_policy.cutoff_hours);

  update reservations set
    policy_version_id        = v_policy.id,
    policy_text_snapshot     = v_policy.body_text,
    cancellation_cutoff_at   = v_cutoff,
    deposit_percent_snapshot = v_pct,
    deposit_amount_paise     = v_deposit
  where id = p_reservation_id;

  perform public.log_event(
    'reservation.confirmed',
    format('%s confirmed, deposit %s of %s',
           v_res.code,
           to_char(v_deposit / 100.0, 'FM₹999999990.00'),
           to_char(v_total   / 100.0, 'FM₹999999990.00')),
    null, 'Payment', p_reservation_id, null, v_folio,
    jsonb_build_object('code', v_res.code, 'totalPaise', v_total,
                       'depositPaise', v_deposit, 'policyVersion', v_policy.version));

  return jsonb_build_object('ok', true, 'reservationId', v_res.id, 'code', v_res.code,
                            'status', 'confirmed', 'folioId', v_folio,
                            'totalPaise', v_total, 'depositPaise', v_deposit,
                            'depositPercent', v_pct, 'cancellationCutoffAt', v_cutoff,
                            'policyVersion', v_policy.version);
end;
$$;

-- --------------------------------------------------------------- privileges
-- create_reservation stays service-role only (0032's finding); the new signature is
-- granted explicitly rather than leaning on default privileges the harness omits.
revoke all on function public.create_reservation(jsonb, date, date, jsonb, text, uuid[], uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_reservation(jsonb, date, date, jsonb, text, uuid[], uuid, text, integer)
  to service_role;

revoke all on function public.release_expired_holds(uuid, date, date) from public, anon;
grant execute on function public.release_expired_holds(uuid, date, date) to service_role;

revoke all on function public.confirm_hold(uuid) from public, anon, authenticated;
grant execute on function public.confirm_hold(uuid) to service_role;
