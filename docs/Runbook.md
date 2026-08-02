# RUNBOOK — Backpackers Storey OS

Lives in the repo at `docs/RUNBOOK.md`. Written so that someone who has never seen this project
can keep it alive, restore it, or move it to Vercel without asking you.

**Owner:** _(your name + contact)_
**Property contact:** _(owner name + phone)_
**Last verified:** _(date you last did a restore rehearsal)_

---

## 0. Order of operations — do not skip ahead

The VPS is step 5, not step 1. Setting up a server before the grant bug is fixed just gives you
a broken app on a nicer address.

| # | Step | Who | Done? |
|---|---|---|---|
| 1 | Fix the grant bug (three parts) | Claude Code | ☐ |
| 2 | Build the backup job | Claude Code | ☐ |
| 3 | Fresh Supabase project, 31 migrations, real seed | Claude Code + you | ☐ |
| 4 | **Restore rehearsal** — locally, not in the cloud | You | ☐ |
| 5 | VPS setup + deploy to `new.backpackerstorey.in` | You | ☐ |
| 6 | Three staff each do a full loop on the real URL | Them | ☐ |
| 7 | DNS cutover + Google Business Profile link | You | ☐ |

Step 4 is the gate. Until a restore has actually worked, treat everything after it as unsafe.

---

## 1. Claude Code prompt — backups

Send this before anything else. It contains the failure modes that will otherwise cost you a
day each.

```text
Read docs/foundation.md and docs/RUNBOOK.md first. Additive changes only, no business logic.

Build the backup and restore system. It runs as a cron job ON THE VPS, not GitHub Actions —
scheduled Actions workflows get disabled after ~60 days of repo inactivity, which is exactly
what happens to this repo after launch.

KNOWN PITFALLS — handle every one explicitly and tell me how you did it:

1. auth.users is NOT in the public schema. A pg_dump of public alone loses every staff
   account and breaks every foreign key pointing at auth.users. The dump must cover public
   AND auth. Prefer `supabase db dump` (role-only, schema, data-only) over hand-rolled
   pg_dump for exactly this reason.

2. pg_dump refuses to run when the client is older than the server. Ubuntu's default
   postgresql-client is usually behind Supabase's Postgres. Pin the client version in the
   setup script and print both versions at the top of every run.

3. Direct Postgres connections on Supabase may be IPv6-only. If the VPS has no IPv6, the
   dump fails with a confusing network error. Use the Session Pooler connection string
   (IPv4-capable, port 5432) unless you have verified IPv6 works. Do NOT use the transaction
   pooler on 6543 — pg_dump does not work through it.

4. btree_gist must exist before the allocations exclusion constraint can be restored. The
   restore script creates extensions first, in their own step.

5. Sequences must be included, or restored IDs collide with new inserts.

REQUIREMENTS:

- Nightly at 02:30 IST. Gzip, then encrypt (age or gpg) BEFORE upload — the dump contains
  guest names, phone numbers and ID numbers.
- Upload to Cloudflare R2. Retention: 7 daily + 4 weekly.
- Write every run to a backup_runs table: started_at, finished_at, status, byte size, and row
  counts for reservations, folio_items and payments.
- FAIL LOUDLY on a suspicious dump. A 2 KB file is a failed backup that looks like a success.
  If the dump is smaller than 50% of the previous run, mark the run failed and do not rotate
  out the older backup.
- Ping healthchecks.io only on success. A missing ping is what alerts me.
- Write scripts/restore.sh that takes a backup file and a target database URL. It must be
  runnable by someone who has never seen this repo.

Also add scripts/backup-verify.sh: downloads the newest backup, restores it into a throwaway
local Postgres, and prints row counts. This is what makes the rehearsal a five-minute job
instead of an afternoon, so I actually repeat it.

Do NOT report the restore as tested. I run that myself.
```

**Why a local restore rehearsal, not a second cloud project:** the Supabase free tier allows
two active projects and you'll be using both (old + new). Restoring into local Postgres proves
the dump is complete and loadable, which is the part that actually fails. Note in your summary
that `auth` and `storage` schemas need a real Supabase target to fully verify.

---

## 2. Provision the VPS

**Pick the region to match your Supabase project.** Check it in the Supabase dashboard first.
Mumbai/Singapore Supabase → DigitalOcean Bangalore or AWS Lightsail Mumbai. A German box with
a Mumbai database adds 150–200 ms to every query.

Size: the $6 / 1 GB tier is fine for *running* the app (~200–300 MB), but `next build` will run
out of memory on 1 GB. Add swap — it's a one-off cost during builds only.

```bash
# as root, first minutes on a fresh Ubuntu 24.04 box
adduser deploy && usermod -aG sudo deploy
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy

# swap, so next build doesn't OOM on a 1GB box
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab

# lock down SSH: key-only, no root
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
systemctl restart ssh

ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

# automatic security patches
apt update && apt install -y unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

timedatectl set-timezone Asia/Kolkata     # cron and logs in the same timezone as the hostel
```

