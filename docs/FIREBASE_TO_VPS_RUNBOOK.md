# Firebase-to-VPS cutover and rollback runbook

This runbook retires Firebase and the live Zerodha integration without losing
historical data. It assumes the isolated VPS stack in `deploy/vps/` and the
read-only/staging tools in `migration/`.

It is a future operator runbook, not authorization to change live DNS, Nginx,
Firebase, the VPS, DeltaLens, or any independent Zerodha system now. DeltaLens
and external Zerodha processes/credentials/schedulers are no-touch boundaries;
only the Edge Book-owned integration may be retired in a separately approved
cutover.

## Invariants

1. There is exactly one writer and one scheduler owner at every moment.
2. The final export and retained Firebase data are not deleted during the
   rollback window; obsolete Functions/schedulers are explicitly disabled or
   deleted before VPS writers start so they cannot resume silently.
3. No legacy broker token is migrated.
4. Historical and archived Zerodha trades retain their provenance and IDs.
5. A migration is not accepted on UI spot checks alone; manifests, hashes,
   per-trade fingerprints, aggregates and screenshot objects must reconcile.
6. Rollback never restores over the live database or upload tree.

## Roles

- **Cutover lead:** authorizes each gate and records timestamps.
- **Firebase operator:** freezes old writes/schedules and creates final export.
- **VPS operator:** deploys the isolated stack and controls scheduler ownership.
- **Data verifier:** independently validates export/import/reconciliation.
- **Product verifier:** tests identity, journals, archived history and uploads.

One person may hold multiple roles for a small deployment, but the gate checklist
must still be recorded.

## Single-writer state machine

| Phase | Firebase UI writes | Firebase schedules | VPS writes | VPS scheduler |
|---|---:|---:|---:|---:|
| Rehearsal | On | On | Off/read-only | Off |
| Write freeze | Off | Off | Off | Off |
| Final import | Off | Off | Staging only | Off |
| VPS cutover | Off | Off | On | One owner |
| Rollback decision | Off | Off | Off | Off |
| Pre-write rollback | On after approval | One owner after approval | Off | Off |

Never transition directly from both systems Off to both systems On. The cutover
lead records which system owns writes and the scheduler lease.

## Phase 0 — decisions and baseline

- Confirm live Zerodha OAuth/API sync is being removed.
- Decide whether Zerodha CSV recognition remains. Recommended: yes, with
  `sourceSystem=zerodha` and `ingestionMethod=csv` distinct from retired API sync.
- Confirm cTrader remains only through fresh official OAuth with read-only
  `scope=accounts` and selection by `ctidTraderAccountId`.
- Define maintenance window, rollback window (recommended 30–90 days), data
  retention and responsible operators.
- Inventory Firebase Auth users and these paths:
  - `users/*/trades/*`, including `deleted=true`;
  - `users/*/meta/*` and account/settings maps;
  - `users/*/brokers/*` metadata, excluding credentials;
  - `users/*/pendingDuplicates/*`, notifications, orders and order updates;
  - `users/*/screenshots/*` Storage objects.
- Record per-user active/archived counts, source/account counts, earliest/latest
  date, P&L aggregate and screenshot-reference/object counts.
- Record browser-local Daily Journal and Mood Tracker counts for each browser.

## Phase 1 — rehearsal with writes still on Firebase

1. Run the VPS preflight. Port 3210 must be unused; `*:8787` remains untouched.
2. Build a `--mode rehearsal` static artifact and start only the isolated API/DB
   on loopback. The artifact is VPS-only: it has no Firebase fallback module and
   fails closed when the API is unavailable. Keep `COMPOSE_PROFILES` blank, so
   no cTrader worker exists. Leave the complete cTrader credential set blank if
   the API should report cTrader disabled during this rehearsal.
