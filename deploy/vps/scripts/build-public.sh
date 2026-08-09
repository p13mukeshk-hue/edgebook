#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s --mode rehearsal|cutover --destination /opt/edgebook/releases/<release-id>/public\n' "$0" >&2
  exit 2
}

destination=''
mode=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --destination) destination="${2:-}"; shift 2 ;;
    --mode) mode="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done

[[ "$mode" == rehearsal || "$mode" == cutover ]] || usage
command -v realpath >/dev/null 2>&1 || { printf 'Missing command: realpath\n' >&2; exit 1; }
destination="$(realpath -m -- "$destination")"
[[ "$destination" =~ ^/opt/edgebook/releases/[A-Za-z0-9._-]+/public$ ]] || {
  printf 'Refusing destination outside /opt/edgebook/releases/<id>/public: %s\n' "$destination" >&2
  exit 1
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/../../.." && pwd -P)"
for source in index.html app.html landing.html 404.html \
  client/api-client.js client/auth-adapter.js client/data-adapter.js; do
  [[ -f "$repo_root/$source" ]] || { printf 'Missing public source: %s\n' "$source" >&2; exit 1; }
done

if [[ -e "$destination" ]] && [[ -n "$(find "$destination" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]]; then
  printf 'Refusing non-empty public destination: %s\n' "$destination" >&2
  exit 1
fi

install -d -m 0755 -- "$destination/client"
install -m 0644 -- "$repo_root/index.html" "$destination/index.html"
install -m 0644 -- "$repo_root/app.html" "$destination/app.html"
install -m 0644 -- "$repo_root/landing.html" "$destination/landing.html"
install -m 0644 -- "$repo_root/404.html" "$destination/404.html"
install -m 0644 -- "$repo_root/client/api-client.js" "$destination/client/api-client.js"
install -m 0644 -- "$repo_root/client/auth-adapter.js" "$destination/client/auth-adapter.js"
install -m 0644 -- "$repo_root/client/data-adapter.js" "$destination/client/data-adapter.js"

for page in app.html index.html landing.html; do
  if grep -Eiq 'enableFirebaseFallback|firebase-fallback|www\.gstatic\.com/firebasejs' "$destination/$page"; then
    printf 'Refusing Firebase runtime reference in VPS-only page %s\n' "$page" >&2
    exit 1
  fi
done

[[ ! -e "$destination/client/firebase-fallback.js" ]] || {
  printf 'Firebase fallback module must not exist in a VPS artifact\n' >&2
  exit 1
}

printf '{"artifactMode":"%s","dataBackend":"vps-postgres","firebaseDependency":false}\n' "$mode" \
  >"$destination/edgebook-build.json"
chmod 0644 -- "$destination/edgebook-build.json"

printf 'Created allowlisted %s static directory: %s\n' "$mode" "$destination"
