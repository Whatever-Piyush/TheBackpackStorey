# Security remediation — analysis before implementation

> Companion to `docs/Roadmap.md` §4. The review itself is done; this document is the
> **analysis that must precede the fixes**, in the order you set: backups first, because
> every other item is a migration against a database with no recovery path.
>
> Foundation is frozen. All schema changes are additive from **0031**. No business,
> reservation, or allocation logic is touched by any item here.

---

## Provenance of every claim below

Everything marked **verified** was executed against the full 30-migration chain applied to
Postgres 17 in Docker, using `set role anon` / `set role authenticated` / `set role
service_role`. Everything marked **unverifiable here** needs the live Supabase project and
is listed again in §7 so it cannot be quietly forgotten.

The distinction matters: a local probe proves *database-level* enforcement (RLS + grants).
It does not prove what the hosted PostgREST, Storage, or Auth layers do.

---

## 0. Security Status panel — INVESTIGATED, NOTHING TO FIX

**The panel does not exist.** No component, page, or partial renders "Nightly Backups
Enabled", "Last Backup", "Webhook Secret Configured", "Passport Bucket Private", "Service
Role Key Safe", or "No Pending Security Alerts".

Evidence:

| Search | Result |
|---|---|
| Case-insensitive grep for all six strings across the whole repo (excluding `node_modules`, `.next`, `.git`) | 1 hit: `docs/Roadmap.md:314`, the roadmap's own "Nightly backup:" requirement |
| `find src -iname "*security*"` | no files |
| Files containing "security" anywhere in `src/` | 2, both comments describing `SECURITY DEFINER` (`src/lib/pos/kitchen.ts:111`, `src/lib/reception/dashboard.ts:10`) |
| `git log --all -S "Security Status"` and `-S "Nightly Backups"` | no commits — it was never in history and has not been deleted |

The nearest real thing is `src/components/stays/channel-status.tsx`. It is an honest panel:
every value (`Waiting`, `To type in`, `Failed`, `Sent today`) comes from `channel_status()`
reading `channel_outbox`. It makes no security claims and hardcodes nothing.

**Conclusion:** there is no panel lying to the owner, because there is no panel. Nothing to
wire up and nothing to delete.

**If you want one built later**, it is only worth building on real checks, and three of the
six lines cannot be honestly computed today:

| Line | Honest source | Status |
|---|---|---|
| Nightly Backups Enabled | `select count(*) from backup_runs where status='ok' and started_at > now() - interval '48 hours'` | needs item 1 |
| Last Backup | `max(finished_at)` + byte size from `backup_runs` | needs item 1 |
| Webhook Secret Configured | server-side `Boolean(process.env.CHANNEL_<provider>_SECRET)` | needs item 3 |
| Passport Bucket Private | Storage admin API read of the bucket's `public` flag | live-only check |
| Service Role Key Safe | build-time assertion that the key is absent from `.next/static` | CI check, not a runtime panel line |
| No Pending Security Alerts | meaningless without a defined alert source | do not build |

Your constraint is recorded and binding for every item below: **no panel line may ever be
satisfied by hardcoding it green.** The `backup_runs` table in item 1 exists precisely so
that "backups are working" becomes a queryable fact rather than an assertion.

---

## 1. Backups — design

### What the free tier actually gives you

Supabase Free has **no point-in-time recovery**. If the project is deleted, paused past its
retention, or corrupted by a bad migration, every reservation, folio, and payment is gone.
The roadmap's own wording — *"the single largest operational risk in the project"* — is
accurate, and it is currently unmitigated.

### Shape of the job

```
pg_dump --format=custom --no-owner --no-privileges
  → gzip
  → age (or gpg --symmetric) with a passphrase held only in the secret store
  → PUT to Cloudflare R2 (S3-compatible)  [or Backblaze B2]
  → INSERT one row into backup_runs
```

Off Supabase, as you specified. **Not** GitHub release artifacts — they expire, and a
backup with an expiry date is not a backup.

Retention **7 daily + 4 weekly**, enforced by the job itself (list, sort, delete beyond
policy) rather than by bucket lifecycle rules, so the retention logic is visible in code and
testable.

