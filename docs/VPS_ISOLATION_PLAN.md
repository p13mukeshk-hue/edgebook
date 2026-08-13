# Existing-VPS isolation plan

## Objective

Run Edge Book on the existing VPS without changing or depending on its host
Node.js 20.20.2, host PostgreSQL 16.14, or unrelated public listener on
`*:8787`. Edge Book receives a dedicated container/network/data boundary and a
single host-loopback ingress consumed by the existing Nginx installation.

This plan does not authorize a live deployment, DNS change, Nginx reload, or
service restart. DeltaLens and every independent Zerodha system—including
credentials, webhooks, databases, processes and schedulers—are explicit
no-touch boundaries.

## Boundary map

```text
Internet
   |
host Nginx :443
   |
127.0.0.1:3210 only
   |
Edge Book API container (Node 22, non-root UID 12001, internal port 3210)
   |                         \
private database network     outbound HTTPS for approved OAuth/API calls
   |
dedicated PostgreSQL 16 container (no host port)

/srv/edgebook-data/uploads -> API bind mount only
Nginx has no upload alias; downloads pass through authenticated API checks
```

## Non-interference guarantees

- Do not install, upgrade, replace, or change alternatives for host Node.js.
- Do not edit host PostgreSQL `listen_addresses`, `pg_hba.conf`, roles, databases,
  extensions, service unit, or data directory.
- Do not bind Edge Book to port 8787. Preflight must prove port 3210 is free or
  already owned by the Edge Book Compose API service.
- Do not stop, restart, inspect secrets for, share a database with, or modify
  DeltaLens or any independent Zerodha deployment.
- PostgreSQL is reachable only by the private `edgebook-database` Compose network.
- API publication is exactly `127.0.0.1:3210:3210`; a wildcard host bind fails
  deployment review.
- Install a new Nginx server block rather than replacing a global configuration.
- Releases are immutable; switch `/opt/edgebook/current` atomically only after
  image build, migration rehearsal, and health checks.

## Container isolation

The API image is based on Node.js 22 and runs as UID/GID 12001 with:

- read-only root filesystem;
- all Linux capabilities dropped;
- `no-new-privileges`;
- 768 MiB memory limit, 256 MiB reservation, 0.75 CPU limit, 192 PID limit;
- bounded Docker JSON logs;
- a 64 MiB no-exec temporary filesystem;
- only the private upload directory writable.

PostgreSQL has its own named volume, private network, health check, bounded logs,
1 GiB memory, 0.75 CPU, 256 PID and 256 MiB shared memory limits. The profiled
cTrader worker is capped at 384 MiB/0.35 CPU. Tune these only
after measuring both Edge Book and neighboring services; never consume all VPS
memory or CPUs.

## Network policy

- Public: Nginx 80/443 only.
- Host local: Edge Book API 127.0.0.1:3210.
- Container private: PostgreSQL 5432 with no published port.
- API outbound: HTTPS required for official cTrader OAuth/API and other explicitly
  approved services.
- Health/readiness endpoints remain host-local; Nginx returns 404 for them.
- `/uploads/` is never a static path. The API authenticates user, validates object
  ownership, applies download headers, and streams the file.

## Database isolation

The official PostgreSQL image initializes a private `edgebook` database. Secrets
live only in root-owned `/etc/edgebook/edgebook.env`.

- `postgres`: container bootstrap/backup administrator, never exposed to API.
- `edgebook_owner`: non-superuser schema migration role.
- `edgebook_app`: non-superuser runtime role with only default DML grants.
- `edgebook_migration`: raw staging schema, inaccessible to runtime.

Application migrations run as owner in an explicit one-shot operator command.
The web runtime uses `edgebook_app`. No database connection string appears in
systemd, Nginx, the repository, image layers, logs, or browser responses.
The migration image contains `server/migrations/`, and the normal Compose start
does not run it; operators invoke the `tools` profile explicitly.

## Private upload volume and quota plan

Use `/srv/edgebook-data` as a dedicated LV/dataset when feasible. Mount with
`nodev,nosuid,noexec`; enable encryption at the block/storage layer. The
`uploads` directory is mode `0750` and owned by numeric UID/GID 12001.

Enforce all of the following in the API before accepting a file:

1. Authenticated user and CSRF/origin checks.
2. Request/body size limit before buffering.
3. Decoded image validation, MIME allowlist and rejection of polyglot content.
4. Maximum 5 MiB per processed file and 5 files per trade.
5. Transactional per-user quota reservation, initially 500 MiB.
6. Random server object key; original name is metadata only.
7. Write to a temporary name, fsync/close, atomic rename, then database commit.
8. If DB commit fails, enqueue orphan cleanup; if file write fails, roll quota back.
9. Soft-deleting a trade does not delete screenshots during the rollback window.
10. Permanent deletion writes an audit event and uses delayed garbage collection.

Alert at 70%, 85%, and 95% volume utilization. Stop accepting uploads before the
filesystem is full while continuing to allow journals/trades and exports.

## Scheduler isolation

Only the replacement VPS may schedule cTrader sync after cutover. Requirements:

- official OAuth `scope=accounts` only;
- fresh user authorization; no migration of legacy tokens;
- account selection by `ctidTraderAccountId`;
- `SCHEDULER_ENABLED=false` until Firebase jobs are disabled;
- the `writer` Compose profile absent until the final handoff, because a worker
  with scheduling disabled can still process manually queued work;
- one scheduler owner enforced by a PostgreSQL advisory lock or expiring lease;
- idempotency keys for imported deals and immutable source IDs;
- loss of the lease stops scheduling, rather than allowing two writers.

## Operational checks

Before first start and every port/config change:

1. Run `deploy/vps/scripts/preflight.sh`.
   It enforces a 10 GiB absolute free-space floor on `/srv` and the Docker data
   filesystem. Below 15 GiB it warns that cleanup should be planned, but the free
   percentage is informational and does not stop deployment. The 10 GiB hard
   floor cannot be lowered through environment overrides. No automatic
   cache/image prune is authorized.
2. Render `docker compose config` from the protected env file and verify the API
   port begins with `127.0.0.1:3210` and PostgreSQL has no published port.
3. Build the image without changing host Node.
4. Run schema migrations against the container DB only.
5. Start the stack; check container health and host-local health/readiness.
6. Run `nginx -t`, then reload only Nginx.
7. Verify the unrelated port-8787 service and other VPS sites remain healthy.
8. Verify CPU, memory, disk, Docker log size and upload quota telemetry.

Items that build, start, migrate, reload, or route traffic require a separate
approved deployment window. The templates themselves make no live change.

## Failure containment

- API failure does not expose PostgreSQL or uploads.
- PostgreSQL failure makes readiness fail; Nginx returns a bounded upstream error.
- Upload exhaustion rejects new uploads before affecting DB writes.
- Backup failure leaves only a hidden `.partial-*` directory and never replaces a
  completed bundle.
- A failed release is rolled back by restoring the previous current symlink/image
  while preserving the data version rules in the cutover runbook.