3. Apply the raw staging schema and application schema to the private container DB.
4. Export one non-production/test UID using `migration/scripts/export-firebase.mjs`.
5. Validate, dry-run, stage, promote with reviewed backend logic, and reconcile.
6. Copy screenshots to the private upload tree and verify authenticated retrieval.
7. Exercise sign-in identity linking using `legacy_firebase_uid` and verified email.
8. Exercise a fresh cTrader OAuth authorization; verify `scope=accounts`, chosen
   `ctidTraderAccountId`, token encryption, reconnect and revocation behavior.
9. Test a complete backup and staged restore.
10. Destroy rehearsal credentials/data according to the approved retention policy.

Rehearsal failure does not affect production because VPS application writes and
scheduling remain disabled.

## Phase 2 — pre-freeze export

Create and validate a full read-only export while Firebase remains authoritative.
Stage it on the VPS to measure duration and surface schema problems. Do not
promote it as the final copy. Estimate final maintenance duration from this run.

Notify users that browser-local Settings, Mood Tracker and Daily Journal data
requires opening the authenticated old app on every browser/profile. Use the
visible **Export complete backup** control where it is already available. For
the currently deployed legacy build, use the reviewable, non-deployable
`migration/browser/export-local-data.js` utility instead:

1. Review the utility from the checked-out cutover release. It contains no
   `fetch`, XHR, beacon, WebSocket or localStorage mutation.
2. In each profile, open the already signed-in legacy app and verify the address
   bar is exactly `https://edgebook.trade` or `https://www.edgebook.trade` (after
   redirects, use the origin actually displayed). Never paste it into another
   site or a signed-out page.
3. Open DevTools Console and paste the entire utility. It obtains the immutable
   UID from `window._fbAuth.currentUser`, reads only the three UID-scoped keys,
   rejects credential-like keys/URLs, and makes no network write.
4. In the visible review panel record origin, legacy UID, settings/account/mood/
   journal counts and SHA-256. Only then click **Download complete browser
   backup**. Independently hash the downloaded file and require the exact same
   SHA-256 before secure transfer to the migration operator.
5. Collect one file from every known browser/profile. Each file is shaped as
   `{users:{legacyFirebaseUid:{settings,moods,dailyJournal}}}`. If two files for
   one UID differ, merge them under explicit review: never silently overwrite
   settings, a mood ID, or a journal date. Re-run promoter dry-run and
   reconciliation against the exact reviewed consolidated file.

Record per-profile counts and Firebase UID in the cutover evidence. This offline
file remains a mandatory promotion and reconciliation input even though the new
app also has a guarded first-login settings merge for a missed browser.

## Phase 3 — retire Zerodha writer

1. Disable new Zerodha connections in the old UI.
2. If explicitly approved, run one final Zerodha sync while Firebase is still the
   sole writer. Record its completion time and counts.
3. Disable Zerodha postback and scheduled sync jobs.
4. Disable all connect/sync/reconcile/history UI actions.
5. Revoke Zerodha access and delete encrypted Zerodha credentials only after the
   final export is safely stored. Keep non-secret connection metadata if needed
   for audit.
6. Do not delete or relabel Zerodha trades. Open historical records become
   “Legacy open — no longer synchronized” and require manual closure/archive.

## Phase 4 — write freeze and final export

The cutover lead announces maintenance and records `freeze_started_at`.

1. Put the Firebase-hosted application into server-enforced read-only mode.
2. Stop/disable every Firebase scheduled writer, including cTrader and Zerodha.
   Inventory the fixed `edgebook-2dce2` project first, then explicitly
   disable/delete the listed legacy Functions and their Cloud Scheduler jobs.
   The archived implementation used the default `us-central1` region; record
   both `firebase functions:list --project edgebook-2dce2` and
   `gcloud scheduler jobs list --project edgebook-2dce2 --location us-central1`
   before and after removal. The legacy function names are listed in
   `archive/zerodha/README.md`; do not use a wildcard against another project.
   The repository's `firebase.json` intentionally has no deploy targets, so a
   normal source deploy cannot recreate them; rollback source remains on the
   pre-migration Git tag.
3. Run `deploy/vps/scripts/audit-firebase-writers.sh edgebook-2dce2`. It is
   read-only and must report no known Zerodha/cTrader HTTP or scheduled function
   and no matching Scheduler target. Also confirm no Firebase client write
   succeeds. Do not run these checks/actions against DeltaLens or another GCP
   project.
