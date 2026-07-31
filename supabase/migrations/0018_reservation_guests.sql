-- Stays — every occupant is a person (extends ROADMAP M2 item 2)
--
-- A booking for four backpackers is four people, each of whom must produce ID on
-- arrival. Until now a reservation carried ONE guest, so a group of four
-- captured one passport — which is not what the register requires.
--
-- This also RELOCATES the journey fields added in 0017. "Arrived from" and
-- "next destination" describe a person's travel, not a booking: three foreign
-- guests sharing a reservation each have their own visa and route. They are
-- backfilled onto reservation_guests, then dropped from reservations.
--
-- `reservations.guest_id` stays as the LEAD guest — the person who booked and
-- who the folio belongs to. Plenty of code joins through it.

create table if not exists reservation_guests (
  id                  uuid primary key default gen_random_uuid(),
  reservation_id      uuid not null references reservations (id) on delete cascade,
  guest_id            uuid not null references guests (id) on delete restrict,
  -- The booker. Their folio carries the stay.
  is_lead             boolean not null default false,
  -- Per-person journey details, required for the foreign-guest register.
  arrived_in_india_on date,
  arrived_from        text,
  next_destination    text,
  checked_in_at       timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (reservation_id, guest_id)
);

create index if not exists reservation_guests_reservation_idx
  on reservation_guests (reservation_id);
create index if not exists reservation_guests_guest_idx
  on reservation_guests (guest_id);

-- At most one lead per reservation, enforced rather than assumed.
create unique index if not exists reservation_guests_one_lead
  on reservation_guests (reservation_id) where is_lead;

drop trigger if exists set_updated_at on reservation_guests;
create trigger set_updated_at before update on reservation_guests
  for each row execute function public.set_updated_at();

alter table reservation_guests enable row level security;
revoke all on reservation_guests from anon, authenticated;

-- ------------------------------------------------------------- backfill
-- Existing bookings become their own lead guest, carrying their journey data
-- across before the columns are removed below.
--
-- Guarded because the backfill READS columns this same migration then DROPS:
-- on a second run those columns are gone and an unguarded SELECT would abort
-- the script, leaving everything below it unapplied.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'reservations'
       and column_name = 'arrived_in_india_on'
  ) then
    execute $q$
      insert into reservation_guests (reservation_id, guest_id, is_lead,
                                      arrived_in_india_on, arrived_from,
                                      next_destination, checked_in_at)
      select r.id, r.guest_id, true,
             r.arrived_in_india_on, r.arrived_from, r.next_destination, r.checked_in_at
        from reservations r
       where r.guest_id is not null
      on conflict (reservation_id, guest_id) do nothing
    $q$;
  else
    -- Already migrated: just make sure every booking has its lead linked.
    insert into reservation_guests (reservation_id, guest_id, is_lead)
    select r.id, r.guest_id, true
      from reservations r
     where r.guest_id is not null
    on conflict (reservation_id, guest_id) do nothing;
  end if;
end $$;

-- Now redundant: the same facts live per-person above.
alter table reservations drop column if exists arrived_in_india_on;
alter table reservations drop column if exists arrived_from;
alter table reservations drop column if exists next_destination;

-- ------------------------------------------- keep the lead guest linked
-- A booking made anywhere (website, walk-in, OTA entry) must appear as a party
-- of one immediately, not only once someone checks in. A trigger does this for
-- every writer, instead of every writer remembering to.
create or replace function public.sync_reservation_lead_guest()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.guest_id is not null then
    -- Only one lead per reservation (partial unique index), so demote first.
    update reservation_guests set is_lead = false
     where reservation_id = new.id and guest_id <> new.guest_id and is_lead;

    insert into reservation_guests (reservation_id, guest_id, is_lead)
    values (new.id, new.guest_id, true)
    on conflict (reservation_id, guest_id) do update set is_lead = true;
  end if;
  return new;
end;
$$;

drop trigger if exists reservations_lead_guest on reservations;
create trigger reservations_lead_guest
  after insert or update of guest_id on reservations
  for each row execute function public.sync_reservation_lead_guest();

-- ------------------------------------------------- ID completeness helper
-- "Each individual's ID proof at check-in": a domestic guest needs an ID number,
-- a foreign national needs a passport. A scan on file counts either way.
create or replace function public.guest_has_id(p_guest_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from guests g
     where g.id = p_guest_id
       and (
         nullif(btrim(coalesce(g.id_proof_number, '')), '') is not null
         or nullif(btrim(coalesce(g.passport_number, '')), '') is not null
         or exists (select 1 from guest_documents d where d.guest_id = g.id)
       )
  );
$$;

