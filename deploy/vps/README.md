# Edge Book VPS deployment templates

These files are deployment **templates**. They do not install packages, change the
VPS, start containers, reload Nginx, or touch the existing Firebase deployment.
Run the commands in this document only during an approved deployment window.

This package does **not** authorize a live DNS switch, Nginx installation/reload,
systemd enable/start, or VPS mutation. DeltaLens, its public `*:8787` listener,
and any independent Zerodha service, account, credentials, webhook, or scheduler
remain untouched. They are not Edge Book migration targets.

The design deliberately leaves the VPS's existing Node.js 20.20.2,
PostgreSQL 16.14, and unrelated service already listening on `*:8787` alone.
Edge Book runs in isolated Node.js 22 and PostgreSQL 16 containers. The only
published application port is `127.0.0.1:3210`; PostgreSQL has no host port.

## Files

- `docker-compose.yml` — isolated API, worker, cleanup job and PostgreSQL containers.
- `Dockerfile.api` — Node.js 22 API image; runs `server/dist/main.js`.
- `Dockerfile.migration` — profile-gated Node.js 22 data-migration image.
- `scripts/build-public.sh` — creates an allowlisted, VPS-only static `public/` directory.
- `nginx/edgebook.conf` — host Nginx TLS virtual host and reverse proxy.
- `systemd/edgebook-stack.service` — owns the Compose stack.
- `systemd/edgebook-backup.{service,timer}` — bounded nightly backup job.
- `systemd/edgebook-cleanup.{service,timer}` — bounded private-file deletion queue drain.
- `postgres/init/001-bootstrap.sh` — first-volume database role hardening.
- `tmpfiles.d/edgebook.conf` — private host directories and fixed container UID.
- `env/*.example` — variable names only; never commit populated copies.
- `scripts/` — read-only preflight plus backup, verification, and safe staged restore.

## Intended filesystem layout

```text
/opt/edgebook/releases/<release-id>/   immutable checked-out release
/opt/edgebook/current -> releases/...  atomic release symlink
/etc/edgebook/edgebook.env             root-readable runtime secrets (0600)
/etc/edgebook/backup.env               root-readable backup settings (0600)
/srv/edgebook-data/uploads/            private uploads, never served by Nginx
/srv/edgebook-migration/input/         read-only-in-container final export inputs
/srv/edgebook-migration/output/        new snapshot/reconciliation outputs
/var/backups/edgebook/                  private local backup landing zone
```

Only a curated static `public/` directory should be mounted into Nginx or copied
to its document root. Never configure Nginx with the repository root: it contains
server code, migration utilities, and deployment material.

## Operator preparation

1. Review [the isolation plan](../../docs/VPS_ISOLATION_PLAN.md) and the
   [cutover runbook](../../docs/FIREBASE_TO_VPS_RUNBOOK.md).
2. Verify the release preserved executable mode `0755` (Git mode `100755`) for
   every `deploy/vps/scripts/*.sh` and `deploy/vps/postgres/init/*.sh` file.
   ZIP/TAR transfer from Windows can lose that bit; if so, compare the files to
   the reviewed release and explicitly `chmod 0755` only those exact scripts
   before systemd or direct execution. The CI release gate rejects a Git tree
   whose script modes are not executable.
3. Run the read-only preflight script from the release:

   ```sh
   sudo ./deploy/vps/scripts/preflight.sh
   ```

   It must report `127.0.0.1:3210` as unused. Do not stop or replace the process
   on `*:8787`; it is outside the Edge Book deployment.
   The preflight also requires at least 10 GiB and 15% free space on both the
   Edge Book data filesystem and Docker filesystem. A reviewed operator may raise
   these floors; lowering them requires capacity approval.

   The observed VPS root is currently about 81% used with roughly 19 GiB free.
   The reviewed 15% plus 10 GiB floors leave the current host eligible only while
   both limits pass; preflight cannot lower either below these values. Recheck
   after image build and before every release/backup. No automatic Docker prune
   or deletion is part of this deployment.
4. Create the directories using the reviewed `tmpfiles.d/edgebook.conf` template,
   or create equivalent paths manually. This includes `/run/edgebook`, used only
   for the shared backup/cleanup lock and recreated at boot. The API container
   uses UID/GID `12001`.