### `backup_runs` — making a 2 KB dump visibly different from a real one

```sql
create table backup_runs (
  id            uuid primary key default gen_random_uuid(),
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running'
                check (status in ('running','ok','failed')),
  object_key    text,
  byte_size     bigint,
  reservations  integer,
  folio_items   integer,
  payments      integer,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
```

Row counts are the point. A dump that succeeds but contains nothing produces
`byte_size ≈ 2000, reservations = 0` next to yesterday's `reservations = 47`, and that
contrast is visible without opening the file. A size check alone would not catch a dump
that silently lost one table.

The job writes `status='running'` at start and updates to `ok`/`failed` at the end, so a job
killed mid-run leaves a `running` row rather than no row — silence and success stay
distinguishable.

### Where it runs — and the GitHub Actions problem

You flagged this correctly. **GitHub disables scheduled workflows after ~60 days of
repository inactivity.** This project will go quiet after launch, which is exactly when the
backups matter most. The failure is silent by design: the workflow simply stops firing.

Honest options:

| Option | Cost | Verdict |
|---|---|---|
| GitHub Actions + dead-man's-switch | free | **Recommended for now.** The switch, not the workflow, is what makes it safe. |
| Supabase Pro | $25/mo | **The real answer.** Daily backups + PITR, no cron to babysit. Roadmap §5 already anticipates this. |
| Fly.io / Render cron | ~$0–5/mo | Works, but adds a second platform to maintain for one shell script. |
| Machine at the property | free | No. Hill internet, and the backup would sit in the same building as the risk. |

**What alerts you when a backup fails to land** — this is the part that matters more than
the job:

A **dead-man's switch** (healthchecks.io free tier, or any equivalent). The job pings a
unique URL only on success. If no ping arrives inside the expected window, the service
emails/messages you. This catches *every* failure mode with one mechanism:

- workflow disabled for inactivity → no ping → alert
- R2 credentials expired → no ping → alert
- `pg_dump` fails → no ping → alert
- GitHub Actions outage → no ping → alert

A workflow that alerts on its own failure cannot alert you when it never runs. That is why
the alert has to live outside GitHub. GitHub does email the repo admin when it disables a
workflow, but that mail is easy to miss and easy to filter.

**My recommendation, stated plainly:** ship the script with the dead-man's switch now, and
treat Supabase Pro as the intended destination as soon as the property can justify $25/mo.
The script remains useful either way — an off-provider encrypted copy protects against
account loss, which PITR does not.

### As built — and what rehearsing it locally found

The scripts were exercised against the migrated Postgres 17 container with a stubbed S3
layer. That is not a substitute for the real rehearsal, but it did surface **five defects
that would each have produced a backup you could not restore from:**

1. **`psql` prints the command tag.** `insert … returning id` emits both the uuid *and*
   `INSERT 0 1` on stdout, so `RUN_ID` captured two lines and every later `UPDATE` failed
   with `invalid input syntax for type uuid`. Fixed with `-q`.
2. **`pipefail` + `head` killed the run.** `pg_dump --version | grep … | head -1` — `head`
   exits after one line, `grep` takes SIGPIPE, the pipeline reports failure, and the whole
   backup aborted before it started. `head` is now gone from every pipeline in both scripts.
3. **`$$` in bash is the process id.** The failure handler dollar-quoted its message as
   `$$…$$`, which bash expanded to `<pid>…<pid>` before Postgres saw it — so *failures were
   never recorded* and the row stayed `running` forever. Now escaped by doubling quotes.
4. **Dropping `public` destroys the extensions.** `pgcrypto` and `btree_gist` live in that
   schema, and `pg_dump --schema=public` never emits `CREATE EXTENSION`. The restore died
   partway with `data type uuid has no default operator class for access method gist`,
   leaving a half-populated database. The restore now recreates them before loading.
5. **`--schema=public` alone cannot be restored at all.** `public.profiles` has a foreign
   key to `auth.users`. Into a fresh project that COPY fails on `profiles_id_fkey` and *no
   business data lands*. The archive is now a two-file bundle — `auth_users.sql` loaded
   first, then `public.sql`.

