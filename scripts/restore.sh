#!/usr/bin/env bash
#
# Restore — Backpackers Storey (ROADMAP §4 item 7)
#
# Reverses scripts/backup.sh:  R2 → gpg → gunzip → psql
#
# THIS SCRIPT HAS NOT BEEN TESTED END TO END. It cannot be: the sandbox it was
# written in has no network access to Supabase and no scratch project. Treat the
# backup as UNPROVEN until you have run the rehearsal in docs/Security_check.md §1
# once, against a scratch project, yourself.
#
# Usage:
#   scripts/restore.sh --list
#   scripts/restore.sh --target "postgres://…scratch…" --key daily/2026-08-01.sql.gz.gpg
#   scripts/restore.sh --target "postgres://…scratch…" --file ./local-copy.sql.gz.gpg

set -Eeuo pipefail

TARGET_URL=""
OBJECT_KEY=""
LOCAL_FILE=""
DO_LIST=0

export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"
export AWS_REQUEST_CHECKSUM_CALCULATION="${AWS_REQUEST_CHECKSUM_CALCULATION:-when_required}"
export AWS_RESPONSE_CHECKSUM_VALIDATION="${AWS_RESPONSE_CHECKSUM_VALIDATION:-when_required}"

log() { printf '[restore] %s\n' "$*" >&2; }
die() { log "FATAL: $*"; exit 1; }

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

while [ $# -gt 0 ]; do
  case "$1" in
    --target) TARGET_URL="${2:-}"; shift 2 ;;
    --key)    OBJECT_KEY="${2:-}"; shift 2 ;;
    --file)   LOCAL_FILE="${2:-}"; shift 2 ;;
    --list)   DO_LIST=1; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# --------------------------------------------------------------------- list

if [ "$DO_LIST" = "1" ]; then
  [ -n "${S3_BUCKET:-}" ] && [ -n "${S3_ENDPOINT:-}" ] || die "S3_BUCKET and S3_ENDPOINT must be set."
  for prefix in daily/ weekly/; do
    echo "--- ${prefix}"
    aws s3 ls "s3://${S3_BUCKET}/${prefix}" --endpoint-url "$S3_ENDPOINT" --human-readable || true
  done
  exit 0
fi

# ------------------------------------------------------------------ preflight

[ -n "$TARGET_URL" ] || die "--target is required. Point it at a SCRATCH project, not production."
[ -n "${BACKUP_PASSPHRASE:-}" ] || die "BACKUP_PASSPHRASE is not set."
[ -n "$OBJECT_KEY" ] || [ -n "$LOCAL_FILE" ] || die "one of --key or --file is required."

for tool in psql gzip gpg; do
  command -v "$tool" >/dev/null 2>&1 || die "$tool is not installed."
done

# Refuse to restore over the database we back up FROM, unless told twice. A
# restore script that can silently overwrite production is a loaded gun on the
# workbench — and a rehearsal is exactly when someone pastes the wrong URL.
host_of() { printf '%s' "$1" | sed -E 's#^[^/]*//([^@]*@)?([^:/?]+).*#\2#'; }
db_of()   { printf '%s' "$1" | sed -E 's#^[^/]*//[^/]*/([^?]+).*#\1#'; }
# Host AND database, not host alone: a scratch database on the same server is a
# legitimate target, and refusing it would push people towards RESTORE_CONFIRM=yes
# as a habit — which is how the guard stops protecting anything.
if [ -n "${DATABASE_URL:-}" ] \
   && [ "$(host_of "$TARGET_URL")" = "$(host_of "$DATABASE_URL")" ] \
   && [ "$(db_of "$TARGET_URL")"   = "$(db_of "$DATABASE_URL")" ]; then
  if [ "${RESTORE_CONFIRM:-}" != "yes" ]; then
    die "target host matches DATABASE_URL (the backup SOURCE).
       If you really mean to overwrite it, re-run with RESTORE_CONFIRM=yes"
  fi
  log "WARNING: restoring over the backup source, because RESTORE_CONFIRM=yes"
fi

# --------------------------------------------------------------------- fetch

ARCHIVE="${WORKDIR}/archive.sql.gz.gpg"
if [ -n "$LOCAL_FILE" ]; then
  [ -f "$LOCAL_FILE" ] || die "no such file: $LOCAL_FILE"
  cp "$LOCAL_FILE" "$ARCHIVE"
  log "using local file $LOCAL_FILE"