4. Confirm VPS `SCHEDULER_ENABLED=false` and `COMPOSE_PROFILES` is blank. Stop
   the Edge Book API container before final staging/promotion; do not stop any
   unrelated VPS service.
5. Wait for in-flight writes to finish and record the last Firebase update time.
6. Create the final Firebase/Auth/Storage export into a new directory.
7. Validate its manifest and checksums.
8. Re-run the Phase 2 exact-origin console export (or already available visible
   control) under the write freeze on every known browser/profile. Verify each
   downloaded SHA-256, expected authenticated Firebase UID, settings, moods and
   daily journal; consolidate without dropping local-only accounts, and
   reconcile per-profile entry/account counts. Absence of a known profile's file
   blocks cutover rather than relying on first login later.
9. Take a frozen backup of the old system/export and copy it to encrypted
   off-host storage.

If the freeze cannot be proven, abort and restore Firebase as sole writer before
continuing. Never “catch up later” from two active writers.

## Phase 5 — final staging, promotion and reconciliation

On the isolated VPS, run the commands in this phase through the profiled
`migration-tools` container described in `migration/README.md`; `postgres:5432`
is intentionally not reachable from the host. Inputs live under the container's
read-only `/migration-input`, outputs under `/migration-output`, and promotion
uses the exact `/srv/edgebook-data/uploads` mount. The service receives no
Google/session/cTrader or PostgreSQL superuser secret.

1. Dry-run the final bundle parser.
2. Set `EDGEBOOK_WRITES_FROZEN=true` only after Phase 4 is signed off.
3. Import the bundle to a new staging batch using
   `--apply --acknowledge SINGLE_WRITER_FROZEN`.
4. Dry-run and then run `migration/scripts/promote.mjs`; it takes an advisory
   transaction lock, verifies the staged manifest, maps identities/accounts,
   verifies every staged row hash, requires an empty target business-data set,
   preserves raw legacy JSON, and promotes deterministically into the reviewed
   application schema including the immutable Firebase archive table.
5. Copy screenshot objects to temporary object keys, validate checksums, then
   update promoted references. Do not remove Firebase objects.
6. With the API and worker still frozen, run `snapshot-target.mjs` under
   `flock /run/edgebook/maintenance.lock` so the cleanup timer cannot change a
   screenshot while it is hashed. Then run `reconcile.mjs` with the exact
   consolidated `--browser-local` file used by the promoter. The snapshot uses
   one repeatable-read, read-only transaction and must be written outside the
   private upload tree.
7. Require exact equality for:
   - every exported Firestore document path/payload checksum and Google `sub`;
   - Firebase trade document paths and stable IDs;
   - active and archived counts;
   - every projected business-field fingerprint, source/ingestion value and
     actual account/broker link;
   - counts by user, source and account;
   - earliest/latest dates and P&L aggregate;
   - screenshot reference, original-name and copied-object SHA-256 equality;
   - account/settings and pending-review counts.
   - merged browser/Firestore settings, every materialized account and broker
     mapping, and every browser-local mood/journal record.
8. Manually inspect representative manual, CSV, cTrader, active Zerodha,
   archived Zerodha, screenshot-rich, open and custom-field trades.

Any unexplained mismatch blocks cutover.

The browser's first-login settings merge is defense in depth, not a replacement
for this gate. It uses a separate `edgebook_vps_settings_migration_v2_*` marker,
applies the same reviewed precedence as the promoter, and writes that marker
only after a successful VPS settings save (or after proving there was no local
settings object). Do not approve cutover because that online fallback might run.

## Phase 6 — activate VPS

1. Start the API on loopback and create/link replacement identities. A failed
   identity match must show recovery, not an empty new account.
2. Build a separate `--mode cutover` public artifact. Verify
   `edgebook-build.json` says `firebaseDependency=false`, the app/index/landing
   HTML contain no fallback flag/loader/import or Firebase SDK origin, and
   `client/firebase-fallback.js` is absent from both source and `public/`.
   An API outage must fail closed. Switch the canonical `edgebook.trade` route;
   `www` must redirect to it.
