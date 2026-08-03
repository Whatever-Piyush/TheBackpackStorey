#!/usr/bin/env bash
#
# Nightly backup — Backpackers Storey (ROADMAP §4 item 7)
#
#   pg_dump → gzip → gpg (AES256) → Cloudflare R2 / Backblaze B2 → backup_runs row
#
# Runs in GitHub Actions, never inside Supabase. Supabase Free has no
# point-in-time recovery: if the project is lost, every booking goes with it.
#
# The dump is VERIFIED before it is uploaded. A pg_dump that fails halfway still
# exits 0 in some pipelines and leaves a plausible-looking file, so this greps the
# plaintext for the tables that must be present and refuses to upload otherwise.
#
# Usage:  scripts/backup.sh
# Every setting arrives by environment variable; see REQUIRED below.

set -Eeuo pipefail

# ------------------------------------------------------------------ settings

REQUIRED=(DATABASE_URL BACKUP_PASSPHRASE S3_BUCKET S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY)

# Schemas to dump. `public` holds every table in our migrations. Supabase's own
# `auth` schema is deliberately NOT dumped — see docs/Security_check.md §1.
BACKUP_SCHEMAS="${BACKUP_SCHEMAS:-public}"

# Retention, as agreed: 7 daily + 4 weekly.
KEEP_DAILY="${KEEP_DAILY:-7}"
KEEP_WEEKLY="${KEEP_WEEKLY:-4}"

# A dump smaller than this is a failure whatever pg_dump's exit code said.
MIN_BYTES="${MIN_BYTES:-2048}"

# Tables whose CREATE TABLE must appear in the plaintext dump.
VERIFY_TABLES="${VERIFY_TABLES:-reservations folio_items payments allocations units}"

# Optional dead-man's switch (healthchecks.io or equivalent).
HEALTHCHECK_URL="${HEALTHCHECK_URL:-}"

# R2 rejects the checksum headers newer AWS CLI versions send by default.
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"

WORKDIR="$(mktemp -d)"
RUN_ID=""
STAMP="$(date -u +%Y-%m-%d)"
ISOWEEK="$(date -u +%G-W%V)"
OBJECT_KEY="daily/${STAMP}.tar.gz.gpg"

# ------------------------------------------------------------------- helpers

log()  { printf '[backup] %s\n' "$*" >&2; }
ping_hc() {
  [ -n "$HEALTHCHECK_URL" ] || return 0
  # Never let the alerting service take the backup down with it.
  curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_URL}${1:-}" || \
    log "warning: could not reach healthcheck endpoint (${1:-success})"
}
# -q matters: without it psql prints the command tag ("INSERT 0 1") to stdout
# alongside the returned row, and capturing that into RUN_ID produces a two-line
# value that is not a uuid.
psql_q() { psql "$DATABASE_URL" -qtAX -v ON_ERROR_STOP=1 -c "$1"; }

record_failure() {
  local message="$1"
  if [ -n "$RUN_ID" ]; then
    # Escape by doubling single quotes. NOT dollar-quoting: bash expands $$ to
    # the process id inside a double-quoted string, so "$$…$$" would send the PID
    # to Postgres and the UPDATE would never parse.
    local safe="${message//\'/\'\'}"
    psql_q "update backup_runs
               set status = 'failed',
                   finished_at = now(),
                   error = '${safe}'
             where id = '${RUN_ID}'" >/dev/null 2>&1 || \
      log "warning: could not record the failure in backup_runs"
  fi
}

on_error() {
  # Disarm first: record_failure runs psql, and a psql that also fails would
  # re-enter this handler instead of reporting the original fault.
  trap - ERR
  local line="$1"
  local message="backup.sh failed at line ${line}"
  log "$message"
  record_failure "$message"
  ping_hc "/fail"
  exit 1
}

cleanup() { rm -rf "$WORKDIR"; }

trap 'on_error $LINENO' ERR
trap cleanup EXIT

# ------------------------------------------------------------- what we dialled
#
# First line of every run, before anything that can fail, because the commonest
# way this job breaks is being pointed at the wrong endpoint — and the resulting
# error is a network timeout that names nothing.
#
# GitHub Actions runners are IPv4-only. db.<project>.supabase.co is IPv6-only.
# The Session Pooler (aws-0-<region>.pooler.supabase.com:5432) is what works.
# Printing the host makes that visible in the log instead of inferred from a
# stack trace at 01:00.
#
# Host only. Never the user, never the password — this log is world-readable to
# anyone with repository access.
db_host() {
  printf '%s' "${1:-}" | sed -E 's#^[^/]*//([^@]*@)?([^:/?]+).*#\2#'
}

if [ -n "${DATABASE_URL:-}" ]; then
  log "Resolved database host: $(db_host "$DATABASE_URL")"
else
  log "Resolved database host: (DATABASE_URL is not set)"
fi

# ------------------------------------------------------------------- preflight

