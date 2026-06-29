# Supabase — Backpackers Storey

Postgres + Auth + Realtime + Storage backend for the café POS and lite PMS.
The public website (Phase 1) does **not** use this — it's static.

## One-time setup

1. Create a free project at [supabase.com](https://supabase.com).
2. Copy the keys into `../.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL` — Project Settings → API → Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Project Settings → API → `anon` `public`
   - `SUPABASE_SERVICE_ROLE_KEY` — Project Settings → API → `service_role` (server only; never ship to the browser)
3. Run the migrations **in order** in the SQL editor (or via the Supabase CLI):
   1. `migrations/0001_schema.sql`
   2. `migrations/0002_rls.sql`
   3. `migrations/0003_seed.sql`

## Create staff accounts

There is **no public signup**. The owner creates accounts in
**Authentication → Users → Add user** (email + password). A `profiles` row is
created automatically by the `on_auth_user_created` trigger, defaulting to role
`reception`.

Promote yourself to owner once (replace the email):

```sql
update profiles
set role = 'owner'
where id = (select id from auth.users where email = 'you@example.com');
```

Roles: `owner`, `manager`, `reception`, `kitchen`, `housekeeping`. Set each
staffer's role the same way.

## What the migrations enforce

- **Money is integer paise** everywhere, with `>= 0` checks.
- **Terminal states**: orders end at `paid`/`void`; bookings end at
  `checked_out`/`cancelled`/`no_show`.
- **No double-booking**: exclusion constraints stop overlapping active stays
  from sharing a bed (dorm) or a room (private).
- **Kitchen flow**: kitchen staff only update `order_items`; a trigger flips the
  order to `served` when every item is `ready`.
- **RLS on every table**, gated by `profiles.role` (see `0002_rls.sql`).
- **Realtime** is enabled on `orders`, `order_items`, `bookings`, `housekeeping`.

## Storage (pre-launch task)

Create a public bucket (e.g. `property`) and upload the photos from
`../public/photos/`, then point the website's image paths at the bucket. Until
then the site serves them locally from `public/photos/`.
