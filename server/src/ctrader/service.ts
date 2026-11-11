import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/database.js";
import { withTransaction } from "../db/database.js";
import type { EventBus } from "../events/event-bus.js";
import { createOpaqueToken, hashToken } from "../auth/tokens.js";
import { AppError, notFound } from "../lib/errors.js";
import { decodeCursor, encodeCursor } from "../lib/pagination.js";
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
  sync_cursor: unknown;
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

type AccountCashFlowRow = QueryResultRow & {
  external_cash_flow_id: string;
  operation_type: number | null;
  operation_name: string;
  amount: string | null;
  balance: string | null;
  equity: string | null;
  raw_delta: string;
  raw_balance: string;
  raw_equity: string | null;
  currency_code: string;
  money_digits: number | null;
  money_digits_source: "cash_flow" | "account" | "unavailable";
  balance_version: string | null;
  occurred_at: Date | string;
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
  accountBalance: string | null;
  accountBalanceRawUnits: string | null;
  accountBalanceMoneyDigits: number | null;
  accountBalanceVersion: string | null;
  accountBalanceAsOf: string | null;
  accountBalanceSource: "ProtoOATrader" | null;
  accountBalanceScalingStatus: "exact" | "money_digits_unavailable" | "not_synced";
  accountCashFlowHistoryComplete: boolean;
  accountCashFlowHistoryStartTimestamp: number | null;
  accountCashFlowSyncedThroughTimestamp: number | null;
  accountCashFlowMonetaryScaleComplete: boolean;
  accountCashFlowTotalRows: number;
  accountCashFlowScaledRows: number;
  accountCashFlowUnscaledRows: number;
  accountCashFlowPendingScaleRetries: number;
  tradeHistoryComplete: boolean;
  tradeHistoryStartTimestamp: number | null;
  tradeHistorySyncedThroughTimestamp: number | null;
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

export type CTraderPublicAccountCashFlow = {
  balanceHistoryId: string;
  operationType: number | null;
  operationName: string;
  amount: string | null;
  balance: string | null;
  equity: string | null;
  rawAmountUnits: string;
  rawBalanceUnits: string;
  rawEquityUnits: string | null;
  currency: string;
  moneyDigits: number | null;
  moneyDigitsSource: "cash_flow" | "unavailable";
  balanceVersion: string | null;
  occurredAt: string;
  category: "funding" | "trading_related_adjustment" | "non_trading_economics" | "bonus_or_protection" | "unknown";
  includedInTradePnl: false;
  positionAttribution: "not_available_from_ctrader";
  scalingStatus: "exact" | "money_digits_unavailable";
};

export type CTraderHistoricalImport = {
  id: string;
  connectionId: string;
  status: string;
  boundaryAt: string;
  boundaryLocal: string;
  timeZone: string;
  throughAt: string;
  normalHistoryFloorAt: string;
  normalHistoryFloorKind: "connection_time_empty_attested";
  acknowledgedAt: string;
  acknowledgeNoOpenPositionsAtBoundary: true;
  clientRequestId: string;
  counters: Record<string, unknown>;
  error: { code: string | null; message: string } | null;
  version: number;
  createdAt: string;
  finishedAt: string | null;
  replayed?: boolean;
};

export type CTraderReconciliationAction =
  | "link_manual"
  | "publish_separate"
  | "suppress_deleted"
  | "reject";

export type CTraderReconciliationCandidate = {
  id: string;
  importId: string;
  version: number;
  status: string;
  classification: "high_confidence" | "ambiguous" | "deleted_manual" | "unmatched" | "execution_only";
  confidence: number;
  reasons: unknown[];
  differences: Record<string, unknown>;
  allowedActions: CTraderReconciliationAction[];
  resolutionAction: CTraderReconciliationAction | null;
  resolutionClientRequestId: string | null;
  manualTrade: null | {
    id: string;
    version: number | null;
    deleted: boolean;
    symbol: string;
    direction: string;
    date: string;
    hasStrategy: boolean;
    hasEmotion: boolean;
    hasPsychology: boolean;
    hasNotes: boolean;
    screenshotCount: number;
  };
  brokerTrade: Record<string, unknown>;
};

export type CTraderLiveReconciliationAction = CTraderReconciliationAction;

export type CTraderLiveReconciliationCandidate = {
  id: string;
  version: number;
  status: string;
  classification: "high_confidence" | "ambiguous" | "deleted_manual" | "existing_pair";
  confidence: number;
  reasons: unknown[];
  differences: Record<string, unknown>;
  allowedActions: CTraderLiveReconciliationAction[];
  resolutionAction: CTraderLiveReconciliationAction | null;
  resolutionClientRequestId: string | null;
  manualTrade: (NonNullable<CTraderReconciliationCandidate["manualTrade"]> & { hasCustomFields?: boolean }) | null;
  manualChoices: Array<NonNullable<CTraderReconciliationCandidate["manualTrade"]> & { hasCustomFields?: boolean }>;
  brokerTrade: Record<string, unknown>;
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
    accountCashFlowHistoryComplete: boolean;
    accountCashFlowHistoryStartTimestamp: number | null;
    accountCashFlowSyncedThroughTimestamp: number | null;
    accountCashFlowMonetaryScaleComplete: boolean;
    accountCashFlowTotalRows: number;
    accountCashFlowScaledRows: number;
    accountCashFlowUnscaledRows: number;
    accountCashFlowPendingScaleRetries: number;
    tradeHistoryComplete: boolean;
    tradeHistoryStartTimestamp: number | null;
    tradeHistorySyncedThroughTimestamp: number | null;
    latestSyncRun: CTraderPublicSyncRun | null;
    historicalImport: CTraderHistoricalImport | null;
    accountCashFlows: CTraderPublicAccountCashFlow[];
  }>;
  listAccountCashFlows(input: {
    userId: string;
    connectionId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ accountCashFlows: CTraderPublicAccountCashFlow[]; nextCursor: string | null }>;
  queueManualSync(userId: string, connectionId: string): Promise<{ syncRunId: string; status: "queued" }>;
  startHistoricalImport(input: {
    auth: AuthContext;
    connectionId: string;
    boundaryLocal: string;
    timeZone: string;
    boundaryAt: string;
    acknowledgeNoOpenPositionsAtBoundary: true;
    clientRequestId: string;
    idempotencyKey: string;
  }): Promise<CTraderHistoricalImport>;
  currentHistoricalImport(userId: string, connectionId: string): Promise<CTraderHistoricalImport | null>;
  listReconciliationCandidates(userId: string, connectionId: string, importId: string): Promise<{
    historicalImport: CTraderHistoricalImport;
    candidates: CTraderReconciliationCandidate[];
  }>;
  resolveReconciliationCandidate(input: {
    auth: AuthContext;
    connectionId: string;
    candidateId: string;
    importId: string;
    action: CTraderReconciliationAction;
    expectedVersion: number;
    clientRequestId: string;
    idempotencyKey: string;
  }): Promise<{ candidate: CTraderReconciliationCandidate; historicalImport: CTraderHistoricalImport }>;
  listLiveReconciliationCandidates(userId: string, connectionId: string): Promise<{
    candidates: CTraderLiveReconciliationCandidate[];
  }>;
  getLiveReconciliationCandidate(userId: string, connectionId: string, candidateId: string): Promise<{
    candidate: CTraderLiveReconciliationCandidate;
  }>;
  resolveLiveReconciliationCandidate(input: {
    auth: AuthContext;
    connectionId: string;
    candidateId: string;
    action: CTraderLiveReconciliationAction;
    manualTradeId: string | null;
    expectedVersion: number;
    clientRequestId: string;
    idempotencyKey: string;
  }): Promise<{ candidate: CTraderLiveReconciliationCandidate }>;
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

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function requestHash(value: unknown): Buffer {
  return createHash("sha256").update(stableJson(value)).digest();
}

function localMinuteAt(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function validateHistoricalBoundary(boundaryLocal: string, timeZone: string, boundaryAt: string): Date {
  let formatter: Intl.DateTimeFormat;
  try { formatter = new Intl.DateTimeFormat("en-CA", { timeZone }); } catch {
    throw new AppError(400, "TIME_ZONE_INVALID", "timeZone must be a supported IANA time zone");
  }
  void formatter;
  const boundary = new Date(boundaryAt);
  if (!Number.isFinite(boundary.getTime()) || boundary.getUTCSeconds() !== 0 || boundary.getUTCMilliseconds() !== 0) {
    throw new AppError(400, "HISTORICAL_BOUNDARY_INVALID", "boundaryAt must identify an exact minute");
  }
  if (localMinuteAt(boundary, timeZone) !== boundaryLocal) {
    throw new AppError(400, "HISTORICAL_BOUNDARY_MISMATCH", "boundaryAt does not match boundaryLocal in timeZone");
  }
  let matchingInstants = 0;
  for (let offset = -240; offset <= 240; offset += 15) {
    if (localMinuteAt(new Date(boundary.getTime() + offset * 60_000), timeZone) === boundaryLocal) matchingInstants += 1;
  }
  if (matchingInstants !== 1) {
    throw new AppError(400, "HISTORICAL_BOUNDARY_AMBIGUOUS", "The selected local time is ambiguous in this time zone");
  }
  if (boundary.getTime() > Date.now() || boundary.getTime() < Date.now() - 5 * 366 * 24 * 60 * 60 * 1_000) {
    throw new AppError(400, "HISTORICAL_BOUNDARY_OUT_OF_RANGE", "The historical boundary must be within the past five years");
  }
  return boundary;
}

function approvedNormalHistoryFloor(input: {
  providerMetadata: unknown;
  userId: string;
  connectionId: string;
  accountId: string;
  environment: CTraderEnvironment;
}): { at: Date; kind: CTraderHistoricalImport["normalHistoryFloorKind"] } {
  const metadata = objectValue(input.providerMetadata);
  const kind = metadata.historyFloorKind;
  if (
    metadata.historyReadValidated !== true
    || kind !== "connection_time_empty_attested"
  ) {
    throw new AppError(
      409,
      "CTRADER_HISTORY_FLOOR_UNAPPROVED",
      "Reconnect cTrader to establish an approved normal-history boundary before importing earlier history",
    );
  }
  const rawFloor = metadata.historyFloorTimestamp;
  const timestamp = typeof rawFloor === "number" && Number.isSafeInteger(rawFloor)
    ? rawFloor
    : typeof rawFloor === "string" && /^\d+$/.test(rawFloor)
      ? Number(rawFloor)
      : Number.NaN;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > Date.now()) {
    throw new AppError(409, "CTRADER_HISTORY_FLOOR_INVALID", "The approved normal-history boundary is invalid");
  }
  const attestation = objectValue(metadata.noOpenPositionsAttestation);
  if (
    attestation.version !== 1
    || attestation.userId !== input.userId
    || attestation.connectionId !== input.connectionId
    || attestation.accountId !== input.accountId
    || attestation.environment !== input.environment
    || Number(attestation.boundaryTimestamp) !== timestamp
  ) {
    throw new AppError(
      409,
      "CTRADER_HISTORY_FLOOR_INVALID",
      "The approved normal-history boundary proof no longer matches this account",
    );
  }
  return {
    at: new Date(timestamp),
    kind: "connection_time_empty_attested",
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

const providerControlCharacters = /[\u0000-\u001f\u007f-\u009f]/u;

function providerText(
  value: unknown,
  field: string,
  maxLength: number,
  allowFiniteNumber = false,
): string | null {
  if (value === undefined || value === null) return null;
  const candidate = typeof value === "string"
    ? value
    : allowFiniteNumber && typeof value === "number" && Number.isFinite(value)
      ? String(value)
      : null;
  if (candidate === null) {
    throw new AppError(502, "CTRADER_PROVIDER_METADATA_INVALID", `cTrader returned an invalid ${field}`);
  }
  // Check before trimming so a provider cannot hide an oversized value in
  // whitespace or persist terminal/control characters in connection metadata.
  if (candidate.length > maxLength || providerControlCharacters.test(candidate)) {
    throw new AppError(502, "CTRADER_PROVIDER_METADATA_INVALID", `cTrader returned an invalid ${field}`);
  }
  const normalized = candidate.trim();
  return normalized.length === 0 ? null : normalized;
}

function firstText(
  objects: readonly Record<string, unknown>[],
  keys: readonly string[],
  options: { field: string; maxLength: number; allowFiniteNumber?: boolean },
): string | null {
  for (const object of objects) {
    for (const key of keys) {
      const value = object[key];
      if (value === undefined || value === null || value === "") continue;
      const normalized = providerText(
        value,
        options.field,
        options.maxLength,
        options.allowFiniteNumber === true,
      );
      if (normalized !== null) return normalized;
    }
  }
  return null;
}

function sanitizeAuthorizedAccount(account: CTraderAuthorizedAccount): CTraderAuthorizedAccount {
  const accountId = providerText(account.ctidTraderAccountId, "account identifier", 20);
  if (accountId === null || !/^(?:0|[1-9]\d{0,19})$/.test(accountId)) {
    throw new AppError(502, "CTRADER_PROVIDER_METADATA_INVALID", "cTrader returned an invalid account identifier");
  }
  const traderLogin = providerText(account.traderLogin, "trader login", 20);
  if (traderLogin !== null && !/^(?:0|[1-9]\d{0,19})$/.test(traderLogin)) {
    throw new AppError(502, "CTRADER_PROVIDER_METADATA_INVALID", "cTrader returned an invalid trader login");
  }
  const brokerTitleShort = providerText(account.brokerTitleShort, "broker title", 120);
  return { ...account, ctidTraderAccountId: accountId, traderLogin, brokerTitleShort };
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

function strictProviderHistoryTimestamp(value: unknown): number | null {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= 2_147_483_646_000
    ? value
    : null;
}

function strictProviderCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

type PublicTradeHistoryCoverage = {
  tradeHistoryComplete: boolean;
  tradeHistoryStartTimestamp: number | null;
  tradeHistorySyncedThroughTimestamp: number | null;
};

function incompleteTradeHistoryCoverage(): PublicTradeHistoryCoverage {
  return {
    tradeHistoryComplete: false,
    tradeHistoryStartTimestamp: null,
    tradeHistorySyncedThroughTimestamp: null,
  };
}

/**
 * Public completeness is deliberately stronger than "the requested window was
 * exhausted".  It requires a registration-floor cursor written by a successful
 * sync and agreement with the server-owned connection metadata. Bounded MCP
 * floors remain useful for ingestion but can never claim complete history.
 */
function tradeHistoryCoverage(row: ConnectionRow): PublicTradeHistoryCoverage {
  const cursor = objectValue(row.sync_cursor);
  const metadata = objectValue(row.provider_metadata);
  if (cursor.version !== 1 || cursor.fullHistoryComplete !== true) {
    return incompleteTradeHistoryCoverage();
  }
  const lastSuccessfulSyncAt = row.last_sync_at === null ? Number.NaN : new Date(row.last_sync_at).getTime();
  if (!Number.isFinite(lastSuccessfulSyncAt)) return incompleteTradeHistoryCoverage();

  let start: number | null = null;
  const through = strictProviderHistoryTimestamp(cursor.syncedThroughTimestamp);
  if (row.connection_mode === "official") {
    const cursorRegistration = strictProviderHistoryTimestamp(cursor.registrationTimestamp);
    const metadataRegistration = strictProviderHistoryTimestamp(metadata.registrationTimestamp);
    if (cursorRegistration === null || metadataRegistration !== cursorRegistration) {
      return incompleteTradeHistoryCoverage();
    }
    start = cursorRegistration;
  } else {
    // A connection-time floor (including a user-attested empty boundary) is a
    // bounded view, not proof that earlier broker trades do not exist.
    if (metadata.historyReadValidated !== true
      || metadata.historyFloorKind !== "registration"
      || cursor.historyFloorKind !== "registration"
      || cursor.historyWindowComplete !== true) {
      return incompleteTradeHistoryCoverage();
    }
    const metadataRegistration = strictProviderHistoryTimestamp(metadata.registrationTimestamp);
    const metadataFloor = strictProviderHistoryTimestamp(metadata.historyFloorTimestamp);
    const cursorStart = strictProviderHistoryTimestamp(cursor.historyStartTimestamp);
    if (metadataRegistration === null
      || metadataFloor !== metadataRegistration
      || cursorStart !== metadataRegistration) {
      return incompleteTradeHistoryCoverage();
    }
    start = metadataRegistration;
  }

  if (start === null || through === null || start > through || through > lastSuccessfulSyncAt) {
    return incompleteTradeHistoryCoverage();
  }
  return {
    tradeHistoryComplete: true,
    tradeHistoryStartTimestamp: start,
    tradeHistorySyncedThroughTimestamp: through,
  };
}

function mapConnection(row: ConnectionRow): CTraderPublicConnection {
  const metadata = objectValue(row.provider_metadata);
  const errorMessage = row.latest_sync_error_message ?? stringOrNull(metadata.lastErrorMessage);
  const errorCode = row.latest_sync_error_code ?? stringOrNull(metadata.lastErrorCode);
  const warningMessage = stringOrNull(metadata.lastWarningMessage);
  const warningCode = stringOrNull(metadata.lastWarningCode);
  const balanceMoneyDigits = typeof metadata.accountBalanceMoneyDigits === "number"
    && Number.isInteger(metadata.accountBalanceMoneyDigits)
    && metadata.accountBalanceMoneyDigits >= 0
    && metadata.accountBalanceMoneyDigits <= 18
    ? metadata.accountBalanceMoneyDigits
    : null;
  const balanceSource = metadata.accountBalanceSource === "ProtoOATrader" ? "ProtoOATrader" : null;
  const balanceScalingStatus = balanceSource === null
    ? "not_synced"
    : metadata.accountBalanceScalingStatus === "exact"
      ? "exact"
      : "money_digits_unavailable";
  const cashFlowHistoryStartTimestamp = strictProviderHistoryTimestamp(
    metadata.accountCashFlowHistoryStartTimestamp,
  );
  const cashFlowSyncedThroughTimestamp = strictProviderHistoryTimestamp(
    metadata.accountCashFlowSyncedThroughTimestamp,
  );
  const cashFlowHistoryComplete = metadata.accountCashFlowHistoryComplete === true
    && cashFlowHistoryStartTimestamp !== null
    && cashFlowSyncedThroughTimestamp !== null
    && cashFlowHistoryStartTimestamp <= cashFlowSyncedThroughTimestamp;
  const cashFlowTotalRowsValue = strictProviderCount(metadata.accountCashFlowTotalRows);
  const cashFlowScaledRowsValue = strictProviderCount(metadata.accountCashFlowScaledRows);
  const cashFlowUnscaledRowsValue = strictProviderCount(metadata.accountCashFlowUnscaledRows);
  const cashFlowPendingScaleRetriesValue = strictProviderCount(metadata.accountCashFlowPendingScaleRetries);
  const cashFlowMonetaryScaleComplete = metadata.accountCashFlowMonetaryScaleComplete === true
    && cashFlowTotalRowsValue !== null
    && cashFlowScaledRowsValue !== null
    && cashFlowUnscaledRowsValue !== null
    && cashFlowPendingScaleRetriesValue !== null
    && cashFlowScaledRowsValue + cashFlowUnscaledRowsValue === cashFlowTotalRowsValue
    && cashFlowUnscaledRowsValue === 0
    && cashFlowPendingScaleRetriesValue === 0;
  const cashFlowTotalRows = cashFlowTotalRowsValue ?? 0;
  const cashFlowScaledRows = cashFlowScaledRowsValue ?? 0;
  const cashFlowUnscaledRows = cashFlowUnscaledRowsValue ?? 0;
  const cashFlowPendingScaleRetries = cashFlowPendingScaleRetriesValue ?? 0;
  const tradeHistory = tradeHistoryCoverage(row);
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
    accountBalance: stringOrNull(metadata.accountBalance),
    accountBalanceRawUnits: stringOrNull(metadata.accountBalanceRawUnits),
    accountBalanceMoneyDigits: balanceMoneyDigits,
    accountBalanceVersion: stringOrNull(metadata.accountBalanceVersion),
    accountBalanceAsOf: stringOrNull(metadata.accountBalanceAsOf),
    accountBalanceSource: balanceSource,
    accountBalanceScalingStatus: balanceScalingStatus,
    accountCashFlowHistoryComplete: cashFlowHistoryComplete,
    accountCashFlowHistoryStartTimestamp: cashFlowHistoryComplete ? cashFlowHistoryStartTimestamp : null,
    accountCashFlowSyncedThroughTimestamp: cashFlowHistoryComplete ? cashFlowSyncedThroughTimestamp : null,
    accountCashFlowMonetaryScaleComplete: cashFlowMonetaryScaleComplete,
    accountCashFlowTotalRows: cashFlowTotalRows,
    accountCashFlowScaledRows: cashFlowScaledRows,
    accountCashFlowUnscaledRows: cashFlowUnscaledRows,
    accountCashFlowPendingScaleRetries: cashFlowPendingScaleRetries,
    ...tradeHistory,
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

function canonicalDatabaseDecimal(value: string | null): string | null {
  if (value === null) return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) throw new Error("Stored cTrader account cash-flow amount is malformed");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const unsigned = `${match[2]}${fraction.length > 0 ? `.${fraction}` : ""}`;
  return /^0(?:\.0*)?$/.test(unsigned) ? "0" : `${match[1]}${unsigned}`;
}

export function accountCashFlowCategory(
  operationType: number | null,
): CTraderPublicAccountCashFlow["category"] {
  if (operationType === null) return "unknown";
  if ([0, 1, 30, 31, 32, 33, 36, 37].includes(operationType)) return "funding";
  if ([15, 16, 17, 18, 21, 22, 34, 35].includes(operationType)) return "trading_related_adjustment";
  if ((operationType >= 3 && operationType <= 14) || (operationType >= 27 && operationType <= 29)) {
    return "non_trading_economics";
  }
  if ([19, 20, 38, 39].includes(operationType)) return "bonus_or_protection";
  return "unknown";
}

function mapAccountCashFlow(row: AccountCashFlowRow): CTraderPublicAccountCashFlow {
  const exactRowScale = row.money_digits_source === "cash_flow" && row.money_digits !== null;
  return {
    balanceHistoryId: row.external_cash_flow_id,
    operationType: row.operation_type,
    operationName: row.operation_name,
    amount: exactRowScale ? canonicalDatabaseDecimal(row.amount) : null,
    balance: exactRowScale ? canonicalDatabaseDecimal(row.balance) : null,
    equity: exactRowScale ? canonicalDatabaseDecimal(row.equity) : null,
    rawAmountUnits: row.raw_delta,
    rawBalanceUnits: row.raw_balance,
    rawEquityUnits: row.raw_equity,
    currency: row.currency_code,
    moneyDigits: exactRowScale ? row.money_digits : null,
    moneyDigitsSource: exactRowScale ? "cash_flow" : "unavailable",
    balanceVersion: row.balance_version,
    occurredAt: new Date(row.occurred_at).toISOString(),
    category: accountCashFlowCategory(row.operation_type),
    includedInTradePnl: false,
    positionAttribution: "not_available_from_ctrader",
    scalingStatus: exactRowScale ? "exact" : "money_digits_unavailable",
  };
}

type HistoricalImportRow = QueryResultRow & {
  id: string;
  broker_connection_id: string;
  status: string;
  boundary_at: Date | string;
  boundary_local: string;
  time_zone: string;
  through_at: Date | string;
  normal_history_floor_at_request: Date | string;
  normal_history_floor_kind_at_request: CTraderHistoricalImport["normalHistoryFloorKind"];
  acknowledged_at: Date | string;
  no_open_positions_attested: boolean;
  client_request_id: string;
  counters: unknown;
  error_code: string | null;
  error_message: string | null;
  row_version: number;
  created_at: Date | string;
  finished_at: Date | string | null;
};

type ReconciliationCandidateRow = QueryResultRow & {
  id: string;
  import_id: string;
  row_version: number;
  status: string;
  classification: CTraderReconciliationCandidate["classification"];
  confidence: number;
  reasons: unknown;
  differences: unknown;
  projected_trade: unknown;
  manual_trade_id: string | null;
  manual_row_version: number | null;
  manual_deleted_at: Date | string | null;
  manual_symbol: string | null;
  manual_direction: string | null;
  manual_trade_date: Date | string | null;
  manual_has_psychology: boolean | null;
  manual_has_notes: boolean | null;
  manual_has_strategy: boolean | null;
  manual_has_emotion: boolean | null;
  screenshot_count: number | string | null;
  resolution_action: CTraderReconciliationAction | null;
  resolution_client_request_id: string | null;
};

function mapHistoricalImport(row: HistoricalImportRow, replayed = false): CTraderHistoricalImport {
  return {
    id: row.id,
    connectionId: row.broker_connection_id,
    status: row.status,
    boundaryAt: new Date(row.boundary_at).toISOString(),
    boundaryLocal: row.boundary_local,
    timeZone: row.time_zone,
    throughAt: new Date(row.through_at).toISOString(),
    normalHistoryFloorAt: new Date(row.normal_history_floor_at_request).toISOString(),
    normalHistoryFloorKind: row.normal_history_floor_kind_at_request,
    acknowledgedAt: new Date(row.acknowledged_at).toISOString(),
    acknowledgeNoOpenPositionsAtBoundary: true,
    clientRequestId: row.client_request_id,
    counters: objectValue(row.counters),
    error: row.error_message === null ? null : { code: row.error_code, message: row.error_message },
    version: row.row_version,
    createdAt: new Date(row.created_at).toISOString(),
    finishedAt: iso(row.finished_at),
    ...(replayed ? { replayed: true } : {}),
  };
}

function candidateAllowedActions(row: ReconciliationCandidateRow): CTraderReconciliationAction[] {
  if (row.status !== "pending") return [];
  const projection = objectValue(row.projected_trade);
  const canPublish = row.projected_trade !== null
    && !(
      projection.isOpen === false
      && (projection.pnl === null || projection.pnl === undefined)
      && !projectionHasCalculatedGross(projection)
    );
  if (row.classification === "high_confidence") {
    return canPublish ? ["link_manual", "publish_separate", "reject"] : ["link_manual", "reject"];
  }
  if (row.classification === "ambiguous" || row.classification === "unmatched") {
    return canPublish ? ["publish_separate", "reject"] : ["reject"];
  }
  if (row.classification === "deleted_manual") return ["suppress_deleted", "reject"];
  return ["reject"];
}

function mapReconciliationCandidate(row: ReconciliationCandidateRow): CTraderReconciliationCandidate {
  const broker = objectValue(row.projected_trade);
  const brokerSummary = Object.fromEntries([
    "positionId", "symbol", "direction", "entryPrice", "exitPrice",
    "quantity", "quantityUnit", "quantityLots", "quantityBaseUnits",
    "pnl", "isOpen", "tradeDate", "entryAt", "exitAt",
  ].filter((key) => Object.prototype.hasOwnProperty.call(broker, key)).map((key) => [key, broker[key]]));
  return {
    id: row.id,
    importId: row.import_id,
    version: row.row_version,
    status: row.status,
    classification: row.classification,
    confidence: row.confidence,
    reasons: arrayValue(row.reasons),
    differences: objectValue(row.differences),
    allowedActions: candidateAllowedActions(row),
    resolutionAction: row.resolution_action,
    resolutionClientRequestId: row.resolution_client_request_id,
    manualTrade: row.manual_trade_id === null ? null : {
      id: row.manual_trade_id,
      version: row.manual_row_version,
      deleted: row.manual_deleted_at !== null,
      symbol: row.manual_symbol ?? "",
      direction: row.manual_direction ?? "",
      date: row.manual_trade_date === null ? "" : new Date(row.manual_trade_date).toISOString().slice(0, 10),
      hasStrategy: row.manual_has_strategy === true,
      hasEmotion: row.manual_has_emotion === true,
      hasPsychology: row.manual_has_psychology === true,
      hasNotes: row.manual_has_notes === true,
      screenshotCount: Number(row.screenshot_count ?? 0),
    },
    brokerTrade: brokerSummary,
  };
}

type ReviewedProjection = {
  positionId: string;
  symbol: string;
  asset: string | null;
  direction: "Long" | "Short";
  entryPrice: string;
  exitPrice: string | null;
  quantity: string;
  quantityUnit: "lots" | "base_units";
  quantityLots: string | null;
  quantityBaseUnits: string | null;
  pnl: string | null;
  isOpen: boolean;
  tradeDate: string;
  entryAt: string;
  exitAt: string | null;
  entryTime: string;
  exitTime: string | null;
  brokerData: Record<string, unknown>;
};

function projectionHasCalculatedGross(value: unknown): boolean {
  const projection = objectValue(value);
  const brokerData = objectValue(projection.brokerData);
  const provenance = objectValue(brokerData.calculatedGrossProvenance);
  return brokerData.calculatedGrossMethod === "fill_price_base_units_identity_conversion_v1"
    && typeof brokerData.calculatedGrossPnl === "string"
    && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(brokerData.calculatedGrossPnl)
    && typeof brokerData.calculatedGrossCurrency === "string"
    && /^[A-Z]{3}$/.test(brokerData.calculatedGrossCurrency)
    && provenance.version === 1
    && provenance.feesIncluded === false
    && provenance.analyticsTreatment === "excluded_from_net_pnl";
}

function reviewedProjection(value: unknown): ReviewedProjection | null {
  const row = objectValue(value);
  const requiredText = (key: string): string | null =>
    typeof row[key] === "string" && String(row[key]).length > 0 ? String(row[key]) : null;
  const positionId = requiredText("positionId");
  const symbol = requiredText("symbol");
  const direction = row.direction === "Long" || row.direction === "Short" ? row.direction : null;
  const entryPrice = requiredText("entryPrice");
  const explicitQuantityUnit = row.quantityUnit;
  const quantityUnit = explicitQuantityUnit === "base_units" || explicitQuantityUnit === "lots"
    ? explicitQuantityUnit
    : "lots";
  const quantity = requiredText("quantity") ?? requiredText("quantityLots");
  const quantityLots = quantityUnit === "lots"
    ? requiredText("quantityLots") ?? quantity
    : null;
  const quantityBaseUnits = quantityUnit === "base_units"
    ? requiredText("quantityBaseUnits") ?? quantity
    : requiredText("quantityBaseUnits");
  const tradeDate = requiredText("tradeDate");
  const entryAt = requiredText("entryAt");
  const entryTime = requiredText("entryTime");
  if (!positionId || !symbol || !direction || !entryPrice || !quantity || !tradeDate || !entryAt || !entryTime) return null;
  if (![entryPrice, quantity].every((number) => Number.isFinite(Number(number))) || Number(quantity) <= 0) return null;
  if (quantityLots !== null && (!Number.isFinite(Number(quantityLots)) || Number(quantityLots) <= 0)) return null;
  if (quantityBaseUnits !== null && (!Number.isFinite(Number(quantityBaseUnits)) || Number(quantityBaseUnits) <= 0)) return null;
  const nullableText = (key: string): string | null => row[key] === null || row[key] === undefined
    ? null
    : typeof row[key] === "string" ? row[key] : null;
  const exitPrice = nullableText("exitPrice");
  const pnl = nullableText("pnl");
  if (exitPrice !== null && !Number.isFinite(Number(exitPrice))) return null;
  if (pnl !== null && !Number.isFinite(Number(pnl))) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate) || !Number.isFinite(Date.parse(entryAt))) return null;
  const exitAt = nullableText("exitAt");
  if (exitAt !== null && !Number.isFinite(Date.parse(exitAt))) return null;
  const brokerData = objectValue(row.brokerData);
  if (explicitQuantityUnit === "base_units" || explicitQuantityUnit === "lots") {
    const declared = objectValue(brokerData.quantityProjection);
    if (
      declared.version !== 1
      || declared.value !== quantity
      || declared.unit !== quantityUnit
      || declared.volumeScale !== "unit_cents"
      || declared.source !== "provider_filled_volume"
      || (quantityLots === null ? declared.lots !== null : declared.lots !== quantityLots)
      || (quantityBaseUnits === null ? declared.baseUnits !== null : declared.baseUnits !== quantityBaseUnits)
    ) return null;
  }
  return {
    positionId,
    symbol,
    asset: nullableText("asset"),
    direction,
    entryPrice,
    exitPrice,
    quantity,
    quantityUnit,
    quantityLots,
    quantityBaseUnits,
    pnl,
    isOpen: row.isOpen === true,
    tradeDate,
    entryAt,
    exitAt,
    entryTime,
    exitTime: nullableText("exitTime"),
    brokerData,
  };
}

function reviewedProjectionBrokerData(
  projection: ReviewedProjection,
  linkedManualRow?: unknown,
): Record<string, unknown> {
  const manualPnl = objectValue(linkedManualRow).pnl;
  const preservesManualPnl = projection.pnl === null
    && manualPnl !== null
    && manualPnl !== undefined
    && manualPnl !== ""
    && Number.isFinite(Number(manualPnl));
  return {
    ...projection.brokerData,
    providerTradeDate: projection.tradeDate,
    ...(preservesManualPnl ? {
      pnlAuthority: "preserved_reconciled_manual",
      reconciledManualPnlPreserved: true,
    } : {}),
  };
}

const historicalImportSelect = `
  SELECT id, broker_connection_id, status, boundary_at, boundary_local, time_zone,
         through_at, normal_history_floor_at_request, normal_history_floor_kind_at_request,
         acknowledged_at, no_open_positions_attested, client_request_id,
         counters, error_code, error_message,
         row_version, created_at, finished_at
  FROM ctrader_historical_imports`;

const reconciliationCandidateSelect = `
  SELECT rc.id, rc.import_id, rc.row_version, rc.status, rc.classification,
         rc.confidence, rc.reasons, rc.differences, rc.projected_trade,
         rc.resolution_action,
         resolution.client_request_id AS resolution_client_request_id,
         rc.manual_trade_id, rc.manual_row_version,
         mt.deleted_at AS manual_deleted_at, mt.symbol AS manual_symbol,
         mt.direction AS manual_direction, mt.trade_date AS manual_trade_date,
         CASE WHEN mt.id IS NULL THEN NULL ELSE mt.psychology <> '{}'::jsonb END AS manual_has_psychology,
         CASE WHEN mt.id IS NULL THEN NULL ELSE COALESCE(length(trim(mt.notes)),0) > 0 END AS manual_has_notes,
         CASE WHEN mt.id IS NULL THEN NULL ELSE COALESCE(length(trim(mt.strategy)),0) > 0 END AS manual_has_strategy,
         CASE WHEN mt.id IS NULL THEN NULL ELSE COALESCE(length(trim(mt.emotion)),0) > 0 END AS manual_has_emotion,
         (SELECT count(*) FROM file_objects fo
          WHERE fo.user_id=rc.user_id AND fo.trade_id=mt.id AND fo.deleted_at IS NULL) AS screenshot_count
  FROM ctrader_reconciliation_candidates rc
  LEFT JOIN trades mt ON mt.user_id=rc.user_id AND mt.id=rc.manual_trade_id
  LEFT JOIN ctrader_reconciliation_resolutions resolution
    ON resolution.user_id=rc.user_id
   AND resolution.broker_connection_id=rc.broker_connection_id
   AND resolution.import_id=rc.import_id
   AND resolution.candidate_id=rc.id`;

type LiveReconciliationCandidateRow = QueryResultRow & {
  id: string;
  row_version: number;
  status: string;
  classification: CTraderLiveReconciliationCandidate["classification"];
  confidence: number;
  reasons: unknown;
  differences: unknown;
  candidate_data: unknown;
  projected_trade: unknown;
  manual_trade_id: string | null;
  manual_row_version: number | null;
  broker_trade_id: string | null;
  broker_row_version: number | null;
  external_position_id: string;
  external_trade_key: string;
  resolution_action: CTraderLiveReconciliationAction | null;
  resolution_client_request_id: string | null;
  manual_deleted_at: Date | string | null;
  manual_symbol: string | null;
  manual_direction: string | null;
  manual_trade_date: Date | string | null;
  manual_has_psychology: boolean | null;
  manual_has_notes: boolean | null;
  manual_has_strategy: boolean | null;
  manual_has_emotion: boolean | null;
  manual_has_custom_fields: boolean | null;
  screenshot_count: number | string | null;
};

const liveReconciliationCandidateSelect = `
  SELECT candidate.id, candidate.row_version, candidate.status,
         candidate.classification, candidate.confidence, candidate.reasons,
         candidate.differences, candidate.candidate_data, candidate.projected_trade,
         candidate.manual_trade_id, candidate.manual_row_version,
         candidate.broker_trade_id, candidate.broker_row_version,
         candidate.external_position_id, candidate.external_trade_key,
         candidate.resolution_action,
         resolution.client_request_id AS resolution_client_request_id,
         manual.deleted_at AS manual_deleted_at,
         manual.symbol AS manual_symbol, manual.direction AS manual_direction,
         manual.trade_date AS manual_trade_date,
         CASE WHEN manual.id IS NULL THEN NULL ELSE manual.psychology <> '{}'::jsonb END AS manual_has_psychology,
         CASE WHEN manual.id IS NULL THEN NULL ELSE COALESCE(length(trim(manual.notes)),0) > 0 END AS manual_has_notes,
         CASE WHEN manual.id IS NULL THEN NULL ELSE COALESCE(length(trim(manual.strategy)),0) > 0 END AS manual_has_strategy,
         CASE WHEN manual.id IS NULL THEN NULL ELSE COALESCE(length(trim(manual.emotion)),0) > 0 END AS manual_has_emotion,
         CASE WHEN manual.id IS NULL THEN NULL ELSE manual.custom_fields <> '{}'::jsonb END AS manual_has_custom_fields,
         (SELECT count(*) FROM file_objects file
          WHERE file.user_id=candidate.user_id AND file.trade_id=manual.id
            AND file.deleted_at IS NULL) AS screenshot_count
  FROM ctrader_live_reconciliation_candidates candidate
  JOIN broker_connections connection
    ON connection.user_id=candidate.user_id
   AND connection.id=candidate.broker_connection_id
  LEFT JOIN trades manual
    ON manual.user_id=candidate.user_id AND manual.id=candidate.manual_trade_id
  LEFT JOIN ctrader_live_reconciliation_resolutions resolution
    ON resolution.user_id=candidate.user_id
   AND resolution.broker_connection_id=candidate.broker_connection_id
   AND resolution.candidate_id=candidate.id`;

function liveAllowedActions(row: LiveReconciliationCandidateRow): CTraderLiveReconciliationAction[] {
  if (row.status !== "pending") return [];
  // A repair candidate deliberately remains pending even when it falls beyond
  // the bounded exact-money refetch batch. Do not let publish/link/suppress
  // consume that durable completeness gate before cTrader supplies the
  // message-local close moneyDigits and staging replaces this projection.
  if (objectValue(row.candidate_data).exactMoneyRepairPending === true) return [];
  // A broker-absent candidate may age beyond either sync mode's overlap and
  // never be fetched again. It therefore cannot use the legacy "dismiss and
  // let the next sync publish" action: that would make the position disappear
  // nondeterministically. The user can link it, publish it separately,
  // suppress an intentional deletion, or simply leave the review pending.
  const canDeferRejectedPublish = row.broker_trade_id !== null;
  const withOptionalReject = (actions: CTraderLiveReconciliationAction[]) =>
    canDeferRejectedPublish ? [...actions, "reject" as const] : actions;
  if (row.classification === "high_confidence") return withOptionalReject(["link_manual", "publish_separate"]);
  if (row.classification === "ambiguous") return withOptionalReject(["link_manual", "publish_separate"]);
  if (row.classification === "deleted_manual") {
    const actions: CTraderLiveReconciliationAction[] = ["suppress_deleted"];
    if (row.broker_trade_id === null) {
      actions.push("publish_separate");
    }
    return withOptionalReject(actions);
  }
  return withOptionalReject(["link_manual"]);
}

function mapLiveReconciliationCandidate(row: LiveReconciliationCandidateRow): CTraderLiveReconciliationCandidate {
  const projection = objectValue(row.projected_trade);
  const brokerTrade = Object.fromEntries(["positionId", "symbol", "direction", "entryPrice", "exitPrice",
    "quantity", "quantityUnit", "quantityLots", "quantityBaseUnits",
    "pnl", "isOpen", "tradeDate", "entryAt", "exitAt"].filter((key) =>
    Object.prototype.hasOwnProperty.call(projection, key)).map((key) => [key, projection[key]]));
  if (row.broker_trade_id !== null) brokerTrade.id = row.broker_trade_id;
  const manualTrade = row.manual_trade_id === null ? null : {
    id: row.manual_trade_id,
    version: row.manual_row_version,
    deleted: row.manual_deleted_at !== null,
    symbol: row.manual_symbol ?? "",
    direction: row.manual_direction ?? "",
    date: row.manual_trade_date === null ? "" : new Date(row.manual_trade_date).toISOString().slice(0, 10),
    hasStrategy: row.manual_has_strategy === true,
    hasEmotion: row.manual_has_emotion === true,
    hasPsychology: row.manual_has_psychology === true,
    hasNotes: row.manual_has_notes === true,
    hasCustomFields: row.manual_has_custom_fields === true,
    screenshotCount: Number(row.screenshot_count ?? 0),
  };
  const choiceValues = arrayValue(objectValue(row.candidate_data).manualChoices);
  const manualChoices = choiceValues.flatMap((choice) => {
    const value = objectValue(choice);
    return typeof value.id === "string" && Number.isInteger(value.version)
      ? [value as NonNullable<CTraderLiveReconciliationCandidate["manualTrade"]>]
      : [];
  });
  return {
    id: row.id,
    version: row.row_version,
    status: row.status,
    classification: row.classification,
    confidence: row.confidence,
    reasons: arrayValue(row.reasons),
    differences: objectValue(row.differences),
    allowedActions: liveAllowedActions(row),
    resolutionAction: row.resolution_action,
    resolutionClientRequestId: row.resolution_client_request_id,
    manualTrade,
    manualChoices,
    brokerTrade,
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
    return sanitizeAuthorizedAccount({
      ctidTraderAccountId: id,
      environment,
      traderLogin: stringOrNull(account.traderLogin),
      brokerTitleShort: stringOrNull(account.brokerTitleShort),
      lastClosingDealTimestamp: numberOrNull(account.lastClosingDealTimestamp),
      lastBalanceUpdateTimestamp: numberOrNull(account.lastBalanceUpdateTimestamp),
    });
  });
}

async function resolveConnectionIdentity(
  client: PoolClient,
  userId: string,
  environment: CTraderEnvironment,
  accountId: string,
  requestedMode: "official" | "mcp_read",
  options: { allowActiveMcpToOfficialUpgrade?: boolean; lockRows?: boolean } = {},
): Promise<{ row: ConnectionIdentityRow | null; adoptsLegacyEnvironment: boolean }> {
  const candidates = await client.query<ConnectionIdentityRow>(
    `SELECT id, connected, connection_mode, provider_environment, provider_metadata
     FROM broker_connections
     WHERE user_id=$1 AND provider='ctrader' AND external_account_id=$2
       AND (provider_environment=$3 OR provider_environment IS NULL)
     ${options.lockRows === false ? "" : "FOR UPDATE"}`,
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
  const activeMcpToOfficialUpgrade = options.allowActiveMcpToOfficialUpgrade === true
    && requestedMode === "official"
    && row?.connection_mode === "mcp_read";
  if (row?.connected && row.connection_mode !== requestedMode && !activeMcpToOfficialUpgrade) {
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
         c.sync_cursor, c.provider_metadata, c.connected_at, c.last_sync_at,
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
    const accounts = (await gateway.discoverAccounts(tokenSet.accessToken)).map(sanitizeAuthorizedAccount);
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
    ], { field: "account identifier", maxLength: 20, allowFiniteNumber: true });
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
    const environmentText = firstText(
      metadataObjects,
      ["environment", "accountEnvironment"],
      { field: "account environment", maxLength: 8 },
    );
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
    const currency = firstText(
      metadataObjects,
      ["currency", "currencyCode", "accountCurrency"],
      { field: "account currency", maxLength: 3 },
    );
    const accountCurrency = currency?.toUpperCase() ?? null;
    if (accountCurrency !== null && !/^[A-Z]{3}$/.test(accountCurrency)) {
      throw new AppError(502, "CTRADER_PROVIDER_METADATA_INVALID", "cTrader returned an invalid account currency");
    }
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
      const discoveredIdentity = await resolveConnectionIdentity(
        client,
        input.auth.user.id,
        environment,
        accountId,
        "mcp_read",
        { lockRows: false },
      );
      const id = discoveredIdentity.row?.id ?? randomUUID();
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [id]);
      const identity = await resolveConnectionIdentity(
        client,
        input.auth.user.id,
        environment,
        accountId,
        "mcp_read",
      );
      if (identity.row?.id !== discoveredIdentity.row?.id) {
        throw new AppError(409, "CTRADER_CONNECTION_CHANGED", "The cTrader connection changed while reconnecting");
      }
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
        accountCurrency,
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
      const discoveredIdentity = await resolveConnectionIdentity(
        client,
        input.auth.user.id,
        selected.environment,
        selected.ctidTraderAccountId,
        "official",
        { allowActiveMcpToOfficialUpgrade: true, lockRows: false },
      );
      const id = discoveredIdentity.row?.id ?? randomUUID();
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [id]);
      const identity = await resolveConnectionIdentity(
        client,
        input.auth.user.id,
        selected.environment,
        selected.ctidTraderAccountId,
        "official",
        { allowActiveMcpToOfficialUpgrade: true },
      );
      if (identity.row?.id !== discoveredIdentity.row?.id) {
        throw new AppError(409, "CTRADER_CONNECTION_CHANGED", "The cTrader connection changed while upgrading authorization");
      }
      const upgradesMcpConnection = identity.row?.connection_mode === "mcp_read";
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
        integrationMode: "official",
        brokerTitleShort: selected.brokerTitleShort,
        traderLogin: selected.traderLogin,
        lastClosingDealTimestamp: selected.lastClosingDealTimestamp,
        lastBalanceUpdateTimestamp: selected.lastBalanceUpdateTimestamp,
        permissionScope: "accounts",
        legacyEnvironmentWasUnbound: identity.adoptsLegacyEnvironment
          || previousMetadata.legacyEnvironmentWasUnbound === true,
        readOnly: true,
        reauthRequired: false,
        upgradedFromRemoteMcpAt: upgradesMcpConnection ? new Date().toISOString() : null,
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
      if (upgradesMcpConnection) {
        // The connection advisory lock guarantees that no MCP run is still
        // executing. A crashed worker can nevertheless leave a stale
        // `running` row after its session lock disappears, so cancel both
        // queued and orphaned-running MCP work before inserting the official
        // initial run. This also clears the one-active-run unique index.
        await client.query(
          `UPDATE sync_runs SET status='cancelled', finished_at=now(),
             error_code='CONNECTION_MODE_UPGRADED',
             error_message='Superseded by official cTrader OAuth history backfill'
           WHERE broker_connection_id=$1 AND status IN ('queued','running')`,
          [id],
        );
        await client.query(
          `UPDATE ctrader_historical_imports import SET
             status='cancelled', error_code='CONNECTION_MODE_UPGRADED',
             error_message='Superseded by official cTrader OAuth history backfill',
             finished_at=now(), row_version=import.row_version+1
           WHERE import.broker_connection_id=$1 AND import.user_id=$2
             AND import.status IN ('queued','running','review')`,
          [id, input.auth.user.id],
        );
        // Pending live suggestions are mode-specific work, not durable audit.
        // Terminal candidates and resolution rows remain intact for replay.
        await client.query(
          `DELETE FROM ctrader_live_reconciliation_candidates
           WHERE broker_connection_id=$1 AND user_id=$2 AND status='pending'`,
          [id, input.auth.user.id],
        );
      }
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
    accountCashFlowHistoryComplete: boolean;
    accountCashFlowHistoryStartTimestamp: number | null;
    accountCashFlowSyncedThroughTimestamp: number | null;
    accountCashFlowMonetaryScaleComplete: boolean;
    accountCashFlowTotalRows: number;
    accountCashFlowScaledRows: number;
    accountCashFlowUnscaledRows: number;
    accountCashFlowPendingScaleRetries: number;
    tradeHistoryComplete: boolean;
    tradeHistoryStartTimestamp: number | null;
    tradeHistorySyncedThroughTimestamp: number | null;
    latestSyncRun: CTraderPublicSyncRun | null;
    historicalImport: CTraderHistoricalImport | null;
    accountCashFlows: CTraderPublicAccountCashFlow[];
  }> {
    const row = await this.findConnectionRow(userId, connectionId);
    const [historical, accountCashFlows] = await Promise.all([
      this.database.query<HistoricalImportRow>(
        `${historicalImportSelect}
         WHERE user_id=$1 AND broker_connection_id=$2
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [userId, connectionId],
      ),
      this.database.query<AccountCashFlowRow>(
        `SELECT external_cash_flow_id, operation_type, operation_name,
                amount::text, balance::text, equity::text,
                raw_delta::text, raw_balance::text, raw_equity::text, currency_code,
                money_digits, money_digits_source, balance_version::text, occurred_at
         FROM ctrader_account_cash_flows
         WHERE user_id=$1 AND broker_connection_id=$2
         ORDER BY occurred_at DESC, external_cash_flow_id DESC
         LIMIT 50`,
        [userId, connectionId],
      ),
    ]);
    const connection = mapConnection(row);
    return {
      connection,
      accountCashFlowHistoryComplete: connection.accountCashFlowHistoryComplete,
      accountCashFlowHistoryStartTimestamp: connection.accountCashFlowHistoryStartTimestamp,
      accountCashFlowSyncedThroughTimestamp: connection.accountCashFlowSyncedThroughTimestamp,
      accountCashFlowMonetaryScaleComplete: connection.accountCashFlowMonetaryScaleComplete,
      accountCashFlowTotalRows: connection.accountCashFlowTotalRows,
      accountCashFlowScaledRows: connection.accountCashFlowScaledRows,
      accountCashFlowUnscaledRows: connection.accountCashFlowUnscaledRows,
      accountCashFlowPendingScaleRetries: connection.accountCashFlowPendingScaleRetries,
      tradeHistoryComplete: connection.tradeHistoryComplete,
      tradeHistoryStartTimestamp: connection.tradeHistoryStartTimestamp,
      tradeHistorySyncedThroughTimestamp: connection.tradeHistorySyncedThroughTimestamp,
      latestSyncRun: mapLatestSync(row),
      historicalImport: historical.rows[0] ? mapHistoricalImport(historical.rows[0]) : null,
      accountCashFlows: accountCashFlows.rows.map(mapAccountCashFlow),
    };
  }

  async listAccountCashFlows(input: {
    userId: string;
    connectionId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ accountCashFlows: CTraderPublicAccountCashFlow[]; nextCursor: string | null }> {
    await this.findConnectionRow(input.userId, input.connectionId);
    const cursor = decodeCursor(input.cursor);
    if (cursor !== null && !/^(?:0|[1-9]\d{0,99})$/.test(cursor.id)) {
      throw new AppError(400, "INVALID_CURSOR", "The pagination cursor is invalid");
    }
    const result = await this.database.query<AccountCashFlowRow>(
      `SELECT external_cash_flow_id, operation_type, operation_name,
              amount::text, balance::text, equity::text,
              raw_delta::text, raw_balance::text, raw_equity::text, currency_code,
              money_digits, money_digits_source, balance_version::text, occurred_at
       FROM ctrader_account_cash_flows
       WHERE user_id=$1 AND broker_connection_id=$2
         ${cursor === null ? "" : "AND (occurred_at, external_cash_flow_id) < ($3::timestamptz, $4::text)"}
       ORDER BY occurred_at DESC, external_cash_flow_id DESC
       LIMIT $${cursor === null ? 3 : 5}`,
      cursor === null
        ? [input.userId, input.connectionId, input.limit + 1]
        : [input.userId, input.connectionId, cursor.at, cursor.id, input.limit + 1],
    );
    const hasMore = result.rows.length > input.limit;
    const rows = hasMore ? result.rows.slice(0, input.limit) : result.rows;
    const last = rows.at(-1);
    return {
      accountCashFlows: rows.map(mapAccountCashFlow),
      nextCursor: hasMore && last
        ? encodeCursor({ at: new Date(last.occurred_at).toISOString(), id: last.external_cash_flow_id })
        : null,
    };
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

  async startHistoricalImport(input: {
    auth: AuthContext;
    connectionId: string;
    boundaryLocal: string;
    timeZone: string;
    boundaryAt: string;
    acknowledgeNoOpenPositionsAtBoundary: true;
    clientRequestId: string;
    idempotencyKey: string;
  }): Promise<CTraderHistoricalImport> {
    const boundary = validateHistoricalBoundary(input.boundaryLocal, input.timeZone, input.boundaryAt);
    const hash = requestHash({
      connectionId: input.connectionId,
      boundaryLocal: input.boundaryLocal,
      timeZone: input.timeZone,
      boundaryAt: boundary.toISOString(),
      acknowledgeNoOpenPositionsAtBoundary: true,
      clientRequestId: input.clientRequestId,
    });
    return withTransaction(this.database, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`ctrader:history:${input.auth.user.id}:${input.clientRequestId}`],
      );
      // This is the same raw connection key held by the worker. Lock order is
      // request identity, connection identity, then database rows.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [input.connectionId],
      );
      const replay = await client.query<HistoricalImportRow>(
        `${historicalImportSelect}
         WHERE user_id=$1 AND client_request_id=$2
         LIMIT 1`,
        [input.auth.user.id, input.clientRequestId],
      );
      if (replay.rows[0]) {
        const storedHash = await client.query<{ request_hash: Buffer }>(
          `SELECT request_hash FROM ctrader_historical_imports
           WHERE user_id=$1 AND client_request_id=$2`,
          [input.auth.user.id, input.clientRequestId],
        );
        if (!storedHash.rows[0]?.request_hash.equals(hash)) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "clientRequestId was already used for a different request");
        }
        return mapHistoricalImport(replay.rows[0], true);
      }
      const connection = await client.query<{
        external_account_id: string;
        provider_environment: CTraderEnvironment;
        connected: boolean;
        access_token_ciphertext: string | null;
        mapped_account_id: string | null;
        legacy_mapped_account_id: string | null;
        provider_metadata: unknown;
      }>(
        `SELECT external_account_id, provider_environment, connected,
                access_token_ciphertext, mapped_account_id, legacy_mapped_account_id,
                provider_metadata
         FROM broker_connections
         WHERE id=$1 AND user_id=$2 AND provider='ctrader'
           AND connection_mode='mcp_read' AND oauth_scope='mcp_read'
           AND provider_environment IS NOT NULL
         FOR UPDATE`,
        [input.connectionId, input.auth.user.id],
      );
      const row = connection.rows[0];
      if (!row) throw notFound("cTrader connection");
      if (!row.connected || !row.access_token_ciphertext) {
        throw new AppError(409, "CTRADER_REAUTH_REQUIRED", "Reconnect cTrader before requesting history");
      }
      if (!row.mapped_account_id && !row.legacy_mapped_account_id) {
        throw new AppError(409, "CTRADER_ACCOUNT_MAPPING_REQUIRED", "Map this broker connection to an Edgebook account first");
      }
      const normalFloor = approvedNormalHistoryFloor({
        providerMetadata: row.provider_metadata,
        userId: input.auth.user.id,
        connectionId: input.connectionId,
        accountId: row.external_account_id,
        environment: row.provider_environment,
      });
      if (boundary.getTime() >= normalFloor.at.getTime()) {
        throw new AppError(
          409,
          "HISTORICAL_IMPORT_NO_GAP",
          "Choose a historical boundary earlier than the existing normal-sync boundary",
        );
      }
      const activeRun = await client.query<{ id: string }>(
        `SELECT id FROM sync_runs
         WHERE broker_connection_id=$1 AND status IN ('queued','running')
         LIMIT 1`,
        [input.connectionId],
      );
      if (activeRun.rows[0]) {
        throw new AppError(409, "CTRADER_SYNC_IN_PROGRESS", "Wait for the current cTrader sync to finish before importing history");
      }
      const activeImport = await client.query<{ id: string }>(
        `SELECT id FROM ctrader_historical_imports
         WHERE broker_connection_id=$1 AND status IN ('queued','running','review')
         LIMIT 1`,
        [input.connectionId],
      );
      if (activeImport.rows[0]) {
        throw new AppError(409, "HISTORICAL_IMPORT_ACTIVE", "Finish the current historical review before starting another import");
      }
      const importId = randomUUID();
      const inserted = await client.query<HistoricalImportRow>(
        `INSERT INTO ctrader_historical_imports (
           id, user_id, broker_connection_id, external_account_id, provider_environment,
           boundary_at, boundary_local, time_zone, no_open_positions_attested,
           attestation_version, attestation_purpose, through_at,
           normal_history_floor_at_request, normal_history_floor_kind_at_request,
           client_request_id, request_hash,
           status, counters
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,true,1,'historical_preview_reconciliation',
           $9,$9,$10,$11,$12,'queued','{}'::jsonb
         )
         RETURNING id, broker_connection_id, status, boundary_at, boundary_local, time_zone,
                   through_at, normal_history_floor_at_request, normal_history_floor_kind_at_request,
                   acknowledged_at, no_open_positions_attested, client_request_id,
                   counters, error_code, error_message,
                   row_version, created_at, finished_at`,
        [
          importId, input.auth.user.id, input.connectionId, row.external_account_id,
          row.provider_environment, boundary, input.boundaryLocal, input.timeZone,
          normalFloor.at, normalFloor.kind, input.clientRequestId, hash,
        ],
      );
      const syncRunId = randomUUID();
      await client.query(
        `INSERT INTO sync_runs (
           id, broker_connection_id, job_key, sync_type, status,
           requested_by_user_id, counters, historical_import_user_id, historical_import_id
         ) VALUES ($1,$2,$3,'historical_preview','queued',$4,'{}'::jsonb,$4,$5)`,
        [syncRunId, input.connectionId, `historical-preview:${importId}`, input.auth.user.id, importId],
      );
      await client.query(
        `INSERT INTO audit_events (
           user_id, session_id, event_type, target_type, target_id, metadata
         ) VALUES ($1,$2,'ctrader.historical_import_requested','ctrader_historical_import',$3,
           jsonb_build_object(
             'connectionId',$4::text,'boundaryAt',$5::text,'throughAt',$6::text,
             'normalHistoryFloorKind',$7::text,'timeZone',$8::text
           ))`,
        [
          input.auth.user.id, input.auth.sessionId, importId, input.connectionId,
          boundary.toISOString(), normalFloor.at.toISOString(), normalFloor.kind, input.timeZone,
        ],
      );
      const created = inserted.rows[0];
      if (!created) throw new Error("Failed to create cTrader historical import");
      return mapHistoricalImport(created);
    });
  }

  async currentHistoricalImport(userId: string, connectionId: string): Promise<CTraderHistoricalImport | null> {
    await this.findConnectionRow(userId, connectionId);
    const result = await this.database.query<HistoricalImportRow>(
      `${historicalImportSelect}
       WHERE user_id=$1 AND broker_connection_id=$2
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId, connectionId],
    );
    return result.rows[0] ? mapHistoricalImport(result.rows[0]) : null;
  }

  async listReconciliationCandidates(userId: string, connectionId: string, importId: string): Promise<{
    historicalImport: CTraderHistoricalImport;
    candidates: CTraderReconciliationCandidate[];
  }> {
    const imported = await this.database.query<HistoricalImportRow>(
      `${historicalImportSelect}
       WHERE id=$1 AND user_id=$2 AND broker_connection_id=$3 LIMIT 1`,
      [importId, userId, connectionId],
    );
    const historicalImport = imported.rows[0];
    if (!historicalImport) throw notFound("cTrader historical import");
    const rows = await this.database.query<ReconciliationCandidateRow>(
      `${reconciliationCandidateSelect}
       WHERE rc.import_id=$1 AND rc.user_id=$2 AND rc.broker_connection_id=$3
       ORDER BY rc.created_at ASC, rc.id ASC
       LIMIT 501`,
      [importId, userId, connectionId],
    );
    if (rows.rows.length > 500) {
      throw new AppError(
        409,
        "CTRADER_RECONCILIATION_LIMIT_EXCEEDED",
        "This historical preview is too large to review safely; start again with a narrower boundary",
      );
    }
    return {
      historicalImport: mapHistoricalImport(historicalImport),
      candidates: rows.rows.map(mapReconciliationCandidate),
    };
  }

  async listLiveReconciliationCandidates(userId: string, connectionId: string): Promise<{
    candidates: CTraderLiveReconciliationCandidate[];
  }> {
    const rows = await this.database.query<LiveReconciliationCandidateRow>(
      `${liveReconciliationCandidateSelect}
       WHERE candidate.user_id=$1 AND candidate.broker_connection_id=$2
          AND candidate.status='pending'
          AND connection.connected=true
          AND (
            (connection.connection_mode='mcp_read' AND connection.oauth_scope='mcp_read')
            OR (connection.connection_mode='official' AND connection.oauth_scope='accounts')
          )
       ORDER BY candidate.created_at ASC, candidate.id ASC
       LIMIT 501`,
      [userId, connectionId],
    );
    if (rows.rows.length > 500) {
      throw new AppError(409, "CTRADER_RECONCILIATION_LIMIT_EXCEEDED", "Too many live cTrader matches require review");
    }
    return { candidates: rows.rows.map(mapLiveReconciliationCandidate) };
  }

  async getLiveReconciliationCandidate(
    userId: string,
    connectionId: string,
    candidateId: string,
  ): Promise<{ candidate: CTraderLiveReconciliationCandidate }> {
    const rows = await this.database.query<LiveReconciliationCandidateRow>(
      `${liveReconciliationCandidateSelect}
       WHERE candidate.id=$1 AND candidate.user_id=$2
          AND candidate.broker_connection_id=$3
          AND connection.connected=true
          AND (
            (connection.connection_mode='mcp_read' AND connection.oauth_scope='mcp_read')
            OR (connection.connection_mode='official' AND connection.oauth_scope='accounts')
          )`,
      [candidateId, userId, connectionId],
    );
    if (!rows.rows[0]) throw notFound("cTrader live reconciliation candidate");
    return { candidate: mapLiveReconciliationCandidate(rows.rows[0]) };
  }

  async resolveLiveReconciliationCandidate(input: {
    auth: AuthContext;
    connectionId: string;
    candidateId: string;
    action: CTraderLiveReconciliationAction;
    manualTradeId: string | null;
    expectedVersion: number;
    clientRequestId: string;
    idempotencyKey: string;
  }): Promise<{ candidate: CTraderLiveReconciliationCandidate }> {
    const hash = requestHash({
      connectionId: input.connectionId,
      candidateId: input.candidateId,
      action: input.action,
      manualTradeId: input.manualTradeId,
      expectedVersion: input.expectedVersion,
      clientRequestId: input.clientRequestId,
    });
    const outcome = await withTransaction(this.database, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `ctrader:live-resolution:${input.auth.user.id}:${input.clientRequestId}`,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [input.connectionId]);
      const replay = await client.query<{ request_hash: Buffer; candidate_id: string }>(
        `SELECT request_hash, candidate_id FROM ctrader_live_reconciliation_resolutions
         WHERE user_id=$1 AND client_request_id=$2 LIMIT 1`,
        [input.auth.user.id, input.clientRequestId],
      );
      if (replay.rows[0]) {
        if (!replay.rows[0].request_hash.equals(hash) || replay.rows[0].candidate_id !== input.candidateId) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "clientRequestId was already used for another decision");
        }
        return this.readLiveResolvedCandidate(client, input.auth.user.id, input.connectionId, input.candidateId);
      }
      const result = await client.query<LiveReconciliationCandidateRow>(
        `SELECT candidate.id, candidate.row_version, candidate.status,
                candidate.classification, candidate.confidence, candidate.reasons,
                candidate.differences, candidate.candidate_data, candidate.projected_trade,
                candidate.manual_trade_id, candidate.manual_row_version,
                candidate.broker_trade_id, candidate.broker_row_version,
                candidate.external_position_id, candidate.external_trade_key,
                candidate.resolution_action, NULL::uuid AS resolution_client_request_id,
                NULL::timestamptz AS manual_deleted_at, NULL::text AS manual_symbol,
                NULL::text AS manual_direction, NULL::date AS manual_trade_date,
                NULL::boolean AS manual_has_psychology, NULL::boolean AS manual_has_notes,
                NULL::boolean AS manual_has_strategy, NULL::boolean AS manual_has_emotion,
                NULL::boolean AS manual_has_custom_fields, 0::bigint AS screenshot_count
         FROM ctrader_live_reconciliation_candidates candidate
         JOIN broker_connections connection
           ON connection.user_id=candidate.user_id
          AND connection.id=candidate.broker_connection_id
          WHERE candidate.id=$1 AND candidate.user_id=$2
            AND candidate.broker_connection_id=$3
            AND connection.connected=true
            AND (
              (connection.connection_mode='mcp_read' AND connection.oauth_scope='mcp_read')
              OR (connection.connection_mode='official' AND connection.oauth_scope='accounts')
            )
         FOR UPDATE OF candidate, connection`,
        [input.candidateId, input.auth.user.id, input.connectionId],
      );
      const candidate = result.rows[0];
      if (!candidate) throw notFound("cTrader live reconciliation candidate");
      if (candidate.status !== "pending") {
        throw new AppError(409, "RECONCILIATION_ALREADY_RESOLVED", "This candidate was already resolved");
      }
      if (candidate.row_version !== input.expectedVersion) {
        throw new AppError(409, "VERSION_CONFLICT", "The reconciliation candidate changed; reload before deciding");
      }
      if (objectValue(candidate.candidate_data).exactMoneyRepairPending === true) {
        throw new AppError(
          409,
          "CTRADER_EXACT_MONEY_REPAIR_PENDING",
          "This broker position is waiting for authoritative cTrader money; sync again before resolving it",
        );
      }
      if (!liveAllowedActions(candidate).includes(input.action)) {
        throw new AppError(409, "RECONCILIATION_ACTION_INVALID", "This action is not safe for this candidate");
      }
      const tombstone = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM ctrader_trade_tombstones
           WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
         ) AS exists`,
        [input.auth.user.id, input.connectionId, candidate.external_trade_key],
      );
      if (tombstone.rows[0]?.exists === true) {
        throw new AppError(
          409,
          "RECONCILIATION_IDENTITY_CONFLICT",
          "This broker position was permanently removed or suppressed; reload the review",
        );
      }
      const projection = reviewedProjection(candidate.projected_trade);
      if (!projection) throw new AppError(409, "RECONCILIATION_PROJECTION_INCOMPLETE", "Broker facts are incomplete");
      const choices = arrayValue(objectValue(candidate.candidate_data).manualChoices).map(objectValue);
      const selectedManualId = input.action === "link_manual" || input.action === "suppress_deleted"
        ? input.manualTradeId ?? candidate.manual_trade_id
        : null;
      if (input.action === "link_manual" || input.action === "suppress_deleted") {
        if (!selectedManualId || !choices.some((choice) => choice.id === selectedManualId)) {
          throw new AppError(409, "RECONCILIATION_MANUAL_TRADE_REQUIRED", "Choose an advertised manual trade");
        }
      }
      let resolvedTradeId: string | null = null;
      let beforeManual: unknown = null;
      let beforeBroker: unknown = null;
      if (input.action === "link_manual") {
        const choice = choices.find((candidateChoice) => candidateChoice.id === selectedManualId)!;
        const expectedManualVersion = Number(choice.version);
        if (!Number.isSafeInteger(expectedManualVersion) || expectedManualVersion <= 0) {
          throw new AppError(409, "MANUAL_TRADE_CHANGED", "The advertised manual trade version is invalid; reload before linking");
        }
        const manualResult = await client.query<{ row: unknown; row_version: number; deleted_at: Date | string | null }>(
          `SELECT to_jsonb(manual) AS row, manual.row_version, manual.deleted_at
           FROM trades manual
           WHERE manual.id=$1 AND manual.user_id=$2
             AND manual.row_version=$3
             AND manual.broker_connection_id IS NULL
             AND manual.external_trade_key IS NULL
             AND manual.source_system <> 'ctrader'
             AND EXISTS (
               SELECT 1 FROM broker_connections connection
               WHERE connection.id=$4 AND connection.user_id=$2
                 AND (
                   (connection.mapped_account_id IS NOT NULL
                     AND manual.account_id=connection.mapped_account_id)
                   OR (
                     connection.mapped_account_id IS NULL
                     AND connection.legacy_mapped_account_id IS NOT NULL
                     AND manual.legacy_account_id=connection.legacy_mapped_account_id
                   )
                 )
             )
           FOR UPDATE OF manual`,
          [selectedManualId, input.auth.user.id, expectedManualVersion, input.connectionId],
        );
        const manual = manualResult.rows[0];
        if (!manual || manual.deleted_at !== null) {
          throw new AppError(409, "MANUAL_TRADE_CHANGED", "The manual trade changed; reload before linking");
        }
        beforeManual = manual.row;
        if (candidate.broker_trade_id !== null) {
          const brokerResult = await client.query<{ row: unknown; row_version: number }>(
            `SELECT to_jsonb(broker) AS row, broker.row_version
             FROM trades broker
             WHERE broker.id=$1 AND broker.user_id=$2
               AND broker.broker_connection_id=$3
               AND broker.external_trade_key=$4
               AND broker.deleted_at IS NULL AND broker.row_version=$5
             FOR UPDATE`,
            [candidate.broker_trade_id, input.auth.user.id, input.connectionId,
              candidate.external_trade_key, candidate.broker_row_version],
          );
          const broker = brokerResult.rows[0];
          if (!broker) throw new AppError(409, "RECONCILIATION_IDENTITY_CONFLICT", "The broker trade changed; reload");
          beforeBroker = broker.row;
          const historicalEvidence = await client.query<{ exists: boolean }>(
            `SELECT EXISTS (
               SELECT 1 FROM ctrader_reconciliation_resolutions
               WHERE user_id=$1 AND broker_connection_id=$2 AND resolved_trade_id=$3
             ) AS exists`,
            [input.auth.user.id, input.connectionId, candidate.broker_trade_id],
          );
          if (historicalEvidence.rows[0]?.exists === true) {
            throw new AppError(
              409,
              "RECONCILIATION_AUDIT_DEPENDENCY",
              "This broker row is protected by an earlier historical-import decision; keep both rows to preserve its audit evidence",
            );
          }
          await client.query(
            `UPDATE file_objects SET trade_id=$1
             WHERE user_id=$2 AND trade_id=$3`,
            [selectedManualId, input.auth.user.id, candidate.broker_trade_id],
          );
          await client.query(
            `UPDATE trade_executions SET trade_id=NULL
             WHERE user_id=$1 AND broker_connection_id=$2 AND external_position_id=$3
               AND trade_id=$4`,
            [input.auth.user.id, input.connectionId, candidate.external_position_id, candidate.broker_trade_id],
          );
          const removed = await client.query<{ id: string }>(
            `DELETE FROM trades
             WHERE id=$1 AND user_id=$2 AND row_version=$3
             RETURNING id`,
            [candidate.broker_trade_id, input.auth.user.id, candidate.broker_row_version],
          );
          if (!removed.rows[0]) throw new AppError(409, "RECONCILIATION_IDENTITY_CONFLICT", "The broker trade changed; reload");
          // Deleting a cTrader row creates a tombstone by trigger. This merge is
          // not deletion intent, so remove only the exact just-created key while
          // still holding the connection advisory lock.
          await client.query(
            `DELETE FROM ctrader_trade_tombstones
             WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3`,
            [input.auth.user.id, input.connectionId, candidate.external_trade_key],
          );
        }
        await client.query(
          `INSERT INTO ctrader_trade_links (
             user_id, broker_connection_id, external_position_id,
             external_trade_key, trade_id, import_id
           ) VALUES ($1,$2,$3,$4,$5,NULL)`,
          [input.auth.user.id, input.connectionId, candidate.external_position_id,
            candidate.external_trade_key, selectedManualId],
        );
        const updated = await client.query<{ id: string }>(
          `UPDATE trades SET
             broker_connection_id=$1, external_trade_key=$2, broker_trade_id=$3,
             source_system='ctrader', ingestion_method='reconciled',
             symbol=$4, asset=COALESCE($5,asset), instrument=$4, direction=$6,
             entry_price=$7, exit_price=COALESCE($8,exit_price),
             quantity=$9, pnl=COALESCE($10,pnl), is_open=$11,
             trade_date=COALESCE(trade_date,$12::date), entry_at=$13, exit_at=COALESCE($14,exit_at),
             legacy_entry_time=$15, legacy_exit_time=COALESCE($16,legacy_exit_time),
             broker_data=broker_data || $17::jsonb, calculation_version=2,
             row_version=row_version+1
           WHERE id=$18 AND user_id=$19 AND row_version=$20 AND deleted_at IS NULL
           RETURNING id`,
          [
            input.connectionId, candidate.external_trade_key, projection.positionId,
            projection.symbol, projection.asset, projection.direction, projection.entryPrice,
            projection.exitPrice, projection.quantity, projection.pnl, projection.isOpen,
            projection.tradeDate, projection.entryAt, projection.exitAt, projection.entryTime,
            projection.exitTime, JSON.stringify(reviewedProjectionBrokerData(projection, manual.row)), selectedManualId,
            input.auth.user.id, expectedManualVersion,
          ],
        );
        if (!updated.rows[0]) throw new AppError(409, "MANUAL_TRADE_CHANGED", "The manual trade changed during linking");
        resolvedTradeId = updated.rows[0].id;
        await client.query(
          `UPDATE trade_executions SET trade_id=$1
           WHERE user_id=$2 AND broker_connection_id=$3 AND external_position_id=$4`,
          [resolvedTradeId, input.auth.user.id, input.connectionId, candidate.external_position_id],
        );
      } else if (input.action === "publish_separate") {
        if (candidate.broker_trade_id !== null) {
          const brokerResult = await client.query<{ row: unknown; row_version: number }>(
            `SELECT to_jsonb(broker) AS row, broker.row_version
             FROM trades broker
             WHERE broker.id=$1 AND broker.user_id=$2
               AND broker.broker_connection_id=$3
               AND broker.external_trade_key=$4
               AND broker.deleted_at IS NULL AND broker.row_version=$5
             FOR UPDATE`,
            [candidate.broker_trade_id, input.auth.user.id, input.connectionId,
              candidate.external_trade_key, candidate.broker_row_version],
          );
          if (!brokerResult.rows[0]) {
            throw new AppError(409, "RECONCILIATION_IDENTITY_CONFLICT", "The broker trade changed; reload");
          }
          beforeBroker = brokerResult.rows[0].row;
          resolvedTradeId = candidate.broker_trade_id;
        } else {
          resolvedTradeId = randomUUID();
          await client.query(
            `INSERT INTO trades (
               id,user_id,account_id,legacy_account_id,broker_connection_id,
               source_system,ingestion_method,external_trade_key,broker_trade_id,
               symbol,asset,instrument,direction,entry_price,exit_price,quantity,pnl,
               is_open,trade_date,entry_at,exit_at,legacy_entry_time,legacy_exit_time,
               broker_data,calculation_version,row_version
             ) SELECT $1,$2,connection.mapped_account_id,connection.legacy_mapped_account_id,connection.id,
               'ctrader','api',$3,$4,$5,$6,$5,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
               $18::jsonb,2,1 FROM broker_connections connection
               WHERE connection.id=$19 AND connection.user_id=$2`,
            [resolvedTradeId, input.auth.user.id, candidate.external_trade_key, projection.positionId,
              projection.symbol, projection.asset, projection.direction, projection.entryPrice,
              projection.exitPrice, projection.quantity, projection.pnl, projection.isOpen,
              projection.tradeDate, projection.entryAt, projection.exitAt, projection.entryTime,
              projection.exitTime, JSON.stringify(reviewedProjectionBrokerData(projection)), input.connectionId],
          );
          await client.query(
            `UPDATE trade_executions SET trade_id=$1
             WHERE user_id=$2 AND broker_connection_id=$3 AND external_position_id=$4`,
            [resolvedTradeId, input.auth.user.id, input.connectionId, candidate.external_position_id],
          );
        }
      } else if (input.action === "suppress_deleted") {
        const choice = choices.find((candidateChoice) => candidateChoice.id === selectedManualId)!;
        const expectedManualVersion = Number(choice.version);
        if (!Number.isSafeInteger(expectedManualVersion) || expectedManualVersion <= 0) {
          throw new AppError(409, "DELETED_MATCH_CHANGED", "The advertised deleted-trade version is invalid; reload");
        }
        const deleted = await client.query<{ id: string }>(
          `SELECT id FROM trades
           WHERE id=$1 AND user_id=$2 AND row_version=$3 AND deleted_at IS NOT NULL
             AND broker_connection_id IS NULL AND external_trade_key IS NULL
             AND EXISTS (
               SELECT 1 FROM broker_connections connection
               WHERE connection.id=$4 AND connection.user_id=$2
                 AND (
                   (connection.mapped_account_id IS NOT NULL
                     AND trades.account_id=connection.mapped_account_id)
                   OR (
                     connection.mapped_account_id IS NULL
                     AND connection.legacy_mapped_account_id IS NOT NULL
                     AND trades.legacy_account_id=connection.legacy_mapped_account_id
                   )
                 )
             )
           FOR UPDATE`,
          [selectedManualId, input.auth.user.id, expectedManualVersion, input.connectionId],
        );
        if (!deleted.rows[0]) throw new AppError(409, "DELETED_MATCH_CHANGED", "The deleted trade changed; reload");
        await client.query(
          `INSERT INTO ctrader_trade_tombstones (
             user_id, broker_connection_id, external_trade_key, external_position_id
           ) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id,broker_connection_id,external_trade_key) DO UPDATE SET
             external_position_id=EXCLUDED.external_position_id, purged_at=now()`,
          [input.auth.user.id, input.connectionId, candidate.external_trade_key, candidate.external_position_id],
        );
      }
      const finalStatus = input.action === "link_manual" ? "linked"
        : input.action === "publish_separate" ? "published"
          : input.action === "suppress_deleted" ? "suppressed" : "rejected";
      const resolved = await client.query(
        `UPDATE ctrader_live_reconciliation_candidates SET
           status=$1, resolution_action=$2, resolved_trade_id=$3,
           merged_broker_snapshot=$4::jsonb, resolved_at=now(), row_version=row_version+1
         WHERE id=$5 AND user_id=$6 AND broker_connection_id=$7
           AND row_version=$8 AND status='pending'`,
        [finalStatus, input.action, resolvedTradeId,
          beforeBroker === null ? null : JSON.stringify(beforeBroker), input.candidateId,
          input.auth.user.id, input.connectionId, input.expectedVersion],
      );
      if (resolved.rowCount !== 1) throw new AppError(409, "VERSION_CONFLICT", "Candidate changed during resolution");
      await client.query(
        `INSERT INTO ctrader_live_reconciliation_resolutions (
           id,user_id,broker_connection_id,candidate_id,client_request_id,
           request_hash,action,selected_manual_trade_id,before_manual,before_broker,
           staged_projection,resolved_trade_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,
        [randomUUID(), input.auth.user.id, input.connectionId, input.candidateId,
          input.clientRequestId, hash, input.action, selectedManualId,
          beforeManual === null ? null : JSON.stringify(beforeManual),
          beforeBroker === null ? null : JSON.stringify(beforeBroker),
          JSON.stringify(candidate.projected_trade), resolvedTradeId],
      );
      await client.query(
        `INSERT INTO audit_events (
           user_id,session_id,event_type,target_type,target_id,metadata
         ) VALUES ($1,$2,'ctrader.live_reconciliation_resolved','ctrader_live_reconciliation_candidate',$3,
           jsonb_build_object('connectionId',$4::text,'action',$5::text,
             'manualTradeId',$6::text,'resolvedTradeId',$7::text,
             'preservedFields',CASE WHEN $5::text='link_manual'
               THEN jsonb_build_array('id','created_at','trade_date','stop_loss','take_profit','strategy','emotion','notes','tags','psychology','custom_fields','files')
               ELSE '[]'::jsonb END))` ,
        [input.auth.user.id, input.auth.sessionId, input.candidateId, input.connectionId,
          input.action, selectedManualId, resolvedTradeId],
      );
      return this.readLiveResolvedCandidate(client, input.auth.user.id, input.connectionId, input.candidateId);
    });
    await this.events.publish(input.auth.user.id, "ctrader.live_reconciliation_resolved", {
      connectionId: input.connectionId,
      candidateId: input.candidateId,
      action: input.action,
    }).catch(() => undefined);
    if (input.action !== "reject") {
      await this.events.publish(input.auth.user.id, "trades.changed", {
        reason: "ctrader_live_reconciliation",
        connectionId: input.connectionId,
        candidateId: input.candidateId,
        action: input.action,
      }).catch(() => undefined);
    }
    return outcome;
  }

  private async readLiveResolvedCandidate(
    client: PoolClient,
    userId: string,
    connectionId: string,
    candidateId: string,
  ): Promise<{ candidate: CTraderLiveReconciliationCandidate }> {
    const result = await client.query<LiveReconciliationCandidateRow>(
      `${liveReconciliationCandidateSelect}
       WHERE candidate.id=$1 AND candidate.user_id=$2 AND candidate.broker_connection_id=$3`,
      [candidateId, userId, connectionId],
    );
    if (!result.rows[0]) throw notFound("cTrader live reconciliation decision");
    return { candidate: mapLiveReconciliationCandidate(result.rows[0]) };
  }

  async resolveReconciliationCandidate(input: {
    auth: AuthContext;
    connectionId: string;
    candidateId: string;
    importId: string;
    action: CTraderReconciliationAction;
    expectedVersion: number;
    clientRequestId: string;
    idempotencyKey: string;
  }): Promise<{ candidate: CTraderReconciliationCandidate; historicalImport: CTraderHistoricalImport }> {
    const hash = requestHash({
      connectionId: input.connectionId,
      candidateId: input.candidateId,
      importId: input.importId,
      action: input.action,
      expectedVersion: input.expectedVersion,
      clientRequestId: input.clientRequestId,
    });
    return withTransaction(this.database, async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`ctrader:resolution:${input.auth.user.id}:${input.clientRequestId}`],
      );
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [input.connectionId],
      );
      const previous = await client.query<{ request_hash: Buffer; candidate_id: string }>(
        `SELECT request_hash, candidate_id FROM ctrader_reconciliation_resolutions
         WHERE user_id=$1 AND client_request_id=$2 LIMIT 1`,
        [input.auth.user.id, input.clientRequestId],
      );
      if (previous.rows[0]) {
        if (!previous.rows[0].request_hash.equals(hash) || previous.rows[0].candidate_id !== input.candidateId) {
          throw new AppError(409, "IDEMPOTENCY_CONFLICT", "clientRequestId was already used for a different decision");
        }
        return this.readResolvedCandidate(client, input.auth.user.id, input.connectionId, input.importId, input.candidateId);
      }
      const candidateResult = await client.query<{
        id: string;
        row_version: number;
        status: string;
        classification: CTraderReconciliationCandidate["classification"];
        external_position_id: string;
        external_trade_key: string;
        manual_trade_id: string | null;
        manual_row_version: number | null;
        projected_trade: unknown;
      }>(
        `SELECT rc.id, rc.row_version, rc.status, rc.classification,
                rc.external_position_id, rc.external_trade_key,
                rc.manual_trade_id, rc.manual_row_version, rc.projected_trade
         FROM ctrader_reconciliation_candidates rc
         JOIN ctrader_historical_imports hi
           ON hi.id=rc.import_id AND hi.user_id=rc.user_id
              AND hi.broker_connection_id=rc.broker_connection_id
         JOIN broker_connections connection
           ON connection.id=rc.broker_connection_id AND connection.user_id=rc.user_id
         WHERE rc.id=$1 AND rc.import_id=$2 AND rc.user_id=$3
            AND rc.broker_connection_id=$4
            AND hi.status='review'
            AND connection.connected=true
            AND connection.connection_mode='mcp_read'
            AND connection.oauth_scope='mcp_read'
         FOR UPDATE OF rc, hi, connection`,
        [input.candidateId, input.importId, input.auth.user.id, input.connectionId],
      );
      const candidate = candidateResult.rows[0];
      if (!candidate) throw notFound("cTrader reconciliation candidate");
      if (candidate.status !== "pending") {
        throw new AppError(409, "RECONCILIATION_ALREADY_RESOLVED", "This candidate has already been resolved");
      }
      if (candidate.row_version !== input.expectedVersion) {
        throw new AppError(409, "VERSION_CONFLICT", "The reconciliation candidate changed; reload before deciding");
      }
      const projection = reviewedProjection(candidate.projected_trade);
      const allowed = new Set<CTraderReconciliationAction>(
        candidate.classification === "high_confidence"
          ? ["link_manual", "publish_separate", "reject"]
          : candidate.classification === "deleted_manual"
            ? ["suppress_deleted", "reject"]
            : candidate.classification === "execution_only"
              ? ["reject"]
              : projection ? ["publish_separate", "reject"] : ["reject"],
      );
      if (!allowed.has(input.action)) {
        throw new AppError(409, "RECONCILIATION_ACTION_INVALID", "This action is not safe for the selected candidate");
      }
      if ((input.action === "link_manual" || input.action === "publish_separate") && !projection) {
        throw new AppError(409, "RECONCILIATION_PROJECTION_INCOMPLETE", "Authoritative broker fields are incomplete");
      }
      if (
        input.action === "publish_separate"
        && projection
        && !projection.isOpen
        && projection.pnl === null
        && !projectionHasCalculatedGross(candidate.projected_trade)
      ) {
        throw new AppError(
          409,
          "RECONCILIATION_PNL_UNAVAILABLE",
          "A closed broker trade cannot be published without authoritative P&L",
        );
      }
      if (input.action === "link_manual" || input.action === "publish_separate") {
        const identityOwner = await client.query<{ id: string }>(
          `SELECT id FROM trades
           WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
             AND deleted_at IS NULL
             AND ($4::uuid IS NULL OR id<>$4::uuid)
           FOR UPDATE`,
          [
            input.auth.user.id,
            input.connectionId,
            candidate.external_trade_key,
            input.action === "link_manual" ? candidate.manual_trade_id : null,
          ],
        );
        const tombstone = await client.query<{ external_trade_key: string }>(
          `SELECT external_trade_key FROM ctrader_trade_tombstones
           WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
           FOR UPDATE`,
          [input.auth.user.id, input.connectionId, candidate.external_trade_key],
        );
        if (identityOwner.rows[0] || tombstone.rows[0]) {
          throw new AppError(
            409,
            "RECONCILIATION_IDENTITY_CONFLICT",
            "This broker position was already imported, linked, or suppressed; reload the review",
          );
        }
      }
      let resolvedTradeId: string | null = null;
      let beforeManual: unknown = null;
      if (input.action === "link_manual") {
        if (!candidate.manual_trade_id || candidate.manual_row_version === null || !projection) {
          throw new AppError(409, "RECONCILIATION_MANUAL_TRADE_REQUIRED", "A unique active manual trade is required");
        }
        const manual = await client.query<{ row: unknown; row_version: number }>(
          `SELECT to_jsonb(t) AS row, t.row_version
           FROM trades t
           WHERE t.id=$1 AND t.user_id=$2 AND t.deleted_at IS NULL
             AND EXISTS (
               SELECT 1 FROM broker_connections c
               WHERE c.id=$3 AND c.user_id=$2
                 AND (
                   (c.mapped_account_id IS NOT NULL AND t.account_id=c.mapped_account_id)
                   OR (
                     c.mapped_account_id IS NULL
                     AND c.legacy_mapped_account_id IS NOT NULL
                     AND t.legacy_account_id=c.legacy_mapped_account_id
                   )
                 )
             )
           FOR UPDATE`,
          [candidate.manual_trade_id, input.auth.user.id, input.connectionId],
        );
        if (!manual.rows[0] || manual.rows[0].row_version !== candidate.manual_row_version) {
          throw new AppError(409, "MANUAL_TRADE_CHANGED", "The manual trade changed; regenerate the review before linking");
        }
        beforeManual = manual.rows[0].row;
        await client.query(
          `INSERT INTO ctrader_trade_links (
             user_id, broker_connection_id, external_position_id,
             external_trade_key, trade_id, import_id
           ) VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            input.auth.user.id, input.connectionId, candidate.external_position_id,
            candidate.external_trade_key, candidate.manual_trade_id, input.importId,
          ],
        );
        const updated = await client.query<{ id: string }>(
          `UPDATE trades SET
             broker_connection_id=$1, external_trade_key=$2, broker_trade_id=$3,
             source_system='ctrader', ingestion_method='reconciled',
             symbol=$4, asset=COALESCE($5,asset), instrument=$4, direction=$6,
             entry_price=$7, exit_price=COALESCE($8,exit_price),
             quantity=COALESCE($9,quantity), pnl=COALESCE($10,pnl),
             is_open=$11, trade_date=COALESCE(trade_date,$12::date), entry_at=$13,
             exit_at=COALESCE($14,exit_at), legacy_entry_time=$15,
             legacy_exit_time=COALESCE($16,legacy_exit_time),
             broker_data=broker_data || $17::jsonb, calculation_version=2,
             row_version=row_version+1
           WHERE id=$18 AND user_id=$19 AND row_version=$20 AND deleted_at IS NULL
           RETURNING id`,
          [
            input.connectionId, candidate.external_trade_key, projection.positionId,
            projection.symbol, projection.asset, projection.direction, projection.entryPrice,
            projection.exitPrice, projection.quantity, projection.pnl, projection.isOpen,
            projection.tradeDate, projection.entryAt, projection.exitAt, projection.entryTime,
            projection.exitTime, JSON.stringify(reviewedProjectionBrokerData(projection, manual.rows[0].row)), candidate.manual_trade_id,
            input.auth.user.id, candidate.manual_row_version,
          ],
        );
        if (!updated.rows[0]) throw new AppError(409, "MANUAL_TRADE_CHANGED", "The manual trade changed during linking");
        resolvedTradeId = updated.rows[0].id;
        await client.query(
          `UPDATE trade_executions SET trade_id=$1
           WHERE user_id=$2 AND broker_connection_id=$3 AND external_position_id=$4`,
          [resolvedTradeId, input.auth.user.id, input.connectionId, candidate.external_position_id],
        );
      } else if (input.action === "publish_separate" && projection) {
        resolvedTradeId = randomUUID();
        await client.query(
          `INSERT INTO trades (
             id,user_id,account_id,legacy_account_id,broker_connection_id,
             source_system,ingestion_method,external_trade_key,broker_trade_id,
             symbol,asset,instrument,direction,entry_price,exit_price,quantity,pnl,
             is_open,trade_date,entry_at,exit_at,legacy_entry_time,legacy_exit_time,
             broker_data,calculation_version,row_version
           ) SELECT $1,$2,c.mapped_account_id,c.legacy_mapped_account_id,c.id,
             'ctrader','api',$3,$4,$5,$6,$5,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
             $18::jsonb,2,1
             FROM broker_connections c WHERE c.id=$19 AND c.user_id=$2`,
          [
            resolvedTradeId, input.auth.user.id, candidate.external_trade_key, projection.positionId,
            projection.symbol, projection.asset, projection.direction, projection.entryPrice,
            projection.exitPrice, projection.quantity, projection.pnl, projection.isOpen,
            projection.tradeDate, projection.entryAt, projection.exitAt, projection.entryTime,
            projection.exitTime, JSON.stringify(reviewedProjectionBrokerData(projection)), input.connectionId,
          ],
        );
        await client.query(
          `UPDATE trade_executions SET trade_id=$1
           WHERE user_id=$2 AND broker_connection_id=$3 AND external_position_id=$4`,
          [resolvedTradeId, input.auth.user.id, input.connectionId, candidate.external_position_id],
        );
      } else if (input.action === "suppress_deleted") {
        if (!candidate.manual_trade_id || candidate.manual_row_version === null) {
          throw new AppError(409, "DELETED_MATCH_REQUIRED", "A versioned deleted manual match is required");
        }
        const deleted = await client.query<{ id: string; row: unknown; row_version: number }>(
          `SELECT t.id, to_jsonb(t) AS row, t.row_version
           FROM trades t
           WHERE t.id=$1 AND t.user_id=$2 AND t.deleted_at IS NOT NULL
             AND t.row_version=$3
             AND EXISTS (
               SELECT 1 FROM broker_connections c
               WHERE c.id=$4 AND c.user_id=$2
                 AND (
                   (c.mapped_account_id IS NOT NULL AND t.account_id=c.mapped_account_id)
                   OR (
                     c.mapped_account_id IS NULL
                     AND c.legacy_mapped_account_id IS NOT NULL
                     AND t.legacy_account_id=c.legacy_mapped_account_id
                   )
                 )
             )
           FOR UPDATE`,
          [candidate.manual_trade_id, input.auth.user.id, candidate.manual_row_version, input.connectionId],
        );
        if (!deleted.rows[0] || deleted.rows[0].row_version !== candidate.manual_row_version) {
          throw new AppError(409, "DELETED_MATCH_CHANGED", "The deleted trade match changed; regenerate the review");
        }
        beforeManual = deleted.rows[0].row;
        await client.query(
          `INSERT INTO ctrader_trade_tombstones (
             user_id, broker_connection_id, external_trade_key, external_position_id
           ) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id,broker_connection_id,external_trade_key) DO UPDATE SET
             external_position_id=EXCLUDED.external_position_id, purged_at=now()`,
          [input.auth.user.id, input.connectionId, candidate.external_trade_key, candidate.external_position_id],
        );
      }
      const finalStatus = input.action === "link_manual" ? "linked"
        : input.action === "publish_separate" ? "published"
          : input.action === "suppress_deleted" ? "suppressed" : "rejected";
      const resolved = await client.query(
        `UPDATE ctrader_reconciliation_candidates SET
           status=$1, resolution_action=$2, resolved_trade_id=$3,
           resolved_at=now(), row_version=row_version+1
         WHERE id=$4 AND user_id=$5 AND row_version=$6 AND status='pending'`,
        [finalStatus, input.action, resolvedTradeId, input.candidateId, input.auth.user.id, input.expectedVersion],
      );
      if (resolved.rowCount !== 1) {
        throw new AppError(409, "VERSION_CONFLICT", "The reconciliation candidate changed during resolution");
      }
      await client.query(
        `INSERT INTO ctrader_reconciliation_resolutions (
           id,user_id,broker_connection_id,import_id,candidate_id,client_request_id,request_hash,action,
           before_manual,staged_projection,resolved_trade_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
        [
          randomUUID(), input.auth.user.id, input.connectionId, input.importId,
          input.candidateId, input.clientRequestId, hash, input.action,
          beforeManual === null ? null : JSON.stringify(beforeManual),
          candidate.projected_trade === null ? null : JSON.stringify(candidate.projected_trade), resolvedTradeId,
        ],
      );
      await client.query(
        `INSERT INTO audit_events (
           user_id, session_id, event_type, target_type, target_id, metadata
         ) VALUES ($1,$2,'ctrader.reconciliation_resolved','ctrader_reconciliation_candidate',$3,
           jsonb_build_object('connectionId',$4::text,'importId',$5::text,'action',$6::text,
             'manualTradeId',$7::text,'resolvedTradeId',$8::text,
             'preservedFields',CASE WHEN $6::text='link_manual'
               THEN jsonb_build_array('trade_date','stop_loss','take_profit','strategy','emotion','notes','tags','psychology','custom_fields','files')
               ELSE '[]'::jsonb END))`,
        [
          input.auth.user.id, input.auth.sessionId, input.candidateId, input.connectionId,
          input.importId, input.action, candidate.manual_trade_id, resolvedTradeId,
        ],
      );
      await client.query(
        `UPDATE ctrader_historical_imports hi SET
           status='completed', finished_at=now(), row_version=row_version+1
         WHERE hi.id=$1 AND hi.user_id=$2
           AND NOT EXISTS (
             SELECT 1 FROM ctrader_reconciliation_candidates pending
             WHERE pending.import_id=hi.id AND pending.user_id=hi.user_id
               AND pending.status='pending'
           )`,
        [input.importId, input.auth.user.id],
      );
      return this.readResolvedCandidate(client, input.auth.user.id, input.connectionId, input.importId, input.candidateId);
    });
  }

  private async readResolvedCandidate(
    client: PoolClient,
    userId: string,
    connectionId: string,
    importId: string,
    candidateId: string,
  ): Promise<{ candidate: CTraderReconciliationCandidate; historicalImport: CTraderHistoricalImport }> {
    const candidates = await client.query<ReconciliationCandidateRow>(
      `${reconciliationCandidateSelect}
       WHERE rc.id=$1 AND rc.import_id=$2 AND rc.user_id=$3 AND rc.broker_connection_id=$4`,
      [candidateId, importId, userId, connectionId],
    );
    const imports = await client.query<HistoricalImportRow>(
      `${historicalImportSelect}
       WHERE id=$1 AND user_id=$2 AND broker_connection_id=$3`,
      [importId, userId, connectionId],
    );
    if (!candidates.rows[0] || !imports.rows[0]) throw notFound("cTrader reconciliation decision");
    return {
      candidate: mapReconciliationCandidate(candidates.rows[0]),
      historicalImport: mapHistoricalImport(imports.rows[0]),
    };
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