for var in "${REQUIRED[@]}"; do
  if [ -z "${!var:-}" ]; then
    log "FATAL: $var is not set."
    ping_hc "/fail"
    exit 1
  fi
done

for tool in pg_dump psql gzip gpg aws curl tar; do
  command -v "$tool" >/dev/null 2>&1 || { log "FATAL: $tool is not installed."; ping_hc "/fail"; exit 1; }
done

# pg_dump must be at least the server's major version or it refuses to run. This
# check turns a confusing mid-pipeline abort into a clear message.
# Note: no `| head` in these pipelines. Under `set -o pipefail`, head exits after
# the first line, the upstream process takes SIGPIPE, and the whole pipeline
# reports failure — which would abort the backup for no reason. awk/sed/cut all
# consume their input to the end.
SERVER_MAJOR="$(psql_q 'show server_version' | cut -d. -f1)"
CLIENT_MAJOR="$(pg_dump --version | awk '{print $NF}' | cut -d. -f1)"
if [ "$CLIENT_MAJOR" -lt "$SERVER_MAJOR" ]; then
  log "FATAL: pg_dump is $CLIENT_MAJOR but the server is $SERVER_MAJOR. Install postgresql-client-${SERVER_MAJOR}."
  ping_hc "/fail"
  exit 1
fi

ping_hc "/start"
log "starting backup of schema(s): ${BACKUP_SCHEMAS}"

# ------------------------------------------------------------------- record

RUN_ID="$(psql_q "insert into backup_runs (status) values ('running') returning id" | sed -n '1p' | tr -d '[:space:]')"
[ -n "$RUN_ID" ] || { log "FATAL: could not create a backup_runs row."; ping_hc "/fail"; exit 1; }
log "backup_runs id ${RUN_ID}"

COUNTS="$(psql_q "select (select count(*) from reservations),
                         (select count(*) from folio_items),
                         (select count(*) from payments)")"
RES_COUNT="$(echo "$COUNTS" | cut -d'|' -f1)"
FI_COUNT="$(echo "$COUNTS"  | cut -d'|' -f2)"
PAY_COUNT="$(echo "$COUNTS" | cut -d'|' -f3)"
log "rows: reservations=${RES_COUNT} folio_items=${FI_COUNT} payments=${PAY_COUNT}"

# ---------------------------------------------------------------------- dump

PLAIN="${WORKDIR}/public.sql"
AUTH_SQL="${WORKDIR}/auth_users.sql"
SCHEMA_ARGS=()
for s in $BACKUP_SCHEMAS; do SCHEMA_ARGS+=(--schema="$s"); done

# --no-owner/--no-privileges: roles differ between projects, and a restore into a
# scratch project must not fail on a missing role. Grants are re-applied by
# replaying the migrations, which is what the restore procedure does.
pg_dump "$DATABASE_URL" \
  --format=plain \
  --no-owner \
  --no-privileges \
  --quote-all-identifiers \
  "${SCHEMA_ARGS[@]}" \
  --file="$PLAIN"

# auth.users is Supabase's, not ours — but public.profiles carries a foreign key
# to it, so a dump of `public` alone cannot be restored into a fresh project: the
# profiles COPY fails on profiles_id_fkey and no business data lands at all.
# Proven by rehearsing the restore locally, not assumed.
#
# Data only: the target project already has the auth schema, and we must not try
# to recreate Supabase-managed DDL. Non-fatal — losing three staff logins is
# recoverable by re-inviting them, losing the bookings is not.
if pg_dump "$DATABASE_URL" \
     --format=plain --data-only --no-owner --no-privileges \
     --quote-all-identifiers --table=auth.users \
     --file="$AUTH_SQL" 2>"${WORKDIR}/auth.err"; then
  log "captured auth.users"
else
  log "warning: could not dump auth.users — $(tr -d '\n' < "${WORKDIR}/auth.err")"
  log "warning: staff logins are NOT in this backup; see docs/Security_check.md §1"
  : > "$AUTH_SQL"
fi

# -------------------------------------------------------------------- verify

for t in $VERIFY_TABLES; do
  if ! grep -q "CREATE TABLE \"public\".\"${t}\"" "$PLAIN"; then
    log "FATAL: dump is missing CREATE TABLE for ${t} — refusing to upload."
    record_failure "verification failed: no CREATE TABLE for ${t}"
    ping_hc "/fail"
    exit 1
  fi
done
log "verified: all expected tables present in the dump"

# ------------------------------------------------------------- compress+encrypt

# Two files, so the restore can load auth.users BEFORE the public data that
# references it. Ordering is why this is a bundle and not one concatenated file.
BUNDLE="${WORKDIR}/bundle.tar"
tar -cf "$BUNDLE" -C "$WORKDIR" public.sql auth_users.sql

