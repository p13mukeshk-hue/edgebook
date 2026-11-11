# Firebase to VPS migration toolkit

These utilities are deliberately separate from application code. They never
modify Firebase. The exporter and validator are read-only. The staging importer
is dry-run by default and can write only to the append-only
`edgebook_migration` PostgreSQL schema after two explicit write-freeze gates.
`promote.mjs` then maps the staged bundle deterministically into the schema in
the application schema. Migration `900_legacy_firebase_archive.sql` retains a
redacted immutable envelope/hash for every source document, including uncommon
legacy collections without a first-class feature table.

## Security rules

- Use Application Default Credentials from a protected operator environment.
  Never copy a service-account JSON key into this repository or an export bundle.
- Export directories are created with mode `0700`; files use `0600`.
- Credential field names are normalized across camel/snake/kebab/case variants
  and redacted from every exported user document. Firebase pending OAuth state
  is never exported.
- Legacy cTrader tokens are never migrated. The replacement uses fresh official
  cTrader OAuth authorization with read-only `scope=accounts`, followed by user
  account selection using `ctidTraderAccountId`.
- Export bundles contain private financial and image data. Encrypt them at rest
  and in transit, restrict operator access, and record deletion/retention.
- Never run a promotion while either Firebase or the VPS application can write.

## Bundle contents

```text
manifest.json          format, scope, counts, checksums, redaction policy
auth-users.ndjson      safe identity-linking metadata; no password hashes
firestore.ndjson       recursive users/* documents with Firestore types tagged
storage.ndjson         copied screenshot metadata and checksums
storage/users/...      screenshot objects when --download-storage is used
```

The Firestore traversal includes active and soft-deleted trades, settings,
broker metadata with credentials removed, orders, order updates, notifications,
and pending duplicate records below each user. It excludes `pendingAuth` and
shared caches that should be regenerated.

## Install tools in isolation

Use Node.js 22 in a disposable operator container or workstation, not the VPS's
host Node.js installation:

```sh
cd migration
npm ci
npm test
```

The repository intentionally does not contain credentials or populated `.env`
files.

### Running database tools on the isolated VPS

PostgreSQL is deliberately not published on a host port, so do not run the
database-writing commands with the VPS host Node.js or expose port 5432. Copy the
validated export directory and consolidated browser file into
`/srv/edgebook-migration/input/`, owned by numeric UID/GID `12001`, then use the
profile-gated `migration-tools` container on the private Compose network. Its
input mount is read-only; new snapshots/reports go under `/migration-output`.

The common invocation prefix is:

```sh
sudo docker compose \
  --project-directory /opt/edgebook/current \
  --env-file /etc/edgebook/edgebook.env \
  -f /opt/edgebook/current/deploy/vps/docker-compose.yml \
  --profile migration run --rm --no-deps migration-tools
```

Append the Node entry script and arguments to that prefix. For example, after
`postgres` is healthy, create/verify the append-only staging schema with:

```sh
sudo docker compose \
  --project-directory /opt/edgebook/current \
  --env-file /etc/edgebook/edgebook.env \
  -f /opt/edgebook/current/deploy/vps/docker-compose.yml \
  --profile migration run --rm --no-deps migration-tools \
  scripts/apply-staging-schema.mjs
```

For a cutover `import-staging.mjs` or `promote.mjs` apply, invoke Compose as
`sudo env EDGEBOOK_WRITES_FROZEN=true docker compose ...`; the container rejects
apply unless that value and the explicit `SINGLE_WRITER_FROZEN` acknowledgement
are both present. Never use `docker compose config --environment`, because it
prints secrets.

## Read-only Firebase export

Create a protected parent directory and authenticate using your organization's
approved ADC workflow. Then:

```sh
node scripts/export-firebase.mjs \
  --project-id edgebook-2dce2 \
  --storage-bucket edgebook-2dce2.firebasestorage.app \
  --download-storage \
  --output /secure/edgebook-export-YYYYMMDDTHHMMSSZ
```

Use `--uid <firebase-uid>` for a rehearsal with one account. The output path
must be absolute and must not already exist. The script does not change
Firestore, Auth, Storage, Functions, schedules, or hosting.

Validate immediately and again after every copy:

```sh
node scripts/validate-bundle.mjs \
  --bundle /secure/edgebook-export-YYYYMMDDTHHMMSSZ
```