-- ---------------------------------------------------------------- arrivals
-- Now carries the full party, so the desk can see who still has to be recorded.
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
                   -- Everyone recorded on the booking so far, lead first.
                   'party', coalesce((
                     select jsonb_agg(jsonb_build_object(
                              'guestId', pg.id,
                              'name', pg.name,
                              'phone', pg.phone,
                              'email', pg.email,
                              'nationality', pg.nationality,
                              'isForeign', public.is_foreign_national(pg.nationality),
                              'isLead', rg.is_lead,
                              'idProofType', pg.id_proof_type,
                              'idProofNumber', pg.id_proof_number,
                              'passportNumber', pg.passport_number,
                              'passportIssueDate', pg.passport_issue_date,
                              'passportExpiry', pg.passport_expiry,
                              'visaNumber', pg.visa_number,
                              'visaType', pg.visa_type,
                              'visaExpiry', pg.visa_expiry,
                              'arrivedInIndiaOn', rg.arrived_in_india_on,
                              'arrivedFrom', rg.arrived_from,
                              'nextDestination', rg.next_destination,
                              'hasId', public.guest_has_id(pg.id),
                              'documents', (select count(*) from guest_documents d
                                             where d.guest_id = pg.id))
                            order by rg.is_lead desc, pg.name)
                       from reservation_guests rg
                       join guests pg on pg.id = rg.guest_id
                      where rg.reservation_id = res.id
                   ), '[]'::jsonb),
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
-- Takes the WHOLE party. Still one action for the reservation, however many
-- people and however many beds.
drop function if exists public.check_in_reservation(uuid, jsonb, jsonb, uuid, text);