Defects 4 and 5 are the ones that matter: both produced a backup that looked perfectly
healthy — correct size, correct row counts, green status — and could not be restored.

**Verified locally, end to end:** restored into a scratch database, source and restore agree
exactly (`reservations`, `allocations`, `units`, `guests`, `rooms`, `rates`, `menu_items`,
293 functions, 25 policies), RLS still enabled on every guest table, and
`allocations_no_overlap` still **rejects an overlapping insert in the restored database** —
the anti-double-booking guarantee survives the round trip. Retention prunes to exactly 7
daily / 4 weekly. A verification failure records `status='failed'` with the reason.

**Still NOT verified, and not to be treated as tested:** the real thing — against the live
Supabase project, over the network, with real R2 credentials. In particular the `auth.users`
capture is the piece most likely to need adjustment, because the local stand-in has three
columns and Supabase's real table has far more.

### Rehearsal — run this yourself

Prerequisites locally: `postgresql-client-17`, `gnupg`, `awscli`.

```bash
# 0. Create a SECOND, scratch Supabase project. Never rehearse into production.

# 1. Point at production and take one backup by hand.
export DATABASE_URL='postgresql://postgres:PASSWORD@db.PROJECT.supabase.co:5432/postgres'
export BACKUP_PASSPHRASE='the-passphrase-from-your-password-manager'
export S3_BUCKET='bs-backups'
export S3_ENDPOINT='https://ACCOUNT_ID.r2.cloudflarestorage.com'
export AWS_ACCESS_KEY_ID='r2-access-key'
export AWS_SECRET_ACCESS_KEY='r2-secret-key'

scripts/backup.sh

# 2. Confirm it landed, and that the row counts look like a real property.
scripts/restore.sh --list
psql "$DATABASE_URL" -c \
  "select started_at, status, byte_size, reservations, folio_items, payments
     from backup_runs order by started_at desc limit 5"

# 3. Restore into the SCRATCH project. The script refuses if the target host AND
#    database both match DATABASE_URL, so this cannot silently hit production.
scripts/restore.sh \
  --target 'postgresql://postgres:PASSWORD@db.SCRATCH.supabase.co:5432/postgres' \
  --key daily/YYYY-MM-DD.tar.gz.gpg

# 4. The restore prints its own row counts. Compare them against step 2.
#    They must match. If they do not, stop and tell me what differs.

# 5. Prove the constraint survived — this MUST fail with 23P01:
psql 'postgresql://…SCRATCH…' -c \
  "insert into allocations (unit_id, reason, stay)
     select id, 'maintenance', daterange('2030-01-01','2030-01-05','[)') from units limit 1;
   insert into allocations (unit_id, reason, stay)
     select id, 'maintenance', daterange('2030-01-03','2030-01-07','[)') from units limit 1;"

# 6. Delete the scratch project.
```

If step 3 stops on `profiles_id_fkey`, the `auth.users` capture did not transfer between
projects. Re-run step 3 with `RESTORE_SKIP_FK=yes` to land the business data anyway, then
re-invite the three staff — and tell me, because it means that part needs adjusting.

### Setting up the alerting

1. Create a check at healthchecks.io with period 1 day, grace 6 hours.
2. Add its ping URL as the `HEALTHCHECK_URL` GitHub secret.
3. Add a phone-delivered integration. **SMS and WhatsApp may require a paid plan** — confirm
   current limits when you set it up. If they do, **Telegram or Signal reach the same phone
   for free** and satisfy the "not email" requirement. Do not leave it on email only.
4. Test it deliberately: pause the check or skip a night, and confirm the alert arrives on
   your phone. An untested alert is not an alert.

### Passphrase custody — do not skip this

`BACKUP_PASSPHRASE` must exist somewhere **other than GitHub secrets** — a password manager.
Losing access to the GitHub account is one of the scenarios these backups exist to survive,
and an encrypted archive whose only passphrase lived in that account is unrecoverable.

---

## 2. `sync_units_for_room` grants — callers first

### Every caller — verified

