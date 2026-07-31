-- Channels as data, not as a CHECK constraint (docs/Channel_manager.md §5a, §9a)
--
-- `reservations.source` was constrained by a hardcoded list of OTAs, so adding
-- Agoda or Expedia meant a schema migration. The whole point of the channel
-- redesign is that a new OTA is an INSERT.
--
-- The existing source VALUES are kept exactly as they are — this is a schema
-- change, not a data migration. `channels.kind` becomes the authoritative way to
-- ask "is this an OTA?", replacing the `source like 'ota\_%'` string matching
-- that was scattered around.

create table if not exists channels (
  code       text primary key,
  name       text not null,
  -- direct: we took it ourselves · ota: came through a marketplace
  -- manual:  entered by staff on someone else's behalf
  kind       text not null check (kind in ('direct', 'ota', 'manual')),
  active     boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists set_updated_at on channels;
create trigger set_updated_at before update on channels
  for each row execute function public.set_updated_at();

alter table channels enable row level security;
revoke all on channels from anon;
-- Staff screens need to list channels; nobody edits them from a browser.
revoke insert, update, delete on channels from authenticated;
grant select on channels to authenticated;

drop policy if exists channels_read on channels;
create policy channels_read on channels for select to authenticated
  using (active);

-- Codes match the source values already in use, so no row has to be rewritten.
insert into channels (code, name, kind, sort_order) values
  ('website',         'Website',      'direct', 1),
  ('walk_in',         'Walk-in',      'direct', 2),
  ('phone',           'Phone',        'direct', 3),
  ('ota_booking',     'Booking.com',  'ota',    10),
  ('ota_goibibo',     'Goibibo / MMT','ota',    11),
  ('ota_hostelworld', 'Hostelworld',  'ota',    12),
  ('ota_airbnb',      'Airbnb',       'ota',    13),
  ('ota_agoda',       'Agoda',        'ota',    14),
  ('ota_expedia',     'Expedia',      'ota',    15),
  ('other',           'Other',        'manual', 90)
on conflict (code) do nothing;

-- ------------------------------------------------- source becomes a reference
-- Any source already in the table must exist as a channel first, or the FK
-- cannot be added. Nothing should be missing, but say so loudly if it is.
do $$
declare
  v_orphans text;
begin
  select string_agg(distinct r.source, ', ') into v_orphans
    from reservations r
   where not exists (select 1 from channels c where c.code = r.source);

  if v_orphans is not null then
    raise exception 'reservations reference unknown channels: %', v_orphans;
  end if;
end $$;

alter table reservations drop constraint if exists reservations_source_check;

alter table reservations drop constraint if exists reservations_source_fkey;
alter table reservations add constraint reservations_source_fkey
  foreign key (source) references channels (code) on update cascade;

create index if not exists reservations_source_idx on reservations (source);

-- ------------------------------------------------------------ how we publish
-- One row. Inventory is ALWAYS pooled; this only decides how the recalculated
-- numbers reach the outside world.
create table if not exists property_settings (
  id                integer primary key default 1 check (id = 1),
  distribution_mode text not null default 'manual'
                    check (distribution_mode in ('manual', 'channel_manager')),
  updated_at        timestamptz not null default now()
);

insert into property_settings (id) values (1) on conflict (id) do nothing;

drop trigger if exists set_updated_at on property_settings;
create trigger set_updated_at before update on property_settings
  for each row execute function public.set_updated_at();

alter table property_settings enable row level security;
revoke all on property_settings from anon, authenticated;

-- ------------------------------------------------------- installed provider
-- Which implementation the registry should return. Config holds endpoint and
-- credential references — never secrets in plaintext; those live in env.
create table if not exists channel_providers (
  id          uuid primary key default gen_random_uuid(),
  provider_id text not null unique,
  label       text not null,
  config      jsonb not null default '{}'::jsonb,
  active      boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- At most one active provider: two would fight over the same inventory.
create unique index if not exists channel_providers_one_active
  on channel_providers ((true)) where active;

drop trigger if exists set_updated_at on channel_providers;
create trigger set_updated_at before update on channel_providers
  for each row execute function public.set_updated_at();

alter table channel_providers enable row level security;
revoke all on channel_providers from anon, authenticated;

/** Is this channel a marketplace? Replaces `source like 'ota\_%'`. */
create or replace function public.is_ota_channel(p_code text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from channels c where c.code = p_code and c.kind = 'ota');
$$;

/** How the property publishes availability right now. */
create or replace function public.distribution_mode()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select distribution_mode from property_settings where id = 1), 'manual');
$$;

revoke all on function public.is_ota_channel(text) from public, anon;
revoke all on function public.distribution_mode() from public, anon;
grant execute on function public.is_ota_channel(text) to authenticated;
grant execute on function public.distribution_mode() to authenticated;
