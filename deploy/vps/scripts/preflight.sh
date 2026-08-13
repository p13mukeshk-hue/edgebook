#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only host checks. This script deliberately does not install, stop, start,
# reload, chmod, chown, create, or delete anything.

EDGEBOOK_HOST_PORT="${EDGEBOOK_HOST_PORT:-3210}"
EDGEBOOK_MIN_FREE_BYTES="${EDGEBOOK_MIN_FREE_BYTES:-10737418240}"
EDGEBOOK_WARN_FREE_BYTES="${EDGEBOOK_WARN_FREE_BYTES:-16106127360}"

[[ "$EDGEBOOK_HOST_PORT" =~ ^[0-9]+$ ]] && (( EDGEBOOK_HOST_PORT >= 1 && EDGEBOOK_HOST_PORT <= 65535 )) || {
  printf 'ERROR: EDGEBOOK_HOST_PORT must be an integer from 1 to 65535.\n' >&2; exit 1;
}
[[ "$EDGEBOOK_HOST_PORT" == 3210 ]] || {
  printf 'ERROR: this reviewed shared-VPS deployment is fixed to 127.0.0.1:3210.\n' >&2; exit 1;
}
[[ "$EDGEBOOK_MIN_FREE_BYTES" =~ ^[0-9]+$ ]] && (( EDGEBOOK_MIN_FREE_BYTES >= 10737418240 )) || {
  printf 'ERROR: EDGEBOOK_MIN_FREE_BYTES must be at least 10737418240 (10 GiB).\n' >&2; exit 1;
}
[[ "$EDGEBOOK_WARN_FREE_BYTES" =~ ^[0-9]+$ ]] && (( EDGEBOOK_WARN_FREE_BYTES >= EDGEBOOK_MIN_FREE_BYTES )) || {
  printf 'ERROR: EDGEBOOK_WARN_FREE_BYTES must be an integer at least as large as EDGEBOOK_MIN_FREE_BYTES.\n' >&2; exit 1;
}

for url_name in DATABASE_URL MIGRATION_DATABASE_URL; do
  url_value="$(printenv "$url_name" 2>/dev/null || true)"
  if [[ -n "$url_value" && "$url_value" != *@postgres:5432/* ]]; then
    printf 'ERROR: %s must resolve the private Compose service postgres:5432.\n' "$url_name" >&2
    exit 1
  fi
done

required=(docker ss nginx)
for cmd in "${required[@]}"; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'ERROR: required command is missing: %s\n' "$cmd" >&2
    exit 1
  fi
done

if ! docker compose version >/dev/null 2>&1; then
  printf 'ERROR: Docker Compose v2 is required.\n' >&2
  exit 1
fi

listeners="$(ss -H -ltnp "sport = :${EDGEBOOK_HOST_PORT}" 2>/dev/null || true)"
if [[ -n "$listeners" ]]; then
  non_loopback_listener="$(awk -v port=":${EDGEBOOK_HOST_PORT}" '$4 != "127.0.0.1" port { print $4 }' <<<"$listeners")"
  if [[ -n "$non_loopback_listener" ]]; then
    printf 'ERROR: Edge Book port %s is exposed beyond IPv4 loopback: %s\n' \
      "$EDGEBOOK_HOST_PORT" "$non_loopback_listener" >&2
    exit 1
  fi
  owned_by_edgebook="$(docker ps \
    --filter label=com.docker.compose.project=edgebook \
    --filter label=com.docker.compose.service=api \
    --format '{{.ID}}' 2>/dev/null || true)"
  if [[ -z "$owned_by_edgebook" ]]; then
    printf 'ERROR: 127.0.0.1:%s is already occupied:\n%s\n' \
      "$EDGEBOOK_HOST_PORT" "$listeners" >&2
    exit 1
  fi
  printf 'OK: port %s is owned by the existing Edge Book API container.\n' "$EDGEBOOK_HOST_PORT"
else
  printf 'OK: port %s is unused.\n' "$EDGEBOOK_HOST_PORT"
fi

existing_8787="$(ss -H -ltnp 'sport = :8787' 2>/dev/null || true)"
if [[ -n "$existing_8787" ]]; then
  printf 'INFO: existing service on port 8787 detected and left untouched.\n'
fi

printf 'Docker: '
docker version --format '{{.Server.Version}}' 2>/dev/null || printf 'server unavailable'
printf '\nCompose: '
docker compose version --short 2>/dev/null || true
printf '\nNginx: '
nginx -v 2>&1 || true
printf '\n'

if command -v node >/dev/null 2>&1; then
  printf 'Host Node (informational; Edge Book does not use it): '
  node --version
fi
if command -v psql >/dev/null 2>&1; then
  printf 'Host PostgreSQL client (informational; Edge Book DB is containerized): '
  psql --version
fi

check_disk_floor() {
  local probe="$1"
  local label="$2"
  local row available used_percent free_percent
  row="$(df -B1 --output=avail,pcent "$probe" | tail -n 1)"
  available="$(awk '{print $1}' <<<"$row")"
  used_percent="$(awk '{gsub(/%/, "", $2); print $2}' <<<"$row")"
  free_percent=$((100 - used_percent))
  if (( available < EDGEBOOK_MIN_FREE_BYTES )); then
    printf 'ERROR: %s disk floor failed: %s bytes available (%s%% free); require at least %s bytes (10 GiB).\n' \
      "$label" "$available" "$free_percent" "$EDGEBOOK_MIN_FREE_BYTES" >&2
    exit 1
  fi
  if (( available < EDGEBOOK_WARN_FREE_BYTES )); then
    printf 'WARN: %s has %s bytes available (%s%% free), below the %s-byte (15 GiB) cleanup warning; deployment remains allowed.\n' \
      "$label" "$available" "$free_percent" "$EDGEBOOK_WARN_FREE_BYTES" >&2
  else
    printf 'OK: %s disk capacity: %s bytes available, %s%% free.\n' "$label" "$available" "$free_percent"
  fi
}

check_disk_floor /srv 'Edge Book data filesystem'
docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
if [[ -z "$docker_root" || ! -e "$docker_root" ]]; then
  printf 'ERROR: Docker daemon/root directory is unavailable; Docker disk floor cannot be verified.\n' >&2
  exit 1
fi
check_disk_floor "$docker_root" 'Docker filesystem'

printf 'Preflight passed. No host state was changed.\n'
