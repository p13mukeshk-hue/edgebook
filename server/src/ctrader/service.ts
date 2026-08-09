import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/database.js";
import { withTransaction } from "../db/database.js";
import type { EventBus } from "../events/event-bus.js";
import { createOpaqueToken, hashToken } from "../auth/tokens.js";
import { AppError, notFound } from "../lib/errors.js";
import { resolveOwnedAccountMapping } from "../modules/accounts/sync.js";
import type { AuthContext } from "../types.js";
import type { CTraderGateway } from "./client.js";
import {
  connectionTokenAad,
  grantTokenAad,
  type TokenCipher,
} from "./crypto.js";
import type { CTraderOAuthClient } from "./oauth.js";
import type { CTraderAuthorizedAccount, CTraderEnvironment } from "./protocol.js";

type OAuthTransactionRow = QueryResultRow & { id: string };

type GrantRow = QueryResultRow & {
  id: string;
  user_id: string;
  session_id: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  encryption_key_version: number;
  token_expires_at: Date | string;
  authorized_accounts: unknown;
  expires_at: Date | string;
  consumed_at: Date | string | null;
};

type ConnectionRow = QueryResultRow & {
  id: string;
  connected: boolean;
  external_account_id: string;
  provider_environment: CTraderEnvironment;
  account_label: string | null;
  mapped_account_id: string | null;
  legacy_mapped_account_id: string | null;
  provider_metadata: unknown;
  connected_at: Date | string | null;
  last_sync_at: Date | string | null;
  disconnected_at: Date | string | null;
  disconnect_reason: string | null;
  token_expires_at: Date | string | null;
  latest_sync_id: string | null;
  latest_sync_status: string | null;
  latest_sync_counters: unknown;
  latest_sync_error_code: string | null;
  latest_sync_error_message: string | null;
  latest_sync_started_at: Date | string | null;
  latest_sync_finished_at: Date | string | null;
};

export type CTraderPublicConnection = {
  id: string;
  connected: boolean;
  ctidTraderAccountId: string;
  environment: CTraderEnvironment;
  label: string | null;
  mappedAccountId: string | null;
  mappedLegacyAccountId: string | null;
  brokerTitleShort: string | null;
  traderLogin: string | null;
  accountCurrency: string | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  disconnectedAt: string | null;
  disconnectReason: string | null;
  tokenExpiresAt: string | null;
  reauthRequired: boolean;
  lastSyncStatus: string;
  lastError: { code: string | null; message: string } | null;
};

