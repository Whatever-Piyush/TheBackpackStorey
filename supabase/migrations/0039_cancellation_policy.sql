-- Cancellation policy + deposit configuration (Phase 9, Phase 2)
--
-- The POLICY/CONFIG FOUNDATION only. No Razorpay, no holds, no payment or refund
-- flows, no cancellation execution, no status/allocation/folio changes. This file
-- adds two versioned config tables, a deterministic resolver, the server-side cutoff
-- and deposit math, a public read for the guest policy page, and the (nullable)
-- snapshot columns a future booking flow will populate. Money is integer paise
-- (docs/phase9-audit.md §F); percentages are rates, so they are numeric.

-- =================================================================== deposit
-- Versioned deposit configuration. The 20% is DATA, never hard-coded in booking or
-- payment logic. min_amount_paise stays nullable — no minimum has been approved.
create table if not exists deposit_config (
  id               uuid primary key default gen_random_uuid(),
  version          integer not null unique,
  percent          numeric(5,2) not null check (percent >= 0 and percent <= 100),
  min_amount_paise integer check (min_amount_paise is null or min_amount_paise >= 0),
  effective_from   timestamptz not null default now(),
  effective_to     timestamptz,
  created_at       timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from)
);

-- ======================================================= cancellation policy
-- Two INDEPENDENT date dimensions (docs/gateway-and-policies.md §4):
--   effective_from/effective_to  — which version was on offer to NEW bookings when
--                                  the booking was made
--   stay_from/stay_to            — which ARRIVAL dates this rule governs (null = all)
-- A September booking for a December arrival resolves the December rule using the
-- version that was live in September; one pair of columns cannot express that.
create table if not exists cancellation_policies (
  id                    uuid primary key default gen_random_uuid(),
  version               integer not null unique,
  effective_from        timestamptz not null default now(),
  effective_to          timestamptz,
  stay_from             date,
  stay_to               date,
  cutoff_hours          integer not null check (cutoff_hours >= 0),
  refund_percent        numeric(5,2) not null check (refund_percent >= 0 and refund_percent <= 100),
  group_threshold_units integer check (group_threshold_units is null or group_threshold_units > 0),
  group_cutoff_hours    integer check (group_cutoff_hours is null or group_cutoff_hours >= 0),
  body_text             text not null,
  created_at            timestamptz not null default now(),
  check (effective_to is null or effective_to > effective_from),
  check (stay_from is null or stay_to is null or stay_to >= stay_from)
);

create index if not exists cancellation_policies_effective_idx
  on cancellation_policies (effective_from, effective_to);
create index if not exists cancellation_policies_stay_idx
  on cancellation_policies (stay_from, stay_to);

-- ------------------------------------------------------ cutoff computation
-- Check-in is 14:00 Asia/Kolkata; the cancellation cutoff is that instant minus
-- cutoff_hours, returned as an absolute timestamptz so it is never a browser-local
-- time. (14:00 on the arrival date in IST) − cutoff_hours. For the standard 24h
-- policy this lands at 14:00 IST the day before arrival, across month/year
-- boundaries. STABLE, not IMMUTABLE: AT TIME ZONE reads the tz database.
create or replace function public.cancellation_cutoff(
  p_checkin      date,
  p_cutoff_hours integer
)
returns timestamptz
language sql
stable
set search_path = public, pg_temp
as $$
  select ((p_checkin + time '14:00') at time zone 'Asia/Kolkata')
         - make_interval(hours => p_cutoff_hours);
$$;

-- ------------------------------------------------------- deposit computation
-- The deposit in paise: percent of the total, floored at min_amount_paise when one
-- is configured. With min NULL, no floor is applied. Integer paise in, integer out.
create or replace function public.compute_deposit_paise(
  p_total_paise integer,
  p_percent     numeric,
  p_min_paise   integer default null
)
returns integer
language sql
immutable
as $$
  select greatest(
    round(p_total_paise * p_percent / 100.0)::integer,
    coalesce(p_min_paise, 0)
  );
$$;

-- ---------------------------------------------------- policy resolution (§3)
-- The version whose EFFECTIVE window contained the booking instant AND whose STAY
-- window covers the arrival date. Deterministic ordering — never row order:
--   1. most specific stay window first: fully bounded (both dates) beats half
--      bounded beats unbounded; among fully bounded, the NARROWER window wins;
--   2. latest effective_from;
--   3. latest version (final deterministic tiebreak).
-- SETOF so "no policy qualifies" is 0 rows, not a row of NULLs.
create or replace function public.resolve_cancellation_policy(
  p_booked_at timestamptz,
  p_checkin   date
)
returns setof public.cancellation_policies
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select cp.*
    from public.cancellation_policies cp
   where cp.effective_from <= p_booked_at
     and (cp.effective_to is null or p_booked_at < cp.effective_to)
     and (cp.stay_from is null or p_checkin >= cp.stay_from)
     and (cp.stay_to   is null or p_checkin <= cp.stay_to)
   order by
     (case when cp.stay_from is not null and cp.stay_to is not null then 0
           when cp.stay_from is not null or  cp.stay_to is not null then 1
           else 2 end) asc,
     (case when cp.stay_from is not null and cp.stay_to is not null
           then (cp.stay_to - cp.stay_from) end) asc nulls last,
     cp.effective_from desc,
     cp.version        desc
   limit 1;
