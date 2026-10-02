#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s [--require-frozen] /absolute/path/to/backup-directory\n' "$0" >&2
  exit 2
}

require_frozen=false
if [[ "${1:-}" == --require-frozen ]]; then require_frozen=true; shift; fi
[[ $# -eq 1 ]] || usage
bundle="$1"
[[ "$bundle" = /* ]] || { printf 'Backup path must be absolute.\n' >&2; exit 1; }
[[ -d "$bundle" ]] || { printf 'Backup directory not found: %s\n' "$bundle" >&2; exit 1; }

for file in database.dump uploads.tar.gz file-inventory.tsv metadata.txt SHA256SUMS; do
  [[ -f "$bundle/$file" ]] || { printf 'Missing backup file: %s\n' "$file" >&2; exit 1; }
done

checksum_names="$(awk 'NF == 2 { name=$2; sub(/^\*/, "", name); print name }' "$bundle/SHA256SUMS" | LC_ALL=C sort)"
expected_checksum_names="$(printf '%s\n' database.dump file-inventory.tsv metadata.txt uploads.tar.gz | LC_ALL=C sort)"
[[ "$checksum_names" == "$expected_checksum_names" ]] || {
  printf 'SHA256SUMS must contain exactly the four reviewed backup payload files.\n' >&2
  exit 1
}

(
  cd "$bundle"
  sha256sum --check SHA256SUMS
)

magic="$(head -c 5 "$bundle/database.dump")"
[[ "$magic" == 'PGDMP' ]] || { printf 'database.dump is not PostgreSQL custom format.\n' >&2; exit 1; }

grep -Fxq 'format_version=2' "$bundle/metadata.txt" || {
  printf 'Unsupported or missing backup metadata format.\n' >&2; exit 1;
}
if [[ "$require_frozen" == true ]]; then
  grep -Fxq 'writes_frozen=true' "$bundle/metadata.txt" || {
    printf 'Backup was not recorded under an Edge Book write freeze.\n' >&2; exit 1;
  }
fi

bad_member=''
while IFS= read -r member; do
  case "$member" in
    /*|../*|*/../*|*/..) bad_member="$member"; break ;;
  esac
done < <(tar --list --gzip --file="$bundle/uploads.tar.gz")
[[ -z "$bad_member" ]] || { printf 'Unsafe upload archive member: %s\n' "$bad_member" >&2; exit 1; }

duplicate_member="$(tar --list --gzip --file="$bundle/uploads.tar.gz" | LC_ALL=C sort | uniq -d | head -n 1)"
[[ -z "$duplicate_member" ]] || { printf 'Duplicate upload archive member: %s\n' "$duplicate_member" >&2; exit 1; }

bad_type=''
while IFS= read -r listing; do
  type="${listing:0:1}"
  case "$type" in
    -|d) ;;
    *) bad_type="$listing"; break ;;
  esac
done < <(tar --list --verbose --gzip --file="$bundle/uploads.tar.gz")
[[ -z "$bad_type" ]] || {
  printf 'Unsafe upload archive entry type (links/devices are forbidden): %s\n' "$bad_type" >&2
  exit 1
}

while IFS=$'\t' read -r storage_key expected_sha256; do
  [[ -n "$storage_key" ]] || continue
  if [[ "$storage_key" = /* || "$storage_key" == *\\* || "$storage_key" =~ (^|/)\.\.?(/|$) || ! "$expected_sha256" =~ ^[a-f0-9]{64}$ ]]; then
    printf 'Unsafe file inventory row: %s\n' "$storage_key" >&2
    exit 1
  fi
  archived_sha256="$(tar --extract --to-stdout --gzip --file="$bundle/uploads.tar.gz" -- "./$storage_key" | sha256sum | awk '{print $1}')"
  [[ "$archived_sha256" == "$expected_sha256" ]] || {
    printf 'Archived private file checksum mismatch: %s\n' "$storage_key" >&2
    exit 1
  }
done <"$bundle/file-inventory.tsv"

if command -v pg_restore >/dev/null 2>&1; then
  pg_restore --list "$bundle/database.dump" >/dev/null
else
  printf 'INFO: host pg_restore unavailable; custom-format magic and checksum were verified.\n'
fi

printf 'Backup verification passed: %s\n' "$bundle"