## PostgreSQL staging

Apply `postgres/staging-schema.sql` once using the restricted migration/owner
connection. On the VPS use the `scripts/apply-staging-schema.mjs` container
invocation above. The runtime role must not receive access to this schema.

Dry-run parses and validates without opening a database connection:

```sh
node scripts/import-staging.mjs \
  --bundle /secure/edgebook-export-YYYYMMDDTHHMMSSZ
```

Only after the runbook's single-writer freeze:

```sh
EDGEBOOK_WRITES_FROZEN=true \
MIGRATION_DATABASE_URL='<provided securely by the operator>' \
node scripts/import-staging.mjs \
  --bundle /secure/edgebook-export-YYYYMMDDTHHMMSSZ \
  --apply --acknowledge SINGLE_WRITER_FROZEN
```

The command stores raw source envelopes and hashes. It does not alter application
users/trades/settings or mark a batch promoted.

## Deterministic promotion

Dry-run builds the complete relational/file plan without opening PostgreSQL or
writing uploads:

```sh
node scripts/promote.mjs \
  --bundle /secure/edgebook-export-YYYYMMDDTHHMMSSZ \
  --browser-local /secure/browser-local.json
```

After the staged batch and write freeze are independently verified:

```sh
EDGEBOOK_WRITES_FROZEN=true \
MIGRATION_DATABASE_URL='<edgebook_owner URL supplied securely>' \
node scripts/promote.mjs \
  --bundle /secure/edgebook-export-YYYYMMDDTHHMMSSZ \
  --batch-id '<staged batch UUID>' \
  --upload-root /srv/edgebook-data/uploads \
  --browser-local /secure/browser-local.json \
  --apply --acknowledge SINGLE_WRITER_FROZEN
```

The promoter runs under a PostgreSQL advisory transaction lock, verifies the
staged manifest and every staged row hash, maps/link-checks identities, creates
deterministic UUIDs,
disconnects all migrated broker metadata, inserts with legacy uniqueness keys,
and marks the batch promoted only in the same successful transaction.

The target may contain a Google-login user/session/audit row created during a
loopback rehearsal. It must not contain business data. Empty `{}` settings are
replaced by the Firebase source; any non-empty settings or other target data
blocks promotion for an explicit merge review. Conflict handlers never silently
choose a pre-existing VPS account/trade/notification over Firebase.

A cutover apply requires the consolidated `--browser-local` export. Firestore
settings and browser-local settings are merged deterministically: Firestore wins
ordinary and nested preference keys, the account copy with the newer `updatedAt`
wins, local-only accounts are retained, and the browser-local broker-account map
wins. Duplicate or missing account IDs block promotion. The merged accounts are
materialized into `accounts`; the unmodified local settings copy remains in the
user's protected legacy archive for audit.

It preserves:

- `legacy_firebase_uid` on the new user identity;
- the full Firestore document path as `legacy_path`;
- trade document ID, `brokerTradeId`, source/broker provenance, soft-delete state,
  timestamps, account mapping, review flags, lot/grouping fields, user notes,
  screenshots, psychology, tags, and custom fields;
- immutable original-source metadata even when a screenshot URL is rewritten;
- archived Zerodha records as historical data, never relabeled as Manual;
- Zerodha CSV imports as distinct `sourceSystem=zerodha` and
  `ingestionMethod=csv` when supported after cutover.

Embedded image data URLs and checksummed Firebase Storage downloads are copied to
deterministic private object keys. Existing objects are accepted only when their
SHA-256 matches. Unknown external/missing/unsupported screenshot data blocks the
promotion. Exported Storage objects with no trade reference also block for a
reviewed disposition rather than being silently dropped. When those objects
are confirmed abandoned uploads or belong only to raw-only corrupt trade
records, preserve the checksum-verified source bundle in protected backup
storage and pass `--unreferenced-storage archive`; the promotion report records
every archive-only object name. They are not exposed as live trade files or
deleted from the source bundle. A database rollback
may leave checksum-addressed orphan files, which
are safe for an idempotent retry and must be inventoried before cleanup.