```
supabase/migrations/0005_inventory.sql:128   the definition
supabase/migrations/0005_inventory.sql:175   perform … inside a trigger function
supabase/migrations/0005_inventory.sql:187   perform … inside a trigger function
supabase/migrations/0005_inventory.sql:214   perform … inside a trigger function
supabase/migrations/0005_inventory.sql:232   perform … inside a trigger function
```

**Zero callers in `src/`. Zero in `tests/`.** No admin path, no room-management path, no
client of any kind calls it. Every caller is a trigger, and triggers execute the function
under the definer's rights regardless of the invoker's `EXECUTE` privilege.

**Revoking is therefore safe** — room and bed creation continue to work unchanged. This
matches your concern exactly; had a room-management screen called it through the
authenticated client, revoking would have broken room creation.

### The full `proacl IS NULL` sweep — your instinct was right

You said: *if the default PUBLIC grant was missed here, assume it was missed elsewhere.*
It was. Sweeping **all** functions in `public` (not just SECURITY DEFINER) found, after
excluding the `pgcrypto` and `btree_gist` extension functions whose default grants are
normal:

| Function | Kind | Exposure |
|---|---|---|
| `sync_units_for_room(uuid)` | **SECURITY DEFINER**, callable | **Confirmed exploitable.** Writes to `units`, floods `channel_outbox`. |
| `user_role()` | **SECURITY DEFINER**, callable | Returns NULL for anon — no disclosure, but should not be public. |
| `create_reservation(jsonb, date, date, jsonb, text, uuid[], uuid, text)` | SECURITY INVOKER, callable | **Newly found.** Default PUBLIC grant, never revoked. |
| `gen_reservation_code()` | invoker | Generates a code string; no data access. |
| `is_foreign_national(...)`, `pos_item_kind(...)` | invoker | Pure helpers, no data access. |
| 11 trigger functions | `returns trigger` | Not directly callable — Postgres refuses (`trigger functions can only be called as triggers`), verified. |

**The `create_reservation` finding explained.** Migrations 0010, 0011, and 0012 each
explicitly revoked `create_reservation` from `public, anon, authenticated` — but each
revoke names a *specific signature*. Migration 0028 created a **new** signature (dropping
`p_respect_allotment`, adding actor columns), and a new signature is a new object with fresh
default privileges. The revoke did not carry over.

Is it exploitable? **No — verified.** It is SECURITY INVOKER, so it runs with the caller's
own privileges. anon calling it dies at:

```
ERROR:  permission denied for table channels
CONTEXT:  SQL expression "not exists (select 1 from channels where code = p_source and active)"
```

It is stopped by table grants, not by function grants. But it should still be revoked, for
one specific reason: **the day anyone converts that function to SECURITY DEFINER, it becomes
an unauthenticated booking engine.** The defence currently rests on a property of the
function nobody has written down.

### Proposed migration 0031 (item 2 portion)

```sql
revoke all on function public.sync_units_for_room(uuid) from public, anon, authenticated;
revoke all on function public.create_reservation(jsonb, date, date, jsonb, text, uuid[], uuid, text)
  from public, anon, authenticated;
```

---

## 3. Webhook — fail closed

### The actual defect

Not the missing secret. This:

```ts
const secret = process.env.CHANNEL_MOCK_SECRET;
if (!secret) return true;   // ← unconfigured means "allow everyone"
```

Setting the secret hides it until someone rotates env vars, deploys to a new environment, or
typos a variable name — and then the door reopens silently. You are right that this is the
bug.

### Changes

1. **`verify()` returns `false` when the secret is unconfigured.** Never true. An
   unconfigured provider rejects everything, and the failure is loud.
2. **Constant-time comparison** — `crypto.timingSafeEqual`, with an explicit length check
   first, since `timingSafeEqual` throws on length mismatch.
3. **Replay window** — require a timestamp header, reject outside ±5 minutes, and make the
   signature cover `timestamp + "." + rawBody` so the timestamp cannot be swapped.
4. **Provider resolved from server configuration**, via `getActiveDistribution()`, not from
   the URL path. A path segment that disagrees with configuration returns 404.