Then Docker, Caddy and Node as the `deploy` user. Use Node's LTS matching your local version —
mismatches produce build failures that look like code bugs.

---

## 3. Deploy

Set `output: 'standalone'` in `next.config.js` first. It produces a self-contained bundle and
makes the whole deploy story simpler.

`Caddyfile` — this is your entire TLS setup, certificates and renewal included:

```
new.backpackerstorey.in {
    reverse_proxy localhost:3000
    encode gzip
}
```

`docker-compose.yml`:

```yaml
services:
  web:
    build: .
    restart: unless-stopped        # survives crashes and reboots
    env_file: .env.production
    ports: ["127.0.0.1:3000:3000"]
    logging:
      driver: json-file
      options: { max-size: "10m", max-file: "3" }   # or logs eat the disk
```

Deploy script (`scripts/deploy.sh`):

```bash
set -euo pipefail
cd /home/deploy/app
git fetch --all && git checkout "${1:-main}" && git pull
docker compose build && docker compose up -d
docker image prune -f
curl -fsS --retry 3 http://localhost:3000/api/health || {
  echo "HEALTH CHECK FAILED — rolling back"; exit 1; }
```

**Test on `new.backpackerstorey.in` while the apex still points at Zotel.** Real DNS, real TLS,
real Supabase, zero risk to the live domain.

### Environment variables

Live in `/home/deploy/app/.env.production`, `chmod 600`, never committed.

**Store a copy in your password manager.** If the box dies and you've lost these, the backup
is useless — you can't bring the app up without them.

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=       # server only, never NEXT_PUBLIC_
RESEND_API_KEY=
CHANNEL_WEBHOOK_SECRET=          # must be set — verify() fails closed without it
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
BACKUP_ENCRYPTION_KEY=
HEALTHCHECKS_URL=
DATABASE_URL=                    # session pooler, for the backup job
```

### Cloudflare in front

Add the domain to Cloudflare (free), set the record to **Proxied**. You get CDN, caching, DDoS
protection and Always Online for ₹0.

This is DNS proxying only — nothing to do with running Next.js on Workers, and none of the
OpenNext incompatibilities apply.

SSL/TLS mode: **Full (strict)**. Caddy already holds a real certificate.

---

## 4. Maintenance sheet

Print this. It's the whole ongoing burden.

### ⚠️ Adding a staff member takes TWO rows, not one

A new staff member needs **both** a `profiles` row **and** a `staff` row. Create only one and
they get a half-working account that is genuinely confusing to diagnose:

| They have | What works | What doesn't |
|---|---|---|
| `profiles` only | Café POS, Stays console, check-in, checkout, folios | **`/reception` — "not reception staff"** |
| `staff` only | `/reception` | Everything else — no role, so every `user_role()` check refuses |

The cause is two parallel authorisation systems that have not been reconciled:

- **`user_role()`** reads `profiles.role`. Used by **21 functions and all 19 RLS policies**.
- **`is_staff()`** reads the `staff` table. Used by **exactly one function:
  `reception_dashboard`**.

The two tables also use **different role vocabularies**, which is the part that bites:

```
profiles.role  in (owner, manager, reception, kitchen, housekeeping)
staff.role     in (owner, staff)                     -- only two values
```

Copying `profiles.role` straight into `staff.role` violates `staff_role_check` for anyone who
is not an owner. Map it: `owner` → `owner`, everything else → `staff`.

```sql
-- Adding one person, the safe way:
insert into staff (user_id, display_name, role, active)
select p.id,
       coalesce(nullif(btrim(coalesce(p.full_name,'')),''), 'Staff'),
       case when p.role = 'owner' then 'owner' else 'staff' end,
       true
from profiles p
where p.id = '<the-new-user-uuid>'
on conflict (user_id) do nothing;
```

Migration `0035_staff_backfill.sql` did this once for everyone who existed at deploy time.
It does **not** run for accounts created afterwards — `handle_new_user` creates the `profiles`
row automatically, but nothing creates the `staff` row.

Reconciling these two systems into one is deliberately deferred until after launch. Until
then, this note is the whole workaround.

### Daily — automated, nothing to do

| Task | How |
|---|---|
| Database backup | cron 02:30 IST |
| Security patches | `unattended-upgrades` |
| Restart after crash | Docker `restart: unless-stopped` |
| TLS renewal | Caddy |

**Your only daily job is to notice a healthchecks.io alert if one arrives.** No alert = it ran.

### Weekly — 2 minutes

- ☐ Open the site, book a test stay, cancel it. Confirms the whole chain still works.
- ☐ Glance at `backup_runs`: 7 rows, all `ok`, sizes stable.

### Monthly — 15 minutes

- ☐ `df -h` — disk under 70%
- ☐ `docker system prune -f`
- ☐ Supabase dashboard: database size, storage, egress. Alert at 80% of any.
- ☐ `sudo reboot` if `/var/run/reboot-required` exists
- ☐ Confirm the VPS and domain are paid and not near expiry

### Quarterly — 1 hour

- ☐ `npm audit` and dependency updates
- ☐ **Restore rehearsal** — `scripts/backup-verify.sh`. Update "Last verified" at the top.
- ☐ Rotate `SUPABASE_SERVICE_ROLE_KEY` and the webhook secret
- ☐ Re-read section 6 and confirm it's still accurate

### Yearly — 2 hours

- ☐ Ubuntu LTS upgrade, or rebuild from this document
- ☐ Next.js major version upgrade (**14 is end-of-life — do this one first**)
- ☐ Review whether the property has outgrown the free tiers

---

## 5. Restore

**When:** database corrupted, project deleted, or a bad migration.

```bash
# 1. newest backup
rclone ls r2:backpackers-backups | sort -k2 | tail -5
rclone copy r2:backpackers-backups/<file> ./

