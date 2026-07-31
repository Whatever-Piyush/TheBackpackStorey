-- Reception — events (docs/reception-definitions.md §1)
--
-- A reception activity feed, not an audit log. One event per desk action, written
-- in the SAME transaction as the mutation it describes: a booking that rolls back
-- leaves no event, so anything in the feed provably happened.
--
-- `move_allocation` and `block_unit` become plpgsql here for exactly that reason —
-- as client-side single statements they could not write an event atomically.
--
-- create_reservation / cancel_reservation are re-created (unchanged logic, plus the
-- event + an actor argument). 0011 is left intact.

-- ------------------------------------------------------------------ events
create table if not exists events (
  id             uuid primary key default gen_random_uuid(),
  at             timestamptz not null default now(),
  -- 'noun.verb'. No CHECK: a new event type is an INSERT, not a migration.
  kind           text not null,
  -- Deliberately NOT foreign keys. Two reasons, both forced by immutability:
  --   1. `on delete set null` is an UPDATE, which the BEFORE UPDATE trigger below
  --      refuses — a single FK would make deleting a reservation impossible.
  --   2. History must outlive the rows it describes. A feed entry saying a booking
  --      was cancelled should survive that booking being purged.
  actor_id       uuid,
  -- Snapshot, so the feed stays readable after a staff account is removed.
  actor_label    text,
  reservation_id uuid,
  unit_id        uuid,
  folio_id       uuid,
  -- Composed at log time so rendering the feed needs no joins.
  summary        text not null,
  payload        jsonb not null default '{}'::jsonb
);

-- The dashboard's "last 20 events".
create index if not exists events_at_idx on events (at desc);
create index if not exists events_reservation_idx on events (reservation_id);

-- RLS on with NO read policy: reads go through reception_dashboard(), which is
-- SECURITY DEFINER. anon loses everything; authenticated keeps only SELECT (which
-- RLS then denies anyway) and can never mutate.
alter table events enable row level security;

revoke update, delete on events from anon, authenticated;
revoke all on events from anon;

-- Immutability is enforced in the database, not by convention: a feed you can
-- rewrite is not evidence of anything. Blocks every caller, service_role included.
create or replace function public.events_immutable()
returns trigger
language plpgsql
as $$
begin
  raise exception 'events are immutable (attempted % on event %)',
    tg_op, coalesce(old.id::text, '?')
    using errcode = 'restrict_violation';
end;
$$;

drop trigger if exists events_no_update on events;
create trigger events_no_update before update on events
  for each row execute function public.events_immutable();

drop trigger if exists events_no_delete on events;
create trigger events_no_delete before delete on events
  for each row execute function public.events_immutable();

