#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

usage() {
  printf 'Usage: %s --release-dir /opt/edgebook/releases/<release-id> --env-file /etc/edgebook/edgebook.env --image-tag <immutable-tag>\n' "$0" >&2
  exit 2
}

release_dir=''
env_file=''
image_tag=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --release-dir) release_dir="${2:-}"; shift 2 ;;
    --env-file) env_file="${2:-}"; shift 2 ;;
    --image-tag) image_tag="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ -n "$release_dir" && -n "$env_file" && -n "$image_tag" ]] || usage
for cmd in docker flock realpath stat; do
  command -v "$cmd" >/dev/null 2>&1 || { printf 'Missing command: %s\n' "$cmd" >&2; exit 1; }
done
docker compose version >/dev/null 2>&1 || { printf 'Docker Compose v2 is required.\n' >&2; exit 1; }

release_lexical="$(realpath -m -s -- "$release_dir")"
release_dir="$(realpath -m -- "$release_dir")"
[[ "$release_lexical" == "$release_dir" && ! -L "$release_dir" ]] || {
  printf 'Release path must not contain symlinks: %s\n' "$release_lexical" >&2
  exit 1
}
[[ "$release_dir" =~ ^/opt/edgebook/releases/[A-Za-z0-9._-]+$ && -d "$release_dir" ]] || {
  printf 'Refusing release outside /opt/edgebook/releases/<release-id>: %s\n' "$release_dir" >&2
  exit 1
}
compose_file="$release_dir/deploy/vps/docker-compose.yml"
[[ -f "$compose_file" && ! -L "$compose_file" ]] || {
  printf 'Release Compose file is missing or unsafe: %s\n' "$compose_file" >&2
  exit 1
}

env_lexical="$(realpath -m -s -- "$env_file")"
env_file="$(realpath -m -- "$env_file")"
[[ "$env_lexical" == "$env_file" && "$env_file" == /etc/edgebook/edgebook.env && -f "$env_file" && ! -L "$env_file" ]] || {
  printf 'Environment file must be the non-symlinked /etc/edgebook/edgebook.env.\n' >&2
  exit 1
}
read -r env_owner env_mode < <(stat -c '%u %a' -- "$env_file")
[[ "$env_owner" == 0 ]] || { printf 'Environment file must be owned by root.\n' >&2; exit 1; }
[[ "$env_mode" =~ ^[0-7]{3,4}$ ]] || { printf 'Could not verify environment file mode.\n' >&2; exit 1; }
(( (8#$env_mode & 8#077) == 0 )) || {
  printf 'Environment file must not grant group or other permissions (observed mode %s).\n' "$env_mode" >&2
  exit 1
}

[[ "$image_tag" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$ && "$image_tag" != latest && "$image_tag" != local ]] || {
  printf 'Image tag must be an explicit immutable tag (not latest/local): %s\n' "$image_tag" >&2
  exit 1
}
[[ "$image_tag" == *-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f] ]] || {
  printf 'Image tag must end in a seven-character lowercase Git commit prefix: %s\n' "$image_tag" >&2
  exit 1
}
image="edgebook-api:$image_tag"
docker image inspect "$image" >/dev/null 2>&1 || {
  printf 'Required local migration image is missing: %s\n' "$image" >&2
  exit 1
}

[[ -d /run/edgebook && ! -L /run/edgebook ]] || {
  printf 'Missing safe maintenance-lock directory; apply deploy/vps/tmpfiles.d/edgebook.conf first.\n' >&2
  exit 1
}
exec 9>/run/edgebook/maintenance.lock
if ! flock -n 9; then
  printf 'Another Edge Book maintenance operation is already running.\n' >&2
  exit 1
fi

# Check by Compose labels rather than by this release's model. That also catches
# writer containers left running from the previous /opt/edgebook/current target.
mapfile -t running_services < <(
  docker ps \
    --filter label=com.docker.compose.project=edgebook \
    --format '{{.Label "com.docker.compose.service"}}' \
    | sort -u
)
for service in "${running_services[@]}"; do
  case "$service" in
    api|worker)
      printf 'Refusing migration while Edge Book %s is running; quiesce both api and worker first.\n' "$service" >&2
      exit 1
      ;;
    migrate)
      printf 'Refusing migration while another Edge Book migrator is running.\n' >&2
      exit 1
      ;;
  esac
done

mapfile -t postgres_ids < <(
  docker ps -q \
    --filter label=com.docker.compose.project=edgebook \
    --filter label=com.docker.compose.service=postgres
)
(( ${#postgres_ids[@]} == 1 )) || {
  printf 'Expected exactly one running Edge Book PostgreSQL container; observed %s.\n' "${#postgres_ids[@]}" >&2
  exit 1
}
postgres_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "${postgres_ids[0]}")"
[[ "$postgres_health" == healthy ]] || {
  printf 'Edge Book PostgreSQL must be healthy before migration (observed %s).\n' "$postgres_health" >&2
  exit 1
}

export COMPOSE_PROJECT_NAME=edgebook
export EDGEBOOK_IMAGE_TAG="$image_tag"
compose=(
  docker compose
  --project-directory "$release_dir"
  --env-file "$env_file"
  -f "$compose_file"
  --profile tools
)
mapfile -t selected_migrate_images < <("${compose[@]}" config --images migrate)
(( ${#selected_migrate_images[@]} == 1 )) && [[ "${selected_migrate_images[0]}" == "$image" ]] || {
  printf 'Rendered release does not select the explicit migration image %s.\n' "$image" >&2
  exit 1
}

printf 'Running quiesced Edge Book migrations from %s with image %s...\n' "$release_dir" "$image"
"${compose[@]}" run --rm --no-deps --pull never migrate
printf 'Edge Book migrations completed; api and worker remain stopped.\n'
