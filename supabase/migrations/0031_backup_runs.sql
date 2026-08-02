-- Backup telemetry (ROADMAP §4 item 7)
--
-- The backup itself runs OUTSIDE Supabase, in GitHub Actions. Nothing here
-- schedules or performs a dump; the free tier has no pg_cron worth relying on and
-- a backup that runs inside the thing it is backing up is not a backup.
--
-- This table is the only part that lives in the database: one row per attempt, so
-- "backups are working" becomes a fact you can query rather than a claim on a panel.
--
-- Row counts are the point. A dump that succeeds but contains nothing produces
-- byte_size ~2000 next to reservations = 0, sitting directly under yesterday's
-- reservations = 47. That contrast is visible without opening the file. A size
-- check alone would not catch a dump that silently lost one table.

create table if not exists backup_runs (
  id           uuid primary key default gen_random_uuid(),
  -- started_at IS the creation time, so there is no separate created_at: the
  -- house rule is no duplicated business data, and two identical timestamps
  -- would be exactly that.
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  status       text not null default 'running'
               check (status in ('running', 'ok', 'failed')),
  object_key   text,
  byte_size    bigint,
  -- Counted at dump time, from the same connection that produced the dump.
  reservations integer,
  folio_items  integer,
  payments     integer,
  error        text,
  updated_at   timestamptz not null default now()
);

-- Every read is "the recent ones, newest first".
create index if not exists backup_runs_started_idx on backup_runs (started_at desc);

drop trigger if exists set_updated_at on public.backup_runs;
create trigger set_updated_at before update on public.backup_runs
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------ access
--
-- The job writes over a direct Postgres connection as the `postgres` role, which
-- owns the table and bypasses RLS. Nothing in the application writes here, so no
-- role is granted insert/update/delete.
--
-- Owner-only read: a staff member does not need to know the backup schedule, and
-- the object keys name a bucket layout worth keeping quiet.

alter table backup_runs enable row level security;
revoke all on backup_runs from anon, authenticated;
grant select on backup_runs to authenticated;

drop policy if exists backup_runs_owner_read on backup_runs;
create policy backup_runs_owner_read on backup_runs for select to authenticated
  using (coalesce(public.user_role(), '') = 'owner');

-- NOTE for migration 0033 (item 6): this policy calls public.user_role(), which
-- today carries the default PUBLIC execute grant. When that grant is revoked, the
-- same migration MUST re-grant execute to authenticated or this policy starts
-- raising "permission denied for function user_role".