5. Copy `env/edgebook.env.example` to `/etc/edgebook/edgebook.env`, fill values
   directly on the VPS, and set mode `0600`. Generate fresh random secrets; do
   not reuse Firebase or legacy cTrader tokens.
6. Official OAuth with `scope=accounts` remains the preferred cTrader connection.
   The optional `CTRADER_MCP_ENABLED=true` compatibility path lets a user paste
   a fresh per-account Remote MCP configuration in the authenticated dashboard;
   the server encrypts it immediately and exposes only a fixed read-tool
   allowlist. Remote MCP tokens are session-bound and provider-trading-capable,
   so the UI requires an explicit acknowledgement and reconnection may be
   needed. Legacy Firebase tokens are never migrated or reused. Generate a fresh
   versioned `CTRADER_ENCRYPTION_KEYS` keyring. In the systemd environment file,
   single-quote the entire JSON value, for example
   `CTRADER_ENCRYPTION_KEYS='{"1":"<43-character-base64url-key>"}'`, so its
   inner quotes survive both systemd and Compose parsing. For credentialless loopback staging,
   leave OAuth credentials, the keyring pair, and MCP flag blank/false; the API
   then reports cTrader disabled. The encryption keyring pair is required for
   either connection method; the OAuth client/secret/redirect trio is required
   only for OAuth. The profiled worker requires encryption plus at least one
   enabled connection method.
7. Build a static public directory inside the immutable release. This copies only
   the four HTML entry files and three VPS browser adapters; it never exposes the
   repository root. Source and artifact both omit the Firebase fallback flag,
   loader, SDK and `client/firebase-fallback.js`; the builder copies the reviewed
   source directly and rejects any reintroduced runtime reference. A failed API
   therefore fails closed instead of selecting another writer:

   ```sh
   ./deploy/vps/scripts/build-public.sh \
     --mode rehearsal \
     --destination /opt/edgebook/releases/<release-id>/public
   ```

8. Build the image from the repository root:

   ```sh
   docker compose \
     --project-directory /opt/edgebook/current \
     --env-file /etc/edgebook/edgebook.env \
     -f /opt/edgebook/current/deploy/vps/docker-compose.yml \
     build --pull api migration-tools
   ```

9. On a brand-new PostgreSQL volume, `postgres/init/001-bootstrap.sh` runs once.
   Start only `postgres` and wait for it before the first migration. On an
   existing volume the bootstrap does not rerun; apply reviewed database changes
   with an explicit migration instead. Do not start the API until application
   migrations pass, because its `/readyz` healthcheck intentionally rejects an
   incomplete schema.
10. Run application schema migrations through the explicit tools profile using
   `MIGRATION_DATABASE_URL`, which must authenticate `edgebook_owner` at the
   private hostname `postgres:5432`:

   ```sh
   docker compose \
     --project-directory /opt/edgebook/current \
     --env-file /etc/edgebook/edgebook.env \
     -f /opt/edgebook/current/deploy/vps/docker-compose.yml \
     --profile tools run --rm migrate
   ```

   The API `DATABASE_URL` must authenticate `edgebook_app` at `postgres:5432`.
   Neither URL may resolve the host PostgreSQL service.
   Compose explicitly passes the API allowlist of runtime variables; it does not
   inject the env file wholesale. Therefore the API never receives the PostgreSQL
   superuser password, owner password, or `MIGRATION_DATABASE_URL`. The migrator
   receives only the owner URL and a two-connection pool limit: it receives no
   superuser password, Google/session/upload secret, or broker credential.
   The screenshot cleanup job similarly receives only the runtime DB URL,
   private upload path and storage-policy limits; it receives no auth or broker
   secret.
   Firebase data staging/promotion uses a different, separately profiled
   `migration-tools` image. It receives only the owner URL/write-freeze gate,
   read-only `/migration-input`, writable `/migration-output`, and the exact
   private upload tree. It has no host port, auth/session or broker secret, and
   PostgreSQL remains unpublished. Exact invocations are in `migration/README.md`.
11. Install the systemd and Nginx templates only after obtaining a certificate
   covering both `edgebook.trade` and `www.edgebook.trade`. Always run `nginx -t`
   before reloading Nginx. The enforced cutover CSP permits the current Google
   sign-in, Google Fonts, cdnjs Chart.js/Font Awesome, Frankfurter FX, cTrader
   icon and Google avatar origins; it intentionally blocks Firebase and legacy
   Cloud Functions. Smoke-test Google sign-in, charts, fonts, avatars, FX rates
   and SSE in the browser console before switching the canonical route.

