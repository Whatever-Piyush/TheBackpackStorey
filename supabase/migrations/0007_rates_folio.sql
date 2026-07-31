-- Hotel OS foundation — §4 Rates + §6 Folio (docs/foundation.md)
--
-- MONEY: integer paise, matching the six money columns that already exist
-- (menu_items.price_paise, orders.*_paise, order_items.price_paise, ...) and
-- src/lib/money.ts. §4/§6 write `numeric(10,2)`; storing rupees here would mean
-- every charge-to-room posting converts menu_items.price_paise → folio_items, and
-- one missed division is a 100× billing error. One representation, no conversions.
--
-- Signs are deliberately unconstrained: a `discount` folio line is negative, and
-- §6 defines a refund as a negative payment.

-- -------------------------------------------------------------- rate_plans
create table if not exists rate_plans (
  id           uuid primary key default gen_random_uuid(),
  room_type_id uuid not null references room_types (id) on delete cascade,
  name         text not null,
  min_nights   integer not null default 1 check (min_nights > 0),
  refundable   boolean not null default true,
  cancel_hours integer not null default 24 check (cancel_hours >= 0),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (room_type_id, name)
);

drop trigger if exists set_updated_at on rate_plans;
create trigger set_updated_at before update on rate_plans
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------- rates
-- One row per type per plan per night. §4: no rule engine at read time — a stay's
-- price is the sum of its nights. Seasons and weekends are scripts that write rows.
create table if not exists rates (
  room_type_id uuid not null references room_types (id) on delete cascade,
  rate_plan_id uuid not null references rate_plans (id) on delete cascade,
  stay_date    date not null,
  price_paise  integer not null check (price_paise >= 0),
  closed       boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (room_type_id, rate_plan_id, stay_date)
);

drop trigger if exists set_updated_at on rates;
create trigger set_updated_at before update on rates
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------ folios
create table if not exists folios (
  id             uuid primary key default gen_random_uuid(),
  reservation_id uuid references reservations (id) on delete cascade,
  table_no       text,                                  -- café walk-in tab
  status         text not null default 'open'
                 check (status in ('open', 'settled', 'void')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists folios_reservation_idx on folios (reservation_id);
-- Reception's "open tabs" list.
create index if not exists folios_open_idx on folios (status) where status = 'open';

drop trigger if exists set_updated_at on folios;
create trigger set_updated_at before update on folios
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------- folio_items
create table if not exists folio_items (
  id               uuid primary key default gen_random_uuid(),
  folio_id         uuid not null references folios (id) on delete cascade,
  kind             text not null
                   check (kind in ('room_night', 'food', 'beverage', 'extra', 'discount', 'tax')),
  description      text not null,
  qty              numeric(10,2) not null default 1,
  unit_price_paise integer not null,
  amount_paise     integer not null,
  -- §6: GST per line, never a hardcoded constant. 0 until the hostel's
  -- registration status and current slab are confirmed.
  tax_rate         numeric(5,2) not null default 0 check (tax_rate >= 0),
  source           text,                                -- 'pos' | 'booking' | 'reception'
  posted_at        timestamptz not null default now(),
  posted_by        uuid references auth.users (id)
);

create index if not exists folio_items_folio_idx on folio_items (folio_id);

-- ---------------------------------------------------------------- payments
-- The existing `payments` table is keyed on order_id/booking_id and predates the
-- folio model. It has no readers or writers in the app (verified), so it is
-- RENAMED rather than dropped — any rows survive in payments_legacy and this is
-- reversible.
do $$
begin
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'payments' and column_name = 'order_id'
  ) then
    alter table payments rename to payments_legacy;
    -- Renaming a table does NOT rename its constraints, so `payments_pkey` would
    -- still be taken and the new table would silently get `payments_pkey1`.
    alter table payments_legacy rename constraint payments_pkey to payments_legacy_pkey;
    raise notice 'renamed legacy payments table to payments_legacy';
  end if;
end $$;

create table if not exists payments (
  id          uuid primary key default gen_random_uuid(),
  folio_id    uuid not null references folios (id) on delete cascade,
  method      text not null
              check (method in ('cash', 'upi', 'card', 'razorpay', 'ota_prepaid')),
  -- Unconstrained sign: §6 models a refund as a negative payment.
  amount_paise integer not null,
  reference   text,                                     -- UPI ref / Razorpay payment id
  received_at timestamptz not null default now(),
  received_by uuid references auth.users (id)
);

create index if not exists payments_folio_idx on payments (folio_id);

-- ------------------------------------------------------------------- RLS
-- Deny-by-default everywhere; §8 grants anon SELECT on `rates` only (the booking
-- engine has to quote a price). rate_plans stays private — plan metadata is read
-- server-side alongside the quote.
alter table rate_plans  enable row level security;
alter table rates       enable row level security;
alter table folios      enable row level security;
alter table folio_items enable row level security;
alter table payments    enable row level security;

revoke all on rate_plans  from anon;
revoke all on rates       from anon;
revoke all on folios      from anon;
revoke all on folio_items from anon;
revoke all on payments    from anon;

grant select on rates to anon;

drop policy if exists rates_anon_read on rates;
create policy rates_anon_read on rates for select to anon
  using (not closed);