create or replace function public.check_in_reservation(
  p_reservation_id uuid,
  p_guests         jsonb,
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
  v_g        jsonb;
  v_guest_id uuid;
  v_lead     uuid;
  v_name     text;
  v_units    integer;
  v_rooms    text;
  v_count    integer := 0;
  v_missing  text[] := array[]::text[];
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
    return jsonb_build_object('ok', false, 'code', 'NO_UNITS');
  end if;

  if p_guests is null or jsonb_typeof(p_guests) <> 'array'
     or jsonb_array_length(p_guests) = 0 then
    return jsonb_build_object('ok', false, 'code', 'NO_GUESTS');
  end if;

  -- Validate the whole party BEFORE writing anything: a half-recorded group is
  -- worse than a rejected one.
  for v_g in select * from jsonb_array_elements(p_guests) loop
    if nullif(btrim(coalesce(v_g ->> 'name', '')), '') is null then
      return jsonb_build_object('ok', false, 'code', 'NAME_REQUIRED');
    end if;
    if nullif(btrim(coalesce(v_g ->> 'idProofNumber', '')), '') is null
       and nullif(btrim(coalesce(v_g ->> 'passportNumber', '')), '') is null
       and not exists (
         select 1 from guest_documents d
          where d.guest_id = nullif(v_g ->> 'guestId', '')::uuid
       )
    then
      v_missing := v_missing || (v_g ->> 'name');
    end if;
  end loop;

  if array_length(v_missing, 1) > 0 then
    -- Every individual must produce ID on arrival.
    return jsonb_build_object('ok', false, 'code', 'ID_REQUIRED',
                              'missing', to_jsonb(v_missing));
  end if;

  for v_g in select * from jsonb_array_elements(p_guests) loop
    v_guest_id := nullif(v_g ->> 'guestId', '')::uuid;

    if v_guest_id is null then
      insert into guests (name, phone, email, nationality, id_proof_type, id_proof_number,
                          passport_number, passport_issue_date, passport_expiry,
                          visa_number, visa_type, visa_expiry)
      values (v_g ->> 'name', nullif(v_g ->> 'phone', ''), nullif(v_g ->> 'email', ''),
              nullif(v_g ->> 'nationality', ''), nullif(v_g ->> 'idProofType', ''),
              nullif(v_g ->> 'idProofNumber', ''), nullif(v_g ->> 'passportNumber', ''),
              (nullif(v_g ->> 'passportIssueDate', ''))::date,
              (nullif(v_g ->> 'passportExpiry', ''))::date,
              nullif(v_g ->> 'visaNumber', ''), nullif(v_g ->> 'visaType', ''),
              (nullif(v_g ->> 'visaExpiry', ''))::date)
      returning id into v_guest_id;
    else
      -- Blank fields never wipe what was captured at booking time.
      update guests set
        name                = coalesce(nullif(v_g ->> 'name', ''), name),
        phone               = coalesce(nullif(v_g ->> 'phone', ''), phone),
        email               = coalesce(nullif(v_g ->> 'email', ''), email),
        nationality         = coalesce(nullif(v_g ->> 'nationality', ''), nationality),
        id_proof_type       = coalesce(nullif(v_g ->> 'idProofType', ''), id_proof_type),
        id_proof_number     = coalesce(nullif(v_g ->> 'idProofNumber', ''), id_proof_number),
        passport_number     = coalesce(nullif(v_g ->> 'passportNumber', ''), passport_number),
        passport_issue_date = coalesce((nullif(v_g ->> 'passportIssueDate', ''))::date, passport_issue_date),
        passport_expiry     = coalesce((nullif(v_g ->> 'passportExpiry', ''))::date, passport_expiry),
        visa_number         = coalesce(nullif(v_g ->> 'visaNumber', ''), visa_number),
        visa_type           = coalesce(nullif(v_g ->> 'visaType', ''), visa_type),
        visa_expiry         = coalesce((nullif(v_g ->> 'visaExpiry', ''))::date, visa_expiry)
      where id = v_guest_id;
    end if;

    -- The first person listed leads unless one is explicitly flagged.
    if v_lead is null or coalesce((v_g ->> 'isLead')::boolean, false) then
      v_lead := coalesce(
        case when coalesce((v_g ->> 'isLead')::boolean, false) then v_guest_id else null end,
        v_lead, v_guest_id);
    end if;

    insert into reservation_guests (reservation_id, guest_id, is_lead,
                                    arrived_in_india_on, arrived_from, next_destination,
                                    checked_in_at)
    values (p_reservation_id, v_guest_id, false,
            (nullif(v_g ->> 'arrivedInIndiaOn', ''))::date,
            nullif(v_g ->> 'arrivedFrom', ''),
            nullif(v_g ->> 'nextDestination', ''),
            now())
    on conflict (reservation_id, guest_id) do update set
      arrived_in_india_on = coalesce(excluded.arrived_in_india_on, reservation_guests.arrived_in_india_on),
      arrived_from        = coalesce(excluded.arrived_from, reservation_guests.arrived_from),
      next_destination    = coalesce(excluded.next_destination, reservation_guests.next_destination),
      checked_in_at       = now();

    v_count := v_count + 1;
  end loop;

  -- Exactly one lead, set after the loop so the unique index can't trip mid-way.
  update reservation_guests set is_lead = false where reservation_id = p_reservation_id;
  update reservation_guests set is_lead = true
   where reservation_id = p_reservation_id and guest_id = v_lead;
  update reservations set guest_id = v_lead where id = p_reservation_id;

  select g.name into v_name from guests g where g.id = v_lead;

  update reservations set
    status        = 'checked_in',
    checked_in_at = now(),
    checked_in_by = p_actor_id
  where id = p_reservation_id;

  select string_agg(distinct rm.number, ', ' order by rm.number) into v_rooms
    from allocations a
    join units u on u.id = a.unit_id
    join rooms rm on rm.id = u.room_id
   where a.reservation_id = p_reservation_id;

  perform public.log_event(
    'guest.checked_in',
    format('%s%s checked in to %s (%s unit%s)',
           coalesce(v_name, 'Guest'),
           case when v_count > 1 then format(' +%s', v_count - 1) else '' end,
           coalesce(v_rooms, '—'), v_units, case when v_units = 1 then '' else 's' end),
    p_actor_id, p_actor_label, p_reservation_id, null, null,
    jsonb_build_object('code', v_res.code, 'units', v_units,
                       'guests', v_count, 'rooms', v_rooms));

  return jsonb_build_object('ok', true, 'units', v_units, 'guests', v_count,
                            'rooms', v_rooms, 'code', v_res.code);
end;
$$;

-- ------------------------------------------------- foreign-guest register
-- One row per FOREIGN PERSON, not per booking — which is the point of all this.
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
                 'isLead', rg.is_lead,
                 'nationality', g.nationality,
                 'passportNumber', g.passport_number,
                 'passportIssueDate', g.passport_issue_date,
                 'passportExpiry', g.passport_expiry,
                 'visaNumber', g.visa_number,
                 'visaType', g.visa_type,
                 'visaExpiry', g.visa_expiry,
                 'arrivedInIndiaOn', rg.arrived_in_india_on,
                 'arrivedFrom', rg.arrived_from,
                 'nextDestination', rg.next_destination,
                 'checkin', res.checkin,
                 'checkout', res.checkout,
                 'checkedInAt', rg.checked_in_at,
                 'rooms', (
                   select string_agg(distinct rm.number, ' / ' order by rm.number)
                     from allocations a
                     join units u on u.id = a.unit_id
                     join rooms rm on rm.id = u.room_id
                    where a.reservation_id = res.id
                 )
               ) as x
          from reservation_guests rg
          join reservations res on res.id = rg.reservation_id
          join guests g on g.id = rg.guest_id
         where public.is_foreign_national(g.nationality)
           and res.checkin >= p_from
           and res.checkin < p_to
           and res.status in ('checked_in', 'checked_out')
      ) s
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.guest_has_id(uuid) from public, anon;
revoke all on function public.check_in_reservation(uuid, jsonb, uuid, text) from public, anon;
grant execute on function public.guest_has_id(uuid) to authenticated;
grant execute on function public.check_in_reservation(uuid, jsonb, uuid, text) to authenticated;