5. **`mock` unroutable in production** — the mock provider is registered only when
   `NODE_ENV !== "production"`, so `/api/channel/mock/webhook` 404s in production even if
   someone sets a mock secret.
6. **Request-size cap** — reject bodies over a fixed limit before parsing.
7. **Rate limit** — `check_rate_limit` on the route, keyed per provider.

---

## 4. `create_channel_reservation` guard — same commit as item 3

### Why it fails — verified

```sql
if coalesce(public.user_role(), '') not in ('owner', 'manager', 'reception') then
  raise exception 'not permitted' using errcode = 'insufficient_privilege';
end if;
```

`user_role()` resolves the caller through `auth.uid()`. The webhook path runs under the
service-role client, which carries no JWT, so `auth.uid()` is NULL, `user_role()` is NULL,
and the guard raises. Verified directly:

```
user_role() under service_role = [NULL]  => guard evaluates: RAISES not permitted
```

Every inbound Channel Manager reservation would 422 in production.

### One correction to your proposed approach

You offered "an explicit source argument, or gating on `session_user`". **`session_user` is
the wrong primitive on Supabase.** PostgREST connects as the `authenticator` login role and
then issues `SET LOCAL ROLE service_role` per request. `SET ROLE` changes `current_user` but
leaves `session_user` as `authenticator` — so a `session_user = 'service_role'` check would
never match, and a `session_user = 'authenticator'` check would match *every* PostgREST
request including anon ones. That is the hole you were explicitly trying to avoid.

The correct primitive is **`current_user`**, which does reflect the `SET ROLE`.

### Proposed guard

```sql
if current_user in ('service_role', 'postgres') then
  null;                          -- trusted machine caller: the webhook, post-signature
elsif coalesce(public.user_role(), '') in ('owner', 'manager', 'reception') then
  null;                          -- staff at the desk, typing an OTA booking in
else
  raise exception 'not permitted' using errcode = 'insufficient_privilege';
end if;
```

This widens nothing for browser-facing roles: `anon` and `authenticated` are unchanged and
still rejected. It admits exactly one new caller — the service role, which already bypasses
RLS and can write to these tables directly anyway.

### The dependency, stated explicitly

**After item 4, the signature verification from item 3 is the only thing between the public
internet and injected reservations.** Today the broken guard is accidentally holding that
line. That is why these ship as one commit and why I will show both diffs side by side.
Item 4 must never be applied on its own.

---

## 5. Public RPC rate limiting — report before changing

### Does any client component call the three RPCs directly? — verified

**No client component does.** All three call sites are server-side; none of the three files
carries `"use client"`:

| Caller | RPC | Supabase client |
|---|---|---|
| `src/app/api/book/route.ts:102` | `public_availability` | `createAdminClient()` — service role |
| `src/lib/booking/lookup.ts:47` | `public_booking_lookup` | `createAdminClient()` — service role |
| `src/lib/booking/availability.ts:49,69,91` | `public_availability`, `public_quote` | **`createPublicClient()` — the anon client** |

### The complication your instruction did not anticipate

`src/lib/booking/availability.ts` is server code, but it deliberately authenticates **as
anon**. `src/lib/supabase/public.ts` is the cookie-free client added specifically so the
room pages could keep ISR — a cookie-reading client opts a route out of static generation.

So revoking `anon` EXECUTE splits cleanly in two:

- **`public_booking_lookup` — revoke now, zero risk.** Its only caller uses the admin client,
  and rate limiting already applies at `src/lib/booking/lookup.ts:49`.
- **`public_availability` / `public_quote` — revoking breaks the room pages and the booking
  widget** unless `availability.ts` moves off the anon client first.

### Options for the two availability functions

| Option | Effect | Trade-off |
|---|---|---|
| **A. Switch `availability.ts` to `createAdminClient()`, then revoke all three** | one enforcement point, as you wanted | service-role key used for public reads; ISR still works (server-only, build time), but blast radius grows if that module is ever imported client-side |
| **B. Keep anon EXECUTE on the two read-only functions** | no code change | app-layer rate limit stays bypassable via `/rest/v1/rpc/…` |
| **C. In-function rate limiting** | limit applies wherever it is called from | **the IP must be passed in as an argument — trivially forged.** Postgres cannot see the real client IP |