-- --------------------------------------------------------------- log_event
create or replace function public.log_event(
  p_kind           text,
  p_summary        text,
  p_actor_id       uuid    default null,
  p_actor_label    text    default null,
  p_reservation_id uuid    default null,
  p_unit_id        uuid    default null,
  p_folio_id       uuid    default null,
  p_payload        jsonb   default '{}'::jsonb
)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into events (kind, summary, actor_id, actor_label,
                      reservation_id, unit_id, folio_id, payload)
  values (p_kind, p_summary, p_actor_id, p_actor_label,
          p_reservation_id, p_unit_id, p_folio_id, coalesce(p_payload, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end;
$$;

-- ------------------------------------------------- create_reservation + event
drop function if exists public.create_reservation(jsonb, date, date, jsonb, text, uuid[], boolean);

create or replace function public.create_reservation(
  p_guest             jsonb,
  p_checkin           date,
  p_checkout          date,
  p_lines             jsonb,
  p_source            text,
  p_unit_ids          uuid[]  default null,
  p_respect_allotment boolean default true,
  p_actor_id          uuid    default null,
  p_actor_label       text    default null
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

  -- Registration/reporting only; dorms are mixed and gender never gates a bed.
  v_gender := nullif(p_guest ->> 'gender', '');

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_type_id := (v_line ->> 'roomTypeId')::uuid;
    if not exists (select 1 from room_types rt where rt.id = v_type_id) then
      return jsonb_build_object('ok', false, 'code', 'UNKNOWN_ROOM_TYPE',
                                'roomTypeId', v_type_id);
    end if;
  end loop;

  if p_respect_allotment then
    for v_line in select * from jsonb_array_elements(p_lines) loop
      v_type_id := (v_line ->> 'roomTypeId')::uuid;
      v_qty     := coalesce((v_line ->> 'qty')::int, 1);
      select min(d.available) into v_available
        from public.direct_availability(v_type_id, p_checkin, p_checkout) d;
      if coalesce(v_available, 0) < v_qty then
        return jsonb_build_object(
          'ok', false, 'code', 'NO_ALLOTMENT', 'roomTypeId', v_type_id,
          'requested', v_qty, 'available', coalesce(v_available, 0));
      end if;
    end loop;
  end if;

  -- ---- one subtransaction: reservation, allocations and event all-or-nothing ----
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

    -- Exactly ONE event, however many units the booking covers.
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
    -- Reservation, guest, allocations AND the event are all rolled back.
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

-- ------------------------------------------------- cancel_reservation + event
drop function if exists public.cancel_reservation(uuid);

create or replace function public.cancel_reservation(
  p_reservation_id uuid,
  p_actor_id       uuid default null,
  p_actor_label    text default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_current text;
  v_code    text;
  v_freed   integer;
begin
  select r.status, r.code into v_current, v_code
    from reservations r where r.id = p_reservation_id;

  if v_current is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_current in ('cancelled', 'checked_out', 'no_show') then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CLOSED', 'status', v_current);
  end if;

  delete from allocations where reservation_id = p_reservation_id;
  get diagnostics v_freed = row_count;

  update reservations set status = 'cancelled' where id = p_reservation_id;

  perform public.log_event(
    'reservation.cancelled',
    format('Reservation %s cancelled, %s unit%s released',
           v_code, v_freed, case when v_freed = 1 then '' else 's' end),
    p_actor_id, p_actor_label, p_reservation_id, null, null,
    jsonb_build_object('code', v_code, 'unitsReleased', v_freed,
                       'previousStatus', v_current));

  return jsonb_build_object('ok', true, 'unitsReleased', v_freed);
end;
$$;

-- ---------------------------------------------------- move_allocation + event
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
  v_from_no text;
  v_to_no   text;
begin
  select a.reservation_id, a.unit_id into v_res_id, v_from
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
    return jsonb_build_object('ok', false, 'code', 'UNIT_TAKEN');
  end;
end;
$$;

-- --------------------------------------------------------- block_unit + event
create or replace function public.block_unit(
  p_unit_id     uuid,
  p_checkin     date,
  p_checkout    date,
  p_reason      text default 'maintenance',
  p_actor_id    uuid default null,
  p_actor_label text default null
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_id     uuid;
  v_number text;
begin
  if p_checkout <= p_checkin then
    return jsonb_build_object('ok', false, 'code', 'INVALID_DATES');
  end if;

  select r.number into v_number
    from units u join rooms r on r.id = u.room_id where u.id = p_unit_id;
  if v_number is null then
    return jsonb_build_object('ok', false, 'code', 'UNKNOWN_UNIT');
  end if;

  begin
    insert into allocations (unit_id, reservation_id, reason, stay)
    values (p_unit_id, null, p_reason, daterange(p_checkin, p_checkout, '[)'))
    returning id into v_id;

    perform public.log_event(
      'unit.blocked',
      format('%s blocked (%s), %s to %s', v_number, p_reason, p_checkin, p_checkout),
      p_actor_id, p_actor_label, null, p_unit_id, null,
      jsonb_build_object('reason', p_reason, 'from', p_checkin, 'to', p_checkout));

    return jsonb_build_object('ok', true, 'allocationId', v_id);
  exception when exclusion_violation then
    return jsonb_build_object('ok', false, 'code', 'UNIT_TAKEN');
  end;
end;
$$;

-- --------------------------------------------------------------- privileges
revoke all on function public.log_event(text, text, uuid, text, uuid, uuid, uuid, jsonb)
  from public, anon, authenticated;
revoke all on function public.create_reservation(jsonb, date, date, jsonb, text, uuid[], boolean, uuid, text)
  from public, anon, authenticated;
revoke all on function public.cancel_reservation(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.move_allocation(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.block_unit(uuid, date, date, text, uuid, text) from public, anon, authenticated;
