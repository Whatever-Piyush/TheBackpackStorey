-- Populate the staff roster from the existing profiles
--
-- Found by replaying this chain against a restored production dump: after
-- migrating, `staff` is empty, because nothing has ever inserted into it. The
-- owner's profile says role='owner' and user_role() returns 'owner', but
-- is_staff() reads the `staff` table and returns false — so /reception raises
-- 'not reception staff' for the only account that exists.
--
-- Blast radius, measured rather than assumed:
--   is_staff()  is read by exactly ONE function: reception_dashboard.
--   user_role() is read by 21 functions and all 19 RLS policies.
-- So the lockout is confined to /reception. The POS and the Stays console gate on
-- user_role() and were never affected.
--
-- ⚠️ The two role vocabularies are NOT the same, and this is the trap:
--
--   profiles.role  in (owner, manager, reception, kitchen, housekeeping)
--   staff.role     in (owner, staff)
--
-- Copying profiles.role straight across would violate staff_role_check on the
-- first manager or receptionist and abort the migration mid-chain. Everything
-- except owner therefore maps to 'staff'.

insert into staff (user_id, display_name, role, active)
select
  p.id,
  -- display_name is NOT NULL and profiles.full_name is not guaranteed.
  coalesce(nullif(btrim(coalesce(p.full_name, '')), ''), 'Staff'),
  case when p.role = 'owner' then 'owner' else 'staff' end,
  true
from profiles p
where p.role is not null
-- staff_pkey is on user_id, so this genuinely deduplicates. Re-running the
-- migration is a no-op, and an owner who has already edited the roster keeps
-- their edits.
on conflict (user_id) do nothing;

-- Every profile is included, not just the three front-desk roles. reception_dashboard
-- is the only thing gated by is_staff(), and one of the keys it returns is
-- `needsCleaning` — housekeeping's own worklist. Excluding them would lock the
-- people who need that screen out of it, which is the same class of mistake this
-- migration exists to correct.
--
-- To narrow it later:  delete from staff where user_id in
--                        (select id from profiles where role = 'kitchen');