$$;

-- ------------------------------------------------- guest-facing published policy
-- The standard (unbounded stay) policy in effect now — what /policies/cancellation
-- renders. Returns the wording only; SECURITY DEFINER so anon never reads the table.
create or replace function public.public_cancellation_policy()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
           'version',       cp.version,
           'body',          cp.body_text,
           'cutoffHours',   cp.cutoff_hours,
           'refundPercent', cp.refund_percent)
    from public.cancellation_policies cp
   where cp.effective_from <= now()
     and (cp.effective_to is null or now() < cp.effective_to)
     and cp.stay_from is null and cp.stay_to is null
   order by cp.effective_from desc, cp.version desc
   limit 1;
$$;

-- ================================================ reservation snapshot columns
-- Additive and NULLABLE. A future booking flow (Phase 3/4) writes these ONCE, at
-- booking time, from the resolver + cutoff + deposit math above; they are never
-- recomputed from the live policy/config, so editing a policy later cannot move an
-- existing guest's terms. Existing reservations keep NULLs. This phase does NOT
-- populate them and does NOT change /api/book.
alter table reservations add column if not exists policy_version_id uuid
  references cancellation_policies (id);
alter table reservations add column if not exists policy_text_snapshot text;
alter table reservations add column if not exists cancellation_cutoff_at timestamptz;
alter table reservations add column if not exists deposit_percent_snapshot numeric(5,2);
alter table reservations add column if not exists deposit_amount_paise integer
  check (deposit_amount_paise is null or deposit_amount_paise >= 0);
-- Records that the guest accepted the shown policy (Part 6). Timestamp only; wiring
-- the acceptance into checkout is Phase 3/4.
alter table reservations add column if not exists policy_accepted_at timestamptz;

-- ================================================================== security
-- Deny-by-default, like reservations/folios. No client ever reads or writes policy
-- or config directly; the guest page reads through public_cancellation_policy(),
-- and Phase 3/4 writes happen server-side on the service role.
alter table deposit_config        enable row level security;
alter table cancellation_policies enable row level security;
revoke all on deposit_config        from anon, authenticated;
revoke all on cancellation_policies from anon, authenticated;

revoke all on function public.cancellation_cutoff(date, integer)            from public, anon;
revoke all on function public.compute_deposit_paise(integer, numeric, integer) from public, anon;
revoke all on function public.resolve_cancellation_policy(timestamptz, date) from public, anon;
grant execute on function public.cancellation_cutoff(date, integer)            to authenticated, service_role;
grant execute on function public.compute_deposit_paise(integer, numeric, integer) to authenticated, service_role;
grant execute on function public.resolve_cancellation_policy(timestamptz, date) to authenticated, service_role;
-- The policy page is public.
revoke all on function public.public_cancellation_policy() from public;
grant execute on function public.public_cancellation_policy() to anon, authenticated, service_role;

-- ====================================================================== seed
-- Standard policy, version 1: 20% deposit, 24h cutoff, 100% of the deposit
-- refunded before the cutoff, applies to ALL arrival dates (stay null), group
-- fields undecided (null). effective_from is set well in the past so the standard
-- terms are the baseline for every booking; a later version supersedes it by
-- carrying a newer effective_from.
insert into cancellation_policies (
  version, effective_from, effective_to, stay_from, stay_to,
  cutoff_hours, refund_percent, group_threshold_units, group_cutoff_hours, body_text)
values (
  1, timestamptz '2020-01-01 00:00:00+05:30', null, null, null,
  24, 100, null, null,
  'A 20% deposit, paid online, confirms your booking. The remaining 80% is settled ' ||
  'at the property by cash or UPI.' || E'\n\n' ||
  'Free cancellation until the deadline shown on your confirmation — 2:00 PM (IST) ' ||
  'on the day before your arrival. Cancel by then and your deposit is refunded in full.' || E'\n\n' ||
  'Cancelling after that deadline, or not arriving (a no-show), forfeits the deposit. ' ||
  'Nothing beyond the deposit is ever taken online.')
on conflict (version) do nothing;

insert into deposit_config (version, percent, min_amount_paise, effective_from)
values (1, 20, null, timestamptz '2020-01-01 00:00:00+05:30')
on conflict (version) do nothing;
