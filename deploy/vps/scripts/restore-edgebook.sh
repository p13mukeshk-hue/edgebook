#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

usage() {
  cat >&2 <<'EOF'
Usage:
  restore-edgebook.sh --from /absolute/backup-dir \
    --target-db edgebook_restore_YYYYMMDD \
    --target-uploads /srv/edgebook-data/restore/<name> \
    --acknowledge SINGLE_WRITER_STOPPED --apply

The target database must already exist and contain no user tables. The script
refuses the configured production database and refuses a non-empty upload path.
It never swaps the restored data into production.
EOF
  exit 2
}

bundle=''
target_db=''
target_uploads=''
ack=''
apply=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --from) bundle="${2:-}"; shift 2 ;;
    --target-db) target_db="${2:-}"; shift 2 ;;
    --target-uploads) target_uploads="${2:-}"; shift 2 ;;
    --acknowledge) ack="${2:-}"; shift 2 ;;
    --apply) apply=true; shift ;;
    *) usage ;;
  esac
done

[[ "$apply" == true ]] || usage
[[ "$ack" == 'SINGLE_WRITER_STOPPED' ]] || { printf 'Missing single-writer acknowledgement.\n' >&2; exit 1; }
[[ "$bundle" = /* && "$target_uploads" = /* ]] || { printf 'Bundle and upload paths must be absolute.\n' >&2; exit 1; }
[[ "$target_db" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || { printf 'Unsafe target database name.\n' >&2; exit 1; }

if [[ -r /etc/edgebook/backup.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /etc/edgebook/backup.env
  set +a
fi
: "${COMPOSE_PROJECT_DIR:?COMPOSE_PROJECT_DIR is required}"
: "${COMPOSE_FILE:?COMPOSE_FILE is required}"
: "${COMPOSE_ENV_FILE:?COMPOSE_ENV_FILE is required}"
: "${POSTGRES_SERVICE:=postgres}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${POSTGRES_BACKUP_USER:=postgres}"
: "${EDGEBOOK_DB_OWNER:=edgebook_owner}"

[[ "$target_db" != "$POSTGRES_DB" ]] || { printf 'Refusing to restore over production database %s.\n' "$POSTGRES_DB" >&2; exit 1; }
resolved_target_uploads="$(realpath -m "$target_uploads")"
case "$resolved_target_uploads" in
  /srv/edgebook-data/restore/*) ;;
  *) printf 'Target uploads must be below /srv/edgebook-data/restore/.\n' >&2; exit 1 ;;
esac
target_uploads="$resolved_target_uploads"
[[ ! -L "$target_uploads" ]] || { printf 'Target upload directory must not be a symlink.\n' >&2; exit 1; }

"$(dirname "$0")/verify-backup.sh" --require-frozen "$bundle"

if [[ -e "$target_uploads" ]] && [[ -n "$(find "$target_uploads" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  printf 'Refusing non-empty target upload directory: %s\n' "$target_uploads" >&2
  exit 1
fi

compose=(docker compose --project-directory "$COMPOSE_PROJECT_DIR" --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE")
exists="$("${compose[@]}" exec -T -u postgres "$POSTGRES_SERVICE" \
  psql --username="$POSTGRES_BACKUP_USER" --dbname=postgres --tuples-only --no-align \
  --command="SELECT 1 FROM pg_database WHERE datname = '$target_db'" | tr -d '[:space:]')"
[[ "$exists" == '1' ]] || { printf 'Target database does not exist: %s\n' "$target_db" >&2; exit 1; }

table_count="$("${compose[@]}" exec -T -u postgres "$POSTGRES_SERVICE" \
  psql --username="$POSTGRES_BACKUP_USER" --dbname="$target_db" --tuples-only --no-align \
  --command="SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')" | tr -d '[:space:]')"
[[ "$table_count" == '0' ]] || { printf 'Target database is not empty (%s user tables).\n' "$table_count" >&2; exit 1; }

printf 'Restoring database into isolated target %s...\n' "$target_db"
"${compose[@]}" exec -T -u postgres "$POSTGRES_SERVICE" \
  pg_restore --username="$POSTGRES_BACKUP_USER" --dbname="$target_db" \
  --exit-on-error --no-owner --role="$EDGEBOOK_DB_OWNER" <"$bundle/database.dump"

mkdir -p -- "$target_uploads"
tar --extract --gzip --file="$bundle/uploads.tar.gz" --directory="$target_uploads" \
  --no-same-owner --no-same-permissions
chown -R 12001:12001 -- "$target_uploads"
chmod 0750 -- "$target_uploads"

printf 'Restore staged successfully. Production was not changed.\n'
printf 'Validate %s and %s before any separately approved pointer swap.\n' "$target_db" "$target_uploads"