else
  [ -n "${S3_BUCKET:-}" ] && [ -n "${S3_ENDPOINT:-}" ] || die "S3_BUCKET and S3_ENDPOINT must be set."
  aws s3 cp "s3://${S3_BUCKET}/${OBJECT_KEY}" "$ARCHIVE" --endpoint-url "$S3_ENDPOINT" --only-show-errors
  log "downloaded ${OBJECT_KEY}"
fi

# ------------------------------------------------------------------- decrypt

PLAIN="${WORKDIR}/public.sql"
AUTH_SQL="${WORKDIR}/auth_users.sql"

gpg --batch --yes --decrypt --passphrase-fd 3 --output "${WORKDIR}/bundle.tar.gz" "$ARCHIVE" 3<<<"$BACKUP_PASSPHRASE"
gzip -dc "${WORKDIR}/bundle.tar.gz" > "${WORKDIR}/bundle.tar"
tar -xf "${WORKDIR}/bundle.tar" -C "$WORKDIR"

# Two archive layouts exist and both must restore.
#
#   backup.sh          public.sql + auth_users.sql
#   supabase db dump   <stamp>-schema.sql + <stamp>-data.sql
#
# The emergency archive taken before the 0004–0037 push is the SECOND kind, and
# a restore script that only understands its own output is a script that fails on
# the one artifact you reach for first.
if [ ! -f "$PLAIN" ]; then
  SCHEMA_SQL="$(find "$WORKDIR" -maxdepth 1 -name '*-schema.sql' | head -1)"
  DATA_SQL="$(find "$WORKDIR" -maxdepth 1 -name '*-data.sql' | head -1)"
  if [ -n "$SCHEMA_SQL" ] && [ -n "$DATA_SQL" ]; then
    log "detected a supabase db dump archive (schema + data)"
    # Concatenated in order: the schema dump carries auth DDL, the data dump
    # carries auth.users rows before the public tables that reference them.
    cat "$SCHEMA_SQL" "$DATA_SQL" > "$PLAIN"
    # No separate auth file in this layout — the auth schema and its rows are
    # already inside the combined file, so the auth step below has nothing to do.
    : > "$AUTH_SQL"
    COMBINED_AUTH=1
  fi
fi
[ -f "$PLAIN" ] || die "archive contains neither public.sql nor a *-schema.sql/*-data.sql pair."

BYTES="$(wc -c < "$PLAIN" | tr -d ' ')"
log "decrypted ${BYTES} bytes of SQL"

# Same verification the backup did, on the way back in.
# Tables present in EVERY era of this schema. `reservations` and `folio_items`
# arrive at 0006/0007, so requiring them would reject the emergency archive taken
# at 0003 — the one most likely to be needed.
# Two dump styles again: pg_dump writes `CREATE TABLE "public"."x"`, the Supabase
# CLI writes `CREATE TABLE IF NOT EXISTS "public"."x"`. Match either.
for t in guests profiles rooms menu_items; do
  grep -Eq "CREATE TABLE (IF NOT EXISTS )?\"public\"\.\"${t}\"" "$PLAIN" \
    || die "decrypted dump has no ${t} table — wrong file or corrupt archive."
done
log "verified: expected tables present"

# -------------------------------------------------------------------- restore

# Preparing the target is two problems, both found by rehearsing this locally.
#
# 1. Every Postgres database already has a `public` schema, so the dump's
#    CREATE SCHEMA collides. The target's schema is dropped and recreated: a
#    restore replaces, it does not merge. The host+database guard above is what
#    stops that landing on the wrong database.
#
# 2. pgcrypto and btree_gist live IN the public schema, so dropping it destroys
#    them — and `pg_dump --schema=public` never emits CREATE EXTENSION, because
#    extensions are database-level objects. Without btree_gist the allocations
#    exclusion constraint cannot be rebuilt and the restore dies partway through
#    with "data type uuid has no default operator class for access method gist",
#    leaving a half-populated database. They are recreated before the dump runs.
RESTORE_EXTENSIONS="${RESTORE_EXTENSIONS:-pgcrypto btree_gist}"

