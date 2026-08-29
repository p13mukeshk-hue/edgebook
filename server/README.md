# Edgebook server

Self-hosted Edgebook API foundation for Node.js 22 and PostgreSQL. It is a same-origin Fastify modular monolith with a separate PostgreSQL-backed event stream and filesystem-backed private screenshot store.

This directory is intentionally isolated from the current Firebase frontend and Cloud Functions. It contains no production credentials and does not connect to Firebase.

## Included

- Google Identity Services ID-token verification
- Opaque, HMAC-hashed database sessions
- Secure session cookie plus double-submit, server-verified CSRF token
- Per-user trade, settings, mood, daily-journal and notification APIs
- Stable Firebase-era IDs alongside internal UUIDs
- Private validated screenshot upload/download/delete
- Per-trade, per-user and total storage limits plus disk-free floor
- Durable deletion queue for failed filesystem cleanup
- PostgreSQL-backed, replayable Server-Sent Events
- Liveness and database/storage readiness endpoints
- Versioned SQL migration runner
- Graceful shutdown, rate limits, security headers and log redaction
- Official cTrader OAuth with view-only `accounts` scope
- Opt-in compatibility with an existing cTrader Remote MCP configuration
- Encrypted, rotating cTrader tokens and a durable PostgreSQL sync queue
- Full-history, lossless deal ingestion and idempotent position projection
- Automatic/manual sync worker with single-writer locks and stale-job recovery
- Unit and HTTP contract tests

The cTrader integration exposes no order placement, modification, or position-close primitive. It imports only authorized account metadata and historical deals. Remote MCP credentials are nevertheless trading-capable and session-bound at cTrader, so compatibility mode is disabled by default, requires an explicit user acknowledgement, calls a closed read-tool allowlist, and stores only an AES-GCM-encrypted bearer token. Zerodha is not part of this server.

## Local setup

Requirements:

- Node.js 22+
- PostgreSQL
- An empty database and role owned by the developer
- A Google OAuth web client configured for the local browser origin

```powershell
Copy-Item .env.example .env
npm.cmd install
node --env-file=.env node_modules/tsx/dist/cli.mjs src/db/migrate.ts
node --env-file=.env node_modules/tsx/dist/cli.mjs watch src/main.ts
```

The default listener is `127.0.0.1:3210`. The application does not load `.env` itself; production supervisors and local commands must inject environment variables explicitly.

Useful commands:

```text
npm run typecheck
npm test
npm run build
npm run check
npm run db:migrate
npm run storage:cleanup
npm run ctrader:worker
```

`db:migrate` and `storage:cleanup` require the environment to already be loaded. In production, use `node dist/db/migrate.js` and `node dist/uploads/cleanup.js` through the provided npm scripts. The migration command intentionally parses only `DATABASE_URL`/`DB_POOL_MAX`; cleanup parses only those plus the upload/storage settings, so neither one-shot tool needs Google, session, or cTrader secrets.

## Environment variables

