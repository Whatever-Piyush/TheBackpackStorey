# RESTORE — bringing the database back

Read this before you need it. If you are reading it during an outage, start at §3.

Nothing here names a specific archive, and no passphrase appears in this file. The
passphrase lives in the password manager; the archives live in R2.

---

## 1. What a backup archive is

One encrypted file per night, produced by `scripts/backup.sh`:

```
pg_dump → gzip → gpg (AES256 symmetric) → Cloudflare R2
```

Object keys:

| Key | Kept |
|---|---|
| `daily/<YYYY-MM-DD>.tar.gz.gpg` | 7 most recent |
| `weekly/<YYYY>-W<WW>.tar.gz.gpg` | 4 most recent |

**Two archive layouts exist, and `scripts/restore.sh` handles both:**

| Layout | Produced by | Used for |
|---|---|---|
| `public.sql` + `auth_users.sql` | `scripts/backup.sh` | the nightly job |
| `<stamp>-schema.sql` + `<stamp>-data.sql` | `supabase db dump` | dumps taken by hand |

Both include the **`auth` schema**. That matters: `public.profiles` has a foreign key to
`auth.users`, so a `public`-only dump cannot be restored into a fresh project at all — the
`profiles` COPY fails and no business data lands. It also means an archive contains staff
identities, which is why it is encrypted and why `backups/` is gitignored.

## 2. Taking a dump by hand

Before any risky migration, or any time you want a known-good point:

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
supabase db dump --linked -s public,auth -f "backups/prod-${STAMP}-schema.sql"
supabase db dump --linked --data-only --use-copy -s public,auth -f "backups/prod-${STAMP}-data.sql"
```

`supabase db dump --linked` provisions a temporary login role through the Management API, so
it needs no database password.

Then encrypt it, and **verify the round-trip before deleting the plaintext**:

```bash
tar -cf "backups/prod-${STAMP}.tar" -C backups \
    "prod-${STAMP}-schema.sql" "prod-${STAMP}-data.sql"
gzip -9 -c "backups/prod-${STAMP}.tar" | \
  gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-fd 3 --output "backups/prod-${STAMP}.tar.gz.gpg" 3<<<"$BACKUP_PASSPHRASE"

# Prove it opens BEFORE removing anything.
gpg --batch --quiet --decrypt --passphrase-fd 3 "backups/prod-${STAMP}.tar.gz.gpg" \
    3<<<"$BACKUP_PASSPHRASE" | gzip -dc | tar -tf -
```

> Only delete the plaintext once that listing succeeds. This has already gone wrong once:
> `gpg` was absent, the encrypt failed silently, and the plaintext was deleted anyway. The
> nightly job now performs this same round-trip automatically and refuses to report success
> without it.

## 3. Restoring

```bash
export BACKUP_PASSPHRASE='…from the password manager…'
export S3_BUCKET='…' S3_ENDPOINT='https://<ACCOUNT_ID>.r2.cloudflarestorage.com'
export AWS_ACCESS_KEY_ID='…' AWS_SECRET_ACCESS_KEY='…'

# What is available?
scripts/restore.sh --list

# Restore into a SCRATCH project first. Never rehearse into production.
scripts/restore.sh \
  --target 'postgresql://postgres:PASSWORD@<host>:5432/postgres' \
  --key daily/<YYYY-MM-DD>.tar.gz.gpg

# Or from a local file:
scripts/restore.sh --target '…' --file backups/<archive>.tar.gz.gpg
```

`restore.sh` refuses to run when the target host **and** database both match `DATABASE_URL`
— the database it backs up *from* — unless you set `RESTORE_CONFIRM=yes`.

It prepares the target before loading, because two things bite otherwise:

- **Supabase roles.** A Supabase dump carries `GRANT`/`OWNER TO` naming `supabase_admin`,
  `supabase_auth_admin`, `dashboard_user`, `authenticator`. Restoring into anything that
  lacks them aborts on the first one, before a single row lands.
- **Extensions.** `pgcrypto` and `btree_gist` live *in* the `public` schema, and dropping
  that schema destroys them — but `pg_dump --schema=public` never emits `CREATE EXTENSION`.
  Without `btree_gist` the `allocations` exclusion constraint cannot rebuild and the restore
  dies partway with `data type uuid has no default operator class for access method gist`,
  leaving a half-populated database.

Both are recreated automatically. You do not need to do anything about them.

### If it stops on `profiles_id_fkey`

The `auth.users` rows did not transfer — usually a column-set difference between two
Supabase versions. Get the bookings back first, reconcile logins after:

```bash
RESTORE_SKIP_FK=yes scripts/restore.sh --target '…' --key '…'
```

Then re-invite staff. Say so to whoever maintains this, because it means the auth capture
needs adjusting.

## 4. Verifying a restore

`restore.sh` prints row counts for every table present in the archive. Compare them against
the `backup_runs` row for the same dump:

```sql
select started_at, status, object_key, byte_size, reservations, folio_items, payments
from backup_runs order by started_at desc limit 5;
```

Then prove the constraint that prevents double-booking survived — the second insert **must**
fail with `23P01`:

```sql
insert into allocations (unit_id, reason, stay)
  select id, 'maintenance', daterange('2030-01-01','2030-01-05','[)') from units limit 1;
insert into allocations (unit_id, reason, stay)
  select id, 'maintenance', daterange('2030-01-03','2030-01-07','[)') from units limit 1;
```

A restore that loads rows but loses that constraint is worse than no restore: the property
would oversell and nothing would stop it.

Finally, confirm someone can actually sign in — `auth.users` and `profiles` must both be
populated, and every profile with a role needs a matching `staff` row (see
`docs/Runbook.md` §4).

## 5. If a migration chain fails partway

`supabase db push` commits **per migration**. A failure at 0020 leaves you at 0019, not at
the start. Establish where you are before doing anything:

```bash
supabase migration list --linked
```

**Fix forward** whenever the failure is understood — correct the data or the migration and
re-run `supabase db push --linked`. Applied migrations are skipped. This is the normal path
and needs no restore.

**Full restore** only when the schema is in a state you cannot reason about:

```bash
supabase db reset --linked          # DESTROYS the remote database. No undo.
scripts/restore.sh --target "$PROD_DB_URL" --key <the archive from before the push>
supabase migration repair --linked --status applied <the migrations the archive already contains>
```

The `repair` step matters: without it the next push re-applies migrations that are already
present in the restored schema.

## 6. Connection strings

For **restores and dumps**, use the **Session Pooler**:

| | |
|---|---|
| Host | `aws-<N>-<region>.pooler.supabase.com` |
| Port | **5432** |

`db.<project>.supabase.co` is IPv6-only and fails from IPv4-only hosts, including GitHub
Actions runners. Port **6543** is the transaction pooler and does not work with `pg_dump`.