Steps 4–11 are future operator instructions, not actions performed by this
repository change. Production routing remains unchanged until a separate
cutover approval.

## Single-writer rule

Exactly one system may write trades or run cTrader scheduling at a time:

- before cutover: Firebase is the writer, `COMPOSE_PROFILES` is blank and the VPS
  worker is not running; any VPS rehearsal artifact is still VPS-only and cannot
  fall back into Firebase writes;
- during final import: both application writers are stopped/read-only;
- after cutover: all Firebase schedules/writes are disabled, the cutover static
  artifact has `firebaseDependency=false` and no fallback flag/module,
  `COMPOSE_PROFILES=writer`, and
  exactly one VPS worker runs with `SCHEDULER_ENABLED=true`.

The worker holds a session advisory lock and per-connection locks. The Compose
profile is an additional cutover gate: with the profile blank, the worker cannot
process even manually queued or initial syncs.

Before activation, render and validate the protected Compose configuration
without writing or printing its secret-bearing JSON:

```sh
sudo docker compose \
  --project-directory /opt/edgebook/current \
  --env-file /etc/edgebook/edgebook.env \
  -f /opt/edgebook/current/deploy/vps/docker-compose.yml \
  --profile writer config --format json \
  | sudo node /opt/edgebook/current/deploy/vps/scripts/verify-rendered-worker-env.mjs
```

The command reports only a redacted pass/fail result. It checks the canonical
callback, complete keyring, active key version, `SCHEDULER_ENABLED=true`, matching
API/worker cTrader settings, and `SCHEDULER_ENABLED=false` on the web process.

## Health checks

The API listens inside the container on `0.0.0.0:3210`, published only as
`127.0.0.1:3210` on the host. Check it locally:

```sh
curl --fail --silent http://127.0.0.1:3210/healthz
curl --fail --silent http://127.0.0.1:3210/readyz
```

The public Nginx template intentionally does not expose these endpoints. Its
`/api/` location includes `/api/config` and `/api/auth/*`.

## PostgreSQL bootstrap model

The Compose environment creates the dedicated `edgebook` database inside its
private container. The init script creates:

- `edgebook_owner`: schema owner/migration role, never used by the web runtime;
- `edgebook_app`: least-privilege runtime role;
- private `edgebook` and `public` schema defaults with no public CREATE access.

All PostgreSQL passwords exist only in `/etc/edgebook/edgebook.env`. PostgreSQL
is reachable only over the private Compose network and has no `ports:` mapping.

## Upload storage and quotas

`/srv/edgebook-data/uploads` is mounted at `/var/lib/edgebook/uploads` in the API
container. It is outside the static web root and must be downloaded only through
an authenticated API route that checks ownership.

Recommended initial application limits:

- 5 MiB per uploaded image after server-side validation;
- 5 screenshots per trade;
- 500 MiB total per user, configurable through the environment;
- image MIME allowlist plus decoded-image verification;
- random object keys, original filename stored only as metadata;
- reject rather than silently embedding base64 when quota/storage is unavailable.

For hard filesystem containment, mount a dedicated XFS/ext4 logical volume at
`/srv/edgebook-data` with `nodev,nosuid,noexec`. Prefer an LV or dataset whose
size can be expanded independently. Application per-user quotas remain required
even when a filesystem-level project quota is enabled.

## Backups

The backup timer briefly stops only the Edge Book API/worker processes that were
already running, then creates a PostgreSQL custom dump and private-upload archive
under one write quiesce. A trap restarts only those Edge Book processes. It never
touches unrelated services and performs no automatic retention deletion. The
shared maintenance lock prevents screenshot cleanup from racing the archive.
Before accepting the bundle it inventories every live `file_objects` row and
checks the host file and the archived member against the database SHA-256; a
missing, unsafe, symlinked or mismatched private file fails the backup.
Move completed bundles to encrypted off-host storage and apply retention there.

Verification can require `writes_frozen=true`, and restore always does. Test
restores into a separate database and
separate `/srv/edgebook-data/restore/...` directory; never restore over the live
database or upload tree.
