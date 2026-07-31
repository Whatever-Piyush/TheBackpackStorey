-- Hotel OS foundation — §3 Reservations + §5 direct allotment (docs/foundation.md)
--
-- The exclusion constraint on `allocations` is the whole point: overlap is
-- impossible at the storage layer, so no application availability check can lose
-- a race. Callers insert and handle 23P01; they never "check then hope".

-- --------------------------------------------------- reservation codes
-- What the guest quotes on the phone: 'BS-4K7QP2'. Ambiguous glyphs (I, O, 0, 1)
-- are excluded so a code read aloud or off a screenshot can't be mistyped.
create or replace function public.gen_reservation_code()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  candidate text;
  i int;
begin
  for attempt in 1..20 loop
    candidate := 'BS-';
    for i in 1..6 loop
      candidate := candidate || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    if not exists (select 1 from reservations where code = candidate) then
      return candidate;
    end if;
  end loop;
  -- 32^6 ≈ 1e9 codes; 20 straight collisions means something is very wrong.
  raise exception 'could not allocate a unique reservation code after 20 attempts';
end;
$$;

-- ----------------------------------------------------------- reservations
create table if not exists reservations (
  id         uuid primary key default gen_random_uuid(),
  code       text unique not null default public.gen_reservation_code(),
  guest_id   uuid references guests (id),
  status     text not null default 'confirmed'
             check (status in ('hold', 'confirmed', 'checked_in', 'checked_out', 'cancelled', 'no_show')),
  source     text not null
             check (source in ('website', 'walk_in', 'phone', 'ota_booking', 'ota_goibibo',
                              'ota_hostelworld', 'ota_airbnb', 'other')),
  checkin    date not null,
  checkout   date not null,
  adults     integer not null default 1 check (adults > 0),
  children   integer not null default 0 check (children >= 0),
  notes      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  check (checkout > checkin)
);

create index if not exists reservations_dates_idx on reservations (checkin, checkout);
create index if not exists reservations_status_idx on reservations (status);
create index if not exists reservations_guest_idx on reservations (guest_id);
-- Reception looks a guest up by the code they quote.
create index if not exists reservations_code_idx on reservations (code);

drop trigger if exists set_updated_at on reservations;
create trigger set_updated_at before update on reservations
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------ allocations
-- One row per (unit, stay). A maintenance block or an owner hold is the same row
-- with no reservation — which is why there is no separate "maintenance" table.
create table if not exists allocations (
  id             uuid primary key default gen_random_uuid(),
  unit_id        uuid not null references units (id),
  reservation_id uuid references reservations (id) on delete cascade,
  reason         text not null default 'booking'
                 check (reason in ('booking', 'maintenance', 'owner_use', 'hold')),
  stay           daterange not null,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users (id),
  -- Always built as daterange(checkin, checkout, '[)') — checkout day is free for
  -- the next guest, so `&&` has no off-by-one.
  constraint allocations_stay_half_open check (
    lower_inc(stay) and not upper_inc(stay) and not isempty(stay)
  ),
  -- THE constraint. Two concurrent inserts for the same unit + overlapping dates:
  -- one commits, the other raises 23P01.
  constraint allocations_no_overlap exclude using gist (unit_id with =, stay with &&)
);

create index if not exists allocations_reservation_idx on allocations (reservation_id);
create index if not exists allocations_stay_idx on allocations using gist (stay);

-- A booking allocation must belong to a reservation; a block must not.
alter table allocations drop constraint if exists allocations_reason_reservation_check;
alter table allocations add constraint allocations_reason_reservation_check check (
  (reason = 'booking' and reservation_id is not null)
  or (reason <> 'booking' and reservation_id is null)
);

-- ------------------------------------------------------- direct allotment
-- §5: how many units of a type the direct booking engine may sell on a date.
-- The rest of the inventory belongs to the OTAs, and MUST be closed in their
-- extranets — an OTA booking arrives by email, not by insert, so the exclusion
-- constraint cannot protect against double-selling it.
create table if not exists direct_allotment (
  room_type_id     uuid not null references room_types (id) on delete cascade,
  stay_date        date not null,
  units_for_direct integer not null default 0 check (units_for_direct >= 0),
  updated_at       timestamptz not null default now(),
  primary key (room_type_id, stay_date)
);

drop trigger if exists set_updated_at on direct_allotment;
create trigger set_updated_at before update on direct_allotment
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------- RLS
-- Deny-by-default: RLS on, and no policy for authenticated. Reservations and
-- allocations are never readable or writable from a browser, on any key.
alter table reservations    enable row level security;
alter table allocations     enable row level security;
alter table direct_allotment enable row level security;

revoke all on reservations from anon;
revoke all on allocations from anon;
revoke all on direct_allotment from anon;

-- §8 lists direct_allotment as publicly readable: the booking engine needs it to
-- decide what it may sell.
grant select on direct_allotment to anon;

drop policy if exists direct_allotment_anon_read on direct_allotment;
create policy direct_allotment_anon_read on direct_allotment for select to anon
  using (true);
