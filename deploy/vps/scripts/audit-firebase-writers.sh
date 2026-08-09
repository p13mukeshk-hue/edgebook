#!/usr/bin/env bash
set -Eeuo pipefail

# Read-only cutover gate. It never disables/deletes a function, job or Firebase
# resource. The fixed project guard prevents an operator from accidentally
# auditing (and later acting on) an unrelated Firebase/GCP project.

project="${1:-edgebook-2dce2}"
location="${EDGEBOOK_FIREBASE_FUNCTION_REGION:-us-central1}"
[[ "$project" == edgebook-2dce2 ]] || {
  printf 'Refusing unexpected Firebase project: %s\n' "$project" >&2
  exit 1
}
for command_name in firebase gcloud grep; do
  command -v "$command_name" >/dev/null 2>&1 || {
    printf 'ERROR: required read-only audit command is missing: %s\n' "$command_name" >&2
    exit 1
  }
done

work_dir="$(mktemp -d)"
cleanup() { [[ -d "$work_dir" ]] && rm -rf -- "$work_dir"; }
trap cleanup EXIT INT TERM

firebase functions:list --project "$project" >"$work_dir/functions.txt"
gcloud scheduler jobs list --project "$project" \
  --location "$location" \
  --format='value(name,state,httpTarget.uri,pubsubTarget.topicName)' >"$work_dir/schedulers.txt"

writer_pattern='zerodhaLogin|zerodhaCallback|syncZerodhaTrades|syncZerodhaHistory|restoreWronglyDeletedZerodha|zerodhaPostback|marketHoursTradeSync|scheduledTradeSync|ctraderConnect|ctraderAddAccount|ctraderSymbolInfo|syncCtraderTrades|backfillCtraderTimes|forceReimportCtrader|syncCtraderHistory|ctraderScheduledSync'
failed=false
if grep -E "$writer_pattern" "$work_dir/functions.txt"; then
  printf 'ERROR: legacy Edge Book writer-capable Firebase Functions are still deployed.\n' >&2
  failed=true
fi
if grep -Ei 'edgebook|zerodha|ctrader|marketHoursTradeSync|scheduledTradeSync' "$work_dir/schedulers.txt"; then
  printf 'ERROR: possible Edge Book Cloud Scheduler jobs remain; review/disable them before VPS writer activation.\n' >&2
  failed=true
fi
[[ "$failed" == false ]] || exit 1
printf 'Firebase writer audit passed for %s/%s: no known legacy function or scheduler target is active.\n' "$project" "$location"
