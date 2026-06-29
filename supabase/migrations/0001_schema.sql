-- Backpackers Storey — schema (§4 data model)
-- Conventions: money is integer paise (never floats); status columns are text
-- with CHECK constraints; every status reaches a terminal state.

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "btree_gist";  -- exclusion constraints for no-double-book

-- ---------------------------------------------------------------- profiles
create table if not exists profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text,
  role text not null default 'reception'
    check (role in ('owner', 'manager', 'reception', 'kitchen', 'housekeeping')),
  created_at timestamptz not null default now()
);

-- Role of the current user, read without RLS so policies can call it safely
-- (avoids recursion on the profiles table).
create or replace function public.user_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select role from public.profiles where id = auth.uid();
$$;

-- Auto-create a profile when an auth user is created (owner provisions accounts;
-- promote the first one to 'owner' manually — see supabase/README.md).
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''), 'reception')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------- café
create table if not exists menu_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists menu_items (
  id uuid primary key default gen_random_uuid(),
  category_id uuid references menu_categories (id) on delete cascade,
  name text not null,
  price_paise integer not null check (price_paise >= 0),
  kitchen_station text not null default 'main'
    check (kitchen_station in ('main', 'bar', 'coffee')),
  is_available boolean not null default true,
  created_at timestamptz not null default now()
);

-- -------------------------------------------------------------- rooms/beds
create table if not exists rooms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  type text not null check (type in ('dorm', 'deluxe', 'premium', 'family')),
  total_beds integer not null default 1 check (total_beds >= 0),
  is_dorm boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists beds (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms (id) on delete cascade,
  label text not null,
  created_at timestamptz not null default now(),
  unique (room_id, label)
);

-- ----------------------------------------------------------------- guests
create table if not exists guests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  email text,
  id_proof_type text,
  id_proof_number text,
  created_at timestamptz not null default now()
);
create index if not exists guests_phone_idx on guests (phone);

-- --------------------------------------------------------------- bookings
create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  guest_id uuid not null references guests (id) on delete restrict,
  room_id uuid not null references rooms (id) on delete restrict,
  bed_id uuid references beds (id) on delete restrict,
  check_in date not null,
  check_out date not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'checked_in', 'checked_out', 'cancelled', 'no_show')),
  source text not null default 'walk_in'
    check (source in ('walk_in', 'website', 'zotel', 'ota')),
  amount_paise integer not null default 0 check (amount_paise >= 0),
  balance_paise integer not null default 0 check (balance_paise >= 0),
  notes text,
  created_at timestamptz not null default now(),
  check (check_out > check_in)
);
create index if not exists bookings_room_dates_idx on bookings (room_id, check_in, check_out);
create index if not exists bookings_status_idx on bookings (status);

-- No double-booking (§7 acceptance): overlapping active stays can't share a bed
-- (dorm, bed-level) or a room (private, room-level). '[)' = check_in inclusive,
-- check_out exclusive, which is correct for hotel nights.
alter table bookings drop constraint if exists no_double_book_bed;
alter table bookings add constraint no_double_book_bed
  exclude using gist (
    bed_id with =,
    daterange(check_in, check_out, '[)') with &&
  ) where (bed_id is not null and status in ('reserved', 'checked_in'));

alter table bookings drop constraint if exists no_double_book_room;
alter table bookings add constraint no_double_book_room
  exclude using gist (
    room_id with =,
    daterange(check_in, check_out, '[)') with &&
  ) where (bed_id is null and status in ('reserved', 'checked_in'));

-- ----------------------------------------------------------- housekeeping
create table if not exists housekeeping (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null unique references rooms (id) on delete cascade,
  status text not null default 'clean'
    check (status in ('clean', 'dirty', 'in_progress')),
  updated_by uuid references profiles (id),
  updated_at timestamptz not null default now()
);

-- ----------------------------------------------------------------- orders
create table if not exists orders (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('dine_in', 'takeaway', 'room')),
  table_label text,
  room_id uuid references rooms (id) on delete set null,
  status text not null default 'open'
    check (status in ('open', 'sent', 'served', 'paid', 'void')),
  subtotal_paise integer not null default 0 check (subtotal_paise >= 0),
  discount_paise integer not null default 0 check (discount_paise >= 0),
  total_paise integer not null default 0 check (total_paise >= 0),
  created_by uuid references profiles (id),
  created_at timestamptz not null default now()
);
create index if not exists orders_status_created_idx on orders (status, created_at);

create table if not exists order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders (id) on delete cascade,
  menu_item_id uuid references menu_items (id) on delete restrict,
  qty integer not null check (qty > 0),
  price_paise integer not null check (price_paise >= 0),  -- snapshot at order time
  notes text,
  status text not null default 'pending'
    check (status in ('pending', 'preparing', 'ready')),
  created_at timestamptz not null default now()
);
create index if not exists order_items_order_idx on order_items (order_id);
create index if not exists order_items_status_idx on order_items (status);

-- §6: when every item of an order is ready, the order flips to 'served'.
-- SECURITY DEFINER so kitchen staff only ever update order_items, not orders.
create or replace function public.sync_order_served()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from order_items where order_id = new.order_id and status <> 'ready'
  ) then
    update orders set status = 'served'
    where id = new.order_id and status in ('open', 'sent');
  end if;
  return new;
end;
$$;

drop trigger if exists order_items_sync_served on order_items;
create trigger order_items_sync_served
  after insert or update of status on order_items
  for each row execute function public.sync_order_served();

-- --------------------------------------------------------------- payments
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references orders (id) on delete cascade,
  booking_id uuid references bookings (id) on delete cascade,
  amount_paise integer not null check (amount_paise >= 0),
  method text not null check (method in ('cash', 'upi', 'card', 'cashfree')),
  cashfree_order_id text,
  status text not null default 'pending'
    check (status in ('pending', 'success', 'failed')),
  created_at timestamptz not null default now(),
  -- a payment belongs to an order or a booking (at least one)
  check (order_id is not null or booking_id is not null)
);
create index if not exists payments_order_idx on payments (order_id);
create index if not exists payments_booking_idx on payments (booking_id);

-- ---------------------------------------------------------------- realtime
-- KOT (kitchen) and the occupancy/housekeeping boards subscribe to these.
-- Idempotent: only add a table if it isn't already in the publication.
do $$
declare
  t text;
begin
  foreach t in array array['orders', 'order_items', 'bookings', 'housekeeping'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
