#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  printf 'Usage: %s --candidate /opt/edgebook/releases/<release-id>\n' "$0" >&2
  exit 2
}

candidate=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --candidate) candidate="${2:-}"; shift 2 ;;
    *) usage ;;
  esac
done
[[ -n "$candidate" ]] || usage
command -v realpath >/dev/null 2>&1 || { printf 'Missing command: realpath\n' >&2; exit 1; }

candidate_lexical="$(realpath -m -s -- "$candidate")"
candidate="$(realpath -m -- "$candidate")"
[[ "$candidate_lexical" == "$candidate" && ! -L "$candidate" ]] || {
  printf 'Rollback candidate path must not contain symlinks: %s\n' "$candidate_lexical" >&2
  exit 1
}
[[ "$candidate" =~ ^/opt/edgebook/releases/[A-Za-z0-9._-]+$ && -d "$candidate" ]] || {
  printf 'Refusing rollback candidate outside /opt/edgebook/releases/<release-id>: %s\n' "$candidate" >&2
  exit 1
}

marker="$candidate/public/edgebook-build.json"
app="$candidate/public/app.html"
[[ -f "$marker" && ! -L "$marker" && -f "$app" && ! -L "$app" ]] || {
  printf 'Rollback candidate lacks a safe built public artifact: %s\n' "$candidate" >&2
  exit 1
}
grep -Fq -- '"tradeQuantityCompatibility":"ctrader-quantity-projection-base-units-v1"' "$marker" || {
  printf 'ROLLBACK REJECTED: candidate UI predates canonical cTrader base-unit quantities.\n' >&2
  exit 1
}

contracts=(
  "const value=trade?.brokerData?.quantityProjection;"
  "base units from cTrader; lot conversion unavailable"
  "const excluded=open.filter(t=>readCTraderQuantityProjection(t)?.unit==='base_units');"
  "const measurable=open.filter(t=>readCTraderQuantityProjection(t)?.unit!=='base_units');"
  "excluded from exposure: size is available in base units"
)
for contract in "${contracts[@]}"; do
  grep -Fq -- "$contract" "$app" || {
    printf 'ROLLBACK REJECTED: candidate marker/source disagree on base-unit contract: %s\n' "$contract" >&2
    exit 1
  }
done

printf 'Rollback candidate is UI-compatible with cTrader base-unit quantities: %s\n' "$candidate"
