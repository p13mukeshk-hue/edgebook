import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/database.js";
import { withTransaction } from "../db/database.js";
import type { EventBus } from "../events/event-bus.js";
import type { CTraderAccountSession, CTraderGateway } from "./client.js";
import { CTraderApiError } from "./client.js";
import { connectionTokenAad, type TokenCipher } from "./crypto.js";
import type { CTraderOAuthClient } from "./oauth.js";
import { CTraderOAuthError } from "./oauth.js";
import { projectPosition, volumeCentsToUnits, type CTraderTradeProjection } from "./projection.js";
import {
  parseDeals,
  type CTraderAsset,
  type CTraderAssetClass,
  type CTraderCashFlow,
  type CTraderDeal,
  type CTraderEnvironment,
  type CTraderLightSymbol,
  type CTraderSymbolCategory,
  type CTraderSymbolSpec,
  type CTraderTraderMetadata,
} from "./protocol.js";

type StoredOfficialExecutionRow = QueryResultRow & {
  external_execution_id: string;
  raw_payload: unknown;
};

type StoredMcpMoney = {
  rank: 0 | 1 | 2;
  net: { value: bigint; digits: number } | null;
  components: {
    grossProfit: bigint;
    commission: bigint;
    swap: bigint;
    pnlConversionFee: bigint;
    digits: number;
  } | null;
};

type StoredCashFlowRow = QueryResultRow & {
  external_cash_flow_id: string;
  operation_type: number | null;
  operation_name: string;
  raw_delta: string;
  raw_balance: string;
  raw_equity: string | null;
  currency_code: string;
  money_digits: number | null;
  money_digits_source: CashFlowMoneyDigitsSource;
  balance_version: string | null;
  occurred_at: Date | string;
};

type SyncConnectionRow = QueryResultRow & {
  id: string;
  user_id: string;
  external_account_id: string;
  provider_environment: CTraderEnvironment;
  connected: boolean;
  access_token_ciphertext: string | null;
  refresh_token_ciphertext: string | null;
  encryption_key_version: number | null;
  token_expires_at: Date | string | null;
  token_generation: string | number;
  sync_cursor: unknown;
  provider_metadata: unknown;
  mapped_account_id: string | null;
  legacy_mapped_account_id: string | null;
};

type OfficialProjectionContext = {
  connection: SyncConnectionRow;
  trader: CTraderTraderMetadata;
  assets: CTraderAsset[];
};

type StoredExecutionRow = QueryResultRow & {
  external_position_id: string;
  raw_payload: unknown;
};

type MissingCloseMoneyExecutionRow = QueryResultRow & {
  external_execution_id: string;
  external_position_id: string;
  executed_at: Date | string;
};

type MissingCashFlowMoneyRow = QueryResultRow & {
  external_cash_flow_id: string;
  occurred_at: Date | string;
};

type CashFlowScaleCoverageRow = QueryResultRow & {
  total_rows: string | number;
  scaled_rows: string | number;
  unscaled_rows: string | number;
};

type ExistingTradeRow = QueryResultRow & {
  id: string;
  deleted_at: Date | string | null;
  pnl: string | null;
  broker_data: unknown;
  reconciled_manual_trade: boolean;
};

type OfficialLiveManualTradeRow = QueryResultRow & {
  id: string;
  row_version: number;
  deleted_at: Date | string | null;
  symbol: string;
  direction: "Long" | "Short";
  entry_price: string;
  exit_price: string | null;
  quantity: string;
  pnl: string | null;
  trade_date: Date | string;
  entry_at: Date | string | null;
  exit_at: Date | string | null;
  strategy: string | null;
  emotion: string | null;
  notes: string | null;
  psychology: unknown;
  custom_fields: unknown;
  screenshot_count: number | string;
};

function reconciliationSymbol(value: string): string {
  const normalized = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  // Narrow legacy journal alias shared with the MCP reconciler.  It is used
  // only for duplicate identity comparison; the provider symbol stays XAUUSD.
  return normalized === "GOLD" ? "XAUUSD" : normalized;
}

function reconciliationDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function decimalWithin(
  left: string | null,
  right: string | null,
  relativeTolerance: number,
  absoluteTolerance: number,
): boolean {
  if (left === null || right === null) return left === right;
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) return false;
  const difference = Math.abs(leftNumber - rightNumber);
  return difference <= absoluteTolerance
    || difference / Math.max(Math.abs(leftNumber), Math.abs(rightNumber), 1e-12) <= relativeTolerance;
}

function dateDistanceDays(left: Date | string, right: string): number | null {
  const leftAt = Date.parse(`${reconciliationDate(left)}T00:00:00.000Z`);
  const rightAt = Date.parse(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(leftAt) || !Number.isFinite(rightAt)) return null;
  return Math.abs(leftAt - rightAt) / 86_400_000;
}

export type CTraderSyncCounters = {
  inserted: number;
  updated: number;
  fetchedDeals: number;
  insertedExecutions: number;
  updatedExecutions: number;
  insertedTrades: number;
  updatedTrades: number;
  unchangedTrades: number;
  archivedTradesPreserved: number;
  tombstonesPreserved: number;
  positionsProjected: number;
  positionsAwaitingReview: number;
  fetchedAccountCashFlows?: number;
  insertedAccountCashFlows?: number;
  updatedAccountCashFlows?: number;
  invalidatedAccountCashFlowFallbacks?: number;
  totalAccountCashFlows?: number;
  scaledAccountCashFlows?: number;
  unscaledAccountCashFlows?: number;
  attemptedCashFlowMoneyRetries?: number;
  completedCashFlowMoneyRetries?: number;
  pendingCashFlowMoneyRetries?: number;
  deauthorizedUnsupportedExactExecutions?: number;
  deauthorizedUnsupportedExactTrades?: number;
  sanitizedUnsupportedExactCandidates?: number;
  attemptedExactMoneyRetries?: number;
  completedExactMoneyRetries?: number;
  pendingExactMoneyRetries?: number;
};

export type CTraderSyncResult = {
  userId: string;
  connectionId: string;
  counters: CTraderSyncCounters;
  cursorBefore: Record<string, unknown>;
  cursorAfter: Record<string, unknown>;
};

export class CTraderSyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly requiresReauth = false,
  ) {
    super(message);
    this.name = "CTraderSyncError";
  }
}

/**
 * Locks the exact tenant-owned Edgebook account represented by a connection
 * snapshot and proves that its display/analytics currency agrees with the
 * broker's authoritative deposit currency. Call this before locking the
 * broker connection, then verify that the connection mapping is unchanged;
 * this follows the account -> connection lock order used by settings writes.
 */
export async function lockAndValidateMappedAccountCurrency(
  client: PoolClient,
  input: {
    userId: string;
    mappedAccountId: string | null;
    legacyMappedAccountId: string | null;
    providerCurrency: string | null;
  },
): Promise<void> {
  if (input.mappedAccountId === null && input.legacyMappedAccountId === null) return;
  const mapped = await client.query<{
    id: string;
    legacy_account_id: string | null;
    currency_code: string;
  }>(
    `SELECT id, legacy_account_id, currency_code FROM accounts
     WHERE user_id=$1 AND archived_at IS NULL
       AND (
         ($2::uuid IS NOT NULL AND id=$2::uuid)
         OR ($2::uuid IS NULL AND $3::text IS NOT NULL AND legacy_account_id=$3::text)
       )
     LIMIT 1
     FOR SHARE`,
    [input.userId, input.mappedAccountId, input.legacyMappedAccountId],
  );
  const account = mapped.rows[0];
  if (!account
    || (input.mappedAccountId !== null && account.id !== input.mappedAccountId)
    || (input.mappedAccountId === null && input.legacyMappedAccountId !== null
      && account.legacy_account_id !== input.legacyMappedAccountId)) {
    throw new CTraderSyncError(
      "CTRADER_ACCOUNT_MAPPING_CHANGED",
      "The mapped Edgebook account changed before cTrader data could be persisted",
      true,
    );
  }
  if (input.providerCurrency === null) {
    throw new CTraderSyncError(
      "CTRADER_ACCOUNT_CURRENCY_UNAVAILABLE",
      "cTrader did not expose the deposit currency required to validate the mapped Edgebook account",
      false,
    );
  }
  const mappedCurrency = account.currency_code.trim().toUpperCase();
  if (mappedCurrency !== input.providerCurrency.trim().toUpperCase()) {
    throw new CTraderSyncError(
      "CTRADER_ACCOUNT_CURRENCY_MISMATCH",
      `The mapped Edgebook account currency ${mappedCurrency} does not match cTrader deposit currency ${input.providerCurrency}`,
      false,
    );
  }
}

function sameConnectionMapping(
  left: { mappedAccountId: string | null; legacyMappedAccountId: string | null },
  right: { mappedAccountId: string | null; legacyMappedAccountId: string | null },
): boolean {
  return left.mappedAccountId === right.mappedAccountId
    && left.legacyMappedAccountId === right.legacyMappedAccountId;
}

export function mergeOfficialProjectionAuthority(input: {
  existing: {
    pnl: string | null;
    brokerData: unknown;
    reconciledManualTrade: boolean;
  } | null;
  providerPnl: string | null;
  providerBrokerData: Record<string, unknown>;
}): { pnl: string | null; brokerData: Record<string, unknown> } {
  const existingBrokerData = objectValue(input.existing?.brokerData);
  const existingPnlMethod = typeof existingBrokerData.pnlMethod === "string"
    ? existingBrokerData.pnlMethod
    : null;
  const existingPnlAuthority = typeof existingBrokerData.pnlAuthority === "string"
    ? existingBrokerData.pnlAuthority
    : null;
  const exactProviderMethods = new Set([
    "provider_close_detail_money_digits",
    "provider_explicit_net_cents",
    "provider_mixed_exact_money",
  ]);
  // A link proves that this row began as a manual journal, but it does not
  // prove that its current P&L is still manual. Once exact provider net has
  // superseded that value, a later incomplete projection must not relabel and
  // retain a stale provider subtotal as manual P&L. Older linked rows predate
  // pnlAuthority, so their exact pnlMethod is the backwards-compatible signal.
  const currentPnlIsManual = existingPnlAuthority === "preserved_reconciled_manual"
    || (existingPnlAuthority === null && !exactProviderMethods.has(existingPnlMethod ?? ""));
  const preservesManualPnl = input.existing?.reconciledManualTrade === true
    && input.providerPnl === null
    && input.existing.pnl !== null
    && currentPnlIsManual;
  return {
    pnl: preservesManualPnl ? input.existing?.pnl ?? null : input.providerPnl,
    brokerData: {
      ...(input.existing?.reconciledManualTrade === true ? existingBrokerData : {}),
      ...input.providerBrokerData,
      pnlAuthority: input.providerPnl !== null
        ? "provider"
        : preservesManualPnl ? "preserved_reconciled_manual" : "provider_unavailable",
      reconciledManualPnlPreserved: preservesManualPnl,
    },
  };
}

function objectValue(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function safeTimestamp(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 2_147_483_646_000 ? parsed : null;
}

const EXACT_MONEY_RETRY_QUEUE_VERSION = 1;
const EXACT_MONEY_RETRY_QUEUE_LIMIT = 500;
const EXACT_MONEY_RETRIES_PER_SYNC = 3;
const EXACT_MONEY_RETRY_ATTEMPT_LIMIT = 32;
const EXACT_MONEY_RETRY_BASE_DELAY_MS = 5 * 60 * 1_000;
const EXACT_MONEY_RETRY_MAX_DELAY_MS = 24 * 60 * 60 * 1_000;
const EXACT_MONEY_RETRY_WINDOW_RADIUS_MS = 60 * 1_000;
const EXACT_MONEY_RETRY_HISTORY_REQUEST_LIMIT = 16;
const CASH_FLOW_MONEY_RETRY_QUEUE_VERSION = 1;
const CASH_FLOW_MONEY_RETRY_QUEUE_LIMIT = 500;
const CASH_FLOW_MONEY_RETRIES_PER_SYNC = 3;

export type CTraderExactMoneyRetry = {
  executionId: string;
  positionId: string;
  executionTimestamp: number;
  attemptCount: number;
  firstObservedAt: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number;
};

export type CTraderCashFlowMoneyRetry = {
  balanceHistoryId: string;
  changeBalanceTimestamp: number;
  attemptCount: number;
  firstObservedAt: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number;
};

function retryCursorError(detail: string): CTraderSyncError {
  return new CTraderSyncError(
    "CTRADER_EXACT_MONEY_RETRY_CURSOR_INVALID",
    `The cTrader exact-money retry cursor ${detail}`,
    false,
  );
}

function retryCursorId(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw retryCursorError(`has an invalid ${field}`);
  }
  try {
    if (BigInt(value) > 9_223_372_036_854_775_807n) {
      throw retryCursorError(`has an out-of-range ${field}`);
    }
  } catch (error) {
    if (error instanceof CTraderSyncError) throw error;
    throw retryCursorError(`has an invalid ${field}`);
  }
  return value;
}

/**
 * Reads the durable retry queue without accepting partially valid state. A
 * malformed cursor could otherwise widen arbitrary provider history windows or
 * create an unbounded request loop, so queue version, size and every field are
 * checked before the first retry request is made.
 */
export function parseExactMoneyRetryQueue(cursor: Record<string, unknown>): CTraderExactMoneyRetry[] {
  const version = cursor.exactMoneyRetryQueueVersion;
  const value = cursor.exactMoneyRetries;
  if (version === undefined && value === undefined) return [];
  if (version !== EXACT_MONEY_RETRY_QUEUE_VERSION || !Array.isArray(value)) {
    throw retryCursorError("has an unsupported version or shape");
  }
  if (value.length > EXACT_MONEY_RETRY_QUEUE_LIMIT) {
    throw retryCursorError(`exceeds the ${EXACT_MONEY_RETRY_QUEUE_LIMIT}-entry safety limit`);
  }
  const allowedKeys = new Set([
    "executionId", "positionId", "executionTimestamp", "attemptCount",
    "firstObservedAt", "lastAttemptAt", "nextAttemptAt",
  ]);
  const seen = new Set<string>();
  const parsed = value.map((candidate, index): CTraderExactMoneyRetry => {
    const entry = objectValue(candidate);
    if (Object.keys(entry).length === 0 || Object.keys(entry).some((key) => !allowedKeys.has(key))) {
      throw retryCursorError(`entry ${index} has an invalid shape`);
    }
    const executionId = retryCursorId(entry.executionId, `executionId in entry ${index}`);
    const positionId = retryCursorId(entry.positionId, `positionId in entry ${index}`);
    if (seen.has(executionId)) throw retryCursorError(`contains duplicate executionId ${executionId}`);
    seen.add(executionId);
    const executionTimestamp = safeTimestamp(entry.executionTimestamp);
    const firstObservedAt = safeTimestamp(entry.firstObservedAt);
    const lastAttemptAt = entry.lastAttemptAt === null ? null : safeTimestamp(entry.lastAttemptAt);
    const nextAttemptAt = safeTimestamp(entry.nextAttemptAt);
    const attemptCount = typeof entry.attemptCount === "number" ? entry.attemptCount : Number.NaN;
    if (executionTimestamp === null || firstObservedAt === null || nextAttemptAt === null
      || !Number.isSafeInteger(attemptCount) || attemptCount < 0
      || attemptCount > EXACT_MONEY_RETRY_ATTEMPT_LIMIT
      || (entry.lastAttemptAt !== null && lastAttemptAt === null)) {
      throw retryCursorError(`entry ${index} has invalid bounds`);
    }
    if ((attemptCount === 0 && lastAttemptAt !== null)
      || (attemptCount > 0 && lastAttemptAt === null)
      || (lastAttemptAt !== null && lastAttemptAt < firstObservedAt)
      || nextAttemptAt < (lastAttemptAt ?? firstObservedAt)) {
      throw retryCursorError(`entry ${index} has an inconsistent retry chronology`);
    }
    return {
      executionId,
      positionId,
      executionTimestamp,
      attemptCount,
      firstObservedAt,
      lastAttemptAt,
      nextAttemptAt,
    };
  });
  return parsed.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt
    || left.executionTimestamp - right.executionTimestamp
    || (BigInt(left.executionId) < BigInt(right.executionId) ? -1 : 1));
}

