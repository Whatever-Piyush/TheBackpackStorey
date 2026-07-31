-- Stays — arrivals and check-in (ROADMAP M2 item 2)
--
-- Two kinds of data, deliberately stored in two places:
--   * Identity documents belong to the PERSON  -> guests
--   * Journey details belong to the STAY       -> reservations
-- A passport number is the same next visit; "arrived from" is not.
--
-- Foreign-national capture exists because accommodation providers in India must
-- report foreign guests. We capture and export; we do NOT auto-submit anything
-- until the current process is confirmed.

-- --------------------------------------------------- identity (the person)
alter table guests add column if not exists passport_number text;
alter table guests add column if not exists passport_issue_date date;
alter table guests add column if not exists passport_expiry date;
alter table guests add column if not exists visa_number text;
alter table guests add column if not exists visa_type text;
alter table guests add column if not exists visa_expiry date;

-- ------------------------------------------------------ journey (the stay)
alter table reservations add column if not exists arrived_in_india_on date;
alter table reservations add column if not exists arrived_from text;
alter table reservations add column if not exists next_destination text;
alter table reservations add column if not exists checked_in_at timestamptz;
alter table reservations add column if not exists checked_in_by uuid references auth.users (id);

create index if not exists reservations_checkin_status_idx
  on reservations (checkin, status);

-- Is this guest a foreign national? One definition, used by the arrivals list
-- and the export, so the two can never disagree.
create or replace function public.is_foreign_national(p_nationality text)
returns boolean
language sql
immutable
as $$
  select p_nationality is not null
     and lower(btrim(p_nationality)) not in ('india', 'indian', 'in', 'ind');
$$;

-- ------------------------------------------------------------- ID documents
create table if not exists guest_documents (
  id             uuid primary key default gen_random_uuid(),
  guest_id       uuid not null references guests (id) on delete cascade,
  reservation_id uuid references reservations (id) on delete set null,
  kind           text not null default 'id'
                 check (kind in ('passport', 'visa', 'aadhaar', 'driving_licence', 'id', 'other')),
  -- Object key inside the PRIVATE bucket. Never a URL: a stored URL invites
  -- someone to make it public. Links are signed on demand, server-side.
  storage_path   text not null unique,
  original_name  text,
  mime_type      text,
  size_bytes     integer check (size_bytes is null or size_bytes >= 0),
  uploaded_by    uuid references auth.users (id),
  uploaded_at    timestamptz not null default now()
);

create index if not exists guest_documents_guest_idx on guest_documents (guest_id);
create index if not exists guest_documents_reservation_idx on guest_documents (reservation_id);

-- Deny-by-default. Scans of passports are the most sensitive rows in the
-- database; they are reachable only through server code on the service role.
alter table guest_documents enable row level security;
revoke all on guest_documents from anon, authenticated;

-- ----------------------------------------------------------- private bucket
-- Guarded so this migration still runs against a plain Postgres (CI / local),
-- where Supabase's storage schema does not exist.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public)
    values ('guest-ids', 'guest-ids', false)
    on conflict (id) do update set public = false;   -- never let it drift public
    -- No storage.objects policies are created on purpose: with none, only the
    -- service role can touch the objects, and reception sees them through
    -- short-lived signed URLs generated on the server.
  end if;
end $$;

