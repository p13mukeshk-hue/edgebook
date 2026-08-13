import { randomUUID } from "node:crypto";
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

type StoredExecutionRow = QueryResultRow & {
  external_position_id: string;
  raw_payload: unknown;
};

type ExistingTradeRow = QueryResultRow & {
  id: string;
  deleted_at: Date | string | null;
  pnl: string | null;
  broker_data: unknown;
  reconciled_manual_trade: boolean;
};

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

function executionMoney(deal: CTraderDeal, accountMoneyDigits: number | null): {
  pnl: string | null;
  commission: string | null;
  swap: string | null;
  moneyDigits: number | null;
} {
  const close = deal.closePositionDetail;
  const moneyDigits = close?.moneyDigits ?? deal.moneyDigits ?? accountMoneyDigits;
  if (moneyDigits === null) return { pnl: null, commission: null, swap: null, moneyDigits: null };
  const commission = close?.commission ?? deal.commission;
  return {
    pnl: close === null
      ? null
      : decimalFromScaledInteger(close.grossProfit + close.swap + close.commission - close.pnlConversionFee, moneyDigits),
    commission: commission === null || commission === undefined
      ? null
      : decimalFromScaledInteger(commission, moneyDigits),
    swap: close === null ? null : decimalFromScaledInteger(close.swap, moneyDigits),
    moneyDigits,
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

function officialMoneyDigits(deal: CTraderDeal, accountMoneyDigits: number | null): number | null {
  return deal.closePositionDetail?.moneyDigits ?? deal.moneyDigits ?? accountMoneyDigits;
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
 * only by agreeing official close money; a weaker official replay fails closed.
 */
export function mergeStoredExecutionWithOfficial(
  storedExecutionId: string,
  storedRaw: unknown,
  incoming: CTraderDeal,
  expectedAccountId?: string,
  accountMoneyDigits: number | null = null,
): CTraderDeal {
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
      return mergeOfficialDealFacts(parsed, incoming, accountMoneyDigits);
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
  const digits = officialMoneyDigits(incoming, accountMoneyDigits);
  const close = incoming.closePositionDetail;
  if (close === null || digits === null) {
    throw new CTraderSyncError(
      "CTRADER_OFFICIAL_DEAL_DOWNGRADE",
      `Official cTrader history omitted exact close money already stored for deal ${incoming.dealId}`,
      false,
    );
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
    const existingDigits = officialMoneyDigits(existing, accountMoneyDigits);
    const incomingDigits = officialMoneyDigits(incoming, accountMoneyDigits);
    if (existingDigits === null || incomingDigits === null) {
      throw new CTraderSyncError(
        "CTRADER_OFFICIAL_DEAL_CONFLICT",
        `cTrader returned conflicting exact-money precision for immutable deal ${incoming.dealId}`,
        false,
      );
    }
    for (const field of ["grossProfit", "swap", "commission", "balance", "pnlConversionFee"] as const) {
      if (!sameScaledMoney(
        { value: existing.closePositionDetail[field], digits: existingDigits },
        { value: incoming.closePositionDetail[field], digits: incomingDigits },
      )) {
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
  const close = incoming.closePositionDetail ?? existing.closePositionDetail;
  const moneyDigits = close !== null && incoming.closePositionDetail === null
    ? existing.moneyDigits
    : optionalDealIdentity(incoming.dealId, "moneyDigits", existing.moneyDigits, incoming.moneyDigits);
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
    commission: close !== null && incoming.closePositionDetail === null
      ? existing.commission
      : optionalDealIdentity(incoming.dealId, "commission", existing.commission, incoming.commission),
    closePositionDetail: close,
    // Persist a canonical provider envelope containing retained exact fields so
    // every subsequent projection re-parses the same authoritative facts.
    raw: {
      ...existing.raw,
      ...incoming.raw,
      orderId: optionalDealIdentity(incoming.dealId, "order identity", existing.orderId, incoming.orderId) ?? undefined,
      moneyDigits: moneyDigits ?? undefined,
      commission: (close !== null && incoming.closePositionDetail === null
        ? existing.commission
        : optionalDealIdentity(incoming.dealId, "commission", existing.commission, incoming.commission))?.toString(),
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
): Promise<CTraderDeal[]> {
  if (!Number.isSafeInteger(fromTimestamp) || !Number.isSafeInteger(toTimestamp) || fromTimestamp < 0 || toTimestamp < fromTimestamp) {
    throw new CTraderSyncError("HISTORY_RANGE_INVALID", "The cTrader history range is invalid", false);
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
    if (requests > 100_000) {
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
        // Per-deal moneyDigits ranks above the trader/account fallback.
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

function cashFlowTimestampCompare(left: CTraderCashFlow, right: CTraderCashFlow): number {
  if (left.changeBalanceTimestamp !== right.changeBalanceTimestamp) {
    return left.changeBalanceTimestamp - right.changeBalanceTimestamp;
  }
  const leftId = BigInt(left.balanceHistoryId);
  const rightId = BigInt(right.balanceHistoryId);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

function sameCashFlow(left: CTraderCashFlow, right: CTraderCashFlow): boolean {
  return left.balanceHistoryId === right.balanceHistoryId
    && left.operationType === right.operationType
    && left.operationName === right.operationName
    && left.balance === right.balance
    && left.delta === right.delta
    && left.changeBalanceTimestamp === right.changeBalanceTimestamp
    && left.balanceVersion === right.balanceVersion
    && left.equity === right.equity
    && left.moneyDigits === right.moneyDigits;
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
}): { moneyDigits: number | null; source: CashFlowMoneyDigitsSource } {
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
  // A row-specific exponent is stronger than the account fallback. Preserve it
  // if an overlapping response later omits the optional row field.
  if (input.stored?.source === "cash_flow" && input.stored.moneyDigits !== null) {
    return { moneyDigits: input.stored.moneyDigits, source: "cash_flow" };
  }
  if (input.stored?.source === "account" && input.stored.moneyDigits !== null) {
    if (input.accountMoneyDigits !== null
      && input.accountMoneyDigits !== input.stored.moneyDigits) {
      throw new CTraderSyncError(
        "CASH_FLOW_ACCOUNT_MONEY_DIGITS_CONFLICT",
        "cTrader changed the account moneyDigits used to scale an immutable account cash flow",
        false,
      );
    }
    return { moneyDigits: input.stored.moneyDigits, source: "account" };
  }
  if (input.accountMoneyDigits !== null) {
    return { moneyDigits: input.accountMoneyDigits, source: "account" };
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
      if (prior && !sameCashFlow(prior, cashFlow)) {
        throw new CTraderSyncError(
          "CASH_FLOW_ID_CONFLICT",
          "cTrader returned conflicting values for an immutable account cash-flow identity",
          false,
        );
      }
      cashFlows.set(cashFlow.balanceHistoryId, cashFlow);
    }
    if (to === toTimestamp) break;
    // Boundaries are inclusive, so the next window begins one millisecond
    // later. The immutable ID still protects against provider overlap.
    from = to + 1;
  }
  return [...cashFlows.values()].sort(cashFlowTimestampCompare);
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
      const fetchedDeals = await fetchCompleteDealHistory(
        session,
        fromTimestamp,
        toTimestamp,
        this.config.cTrader.maxDealsPerRequest,
        heartbeat,
        trader.moneyDigits,
      );
      const cashFlowHistoryComplete = cursorBefore.cashFlowHistoryComplete === true;
      const cashFlowSyncedThrough = safeTimestamp(cursorBefore.cashFlowSyncedThroughTimestamp);
      // Spotware explicitly defines registrationTimestamp as the minimum
      // boundary for historical requests. The optional deal override may ask
      // for older executions, but it must not make cash-flow boundaries
      // invalid.
      const cashFlowAuthoritativeStart = trader.registrationTimestamp;
      const cashFlowFromTimestamp = cashFlowHistoryComplete && cashFlowSyncedThrough !== null
        ? Math.max(cashFlowAuthoritativeStart, cashFlowSyncedThrough - this.config.cTrader.syncOverlapSeconds * 1_000)
        : cashFlowAuthoritativeStart;
      const fetchedCashFlows = await fetchCompleteCashFlowHistory(
        session,
        cashFlowFromTimestamp,
        toTimestamp,
        heartbeat,
      );

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
        registrationTimestamp: trader.registrationTimestamp,
        syncedThroughTimestamp: toTimestamp,
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
    registrationTimestamp: number;
    syncedThroughTimestamp: number;
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
        const money = executionMoney(deal, input.trader.moneyDigits);
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

      await this.upsertSymbolSpecs(client, input);
      const positionIds = [...new Set(input.fetchedDeals.map((deal) => deal.positionId))];
      if (positionIds.length > 0) {
        const stored = await client.query<StoredExecutionRow>(
          `SELECT external_position_id, raw_payload
           FROM trade_executions
           WHERE broker_connection_id=$1
             AND external_position_id=ANY($2::text[])
           ORDER BY executed_at ASC, external_execution_id::numeric ASC`,
          [input.connection.id, positionIds],
        );
        const grouped = new Map<string, CTraderDeal[]>();
        for (const row of stored.rows) {
          const parsed = parseDeals({ deal: [row.raw_payload], hasMore: false }).deals[0];
          if (!parsed) continue;
          const group = grouped.get(row.external_position_id) ?? [];
          group.push(parsed);
          grouped.set(row.external_position_id, group);
        }
        const lightById = new Map(input.lightSymbols.map((symbol) => [symbol.symbolId, symbol]));
        const specById = new Map(input.symbolSpecs.map((spec) => [spec.symbolId, spec]));
        const categories = new Map(input.categories.map((category) => [category.id, category]));
        const classes = new Map(input.assetClasses.map((assetClass) => [assetClass.id, assetClass]));
        for (const positionId of positionIds) {
          const deals = grouped.get(positionId);
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
          await this.upsertProjection(client, input, projection, counters);
          counters.positionsProjected += 1;
        }
      }

      const cursorAfter = {
        version: 1,
        fullHistoryComplete: true,
        registrationTimestamp: input.registrationTimestamp,
        syncedThroughTimestamp: input.syncedThroughTimestamp,
        cashFlowHistoryComplete: true,
        cashFlowSyncedThroughTimestamp: input.syncedThroughTimestamp,
        lastCashFlowTimestamp: input.fetchedCashFlows.at(-1)?.changeBalanceTimestamp
          ?? safeTimestamp(input.cursorBefore.lastCashFlowTimestamp),
        lastCashFlowId: input.fetchedCashFlows.at(-1)?.balanceHistoryId
          ?? (typeof input.cursorBefore.lastCashFlowId === "string" ? input.cursorBefore.lastCashFlowId : null),
        lastDealTimestamp: input.fetchedDeals.at(-1)?.executionTimestamp
          ?? safeTimestamp(input.cursorBefore.lastDealTimestamp),
        lastDealId: input.fetchedDeals.at(-1)?.dealId
          ?? (typeof input.cursorBefore.lastDealId === "string" ? input.cursorBefore.lastDealId : null),
      };
      const metadata = {
        registrationTimestamp: input.registrationTimestamp,
        depositAssetId: input.trader.depositAssetId,
        accountCurrency,
        accountMoneyDigits: input.trader.moneyDigits,
        accountCashFlowHistoryComplete: true,
        accountCashFlowPositionAttribution: "not_provided_by_ctrader",
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

  private async upsertProjection(
    client: PoolClient,
    input: {
      connection: SyncConnectionRow;
      trader: CTraderTraderMetadata;
      assets: CTraderAsset[];
    },
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
    const providerBrokerData = {
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
      grossProfit: projection.grossProfit,
      commission: projection.commission,
      swap: projection.swap,
      pnlConversionFee: projection.pnlConversionFee,
      realizedEvents: projection.realizedEvents,
      pnlMethod: projection.realizedPnlComplete
        ? "provider_close_detail_money_digits"
        : projection.realizedEvents.length > 0 ? "partial_provider_close_detail_unavailable" : "not_realized",
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