# 2. decrypt + decompress
age -d -i ~/.age/key.txt <file>.age | gunzip > restore.sql

# 3. NEVER restore straight into production. Verify locally first.
scripts/backup-verify.sh restore.sql

# 4. only after row counts look right
scripts/restore.sh restore.sql "$TARGET_DATABASE_URL"
```

**Known caveats, expect them:**
- `auth.users` restores separately. Staff may need password resets afterwards.
- Storage objects are not in the database dump.
- Extensions are created before data. If `btree_gist` is missing, the exclusion constraint
  fails and the restore is incomplete — check for it explicitly.

**If the whole VPS is gone:** rebuild from section 2, restore `.env.production` from your
password manager, `git clone`, run section 3. Nothing on the box is irreplaceable. That's
deliberate.

---

## 6. Escape hatch — move to Vercel Pro in an hour

This exists so that whoever inherits this project is never stuck with a server they can't run.
The app is plain `next build && next start` with no adapter, so this is genuinely an hour.

1. Vercel → New Project → import the GitHub repo. **Pro plan, not Hobby** — Hobby prohibits
   commercial use and this is a business taking bookings.
2. Paste every variable from `.env.production` into Vercel's environment variables. Mark
   `SUPABASE_SERVICE_ROLE_KEY` and the rest as server-only; only `NEXT_PUBLIC_*` are exposed.
3. Deploy to the preview URL. Confirm: booking flow, staff login, POS, kitchen display.
4. Move the backup cron off the VPS — GitHub Actions with a dead-man's switch, or keep the VPS
   alive as a ₹500 backup runner and shut down the web container.
5. Point DNS at Vercel. Keep the VPS running for 48 hours as a fallback.
6. Set Vercel usage alerts. **Vercel has no spending cap.**

Nothing about the codebase changes. That's the point.

**What NOT to do:** don't move to Cloudflare Workers without a full test pass. `cookies()` from
`next/headers` doesn't work in `middleware.ts` on Workers — which is exactly where staff auth
lives — and the failure only shows in a Workers preview, never in `next dev`.

---

## 7. Launch day

**Before**

- ☐ Restore rehearsal passed
- ☐ No demo reservations, no `@backpackerstorey.test` account in production
- ☐ Rates seeded: dorm ₹300/bed, Deluxe ₹1,800, Premium ₹1,800, Family ₹2,000
- ☐ Family Room shows **no attached bathroom** everywhere it's described
- ☐ Cancellation policy, privacy policy, terms — published
- ☐ All three staff have logins with real passwords and have each done a full loop
- ☐ Allotment set, and those units closed in every OTA extranet

**Cutover**

- ☐ Lower DNS TTL to 300s a day ahead
- ☐ Point the apex at the VPS. Zotel's page stays reachable at its own URL for 48h.
- ☐ Update the booking link on Google Business Profile — **it currently points at a Zotel page that returns "no rooms available" for every date**
- ☐ Book a real stay yourself, end to end, and pay for it
- ☐ Watch the first three real bookings all the way through

**Week one**

- ☐ Check `backup_runs` daily
- ☐ Ask the three staff what annoyed them. Fix that, not your backlog.

---

## 8. If something breaks

| Symptom | First check |
|---|---|
| Site down | `docker compose ps`, then `docker compose logs --tail=100 web` |
| Staff can't log in | Table grants — this is the bug from the security review. Check the migration applied. |
| Bookings failing | Supabase status page, then Supabase usage — a blown quota returns 402 |
| Backup alert fired | `docker compose logs backup`, disk space, then run it manually |
| Double booking | Should be impossible. If it happened, check the exclusion constraint still exists on `allocations`. |
| Slow pages | Confirm VPS region still matches the Supabase region |

**Escalation:** you → _(name a second person who has read this document)_ → Vercel migration
in section 6.