-- ---------------------------------------------------------------- arrivals
-- Expected today, PLUS anyone still unarrived from earlier — an overdue arrival
-- must not silently vanish off the list at midnight.
create or replace function public.stays_arrivals(
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
    'arrivals', coalesce((
      select jsonb_agg(x order by (x ->> 'overdue')::boolean desc, x ->> 'checkin', x ->> 'guestName')
        from (
          select jsonb_build_object(
                   'reservationId', res.id,
                   'code', res.code,
                   'status', res.status,
                   'checkin', res.checkin,
                   'checkout', res.checkout,
                   'nights', res.checkout - res.checkin,
                   'overdue', res.checkin < v_date,
                   'adults', res.adults,
                   'children', res.children,
                   'source', res.source,
                   'guestId', g.id,
                   'guestName', coalesce(g.name, 'Guest'),
                   'guestPhone', g.phone,
                   'guestEmail', g.email,
                   'nationality', g.nationality,
                   'isForeign', public.is_foreign_national(g.nationality),
                   'idProofType', g.id_proof_type,
                   'idProofNumber', g.id_proof_number,
                   'passportNumber', g.passport_number,
                   'passportIssueDate', g.passport_issue_date,
                   'passportExpiry', g.passport_expiry,
                   'visaNumber', g.visa_number,
                   'visaType', g.visa_type,
                   'visaExpiry', g.visa_expiry,
                   'arrivedInIndiaOn', res.arrived_in_india_on,
                   'arrivedFrom', res.arrived_from,
                   'nextDestination', res.next_destination,
                   'documents', (
                     select count(*) from guest_documents d where d.guest_id = g.id
                   ),
                   -- Every unit on the booking: a group of four checks in once.
                   'units', coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'allocationId', a.id,
                              'unitId', u.id,
                              'roomTypeId', u.room_type_id,
                              'room', rm.number,
                              'bed', b.label)
                            order by rm.number, b.label nulls first)
                       from allocations a
                       join units u on u.id = a.unit_id
                       join rooms rm on rm.id = u.room_id
                       left join beds b on b.id = u.bed_id
                      where a.reservation_id = res.id
                   ), '[]'::jsonb)
                 ) as x
            from reservations res
            left join guests g on g.id = res.guest_id
           where res.status in ('hold', 'confirmed')
             and res.checkin <= v_date
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

