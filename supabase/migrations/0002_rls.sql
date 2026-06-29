-- Backpackers Storey — Row Level Security (§8 roles)
-- Roles: owner, manager, reception, kitchen, housekeeping.
-- Audiences:
--   all staff           any signed-in profile          -> user_role() is not null
--   front desk          owner / manager / reception     (POS + PMS operators)
--   management          owner / manager                 (config: rooms, menu prices, accounts)
--   kitchen-read        front desk + kitchen            (KOT visibility)
--   housekeeping-write  front desk + housekeeping
--
-- Pattern: a broad "read" policy plus a narrower "write" (for all) policy.
-- Permissive policies are OR'd, so the read audience is the union of both.
-- The service-role key bypasses RLS (used by the Cashfree webhook + admin tasks).

alter table profiles        enable row level security;
alter table menu_categories enable row level security;
alter table menu_items      enable row level security;
alter table rooms           enable row level security;
alter table beds            enable row level security;
alter table guests          enable row level security;
alter table bookings        enable row level security;
alter table housekeeping    enable row level security;
alter table orders          enable row level security;
alter table order_items     enable row level security;
alter table payments        enable row level security;

-- ---------------------------------------------------------------- profiles
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select to authenticated
  using (id = auth.uid() or public.user_role() in ('owner', 'manager'));

drop policy if exists profiles_write on profiles;
create policy profiles_write on profiles for all to authenticated
  using (public.user_role() in ('owner', 'manager'))
  with check (public.user_role() in ('owner', 'manager'));

-- ------------------------------------------------------------------- café
drop policy if exists menu_categories_read on menu_categories;
create policy menu_categories_read on menu_categories for select to authenticated
  using (public.user_role() is not null);
drop policy if exists menu_categories_write on menu_categories;
create policy menu_categories_write on menu_categories for all to authenticated
  using (public.user_role() in ('owner', 'manager', 'reception'))
  with check (public.user_role() in ('owner', 'manager', 'reception'));

drop policy if exists menu_items_read on menu_items;
create policy menu_items_read on menu_items for select to authenticated
  using (public.user_role() is not null);
drop policy if exists menu_items_write on menu_items;
create policy menu_items_write on menu_items for all to authenticated
  using (public.user_role() in ('owner', 'manager', 'reception'))
  with check (public.user_role() in ('owner', 'manager', 'reception'));

-- -------------------------------------------------------------- rooms/beds
drop policy if exists rooms_read on rooms;
create policy rooms_read on rooms for select to authenticated
  using (public.user_role() is not null);
drop policy if exists rooms_write on rooms;
create policy rooms_write on rooms for all to authenticated
  using (public.user_role() in ('owner', 'manager'))
  with check (public.user_role() in ('owner', 'manager'));

drop policy if exists beds_read on beds;
create policy beds_read on beds for select to authenticated
  using (public.user_role() is not null);
drop policy if exists beds_write on beds;
create policy beds_write on beds for all to authenticated
  using (public.user_role() in ('owner', 'manager'))
  with check (public.user_role() in ('owner', 'manager'));

-- ------------------------------------------------------------ guests/stays
drop policy if exists guests_all on guests;
create policy guests_all on guests for all to authenticated
  using (public.user_role() in ('owner', 'manager', 'reception'))
  with check (public.user_role() in ('owner', 'manager', 'reception'));

drop policy if exists bookings_all on bookings;
create policy bookings_all on bookings for all to authenticated
  using (public.user_role() in ('owner', 'manager', 'reception'))
  with check (public.user_role() in ('owner', 'manager', 'reception'));

-- ----------------------------------------------------------- housekeeping
drop policy if exists housekeeping_read on housekeeping;
create policy housekeeping_read on housekeeping for select to authenticated
  using (public.user_role() is not null);
drop policy if exists housekeeping_write on housekeeping;
create policy housekeeping_write on housekeeping for all to authenticated
  using (public.user_role() in ('owner', 'manager', 'reception', 'housekeeping'))
  with check (public.user_role() in ('owner', 'manager', 'reception', 'housekeeping'));

-- --------------------------------------------------------- orders / items
drop policy if exists orders_read on orders;
create policy orders_read on orders for select to authenticated
  using (public.user_role() in ('owner', 'manager', 'reception', 'kitchen'));
drop policy if exists orders_write on orders;
create policy orders_write on orders for all to authenticated
  using (public.user_role() in ('owner', 'manager', 'reception'))
  with check (public.user_role() in ('owner', 'manager', 'reception'));

drop policy if exists order_items_read on order_items;
create policy order_items_read on order_items for select to authenticated
  using (public.user_role() in ('owner', 'manager', 'reception', 'kitchen'));
drop policy if exists order_items_write on order_items;
create policy order_items_write on order_items for all to authenticated
  using (public.user_role() in ('owner', 'manager', 'reception'))
  with check (public.user_role() in ('owner', 'manager', 'reception'));
-- Kitchen advances item status (pending -> preparing -> ready).
drop policy if exists order_items_kitchen_update on order_items;
create policy order_items_kitchen_update on order_items for update to authenticated
  using (public.user_role() = 'kitchen')
  with check (public.user_role() = 'kitchen');

-- --------------------------------------------------------------- payments
drop policy if exists payments_all on payments;
create policy payments_all on payments for all to authenticated
  using (public.user_role() in ('owner', 'manager', 'reception'))
  with check (public.user_role() in ('owner', 'manager', 'reception'));
