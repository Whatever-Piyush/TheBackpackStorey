-- Reception — staff (Step 3)
--
-- Two roles, no permission matrix: `owner` additionally sees rates, direct
-- allotment and daily close; everything else is shared.
--
-- Deliberately separate from the existing `profiles` table, which serves the
-- café POS / Stays portal with a different five-role vocabulary. One person may
-- hold rows in both; merging them would mean rewriting POS authorisation, which
-- this task does not touch.

create table if not exists staff (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  display_name text not null,
  role         text not null default 'staff' check (role in ('owner', 'staff')),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

drop trigger if exists set_updated_at on staff;
create trigger set_updated_at before update on staff
  for each row execute function public.set_updated_at();

-- Is the calling user active reception staff? SECURITY DEFINER so the dashboard
-- can ask without granting anyone a direct read of the table.
create or replace function public.is_staff(p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (select 1 from staff s where s.user_id = p_user_id and s.active);
$$;

alter table staff enable row level security;
revoke all on staff from anon;
revoke insert, update, delete on staff from authenticated;
grant select on staff to authenticated;

-- A staffer may read their OWN row — the shell needs the role to decide which
-- owner-only navigation to render. Nobody can read anyone else's, and staff
-- accounts are provisioned out of band (service role / SQL), never self-serve.
drop policy if exists staff_self_read on staff;
create policy staff_self_read on staff for select to authenticated
  using (user_id = auth.uid() and active);

revoke all on function public.is_staff(uuid) from public, anon;
grant execute on function public.is_staff(uuid) to authenticated;