-- ---------------------------------------------------------------- check-in
-- ONE action for the whole reservation, however many units it covers.
create or replace function public.check_in_reservation(
  p_reservation_id uuid,
  p_guest          jsonb default '{}'::jsonb,
  p_stay           jsonb default '{}'::jsonb,
  p_actor_id       uuid  default null,
  p_actor_label    text  default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res    record;
  v_guest  uuid;
  v_name   text;
  v_units  integer;
  v_rooms  text;
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  select * into v_res from reservations where id = p_reservation_id;
  if v_res is null then
    return jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  end if;
  if v_res.status = 'checked_in' then
    return jsonb_build_object('ok', false, 'code', 'ALREADY_CHECKED_IN');
  end if;
  if v_res.status not in ('hold', 'confirmed') then
    return jsonb_build_object('ok', false, 'code', 'NOT_ARRIVABLE', 'status', v_res.status);
  end if;

  select count(*) into v_units from allocations where reservation_id = p_reservation_id;
  if v_units = 0 then
    -- Eager allocation means this should be impossible; refuse rather than put
    -- a guest in-house with no bed against their name.
    return jsonb_build_object('ok', false, 'code', 'NO_UNITS');
  end if;

  v_guest := v_res.guest_id;

  -- Only overwrite what was actually supplied; a blank field must not wipe
  -- details captured at booking time.
  if v_guest is not null then
    update guests set
      name                = coalesce(nullif(p_guest ->> 'name', ''), name),
      phone               = coalesce(nullif(p_guest ->> 'phone', ''), phone),
      email               = coalesce(nullif(p_guest ->> 'email', ''), email),
      nationality         = coalesce(nullif(p_guest ->> 'nationality', ''), nationality),
      id_proof_type       = coalesce(nullif(p_guest ->> 'idProofType', ''), id_proof_type),
      id_proof_number     = coalesce(nullif(p_guest ->> 'idProofNumber', ''), id_proof_number),
      passport_number     = coalesce(nullif(p_guest ->> 'passportNumber', ''), passport_number),
      passport_issue_date = coalesce((nullif(p_guest ->> 'passportIssueDate', ''))::date, passport_issue_date),
      passport_expiry     = coalesce((nullif(p_guest ->> 'passportExpiry', ''))::date, passport_expiry),
      visa_number         = coalesce(nullif(p_guest ->> 'visaNumber', ''), visa_number),
      visa_type           = coalesce(nullif(p_guest ->> 'visaType', ''), visa_type),
      visa_expiry         = coalesce((nullif(p_guest ->> 'visaExpiry', ''))::date, visa_expiry)
    where id = v_guest
    returning name into v_name;
  end if;

  update reservations set
    status              = 'checked_in',
    checked_in_at       = now(),
    checked_in_by       = p_actor_id,
    arrived_in_india_on = coalesce((nullif(p_stay ->> 'arrivedInIndiaOn', ''))::date, arrived_in_india_on),
    arrived_from        = coalesce(nullif(p_stay ->> 'arrivedFrom', ''), arrived_from),
    next_destination    = coalesce(nullif(p_stay ->> 'nextDestination', ''), next_destination)
  where id = p_reservation_id;

  select string_agg(distinct rm.number, ', ' order by rm.number) into v_rooms
    from allocations a
    join units u on u.id = a.unit_id
    join rooms rm on rm.id = u.room_id
   where a.reservation_id = p_reservation_id;

  perform public.log_event(
    'guest.checked_in',
    format('%s checked in to %s (%s unit%s)',
           coalesce(v_name, 'Guest'), coalesce(v_rooms, '—'),
           v_units, case when v_units = 1 then '' else 's' end),
    p_actor_id, p_actor_label, p_reservation_id, null, null,
    jsonb_build_object('code', v_res.code, 'units', v_units, 'rooms', v_rooms));

  return jsonb_build_object('ok', true, 'units', v_units, 'rooms', v_rooms,
                            'code', v_res.code);
end;
$$;

-- ------------------------------------------------- foreign-guest export (§C)
-- Everything an official form needs, in one row per stay. Export only — nothing
-- here submits to anyone.
create or replace function public.foreign_guest_register(
  p_from date,
  p_to   date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.user_role(), '') not in ('owner', 'manager') then
    raise exception 'not permitted' using errcode = 'insufficient_privilege';
  end if;

  return coalesce((
    select jsonb_agg(x order by x ->> 'checkin', x ->> 'guestName')
      from (
        select jsonb_build_object(
                 'code', res.code,
                 'guestName', g.name,
                 'nationality', g.nationality,
                 'passportNumber', g.passport_number,
                 'passportIssueDate', g.passport_issue_date,
                 'passportExpiry', g.passport_expiry,
                 'visaNumber', g.visa_number,
                 'visaType', g.visa_type,
                 'visaExpiry', g.visa_expiry,
                 'arrivedInIndiaOn', res.arrived_in_india_on,
                 'arrivedFrom', res.arrived_from,
                 'nextDestination', res.next_destination,
                 'checkin', res.checkin,
                 'checkout', res.checkout,
                 'checkedInAt', res.checked_in_at,
                 'rooms', (
                   select string_agg(distinct rm.number, ' / ' order by rm.number)
                     from allocations a
                     join units u on u.id = a.unit_id
                     join rooms rm on rm.id = u.room_id
                    where a.reservation_id = res.id
                 )
               ) as x
          from reservations res
          join guests g on g.id = res.guest_id
         where public.is_foreign_national(g.nationality)
           and res.checkin >= p_from
           and res.checkin < p_to
           and res.status in ('checked_in', 'checked_out')
      ) s
  ), '[]'::jsonb);
end;
$$;

-- --------------------------------------------------------------- privileges
revoke all on function public.stays_arrivals(date, text) from public, anon;
revoke all on function public.check_in_reservation(uuid, jsonb, jsonb, uuid, text) from public, anon;
revoke all on function public.foreign_guest_register(date, date) from public, anon;

grant execute on function public.stays_arrivals(date, text) to authenticated;
grant execute on function public.check_in_reservation(uuid, jsonb, jsonb, uuid, text) to authenticated;
grant execute on function public.foreign_guest_register(date, date) to authenticated;
