-- Transactional outbox + pooled inventory snapshot (docs/Channel_manager.md §3, §4)
--
-- An HTTP call cannot be rolled back, so the PMS never calls a Channel Manager
-- inside a transaction. It writes an INTENT to sync in the same transaction as
-- the booking, and a worker drains it. The booking and the intent commit or fail
-- together, so a sync can never be missed — and a Channel Manager outage delays
-- a sync without ever blocking a booking.

-- Monotonic ordering across every enqueue, so a stale availability number can
-- never land after a fresh one.
create sequence if not exists channel_outbox_seq;

create table if not exists channel_outbox (
  id              uuid primary key default gen_random_uuid(),
  -- What changed. Providers map these to their own API verbs.
  kind            text not null check (kind in
                    ('availability', 'rates', 'reservation_created',
                     'reservation_modified', 'reservation_cancelled')),
  -- What it changed FOR. Availability and rates are scoped to a room type and a
  -- date range; reservation events to a reservation.
  room_type_id    uuid references room_types (id) on delete cascade,
  from_date       date,
  to_date         date,
  reservation_id  uuid,
  sequence        bigint not null default nextval('channel_outbox_seq'),
  status          text not null default 'pending'
                  check (status in ('pending', 'sent', 'failed', 'superseded')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  -- Manual distribution: staff confirm they updated the extranets.
  requires_ack    boolean not null default false,
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users (id),
  provider_id     text,
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);

create index if not exists channel_outbox_pending_idx
  on channel_outbox (next_attempt_at) where status = 'pending';
create index if not exists channel_outbox_scope_idx
  on channel_outbox (kind, room_type_id, from_date, to_date) where status = 'pending';
create index if not exists channel_outbox_ack_idx
  on channel_outbox (created_at desc) where requires_ack and acknowledged_at is null;

alter table channel_outbox enable row level security;
revoke all on channel_outbox from anon, authenticated;

-- ------------------------------------------------- pooled inventory snapshot
-- THE availability calculation. One definition, used by the website, by the
-- outbox, and by anything else that asks.
--
-- Pooled and always pooled: physical units minus allocations. `direct_allotment`
-- is NOT consulted — distribution_mode changes how this number is published,
-- never how it is derived.
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
    -- Every allocation counts, whatever put it there: a website booking, an OTA
    -- reservation, or a maintenance block. One pool.
    (select t.units from total t) - (
      select count(*)::int
        from allocations a
        join units u on u.id = a.unit_id
        join rooms r on r.id = u.room_id
       where u.room_type_id = p_room_type
         and u.active and r.active
         and a.stay @> n.stay_date
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

-- ------------------------------------------------------------------ enqueue
create or replace function public.enqueue_channel_sync(
  p_kind         text,
  p_room_type_id uuid default null,
  p_from         date default null,
  p_to           date default null,
  p_reservation  uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  -- Coalesce: an unsent row for the same scope is replaced rather than queued
  -- behind. Ten bookings in a minute produce one push, not ten.
  if p_kind in ('availability', 'rates') then
    update channel_outbox
       set status = 'superseded'
     where status = 'pending'
       and kind = p_kind
       and room_type_id is not distinct from p_room_type_id
       and from_date <= p_to
       and to_date >= p_from;
  end if;

  insert into channel_outbox (kind, room_type_id, from_date, to_date, reservation_id,
                              requires_ack)
  values (p_kind, p_room_type_id, p_from, p_to, p_reservation,
          public.distribution_mode() = 'manual');
end;
$$;

-- ------------------------------------------------------------------ triggers
-- On the TABLES, not in the functions. Extend, move, block, cancel and any
-- future feature all mutate `allocations`, so all of them sync for free and
-- none of them has to remember to.
create or replace function public.allocations_enqueue_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type uuid;
  v_row  record;
begin
  v_row := coalesce(new, old);

  select u.room_type_id into v_type from units u where u.id = v_row.unit_id;
  if v_type is not null then
    perform public.enqueue_channel_sync(
      'availability', v_type, lower(v_row.stay), upper(v_row.stay), null);
  end if;

  -- An UPDATE can move a stay between units of different types; tell both.
  if tg_op = 'UPDATE' and new.unit_id is distinct from old.unit_id then
    select u.room_type_id into v_type from units u where u.id = old.unit_id;
    if v_type is not null then
      perform public.enqueue_channel_sync(
        'availability', v_type, lower(old.stay), upper(old.stay), null);
    end if;
  end if;

  if v_row.reservation_id is not null then
    perform public.enqueue_channel_sync(
      case tg_op
        when 'INSERT' then 'reservation_created'
        when 'DELETE' then 'reservation_cancelled'
        else 'reservation_modified'
      end,
      null, null, null, v_row.reservation_id);
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists allocations_channel_sync on allocations;
create trigger allocations_channel_sync
  after insert or update or delete on allocations
  for each row execute function public.allocations_enqueue_sync();

create or replace function public.rates_enqueue_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
begin
  v_row := coalesce(new, old);
  perform public.enqueue_channel_sync(
    'rates', v_row.room_type_id, v_row.stay_date, v_row.stay_date + 1, null);
  return coalesce(new, old);
end;
$$;

drop trigger if exists rates_channel_sync on rates;
create trigger rates_channel_sync
  after insert or update or delete on rates
  for each row execute function public.rates_enqueue_sync();

-- A unit going in or out of service changes the pool itself.
create or replace function public.units_enqueue_sync()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row record;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  v_row := coalesce(new, old);
  perform public.enqueue_channel_sync(
    'availability', v_row.room_type_id, v_today, v_today + 400, null);
  return coalesce(new, old);
end;
$$;

drop trigger if exists units_channel_sync on units;
create trigger units_channel_sync
  after insert or update of active, room_type_id or delete on units
  for each row execute function public.units_enqueue_sync();

-- -------------------------------------------------------------- worker API
/**
 * Claim the next batch of work. Rows are marked `sent` optimistically by the
 * caller only after the provider confirms — see complete_channel_sync.
 */
create or replace function public.claim_channel_sync(p_limit integer default 20)
returns setof channel_outbox
language sql
volatile
security definer
set search_path = public, pg_temp
as $$
  update channel_outbox o
     set attempts = o.attempts + 1
   where o.id in (
     select id from channel_outbox
      where status = 'pending' and next_attempt_at <= now()
      order by sequence
      limit p_limit
      for update skip locked
   )
  returning o.*;
$$;

create or replace function public.complete_channel_sync(
  p_id          uuid,
  p_ok          boolean,
  p_error       text default null,
  p_provider_id text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_attempts integer;
begin
  select attempts into v_attempts from channel_outbox where id = p_id;

  if p_ok then
    update channel_outbox
       set status = 'sent', sent_at = now(), last_error = null,
           provider_id = coalesce(p_provider_id, provider_id)
     where id = p_id;
  else
    -- Exponential backoff, capped. Give up after 8 tries and make it visible
    -- rather than retrying forever in silence.
    update channel_outbox
       set status = case when v_attempts >= 8 then 'failed' else 'pending' end,
           last_error = p_error,
           provider_id = coalesce(p_provider_id, provider_id),
           next_attempt_at = now() + make_interval(
             secs => least(3600, power(2, least(v_attempts, 10))::int * 15))
     where id = p_id;
  end if;
end;
$$;

/** Staff confirming they updated the extranets by hand. */
create or replace function public.acknowledge_channel_sync(
  p_id       uuid,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  update channel_outbox
     set acknowledged_at = now(), acknowledged_by = p_actor_id,
         status = 'sent', sent_at = coalesce(sent_at, now())
   where id = p_id and requires_ack;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function public.inventory_snapshot(uuid, date, date) from public, anon;
revoke all on function public.enqueue_channel_sync(text, uuid, date, date, uuid) from public, anon, authenticated;
revoke all on function public.claim_channel_sync(integer) from public, anon, authenticated;
revoke all on function public.complete_channel_sync(uuid, boolean, text, text) from public, anon, authenticated;
revoke all on function public.acknowledge_channel_sync(uuid, uuid) from public, anon;

grant execute on function public.inventory_snapshot(uuid, date, date) to authenticated;
grant execute on function public.acknowledge_channel_sync(uuid, uuid) to authenticated;