/** Selects a fixed number of due retries and never hits one position twice in a sync. */
export function selectDueExactMoneyRetries(
  queue: readonly CTraderExactMoneyRetry[],
  now: number,
): CTraderExactMoneyRetry[] {
  if (safeTimestamp(now) === null) throw retryCursorError("was evaluated at an invalid timestamp");
  const selected: CTraderExactMoneyRetry[] = [];
  const positions = new Set<string>();
  for (const entry of queue) {
    if (entry.nextAttemptAt > now || positions.has(entry.positionId)) continue;
    selected.push(entry);
    positions.add(entry.positionId);
    if (selected.length === EXACT_MONEY_RETRIES_PER_SYNC) break;
  }
  return selected;
}

function cashFlowRetryCursorError(detail: string): CTraderSyncError {
  return new CTraderSyncError(
    "CTRADER_CASH_FLOW_MONEY_RETRY_CURSOR_INVALID",
    `The cTrader cash-flow money retry cursor ${detail}`,
    false,
  );
}

export function parseCashFlowMoneyRetryQueue(cursor: Record<string, unknown>): CTraderCashFlowMoneyRetry[] {
  const version = cursor.cashFlowMoneyRetryQueueVersion;
  const value = cursor.cashFlowMoneyRetries;
  if (version === undefined && value === undefined) return [];
  if (version !== CASH_FLOW_MONEY_RETRY_QUEUE_VERSION || !Array.isArray(value)) {
    throw cashFlowRetryCursorError("has an unsupported version or shape");
  }
  if (value.length > CASH_FLOW_MONEY_RETRY_QUEUE_LIMIT) {
    throw cashFlowRetryCursorError(`exceeds the ${CASH_FLOW_MONEY_RETRY_QUEUE_LIMIT}-entry safety limit`);
  }
  const allowedKeys = new Set([
    "balanceHistoryId", "changeBalanceTimestamp", "attemptCount",
    "firstObservedAt", "lastAttemptAt", "nextAttemptAt",
  ]);
  const seen = new Set<string>();
  const parsed = value.map((candidate, index): CTraderCashFlowMoneyRetry => {
    const entry = objectValue(candidate);
    if (Object.keys(entry).length === 0 || Object.keys(entry).some((key) => !allowedKeys.has(key))) {
      throw cashFlowRetryCursorError(`entry ${index} has an invalid shape`);
    }
    let balanceHistoryId: string;
    try {
      balanceHistoryId = retryCursorId(entry.balanceHistoryId, `balanceHistoryId in entry ${index}`);
    } catch {
      throw cashFlowRetryCursorError(`entry ${index} has an invalid balanceHistoryId`);
    }
    if (seen.has(balanceHistoryId)) throw cashFlowRetryCursorError(`contains duplicate balanceHistoryId ${balanceHistoryId}`);
    seen.add(balanceHistoryId);
    const changeBalanceTimestamp = safeTimestamp(entry.changeBalanceTimestamp);
    const firstObservedAt = safeTimestamp(entry.firstObservedAt);
    const lastAttemptAt = entry.lastAttemptAt === null ? null : safeTimestamp(entry.lastAttemptAt);
    const nextAttemptAt = safeTimestamp(entry.nextAttemptAt);
    const attemptCount = typeof entry.attemptCount === "number" ? entry.attemptCount : Number.NaN;
    if (changeBalanceTimestamp === null || firstObservedAt === null || nextAttemptAt === null
      || !Number.isSafeInteger(attemptCount) || attemptCount < 0
      || attemptCount > EXACT_MONEY_RETRY_ATTEMPT_LIMIT
      || (entry.lastAttemptAt !== null && lastAttemptAt === null)) {
      throw cashFlowRetryCursorError(`entry ${index} has invalid bounds`);
    }
    if ((attemptCount === 0 && lastAttemptAt !== null)
      || (attemptCount > 0 && lastAttemptAt === null)
      || (lastAttemptAt !== null && lastAttemptAt < firstObservedAt)
      || nextAttemptAt < (lastAttemptAt ?? firstObservedAt)) {
      throw cashFlowRetryCursorError(`entry ${index} has an inconsistent retry chronology`);
    }
    return {
      balanceHistoryId,
      changeBalanceTimestamp,
      attemptCount,
      firstObservedAt,
      lastAttemptAt,
      nextAttemptAt,
    };
  });
  return parsed.sort((left, right) => left.nextAttemptAt - right.nextAttemptAt
    || left.changeBalanceTimestamp - right.changeBalanceTimestamp
    || (BigInt(left.balanceHistoryId) < BigInt(right.balanceHistoryId) ? -1 : 1));
}

function selectDueCashFlowMoneyRetries(
  queue: readonly CTraderCashFlowMoneyRetry[],
  now: number,
): CTraderCashFlowMoneyRetry[] {
  if (safeTimestamp(now) === null) throw cashFlowRetryCursorError("was evaluated at an invalid timestamp");
  const selected: CTraderCashFlowMoneyRetry[] = [];
  const timestamps = new Set<number>();
  for (const entry of queue) {
    if (entry.nextAttemptAt > now || timestamps.has(entry.changeBalanceTimestamp)) continue;
    selected.push(entry);
    timestamps.add(entry.changeBalanceTimestamp);
    if (selected.length === CASH_FLOW_MONEY_RETRIES_PER_SYNC) break;
  }
  return selected;
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(
    EXACT_MONEY_RETRY_MAX_DELAY_MS,
    EXACT_MONEY_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, Math.min(attemptCount - 1, 20))),
  );
}

function advancedExactMoneyRetry(entry: CTraderExactMoneyRetry, attemptedAt: number): CTraderExactMoneyRetry {
  const attemptCount = Math.min(EXACT_MONEY_RETRY_ATTEMPT_LIMIT, entry.attemptCount + 1);
  return {
    ...entry,
    attemptCount,
    lastAttemptAt: attemptedAt,
    nextAttemptAt: Math.min(2_147_483_646_000, attemptedAt + retryDelayMs(attemptCount)),
  };
}

function advancedCashFlowMoneyRetry(
  entry: CTraderCashFlowMoneyRetry,
  attemptedAt: number,
): CTraderCashFlowMoneyRetry {
  const attemptCount = Math.min(EXACT_MONEY_RETRY_ATTEMPT_LIMIT, entry.attemptCount + 1);
  return {
    ...entry,
    attemptCount,
    lastAttemptAt: attemptedAt,
    nextAttemptAt: Math.min(2_147_483_646_000, attemptedAt + retryDelayMs(attemptCount)),
  };
}

function missingExactMoneyClosings(deals: readonly CTraderDeal[]): CTraderDeal[] {
  const chronological = [...deals].sort(timestampCompare);
  const opening = chronological.find((deal) => deal.closePositionDetail === null);
  if (!opening) return [];
  return chronological.filter((deal) =>
    deal.tradeSide !== opening.tradeSide
    && (deal.closePositionDetail === null || deal.closePositionDetail.moneyDigits === null));
}

function reconcileExactMoneyRetryQueue(input: {
  previous: readonly CTraderExactMoneyRetry[];
  attemptedExecutionIds: ReadonlySet<string>;
  projectedPositions: ReadonlyMap<string, readonly CTraderDeal[]>;
  discoveredMissing?: ReadonlyArray<{
    executionId: string;
    positionId: string;
    executionTimestamp: number;
  }>;
  observedAt: number;
}): CTraderExactMoneyRetry[] {
  const next = new Map(input.previous.map((entry) => [entry.executionId, entry]));
  const projectedPositionIds = new Set(input.projectedPositions.keys());
  for (const [positionId, deals] of input.projectedPositions) {
    const missing = new Map(missingExactMoneyClosings(deals).map((deal) => [deal.dealId, deal]));
    for (const [executionId, entry] of next) {
      if (entry.positionId === positionId && !missing.has(executionId)) next.delete(executionId);
    }
    for (const deal of missing.values()) {
      const previous = next.get(deal.dealId);
      if (previous) {
        next.set(
          deal.dealId,
          input.attemptedExecutionIds.has(deal.dealId)
            ? advancedExactMoneyRetry(previous, input.observedAt)
            : previous,
        );
      } else {
        next.set(deal.dealId, {
          executionId: deal.dealId,
          positionId: deal.positionId,
          executionTimestamp: deal.executionTimestamp,
          attemptCount: 0,
          firstObservedAt: input.observedAt,
          lastAttemptAt: null,
          nextAttemptAt: Math.min(2_147_483_646_000, input.observedAt + EXACT_MONEY_RETRY_BASE_DELAY_MS),
        });
      }
    }
  }
  // A bounded retry window may temporarily return no copy of its target deal.
  // Persist backoff for that attempt instead of hammering the same window on
  // every worker tick; the existing obligation remains durable.
  for (const entry of input.previous) {
    if (input.attemptedExecutionIds.has(entry.executionId)
      && !projectedPositionIds.has(entry.positionId)) {
      next.set(entry.executionId, advancedExactMoneyRetry(entry, input.observedAt));
    }
  }
  for (const discovered of input.discoveredMissing ?? []) {
    if (next.has(discovered.executionId) || next.size >= EXACT_MONEY_RETRY_QUEUE_LIMIT) continue;
    next.set(discovered.executionId, {
      ...discovered,
      attemptCount: 0,
      firstObservedAt: input.observedAt,
      lastAttemptAt: null,
      nextAttemptAt: Math.min(2_147_483_646_000, input.observedAt + EXACT_MONEY_RETRY_BASE_DELAY_MS),
    });
  }
  if (next.size > EXACT_MONEY_RETRY_QUEUE_LIMIT) {
    throw new CTraderSyncError(
      "CTRADER_EXACT_MONEY_RETRY_LIMIT_EXCEEDED",
      `More than ${EXACT_MONEY_RETRY_QUEUE_LIMIT} closed executions are missing authoritative cTrader money`,
      false,
    );
  }
  return [...next.values()].sort((left, right) => left.nextAttemptAt - right.nextAttemptAt
    || left.executionTimestamp - right.executionTimestamp
    || (BigInt(left.executionId) < BigInt(right.executionId) ? -1 : 1));
}

function reconcileCashFlowMoneyRetryQueue(input: {
  previous: readonly CTraderCashFlowMoneyRetry[];
  attemptedBalanceHistoryIds: ReadonlySet<string>;
  fetchedCashFlows: readonly CTraderCashFlow[];
  discoveredMissing: ReadonlyArray<{ balanceHistoryId: string; changeBalanceTimestamp: number }>;
  observedAt: number;
}): CTraderCashFlowMoneyRetry[] {
  const next = new Map(input.previous.map((entry) => [entry.balanceHistoryId, entry]));
  const fetchedIds = new Set<string>();
  for (const cashFlow of input.fetchedCashFlows) {
    fetchedIds.add(cashFlow.balanceHistoryId);
    if (cashFlow.moneyDigits !== null) {
      next.delete(cashFlow.balanceHistoryId);
      continue;
    }
    const prior = next.get(cashFlow.balanceHistoryId);
    if (prior) {
      next.set(
        cashFlow.balanceHistoryId,
        input.attemptedBalanceHistoryIds.has(cashFlow.balanceHistoryId)
          ? advancedCashFlowMoneyRetry(prior, input.observedAt)
          : prior,
      );
    } else if (next.size < CASH_FLOW_MONEY_RETRY_QUEUE_LIMIT) {
      next.set(cashFlow.balanceHistoryId, {
        balanceHistoryId: cashFlow.balanceHistoryId,
        changeBalanceTimestamp: cashFlow.changeBalanceTimestamp,
        attemptCount: 0,
        firstObservedAt: input.observedAt,
        lastAttemptAt: null,
        nextAttemptAt: Math.min(2_147_483_646_000, input.observedAt + EXACT_MONEY_RETRY_BASE_DELAY_MS),
      });
    }
  }
  for (const prior of input.previous) {
    if (input.attemptedBalanceHistoryIds.has(prior.balanceHistoryId)
      && !fetchedIds.has(prior.balanceHistoryId)) {
      next.set(prior.balanceHistoryId, advancedCashFlowMoneyRetry(prior, input.observedAt));
    }
  }
  for (const discovered of input.discoveredMissing) {
    if (next.has(discovered.balanceHistoryId) || next.size >= CASH_FLOW_MONEY_RETRY_QUEUE_LIMIT) continue;
    next.set(discovered.balanceHistoryId, {
      ...discovered,
      attemptCount: 0,
      firstObservedAt: input.observedAt,
      lastAttemptAt: null,
      nextAttemptAt: Math.min(2_147_483_646_000, input.observedAt + EXACT_MONEY_RETRY_BASE_DELAY_MS),
    });
  }
  return [...next.values()].sort((left, right) => left.nextAttemptAt - right.nextAttemptAt
    || left.changeBalanceTimestamp - right.changeBalanceTimestamp
    || (BigInt(left.balanceHistoryId) < BigInt(right.balanceHistoryId) ? -1 : 1));
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, candidate: unknown) => typeof candidate === "bigint" ? candidate.toString() : candidate);
}

