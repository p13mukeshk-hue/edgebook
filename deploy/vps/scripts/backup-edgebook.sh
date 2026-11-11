#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

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
: "${UPLOAD_ROOT:?UPLOAD_ROOT is required}"
: "${BACKUP_ROOT:?BACKUP_ROOT is required}"
: "${EDGEBOOK_QUIESCE_WRITERS:=true}"

case "$UPLOAD_ROOT" in
  /srv/edgebook-data/uploads|/srv/edgebook-data/uploads/) ;;
  *) printf 'Refusing unexpected upload root: %s\n' "$UPLOAD_ROOT" >&2; exit 1 ;;
esac
case "$BACKUP_ROOT" in
  /var/backups/edgebook|/var/backups/edgebook/) ;;
  *) printf 'Refusing unexpected backup root: %s\n' "$BACKUP_ROOT" >&2; exit 1 ;;
esac

for cmd in docker tar sha256sum flock realpath; do
  command -v "$cmd" >/dev/null 2>&1 || { printf 'Missing command: %s\n' "$cmd" >&2; exit 1; }
done

mkdir -p -- "$BACKUP_ROOT"
backup_root_lexical="$(realpath -m -s -- "$BACKUP_ROOT")"
backup_root_canonical="$(realpath -m -- "$BACKUP_ROOT")"
[[ "$backup_root_lexical" == "$backup_root_canonical" && -d "$BACKUP_ROOT" && ! -L "$BACKUP_ROOT" ]] || {
  printf 'Backup root or one of its parents resolves through a symlink: %s\n' "$BACKUP_ROOT" >&2
  exit 1
}
[[ -d /run/edgebook && ! -L /run/edgebook ]] || {
  printf 'Missing safe maintenance-lock directory; apply deploy/vps/tmpfiles.d/edgebook.conf first.\n' >&2
  exit 1
}
exec 9>/run/edgebook/maintenance.lock
if ! flock -n 9; then
  printf 'Another Edge Book backup/cleanup operation is already running.\n' >&2
  exit 1
fi

compose=(docker compose --project-directory "$COMPOSE_PROJECT_DIR" --env-file "$COMPOSE_ENV_FILE" -f "$COMPOSE_FILE" --profile writer)
timestamp="$(date -u +'%Y%m%dT%H%M%SZ')"
final_dir="${BACKUP_ROOT%/}/${timestamp}"
if [[ -e "$final_dir" ]]; then
  printf 'Refusing to overwrite existing backup: %s\n' "$final_dir" >&2
  exit 1
fi