| Variable | Required/default | Purpose |
|---|---:|---|
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `HOST` | `127.0.0.1` | Bind address; keep loopback behind the reverse proxy |
| `PORT` | `3210` | HTTP listener |
| `LOG_LEVEL` | `info` | Pino log level |
| `TRUST_PROXY` | `false` | Set `true` only behind the controlled reverse proxy |
| `PUBLIC_ORIGIN` | required | Exact browser origin; must be HTTPS in production |
| `DATABASE_URL` | required | PostgreSQL connection string |
| `DB_POOL_MAX` | `10` | API database pool limit |
| `GOOGLE_CLIENT_ID` | required | Public Google web client ID returned by `/api/config` |
| `SESSION_PEPPER` | required, 32+ chars | Secret HMAC pepper for session and CSRF hashes |
| `SESSION_TTL_DAYS` | `14` | Absolute session lifetime |
| `SESSION_IDLE_MINUTES` | `1440` | Idle-session lifetime, capped by absolute lifetime |
| `COOKIE_SECURE` | `true` | Must remain true in production |
| `UPLOAD_ROOT` | required, absolute | Private path outside the served web root |
| `MAX_UPLOAD_BYTES` | `8388608` | Input and validated-output image limit |
| `MAX_IMAGE_PIXELS` | `40000000` | Image decompression-bomb limit |
| `USER_STORAGE_QUOTA_BYTES` | `262144000` | Per-user active screenshot quota |
| `TOTAL_STORAGE_QUOTA_BYTES` | `10737418240` | Active screenshot quota for the installation |
| `MIN_DISK_FREE_BYTES` | `1073741824` | Uploads stop before the volume crosses this floor |
| `SSE_HEARTBEAT_MS` | `20000` | SSE keepalive interval |
| `CTRADER_CLIENT_ID` | optional group | Official cTrader Open API application ID |
| `CTRADER_CLIENT_SECRET` | optional group | Official cTrader Open API secret |
| `CTRADER_REDIRECT_URI` | optional group | Exact HTTPS callback URL ending in `/api/auth/ctrader/callback` |
| `CTRADER_ENCRYPTION_KEYS` | optional group | JSON version-to-32-byte-base64url token keyring |
| `CTRADER_ACTIVE_KEY_VERSION` | optional group | Active positive keyring version |
| `CTRADER_MCP_ENABLED` | `false` | Enables copied Remote MCP compatibility; requires the encryption keyring group |
| `CTRADER_OAUTH_STATE_TTL_SECONDS` | `300` | One-use, session-bound OAuth state lifetime |
| `CTRADER_GRANT_TTL_SECONDS` | `600` | Encrypted account-picker grant lifetime |
| `CTRADER_REQUEST_TIMEOUT_MS` | `15000` | OAuth/Open API request timeout |
| `CTRADER_SYNC_INTERVAL_SECONDS` | `300` | Automatic-sync cadence |
| `CTRADER_STALE_AFTER_SECONDS` | `900` | Running-job heartbeat timeout before recovery |
| `CTRADER_SYNC_OVERLAP_SECONDS` | `300` | Idempotent overlap for incremental history |
| `CTRADER_HISTORY_START_TIMESTAMP` | unset | Optional earlier bound; cannot shorten registration history |
| `CTRADER_REFRESH_SKEW_SECONDS` | `300` | Rotate tokens this far before expiry |
| `CTRADER_MAX_DEALS_PER_REQUEST` | `1000` | Historical page size before lossless bisection |
| `CTRADER_SYMBOL_CACHE_SECONDS` | `86400` | Stored symbol-spec lifetime |
| `CTRADER_TRADING_TIME_ZONE` | `Asia/Kolkata` | Journal date/time projection; UTC timestamps are retained |
| `SCHEDULER_ENABLED` | `false` | Enables recurring enqueueing after the single-writer cutover gate |

In production, keep `SESSION_PEPPER` and the database password in root-readable deployment secrets, not GitHub variables embedded into images.

## Browser contract