# Roles a Supabase project already has, which a bare Postgres does not. A dump
# taken from Supabase carries GRANT and OWNER TO statements naming them, and psql
# aborts on the first one it cannot resolve — `role "supabase_admin" does not
# exist` — before a single row lands.
#
# Creating them is safe either way: on a real Supabase target they already exist
# and this is a no-op. In an emergency nobody reads a caveats section, so the
# script does it rather than the documentation asking someone to.
RESTORE_ROLES="${RESTORE_ROLES:-supabase_admin supabase_auth_admin supabase_storage_admin dashboard_user authenticator anon authenticated service_role}"

log "preparing target: roles"
for role in $RESTORE_ROLES; do
  # NOLOGIN/NOINHERIT is irrelevant here: these exist only so GRANT statements in
  # the dump resolve. Errors are swallowed because "already exists" is the
  # expected outcome on a real Supabase project.
  psql "$TARGET_URL" -qX -c "do \$\$ begin
      if not exists (select 1 from pg_roles where rolname = '${role}') then
        execute format('create role %I', '${role}');
      end if;
    end \$\$;" >/dev/null 2>&1 || log "  note: could not ensure role ${role} (may need superuser)"
done
log "  roles ensured"

log "preparing target: replacing the public schema"
psql "$TARGET_URL" -v ON_ERROR_STOP=1 -qX \
  -c 'drop schema if exists public cascade' \
  -c 'create schema public'
for ext in $RESTORE_EXTENSIONS; do
  psql "$TARGET_URL" -v ON_ERROR_STOP=1 -qX -c "create extension if not exists \"${ext}\""
  log "  extension ${ext} ready"
done

# The schema now exists, so the dump's own CREATE SCHEMA has to go. COMMENT ON
# SCHEMA is left alone — it applies cleanly to the schema we just made.
sed -i.bak '/^CREATE SCHEMA "public";$/d' "$PLAIN" && rm -f "${PLAIN}.bak"

# auth.users first: public.profiles has a foreign key to it, so the order is not
# cosmetic. Non-fatal, because a column-set difference between Supabase versions
# should not cost you the bookings — if it fails, the public load below will stop
# on profiles_id_fkey and name the problem precisely.
if [ -s "$AUTH_SQL" ]; then
  log "loading auth.users …"
  if psql "$TARGET_URL" -v ON_ERROR_STOP=1 -qX -f "$AUTH_SQL"; then
    log "  auth.users loaded"
  else
    log "  WARNING: auth.users failed to load. If the next step stops on"
    log "  profiles_id_fkey, re-run with RESTORE_SKIP_FK=yes to land the business"
    log "  data anyway and re-invite staff afterwards."
  fi
elif [ "${COMBINED_AUTH:-0}" = "1" ]; then
  log "auth schema and users are inside the combined dump — loaded with it below"
else
  log "no auth.users in this archive — staff logins are NOT included"
fi

log "restoring into $(db_of "$TARGET_URL") on $(host_of "$TARGET_URL") …"
if [ "${RESTORE_SKIP_FK:-}" = "yes" ]; then
  # The disaster lever: get the bookings back now, reconcile identities later.
  # Rows land without referential checks, so profiles may point at users that do
  # not exist until staff are re-invited with their original ids.
  log "WARNING: RESTORE_SKIP_FK=yes — foreign keys are NOT enforced during this load"
  { echo "set session_replication_role = 'replica';"; cat "$PLAIN"; } \
    | psql "$TARGET_URL" -v ON_ERROR_STOP=1 -X
else
  psql "$TARGET_URL" -v ON_ERROR_STOP=1 -X -f "$PLAIN"
fi

# ------------------------------------------------------------------- confirm

log "row counts in the restored database:"
# to_regclass, because a 0003-era archive has no reservations/allocations/units
# and a hard reference to them would error out AFTER a successful restore — which
# would read as a failed restore.
psql "$TARGET_URL" -X -c "
  do \$\$
  declare t text; n bigint; out text := '';
  begin
    foreach t in array array['auth.users','profiles','guests','rooms','menu_items',
                             'bookings','orders','reservations','allocations','units',
                             'folio_items','payments']
    loop
      if to_regclass(t) is not null then
        execute format('select count(*) from %s', t) into n;
        out := out || rpad(t, 16) || n || e'\n';
      end if;
    end loop;
    raise notice e'\n%', out;
  end \$\$;"

log "done. Compare the numbers above against the backup_runs row for this dump."