work_dir="$(mktemp -d "${BACKUP_ROOT%/}/.partial-${timestamp}.XXXXXX")"
quiesced_services=()
resume_quiesced() {
  if (( ${#quiesced_services[@]} > 0 )); then
    printf 'Restarting only the Edge Book writer services that were running before backup...\n'
    "${compose[@]}" up --detach --no-deps "${quiesced_services[@]}"
    quiesced_services=()
  fi
}
cleanup() {
  [[ -d "$work_dir" ]] && rm -rf -- "$work_dir"
  resume_quiesced
}
trap cleanup EXIT INT TERM

if [[ "$EDGEBOOK_QUIESCE_WRITERS" == true ]]; then
  mapfile -t running_services < <("${compose[@]}" ps --services --filter status=running)
  for service in api worker; do
    if printf '%s\n' "${running_services[@]}" | grep -Fxq "$service"; then
      quiesced_services+=("$service")
    fi
  done
  if (( ${#quiesced_services[@]} > 0 )); then
    printf 'Quiescing Edge Book writers for a DB/filesystem-consistent backup...\n'
    "${compose[@]}" stop --timeout 30 "${quiesced_services[@]}"
  fi
  writes_frozen=true
elif [[ "${EDGEBOOK_WRITES_FROZEN:-false}" == true ]]; then
  writes_frozen=true
else
  printf 'Refusing a potentially inconsistent backup: enable writer quiescing or provide an external write freeze.\n' >&2
  exit 1
fi

printf 'Creating PostgreSQL custom dump...\n'
"${compose[@]}" exec -T -u postgres "$POSTGRES_SERVICE" \
  pg_dump --username="$POSTGRES_BACKUP_USER" --dbname="$POSTGRES_DB" \
  --format=custom --compress=6 --no-owner >"$work_dir/database.dump"

printf 'Validating PostgreSQL dump catalog...\n'
"${compose[@]}" exec -T -u postgres "$POSTGRES_SERVICE" \
  pg_restore --list <"$work_dir/database.dump" >/dev/null

printf 'Validating every live private-file reference under the write freeze...\n'
"${compose[@]}" exec -T -u postgres "$POSTGRES_SERVICE" \
  psql --username="$POSTGRES_BACKUP_USER" --dbname="$POSTGRES_DB" \
  --quiet --tuples-only --no-align --field-separator=$'\t' \
  --command="SELECT storage_key,encode(sha256,'hex') FROM file_objects WHERE deleted_at IS NULL ORDER BY storage_key" \
  >"$work_dir/file-inventory.tsv"
while IFS=$'\t' read -r storage_key expected_sha256; do
  [[ -n "$storage_key" ]] || continue
  if [[ "$storage_key" = /* || "$storage_key" == *\\* || "$storage_key" =~ (^|/)\.\.?(/|$) || ! "$expected_sha256" =~ ^[a-f0-9]{64}$ ]]; then
    printf 'Unsafe database file inventory row: %s\n' "$storage_key" >&2
    exit 1
  fi
  lexical_source_file="$(realpath -m -s -- "${UPLOAD_ROOT%/}/$storage_key")"
  source_file="$(realpath -m -- "${UPLOAD_ROOT%/}/$storage_key")"
  [[ "$source_file" == "$lexical_source_file" ]] || { printf 'Database file reference resolves through a symlink: %s\n' "$storage_key" >&2; exit 1; }
  case "$source_file" in
    "${UPLOAD_ROOT%/}"/*) ;;
    *) printf 'Database file reference escapes upload root: %s\n' "$storage_key" >&2; exit 1 ;;
  esac
  [[ -f "$source_file" && ! -L "$source_file" ]] || { printf 'Referenced private file is missing/unsafe: %s\n' "$storage_key" >&2; exit 1; }
  actual_sha256="$(sha256sum -- "$source_file" | awk '{print $1}')"
  [[ "$actual_sha256" == "$expected_sha256" ]] || { printf 'Referenced private file checksum mismatch: %s\n' "$storage_key" >&2; exit 1; }
done <"$work_dir/file-inventory.tsv"

printf 'Archiving private uploads...\n'
if [[ -d "$UPLOAD_ROOT" ]]; then
  upload_root_lexical="$(realpath -m -s -- "$UPLOAD_ROOT")"
  upload_root_canonical="$(realpath -m -- "$UPLOAD_ROOT")"
  [[ "$upload_root_lexical" == "$upload_root_canonical" && ! -L "$UPLOAD_ROOT" ]] || {
    printf 'Upload root or one of its parents resolves through a symlink: %s\n' "$UPLOAD_ROOT" >&2
    exit 1
  }
  tar --create --gzip --file="$work_dir/uploads.tar.gz" --directory="$UPLOAD_ROOT" .
else
  printf 'Upload directory was absent at backup time.\n' >"$work_dir/uploads-absent.txt"
  tar --create --gzip --file="$work_dir/uploads.tar.gz" --files-from=/dev/null
fi

cat >"$work_dir/metadata.txt" <<EOF
format_version=2
created_at_utc=${timestamp}
database=${POSTGRES_DB}
upload_root=${UPLOAD_ROOT}
writes_frozen=${writes_frozen}
host=$(hostname -f 2>/dev/null || hostname)
EOF

(
  cd "$work_dir"
  sha256sum database.dump uploads.tar.gz file-inventory.tsv metadata.txt >SHA256SUMS
)

"$(dirname "$0")/verify-backup.sh" --require-frozen "$work_dir"

mv -- "$work_dir" "$final_dir"
resume_quiesced
trap - EXIT INT TERM
printf 'Backup completed atomically: %s\n' "$final_dir"
printf 'No retention deletion was performed. Copy this bundle to encrypted off-host storage.\n'