3. Run local and public health checks, login, read-only journal, archive and image
   retrieval checks.
4. Record the canonical-route switch as `vps_writer_enabled_at`; verify a bounded
   test write. Firebase must already be frozen, so there is never a dual-writer
   interval.
5. In the protected environment set `COMPOSE_PROFILES=writer` and
   `SCHEDULER_ENABLED=true` only after Firebase writers are confirmed off. Keep
   the whole JSON keyring single-quoted in the systemd environment file. Pipe
   `docker compose --profile writer config --format json` directly into
   `deploy/vps/scripts/verify-rendered-worker-env.mjs`; never print or save the
   secret-bearing rendered model. Only after that redacted gate passes, start
   exactly one worker and verify its database advisory lock.
6. Keep Firebase UI and schedules read-only/off.
7. Require users to authorize cTrader fresh through official OAuth
   `scope=accounts`, then choose `ctidTraderAccountId`. Do not reuse legacy tokens.
8. Run a manual create/edit/archive/restore/upload/export test in a dedicated
   migration test account.
9. For a browser containing legacy settings, verify first login either reports
   already reconciled values or saves the deterministic merge, then writes its
   v2 completion marker. Confirm a simulated failed settings write does not set
   the marker. This is a post-cutover safety check, not permission to omit any
   Phase 2/4 offline export.
10. Record `vps_writer_enabled_at`, scheduler owner, deployed release and DB schema.

## Observation window

Monitor closely for at least 24 hours, then through the rollback window:

- API/DB readiness, latency and error rate;
- failed writes and authentication/account-link failures;
- scheduler lease ownership and duplicate imports;
- disk/upload quota, pending uploads and missing objects;
- P&L/source/account aggregate drift;
- backups and one staged restore;
- unrelated VPS services, especially the existing port-8787 process.

The retained Firebase data/export remains read-only for rollback evidence, but
the VPS public artifact contains no Firebase SDK/fallback module. Do not deploy
code that writes back to Firebase.

## Rollback

### Safe fast rollback before any VPS production write

1. Freeze VPS API and scheduler.
2. Confirm no production writes occurred after `vps_writer_enabled_at`.
3. Point the frontend/API back to the retained Firebase release.
4. Re-enable Firebase client writes.
5. Acquire/enable exactly one Firebase scheduler owner.
6. Verify counts and record rollback completion.

### Rollback after VPS production writes

Do **not** simply re-enable Firebase; that would discard or fork new records.

1. Freeze VPS API and scheduler and keep Firebase frozen.
2. Export all VPS changes since cutover with stable IDs and audit timestamps.
3. Reconcile them against the final Firebase baseline.
4. Choose one authoritative recovery path:
   - repair/roll forward on VPS; or
   - perform a reviewed reverse migration into a new Firebase dataset.
5. Reconcile again before enabling exactly one writer/scheduler.

Restoring a VPS backup uses `restore-edgebook.sh` into a new empty database and
new `/srv/edgebook-data/restore/...` directory. Validate it, then perform a
separately approved connection/pointer swap. Never restore over live paths.

## Firebase decommission gate

After the 30–90 day window, decommission only when:

- every identity is linked or explicitly resolved;
- final reconciliation and current aggregates are clean;
- all screenshots are copied and verified;
- browser-local settings/journals/moods from every known profile are migrated
  and reconciled (or an explicitly identified user accepted documented loss);
- at least two successful backups and one restore test exist;
- cTrader users completed fresh OAuth and only one scheduler owner is observed;
- no rollback incident remains open;
- retention/deletion approval is recorded.

Functions and schedules must already be disabled/deleted before VPS activation,
and the VPS artifact must already omit the Firebase SDK/fallback. After the
window, remove any remaining legacy rules/hosting/project resources in separate
reviewed changes. Preserve the encrypted final export for the approved retention
period and record when it is securely destroyed.