**Recommendation: A**, with one guard rail — an ESLint or build-time assertion that
`@/lib/supabase/admin` is never reachable from a `"use client"` module. Option C is the one
to avoid: it looks like the strongest option and is the weakest, because a limit keyed on a
forgeable value is a limit that reports success while doing nothing. If you pick C anyway, I
will key it on the passed IP and state in the code comment that it is advisory only.

Note that both functions are pure read-only counts and prices — no guest data, no unit ids
(roadmap M3 §1). The exposure is request-volume, not disclosure.

---

## 6. Low-severity cleanup

| Change | Verified safe? |
|---|---|
| `revoke all on direct_allotment from anon` | Deprecated since 0028; grep shows zero readers in `src/`, `tests/`, and post-0028 migrations |
| `revoke all on function public.user_role() from public` | No direct RPC calls from any client. Callers are all SECURITY DEFINER functions, which run as the definer and are unaffected |
| Narrow anon-readable `room_types` columns | **Needs one more check before implementing.** `availability.ts:52` selects only `id`, but the marketing room pages read room types through other paths; I will enumerate the rendered columns first and narrow to exactly that set, rather than guess and break a page |

Current anon-readable `room_types` columns are the whole table: `active, base_occupancy,
base_rate_paise, code, created_at, deleted_at, gender_policy, id, is_dorm, max_occupancy,
name, sell_mode, sort_order, updated_at`. Nothing sensitive — this is tidying an over-broad
grant, not closing a leak. `rooms` is already correctly narrowed to `id, number,
room_type_id, type`.

---

## 7. What cannot be verified from this sandbox

Carried forward into the final report, not resolved by any item above:

1. **Live storage bucket state.** The local Postgres has no `storage` schema, so `0017`'s
   bucket creation is skipped by its own guard. Migration source shows `public = false` and
   no `storage.objects` policies, which is correct by construction — but passport and visa
   scans are the most sensitive data in the system and this is the one control I have
   confirmed least. Needs: bucket privacy confirmed in the dashboard, and an
   unauthenticated request to a stored object confirmed to 404.
2. **Restore rehearsal against Supabase.** The round trip is proven *locally* — dump,
   encrypt, decrypt, restore into a scratch database, counts and constraints verified (§1).
   What is unproven is the real path: the live project, the network, real R2 credentials,
   and above all whether `auth.users` transfers between two Supabase projects, since the
   local stand-in for that table has three columns and the real one has many more. Until
   you have run §1's rehearsal, treat the backup as unproven.
3. **End-to-end anon probe over HTTPS with the real anon key.** The local probe proves RLS
   and grants. It does not exercise hosted PostgREST, Storage, or Auth.
4. **Whether Supabase's own default privileges differ from local.** Supabase's bootstrap
   sets `alter default privileges … grant … to anon, authenticated, service_role` for objects
   created by `postgres`. If those defaults are in force on the live project, more functions
   may carry grants there than appear here — the explicit `revoke` statements in items 2
   and 6 are correct regardless, but the live grant listing should be re-run after deploy.
5. **That the dead-man's switch actually fires.** Provable only by deliberately skipping a
   backup and confirming the alert arrives. Worth doing once, deliberately.

---

## Migration plan

| Migration | Contents | Item |
|---|---|---|
| `0031_backup_runs.sql` | `backup_runs` table, `updated_at` trigger, RLS deny-by-default, owner-only read | 1 |
| `0032_function_grants.sql` | revokes for `sync_units_for_room`, `create_reservation` (0028 signature), `user_role`, `direct_allotment`, narrowed `room_types` | 2, 6 |
| `0033_channel_guard.sql` | `create_channel_reservation` guard on `current_user` — **same commit as the item 3 route changes** | 4 |
| `0034_public_rpc_grants.sql` | revoke anon EXECUTE per your decision on §5 option A/B/C | 5 |

Item 3 is TypeScript only and carries no migration.

Nothing above alters reservation, allocation, or pricing logic. The only behavioural change
to a working path is item 4, which turns a guaranteed failure into a working one.