function decimalFromScaledInteger(value: bigint, digits: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  if (digits === 0) return `${negative ? "-" : ""}${absolute}`;
  const padded = absolute.toString().padStart(digits + 1, "0");
  const whole = padded.slice(0, -digits);
  const fraction = padded.slice(-digits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

function executionMoney(deal: CTraderDeal): {
  pnl: string | null;
  commission: string | null;
  swap: string | null;
  moneyDigits: number | null;
} {
  const close = deal.closePositionDetail;
  // Message-local scale authority is strict. Close money is exact only with
  // ProtoOAClosePositionDetail.moneyDigits. ProtoOADeal.moneyDigits may scale
  // only ProtoOADeal.commission; ProtoOATrader.moneyDigits is deliberately not
  // a fallback for either message.
  const closeDigits = close?.moneyDigits ?? null;
  const dealCommissionDigits = deal.moneyDigits;
  const exactCloseMoney = close !== null && closeDigits !== null;
  const commission = exactCloseMoney ? close.commission : deal.commission;
  const commissionDigits = exactCloseMoney ? closeDigits : dealCommissionDigits;
  return {
    pnl: !exactCloseMoney
      ? null
      : decimalFromScaledInteger(close.grossProfit + close.swap + close.commission - close.pnlConversionFee, closeDigits),
    commission: commission === null || commission === undefined || commissionDigits === null
      ? null
      : decimalFromScaledInteger(commission, commissionDigits),
    swap: !exactCloseMoney ? null : decimalFromScaledInteger(close.swap, closeDigits),
    moneyDigits: exactCloseMoney ? closeDigits : commissionDigits,
  };
}

function timestampCompare(left: CTraderDeal, right: CTraderDeal): number {
  if (left.executionTimestamp !== right.executionTimestamp) return left.executionTimestamp - right.executionTimestamp;
  const leftId = BigInt(left.dealId);
  const rightId = BigInt(right.dealId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function optionalDealIdentity<T>(
  dealId: string,
  label: string,
  existing: T | null,
  incoming: T | null,
): T | null {
  if (existing !== null && incoming !== null && String(existing) !== String(incoming)) {
    throw new CTraderSyncError(
      "CTRADER_OFFICIAL_DEAL_CONFLICT",
      `cTrader changed ${label} for immutable deal ${dealId}`,
      false,
    );
  }
  return incoming ?? existing;
}

function officialMoneyDigits(deal: CTraderDeal): number | null {
  return deal.closePositionDetail?.moneyDigits ?? null;
}

function sameScaledMoney(
  left: { value: bigint; digits: number },
  right: { value: bigint; digits: number },
): boolean {
  const digits = Math.max(left.digits, right.digits);
  return left.value * (10n ** BigInt(digits - left.digits))
    === right.value * (10n ** BigInt(digits - right.digits));
}

function storedExecutionInvalid(executionId: string, detail: string): CTraderSyncError {
  return new CTraderSyncError(
    "CTRADER_STORED_EXECUTION_INVALID",
    `Stored cTrader execution ${executionId} ${detail}`,
    false,
  );
}

function canonicalText(
  canonical: Record<string, unknown>,
  field: string,
  executionId: string,
  required = true,
): string | null {
  const value = canonical[field];
  if (value === null || value === undefined || value === "") {
    if (!required) return null;
    throw storedExecutionInvalid(executionId, `has no canonical ${field}`);
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw storedExecutionInvalid(executionId, `has an invalid canonical ${field}`);
  }
  return String(value);
}

function canonicalInteger(value: unknown, executionId: string, field: string): bigint {
  if ((typeof value !== "string" && typeof value !== "number")
    || !/^-?\d+$/.test(String(value))) {
    throw storedExecutionInvalid(executionId, `has an invalid canonical ${field}`);
  }
  try {
    return BigInt(String(value));
  } catch {
    throw storedExecutionInvalid(executionId, `has an invalid canonical ${field}`);
  }
}

function canonicalSafeNumber(value: unknown, executionId: string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw storedExecutionInvalid(executionId, `has an invalid canonical ${field}`);
  }
  return parsed;
}

function storedMcpMoney(canonical: Record<string, unknown>, executionId: string): StoredMcpMoney {
  const detailValue = canonical.closePositionDetail;
  if (detailValue !== null && detailValue !== undefined) {
    const detail = objectValue(detailValue);
    if (Object.keys(detail).length === 0) {
      throw storedExecutionInvalid(executionId, "has an invalid canonical closePositionDetail");
    }
    const digits = canonicalSafeNumber(detail.moneyDigits, executionId, "moneyDigits");
    if (!Number.isSafeInteger(digits) || digits < 0 || digits > 18) {
      throw storedExecutionInvalid(executionId, "has an invalid canonical moneyDigits");
    }
    const components = {
      grossProfit: canonicalInteger(detail.grossProfit, executionId, "grossProfit"),
      commission: canonicalInteger(detail.commission, executionId, "commission"),
      swap: canonicalInteger(detail.swap, executionId, "swap"),
      pnlConversionFee: canonicalInteger(detail.pnlConversionFee, executionId, "pnlConversionFee"),
      digits,
    };
    return {
      rank: 2,
      net: {
        value: components.grossProfit + components.swap + components.commission - components.pnlConversionFee,
        digits,
      },
      components,
    };
  }
  if (canonical.netPnlCents !== null && canonical.netPnlCents !== undefined) {
    const net = canonicalInteger(canonical.netPnlCents, executionId, "netPnlCents");
    if (net < BigInt(Number.MIN_SAFE_INTEGER) || net > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw storedExecutionInvalid(executionId, "has an out-of-range canonical netPnlCents");
    }
    return { rank: 1, net: { value: net, digits: 2 }, components: null };
  }
  return { rank: 0, net: null, components: null };
}

/**
 * Safely upgrades an execution stored by the Remote MCP reader to the official
 * Open API representation. The MCP envelope is accepted only after its
 * immutable execution identity is validated. Exact MCP money can be replaced
 * only by agreeing official close money. A weaker official observation remains
 * provider-unavailable and enters the official retry queue; it is never
 * promoted with a deal/trader exponent.
 */
export function mergeStoredExecutionWithOfficial(
  storedExecutionId: string,
  storedRaw: unknown,
  incoming: CTraderDeal,
  expectedAccountId?: string,
  accountMoneyDigits: number | null = null,
): CTraderDeal {
  void accountMoneyDigits;
  if (storedExecutionId !== incoming.dealId) {
    throw storedExecutionInvalid(storedExecutionId, "does not match the fetched official deal identity");
  }
  const envelope = objectValue(storedRaw);
  if (!Object.prototype.hasOwnProperty.call(envelope, "edgebookMcpDeal")) {
    try {
      const parsed = parseDeals({ deal: [storedRaw], hasMore: false }).deals[0];
      if (!parsed || parsed.dealId !== storedExecutionId) {
        throw storedExecutionInvalid(storedExecutionId, "cannot be parsed safely");
      }
      return mergeOfficialDealFacts(parsed, incoming);
    } catch (error) {
      if (error instanceof CTraderSyncError) throw error;
      throw storedExecutionInvalid(storedExecutionId, "cannot be parsed safely");
    }
  }

  const canonical = objectValue(envelope.edgebookMcpDeal);
  if (Object.keys(canonical).length === 0 || canonical.version !== 1) {
    throw storedExecutionInvalid(storedExecutionId, "has an invalid canonical MCP envelope");
  }
  const validVolumeProvenance = new Set([
    "filledVolumeCents:unit_cents",
    "filledVolume:unit_cents",
    "filled_volume:unknown",
    "volume:unknown",
    "quantity:unknown",
    "null:unknown",
  ]);
  if (!validVolumeProvenance.has(`${String(canonical.filledVolumeSourceKey)}:${String(canonical.filledVolumeScale)}`)) {
    throw storedExecutionInvalid(storedExecutionId, "has invalid canonical filled-volume provenance");
  }
  if (!["OPEN", "CLOSE", null].includes(canonical.role as "OPEN" | "CLOSE" | null)) {
    throw storedExecutionInvalid(storedExecutionId, "has an invalid canonical execution role");
  }
  const identity: Array<[string, unknown]> = [
    ["dealId", incoming.dealId],
    ["positionId", incoming.positionId],
    ["symbolId", incoming.symbolId],
    ["side", incoming.tradeSide],
    ["filledVolumeCents", incoming.filledVolumeCents],
    ["executionTimestamp", incoming.executionTimestamp],
  ];
  for (const [field, officialValue] of identity) {
    if (canonicalText(canonical, field, storedExecutionId) !== String(officialValue)) {
      throw storedExecutionInvalid(storedExecutionId, `conflicts with official ${field}`);
    }
  }
  const canonicalPrice = canonicalSafeNumber(canonical.executionPrice, storedExecutionId, "executionPrice");
  if (canonicalPrice !== incoming.executionPrice) {
    throw storedExecutionInvalid(storedExecutionId, "conflicts with official executionPrice");
  }
  const canonicalOrderId = canonicalText(canonical, "orderId", storedExecutionId, false);
  if (canonicalOrderId !== null && incoming.orderId !== null && canonicalOrderId !== incoming.orderId) {
    throw storedExecutionInvalid(storedExecutionId, "conflicts with official orderId");
  }
  const canonicalAccountId = canonicalText(canonical, "accountId", storedExecutionId, false);
  if (canonicalAccountId !== null && expectedAccountId !== undefined && canonicalAccountId !== expectedAccountId) {
    throw storedExecutionInvalid(storedExecutionId, "belongs to a different cTrader account");
  }

  const storedMoney = storedMcpMoney(canonical, storedExecutionId);
  if (storedMoney.rank === 0) return incoming;
  const digits = officialMoneyDigits(incoming);
  const close = incoming.closePositionDetail;
  if (close === null || digits === null) {
    return incoming;
  }
  const officialNet = {
    value: close.grossProfit + close.swap + close.commission - close.pnlConversionFee,
    digits,
  };
  if (storedMoney.net === null || !sameScaledMoney(storedMoney.net, officialNet)) {
    throw new CTraderSyncError(
      "CTRADER_OFFICIAL_DEAL_CONFLICT",
      `Official cTrader history conflicts with stored MCP realized P&L for deal ${incoming.dealId}`,
      false,
    );
  }
  if (storedMoney.components) {
    for (const field of ["grossProfit", "commission", "swap", "pnlConversionFee"] as const) {
      if (!sameScaledMoney(
        { value: storedMoney.components[field], digits: storedMoney.components.digits },
        { value: close[field], digits },
      )) {
        throw new CTraderSyncError(
          "CTRADER_OFFICIAL_DEAL_CONFLICT",
          `Official cTrader history conflicts with stored MCP ${field} for deal ${incoming.dealId}`,
          false,
        );
      }
    }
  }
  return incoming;
}

/**
 * Joins two observations of one immutable official deal. A later response that
 * omits closePositionDetail cannot erase exact realized money; overlapping
 * exact observations must agree after scaling or the sync fails closed.
 */
export function mergeOfficialDealFacts(
  existing: CTraderDeal,
  incoming: CTraderDeal,
  accountMoneyDigits: number | null = null,
): CTraderDeal {
  void accountMoneyDigits;
  if (existing.dealId !== incoming.dealId) {
    throw new CTraderSyncError("CTRADER_OFFICIAL_DEAL_CONFLICT", "cTrader mixed official execution identities", false);
  }
  const stable = ["positionId", "symbolId", "filledVolumeCents", "executionTimestamp", "executionPrice", "tradeSide"] as const;
  if (stable.some((key) => String(existing[key]) !== String(incoming[key]))) {
    throw new CTraderSyncError(
      "CTRADER_OFFICIAL_DEAL_CONFLICT",
      `cTrader changed stable execution data for immutable deal ${incoming.dealId}`,
      false,
    );
  }
  if (existing.closePositionDetail && incoming.closePositionDetail) {
    const existingDigits = officialMoneyDigits(existing);
    const incomingDigits = officialMoneyDigits(incoming);
    for (const field of ["grossProfit", "swap", "commission", "balance", "pnlConversionFee"] as const) {
      const agrees = existingDigits !== null && incomingDigits !== null
        ? sameScaledMoney(
            { value: existing.closePositionDetail[field], digits: existingDigits },
            { value: incoming.closePositionDetail[field], digits: incomingDigits },
          )
        // Without both message-local exponents the values cannot be compared
        // after scaling. Equal lossless raw units are the only safe join.
        : existing.closePositionDetail[field] === incoming.closePositionDetail[field];
      if (!agrees) {
        throw new CTraderSyncError(
          "CTRADER_OFFICIAL_DEAL_CONFLICT",
          `cTrader changed ${field} for immutable deal ${incoming.dealId}`,
          false,
        );
      }
    }
    if (existing.closePositionDetail.entryPrice !== incoming.closePositionDetail.entryPrice
      || String(existing.closePositionDetail.closedVolumeCents)
        !== String(incoming.closePositionDetail.closedVolumeCents)) {
      throw new CTraderSyncError(
        "CTRADER_OFFICIAL_DEAL_CONFLICT",
        `cTrader changed closing execution data for immutable deal ${incoming.dealId}`,
        false,
      );
    }
  }
  const close = existing.closePositionDetail !== null
    && existing.closePositionDetail.moneyDigits !== null
    && incoming.closePositionDetail?.moneyDigits === null
      ? existing.closePositionDetail
      : incoming.closePositionDetail ?? existing.closePositionDetail;
  // These two fields belong to ProtoOADeal. Never let a close-detail exponent
  // influence their immutable identity or vice versa.
  const moneyDigits = optionalDealIdentity(incoming.dealId, "deal moneyDigits", existing.moneyDigits, incoming.moneyDigits);
  const dealCommission = optionalDealIdentity(incoming.dealId, "deal commission", existing.commission, incoming.commission);
  return {
    ...existing,
    ...incoming,
    orderId: optionalDealIdentity(incoming.dealId, "order identity", existing.orderId, incoming.orderId),
    providerUpdatedTimestamp: existing.providerUpdatedTimestamp === null
      ? incoming.providerUpdatedTimestamp
      : incoming.providerUpdatedTimestamp === null
        ? existing.providerUpdatedTimestamp
        : Math.max(existing.providerUpdatedTimestamp, incoming.providerUpdatedTimestamp),
    moneyDigits,
    commission: dealCommission,
    closePositionDetail: close,
    // Persist a canonical provider envelope containing retained exact fields so
    // every subsequent projection re-parses the same authoritative facts.
    raw: {
      ...existing.raw,
      ...incoming.raw,
      orderId: optionalDealIdentity(incoming.dealId, "order identity", existing.orderId, incoming.orderId) ?? undefined,
      moneyDigits: moneyDigits ?? undefined,
      commission: dealCommission?.toString(),
      closePositionDetail: close?.raw,
    },
  };
}

/**
 * Spotware exposes a hasMore flag but no lossless cursor. Splitting saturated
 * time windows is safer than advancing to the last returned timestamp, which
 * can silently skip deals that share that millisecond. The single-millisecond
 * saturation error is explicit rather than pretending the import is complete.
 */
export async function fetchCompleteDealHistory(
  session: Pick<CTraderAccountSession, "listDeals">,
  fromTimestamp: number,
  toTimestamp: number,
  maxRows: number,
  heartbeat: () => Promise<void> = async () => undefined,
  accountMoneyDigits: number | null = null,
  requestLimit = 100_000,
): Promise<CTraderDeal[]> {
  if (!Number.isSafeInteger(fromTimestamp) || !Number.isSafeInteger(toTimestamp) || fromTimestamp < 0 || toTimestamp < fromTimestamp) {
    throw new CTraderSyncError("HISTORY_RANGE_INVALID", "The cTrader history range is invalid", false);
  }
  if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 100_000) {
    throw new CTraderSyncError("HISTORY_REQUEST_LIMIT_INVALID", "The cTrader history request limit is invalid", false);
  }
  // Some cTrader backends reject overly wide historical boundaries. Seed the
  // request with bounded seven-day windows, then bisect only windows that are
  // saturated by row count. This is deterministic for accounts of any age.
  const maximumWindowMs = 7 * 24 * 60 * 60 * 1_000;
  const chronologicalWindows: Array<{ from: number; to: number }> = [];
  for (let from = fromTimestamp; from <= toTimestamp;) {
    const to = Math.min(toTimestamp, from + maximumWindowMs - 1);
    chronologicalWindows.push({ from, to });
    if (to === toTimestamp) break;
    from = to + 1;
  }
  const windows = chronologicalWindows.reverse();
  const deals = new Map<string, CTraderDeal>();
  let requests = 0;
  while (windows.length > 0) {
    const window = windows.pop();
    if (!window) break;
    requests += 1;
    if (requests > requestLimit) {
      throw new CTraderSyncError("HISTORY_PAGINATION_LIMIT", "cTrader history required too many pages", false);
    }
    await heartbeat();
    const page = await session.listDeals(window.from, window.to, maxRows);
    for (const deal of page.deals) {
      if (deal.executionTimestamp < window.from || deal.executionTimestamp > window.to) {
        throw new CTraderSyncError("HISTORY_OUT_OF_RANGE", "cTrader returned a deal outside the requested history window", false);
      }
      const previous = deals.get(deal.dealId);
      if (previous && json(previous.raw) !== json(deal.raw)) {
        // The most recent payload supplies optional metadata, but immutable
        // exact-money observations are joined at their authoritative scale.
        // Each message retains only its own authoritative moneyDigits.
        const previousUpdate = previous.providerUpdatedTimestamp ?? previous.executionTimestamp;
        const nextUpdate = deal.providerUpdatedTimestamp ?? deal.executionTimestamp;
        deals.set(
          deal.dealId,
          nextUpdate >= previousUpdate
            ? mergeOfficialDealFacts(previous, deal, accountMoneyDigits)
            : mergeOfficialDealFacts(deal, previous, accountMoneyDigits),
        );
      } else if (!previous) {
        deals.set(deal.dealId, deal);
      }
    }
    if (!page.hasMore) continue;
    if (window.from === window.to) {
      throw new CTraderSyncError(
        "HISTORY_PAGE_SATURATED",
        `More than ${maxRows} cTrader deals share timestamp ${window.from}; history cannot be proven complete`,
        false,
      );
    }
    const midpoint = window.from + Math.floor((window.to - window.from) / 2);
    // Stack order keeps processing chronological ranges first.
    windows.push({ from: midpoint + 1, to: window.to });
    windows.push({ from: window.from, to: midpoint });
  }
  return [...deals.values()].sort(timestampCompare);
}

function mergeOfficialDealCollections(
  current: readonly CTraderDeal[],
  incoming: readonly CTraderDeal[],
  accountMoneyDigits: number | null,
): CTraderDeal[] {
  const merged = new Map(current.map((deal) => [deal.dealId, deal]));
  for (const deal of incoming) {
    const existing = merged.get(deal.dealId);
    merged.set(
      deal.dealId,
      existing === undefined ? deal : mergeOfficialDealFacts(existing, deal, accountMoneyDigits),
    );
  }
  return [...merged.values()].sort(timestampCompare);
}

function cashFlowTimestampCompare(left: CTraderCashFlow, right: CTraderCashFlow): number {
  if (left.changeBalanceTimestamp !== right.changeBalanceTimestamp) {
    return left.changeBalanceTimestamp - right.changeBalanceTimestamp;
  }
  const leftId = BigInt(left.balanceHistoryId);
  const rightId = BigInt(right.balanceHistoryId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

export function mergeCashFlowObservations(
  existing: CTraderCashFlow,
  incoming: CTraderCashFlow,
): CTraderCashFlow {
  const conflict = (field: string): never => {
    throw new CTraderSyncError(
      "CASH_FLOW_ID_CONFLICT",
      `cTrader changed ${field} for immutable cash-flow ${incoming.balanceHistoryId}`,
      false,
    );
  };
  if (existing.balanceHistoryId !== incoming.balanceHistoryId) conflict("identity");
  if (existing.operationName !== incoming.operationName) conflict("operation name");
  if (existing.operationType !== null && incoming.operationType !== null
    && existing.operationType !== incoming.operationType) conflict("operation type");
  if (existing.balance !== incoming.balance) conflict("raw balance");
  if (existing.delta !== incoming.delta) conflict("raw delta");
  if (existing.changeBalanceTimestamp !== incoming.changeBalanceTimestamp) conflict("timestamp");
  if (existing.balanceVersion !== null && incoming.balanceVersion !== null
    && existing.balanceVersion !== incoming.balanceVersion) conflict("balance version");
  if (existing.equity !== null && incoming.equity !== null && existing.equity !== incoming.equity) conflict("raw equity");
  if (existing.moneyDigits !== null && incoming.moneyDigits !== null
    && existing.moneyDigits !== incoming.moneyDigits) conflict("moneyDigits");
  return {
    ...existing,
    ...incoming,
    operationType: incoming.operationType ?? existing.operationType,
    balanceVersion: incoming.balanceVersion ?? existing.balanceVersion,
    equity: incoming.equity ?? existing.equity,
    moneyDigits: incoming.moneyDigits ?? existing.moneyDigits,
  };
}

/** Joins immutable cash-flow observations and preserves optional enrichment. */
export function mergeStoredCashFlowFacts(
  stored: Pick<StoredCashFlowRow,
    "external_cash_flow_id" | "operation_type" | "operation_name" | "raw_delta" | "raw_balance"
    | "raw_equity" | "balance_version" | "occurred_at">,
  incoming: CTraderCashFlow,
): CTraderCashFlow {
  const conflict = (field: string): never => {
    throw new CTraderSyncError(
      "CASH_FLOW_ID_CONFLICT",
      `cTrader changed ${field} for immutable cash-flow ${incoming.balanceHistoryId}`,
      false,
    );
  };
  let storedDelta: bigint;
  let storedBalance: bigint;
  let storedEquity: bigint | null;
  let storedBalanceVersion: bigint | null;
  try {
    storedDelta = BigInt(stored.raw_delta);
    storedBalance = BigInt(stored.raw_balance);
    storedEquity = stored.raw_equity === null ? null : BigInt(stored.raw_equity);
    storedBalanceVersion = stored.balance_version === null ? null : BigInt(stored.balance_version);
  } catch {
    return conflict("stored monetary facts");
  }
  const occurredAt = new Date(stored.occurred_at).getTime();
  if (stored.external_cash_flow_id !== incoming.balanceHistoryId) conflict("identity");
  if (stored.operation_name !== incoming.operationName) conflict("operation name");
  if (stored.operation_type !== null && incoming.operationType !== null
    && stored.operation_type !== incoming.operationType) conflict("operation type");
  if (storedDelta !== incoming.delta) conflict("raw delta");
  if (storedBalance !== incoming.balance) conflict("raw balance");
  if (!Number.isFinite(occurredAt) || occurredAt !== incoming.changeBalanceTimestamp) conflict("timestamp");
  if (storedEquity !== null && incoming.equity !== null && storedEquity !== incoming.equity) conflict("equity");
  if (storedBalanceVersion !== null && incoming.balanceVersion !== null
    && storedBalanceVersion !== incoming.balanceVersion) conflict("balance version");
  return {
    ...incoming,
    operationType: incoming.operationType ?? stored.operation_type,
    equity: incoming.equity ?? storedEquity,
    balanceVersion: incoming.balanceVersion ?? storedBalanceVersion,
  };
}

type CashFlowMoneyDigitsSource = "cash_flow" | "account" | "unavailable";

export function resolveCashFlowMoneyScale(input: {
  cashFlowMoneyDigits: number | null;
  accountMoneyDigits: number | null;
  stored?: { moneyDigits: number | null; source: CashFlowMoneyDigitsSource } | null;
}): { moneyDigits: number | null; source: "cash_flow" | "unavailable" } {
  // ProtoOADepositWithdraw.moneyDigits is message-local. The trader/account
  // exponent is not authority for row balance, delta, or equity.
  void input.accountMoneyDigits;
  if (input.cashFlowMoneyDigits !== null) {
    if (input.stored?.source === "cash_flow"
      && input.stored.moneyDigits !== input.cashFlowMoneyDigits) {
      throw new CTraderSyncError(
        "CASH_FLOW_MONEY_DIGITS_CONFLICT",
        "cTrader changed moneyDigits for an immutable account cash-flow identity",
        false,
      );
    }
    return { moneyDigits: input.cashFlowMoneyDigits, source: "cash_flow" };
  }
  // Preserve a previously observed row exponent if an overlapping response
  // later omits that optional field.
  if (input.stored?.source === "cash_flow" && input.stored.moneyDigits !== null) {
    return { moneyDigits: input.stored.moneyDigits, source: "cash_flow" };
  }
  return { moneyDigits: null, source: "unavailable" };
}

/**
 * Spotware limits ProtoOACashFlowHistoryListReq to a seven-day boundary and
 * exposes no pagination flag. Fetch every non-overlapping window and retain
 * the immutable balanceHistoryId as the account-ledger identity.
 */
export async function fetchCompleteCashFlowHistory(
  session: Pick<CTraderAccountSession, "listCashFlows">,
  fromTimestamp: number,
  toTimestamp: number,
  heartbeat: () => Promise<void> = async () => undefined,
): Promise<CTraderCashFlow[]> {
  if (!Number.isSafeInteger(fromTimestamp) || !Number.isSafeInteger(toTimestamp) || fromTimestamp < 0 || toTimestamp < fromTimestamp) {
    throw new CTraderSyncError("CASH_FLOW_RANGE_INVALID", "The cTrader cash-flow history range is invalid", false);
  }
  const maximumWindowMs = 7 * 24 * 60 * 60 * 1_000;
  const cashFlows = new Map<string, CTraderCashFlow>();
  let requests = 0;
  for (let from = fromTimestamp; from <= toTimestamp;) {
    // Use an inclusive range whose cardinality is at most seven days. This is
    // one millisecond stricter than merely satisfying `to - from <= 7d` and
    // avoids gateways interpreting both endpoints as a 7d + 1ms window.
    const to = Math.min(toTimestamp, from + maximumWindowMs - 1);
    requests += 1;
    if (requests > 100_000) {
      throw new CTraderSyncError("CASH_FLOW_PAGINATION_LIMIT", "cTrader cash-flow history required too many windows", false);
    }
    await heartbeat();
    const page = await session.listCashFlows(from, to);
    for (const cashFlow of page) {
      if (cashFlow.changeBalanceTimestamp < from || cashFlow.changeBalanceTimestamp > to) {
        throw new CTraderSyncError(
          "CASH_FLOW_OUT_OF_RANGE",
          "cTrader returned an account cash-flow outside the requested history window",
          false,
        );
      }
      const prior = cashFlows.get(cashFlow.balanceHistoryId);
      cashFlows.set(
        cashFlow.balanceHistoryId,
        prior === undefined ? cashFlow : mergeCashFlowObservations(prior, cashFlow),
      );
    }
    if (to === toTimestamp) break;
    // Boundaries are inclusive, so the next window begins one millisecond
    // later. The immutable ID still protects against provider overlap.
    from = to + 1;
  }
  return [...cashFlows.values()].sort(cashFlowTimestampCompare);
}

function mergeCashFlowCollections(
  current: readonly CTraderCashFlow[],
  incoming: readonly CTraderCashFlow[],
): CTraderCashFlow[] {
  const merged = new Map(current.map((cashFlow) => [cashFlow.balanceHistoryId, cashFlow]));
  for (const cashFlow of incoming) {
    const existing = merged.get(cashFlow.balanceHistoryId);
    merged.set(
      cashFlow.balanceHistoryId,
      existing === undefined ? cashFlow : mergeCashFlowObservations(existing, cashFlow),
    );
  }
  return [...merged.values()].sort(cashFlowTimestampCompare);
}

function isAuthFailure(error: unknown): boolean {
  if (!(error instanceof CTraderApiError)) return false;
  return /AUTH|TOKEN|ACCESS|INVALIDATED/i.test(error.code);
}

function normalizeSyncError(error: unknown): CTraderSyncError {
  if (error instanceof CTraderSyncError) return error;
  if (error instanceof CTraderOAuthError) {
    const transient = error.code === "TOKEN_ENDPOINT_UNAVAILABLE" || error.code === "TOKEN_RESPONSE_INVALID";
    return new CTraderSyncError(error.code, error.message, transient, !transient);
  }
  if (error instanceof CTraderApiError) {
    const reauth = isAuthFailure(error);
    const retryable = !reauth && (
      error.code === "CONNECTION_CLOSED"
      || error.code === "CONNECTION_ERROR"
      || error.code === "CONNECTION_TIMEOUT"
      || error.code === "REQUEST_TIMEOUT"
      || error.code === "SEND_FAILED"
      || error.retryAfterSeconds !== null
    );
    return new CTraderSyncError(error.code, error.message, retryable, reauth);
  }
  return new CTraderSyncError(
    "CTRADER_SYNC_FAILED",
    error instanceof Error ? error.message : "The cTrader sync failed",
    false,
  );
}

export class CTraderSyncEngine {
  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly oauth: CTraderOAuthClient,
    private readonly gateway: CTraderGateway,
    private readonly cipher: TokenCipher,
    private readonly events: EventBus,
  ) {}

  async syncConnection(
    connectionId: string,
    heartbeat: () => Promise<void> = async () => undefined,
  ): Promise<CTraderSyncResult> {
    const connection = await this.loadConnection(connectionId);
    let accessToken = await this.validAccessToken(connection, false);
    let result: CTraderSyncResult;
    try {
      result = await this.performSync(connection, accessToken, heartbeat);
    } catch (error) {
      if (!isAuthFailure(error)) throw normalizeSyncError(error);
      // A server-side expiry/revocation can precede the stored expiry. Rotate
      // once through the refresh grant, then fail closed if authorization is
      // still rejected.
      accessToken = await this.validAccessToken(connection, true);
      try {
        result = await this.performSync(connection, accessToken, heartbeat);
      } catch (retryError) {
        throw normalizeSyncError(retryError);
      }
    }
    await this.events.publish(connection.user_id, "ctrader.synced", {
      connectionId,
      counters: result.counters,
    }).catch(() => undefined);
    return result;
  }

  private async loadConnection(connectionId: string): Promise<SyncConnectionRow> {
    const result = await this.database.query<SyncConnectionRow>(
      `SELECT id, user_id, external_account_id, provider_environment, connected,
              access_token_ciphertext, refresh_token_ciphertext,
              encryption_key_version, token_expires_at, token_generation,
              sync_cursor, provider_metadata, mapped_account_id,
              legacy_mapped_account_id
       FROM broker_connections
       WHERE id=$1 AND provider='ctrader' AND connection_mode='official'
         AND oauth_scope='accounts'
         AND provider_environment IS NOT NULL
       LIMIT 1`,
      [connectionId],
    );
    const connection = result.rows[0];
    if (!connection) throw new CTraderSyncError("CONNECTION_NOT_FOUND", "The cTrader connection no longer exists", false);
    if (!connection.connected || !connection.access_token_ciphertext || !connection.refresh_token_ciphertext) {
      throw new CTraderSyncError("CTRADER_REAUTH_REQUIRED", "Reconnect cTrader before syncing", false, true);
    }
    return connection;
  }

  private async validAccessToken(connection: SyncConnectionRow, forceRefresh: boolean): Promise<string> {
    if (!connection.access_token_ciphertext || !connection.refresh_token_ciphertext || connection.token_expires_at === null) {
      throw new CTraderSyncError("CTRADER_REAUTH_REQUIRED", "The cTrader connection has no usable token", false, true);
    }
    const expiresAt = new Date(connection.token_expires_at).getTime();
    const refreshAt = Date.now() + this.config.cTrader.refreshSkewSeconds * 1_000;
    if (!forceRefresh && Number.isFinite(expiresAt) && expiresAt > refreshAt) {
      return this.cipher.decrypt(connection.access_token_ciphertext, connectionTokenAad(connection.id, "access"));
    }

    const generation = BigInt(connection.token_generation);
    const refreshToken = this.cipher.decrypt(
      connection.refresh_token_ciphertext,
      connectionTokenAad(connection.id, "refresh"),
    );
    let tokenSet;
    try {
      tokenSet = await this.oauth.refresh(refreshToken);
    } catch (error) {
      throw normalizeSyncError(error);
    }
    const nextExpiry = new Date(Date.now() + tokenSet.expiresIn * 1_000);
    const nextAccessCiphertext = this.cipher.encrypt(
      tokenSet.accessToken,
      connectionTokenAad(connection.id, "access"),
    );
    const nextRefreshCiphertext = this.cipher.encrypt(
      tokenSet.refreshToken,
      connectionTokenAad(connection.id, "refresh"),
    );
    const update = await withTransaction(this.database, async (client) => client.query<{ token_generation: string }>(
      `UPDATE broker_connections SET
         access_token_ciphertext=$1,
         refresh_token_ciphertext=$2,
         encryption_key_version=$3,
         token_expires_at=$4,
         token_generation=token_generation+1,
         token_refreshed_at=now()
       WHERE id=$5 AND provider='ctrader' AND connection_mode='official'
         AND connected=true
         AND token_generation=$6
       RETURNING token_generation`,
      [
        nextAccessCiphertext,
        nextRefreshCiphertext,
        this.cipher.activeKeyVersion,
        nextExpiry,
        connection.id,
        generation.toString(),
      ],
    ));
    if (update.rows[0]) {
      connection.access_token_ciphertext = nextAccessCiphertext;
      connection.refresh_token_ciphertext = nextRefreshCiphertext;
      connection.token_generation = update.rows[0].token_generation;
      connection.token_expires_at = nextExpiry;
      return tokenSet.accessToken;
    }

    // Another holder won the compare-and-swap. Never retry the now-rotated old
    // refresh token; load and use the winning generation instead.
    const winner = await this.loadConnection(connection.id);
    Object.assign(connection, winner);
    if (!winner.access_token_ciphertext) {
      throw new CTraderSyncError("CTRADER_REAUTH_REQUIRED", "The cTrader token was revoked during refresh", false, true);
    }
    return this.cipher.decrypt(winner.access_token_ciphertext, connectionTokenAad(winner.id, "access"));
  }

  private async performSync(
    connection: SyncConnectionRow,
    accessToken: string,
    heartbeat: () => Promise<void>,
  ): Promise<CTraderSyncResult> {
    const session = await this.gateway.openAccount(
      connection.provider_environment,
      connection.external_account_id,
      accessToken,
    );
    try {
      await heartbeat();
      const trader = await session.getTraderMetadata();
      // Capture this immediately after the broker response. Later symbol and
      // history calls can take minutes on a large account, so the end-of-sync
      // cursor is not a truthful observation time for the balance snapshot.
      const traderObservedAt = Date.now();
      if (trader.registrationTimestamp === null) {
        throw new CTraderSyncError(
          "REGISTRATION_TIMESTAMP_MISSING",
          "cTrader did not provide the account registration timestamp required to prove a complete history import",
          false,
        );
      }
      const assets = await session.listAssets();
      const assetClasses = await session.listAssetClasses();
      const categories = await session.listSymbolCategories();
      const lightSymbols = await session.listSymbols();
      const cursorBefore = objectValue(connection.sync_cursor);
      const exactMoneyRetriesBefore = parseExactMoneyRetryQueue(cursorBefore);
      const cashFlowMoneyRetriesBefore = parseCashFlowMoneyRetryQueue(cursorBefore);
      const fullHistoryComplete = cursorBefore.fullHistoryComplete === true;
      const syncedThrough = safeTimestamp(cursorBefore.syncedThroughTimestamp);
      const configuredEarlierBound = this.config.cTrader.historyStartTimestamp;
      const authoritativeStart = configuredEarlierBound === null
        ? trader.registrationTimestamp
        : Math.min(trader.registrationTimestamp, configuredEarlierBound);
      const fromTimestamp = fullHistoryComplete && syncedThrough !== null
        ? Math.max(authoritativeStart, syncedThrough - this.config.cTrader.syncOverlapSeconds * 1_000)
        : authoritativeStart;
      const toTimestamp = Date.now();
      if (authoritativeStart > toTimestamp) {
        throw new CTraderSyncError("REGISTRATION_TIMESTAMP_INVALID", "The cTrader registration timestamp is in the future", false);
      }
      if (exactMoneyRetriesBefore.some((entry) =>
        entry.executionTimestamp < authoritativeStart || entry.executionTimestamp > toTimestamp)) {
        throw retryCursorError("contains an execution outside the authoritative account-history boundary");
      }
      let fetchedDeals = await fetchCompleteDealHistory(
        session,
        fromTimestamp,
        toTimestamp,
        this.config.cTrader.maxDealsPerRequest,
        heartbeat,
        trader.moneyDigits,
      );
      const dueExactMoneyRetries = fullHistoryComplete
        ? selectDueExactMoneyRetries(exactMoneyRetriesBefore, toTimestamp)
        : [];
      for (const retry of dueExactMoneyRetries) {
        const retryDeals = await fetchCompleteDealHistory(
          session,
          Math.max(authoritativeStart, retry.executionTimestamp - EXACT_MONEY_RETRY_WINDOW_RADIUS_MS),
          Math.min(toTimestamp, retry.executionTimestamp + EXACT_MONEY_RETRY_WINDOW_RADIUS_MS),
          this.config.cTrader.maxDealsPerRequest,
          heartbeat,
          trader.moneyDigits,
          EXACT_MONEY_RETRY_HISTORY_REQUEST_LIMIT,
        );
        fetchedDeals = mergeOfficialDealCollections(fetchedDeals, retryDeals, trader.moneyDigits);
      }
      const cashFlowHistoryComplete = cursorBefore.cashFlowHistoryComplete === true;
      const cashFlowSyncedThrough = safeTimestamp(cursorBefore.cashFlowSyncedThroughTimestamp);
      // Spotware explicitly defines registrationTimestamp as the minimum
      // boundary for historical requests. The optional deal override may ask
      // for older executions, but it must not make cash-flow boundaries
      // invalid.
      const cashFlowAuthoritativeStart = trader.registrationTimestamp;
      if (cashFlowMoneyRetriesBefore.some((entry) =>
        entry.changeBalanceTimestamp < cashFlowAuthoritativeStart
        || entry.changeBalanceTimestamp > toTimestamp)) {
        throw cashFlowRetryCursorError("contains a row outside the authoritative account-history boundary");
      }
      const cashFlowFromTimestamp = cashFlowHistoryComplete && cashFlowSyncedThrough !== null
        ? Math.max(cashFlowAuthoritativeStart, cashFlowSyncedThrough - this.config.cTrader.syncOverlapSeconds * 1_000)
        : cashFlowAuthoritativeStart;
      let fetchedCashFlows = await fetchCompleteCashFlowHistory(
        session,
        cashFlowFromTimestamp,
        toTimestamp,
        heartbeat,
      );
      const dueCashFlowMoneyRetries = cashFlowHistoryComplete
        ? selectDueCashFlowMoneyRetries(cashFlowMoneyRetriesBefore, toTimestamp)
        : [];
      for (const retry of dueCashFlowMoneyRetries) {
        const retryCashFlows = await fetchCompleteCashFlowHistory(
          session,
          retry.changeBalanceTimestamp,
          retry.changeBalanceTimestamp,
          heartbeat,
        );
        fetchedCashFlows = mergeCashFlowCollections(fetchedCashFlows, retryCashFlows);
      }

      const symbolIds = [...new Set(fetchedDeals.map((deal) => deal.symbolId))];
      const lightById = new Map(lightSymbols.map((symbol) => [symbol.symbolId, symbol]));
      for (const symbolId of symbolIds) {
        if (!lightById.has(symbolId)) {
          throw new CTraderSyncError(
            "SYMBOL_METADATA_MISSING",
            `cTrader did not return archived/current symbol metadata for symbol ${symbolId}`,
            false,
          );
        }
      }
      const symbolNames = new Map(lightSymbols.map((symbol) => [symbol.symbolId, symbol.symbolName]));
      const symbolSpecs = await session.getSymbolDetails(symbolIds, symbolNames);
      if (symbolSpecs.length !== symbolIds.length) {
        throw new CTraderSyncError("SYMBOL_SPEC_MISSING", "cTrader did not return every required symbol specification", false);
      }
      await heartbeat();
      return await this.persistSync({
        connection,
        trader,
        assets,
        assetClasses,
        categories,
        lightSymbols,
        symbolSpecs,
        fetchedDeals,
        fetchedCashFlows,
        cursorBefore,
        exactMoneyRetriesBefore,
        attemptedExactMoneyRetryIds: new Set(dueExactMoneyRetries.map((entry) => entry.executionId)),
        cashFlowMoneyRetriesBefore,
        attemptedCashFlowMoneyRetryIds: new Set(dueCashFlowMoneyRetries.map((entry) => entry.balanceHistoryId)),
        registrationTimestamp: trader.registrationTimestamp,
        syncedThroughTimestamp: toTimestamp,
        traderObservedAt,
      });
    } finally {
      await session.close();
    }
  }

  private async persistSync(input: {
    connection: SyncConnectionRow;
    trader: CTraderTraderMetadata;
    assets: CTraderAsset[];
    assetClasses: CTraderAssetClass[];
    categories: CTraderSymbolCategory[];
    lightSymbols: CTraderLightSymbol[];
    symbolSpecs: CTraderSymbolSpec[];
    fetchedDeals: CTraderDeal[];
    fetchedCashFlows: CTraderCashFlow[];
    cursorBefore: Record<string, unknown>;
    exactMoneyRetriesBefore: CTraderExactMoneyRetry[];
    attemptedExactMoneyRetryIds: ReadonlySet<string>;
    cashFlowMoneyRetriesBefore: CTraderCashFlowMoneyRetry[];
    attemptedCashFlowMoneyRetryIds: ReadonlySet<string>;
    registrationTimestamp: number;
    syncedThroughTimestamp: number;
    traderObservedAt: number;
  }): Promise<CTraderSyncResult> {
    const accountCurrency = this.accountCurrency(input.trader, input.assets);
    const result = await withTransaction(this.database, async (client) => {
      await lockAndValidateMappedAccountCurrency(client, {
        userId: input.connection.user_id,
        mappedAccountId: input.connection.mapped_account_id,
        legacyMappedAccountId: input.connection.legacy_mapped_account_id,
        providerCurrency: accountCurrency,
      });
      const locked = await client.query<{
        connected: boolean;
        mapped_account_id: string | null;
        legacy_mapped_account_id: string | null;
      }>(
        `SELECT connected, mapped_account_id, legacy_mapped_account_id
         FROM broker_connections
         WHERE id=$1 AND user_id=$2 AND provider='ctrader' AND connection_mode='official'
           AND oauth_scope='accounts'
           AND provider_environment IS NOT NULL FOR UPDATE`,
        [input.connection.id, input.connection.user_id],
      );
      if (!locked.rows[0]?.connected) {
        throw new CTraderSyncError("CTRADER_DISCONNECTED", "The cTrader connection was disconnected during sync", false);
      }
      if (!sameConnectionMapping(
        {
          mappedAccountId: input.connection.mapped_account_id,
          legacyMappedAccountId: input.connection.legacy_mapped_account_id,
        },
        {
          mappedAccountId: locked.rows[0].mapped_account_id,
          legacyMappedAccountId: locked.rows[0].legacy_mapped_account_id,
        },
      )) {
        throw new CTraderSyncError(
          "CTRADER_ACCOUNT_MAPPING_CHANGED",
          "The mapped Edgebook account changed during cTrader sync; retry with the current mapping",
          true,
        );
      }
      const counters: CTraderSyncCounters = {
        inserted: 0,
        updated: 0,
        fetchedDeals: input.fetchedDeals.length,
        insertedExecutions: 0,
        updatedExecutions: 0,
        insertedTrades: 0,
        updatedTrades: 0,
        unchangedTrades: 0,
        archivedTradesPreserved: 0,
        tombstonesPreserved: 0,
        positionsProjected: 0,
        positionsAwaitingReview: 0,
        fetchedAccountCashFlows: input.fetchedCashFlows.length,
        insertedAccountCashFlows: 0,
        updatedAccountCashFlows: 0,
        invalidatedAccountCashFlowFallbacks: 0,
        totalAccountCashFlows: 0,
        scaledAccountCashFlows: 0,
        unscaledAccountCashFlows: 0,
        attemptedCashFlowMoneyRetries: input.attemptedCashFlowMoneyRetryIds.size,
        completedCashFlowMoneyRetries: 0,
        pendingCashFlowMoneyRetries: 0,
        deauthorizedUnsupportedExactExecutions: 0,
        deauthorizedUnsupportedExactTrades: 0,
        sanitizedUnsupportedExactCandidates: 0,
        attemptedExactMoneyRetries: input.attemptedExactMoneyRetryIds.size,
        completedExactMoneyRetries: 0,
        pendingExactMoneyRetries: 0,
      };
      const dealIds = input.fetchedDeals.map((deal) => deal.dealId);
      const existingExecutions = dealIds.length === 0
        ? new Map<string, StoredOfficialExecutionRow>()
        : new Map((await client.query<StoredOfficialExecutionRow>(
             `SELECT external_execution_id, raw_payload FROM trade_executions
              WHERE broker_connection_id=$1 AND external_execution_id=ANY($2::text[])`,
             [input.connection.id, dealIds],
          )).rows.map((row) => [row.external_execution_id, row]));

      for (const fetchedDeal of input.fetchedDeals) {
        const storedExecution = existingExecutions.get(fetchedDeal.dealId);
        const deal = storedExecution
          ? mergeStoredExecutionWithOfficial(
              storedExecution.external_execution_id,
              storedExecution.raw_payload,
              fetchedDeal,
              input.connection.external_account_id,
              input.trader.moneyDigits,
            )
          : fetchedDeal;
        const money = executionMoney(deal);
        const closeVolume = deal.closePositionDetail?.closedVolumeCents ?? null;
        await client.query(
          `INSERT INTO trade_executions (
             id, user_id, broker_connection_id, external_execution_id,
             external_position_id, external_order_id, external_symbol_id,
             side, quantity, price, pnl, commission, swap, currency_code,
             executed_at, raw_payload, deal_status, filled_volume_cents,
             closed_volume_cents, money_digits, close_position_detail,
             provider_updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
             $17,$18,$19,$20,$21::jsonb,$22
           )
           ON CONFLICT (broker_connection_id, external_execution_id) DO UPDATE SET
             external_position_id=EXCLUDED.external_position_id,
             external_order_id=EXCLUDED.external_order_id,
             external_symbol_id=EXCLUDED.external_symbol_id,
             side=EXCLUDED.side,
             quantity=EXCLUDED.quantity,
             price=EXCLUDED.price,
             pnl=EXCLUDED.pnl,
             commission=EXCLUDED.commission,
             swap=EXCLUDED.swap,
             currency_code=EXCLUDED.currency_code,
             executed_at=EXCLUDED.executed_at,
             raw_payload=EXCLUDED.raw_payload,
             deal_status=EXCLUDED.deal_status,
             filled_volume_cents=EXCLUDED.filled_volume_cents,
             closed_volume_cents=EXCLUDED.closed_volume_cents,
             money_digits=EXCLUDED.money_digits,
             close_position_detail=EXCLUDED.close_position_detail,
             provider_updated_at=EXCLUDED.provider_updated_at,
             imported_at=now()
           WHERE trade_executions.raw_payload IS DISTINCT FROM EXCLUDED.raw_payload`,
          [
            randomUUID(),
            input.connection.user_id,
            input.connection.id,
            deal.dealId,
            deal.positionId,
            deal.orderId,
            deal.symbolId,
            deal.tradeSide,
            volumeCentsToUnits(deal.filledVolumeCents),
            String(deal.executionPrice),
            money.pnl,
            money.commission,
            money.swap,
            this.accountCurrency(input.trader, input.assets),
            new Date(deal.executionTimestamp),
            json(deal.raw),
            deal.dealStatus,
            deal.filledVolumeCents.toString(),
            closeVolume?.toString() ?? null,
            money.moneyDigits,
            deal.closePositionDetail === null ? null : json(deal.closePositionDetail.raw),
            deal.providerUpdatedTimestamp === null ? null : new Date(deal.providerUpdatedTimestamp),
          ],
        );
        if (storedExecution) counters.updatedExecutions += 1;
        else counters.insertedExecutions += 1;
      }

      // Older builds incorrectly treated deal/trader moneyDigits as a scale
      // for closePositionDetail. De-authorize every such stored observation,
      // including positions outside the normal overlap, before any API or
      // export can continue presenting the derived values as provider exact.
      const missingCloseMoneyExecutions = await client.query<MissingCloseMoneyExecutionRow>(
        `SELECT external_execution_id, external_position_id, executed_at
         FROM trade_executions
         WHERE user_id=$1 AND broker_connection_id=$2
           AND jsonb_typeof(raw_payload->'closePositionDetail')='object'
           AND raw_payload->'closePositionDetail'->>'moneyDigits' IS NULL
         ORDER BY executed_at ASC, external_execution_id::numeric ASC
         LIMIT $3`,
        [input.connection.user_id, input.connection.id, EXACT_MONEY_RETRY_QUEUE_LIMIT + 1],
      );
      if (missingCloseMoneyExecutions.rows.length > 0) {
        const executionRepair = await client.query(
          `UPDATE trade_executions SET
             pnl=NULL,
             commission=CASE
               WHEN raw_payload->>'commission' ~ '^-?(0|[1-9][0-9]*)$'
                AND raw_payload->>'moneyDigits' ~ '^([0-9]|1[0-8])$'
               THEN (raw_payload->>'commission')::numeric
                 / power(10::numeric, (raw_payload->>'moneyDigits')::int)
               ELSE NULL
             END,
             swap=NULL,
             money_digits=CASE
               WHEN raw_payload->>'commission' ~ '^-?(0|[1-9][0-9]*)$'
                AND raw_payload->>'moneyDigits' ~ '^([0-9]|1[0-8])$'
               THEN (raw_payload->>'moneyDigits')::int
               ELSE NULL
             END,
             imported_at=now()
           WHERE user_id=$1 AND broker_connection_id=$2
             AND jsonb_typeof(raw_payload->'closePositionDetail')='object'
             AND raw_payload->'closePositionDetail'->>'moneyDigits' IS NULL
             AND (
               pnl IS NOT NULL OR swap IS NOT NULL
               OR commission IS DISTINCT FROM CASE
                 WHEN raw_payload->>'commission' ~ '^-?(0|[1-9][0-9]*)$'
                  AND raw_payload->>'moneyDigits' ~ '^([0-9]|1[0-8])$'
                 THEN (raw_payload->>'commission')::numeric
                   / power(10::numeric, (raw_payload->>'moneyDigits')::int)
                 ELSE NULL
               END
               OR money_digits IS DISTINCT FROM CASE
                 WHEN raw_payload->>'commission' ~ '^-?(0|[1-9][0-9]*)$'
                  AND raw_payload->>'moneyDigits' ~ '^([0-9]|1[0-8])$'
                 THEN (raw_payload->>'moneyDigits')::int
                 ELSE NULL
               END
             )`,
          [input.connection.user_id, input.connection.id],
        );
        counters.deauthorizedUnsupportedExactExecutions = executionRepair.rowCount ?? 0;
        const tradeRepair = await client.query(
          `UPDATE trades SET
             pnl=CASE
               WHEN broker_data->>'pnlAuthority'='preserved_reconciled_manual'
                AND broker_data->>'reconciledManualPnlPreserved'='true'
               THEN pnl ELSE NULL
             END,
             broker_data=(broker_data
               - 'grossProfit' - 'commission' - 'swap' - 'pnlConversionFee' - 'realizedEvents'
               - 'pnlMethod' - 'pnlAuthority' - 'pnlComponentsCoverage')
               || jsonb_build_object(
                 'pnlMethod','partial_provider_close_detail_unavailable',
                 'pnlAuthority',CASE
                   WHEN broker_data->>'pnlAuthority'='preserved_reconciled_manual'
                    AND broker_data->>'reconciledManualPnlPreserved'='true'
                   THEN 'preserved_reconciled_manual' ELSE 'provider_unavailable'
                 END,
                 'reconciledManualPnlPreserved',CASE
                   WHEN broker_data->>'pnlAuthority'='preserved_reconciled_manual'
                    AND broker_data->>'reconciledManualPnlPreserved'='true'
                   THEN true ELSE false
                 END,
                 'pnlComponentsCoverage',jsonb_build_object(
                   'version',1,
                   'source','ProtoOAClosePositionDetail',
                   'scope','realized_closing_deals',
                   'tradeLevelExact',false,
                   'grossProfit',false,
                   'brokerCommission',false,
                   'swap',false,
                   'pnlConversionFee',false,
                   'formula','grossProfit + swap + commission - pnlConversionFee',
                   'otherAccountCashFlowsIncluded',false,
                   'otherAccountCashFlowsAttribution','not_provided_by_position'
                 )
               ),
             row_version=row_version+1,
             updated_at=now()
           WHERE user_id=$1 AND broker_connection_id=$2
             AND EXISTS (
               SELECT 1 FROM trade_executions AS vulnerable_execution
               WHERE vulnerable_execution.user_id=trades.user_id
                 AND vulnerable_execution.broker_connection_id=trades.broker_connection_id
                 AND trades.external_trade_key='position:' || vulnerable_execution.external_position_id
                 AND jsonb_typeof(vulnerable_execution.raw_payload->'closePositionDetail')='object'
                 AND vulnerable_execution.raw_payload->'closePositionDetail'->>'moneyDigits' IS NULL
             )
             AND (
               (pnl IS NOT NULL AND NOT (
                 broker_data->>'pnlAuthority'='preserved_reconciled_manual'
                 AND broker_data->>'reconciledManualPnlPreserved'='true'
               ))
               OR broker_data ?| ARRAY['grossProfit','commission','swap','pnlConversionFee','realizedEvents']
               OR COALESCE(broker_data->>'pnlAuthority','') NOT IN (
                 'provider_unavailable','preserved_reconciled_manual'
               )
             )`,
          [input.connection.user_id, input.connection.id],
        );
        counters.deauthorizedUnsupportedExactTrades = tradeRepair.rowCount ?? 0;
        const candidateRepair = await client.query(
          `UPDATE ctrader_live_reconciliation_candidates AS candidate SET
             projected_trade=jsonb_set(
               jsonb_set(candidate.projected_trade,'{pnl}','null'::jsonb,true),
               '{brokerData}',
               (COALESCE(candidate.projected_trade->'brokerData','{}'::jsonb)
                 - 'grossProfit' - 'commission' - 'swap' - 'pnlConversionFee' - 'realizedEvents'
                 - 'pnlMethod' - 'pnlAuthority' - 'pnlComponentsCoverage')
                 || jsonb_build_object(
                   'pnlMethod','partial_provider_close_detail_unavailable',
                   'pnlAuthority','provider_unavailable',
                   'reconciledManualPnlPreserved',false,
                   'pnlComponentsCoverage',jsonb_build_object(
                     'version',1,
                     'source','ProtoOAClosePositionDetail',
                     'scope','realized_closing_deals',
                     'tradeLevelExact',false,
                     'grossProfit',false,
                     'brokerCommission',false,
                     'swap',false,
                     'pnlConversionFee',false,
                     'formula','grossProfit + swap + commission - pnlConversionFee',
                     'otherAccountCashFlowsIncluded',false,
                     'otherAccountCashFlowsAttribution','not_provided_by_position'
                   )
                 ),
               true
             ),
             candidate_data=candidate.candidate_data || jsonb_build_object(
               'exactMoneyRepairPending',true,
               'exactMoneyRepairReason','close_position_detail_money_digits_unavailable'
             ),
             projection_fingerprint=decode(repeat('ff',32),'hex'),
             row_version=candidate.row_version+1
           FROM trade_executions AS vulnerable_execution
           WHERE candidate.user_id=$1 AND candidate.broker_connection_id=$2
             AND candidate.status='pending'
             AND vulnerable_execution.user_id=candidate.user_id
             AND vulnerable_execution.broker_connection_id=candidate.broker_connection_id
             AND vulnerable_execution.external_position_id=candidate.external_position_id
             AND jsonb_typeof(vulnerable_execution.raw_payload->'closePositionDetail')='object'
             AND vulnerable_execution.raw_payload->'closePositionDetail'->>'moneyDigits' IS NULL
             AND (
               candidate.projected_trade->>'pnl' IS NOT NULL
               OR COALESCE(candidate.projected_trade->'brokerData'->>'pnlAuthority','') <> 'provider_unavailable'
               OR COALESCE(candidate.candidate_data->>'exactMoneyRepairPending','') <> 'true'
               OR candidate.projection_fingerprint IS DISTINCT FROM decode(repeat('ff',32),'hex')
             )`,
          [input.connection.user_id, input.connection.id],
        );
        counters.sanitizedUnsupportedExactCandidates = candidateRepair.rowCount ?? 0;
      }

      const invalidatedCashFlowFallbacks = await client.query(
        `UPDATE ctrader_account_cash_flows SET
           amount=NULL, balance=NULL, equity=NULL, money_digits=NULL,
           money_digits_source='unavailable', synced_at=now()
         WHERE user_id=$1 AND broker_connection_id=$2
           AND money_digits_source='account'`,
        [input.connection.user_id, input.connection.id],
      );
      counters.invalidatedAccountCashFlowFallbacks = invalidatedCashFlowFallbacks.rowCount ?? 0;

      const existingCashFlows = input.fetchedCashFlows.length === 0
        ? new Map<string, StoredCashFlowRow>()
        : new Map((await client.query<StoredCashFlowRow>(
            `SELECT external_cash_flow_id, operation_type, operation_name,
                    raw_delta, raw_balance, raw_equity, currency_code,
                    money_digits, money_digits_source, balance_version, occurred_at
             FROM ctrader_account_cash_flows
             WHERE broker_connection_id=$1 AND external_cash_flow_id=ANY($2::text[])`,
            [input.connection.id, input.fetchedCashFlows.map((cashFlow) => cashFlow.balanceHistoryId)],
          )).rows.map((row) => [row.external_cash_flow_id, row]));
      for (const fetchedCashFlow of input.fetchedCashFlows) {
        const stored = existingCashFlows.get(fetchedCashFlow.balanceHistoryId) ?? null;
        if (stored && stored.currency_code.trim().toUpperCase() !== accountCurrency) {
          throw new CTraderSyncError(
            "CASH_FLOW_ID_CONFLICT",
            `cTrader changed currency for immutable cash-flow ${fetchedCashFlow.balanceHistoryId}`,
            false,
          );
        }
        const cashFlow = stored ? mergeStoredCashFlowFacts(stored, fetchedCashFlow) : fetchedCashFlow;
        const scale = resolveCashFlowMoneyScale({
          cashFlowMoneyDigits: cashFlow.moneyDigits,
          accountMoneyDigits: input.trader.moneyDigits,
          stored: stored === null ? null : {
            moneyDigits: stored.money_digits,
            source: stored.money_digits_source,
          },
        });
        const moneyDigits = scale.moneyDigits;
        const moneyDigitsSource = scale.source;
        const changed = await client.query<{ id: string }>(
          `INSERT INTO ctrader_account_cash_flows (
             id, user_id, broker_connection_id, external_cash_flow_id,
             operation_type, operation_name, amount, balance, equity,
             raw_delta, raw_balance, raw_equity, currency_code, money_digits,
             money_digits_source, balance_version, occurred_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           ON CONFLICT (broker_connection_id, external_cash_flow_id) DO UPDATE SET
             operation_type=EXCLUDED.operation_type,
             operation_name=EXCLUDED.operation_name,
             amount=EXCLUDED.amount,
             balance=EXCLUDED.balance,
             equity=EXCLUDED.equity,
             raw_delta=EXCLUDED.raw_delta,
             raw_balance=EXCLUDED.raw_balance,
             raw_equity=EXCLUDED.raw_equity,
             currency_code=EXCLUDED.currency_code,
             money_digits=EXCLUDED.money_digits,
             money_digits_source=EXCLUDED.money_digits_source,
             balance_version=EXCLUDED.balance_version,
             occurred_at=EXCLUDED.occurred_at,
             synced_at=now()
           WHERE (
             ctrader_account_cash_flows.operation_type,
             ctrader_account_cash_flows.operation_name,
             ctrader_account_cash_flows.amount,
             ctrader_account_cash_flows.balance,
             ctrader_account_cash_flows.equity,
             ctrader_account_cash_flows.raw_delta,
             ctrader_account_cash_flows.raw_balance,
             ctrader_account_cash_flows.raw_equity,
             ctrader_account_cash_flows.currency_code,
             ctrader_account_cash_flows.money_digits,
             ctrader_account_cash_flows.money_digits_source,
             ctrader_account_cash_flows.balance_version,
             ctrader_account_cash_flows.occurred_at
           ) IS DISTINCT FROM (
             EXCLUDED.operation_type,
             EXCLUDED.operation_name,
             EXCLUDED.amount,
             EXCLUDED.balance,
             EXCLUDED.equity,
             EXCLUDED.raw_delta,
             EXCLUDED.raw_balance,
             EXCLUDED.raw_equity,
             EXCLUDED.currency_code,
             EXCLUDED.money_digits,
             EXCLUDED.money_digits_source,
             EXCLUDED.balance_version,
             EXCLUDED.occurred_at
           )
           RETURNING id`,
          [
            randomUUID(),
            input.connection.user_id,
            input.connection.id,
            cashFlow.balanceHistoryId,
            cashFlow.operationType,
            cashFlow.operationName,
            moneyDigits === null ? null : decimalFromScaledInteger(cashFlow.delta, moneyDigits),
            moneyDigits === null ? null : decimalFromScaledInteger(cashFlow.balance, moneyDigits),
            cashFlow.equity === null || moneyDigits === null ? null : decimalFromScaledInteger(cashFlow.equity, moneyDigits),
            cashFlow.delta.toString(),
            cashFlow.balance.toString(),
            cashFlow.equity?.toString() ?? null,
            accountCurrency,
            moneyDigits,
            moneyDigitsSource,
            cashFlow.balanceVersion?.toString() ?? null,
            new Date(cashFlow.changeBalanceTimestamp),
          ],
        );
        if (!changed.rows[0]) continue;
        if (existingCashFlows.has(cashFlow.balanceHistoryId)) counters.updatedAccountCashFlows! += 1;
        else counters.insertedAccountCashFlows! += 1;
      }

      const cashFlowCoverageResult = await client.query<CashFlowScaleCoverageRow>(
        `SELECT
           count(*)::text AS total_rows,
           count(*) FILTER (
             WHERE money_digits_source='cash_flow' AND money_digits IS NOT NULL
           )::text AS scaled_rows,
           count(*) FILTER (
             WHERE money_digits_source<>'cash_flow' OR money_digits IS NULL
           )::text AS unscaled_rows
         FROM ctrader_account_cash_flows
         WHERE user_id=$1 AND broker_connection_id=$2`,
        [input.connection.user_id, input.connection.id],
      );
      const cashFlowCoverage = cashFlowCoverageResult.rows[0] ?? {
        total_rows: 0,
        scaled_rows: 0,
        unscaled_rows: 0,
      };
      const totalAccountCashFlows = Number(cashFlowCoverage.total_rows);
      const scaledAccountCashFlows = Number(cashFlowCoverage.scaled_rows);
      const unscaledAccountCashFlows = Number(cashFlowCoverage.unscaled_rows);
      if (![totalAccountCashFlows, scaledAccountCashFlows, unscaledAccountCashFlows]
        .every((value) => Number.isSafeInteger(value) && value >= 0)
        || scaledAccountCashFlows + unscaledAccountCashFlows !== totalAccountCashFlows) {
        throw new CTraderSyncError(
          "CASH_FLOW_SCALE_COVERAGE_INVALID",
          "Stored cTrader cash-flow scale coverage is inconsistent",
          false,
        );
      }
      counters.totalAccountCashFlows = totalAccountCashFlows;
      counters.scaledAccountCashFlows = scaledAccountCashFlows;
      counters.unscaledAccountCashFlows = unscaledAccountCashFlows;
      const missingCashFlowMoney = await client.query<MissingCashFlowMoneyRow>(
        `SELECT external_cash_flow_id, occurred_at
         FROM ctrader_account_cash_flows
         WHERE user_id=$1 AND broker_connection_id=$2
           AND (money_digits_source<>'cash_flow' OR money_digits IS NULL)
         ORDER BY occurred_at ASC, external_cash_flow_id::numeric ASC
         LIMIT $3`,
        [input.connection.user_id, input.connection.id, CASH_FLOW_MONEY_RETRY_QUEUE_LIMIT + 1],
      );
      const discoveredMissingCashFlows = missingCashFlowMoney.rows.flatMap((row) => {
        const timestamp = new Date(row.occurred_at).getTime();
        return safeTimestamp(timestamp) === null ? [] : [{
          balanceHistoryId: row.external_cash_flow_id,
          changeBalanceTimestamp: timestamp,
        }];
      });
      const cashFlowMoneyRetriesAfter = reconcileCashFlowMoneyRetryQueue({
        previous: input.cashFlowMoneyRetriesBefore,
        attemptedBalanceHistoryIds: input.attemptedCashFlowMoneyRetryIds,
        fetchedCashFlows: input.fetchedCashFlows,
        discoveredMissing: discoveredMissingCashFlows,
        observedAt: input.syncedThroughTimestamp,
      });
      counters.completedCashFlowMoneyRetries = [...input.attemptedCashFlowMoneyRetryIds]
        .filter((balanceHistoryId) => !cashFlowMoneyRetriesAfter
          .some((entry) => entry.balanceHistoryId === balanceHistoryId)).length;
      counters.pendingCashFlowMoneyRetries = cashFlowMoneyRetriesAfter.length;

      await this.upsertSymbolSpecs(client, input);
      const positionIds = [...new Set(input.fetchedDeals.map((deal) => deal.positionId))];
      const projectedPositions = new Map<string, CTraderDeal[]>();
      if (positionIds.length > 0) {
        const stored = await client.query<StoredExecutionRow>(
          `SELECT external_position_id, raw_payload
           FROM trade_executions
           WHERE broker_connection_id=$1
             AND external_position_id=ANY($2::text[])
           ORDER BY executed_at ASC, external_execution_id::numeric ASC`,
          [input.connection.id, positionIds],
        );
        for (const row of stored.rows) {
          const parsed = parseDeals({ deal: [row.raw_payload], hasMore: false }).deals[0];
          if (!parsed) continue;
          const group = projectedPositions.get(row.external_position_id) ?? [];
          group.push(parsed);
          projectedPositions.set(row.external_position_id, group);
        }
        const lightById = new Map(input.lightSymbols.map((symbol) => [symbol.symbolId, symbol]));
        const specById = new Map(input.symbolSpecs.map((spec) => [spec.symbolId, spec]));
        const categories = new Map(input.categories.map((category) => [category.id, category]));
        const classes = new Map(input.assetClasses.map((assetClass) => [assetClass.id, assetClass]));
        for (const positionId of positionIds) {
          const deals = projectedPositions.get(positionId);
          if (!deals || deals.length === 0) {
            throw new CTraderSyncError("POSITION_EXECUTIONS_MISSING", `No stored executions exist for position ${positionId}`, false);
          }
          const symbolId = deals[0]?.symbolId;
          const light = symbolId ? lightById.get(symbolId) : undefined;
          const spec = symbolId ? specById.get(symbolId) : undefined;
          if (!light || !spec) {
            throw new CTraderSyncError("SYMBOL_SPEC_MISSING", `Position ${positionId} has no authoritative symbol specification`, false);
          }
          const projection = projectPosition({
            deals,
            lightSymbol: light,
            symbolSpec: spec,
            symbolCategories: categories,
            assetClasses: classes,
            accountMoneyDigits: input.trader.moneyDigits,
            timeZone: this.config.cTrader.tradingTimeZone,
          });
          if (await this.stageLiveReconciliation(client, input, projection)) {
            counters.positionsProjected += 1;
            continue;
          }
          await this.upsertProjection(client, input, projection, counters);
          counters.positionsProjected += 1;
        }
      }

      const exactMoneyRetriesAfter = reconcileExactMoneyRetryQueue({
        previous: input.exactMoneyRetriesBefore,
        attemptedExecutionIds: input.attemptedExactMoneyRetryIds,
        projectedPositions,
        discoveredMissing: missingCloseMoneyExecutions.rows.flatMap((row) => {
          const executionTimestamp = new Date(row.executed_at).getTime();
          return safeTimestamp(executionTimestamp) === null ? [] : [{
            executionId: row.external_execution_id,
            positionId: row.external_position_id,
            executionTimestamp,
          }];
        }),
        observedAt: input.syncedThroughTimestamp,
      });
      counters.completedExactMoneyRetries = [...input.attemptedExactMoneyRetryIds]
        .filter((executionId) => !exactMoneyRetriesAfter.some((entry) => entry.executionId === executionId)).length;
      counters.pendingExactMoneyRetries = exactMoneyRetriesAfter.length;

      const priorLastDealTimestamp = safeTimestamp(input.cursorBefore.lastDealTimestamp);
      const fetchedLastDeal = input.fetchedDeals.at(-1) ?? null;
      const fetchedAdvancesLastDeal = fetchedLastDeal !== null
        && (priorLastDealTimestamp === null || fetchedLastDeal.executionTimestamp >= priorLastDealTimestamp);
      const priorLastCashFlowTimestamp = safeTimestamp(input.cursorBefore.lastCashFlowTimestamp);
      const fetchedLastCashFlow = input.fetchedCashFlows.at(-1) ?? null;
      const fetchedAdvancesLastCashFlow = fetchedLastCashFlow !== null
        && (priorLastCashFlowTimestamp === null
          || fetchedLastCashFlow.changeBalanceTimestamp >= priorLastCashFlowTimestamp);

      const cursorAfter = {
        version: 1,
        fullHistoryComplete: true,
        registrationTimestamp: input.registrationTimestamp,
        syncedThroughTimestamp: input.syncedThroughTimestamp,
        cashFlowHistoryComplete: true,
        cashFlowSyncedThroughTimestamp: input.syncedThroughTimestamp,
        exactMoneyRetryQueueVersion: EXACT_MONEY_RETRY_QUEUE_VERSION,
        exactMoneyRetries: exactMoneyRetriesAfter,
        cashFlowMoneyRetryQueueVersion: CASH_FLOW_MONEY_RETRY_QUEUE_VERSION,
        cashFlowMoneyRetries: cashFlowMoneyRetriesAfter,
        lastCashFlowTimestamp: fetchedAdvancesLastCashFlow
          ? fetchedLastCashFlow.changeBalanceTimestamp
          : priorLastCashFlowTimestamp,
        lastCashFlowId: fetchedAdvancesLastCashFlow
          ? fetchedLastCashFlow.balanceHistoryId
          : (typeof input.cursorBefore.lastCashFlowId === "string" ? input.cursorBefore.lastCashFlowId : null),
        lastDealTimestamp: fetchedAdvancesLastDeal
          ? fetchedLastDeal.executionTimestamp
          : priorLastDealTimestamp,
        lastDealId: fetchedAdvancesLastDeal
          ? fetchedLastDeal.dealId
          : (typeof input.cursorBefore.lastDealId === "string" ? input.cursorBefore.lastDealId : null),
      };
      const metadata = {
        registrationTimestamp: input.registrationTimestamp,
        depositAssetId: input.trader.depositAssetId,
        accountCurrency,
        accountMoneyDigits: input.trader.moneyDigits,
        accountBalance: input.trader.moneyDigits === null
          ? null
          : decimalFromScaledInteger(input.trader.balance, input.trader.moneyDigits),
        accountBalanceRawUnits: input.trader.balance.toString(),
        accountBalanceVersion: input.trader.balanceVersion?.toString() ?? null,
        accountBalanceMoneyDigits: input.trader.moneyDigits,
        accountBalanceAsOf: new Date(input.traderObservedAt).toISOString(),
        accountBalanceSource: "ProtoOATrader",
        accountBalanceScalingStatus: input.trader.moneyDigits === null
          ? "money_digits_unavailable"
          : "exact",
        accountCashFlowHistoryComplete: true,
        accountCashFlowHistoryStartTimestamp: input.registrationTimestamp,
        accountCashFlowSyncedThroughTimestamp: input.syncedThroughTimestamp,
        accountCashFlowPositionAttribution: "not_provided_by_ctrader",
        accountCashFlowMonetaryScaleComplete: unscaledAccountCashFlows === 0
          && cashFlowMoneyRetriesAfter.length === 0,
        accountCashFlowTotalRows: totalAccountCashFlows,
        accountCashFlowScaledRows: scaledAccountCashFlows,
        accountCashFlowUnscaledRows: unscaledAccountCashFlows,
        accountCashFlowPendingScaleRetries: cashFlowMoneyRetriesAfter.length,
        lastErrorCode: null,
        lastErrorMessage: null,
        reauthRequired: false,
        readOnly: true,
      };
      await client.query(
        `UPDATE broker_connections SET
           sync_cursor=$1::jsonb,
           provider_metadata=(provider_metadata - 'lastErrorCode' - 'lastErrorMessage') || $2::jsonb,
           last_sync_at=now()
         WHERE id=$3`,
        [json(cursorAfter), json(metadata), input.connection.id],
      );
      return { counters, cursorAfter };
    });

    return {
      userId: input.connection.user_id,
      connectionId: input.connection.id,
      counters: result.counters,
      cursorBefore: input.cursorBefore,
      cursorAfter: result.cursorAfter,
    };
  }

  private accountCurrency(trader: CTraderTraderMetadata, assets: readonly CTraderAsset[]): string | null {
    const asset = assets.find((candidate) => candidate.assetId === trader.depositAssetId);
    if (!asset) {
      throw new CTraderSyncError(
        "DEPOSIT_ASSET_MISSING",
        `cTrader did not return deposit asset ${trader.depositAssetId}`,
        false,
      );
    }
    const value = asset.name.trim().toUpperCase();
    return value.length > 0 ? value : null;
  }

  private async upsertSymbolSpecs(client: PoolClient, input: {
    connection: SyncConnectionRow;
    symbolSpecs: CTraderSymbolSpec[];
    lightSymbols: CTraderLightSymbol[];
  }): Promise<void> {
    const lightById = new Map(input.lightSymbols.map((symbol) => [symbol.symbolId, symbol]));
    for (const spec of input.symbolSpecs) {
      const light = lightById.get(spec.symbolId);
      await client.query(
        `INSERT INTO symbol_specs (
           id, provider, provider_environment, external_account_id,
           external_symbol_id, symbol_name, specification, fetched_at, expires_at
         ) VALUES ($1,'ctrader',$2,$3,$4,$5,$6::jsonb,now(),now()+($7::int*interval '1 second'))
         ON CONFLICT (provider, provider_environment, external_account_id, external_symbol_id)
         DO UPDATE SET symbol_name=EXCLUDED.symbol_name,
           specification=EXCLUDED.specification, fetched_at=now(),
           expires_at=EXCLUDED.expires_at`,
        [
          randomUUID(),
          input.connection.provider_environment,
          input.connection.external_account_id,
          spec.symbolId,
          spec.symbolName,
          json({
            ...spec.raw,
            symbolId: spec.symbolId,
            symbolName: spec.symbolName,
            lotSizeCents: spec.lotSizeCents.toString(),
            digits: spec.digits,
            pipPosition: spec.pipPosition,
            symbolCategoryId: light?.symbolCategoryId ?? null,
          }),
          this.config.cTrader.symbolCacheSeconds,
        ],
      );
    }
  }

  private projectionBrokerData(
    input: OfficialProjectionContext,
    projection: CTraderTradeProjection,
  ): Record<string, unknown> {
    return {
      provider: "ctrader",
      connectionMode: "official",
      readOnly: true,
      environment: input.connection.provider_environment,
      ctidTraderAccountId: input.connection.external_account_id,
      positionId: projection.positionId,
      symbolId: projection.symbolId,
      providerTradeDate: projection.tradeDate,
      providerTradeDateTimeZone: this.config.cTrader.tradingTimeZone,
      openedVolumeCents: projection.openedVolumeCents,
      closedVolumeCents: projection.closedVolumeCents,
      openVolumeCents: projection.openVolumeCents,
      quantityProjection: {
        version: 1,
        value: projection.quantityLots,
        unit: "lots",
        lots: projection.quantityLots,
        baseUnits: volumeCentsToUnits(BigInt(projection.openedVolumeCents)),
        volumeScale: "unit_cents",
        source: "provider_filled_volume",
      },
      grossProfit: projection.grossProfit,
      commission: projection.commission,
      swap: projection.swap,
      pnlConversionFee: projection.pnlConversionFee,
      realizedEvents: projection.realizedEvents,
      pnlMethod: projection.realizedPnlComplete
        ? "provider_close_detail_money_digits"
        : BigInt(projection.closedVolumeCents) > 0n
          ? "partial_provider_close_detail_unavailable"
          : "not_realized",
      pnlAuthority: projection.pnl !== null ? "provider" : "provider_unavailable",
      reconciledManualPnlPreserved: false,
      pnlComponentsCoverage: {
        version: 1,
        source: "ProtoOAClosePositionDetail",
        scope: "realized_closing_deals",
        tradeLevelExact: projection.realizedPnlComplete,
        grossProfit: projection.realizedPnlComplete,
        brokerCommission: projection.realizedPnlComplete,
        swap: projection.realizedPnlComplete,
        pnlConversionFee: projection.realizedPnlComplete,
        formula: "grossProfit + swap + commission - pnlConversionFee",
        otherAccountCashFlowsIncluded: false,
        otherAccountCashFlowsAttribution: "not_provided_by_position",
      },
      accountCurrency: this.accountCurrency(input.trader, input.assets),
      accountMoneyDigits: input.trader.moneyDigits,
      classification: projection.classification,
    };
  }

  /**
   * Official full-history replay must use the same reviewed duplicate boundary
   * as ongoing MCP sync.  A plausible manual journal is staged and the new
   * broker row is withheld until the user chooses link/separate/reject.  No
   * confidence level auto-merges financial or psychology data.
   */
  private async stageLiveReconciliation(
    client: PoolClient,
    input: OfficialProjectionContext,
    projection: CTraderTradeProjection,
  ): Promise<boolean> {
    const connection = input.connection;
    const externalKey = `position:${projection.positionId}`;
    const tombstone = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM ctrader_trade_tombstones
         WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
       ) AS exists`,
      [connection.user_id, connection.id, externalKey],
    );
    if (tombstone.rows[0]?.exists) return false;

    const prior = await client.query<{ status: string }>(
      `SELECT status FROM ctrader_live_reconciliation_candidates
       WHERE user_id=$1 AND broker_connection_id=$2 AND external_position_id=$3
       LIMIT 1`,
      [connection.user_id, connection.id, projection.positionId],
    );
    if (prior.rows[0] && prior.rows[0].status !== "pending") return false;

    const broker = await client.query<{ id: string; row_version: number; deleted_at: Date | string | null }>(
      `SELECT id, row_version, deleted_at FROM trades
       WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
       LIMIT 1`,
      [connection.user_id, connection.id, externalKey],
    );
    const brokerRow = broker.rows[0] ?? null;
    if (brokerRow?.deleted_at) return false;

    const manualRows = (await client.query<OfficialLiveManualTradeRow>(
      `SELECT manual.id, manual.row_version, manual.deleted_at,
              manual.symbol, manual.direction, manual.entry_price::text,
              manual.exit_price::text, manual.quantity::text, manual.pnl::text,
              manual.trade_date, manual.entry_at, manual.exit_at,
              manual.strategy, manual.emotion, manual.notes,
              manual.psychology, manual.custom_fields,
              (SELECT count(*) FROM file_objects file
               WHERE file.user_id=manual.user_id AND file.trade_id=manual.id
                 AND file.deleted_at IS NULL) AS screenshot_count
       FROM trades manual
       WHERE manual.user_id=$1
         AND manual.broker_connection_id IS NULL
         AND manual.external_trade_key IS NULL
         AND manual.source_system <> 'ctrader'
         AND manual.trade_date BETWEEN $2::date - 1 AND $2::date + 1
         AND (
           ($3::uuid IS NOT NULL AND manual.account_id=$3::uuid)
           OR ($3::uuid IS NULL AND $4::text IS NOT NULL AND manual.legacy_account_id=$4::text)
         )
       ORDER BY manual.created_at ASC, manual.id ASC
       LIMIT 101`,
      [
        connection.user_id,
        projection.tradeDate,
        connection.mapped_account_id,
        connection.legacy_mapped_account_id,
      ],
    )).rows;
    if (manualRows.length > 100) {
      throw new CTraderSyncError(
        "CTRADER_LIVE_RECONCILIATION_LIMIT_EXCEEDED",
        "Too many manual trades match the cTrader trade date; narrow the journal before syncing",
        false,
      );
    }

    const identityMatches = (manual: OfficialLiveManualTradeRow): boolean =>
      reconciliationSymbol(manual.symbol) === reconciliationSymbol(projection.symbol)
      && manual.direction === projection.direction;
    const sameDate = manualRows.filter((manual) =>
      identityMatches(manual) && reconciliationDate(manual.trade_date) === projection.tradeDate);
    const strict = sameDate.filter((manual) =>
      decimalWithin(manual.entry_price, projection.entryPrice, 0.0005, 0.00000001)
      && decimalWithin(manual.exit_price, projection.exitPrice, 0.0005, 0.00000001)
      && decimalWithin(manual.quantity, projection.quantityLots, 0.005, 0.00000001)
      && (manual.pnl === null || projection.pnl === null
        || decimalWithin(manual.pnl, projection.pnl, 0.005, 0.01))
      && (manual.entry_at === null
        || Math.abs(new Date(manual.entry_at).getTime() - Date.parse(projection.entryAt)) <= 300_000)
      && (manual.exit_at === null || projection.exitAt === null
        || Math.abs(new Date(manual.exit_at).getTime() - Date.parse(projection.exitAt)) <= 300_000));
    const adjacent = sameDate.length > 0 ? [] : manualRows.filter((manual) => {
      const days = dateDistanceDays(manual.trade_date, projection.tradeDate);
      return identityMatches(manual) && days !== null && days <= 1
        && decimalWithin(manual.entry_price, projection.entryPrice, 0.0005, 0.00000001)
        && decimalWithin(manual.exit_price, projection.exitPrice, 0.0005, 0.00000001)
        && decimalWithin(manual.quantity, projection.quantityLots, 0.005, 0.00000001);
    });
    const choices = sameDate.length > 0 ? sameDate : adjacent;
    if (choices.length === 0) {
      await client.query(
        `DELETE FROM ctrader_live_reconciliation_candidates
         WHERE user_id=$1 AND broker_connection_id=$2 AND external_position_id=$3
           AND status='pending'`,
        [connection.user_id, connection.id, projection.positionId],
      );
      return false;
    }

    const activeStrict = strict.filter((manual) => manual.deleted_at === null);
    const deletedStrict = strict.filter((manual) => manual.deleted_at !== null);
    const selected = strict.length === 1 ? strict[0] ?? null : null;
    const classification = brokerRow !== null
      ? "existing_pair"
      : activeStrict.length === 1 && strict.length === 1
        ? "high_confidence"
        : deletedStrict.length === 1 && strict.length === 1
          ? "deleted_manual"
          : "ambiguous";
    const reasons = classification === "high_confidence"
      ? ["unique_strict_manual_match", "same_account", "official_provider_values_within_strict_tolerance"]
      : classification === "deleted_manual"
        ? ["unique_strict_deleted_manual_match", "deleted_trade_requires_explicit_suppression_review"]
        : adjacent.length > 0
          ? ["possible_manual_match_within_one_local_day", "explicit_manual_selection_required"]
          : ["possible_manual_duplicate", "explicit_manual_selection_required"];
    const choiceData = choices.map((manual) => ({
      id: manual.id,
      version: manual.row_version,
      deleted: manual.deleted_at !== null,
      symbol: manual.symbol,
      direction: manual.direction,
      date: reconciliationDate(manual.trade_date),
      hasStrategy: Boolean(manual.strategy?.trim()),
      hasEmotion: Boolean(manual.emotion?.trim()),
      hasPsychology: Object.keys(objectValue(manual.psychology)).length > 0,
      hasNotes: Boolean(manual.notes?.trim()),
      hasCustomFields: Object.keys(objectValue(manual.custom_fields)).length > 0,
      screenshotCount: Number(manual.screenshot_count ?? 0),
    }));
    const brokerData = this.projectionBrokerData(input, projection);
    const exactMoneyRepairPending = BigInt(projection.closedVolumeCents) > 0n
      && !projection.realizedPnlComplete;
    const projectedTrade = {
      positionId: projection.positionId,
      symbol: projection.symbol,
      asset: projection.asset,
      direction: projection.direction,
      entryPrice: projection.entryPrice,
      exitPrice: projection.exitPrice,
      quantity: projection.quantityLots,
      quantityUnit: "lots",
      quantityLots: projection.quantityLots,
      quantityBaseUnits: volumeCentsToUnits(BigInt(projection.openedVolumeCents)),
      pnl: projection.pnl,
      isOpen: projection.isOpen,
      tradeDate: projection.tradeDate,
      entryAt: projection.entryAt,
      exitAt: projection.exitAt,
      entryTime: projection.entryTime,
      exitTime: projection.exitTime,
      brokerData,
    };
    // Keep every still-incomplete close projection in the same non-resolvable
    // repair state, including a replay that again omits close moneyDigits.
    // Only an authoritative exact projection receives its normal fingerprint,
    // which guarantees the upsert clears this marker after self-healing.
    const fingerprint = exactMoneyRepairPending
      ? Buffer.alloc(32, 0xff)
      : createHash("sha256").update(json(projectedTrade)).digest();
    await client.query(
      `INSERT INTO ctrader_live_reconciliation_candidates (
         id, user_id, broker_connection_id, external_position_id,
         external_trade_key, manual_trade_id, manual_row_version,
         broker_trade_id, broker_row_version, classification, confidence,
         reasons, differences, candidate_data, projected_trade,
         projection_fingerprint, status
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,'{}'::jsonb,$13::jsonb,
         $14::jsonb,$15,'pending'
       )
       ON CONFLICT (user_id, broker_connection_id, external_position_id)
       DO UPDATE SET
         manual_trade_id=EXCLUDED.manual_trade_id,
         manual_row_version=EXCLUDED.manual_row_version,
         broker_trade_id=EXCLUDED.broker_trade_id,
         broker_row_version=EXCLUDED.broker_row_version,
         classification=EXCLUDED.classification,
         confidence=EXCLUDED.confidence,
         reasons=EXCLUDED.reasons,
         differences=EXCLUDED.differences,
         candidate_data=EXCLUDED.candidate_data,
         projected_trade=EXCLUDED.projected_trade,
         projection_fingerprint=EXCLUDED.projection_fingerprint,
         row_version=ctrader_live_reconciliation_candidates.row_version+1
       WHERE ctrader_live_reconciliation_candidates.status='pending'
         AND (
           ctrader_live_reconciliation_candidates.projection_fingerprint IS DISTINCT FROM EXCLUDED.projection_fingerprint
           OR ctrader_live_reconciliation_candidates.manual_trade_id IS DISTINCT FROM EXCLUDED.manual_trade_id
           OR ctrader_live_reconciliation_candidates.manual_row_version IS DISTINCT FROM EXCLUDED.manual_row_version
           OR ctrader_live_reconciliation_candidates.broker_trade_id IS DISTINCT FROM EXCLUDED.broker_trade_id
           OR ctrader_live_reconciliation_candidates.broker_row_version IS DISTINCT FROM EXCLUDED.broker_row_version
           OR ctrader_live_reconciliation_candidates.classification IS DISTINCT FROM EXCLUDED.classification
         )`,
      [
        randomUUID(), connection.user_id, connection.id, projection.positionId, externalKey,
        selected?.id ?? null, selected?.row_version ?? null,
        brokerRow?.id ?? null, brokerRow?.row_version ?? null,
        classification,
        classification === "high_confidence" || classification === "deleted_manual" ? 100 : adjacent.length === 1 ? 60 : 40,
        json(reasons),
        json({
          manualChoices: choiceData,
          preservedFields: [
            "id", "created_at", "trade_date", "strategy", "emotion", "notes", "tags",
            "psychology", "custom_fields", "stop_loss", "take_profit", "files",
          ],
          ...(exactMoneyRepairPending ? {
            exactMoneyRepairPending: true,
            exactMoneyRepairReason: "close_position_detail_money_digits_unavailable",
          } : {}),
        }),
        json(projectedTrade), fingerprint,
      ],
    );
    return brokerRow === null;
  }

  private async upsertProjection(
    client: PoolClient,
    input: OfficialProjectionContext,
    projection: CTraderTradeProjection,
    counters: CTraderSyncCounters,
  ): Promise<void> {
    const externalKey = `position:${projection.positionId}`;
    const tombstone = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM ctrader_trade_tombstones
         WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
       ) AS exists`,
      [input.connection.user_id, input.connection.id, externalKey],
    );
    if (tombstone.rows[0]?.exists) {
      counters.tombstonesPreserved += 1;
      return;
    }
    const existing = await client.query<ExistingTradeRow>(
      `SELECT trade.id, trade.deleted_at, trade.pnl::text, trade.broker_data,
              EXISTS (
                SELECT 1 FROM ctrader_trade_links link
                WHERE link.user_id=trade.user_id
                  AND link.broker_connection_id=trade.broker_connection_id
                  AND link.external_trade_key=trade.external_trade_key
                  AND link.trade_id=trade.id
              ) AS reconciled_manual_trade
       FROM trades trade
       WHERE trade.user_id=$1 AND trade.broker_connection_id=$2 AND trade.external_trade_key=$3
       LIMIT 1`,
      [input.connection.user_id, input.connection.id, externalKey],
    );
    const previous = existing.rows[0] ?? null;
    if (previous?.deleted_at) {
      counters.archivedTradesPreserved += 1;
      return;
    }
    const providerBrokerData = this.projectionBrokerData(input, projection);
    const authority = mergeOfficialProjectionAuthority({
      existing: previous === null ? null : {
        pnl: previous.pnl,
        brokerData: previous.broker_data,
        reconciledManualTrade: previous.reconciled_manual_trade,
      },
      providerPnl: projection.pnl,
      providerBrokerData,
    });
    const changed = await client.query<{ id: string }>(
      `INSERT INTO trades (
         id, user_id, account_id, legacy_account_id, broker_connection_id,
         source_system, ingestion_method, external_trade_key, broker_trade_id,
         symbol, asset, instrument, direction, entry_price, exit_price,
         quantity, pnl, is_open, trade_date, entry_at, exit_at,
         legacy_entry_time, legacy_exit_time, broker_data,
         calculation_version, row_version
       ) VALUES (
         $1,$2,$3,$4,$5,'ctrader','api',$6,$7,$8,$9,$8,$10,$11,$12,
         $13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,2,1
       )
       ON CONFLICT (broker_connection_id, external_trade_key)
         WHERE broker_connection_id IS NOT NULL AND external_trade_key IS NOT NULL
       DO UPDATE SET
         account_id=EXCLUDED.account_id,
         legacy_account_id=EXCLUDED.legacy_account_id,
         broker_trade_id=EXCLUDED.broker_trade_id,
         symbol=EXCLUDED.symbol,
         asset=EXCLUDED.asset,
         instrument=EXCLUDED.instrument,
         direction=EXCLUDED.direction,
         entry_price=EXCLUDED.entry_price,
         exit_price=EXCLUDED.exit_price,
         quantity=EXCLUDED.quantity,
         pnl=EXCLUDED.pnl,
         is_open=EXCLUDED.is_open,
         entry_at=EXCLUDED.entry_at,
         exit_at=EXCLUDED.exit_at,
         legacy_entry_time=EXCLUDED.legacy_entry_time,
         legacy_exit_time=EXCLUDED.legacy_exit_time,
         broker_data=EXCLUDED.broker_data,
         calculation_version=EXCLUDED.calculation_version,
         row_version=trades.row_version+1
       WHERE trades.deleted_at IS NULL AND (
         trades.account_id, trades.legacy_account_id, trades.broker_trade_id,
         trades.symbol, trades.asset, trades.instrument, trades.direction,
         trades.entry_price, trades.exit_price, trades.quantity, trades.pnl,
         trades.is_open, trades.entry_at, trades.exit_at,
         trades.legacy_entry_time, trades.legacy_exit_time, trades.broker_data,
         trades.calculation_version
       ) IS DISTINCT FROM (
         EXCLUDED.account_id, EXCLUDED.legacy_account_id, EXCLUDED.broker_trade_id,
         EXCLUDED.symbol, EXCLUDED.asset, EXCLUDED.instrument, EXCLUDED.direction,
         EXCLUDED.entry_price, EXCLUDED.exit_price, EXCLUDED.quantity, EXCLUDED.pnl,
         EXCLUDED.is_open, EXCLUDED.entry_at, EXCLUDED.exit_at,
         EXCLUDED.legacy_entry_time, EXCLUDED.legacy_exit_time, EXCLUDED.broker_data,
         EXCLUDED.calculation_version
       )
       RETURNING id`,
      [
        randomUUID(),
        input.connection.user_id,
        input.connection.mapped_account_id,
        input.connection.legacy_mapped_account_id,
        input.connection.id,
        externalKey,
        projection.positionId,
        projection.symbol,
        projection.asset,
        projection.direction,
        projection.entryPrice,
        projection.exitPrice,
        projection.quantityLots,
        authority.pnl,
        projection.isOpen,
        projection.tradeDate,
        projection.entryAt,
        projection.exitAt,
        projection.entryTime,
        projection.exitTime,
        json(authority.brokerData),
      ],
    );
    const tradeId = changed.rows[0]?.id ?? previous?.id ?? null;
    if (tradeId) {
      await client.query(
        `UPDATE trade_executions SET trade_id=$1
         WHERE broker_connection_id=$2 AND external_position_id=$3
           AND trade_id IS DISTINCT FROM $1`,
        [tradeId, input.connection.id, projection.positionId],
      );
    }
    if (!previous) {
      counters.insertedTrades += 1;
      counters.inserted += 1;
    } else if (changed.rows[0]) {
      counters.updatedTrades += 1;
      counters.updated += 1;
    }
    else counters.unchangedTrades += 1;
  }
}