export type CTraderPublicSyncRun = {
  id: string;
  status: string;
  counters: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export interface CTraderBrokerService {
  startOAuth(auth: AuthContext): Promise<{ authorizationUrl: string; expiresAt: string }>;
  rejectOAuth(state: string, auth: AuthContext): Promise<void>;
  completeOAuth(state: string, code: string, auth: AuthContext): Promise<void>;
  pendingOAuth(auth: AuthContext): Promise<{ grantId: string; expiresAt: string; accounts: CTraderAuthorizedAccount[] }>;
  listConnections(userId: string): Promise<CTraderPublicConnection[]>;
  createConnection(input: {
    auth: AuthContext;
    grantId: string;
    ctidTraderAccountId: string;
    mappedLegacyAccountId: string | null;
    label: string | null;
  }): Promise<CTraderPublicConnection>;
  connectionStatus(userId: string, connectionId: string): Promise<{
    connection: CTraderPublicConnection;
    latestSyncRun: CTraderPublicSyncRun | null;
  }>;
  queueManualSync(userId: string, connectionId: string): Promise<{ syncRunId: string; status: "queued" }>;
  disconnect(userId: string, connectionId: string): Promise<void>;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function mapConnection(row: ConnectionRow): CTraderPublicConnection {
  const metadata = objectValue(row.provider_metadata);
  const errorMessage = row.latest_sync_error_message ?? stringOrNull(metadata.lastErrorMessage);
  const errorCode = row.latest_sync_error_code ?? stringOrNull(metadata.lastErrorCode);
  return {
    id: row.id,
    connected: row.connected,
    ctidTraderAccountId: row.external_account_id,
    environment: row.provider_environment,
    label: row.account_label,
    mappedAccountId: row.mapped_account_id,
    mappedLegacyAccountId: row.legacy_mapped_account_id,
    brokerTitleShort: stringOrNull(metadata.brokerTitleShort),
    traderLogin: stringOrNull(metadata.traderLogin),
    accountCurrency: stringOrNull(metadata.accountCurrency),
    connectedAt: iso(row.connected_at),
    lastSyncAt: iso(row.last_sync_at),
    disconnectedAt: iso(row.disconnected_at),
    disconnectReason: row.disconnect_reason,
    tokenExpiresAt: iso(row.token_expires_at),
    reauthRequired: metadata.reauthRequired === true,
    lastSyncStatus: row.latest_sync_status ?? (row.last_sync_at === null ? "never" : "succeeded"),
    lastError: errorMessage === null ? null : { code: errorCode, message: errorMessage },
  };
}

function mapLatestSync(row: ConnectionRow): CTraderPublicSyncRun | null {
  if (row.latest_sync_id === null) return null;
  return {
    id: row.latest_sync_id,
    status: row.latest_sync_status ?? "unknown",
    counters: objectValue(row.latest_sync_counters),
    errorCode: row.latest_sync_error_code,
    errorMessage: row.latest_sync_error_message,
    startedAt: iso(row.latest_sync_started_at),
    finishedAt: iso(row.latest_sync_finished_at),
  };
}

function parseAuthorizedAccounts(value: unknown): CTraderAuthorizedAccount[] {
  if (!Array.isArray(value)) throw new Error("Stored cTrader account grant is malformed");
  return value.map((entry, index) => {
    const account = objectValue(entry);
    const id = account.ctidTraderAccountId;
    const environment = account.environment;
    if (typeof id !== "string" || (environment !== "live" && environment !== "demo")) {
      throw new Error(`Stored cTrader account grant entry ${index} is malformed`);
    }
    const numberOrNull = (candidate: unknown): number | null =>
      typeof candidate === "number" && Number.isSafeInteger(candidate) ? candidate : null;
    return {
      ctidTraderAccountId: id,
      environment,
      traderLogin: stringOrNull(account.traderLogin),
      brokerTitleShort: stringOrNull(account.brokerTitleShort),
      lastClosingDealTimestamp: numberOrNull(account.lastClosingDealTimestamp),
      lastBalanceUpdateTimestamp: numberOrNull(account.lastBalanceUpdateTimestamp),
    };
  });
}

const connectionSelect = `
  SELECT c.id, c.connected, c.external_account_id, c.provider_environment,
         c.account_label, c.mapped_account_id, c.legacy_mapped_account_id,
         c.provider_metadata, c.connected_at, c.last_sync_at,
         c.disconnected_at, c.disconnect_reason, c.token_expires_at,
         latest.id AS latest_sync_id, latest.status AS latest_sync_status,
         latest.counters AS latest_sync_counters,
         latest.error_code AS latest_sync_error_code,
         latest.error_message AS latest_sync_error_message,
         latest.started_at AS latest_sync_started_at,
         latest.finished_at AS latest_sync_finished_at
  FROM broker_connections c
  LEFT JOIN LATERAL (
    SELECT id, status, counters, error_code, error_message, started_at, finished_at
    FROM sync_runs
    WHERE broker_connection_id = c.id
    ORDER BY started_at DESC, id DESC
    LIMIT 1
  ) latest ON true`;

export class PostgresCTraderService implements CTraderBrokerService {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly oauth: CTraderOAuthClient,
    private readonly gateway: CTraderGateway,
    private readonly cipher: TokenCipher,
    private readonly events: EventBus,
  ) {}

  async startOAuth(auth: AuthContext): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const state = createOpaqueToken(32);
    const expiresAt = new Date(Date.now() + this.config.cTrader.oauthStateTtlSeconds * 1_000);
    await this.database.query(
      `INSERT INTO oauth_transactions (
         id, user_id, session_id, provider, state_hash, metadata, expires_at
       ) VALUES ($1, $2, $3, 'ctrader', $4, $5::jsonb, $6)`,
      [
        randomUUID(),
        auth.user.id,
        auth.sessionId,
        hashToken(state, this.config.sessionPepper),
        JSON.stringify({ scope: "accounts", returnPath: "/app.html" }),
        expiresAt,
      ],
    );
    void this.database.query(
      `DELETE FROM oauth_transactions
       WHERE provider='ctrader' AND expires_at < now() - interval '1 day'`,
    ).catch(() => undefined);
    return { authorizationUrl: this.oauth.authorizationUrl(state), expiresAt: expiresAt.toISOString() };
  }

  async rejectOAuth(state: string, auth: AuthContext): Promise<void> {
    const claimed = await this.claimOAuthState(state, auth);
    if (!claimed) throw new AppError(400, "CTRADER_STATE_INVALID", "The cTrader authorization state is invalid or expired");
  }

  async completeOAuth(state: string, code: string, auth: AuthContext): Promise<void> {
    const claimed = await this.claimOAuthState(state, auth);
    if (!claimed) throw new AppError(400, "CTRADER_STATE_INVALID", "The cTrader authorization state is invalid or expired");

    const tokenSet = await this.oauth.exchangeAuthorizationCode(code);
    const accounts = await this.gateway.discoverAccounts(tokenSet.accessToken);
    if (accounts.length === 0) {
      throw new AppError(400, "CTRADER_NO_ACCOUNTS", "The cTrader grant contains no authorized accounts");
    }
    const grantId = randomUUID();
    const tokenExpiresAt = new Date(Date.now() + tokenSet.expiresIn * 1_000);
    const expiresAt = new Date(Date.now() + this.config.cTrader.grantTtlSeconds * 1_000);
    await this.database.query(
      `INSERT INTO ctrader_oauth_grants (
         id, user_id, session_id, access_token_ciphertext,
         refresh_token_ciphertext, encryption_key_version, token_expires_at,
         authorized_accounts, expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        grantId,
        auth.user.id,
        auth.sessionId,
        this.cipher.encrypt(tokenSet.accessToken, grantTokenAad(grantId, "access")),
        this.cipher.encrypt(tokenSet.refreshToken, grantTokenAad(grantId, "refresh")),
        this.cipher.activeKeyVersion,
        tokenExpiresAt,
        JSON.stringify(accounts),
        expiresAt,
      ],
    );
  }

  async pendingOAuth(auth: AuthContext): Promise<{
    grantId: string;
    expiresAt: string;
    accounts: CTraderAuthorizedAccount[];
  }> {
    const result = await this.database.query<GrantRow>(
      `SELECT id, user_id, session_id, access_token_ciphertext,
              refresh_token_ciphertext, encryption_key_version,
              token_expires_at, authorized_accounts, expires_at, consumed_at
       FROM ctrader_oauth_grants
       WHERE user_id=$1 AND session_id=$2 AND consumed_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1`,
      [auth.user.id, auth.sessionId],
    );
    const grant = result.rows[0];
    if (!grant) throw new AppError(404, "CTRADER_GRANT_NOT_FOUND", "No pending cTrader authorization was found");
    return {
      grantId: grant.id,
      expiresAt: new Date(grant.expires_at).toISOString(),
      accounts: parseAuthorizedAccounts(grant.authorized_accounts),
    };
  }

  async listConnections(userId: string): Promise<CTraderPublicConnection[]> {
    const result = await this.database.query<ConnectionRow>(
      `${connectionSelect}
       WHERE c.user_id=$1 AND c.provider='ctrader'
         AND c.oauth_scope='accounts' AND c.provider_environment IS NOT NULL
       ORDER BY c.connected DESC, c.created_at ASC`,
      [userId],
    );
    return result.rows.map(mapConnection);
  }

  async createConnection(input: {
    auth: AuthContext;
    grantId: string;
    ctidTraderAccountId: string;
    mappedLegacyAccountId: string | null;
    label: string | null;
  }): Promise<CTraderPublicConnection> {
    const connectionId = await withTransaction(this.database, async (client) => {
      const grantResult = await client.query<GrantRow>(
        `SELECT id, user_id, session_id, access_token_ciphertext,
                refresh_token_ciphertext, encryption_key_version,
                token_expires_at, authorized_accounts, expires_at, consumed_at
         FROM ctrader_oauth_grants
         WHERE id=$1 AND user_id=$2 AND session_id=$3
           AND consumed_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [input.grantId, input.auth.user.id, input.auth.sessionId],
      );
      const grant = grantResult.rows[0];
      if (!grant) throw new AppError(410, "CTRADER_GRANT_EXPIRED", "The cTrader authorization expired; authorize again");
      const accounts = parseAuthorizedAccounts(grant.authorized_accounts);
      const selected = accounts.find((account) => account.ctidTraderAccountId === input.ctidTraderAccountId);
      if (!selected) throw new AppError(400, "CTRADER_ACCOUNT_NOT_AUTHORIZED", "The selected account is not present in this cTrader grant");

      const mapping = await resolveOwnedAccountMapping(client, input.auth.user.id, input.mappedLegacyAccountId);
      // Serialize create/revive by the provider account identity. Without this
      // key lock, two tabs could race: the losing insert would encrypt for a
      // newly generated UUID while PostgreSQL kept the winner's UUID/AAD.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${input.auth.user.id}:ctrader:${selected.environment}:${selected.ctidTraderAccountId}`],
      );
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM broker_connections
         WHERE user_id=$1 AND provider='ctrader'
           AND provider_environment=$2 AND external_account_id=$3`,
        [input.auth.user.id, selected.environment, selected.ctidTraderAccountId],
      );
      const id = existing.rows[0]?.id ?? randomUUID();
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [id]);

      const accessToken = this.cipher.decrypt(grant.access_token_ciphertext, grantTokenAad(grant.id, "access"));
      const refreshToken = this.cipher.decrypt(grant.refresh_token_ciphertext, grantTokenAad(grant.id, "refresh"));
      const metadata = {
        brokerTitleShort: selected.brokerTitleShort,
        traderLogin: selected.traderLogin,
        lastClosingDealTimestamp: selected.lastClosingDealTimestamp,
        lastBalanceUpdateTimestamp: selected.lastBalanceUpdateTimestamp,
        permissionScope: "accounts",
        readOnly: true,
        reauthRequired: false,
      };
      await client.query(
        `INSERT INTO broker_connections (
           id, user_id, provider, provider_environment, oauth_scope,
           external_account_id, account_label, mapped_account_id,
           legacy_mapped_account_id, connected, access_token_ciphertext,
           refresh_token_ciphertext, encryption_key_version, token_expires_at,
           token_generation, provider_metadata, connected_at, disconnected_at,
           disconnect_reason
         ) VALUES (
           $1,$2,'ctrader',$3,'accounts',$4,$5,$6,$7,true,$8,$9,$10,$11,
           1,$12::jsonb,now(),NULL,NULL
         )
         ON CONFLICT (user_id, provider, provider_environment, external_account_id)
           WHERE external_account_id IS NOT NULL
         DO UPDATE SET
           account_label=EXCLUDED.account_label,
           mapped_account_id=EXCLUDED.mapped_account_id,
           legacy_mapped_account_id=EXCLUDED.legacy_mapped_account_id,
           connected=true,
           access_token_ciphertext=EXCLUDED.access_token_ciphertext,
           refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,
           encryption_key_version=EXCLUDED.encryption_key_version,
           token_expires_at=EXCLUDED.token_expires_at,
           token_generation=broker_connections.token_generation+1,
           token_refreshed_at=now(),
           provider_metadata=broker_connections.provider_metadata || EXCLUDED.provider_metadata,
           connected_at=now(),
           disconnected_at=NULL,
           disconnect_reason=NULL`,
        [
          id,
          input.auth.user.id,
          selected.environment,
          selected.ctidTraderAccountId,
          input.label,
          mapping.internalId,
          mapping.legacyId,
          this.cipher.encrypt(accessToken, connectionTokenAad(id, "access")),
          this.cipher.encrypt(refreshToken, connectionTokenAad(id, "refresh")),
          this.cipher.activeKeyVersion,
          grant.token_expires_at,
          JSON.stringify(metadata),
        ],
      );
      await client.query(
        `UPDATE ctrader_oauth_grants
         SET consumed_at=now(), access_token_ciphertext='', refresh_token_ciphertext=''
         WHERE id=$1`,
        [grant.id],
      );
      await client.query(
        `INSERT INTO sync_runs (
           id, broker_connection_id, job_key, sync_type, status,
           requested_by_user_id, counters
         ) VALUES ($1,$2,$3,'initial','queued',$4,'{}'::jsonb)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), id, `oauth:${grant.id}`, input.auth.user.id],
      );
      return id;
    });

    const connection = await this.findConnection(input.auth.user.id, connectionId);
    await this.events.publish(input.auth.user.id, "ctrader.connected", { connectionId }).catch(() => undefined);
    return connection;
  }

  async connectionStatus(userId: string, connectionId: string): Promise<{
    connection: CTraderPublicConnection;
    latestSyncRun: CTraderPublicSyncRun | null;
  }> {
    const row = await this.findConnectionRow(userId, connectionId);
    return { connection: mapConnection(row), latestSyncRun: mapLatestSync(row) };
  }

  async queueManualSync(userId: string, connectionId: string): Promise<{ syncRunId: string; status: "queued" }> {
    return withTransaction(this.database, async (client) => {
      const connection = await client.query<{
        connected: boolean;
        access_token_ciphertext: string | null;
        refresh_token_ciphertext: string | null;
      }>(
        `SELECT connected, access_token_ciphertext, refresh_token_ciphertext
         FROM broker_connections
         WHERE id=$1 AND user_id=$2 AND provider='ctrader'
           AND oauth_scope='accounts' AND provider_environment IS NOT NULL
         FOR UPDATE`,
        [connectionId, userId],
      );
      const row = connection.rows[0];
      if (!row) throw notFound("cTrader connection");
      if (!row.connected || !row.access_token_ciphertext || !row.refresh_token_ciphertext) {
        throw new AppError(409, "CTRADER_REAUTH_REQUIRED", "Reconnect cTrader before requesting a sync");
      }
      const active = await client.query<{ id: string }>(
        `SELECT id FROM sync_runs
         WHERE broker_connection_id=$1 AND status IN ('queued','running')
         ORDER BY started_at ASC LIMIT 1`,
        [connectionId],
      );
      if (active.rows[0]) return { syncRunId: active.rows[0].id, status: "queued" as const };
      const syncRunId = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO sync_runs (
           id, broker_connection_id, job_key, sync_type, status,
           requested_by_user_id, counters
         ) VALUES ($1,$2,$3,'manual','queued',$4,'{}'::jsonb)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [syncRunId, connectionId, `manual:${syncRunId}`, userId],
      );
      if (inserted.rows[0]) return { syncRunId, status: "queued" as const };
      const winner = await client.query<{ id: string }>(
        `SELECT id FROM sync_runs
         WHERE broker_connection_id=$1 AND status IN ('queued','running')
         ORDER BY started_at ASC LIMIT 1`,
        [connectionId],
      );
      if (!winner.rows[0]) throw new Error("Failed to queue cTrader sync");
      return { syncRunId: winner.rows[0].id, status: "queued" as const };
    });
  }

  async disconnect(userId: string, connectionId: string): Promise<void> {
    const changed = await withTransaction(this.database, async (client) => {
      const exists = await client.query<{ id: string }>(
        `SELECT id FROM broker_connections
         WHERE id=$1 AND user_id=$2 AND provider='ctrader'
           AND oauth_scope='accounts' AND provider_environment IS NOT NULL
         LIMIT 1`,
        [connectionId, userId],
      );
      if (!exists.rows[0]) return false;
      // Wait for a currently-running sync to finish before scrubbing its token.
      // The worker holds the matching session advisory lock.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [connectionId]);
      const locked = await client.query<{ id: string }>(
        `SELECT id FROM broker_connections
         WHERE id=$1 AND user_id=$2 AND provider='ctrader'
           AND oauth_scope='accounts' AND provider_environment IS NOT NULL
         FOR UPDATE`,
        [connectionId, userId],
      );
      if (!locked.rows[0]) return false;
      await client.query(
        `UPDATE broker_connections SET
           connected=false,
           access_token_ciphertext=NULL,
           refresh_token_ciphertext=NULL,
           encryption_key_version=NULL,
           token_expires_at=NULL,
           token_generation=token_generation+1,
           disconnected_at=now(),
           disconnect_reason='user',
           provider_metadata=(provider_metadata - 'lastErrorCode' - 'lastErrorMessage')
             || '{"reauthRequired":false}'::jsonb
         WHERE id=$1`,
        [connectionId],
      );
      await client.query(
        `UPDATE sync_runs SET status='cancelled', finished_at=now(),
           error_code='DISCONNECTED', error_message='Connection was disconnected before the sync started'
         WHERE broker_connection_id=$1 AND status='queued'`,
        [connectionId],
      );
      return true;
    });
    if (!changed) throw notFound("cTrader connection");
    await this.events.publish(userId, "ctrader.disconnected", { connectionId }).catch(() => undefined);
  }

  private async claimOAuthState(state: string, auth: AuthContext): Promise<OAuthTransactionRow | null> {
    if (!/^[A-Za-z0-9_-]{40,200}$/.test(state)) return null;
    const result = await this.database.query<OAuthTransactionRow>(
      `UPDATE oauth_transactions SET consumed_at=now()
       WHERE provider='ctrader' AND state_hash=$1 AND user_id=$2 AND session_id=$3
         AND consumed_at IS NULL AND expires_at > now()
       RETURNING id`,
      [hashToken(state, this.config.sessionPepper), auth.user.id, auth.sessionId],
    );
    return result.rows[0] ?? null;
  }

  private async findConnection(userId: string, connectionId: string): Promise<CTraderPublicConnection> {
    return mapConnection(await this.findConnectionRow(userId, connectionId));
  }

  private async findConnectionRow(userId: string, connectionId: string): Promise<ConnectionRow> {
    const result = await this.database.query<ConnectionRow>(
      `${connectionSelect}
       WHERE c.id=$1 AND c.user_id=$2 AND c.provider='ctrader'
         AND c.oauth_scope='accounts' AND c.provider_environment IS NOT NULL
       LIMIT 1`,
      [connectionId, userId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("cTrader connection");
    return row;
  }
}