All responses use JSON except screenshot downloads and the SSE stream. Errors have this shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "The request payload is invalid",
    "requestId": "req-1",
    "details": []
  }
}
```

Unsafe requests must:

1. originate from the exact `PUBLIC_ORIGIN`;
2. include the opaque session cookie; and
3. send the current CSRF value in `x-csrf-token`.

The CSRF value is returned by login and session discovery. The readable CSRF cookie is an additional equality check; the server stores only its HMAC hash.

### Discovery and auth

| Method | Route | Request | Response |
|---|---|---|---|
| GET | `/healthz` | — | `{status:"ok"}` |
| GET | `/readyz` | — | `200 {status:"ready"}` or 503 |
| GET | `/api/config` | — | `{googleClientId,authMode:"google",dataApiReady:true}` |
| GET | `/api/auth/session` | cookie optional | `{user:null}` or `{user,csrfToken}` |
| POST | `/api/auth/google` | `{credential}` | `{user,csrfToken}` and cookies |
| POST | `/api/auth/logout` | CSRF | 204 |

`/api/config` also returns `ctraderEnabled`, `ctraderOAuthEnabled`, and `ctraderMcpEnabled` so the browser can expose only the configured connection modes.

### cTrader (read-only)

| Method | Route | Contract |
|---|---|---|
| POST | `/api/ctrader/oauth/start` | CSRF; `{authorizationUrl,expiresAt}` |
| GET | `/api/auth/ctrader/callback` | Provider redirect; fixed 303 to `/app.html?ctrader=select` or allowlisted error |
| GET | `/api/ctrader/oauth/pending` | Current-session encrypted grant; `{grantId,expiresAt,accounts}` |
| POST | `/api/ctrader/mcp/connect` | CSRF; copied `configuration`, required `environment:"live"|"demo"`, optional mapping/label, and literal `acknowledgeTradingCredentialRisk:true` |
| GET | `/api/ctrader/connections` | `{connections}` with no token material |
| POST | `/api/ctrader/connections` | `{grantId,ctidTraderAccountId,mappedLegacyAccountId?,label?}`; create or revive |
| GET | `/api/ctrader/connections/:id/status` | Connection, latest durable sync run, and up to 50 recent provider-exact account cash-flow rows |
| POST | `/api/ctrader/connections/:id/sync` | CSRF; `202 {syncRunId,status:"queued"}` |
| POST | `/api/ctrader/connections/:id/disconnect` | CSRF; 204; tokens scrubbed, imported trades retained |

OAuth state is opaque, HMACed, one use, short lived, and bound to the current Edgebook user and browser session. Access/refresh tokens are AES-256-GCM envelopes bound by AAD to their grant/connection ID and token kind. Account selection re-encrypts the tokens for the final connection, then erases the short-lived grant ciphertext.

Remote MCP connect first proves that the credential can call balance, symbols, and a real bounded `get_deals` history request. The copied configuration is never returned or retained; its extracted bearer token is stored in the same AAD-bound AES-GCM envelope. Edgebook calls only the fixed cTrader endpoint and the reviewed read-tool allowlist. If cTrader does not advertise the history tool, no connection or sync claim is created. The user must explicitly select live or demo; provider metadata is allowed to confirm that choice but never silently defaults it.

Run one long-lived worker alongside the API:

```text
npm run ctrader:worker:prod
```

That single process handles initial/manual queued jobs even while `SCHEDULER_ENABLED=false`. Once the previous writer is disabled, setting `SCHEDULER_ENABLED=true` also enables recurring enqueueing. A global PostgreSQL advisory lock permits only one active worker; a per-connection advisory lock coordinates sync and disconnect. Heartbeats recover abandoned jobs, transient failures retry at most three attempts, and authorization failure atomically scrubs tokens and requests fresh authorization for that connection mode.

For official OAuth, each cTrader position remains one journal trade, including an open position with partial realized P&L. `brokerData.realizedEvents` is the immutable execution-level ledger (`executionId`, UTC `executedAt`, trading-timezone `date`/`time`, close volume, price, net/gross P&L and fees). Exact trade net is `grossProfit + swap + commission - pnlConversionFee`, using each closing deal's `moneyDigits`; the same provider components and coverage declaration are retained in `brokerData` and shown in the trade UI. Calendar, daily, and drawdown views use those events instead of assigning every close to the original entry date. Provider-owned projection fields cannot be changed through trade PATCH; strategy, emotion, notes, tags, psychology, custom fields, stop loss, and take profit remain editable annotations.

Official sync also walks `ProtoOACashFlowHistoryList` from account registration in provider-limited seven-day windows. GSL, rollover, swap, copy/performance/management fees, dividends, rebates, deposits, withdrawals, and future provider operations are stored in `ctrader_account_cash_flows` under immutable `balanceHistoryId` and returned as `accountCashFlows` by the connection-status API. These are account-level entries: cTrader supplies no position or deal identifier in `ProtoOADepositWithdraw`, so Edgebook never attaches them to trade net and never treats an absent account charge as zero.

Remote MCP responses are intentionally projected more conservatively because their documented deal and symbol payloads may omit contract size, opener role, and authoritative net P&L semantics. Edgebook always stores validated execution facts and advances only a complete history window. A position lacking authoritative projection inputs is withheld from `trades` and analytics, retained in the connection's review queue, retried on later syncs, and surfaced through `positionsAwaitingReview` plus a sanitized connection warning. No lot size or P&L is guessed.

Google users are keyed by immutable `sub`, never by email alone. `users.google_sub` is nullable only to permit a pre-link Firebase import; the importer should populate provider UIDs before auth cutover.

### Trades

| Method | Route | Notes |
|---|---|---|
| GET | `/api/trades` | Cursor list; active trades by default |
| POST | `/api/trades` | `{trade}`; stable `trade.id` or `Idempotency-Key` required; same-key retries never rewrite |
| GET | `/api/trades/:id` | Accepts external legacy ID or `recordId` |
| PATCH | `/api/trades/:id` | `{trade: fields}`; include current `version` or `If-Match` |
| DELETE | `/api/trades/:id` | Soft archive; current `If-Match` required |
| POST | `/api/trades/:id/restore` | Restore; current `If-Match` required |
| DELETE | `/api/trades/:id/permanent` | Archived only; current `If-Match` plus `x-confirm-permanent-delete: <id>` |

List parameters:

- `deleted=active|deleted|all` (default `active`)
- compatibility: `deleted=true` means archived-only, `includeDeleted=true` means all
- `source`, `accountId`, `from`, `to`
- `limit` from 1–500, default 200
- `cursor` from the previous response

Response:

```json
{
  "trades": [],
  "nextCursor": null
}
```

Clients must continue requesting pages until `nextCursor` is null. The server never silently pretends that the first page is the complete journal.

The supplied Firebase-era ID remains the public `trade.id`; the PostgreSQL UUID is `trade.recordId`. `accountId` likewise preserves strings such as `acct_1`, while `internalAccountId` is reserved for a normalized UUID. `sourceSystem` identifies the provider and `ingestionMethod` distinguishes `manual`, `api`, `csv`, `migration`, and `webhook` provenance.

Unknown legacy fields are retained in `legacy_document` and returned beneath authoritative normalized fields. This preserves fields such as `groupingMode`, `needsReview`, `syncedAt`, and broker auxiliaries. Once a trade has a validated private `file_objects` screenshot, only those same-origin private URLs are returned; legacy external references remain a migration fallback only until promotion.

### Settings

| Method | Route | Contract |
|---|---|---|
| GET | `/api/settings` | `{settings,version,updatedAt}` |
| PUT | `/api/settings` | `{settings,version}`; missing version returns 428, stale versions return 409 |

`settings.accounts` is mirrored in the same PostgreSQL transaction into ownership-scoped normalized `accounts` rows. Browser account IDs remain stable public IDs, while the internal UUID survives edits, archive/removal, and later revival. cTrader account mapping resolves only an active account belonging to the same user.

### Mood check-ins

| Method | Route | Contract |
|---|---|---|
| GET | `/api/moods?from=&to=&limit=` | `{moods}` |
| POST | `/api/moods` | `{mood}`; stable `id`, internal `recordId` |
| PATCH | `/api/moods/:id` | `{mood: fields}` |
| DELETE | `/api/moods/:id` | 204 |

### Daily journal

| Method | Route | Contract |
|---|---|---|
| GET | `/api/journals?from=&to=&limit=` | `{entries:[{id,date,entry,version,...}]}` |
| GET | `/api/journals/:date` | `{journal:null|{id,date,entry,version,...}}` |
| PUT | `/api/journals/:date` | `{entry,version?}`; stale versions return 409 |
| DELETE | `/api/journals/:date` | 204 |

Dates use real Gregorian `YYYY-MM-DD` values (impossible dates such as February 30 are rejected) and remain the journal entry's stable external ID.

### Notifications

| Method | Route | Contract |
|---|---|---|
| GET | `/api/notifications?unread=&category=&limit=` | `{notifications}` |
| POST | `/api/notifications` | `{notification}`; legacy ID or `dedupeKey` makes it idempotent |
| PATCH | `/api/notifications/:id` | `{notification: fields}` |
| DELETE | `/api/notifications/:id` | 204 |
| POST | `/api/notifications/read-all` | `{updated}` |

### Screenshots

| Method | Route | Contract |
|---|---|---|
| GET | `/api/trades/:tradeId/screenshots` | `{files}` |
| POST | `/api/trades/:tradeId/screenshots` | Multipart field `file`; `{file}` |
| GET | `/api/files/:id` | Private image stream |
| DELETE | `/api/files/:id` | 204, or 202 when physical cleanup is queued |

Only single-frame JPEG, PNG, and WebP images are accepted. Images are decoded, metadata-stripped and re-encoded before storage. A global PostgreSQL advisory lock serializes the database quota and filesystem free-space recheck immediately before save; the transaction also locks the user/trade and enforces at most five active screenshots per trade.

Deleting metadata writes the storage key to `file_deletion_queue` through a database trigger. Run `storage:cleanup:prod` from a periodic systemd timer or cron job. Failed removals use exponential retry, so a database cascade cannot orphan an unrecoverable file path.

### Server-Sent Events

`GET /api/events` is authenticated and supports `Last-Event-ID`. Mutations persist an event in PostgreSQL before `NOTIFY`; reconnecting clients can replay missed events. Configure the reverse proxy to disable response buffering for this route.

## Database and migrations

`migrations/001_initial.sql` preserves Firebase IDs and original JSON while adding normalized data needed for safe calculation and broker ingestion:

- raw `trade_executions` separate from aggregated `trades`;
- separate `source_system` and `ingestion_method`;
- `numeric(30,10)` values for prices, sizes, and P&L;
- immutable Google subject identity;
- encrypted-token placeholders and key versions for future broker workers;
- webhook, sync-run, symbol-spec, audit and OAuth state tables;
- raw legacy JSON on imported records.

`002_ctrader.sql` adds encrypted one-use OAuth grants, provider/environment uniqueness, raw cTrader execution facts, scheduler heartbeats, and durable purge tombstones. A user-archived cTrader trade remains archived during sync. A permanently purged cTrader projection leaves a tombstone so later broker history cannot silently recreate it.

An idempotent create replay after its original resource was permanently deleted returns `409 IDEMPOTENCY_RESOURCE_GONE`; it never silently recreates or overwrites another trade.

`003_tenant_integrity.sql` adds composite ownership foreign keys, transactional API idempotency records, and a one-active-run-per-connection queue invariant. Cross-user account, broker, trade, execution, duplicate, and private-file UUID links are rejected by PostgreSQL even if an application validation is bypassed.

The runner takes a PostgreSQL advisory lock and records each committed file in `schema_migrations`. Migrations must follow expand/contract rules so the previous application image remains rollback-compatible.

## Docker

Build from this directory after `package-lock.json` exists:

```text
docker build -t edgebook-server:local .
```

The image runs as the unprivileged `node` user. Mount an upload directory writable by that UID and inject all environment variables at runtime. Run migrations as a one-off task before starting a new application image.

## Production checklist

- Put the API on `127.0.0.1:3210` behind Caddy/Nginx.
- Do not expose PostgreSQL publicly.
- Set `PUBLIC_ORIGIN` to the exact HTTPS site origin.
- Set `TRUST_PROXY=true` only when direct access to the Node port is blocked.
- Mount `UPLOAD_ROOT` outside the static site and back it up offsite.
- Schedule `storage:cleanup:prod` and alert on repeated queue failures.
- Back up PostgreSQL and the encryption/session secrets separately.
- Keep only one Firebase/VPS writer and broker scheduler during migration.
- Start `ctrader:worker:prod`; leave `SCHEDULER_ENABLED=false` until the old scheduler is confirmed disabled.
- Back up the active and retired cTrader keyring versions separately from PostgreSQL; retired versions remain required until all envelopes rotate.
- Run `npm run check` and `npm audit` before building the release image.