Every image is decoded and re-encoded through patched Sharp/libvips before it is
planned. The default 5 MiB input/output, 40-megapixel, five-per-trade, 500 MiB
per-user, 10 GiB total, and 10 GiB free-space policies match the reviewed VPS
environment. The promoter reports planned bytes, holds no full-export image set
in memory, rechecks source and processed hashes immediately before each write,
and refuses to lower the 10 GiB disk floor.

Keep raw staged records until the rollback window closes. The promoter does not
copy old broker credentials; all migrated connections are disconnected.

## Target snapshot and reconciliation

After promotion, generate the target snapshot directly from PostgreSQL while
holding the shared maintenance lock. The API/worker must already be frozen, and
the lock prevents the cleanup timer from changing private files while their
database rows and SHA-256 values are read:

```sh
sudo flock /run/edgebook/maintenance.lock \
  env TARGET_DATABASE_URL='<read-only target URL supplied securely>' \
  node scripts/snapshot-target.mjs \
    --upload-root /srv/edgebook-data/uploads \
    --output /secure/edgebook-target-snapshot.ndjson
```

It emits typed NDJSON records for projected trades, every immutable raw document
hash, and every Firebase-UID-to-Google-`sub` identity link. A trade record has
this neutral shape:

```json
{"recordType":"trade","legacyPath":"users/FIREBASE_UID/trades/DOCUMENT_ID","data":{"symbol":"NIFTY","date":"2026-08-08"},"mapped":{"files":[]}}
```

`data` reconstructs every projected Edge Book trade field from the actual
database columns, including provenance, ingestion mode, account/broker links,
soft-delete state, times, prices, review flags, tags, psychology and custom
fields. The query uses one repeatable-read, read-only database transaction. The
snapshotter opens every private file below the non-symlink upload root and
refuses missing files, unsafe paths, symlinks, or a filesystem-vs-database
checksum mismatch.
Screenshot URLs may change; reconciliation compares count, original name and
the actual file SHA-256 rather than URL.
It also requires exact raw-document hashes and Google immutable IDs. Run:

```sh
node scripts/reconcile.mjs \
  --source-bundle /secure/edgebook-export-YYYYMMDDTHHMMSSZ \
  --browser-local /secure/browser-local.json \
  --target /secure/edgebook-target-snapshot.ndjson \
  --report /secure/edgebook-reconciliation.json
```

The command exits non-zero for missing, extra, or changed trade fingerprints,
file checksums, raw documents, identity links, merged settings, materialized
accounts, disconnected broker mappings, browser-local moods/journals or
aggregate mismatches. Notification, order and pending-duplicate source envelopes
are covered by immutable raw-document hashes, and reconciliation also requires
one corresponding relational row for each of those application collections.

## Browser-local data gap

Daily Journal and Mood Tracker records currently live in each browser's
`localStorage`, not Firebase. A Firebase export cannot contain them. Before
decommissioning the old app, every browser/profile used for Edge Book must open
an authenticated migration page that exports and uploads these keys:

- `tradedesk_dailyjournal_<firebaseUid>`
- `tradedesk_moods_<firebaseUid>`
- `tradedesk_settings_<firebaseUid>` as a required merge input

Do not clear old browser storage until the user sees matching entry counts and
has downloaded the full portable backup. The final promoter refuses to apply
without the consolidated file, even when a user has no moods or journals.

The deployed legacy build can be exported without changing or redeploying it:
review `browser/export-local-data.js`, then paste the entire utility into
DevTools Console while signed in at exactly `https://edgebook.trade` or
`https://www.edgebook.trade`. It takes the UID from the existing Firebase Auth
session, reads only the three UID-scoped localStorage keys, rejects
credential-like fields/URLs, performs no network or localStorage write, and
shows counts plus the exact downloaded-file SHA-256 before enabling download.
Record and independently verify that checksum. Never run it on another origin.

The authenticated VPS app also performs a one-time, versioned first-login merge
when it finds `tradedesk_settings_<firebaseUid>` in that browser. It uses the
same precedence as this promoter and writes its completion marker only after a
successful VPS settings save. This is defense in depth for a missed profile; it
does not make the browser data available to the offline promoter or reconciler,
and must never be used to waive the pre-freeze export requirement.

The promoter accepts the consolidated client export in this shape (unknown entry
fields are preserved):

```json
{
  "users": {
    "FIREBASE_UID": {
      "moods": [],
      "dailyJournal": { "2026-08-08": {} },
      "settings": {}
    }
  }
}
```