ARCHIVE="${WORKDIR}/${STAMP}.tar.gz.gpg"
gzip -9 -c "$BUNDLE" | gpg --batch --yes --symmetric \
  --cipher-algo AES256 \
  --passphrase-fd 3 \
  --output "$ARCHIVE" 3<<<"$BACKUP_PASSPHRASE"

BYTES="$(wc -c < "$ARCHIVE" | tr -d ' ')"
if [ "$BYTES" -lt "$MIN_BYTES" ]; then
  log "FATAL: archive is ${BYTES} bytes, below the ${MIN_BYTES} floor."
  record_failure "archive too small: ${BYTES} bytes"
  ping_hc "/fail"
  exit 1
fi
log "archive ${BYTES} bytes"

# ------------------------------------------------------- verify it OPENS again
#
# A size floor proves bytes were written, not that they can ever be read back.
# This is not hypothetical: during the first production backup, gpg was absent
# from the machine, the encrypt step failed, and the plaintext was deleted anyway
# — leaving nothing. The preflight above now catches a missing gpg, but it cannot
# catch a wrong passphrase, a truncated write, a full disk, or a gpg that exits 0
# having produced garbage.
#
# So the archive is decrypted, decompressed, and listed before it is uploaded or
# reported as a success. An unopenable backup that pings healthchecks green is
# worse than no backup, because it stops anyone from looking.
VERIFY_DIR="${WORKDIR}/verify"
mkdir -p "$VERIFY_DIR"
if ! gpg --batch --quiet --decrypt --passphrase-fd 3 "$ARCHIVE" 3<<<"$BACKUP_PASSPHRASE" 2>/dev/null \
     | gzip -dc 2>/dev/null | tar -xf - -C "$VERIFY_DIR" 2>/dev/null; then
  log "FATAL: the archive could not be decrypted and unpacked."
  record_failure "archive failed its decrypt round-trip"
  ping_hc "/fail"
  exit 1
fi

if [ ! -s "${VERIFY_DIR}/public.sql" ]; then
  log "FATAL: archive unpacked but contains no public.sql."
  record_failure "archive unpacked without public.sql"
  ping_hc "/fail"
  exit 1
fi

# The same tables the plaintext was checked for, re-checked after the round trip,
# so encryption cannot silently truncate the payload.
for t in $VERIFY_TABLES; do
  if ! grep -q "CREATE TABLE \"public\".\"${t}\"" "${VERIFY_DIR}/public.sql"; then
    log "FATAL: round-tripped dump is missing ${t}."
    record_failure "round-trip verification failed: no ${t} after decrypt"
    ping_hc "/fail"
    exit 1
  fi
done
log "verified: archive decrypts, unpacks, and still contains every expected table"
rm -rf "$VERIFY_DIR"

# -------------------------------------------------------------------- upload

aws s3 cp "$ARCHIVE" "s3://${S3_BUCKET}/${OBJECT_KEY}" --endpoint-url "$S3_ENDPOINT" --only-show-errors
log "uploaded ${OBJECT_KEY}"

# Sunday's copy is promoted to the weekly set. date +%u: 7 is Sunday.
if [ "$(date -u +%u)" = "7" ]; then
  aws s3 cp "$ARCHIVE" "s3://${S3_BUCKET}/weekly/${ISOWEEK}.tar.gz.gpg" \
    --endpoint-url "$S3_ENDPOINT" --only-show-errors
  log "promoted to weekly/${ISOWEEK}.tar.gz.gpg"
fi

# ------------------------------------------------------------------- retention

prune() {
  local prefix="$1" keep="$2" keys count
  keys="$(aws s3api list-objects-v2 \
            --bucket "$S3_BUCKET" --prefix "$prefix" \
            --endpoint-url "$S3_ENDPOINT" \
            --query 'sort_by(Contents,&LastModified)[].Key' \
            --output text 2>/dev/null | tr '\t' '\n' | grep -v '^None$' || true)"
  [ -n "$keys" ] || return 0

  count="$(printf '%s\n' "$keys" | wc -l | tr -d ' ')"
  [ "$count" -gt "$keep" ] || return 0

  # sed, not head — same SIGPIPE-under-pipefail reason as above.
  printf '%s\n' "$keys" | sed -n "1,$((count - keep))p" | while read -r key; do
    [ -n "$key" ] || continue
    aws s3 rm "s3://${S3_BUCKET}/${key}" --endpoint-url "$S3_ENDPOINT" --only-show-errors
    log "pruned ${key}"
  done
}

prune "daily/"  "$KEEP_DAILY"
prune "weekly/" "$KEEP_WEEKLY"

# --------------------------------------------------------------------- finish

psql_q "update backup_runs
           set status = 'ok',
               finished_at = now(),
               object_key = '${OBJECT_KEY}',
               byte_size = ${BYTES},
               reservations = ${RES_COUNT},
               folio_items = ${FI_COUNT},
               payments = ${PAY_COUNT}
         where id = '${RUN_ID}'" >/dev/null

ping_hc ""
log "done"
