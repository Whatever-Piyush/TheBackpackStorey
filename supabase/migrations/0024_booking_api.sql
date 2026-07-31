-- Public booking API support (ROADMAP M4)
--
-- Three things the website needs that reception does not: a rate limit, an
-- idempotency ledger, and a guest-facing lookup that is not enumerable.
--
-- All state lives in the database on purpose. In-memory counters do not survive
-- a serverless cold start and are not shared between instances, so an in-memory
-- rate limit is a rate limit only on a developer's laptop.

-- ------------------------------------------------------------ rate limiting
create table if not exists rate_limit_hits (
  id     bigserial primary key,
  bucket text not null,
  at     timestamptz not null default now()
);

create index if not exists rate_limit_hits_bucket_idx on rate_limit_hits (bucket, at desc);

alter table rate_limit_hits enable row level security;
revoke all on rate_limit_hits from anon, authenticated;

/**
 * Records a hit and reports whether the caller is still under the limit.
 * Returns false once the bucket is full — the caller should refuse the request.
 */
create or replace function public.check_rate_limit(
  p_bucket         text,
  p_limit          integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_since timestamptz := now() - make_interval(secs => p_window_seconds);
  v_count integer;
begin
  -- Cheap housekeeping: at this volume a full sweep costs nothing, and it keeps
  -- the table from growing without bound.
  delete from rate_limit_hits where at < now() - interval '1 day';

  select count(*) into v_count
    from rate_limit_hits
   where bucket = p_bucket and at >= v_since;

  if v_count >= p_limit then
    return false;
  end if;

  insert into rate_limit_hits (bucket) values (p_bucket);
  return true;
end;
$$;

-- -------------------------------------------------------------- idempotency
-- A double-click, or a retry after the connection drops mid-request, must not
-- produce two bookings. The key is claimed BEFORE the work starts, so two
-- simultaneous requests cannot both proceed.
create table if not exists booking_idempotency (
  key         text primary key,
  -- Guards against a key being reused for a different booking.
  fingerprint text not null,
  status      text not null default 'pending' check (status in ('pending', 'done')),
  response    jsonb,
  created_at  timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists booking_idempotency_created_idx
  on booking_idempotency (created_at);

alter table booking_idempotency enable row level security;
revoke all on booking_idempotency from anon, authenticated;

/**
 * Claim a key. Returns:
 *   {claimed:true}                      -> caller owns it, do the work
 *   {claimed:false, status:'done', ...} -> replay, return the stored response
 *   {claimed:false, status:'pending'}   -> another request is mid-flight
 *   {claimed:false, code:'FINGERPRINT'} -> same key, different booking
 */
create or replace function public.claim_idempotency_key(
  p_key         text,
  p_fingerprint text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row booking_idempotency%rowtype;
begin
  delete from booking_idempotency where created_at < now() - interval '2 days';

  insert into booking_idempotency (key, fingerprint)
  values (p_key, p_fingerprint)
  on conflict (key) do nothing;

  if found then
    return jsonb_build_object('claimed', true);
  end if;

  select * into v_row from booking_idempotency where key = p_key;

  if v_row.fingerprint <> p_fingerprint then
    return jsonb_build_object('claimed', false, 'code', 'FINGERPRINT');
  end if;

  return jsonb_build_object('claimed', false, 'status', v_row.status,
                            'response', v_row.response);
end;
$$;

create or replace function public.complete_idempotency_key(
  p_key      text,
  p_response jsonb
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update booking_idempotency
     set status = 'done', response = p_response, completed_at = now()
   where key = p_key;
$$;

/** Release a claim so a genuine failure can be retried rather than wedged. */
create or replace function public.release_idempotency_key(p_key text)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from booking_idempotency where key = p_key and status = 'pending';
$$;

-- ------------------------------------------------------------ guest lookup
-- Requires the code AND the phone it was booked with. A booking code alone is
-- short enough to enumerate, and a stay tells you who is in the building.
--
-- Returns the SAME answer for a wrong code and a wrong phone, so the response
-- cannot be used to discover which codes exist.
create or replace function public.public_booking_lookup(
  p_code  text,
  p_phone text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_res    record;
  v_digits text;
begin
  v_digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  if length(v_digits) < 6 or nullif(btrim(coalesce(p_code, '')), '') is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  select res.id, res.code, res.status, res.checkin, res.checkout,
         res.adults, res.children, g.name as guest_name
    into v_res
    from reservations res
    join guests g on g.id = res.guest_id
   where upper(res.code) = upper(btrim(p_code))
     -- Compare digits only: a guest may type +91 98166… or 098166….
     and right(regexp_replace(coalesce(g.phone, ''), '\D', '', 'g'), 10)
         = right(v_digits, 10);

  if v_res is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;

  return jsonb_build_object(
    'ok', true,
    'code', v_res.code,
    'guestName', v_res.guest_name,
    'status', v_res.status,
    'checkin', v_res.checkin,
    'checkout', v_res.checkout,
    'nights', v_res.checkout - v_res.checkin,
    'adults', v_res.adults,
    'children', v_res.children,
    -- What they booked, not which bed: the unit is ours to move.
    'rooms', coalesce((
      select jsonb_agg(x.name order by x.name)
        from (
          select distinct rt.name
            from allocations a
            join units u on u.id = a.unit_id
            join room_types rt on rt.id = u.room_type_id
           where a.reservation_id = v_res.id
        ) x
    ), '[]'::jsonb),
    'units', (select count(*) from allocations a where a.reservation_id = v_res.id),
    'totalPaise', coalesce((
      select sum(fi.amount_paise)
        from folio_items fi
        join folios f on f.id = fi.folio_id
       where f.reservation_id = v_res.id
    ), 0),
    'paidPaise', coalesce((
      select sum(p.amount_paise)
        from payments p
        join folios f on f.id = p.folio_id
       where f.reservation_id = v_res.id
    ), 0)
  );
end;
$$;

revoke all on function public.check_rate_limit(text, integer, integer) from public, anon, authenticated;
revoke all on function public.claim_idempotency_key(text, text) from public, anon, authenticated;
revoke all on function public.complete_idempotency_key(text, jsonb) from public, anon, authenticated;
revoke all on function public.release_idempotency_key(text) from public, anon, authenticated;
-- The lookup page is public, but it is rate limited by the route in front of it.
revoke all on function public.public_booking_lookup(text, text) from public;
grant execute on function public.public_booking_lookup(text, text) to anon, authenticated;
