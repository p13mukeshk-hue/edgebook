import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
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

type ConnectionIdentityRow = QueryResultRow & {
  id: string;
  connected: boolean;
  connection_mode: "official" | "mcp_read";
  provider_environment: CTraderEnvironment | null;
  provider_metadata: unknown;
};

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
  connection_mode: "official" | "mcp_read";
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
  mode: "official" | "mcp_read";
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
  lastWarning: { code: string | null; message: string } | null;
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

export type CTraderMcpValidation = {
  bearerToken: string;
  balance: unknown;
  symbols: unknown;
  historyProbe: unknown;
  accountInfo?: unknown;
};

export interface CTraderMcpConnector {
  validateConfiguration(configuration: string): Promise<CTraderMcpValidation>;
}

export interface CTraderBrokerService {
  startOAuth(auth: AuthContext): Promise<{ authorizationUrl: string; expiresAt: string }>;
  rejectOAuth(state: string, auth: AuthContext): Promise<void>;
  completeOAuth(state: string, code: string, auth: AuthContext): Promise<void>;
  pendingOAuth(auth: AuthContext): Promise<{ grantId: string; expiresAt: string; accounts: CTraderAuthorizedAccount[] }>;
  connectMcp(input: {
    auth: AuthContext;
    configuration: string;
    environment: CTraderEnvironment;
    accountId: string | null;
    mappedLegacyAccountId: string | null;
    label: string | null;
    acknowledgeNoOpenPositionsAtConnect?: boolean;
  }): Promise<CTraderPublicConnection>;
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

function firstText(objects: readonly Record<string, unknown>[], keys: readonly string[]): string | null {
  for (const object of objects) {
    for (const key of keys) {
      const value = object[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return null;
}

function unwrapFirstObject(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return objectValue(value[0]);
  const root = objectValue(value);
  for (const key of ["account", "balance", "data", "result"] as const) {
    const nested = root[key];
    if (Array.isArray(nested) && nested.length > 0) return objectValue(nested[0]);
    if (typeof nested === "object" && nested !== null && !Array.isArray(nested)) return objectValue(nested);
  }
  return root;
}

function arrayLength(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  const object = objectValue(value);
  for (const key of ["symbols", "data", "result", "items"] as const) {
    if (Array.isArray(object[key])) return object[key].length;
  }
  return 0;
}

function firstTimestamp(objects: readonly Record<string, unknown>[], keys: readonly string[]): number | null {
  for (const object of objects) {
    for (const key of keys) {
      const value = object[key];
      const parsed = typeof value === "number"
        ? value
        : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
          ? Number(value)
          : typeof value === "string"
            ? Date.parse(value)
            : Number.NaN;
      if (Number.isFinite(parsed) && parsed > 0) {
        const milliseconds = parsed < 1_000_000_000_000 ? parsed * 1_000 : parsed;
        if (Number.isSafeInteger(milliseconds) && milliseconds <= Date.now()) return milliseconds;
      }
    }
  }
  return null;
}

function mapConnection(row: ConnectionRow): CTraderPublicConnection {
  const metadata = objectValue(row.provider_metadata);
  const errorMessage = row.latest_sync_error_message ?? stringOrNull(metadata.lastErrorMessage);
  const errorCode = row.latest_sync_error_code ?? stringOrNull(metadata.lastErrorCode);
  const warningMessage = stringOrNull(metadata.lastWarningMessage);
  const warningCode = stringOrNull(metadata.lastWarningCode);
  return {
    id: row.id,
    connected: row.connected,
    mode: row.connection_mode,
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
    lastWarning: warningMessage === null ? null : { code: warningCode, message: warningMessage },
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

async function resolveConnectionIdentity(
  client: PoolClient,
  userId: string,
  environment: CTraderEnvironment,
  accountId: string,
  requestedMode: "official" | "mcp_read",
): Promise<{ row: ConnectionIdentityRow | null; adoptsLegacyEnvironment: boolean }> {
  const candidates = await client.query<ConnectionIdentityRow>(
    `SELECT id, connected, connection_mode, provider_environment, provider_metadata
     FROM broker_connections
     WHERE user_id=$1 AND provider='ctrader' AND external_account_id=$2
       AND (provider_environment=$3 OR provider_environment IS NULL)
     FOR UPDATE`,
    [userId, accountId, environment],
  );
  const exact = candidates.rows.filter((row) => row.provider_environment === environment);
  const legacy = candidates.rows.filter((row) => row.provider_environment === null);
  if (exact.length > 1 || legacy.length > 1 || (exact.length > 0 && legacy.length > 0)) {
    throw new AppError(
      409,
      "CTRADER_CONNECTION_IDENTITY_CONFLICT",
      "Multiple stored cTrader connections match this account; resolve the legacy connection conflict before reconnecting",
    );
  }
  const row = exact[0] ?? legacy[0] ?? null;
  if (row?.provider_environment === null && row.connected) {
    throw new AppError(
      409,
      "CTRADER_LEGACY_CONNECTION_ACTIVE",
      "Disconnect the legacy cTrader connection before adopting it into the current integration",
    );
  }
  if (row?.connected && row.connection_mode !== requestedMode) {
    throw new AppError(
      409,
      "CTRADER_CONNECTION_MODE_CONFLICT",
      requestedMode === "official"
        ? "This cTrader account is already connected through Remote MCP; disconnect it before switching connection modes"
        : "This cTrader account is already connected through official OAuth; disconnect it before switching connection modes",
    );
  }
  return { row, adoptsLegacyEnvironment: row?.provider_environment === null };
}

const connectionSelect = `
  SELECT c.id, c.connected, c.connection_mode, c.external_account_id, c.provider_environment,
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
    private readonly oauth: CTraderOAuthClient | null,
    private readonly gateway: CTraderGateway | null,
    private readonly cipher: TokenCipher,
    private readonly events: EventBus,
    private readonly mcp: CTraderMcpConnector | null = null,
  ) {}

  async startOAuth(auth: AuthContext): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const { oauth } = this.officialClients();
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
    return { authorizationUrl: oauth.authorizationUrl(state), expiresAt: expiresAt.toISOString() };
  }

  async rejectOAuth(state: string, auth: AuthContext): Promise<void> {
    const claimed = await this.claimOAuthState(state, auth);
    if (!claimed) throw new AppError(400, "CTRADER_STATE_INVALID", "The cTrader authorization state is invalid or expired");
  }

  async completeOAuth(state: string, code: string, auth: AuthContext): Promise<void> {
    const { oauth, gateway } = this.officialClients();
    const claimed = await this.claimOAuthState(state, auth);
    if (!claimed) throw new AppError(400, "CTRADER_STATE_INVALID", "The cTrader authorization state is invalid or expired");

    const tokenSet = await oauth.exchangeAuthorizationCode(code);
    const accounts = await gateway.discoverAccounts(tokenSet.accessToken);
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

  async connectMcp(input: {
    auth: AuthContext;
    configuration: string;
    environment: CTraderEnvironment;
    accountId: string | null;
    mappedLegacyAccountId: string | null;
    label: string | null;
    acknowledgeNoOpenPositionsAtConnect?: boolean;
  }): Promise<CTraderPublicConnection> {
    if (!this.config.cTrader.mcpEnabled || !this.mcp) {
      throw new AppError(503, "CTRADER_MCP_NOT_CONFIGURED", "cTrader MCP compatibility is not enabled on this server");
    }
    // Establish the partial-history boundary before any remote round trip so
    // deals executed while validation is in flight cannot fall into a gap.
    const connectionAttemptStartedAt = Date.now();
    let validation: CTraderMcpValidation;
    try {
      validation = await this.mcp.validateConfiguration(input.configuration);
    } catch (error) {
      // The copied configuration and provider response can both contain a
      // trading-capable credential. Never reflect either through this error.
      const validationCode = objectValue(error).code;
      if (validationCode === "TOOL_UNAVAILABLE") {
        throw new AppError(
          422,
          "CTRADER_MCP_HISTORY_UNAVAILABLE",
          "This cTrader configuration does not expose the required read-only trade-history tool",
        );
      }
      if (validationCode === "REMOTE_RATE_LIMITED") {
        throw new AppError(429, "CTRADER_MCP_RATE_LIMITED", "cTrader is temporarily rate limited; retry shortly");
      }
      if (validationCode === "REMOTE_UNAVAILABLE" || validationCode === "REQUEST_TIMEOUT") {
        throw new AppError(503, "CTRADER_MCP_UNAVAILABLE", "cTrader is temporarily unavailable; retry shortly");
      }
      if (validationCode !== "AUTH_REJECTED" && validationCode !== "TOKEN_INVALID") {
        throw new AppError(502, "CTRADER_MCP_VALIDATION_FAILED", "cTrader could not validate this Remote MCP configuration");
      }
      throw new AppError(401, "CTRADER_MCP_AUTH_FAILED", "The copied cTrader MCP configuration could not be authenticated");
    }
    const balance = unwrapFirstObject(validation.balance);
    const accountInfo = unwrapFirstObject(validation.accountInfo);
    const metadataObjects = [balance, accountInfo];
    const detectedAccountId = firstText(metadataObjects, [
      "accountId", "account_id", "ctidTraderAccountId", "traderAccountId",
    ]);
    if (detectedAccountId !== null && !/^(?:0|[1-9]\d{0,19})$/.test(detectedAccountId)) {
      throw new AppError(400, "CTRADER_MCP_ACCOUNT_INVALID", "cTrader returned an invalid account identifier");
    }
    if (input.accountId !== null && detectedAccountId !== null && input.accountId !== detectedAccountId) {
      throw new AppError(400, "CTRADER_MCP_ACCOUNT_MISMATCH", "The supplied account ID does not match the copied cTrader configuration");
    }
    const accountId = detectedAccountId ?? input.accountId;
    if (accountId === null) {
      throw new AppError(400, "CTRADER_MCP_ACCOUNT_REQUIRED", "Enter the numeric cTrader account ID shown for this configuration");
    }
    const environmentText = firstText(metadataObjects, ["environment", "accountEnvironment"]);
    const explicitIsLive = metadataObjects.find((value) => typeof value.isLive === "boolean")?.isLive;
    const normalizedEnvironment = environmentText?.trim().toLowerCase();
    const detectedEnvironment: CTraderEnvironment | null = explicitIsLive === true
      ? "live"
      : explicitIsLive === false
        ? "demo"
        : normalizedEnvironment === "live" || normalizedEnvironment === "real"
          ? "live"
          : normalizedEnvironment === "demo"
            ? "demo"
            : null;
    if (detectedEnvironment !== null && detectedEnvironment !== input.environment) {
      throw new AppError(
        400,
        "CTRADER_MCP_ENVIRONMENT_MISMATCH",
        "The selected cTrader environment does not match the copied configuration",
      );
    }
    const environment = input.environment;
    const currency = firstText(metadataObjects, ["currency", "currencyCode", "accountCurrency"]);
    const registrationTimestamp = firstTimestamp(metadataObjects, [
      "registrationTimestamp", "createdAt", "created_at", "registrationDate", "openDate", "startDate",
    ]);
    const symbolCount = arrayLength(validation.symbols);
    if (symbolCount === 0) {
      throw new AppError(502, "CTRADER_MCP_SYMBOLS_EMPTY", "cTrader returned no symbols for this account");
    }

    const connectionId = await withTransaction(this.database, async (client) => {
      const mapping = await resolveOwnedAccountMapping(client, input.auth.user.id, input.mappedLegacyAccountId);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`${input.auth.user.id}:ctrader:${accountId}`],
      );
      const identity = await resolveConnectionIdentity(
        client,
        input.auth.user.id,
        environment,
        accountId,
        "mcp_read",
      );
      const id = identity.row?.id ?? randomUUID();
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [id]);
      if (identity.adoptsLegacyEnvironment) {
        const adopted = await client.query<{ id: string }>(
          `UPDATE broker_connections SET provider_environment=$1
           WHERE id=$2 AND connected=false AND provider_environment IS NULL
           RETURNING id`,
          [environment, id],
        );
        if (!adopted.rows[0]) {
          throw new AppError(409, "CTRADER_CONNECTION_CHANGED", "The legacy cTrader connection changed while reconnecting");
        }
      }
      const previousMetadata = identity.row?.connection_mode === "mcp_read"
        ? objectValue(identity.row.provider_metadata)
        : {};
      const previousFloorKind = String(previousMetadata.historyFloorKind ?? "");
      const previousFloorTimestamp = firstTimestamp([previousMetadata], ["historyFloorTimestamp"]);
      const previousAttestation = objectValue(previousMetadata.noOpenPositionsAttestation);
      const previousAttestationIsValid = previousFloorTimestamp !== null
        && previousAttestation.version === 1
        && previousAttestation.userId === input.auth.user.id
        && previousAttestation.connectionId === id
        && previousAttestation.accountId === accountId
        && previousAttestation.environment === environment
        && previousAttestation.boundaryTimestamp === previousFloorTimestamp;
      const createsAttestedBoundary = input.acknowledgeNoOpenPositionsAtConnect === true
        && previousFloorKind !== "connection_time_empty_attested";
      const derivedFloorKind = input.acknowledgeNoOpenPositionsAtConnect === true
        ? "connection_time_empty_attested"
        : registrationTimestamp !== null
          ? "registration"
          : "connection_time";
      const derivedFloorTimestamp = derivedFloorKind === "registration"
        ? registrationTimestamp!
        : connectionAttemptStartedAt;
      const hasStrongerRegistrationFloor = previousFloorTimestamp !== null
        && previousFloorKind === "connection_time"
        && derivedFloorKind === "registration"
        && derivedFloorTimestamp < previousFloorTimestamp;
      const preservesPreviousFloor = identity.row?.connection_mode === "mcp_read"
        && previousFloorTimestamp !== null
        && ["registration", "connection_time", "connection_time_empty_attested"].includes(previousFloorKind)
        && (previousFloorKind !== "connection_time_empty_attested" || previousAttestationIsValid)
        // Registration is an authoritative earlier lower bound. Adopting it
        // requires a cursor reset so the disconnected gap and older history
        // are backfilled atomically.
        && !hasStrongerRegistrationFloor
        && !createsAttestedBoundary;
      const historyFloorKind = preservesPreviousFloor ? previousFloorKind : derivedFloorKind;
      const historyFloorTimestamp = preservesPreviousFloor ? previousFloorTimestamp : derivedFloorTimestamp;
      const resetsHistoryCursor = identity.row?.connection_mode === "mcp_read" && !preservesPreviousFloor;
      const openingLineagePolicy = historyFloorKind === "registration"
        ? "registration_history"
        : historyFloorKind === "connection_time_empty_attested"
          ? "user_attested_empty_at_connection"
          : "provider_role_required";
      const noOpenPositionsAttestation = preservesPreviousFloor
        && historyFloorKind === "connection_time_empty_attested"
        ? previousAttestation
        : historyFloorKind === "connection_time_empty_attested"
        ? {
            version: 1,
            userId: input.auth.user.id,
            connectionId: id,
            accountId,
            environment,
            boundaryTimestamp: historyFloorTimestamp,
            acknowledgedAt: new Date(historyFloorTimestamp).toISOString(),
          }
        : null;
      const metadata = {
        ...previousMetadata,
        integrationMode: "mcp_read",
        mcpEndpoint: "https://mcp.ctrader.com/trading/mcp",
        sessionBound: true,
        credentialCanTrade: true,
        tradingCredentialRiskAcknowledgedAt: new Date().toISOString(),
        edgebookToolPolicy: "read_allowlist",
        accountCurrency: currency?.toUpperCase() ?? null,
        registrationTimestamp,
        symbolCount,
        historyReadValidated: true,
        historyFloorTimestamp,
        historyFloorKind,
        openingLineagePolicy,
        noOpenPositionsAttestation,
        legacyEnvironmentWasUnbound: identity.adoptsLegacyEnvironment
          || previousMetadata.legacyEnvironmentWasUnbound === true,
        readOnly: true,
        reauthRequired: false,
      };
      await client.query(
        `INSERT INTO broker_connections (
           id, user_id, provider, connection_mode, provider_environment, oauth_scope,
           external_account_id, account_label, mapped_account_id,
           legacy_mapped_account_id, connected, access_token_ciphertext,
           refresh_token_ciphertext, encryption_key_version, token_expires_at,
           token_generation, provider_metadata, connected_at, disconnected_at,
           disconnect_reason
         ) VALUES (
           $1,$2,'ctrader','mcp_read',$3,'mcp_read',$4,$5,$6,$7,true,$8,
           NULL,$9,NULL,1,$10::jsonb,now(),NULL,NULL
         )
         ON CONFLICT (user_id, provider, provider_environment, external_account_id)
           WHERE external_account_id IS NOT NULL
         DO UPDATE SET
           sync_cursor=CASE
             WHEN broker_connections.connection_mode IS DISTINCT FROM EXCLUDED.connection_mode OR $11::boolean
               THEN '{}'::jsonb
             ELSE broker_connections.sync_cursor
           END,
           last_sync_at=CASE
             WHEN broker_connections.connection_mode IS DISTINCT FROM EXCLUDED.connection_mode OR $11::boolean
               THEN NULL
             ELSE broker_connections.last_sync_at
           END,
           connection_mode=EXCLUDED.connection_mode,
           oauth_scope=EXCLUDED.oauth_scope,
           account_label=EXCLUDED.account_label,
           mapped_account_id=EXCLUDED.mapped_account_id,
           legacy_mapped_account_id=EXCLUDED.legacy_mapped_account_id,
           connected=true,
           access_token_ciphertext=EXCLUDED.access_token_ciphertext,
           refresh_token_ciphertext=NULL,
           encryption_key_version=EXCLUDED.encryption_key_version,
           token_expires_at=NULL,
           token_generation=broker_connections.token_generation+1,
           token_refreshed_at=now(),
           provider_metadata=EXCLUDED.provider_metadata,
           connected_at=now(),
           disconnected_at=NULL,
           disconnect_reason=NULL`,
        [
          id,
          input.auth.user.id,
          environment,
          accountId,
          input.label,
          mapping.internalId,
          mapping.legacyId,
          this.cipher.encrypt(validation.bearerToken, connectionTokenAad(id, "access")),
          this.cipher.activeKeyVersion,
          JSON.stringify(metadata),
          resetsHistoryCursor,
        ],
      );
      await client.query(
        `INSERT INTO sync_runs (
           id, broker_connection_id, job_key, sync_type, status,
           requested_by_user_id, counters
         ) VALUES ($1,$2,$3,'initial','queued',$4,'{}'::jsonb)
         ON CONFLICT DO NOTHING`,
        [randomUUID(), id, `mcp-connect:${Date.now()}`, input.auth.user.id],
      );
      return id;
    });

    const connection = await this.findConnection(input.auth.user.id, connectionId);
    await this.events.publish(input.auth.user.id, "ctrader.connected", {
      connectionId,
      mode: "mcp_read",
    }).catch(() => undefined);
    return connection;
  }

  async listConnections(userId: string): Promise<CTraderPublicConnection[]> {
    const result = await this.database.query<ConnectionRow>(
      `${connectionSelect}
       WHERE c.user_id=$1 AND c.provider='ctrader'
         AND c.connection_mode IN ('official','mcp_read')
         AND c.provider_environment IS NOT NULL
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
        [`${input.auth.user.id}:ctrader:${selected.ctidTraderAccountId}`],
      );
      const identity = await resolveConnectionIdentity(
        client,
        input.auth.user.id,
        selected.environment,
        selected.ctidTraderAccountId,
        "official",
      );
      const id = identity.row?.id ?? randomUUID();
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [id]);
      if (identity.adoptsLegacyEnvironment) {
        const adopted = await client.query<{ id: string }>(
          `UPDATE broker_connections SET provider_environment=$1
           WHERE id=$2 AND connected=false AND provider_environment IS NULL
           RETURNING id`,
          [selected.environment, id],
        );
        if (!adopted.rows[0]) {
          throw new AppError(409, "CTRADER_CONNECTION_CHANGED", "The legacy cTrader connection changed while reconnecting");
        }
      }

      const accessToken = this.cipher.decrypt(grant.access_token_ciphertext, grantTokenAad(grant.id, "access"));
      const refreshToken = this.cipher.decrypt(grant.refresh_token_ciphertext, grantTokenAad(grant.id, "refresh"));
      const previousMetadata = objectValue(identity.row?.provider_metadata);
      const metadata = {
        brokerTitleShort: selected.brokerTitleShort,
        traderLogin: selected.traderLogin,
        lastClosingDealTimestamp: selected.lastClosingDealTimestamp,
        lastBalanceUpdateTimestamp: selected.lastBalanceUpdateTimestamp,
        permissionScope: "accounts",
        legacyEnvironmentWasUnbound: identity.adoptsLegacyEnvironment
          || previousMetadata.legacyEnvironmentWasUnbound === true,
        readOnly: true,
        reauthRequired: false,
      };
      await client.query(
        `INSERT INTO broker_connections (
           id, user_id, provider, connection_mode, provider_environment, oauth_scope,
           external_account_id, account_label, mapped_account_id,
           legacy_mapped_account_id, connected, access_token_ciphertext,
           refresh_token_ciphertext, encryption_key_version, token_expires_at,
           token_generation, provider_metadata, connected_at, disconnected_at,
           disconnect_reason
         ) VALUES (
           $1,$2,'ctrader','official',$3,'accounts',$4,$5,$6,$7,true,$8,$9,$10,$11,
           1,$12::jsonb,now(),NULL,NULL
         )
         ON CONFLICT (user_id, provider, provider_environment, external_account_id)
           WHERE external_account_id IS NOT NULL
         DO UPDATE SET
           sync_cursor=CASE
             WHEN broker_connections.connection_mode IS DISTINCT FROM EXCLUDED.connection_mode THEN '{}'::jsonb
             ELSE broker_connections.sync_cursor
           END,
           last_sync_at=CASE
             WHEN broker_connections.connection_mode IS DISTINCT FROM EXCLUDED.connection_mode THEN NULL
             ELSE broker_connections.last_sync_at
           END,
           connection_mode=EXCLUDED.connection_mode,
           oauth_scope=EXCLUDED.oauth_scope,
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
           provider_metadata=EXCLUDED.provider_metadata,
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
        connection_mode: "official" | "mcp_read";
        access_token_ciphertext: string | null;
        refresh_token_ciphertext: string | null;
      }>(
        `SELECT connected, connection_mode, access_token_ciphertext, refresh_token_ciphertext
         FROM broker_connections
         WHERE id=$1 AND user_id=$2 AND provider='ctrader'
           AND connection_mode IN ('official','mcp_read')
           AND provider_environment IS NOT NULL
         FOR UPDATE`,
        [connectionId, userId],
      );
      const row = connection.rows[0];
      if (!row) throw notFound("cTrader connection");
      if (
        !row.connected
        || !row.access_token_ciphertext
        || (row.connection_mode === "official" && !row.refresh_token_ciphertext)
      ) {
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
           AND connection_mode IN ('official','mcp_read')
           AND provider_environment IS NOT NULL
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
           AND connection_mode IN ('official','mcp_read')
           AND provider_environment IS NOT NULL
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

  private officialClients(): { oauth: CTraderOAuthClient; gateway: CTraderGateway } {
    if (!this.config.cTrader.enabled || !this.oauth || !this.gateway) {
      throw new AppError(503, "CTRADER_NOT_CONFIGURED", "cTrader OAuth is not configured on this server");
    }
    return { oauth: this.oauth, gateway: this.gateway };
  }

  private async findConnection(userId: string, connectionId: string): Promise<CTraderPublicConnection> {
    return mapConnection(await this.findConnectionRow(userId, connectionId));
  }

  private async findConnectionRow(userId: string, connectionId: string): Promise<ConnectionRow> {
    const result = await this.database.query<ConnectionRow>(
      `${connectionSelect}
       WHERE c.id=$1 AND c.user_id=$2 AND c.provider='ctrader'
         AND c.connection_mode IN ('official','mcp_read')
         AND c.provider_environment IS NOT NULL
       LIMIT 1`,
      [connectionId, userId],
    );
    const row = result.rows[0];
    if (!row) throw notFound("cTrader connection");
    return row;
  }
}
