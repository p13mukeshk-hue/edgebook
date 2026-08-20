import { createHash, randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/database.js";
import { withTransaction } from "../db/database.js";
import type { EventBus } from "../events/event-bus.js";
import { connectionTokenAad, type TokenCipher } from "./crypto.js";
import {
  calculateCTraderGrossFallback,
  CTraderCalculatedGrossError,
} from "./calculated-gross.js";
import { CTraderMcpError, CTraderMcpReadClient } from "./mcp.js";
import {
  CTraderSyncError,
  lockAndValidateMappedAccountCurrency,
  type CTraderSyncCounters,
  type CTraderSyncResult,
} from "./sync.js";

const MAX_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_HISTORICAL_PREVIEW_SPLIT_DEPTH = 16;
const MAX_HISTORICAL_PREVIEW_REQUESTS = 128;
const MAX_HISTORICAL_PREVIEW_DEALS = 5_000;
const MAX_HISTORICAL_PREVIEW_POSITIONS = 250;
const MAX_HISTORICAL_MANUAL_CANDIDATES = 1_000;
const MAX_HISTORICAL_PREVIEW_ELAPSED_MS = 10 * 60 * 1_000;
const MAX_MCP_PNL_REFRESH_POSITIONS = 50;

type JsonRecord = Record<string, unknown>;

const ACCOUNT_ID_KEYS = [
  "accountId",
  "account_id",
  "ctidTraderAccountId",
  "ctidTradingAccountId",
  "traderAccountId",
] as const;

const ACCOUNT_METADATA_WRAPPER_KEYS = ["account", "balance", "data", "result"] as const;
const POSITION_DETAIL_ACCOUNT_METADATA_WRAPPER_KEYS = [
  ...ACCOUNT_METADATA_WRAPPER_KEYS,
  "position",
  "positionDetail",
  "positionDetails",
  "position_detail",
  "position_details",
  "deals",
  "orders",
] as const;
const MAX_ACCOUNT_METADATA_ARRAY_ENTRIES = MAX_HISTORICAL_PREVIEW_DEALS;
const MAX_ACCOUNT_METADATA_OBJECTS = MAX_HISTORICAL_PREVIEW_DEALS + 32;

const ACCOUNTLESS_HISTORY_ATTESTATION_KEY = "accountlessHistoryAttributionAttestation";
const ACCOUNTLESS_HISTORY_ATTESTATION_PURPOSE = "accountless_remote_mcp_history_attribution";
const ACCOUNTLESS_HISTORY_ATTESTATION_SOURCE = "operator_verified_per_account_remote_mcp_token";

// This value is intentionally writable only as operator-managed connection
// metadata. There is no public API that can mint or alter an override: the
// contract size is a financial identity attribute and must be backed by an
// account-specific cTrader Symbol info observation.
const VERIFIED_SYMBOL_OVERRIDES_KEY = "verifiedAccountSymbolOverrides";
const VERIFIED_SYMBOL_OVERRIDE_PURPOSE = "operator_verified_ctrader_symbol_specification";
const VERIFIED_SYMBOL_OVERRIDE_SOURCE = "verified_account_symbol_override";
const PROVIDER_BASE_UNITS_PER_LOT_SCALE = "base_units_per_lot_v1";
const MAX_VERIFIED_SYMBOL_OVERRIDES = 100;

type AccountlessHistoryAttributionAttestation = {
  version: 1;
  purpose: typeof ACCOUNTLESS_HISTORY_ATTESTATION_PURPOSE;
  source: typeof ACCOUNTLESS_HISTORY_ATTESTATION_SOURCE;
  userId: string;
  connectionId: string;
  externalAccountId: string;
  environment: "live" | "demo";
  tokenGeneration: string;
  acknowledgedAt: string;
  fingerprint: string;
};

type VerifiedAccountSymbolOverride = {
  version: 1;
  purpose: typeof VERIFIED_SYMBOL_OVERRIDE_PURPOSE;
  source: typeof VERIFIED_SYMBOL_OVERRIDE_SOURCE;
  userId: string;
  connectionId: string;
  externalAccountId: string;
  environment: "live" | "demo";
  tokenGeneration: string;
  symbolId: string;
  symbolName: string;
  baseUnitsPerLot: number;
  measurementUnit: string;
  verifiedAt: string;
};

type VerifiedAccountSymbolOverrideSnapshot = {
  fingerprint: string;
  overrides: ReadonlyMap<string, VerifiedAccountSymbolOverride>;
};

const MCP_VOLUME_ALIASES = [
  { key: "filledVolumeCents", scale: "unit_cents" },
  { key: "filledVolume", scale: "unit_cents" },
  { key: "filled_volume", scale: "unknown" },
  { key: "volume", scale: "unknown" },
  { key: "quantity", scale: "unknown" },
] as const;

type McpVolumeSourceKey = (typeof MCP_VOLUME_ALIASES)[number]["key"];
type McpVolumeScale = (typeof MCP_VOLUME_ALIASES)[number]["scale"];
type McpDealOrigin = "provider" | "stored";

type HistoricalFetchBudget = {
  deadline: number;
  requestCount: number;
  processedDeals: number;
};

type McpConnectionRow = QueryResultRow & {
  id: string;
  user_id: string;
  external_account_id: string;
  provider_environment: "live" | "demo";
  connected: boolean;
  access_token_ciphertext: string | null;
  encryption_key_version: number | null;
  token_generation: string | number;
  sync_cursor: unknown;
  provider_metadata: unknown;
  mapped_account_id: string | null;
  legacy_mapped_account_id: string | null;
};

type LockedMcpConnectionAttestationRow = QueryResultRow & {
  connection_id: string;
  connection_user_id: string;
  external_account_id: string;
  provider_environment: "live" | "demo";
  connected: boolean;
  token_generation: string | number;
  provider_metadata: unknown;
  mapped_account_id: string | null;
  legacy_mapped_account_id: string | null;
};

type ExistingTradeRow = QueryResultRow & {
  id: string;
  deleted_at: Date | string | null;
};

type StoredExecutionRow = QueryResultRow & {
  external_position_id: string;
  raw_payload: unknown;
};

type HistoricalImportRow = QueryResultRow & {
  id: string;
  user_id: string;
  broker_connection_id: string;
  external_account_id: string;
  provider_environment: "live" | "demo";
  boundary_at: Date | string;
  through_at: Date | string;
  normal_history_floor_at_request: Date | string;
  normal_history_floor_kind_at_request: string;
  boundary_local: string;
  time_zone: string;
  no_open_positions_attested: boolean;
  attestation_version: number;
  attestation_purpose: string;
  status: "queued" | "running" | "review" | "completed" | "failed" | "cancelled";
  counters: unknown;
};

type HistoricalManualTradeRow = QueryResultRow & {
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
};

type LiveManualTradeRow = HistoricalManualTradeRow & {
  strategy: string | null;
  emotion: string | null;
  notes: string | null;
  tags: unknown;
  psychology: unknown;
  custom_fields: unknown;
  screenshot_count: number | string;
};

type LiveReconciliationMatch = {
  classification: "high_confidence" | "ambiguous" | "deleted_manual" | "unmatched";
  confidence: number;
  manualTradeId: string | null;
  manualRowVersion: number | null;
  reasons: string[];
  differences: JsonRecord;
  choices: LiveManualTradeRow[];
};

type McpSymbol = {
  id: string;
  name: string;
  baseAssetId: string | null;
  quoteAssetId: string | null;
  category: string | null;
  lotSize: number | null;
  lotSizeSource: "provider" | "unavailable" | typeof VERIFIED_SYMBOL_OVERRIDE_SOURCE;
  providerLotSizeScale: typeof PROVIDER_BASE_UNITS_PER_LOT_SCALE | null;
  verifiedOverride: VerifiedAccountSymbolOverride | null;
  raw: JsonRecord;
};

export type McpCurrencyContext = {
  accountCurrency: string | null;
  depositAssetId: string | null;
  accountMoneyDigits: number | null;
  assetNames: ReadonlyMap<string, string>;
};

type McpPnlEnrichmentTelemetry = {
  version: 1;
  requestedPositions: number;
  attemptedPositions: number;
  successfulResponses: number;
  positionDetailsAvailable: boolean | null;
  authoritativePositions: number;
  unresolvedPositions: number;
};

type McpProviderReadTelemetry = {
  version: 1;
  assetsAvailable: boolean;
  assetCount: number;
  currencyResolved: boolean;
  pnlEnrichment: McpPnlEnrichmentTelemetry;
};

type McpDeal = {
  dealId: string;
  positionId: string;
  orderId: string | null;
  symbolId: string;
  symbolName: string | null;
  accountId: string | null;
  side: "BUY" | "SELL";
  role: "OPEN" | "CLOSE" | null;
  filledVolumeCents: bigint;
  filledVolumeSourceKey: McpVolumeSourceKey | null;
  filledVolumeScale: McpVolumeScale;
  executionPrice: number;
  executionTimestamp: number;
  dealStatus: number | null;
  providerUpdatedTimestamp: number | null;
  pnlCents: number | null;
  commissionCents: number | null;
  swapCents: number | null;
  /** Unversioned Remote MCP integer observations. These are estimate inputs only. */
  remoteCommissionRawUnits: bigint | null;
  remoteSwapRawUnits: bigint | null;
  grossProfitScaled: bigint | null;
  commissionScaled: bigint | null;
  swapScaled: bigint | null;
  pnlConversionFeeScaled: bigint | null;
  moneyDigits: number | null;
  raw: JsonRecord;
};

type McpProjection = {
  positionId: string;
  symbolId: string;
  symbol: string;
  asset: "eq" | "cx" | "fx" | "cm" | "ix" | null;
  direction: "Long" | "Short";
  entryPrice: string;
  exitPrice: string | null;
  /** Canonical stored quantity. Its unit is always declared in brokerData.quantityProjection. */
  quantity: string;
  quantityUnit: "lots" | "base_units";
  quantityLots: string | null;
  quantityBaseUnits: string;
  pnl: string | null;
  isOpen: boolean;
  tradeDate: string;
  entryAt: string;
  exitAt: string | null;
  entryTime: string;
  exitTime: string | null;
  brokerData: JsonRecord;
};

export type CTraderHistoricalPreviewCounters = CTraderSyncCounters & {
  positionsStaged: number;
  highConfidence: number;
  ambiguous: number;
  deletedManual: number;
  unmatched: number;
  executionOnly: number;
  providerReadTelemetry: McpProviderReadTelemetry;
};

export interface CTraderMcpReadClientLike {
  getAccountInfo(): Promise<unknown>;
  getBalance(): Promise<unknown>;
  getAssets?(): Promise<unknown>;
  getSymbols(): Promise<unknown>;
  getDeals(request: { fromTimestamp: string; toTimestamp: string }): Promise<unknown>;
  getPositionDetails?(positionId: string): Promise<unknown>;
  close(): Promise<void>;
}

export type CTraderMcpReadClientFactory = (bearerToken: string) => CTraderMcpReadClientLike;

function objectValue(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function json(value: unknown): string {
  return JSON.stringify(value, (_key, candidate: unknown) =>
    typeof candidate === "bigint" ? candidate.toString() : candidate);
}

function firstValue(object: JsonRecord, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) return object[key];
  }
  return null;
}

function textValue(value: unknown, field: string, required: true): string;
function textValue(value: unknown, field: string, required?: false): string | null;
function textValue(value: unknown, field: string, required = false): string | null {
  if (value === null || value === undefined || value === "") {
    if (required) throw new CTraderSyncError("CTRADER_MCP_DEAL_INVALID", `cTrader deal is missing ${field}`, false);
    return null;
  }
  const text = String(value).trim();
  if (text.length === 0 || text.length > 200 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new CTraderSyncError("CTRADER_MCP_DEAL_INVALID", `cTrader returned an invalid ${field}`, false);
  }
  return text;
}

function finiteNumber(value: unknown, field: string, positive = false): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER || (positive && number <= 0)) {
    throw new CTraderSyncError("CTRADER_MCP_DEAL_INVALID", `cTrader returned an invalid ${field}`, false);
  }
  return number;
}

function positiveInteger(value: unknown, field: string): bigint {
  let parsed: bigint;
  try {
    if (typeof value === "bigint") parsed = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === "string" && /^\d+$/.test(value.trim())) parsed = BigInt(value.trim());
    else throw new Error("invalid");
  } catch {
    throw new CTraderSyncError("CTRADER_MCP_DEAL_INVALID", `cTrader returned an invalid ${field}`, false);
  }
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CTraderSyncError("CTRADER_MCP_DEAL_INVALID", `cTrader returned an invalid ${field}`, false);
  }
  return parsed;
}

function zeroIntegerLike(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return false;
  if (typeof value === "bigint") return value === 0n;
  if (typeof value === "number") return Number.isSafeInteger(value) && value === 0;
  if (typeof value === "string") return /^0+$/.test(value.trim());
  return false;
}

function isExplicitNonFilledZeroVolumeDeal(value: unknown): boolean {
  const raw = objectValue(value);
  const status = firstValue(raw, ["dealStatus", "deal_status", "status"]);
  if (status === null) return false;
  const normalizedStatus = String(status).trim().toUpperCase();
  if (normalizedStatus === "" || normalizedStatus === "FILLED" || normalizedStatus === "2") return false;
  return zeroIntegerLike(firstValue(raw, ["filledVolumeCents", "filledVolume", "filled_volume"]));
}

function normalizedVolume(
  raw: JsonRecord,
  storedCanonical: boolean,
): {
  value: bigint;
  sourceKey: McpVolumeSourceKey | null;
  scale: McpVolumeScale;
} {
  const present = MCP_VOLUME_ALIASES.flatMap(({ key, scale }) => {
    const value = raw[key];
    return value === undefined || value === null
      ? []
      : [{ key, scale, value: positiveInteger(value, "filledVolume") }];
  });
  const accepted = present[0];
  if (!accepted) {
    throw new CTraderSyncError(
      "CTRADER_MCP_DEAL_INVALID",
      "cTrader deal is missing filledVolume",
      false,
    );
  }
  if (present.some((candidate) => candidate.value !== accepted.value)) {
    throw new CTraderSyncError(
      "CTRADER_MCP_DEAL_INVALID",
      "cTrader returned conflicting filledVolume aliases",
      false,
    );
  }

  if (!storedCanonical) {
    return { value: accepted.value, sourceKey: accepted.key, scale: accepted.scale };
  }

  const storedSource = raw.filledVolumeSourceKey;
  const storedScale = raw.filledVolumeScale;
  if (storedSource === undefined && storedScale === undefined) {
    // Executions written before provenance was captured cannot safely be
    // attributed to the canonical field name used by Edgebook storage.
    return { value: accepted.value, sourceKey: null, scale: "unknown" };
  }
  if (storedSource === null && storedScale === "unknown") {
    return { value: accepted.value, sourceKey: null, scale: "unknown" };
  }
  if (typeof storedSource !== "string" || typeof storedScale !== "string") {
    throw new CTraderSyncError(
      "CTRADER_MCP_DEAL_INVALID",
      "Stored cTrader deal has invalid filledVolume provenance",
      false,
    );
  }
  const source = MCP_VOLUME_ALIASES.find(({ key }) => key === storedSource);
  if (!source || source.scale !== storedScale) {
    throw new CTraderSyncError(
      "CTRADER_MCP_DEAL_INVALID",
      "Stored cTrader deal has invalid filledVolume provenance",
      false,
    );
  }
  return { value: accepted.value, sourceKey: source.key, scale: source.scale };
}

function timestamp(value: unknown, field: string): number {
  let parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value)
      : typeof value === "string"
        ? Date.parse(value)
        : Number.NaN;
  if (Number.isFinite(parsed) && parsed > 0 && parsed < 1_000_000_000_000) parsed *= 1_000;
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > Date.now() + 24 * 60 * 60 * 1_000) {
    throw new CTraderSyncError("CTRADER_MCP_DEAL_INVALID", `cTrader returned an invalid ${field}`, false);
  }
  return parsed;
}

function optionalTimestamp(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  try { return timestamp(value, "provider update timestamp"); } catch { return null; }
}

function optionalCents(object: JsonRecord, keys: readonly string[]): number | null {
  const value = firstValue(object, keys);
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function optionalSignedInteger(object: JsonRecord, keys: readonly string[], field: string): bigint | null {
  const value = firstValue(object, keys);
  if (value === null) return null;
  let parsed: bigint;
  try {
    if (typeof value === "bigint") parsed = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === "string" && /^-?\d+$/.test(value.trim())) parsed = BigInt(value.trim());
    else throw new Error("invalid");
  } catch {
    throw new CTraderSyncError("CTRADER_MCP_DEAL_INVALID", `cTrader returned an invalid ${field}`, false);
  }
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new CTraderSyncError("CTRADER_MCP_NUMERIC_OVERFLOW", `cTrader ${field} exceeds safe bounds`, false);
  }
  return parsed;
}

function optionalEstimatedSignedInteger(object: JsonRecord, keys: readonly string[]): bigint | null {
  const value = firstValue(object, keys);
  if (value === null) return null;
  try {
    const parsed = typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : typeof value === "string" && /^-?\d+$/.test(value.trim())
          ? BigInt(value.trim())
          : null;
    if (parsed === null || parsed > BigInt(Number.MAX_SAFE_INTEGER) || parsed < BigInt(Number.MIN_SAFE_INTEGER)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function optionalMoneyDigits(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 18) {
    throw new CTraderSyncError("CTRADER_MCP_DEAL_INVALID", "cTrader returned invalid moneyDigits", false);
  }
  return parsed;
}

function scaledMoneyToDecimal(value: bigint, digits: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  if (digits === 0) return `${negative ? "-" : ""}${absolute.toString()}`;
  const raw = absolute.toString().padStart(digits + 1, "0");
  const integer = raw.slice(0, -digits);
  const fraction = raw.slice(-digits).replace(/0+$/, "");
  const decimalValue = fraction.length === 0 ? integer : `${integer}.${fraction}`;
  return `${negative ? "-" : ""}${decimalValue}`;
}

function decimalMoneyToScaled(value: string, digits: number): bigint | null {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/.exec(value);
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (fraction.length > digits) return null;
  const raw = BigInt(`${match[2]}${fraction.padEnd(digits, "0")}`);
  return match[1] === "-" ? -raw : raw;
}

function accountHistoryMismatch(): CTraderSyncError {
  return new CTraderSyncError(
    "CTRADER_MCP_ACCOUNT_HISTORY_MISMATCH",
    "cTrader returned history for a different account",
    false,
    true,
  );
}

function accountIds(objects: readonly JsonRecord[]): string[] {
  const values: string[] = [];
  for (const object of objects) {
    for (const key of ACCOUNT_ID_KEYS) {
      const value = object[key];
      if (value === null || value === undefined || value === "") continue;
      const normalized = textValue(value, "accountId");
      if (normalized !== null) values.push(normalized);
    }
  }
  return values;
}

function side(value: unknown): "BUY" | "SELL" {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : value;
  if (normalized === "BUY" || normalized === 1 || normalized === "1") return "BUY";
  if (normalized === "SELL" || normalized === 2 || normalized === "2") return "SELL";
  throw new CTraderSyncError("CTRADER_MCP_DEAL_INVALID", "cTrader returned an invalid trade side", false);
}

function canonicalStoredDeal(deal: McpDeal): JsonRecord {
  return {
    version: 1,
    dealId: deal.dealId,
    positionId: deal.positionId,
    orderId: deal.orderId,
    symbolId: deal.symbolId,
    symbolName: deal.symbolName,
    accountId: deal.accountId,
    side: deal.side,
    role: deal.role,
    filledVolumeCents: deal.filledVolumeCents.toString(),
    filledVolumeSourceKey: deal.filledVolumeSourceKey,
    filledVolumeScale: deal.filledVolumeScale,
    executionPrice: deal.executionPrice,
    executionTimestamp: deal.executionTimestamp,
    dealStatus: deal.dealStatus,
    providerUpdatedTimestamp: deal.providerUpdatedTimestamp,
    // Exact monetary values are accepted only when the provider names their
    // semantics and scale. Generic observations are retained separately and
    // may only feed visibly estimated fees/net; they never become trade.pnl.
    netPnlCents: deal.pnlCents,
    commissionCents: deal.commissionCents,
    swapCents: deal.swapCents,
    remoteCommissionRawUnits: deal.remoteCommissionRawUnits?.toString() ?? null,
    remoteSwapRawUnits: deal.remoteSwapRawUnits?.toString() ?? null,
    ...(deal.moneyDigits === null ? {} : {
      closePositionDetail: {
        grossProfit: deal.grossProfitScaled?.toString() ?? null,
        commission: deal.commissionScaled?.toString() ?? null,
        swap: deal.swapScaled?.toString() ?? null,
        pnlConversionFee: deal.pnlConversionFeeScaled?.toString() ?? null,
        moneyDigits: deal.moneyDigits,
      },
    }),
  };
}

type McpMoneyRank = 0 | 1 | 2;

function dealMoneyRank(deal: McpDeal): McpMoneyRank {
  if (
    deal.moneyDigits !== null
    && deal.grossProfitScaled !== null
    && deal.commissionScaled !== null
    && deal.swapScaled !== null
    && deal.pnlConversionFeeScaled !== null
  ) return 2;
  return deal.pnlCents === null ? 0 : 1;
}

function scaledMoneyEqual(
  left: { value: bigint; digits: number },
  right: { value: bigint; digits: number },
): boolean {
  const digits = Math.max(left.digits, right.digits);
  return left.value * (10n ** BigInt(digits - left.digits))
    === right.value * (10n ** BigInt(digits - right.digits));
}

function exactNet(deal: McpDeal): { value: bigint; digits: number } | null {
  if (dealMoneyRank(deal) === 2) {
    return {
      value: (deal.grossProfitScaled ?? 0n) + (deal.swapScaled ?? 0n)
        + (deal.commissionScaled ?? 0n) - (deal.pnlConversionFeeScaled ?? 0n),
      digits: deal.moneyDigits ?? 0,
    };
  }
  return deal.pnlCents === null ? null : { value: BigInt(deal.pnlCents), digits: 2 };
}

function exactComponent(
  deal: McpDeal,
  field: "grossProfit" | "commission" | "swap" | "pnlConversionFee",
): { value: bigint; digits: number } | null {
  if (dealMoneyRank(deal) === 2) {
    const value = field === "grossProfit"
      ? deal.grossProfitScaled
      : field === "commission"
        ? deal.commissionScaled
        : field === "swap"
          ? deal.swapScaled
          : deal.pnlConversionFeeScaled;
    return value === null ? null : { value, digits: deal.moneyDigits ?? 0 };
  }
  if (field === "commission" && deal.commissionCents !== null) {
    return { value: BigInt(deal.commissionCents), digits: 2 };
  }
  if (field === "swap" && deal.swapCents !== null) {
    return { value: BigInt(deal.swapCents), digits: 2 };
  }
  return null;
}

function dealConflict(dealId: string, detail: string): CTraderSyncError {
  return new CTraderSyncError(
    "CTRADER_MCP_DUPLICATE_DEAL_CONFLICT",
    `cTrader returned conflicting ${detail} for deal ${dealId}`,
    false,
  );
}

/**
 * Joins two observations of one provider execution without allowing a weaker
 * Remote MCP response to erase authoritative facts. Monetary authority is
 * closePositionDetail > explicit net cents > absent. Any overlapping exact
 * facts must agree even when the higher-ranked representation is available.
 */
function mergeDealFacts(existing: McpDeal, incoming: McpDeal): McpDeal {
  if (existing.dealId !== incoming.dealId) throw dealConflict(incoming.dealId, "execution identities");
  const requiredIdentity = [
    "positionId", "symbolId", "side", "filledVolumeCents",
    "filledVolumeSourceKey", "filledVolumeScale", "executionPrice", "executionTimestamp",
  ] as const;
  if (requiredIdentity.some((key) => String(existing[key]) !== String(incoming[key]))) {
    throw dealConflict(incoming.dealId, "stable execution data");
  }
  const mergeOptionalIdentity = <T>(left: T | null, right: T | null, field: string): T | null => {
    if (left !== null && right !== null && String(left) !== String(right)) {
      throw dealConflict(incoming.dealId, field);
    }
    return right ?? left;
  };
  const accountId = mergeOptionalIdentity(existing.accountId, incoming.accountId, "account attribution");
  const orderId = mergeOptionalIdentity(existing.orderId, incoming.orderId, "order identity");
  const role = mergeOptionalIdentity(existing.role, incoming.role, "execution role");
  const dealStatus = mergeOptionalIdentity(existing.dealStatus, incoming.dealStatus, "deal status");
  let symbolName: string | null = incoming.symbolName ?? existing.symbolName;
  if (
    existing.symbolName !== null
    && incoming.symbolName !== null
    && normalizedSymbolName(existing.symbolName) !== normalizedSymbolName(incoming.symbolName)
  ) throw dealConflict(incoming.dealId, "symbol identity");

  const existingNet = exactNet(existing);
  const incomingNet = exactNet(incoming);
  if (existingNet !== null && incomingNet !== null && !scaledMoneyEqual(existingNet, incomingNet)) {
    throw dealConflict(incoming.dealId, "realized P&L representations");
  }
  for (const field of ["grossProfit", "commission", "swap", "pnlConversionFee"] as const) {
    const left = exactComponent(existing, field);
    const right = exactComponent(incoming, field);
    if (left !== null && right !== null && !scaledMoneyEqual(left, right)) {
      throw dealConflict(incoming.dealId, `${field} representations`);
    }
  }

  const existingRank = dealMoneyRank(existing);
  const incomingRank = dealMoneyRank(incoming);
  const authoritativeDetail = incomingRank === 2
    ? incoming
    : existingRank === 2
      ? existing
      : null;
  const mergeOptionalCents = (left: number | null, right: number | null, field: string): number | null => {
    if (left !== null && right !== null && left !== right) throw dealConflict(incoming.dealId, field);
    return right ?? left;
  };
  symbolName = symbolName ?? null;
  return {
    ...existing,
    ...incoming,
    orderId,
    symbolName,
    accountId,
    role,
    dealStatus,
    providerUpdatedTimestamp: existing.providerUpdatedTimestamp === null
      ? incoming.providerUpdatedTimestamp
      : incoming.providerUpdatedTimestamp === null
        ? existing.providerUpdatedTimestamp
        : Math.max(existing.providerUpdatedTimestamp, incoming.providerUpdatedTimestamp),
    pnlCents: mergeOptionalCents(existing.pnlCents, incoming.pnlCents, "explicit realized P&L"),
    commissionCents: mergeOptionalCents(existing.commissionCents, incoming.commissionCents, "explicit commission"),
    swapCents: mergeOptionalCents(existing.swapCents, incoming.swapCents, "explicit swap"),
    remoteCommissionRawUnits: incoming.remoteCommissionRawUnits ?? existing.remoteCommissionRawUnits,
    remoteSwapRawUnits: incoming.remoteSwapRawUnits ?? existing.remoteSwapRawUnits,
    grossProfitScaled: authoritativeDetail?.grossProfitScaled ?? null,
    commissionScaled: authoritativeDetail?.commissionScaled ?? null,
    swapScaled: authoritativeDetail?.swapScaled ?? null,
    pnlConversionFeeScaled: authoritativeDetail?.pnlConversionFeeScaled ?? null,
    moneyDigits: authoritativeDetail?.moneyDigits ?? null,
  };
}

function positionsMissingAuthoritativePnl(deals: readonly McpDeal[]): string[] {
  const grouped = new Map<string, McpDeal[]>();
  for (const deal of deals) grouped.set(deal.positionId, [...(grouped.get(deal.positionId) ?? []), deal]);
  return [...grouped].flatMap(([positionId, positionDeals]) => {
    const potentiallyClosed = positionDeals.some((deal) => deal.role === "CLOSE")
      || new Set(positionDeals.map((deal) => deal.side)).size > 1;
    const ordered = [...positionDeals].sort((left, right) =>
      left.executionTimestamp - right.executionTimestamp || compareDealIds(left.dealId, right.dealId));
    const openingSide = ordered.find((deal) => deal.role === "OPEN")?.side ?? ordered[0]?.side;
    const closing = openingSide === undefined ? [] : ordered.filter((deal) =>
      deal.role === "CLOSE" || (deal.role === null && deal.side !== openingSide));
    const hasAuthoritativeMoney = (deal: McpDeal): boolean => deal.pnlCents !== null || (
      deal.moneyDigits !== null
      && deal.grossProfitScaled !== null
      && deal.commissionScaled !== null
      && deal.swapScaled !== null
      && deal.pnlConversionFeeScaled !== null
    );
    const lacksAuthoritativePnl = closing.length === 0 || closing.some((deal) => !hasAuthoritativeMoney(deal));
    return potentiallyClosed && lacksAuthoritativePnl ? [positionId] : [];
  });
}

function normalizeDeal(value: unknown, origin: McpDealOrigin): McpDeal {
  const envelope = objectValue(value);
  const hasCanonicalEnvelope = Object.prototype.hasOwnProperty.call(envelope, "edgebookMcpDeal");
  const hasInternalProvenance = Object.prototype.hasOwnProperty.call(envelope, "filledVolumeSourceKey")
    || Object.prototype.hasOwnProperty.call(envelope, "filledVolumeScale");
  if (origin === "provider" && (hasCanonicalEnvelope || hasInternalProvenance)) {
    throw new CTraderSyncError(
      "CTRADER_MCP_DEAL_INVALID",
      "cTrader returned reserved internal deal provenance",
      false,
    );
  }
  const canonical = origin === "stored" ? objectValue(envelope.edgebookMcpDeal) : {};
  if (origin === "stored" && (!hasCanonicalEnvelope || Object.keys(canonical).length === 0)) {
    throw new CTraderSyncError(
      "CTRADER_MCP_DEAL_INVALID",
      "Stored cTrader deal is missing its canonical envelope",
      false,
    );
  }
  const raw = origin === "stored" ? canonical : envelope;
  const dealId = textValue(firstValue(raw, ["dealId", "deal_id", "id"]), "dealId", true);
  const positionId = textValue(firstValue(raw, ["positionId", "position_id"]), "positionId", true);
  const symbolId = textValue(firstValue(raw, ["symbolId", "symbol_id"]), "symbolId", true);
  const tradeSide = side(firstValue(raw, ["side", "tradeSide", "trade_side"]));
  const roleText = String(firstValue(raw, ["role", "dealType", "deal_type", "executionType"]) ?? "")
    .trim()
    .toUpperCase();
  const closeDetailPresent = Object.prototype.hasOwnProperty.call(raw, "closePositionDetail")
    || Object.prototype.hasOwnProperty.call(raw, "close_position_detail");
  const closeDetail = firstValue(raw, ["closePositionDetail", "close_position_detail"]);
  const closeDetailObject = closeDetail === null ? null : objectValue(closeDetail);
  const normalizedFilledVolume = normalizedVolume(raw, origin === "stored");
  const executionPrice = finiteNumber(
    firstValue(raw, ["executionPrice", "execution_price", "price", "dealPrice", "filledPrice"]),
    "executionPrice",
    true,
  );
  const executionTimestamp = timestamp(
    firstValue(raw, ["executionTimestamp", "execution_timestamp", "executedAt", "executed_at", "timestamp"]),
    "executionTimestamp",
  );
  const statusValue = firstValue(raw, ["dealStatus", "deal_status", "status"]);
  const parsedStatus = statusValue === null ? null : Number(statusValue);
  const explicitAccountIds = accountIds(
    origin === "stored" ? [envelope, canonical] : [raw],
  );
  const accountId = explicitAccountIds[0] ?? null;
  if (explicitAccountIds.some((value) => value !== accountId)) {
    throw accountHistoryMismatch();
  }
  const pnlCents = optionalCents(raw, ["netPnlCents", "netProfitCents"]);
  const moneyDigits = closeDetailObject === null
    ? null
    : optionalMoneyDigits(firstValue(closeDetailObject, ["moneyDigits", "money_digits"]));
  const grossProfitScaled = closeDetailObject === null
    ? null
    : optionalSignedInteger(closeDetailObject, ["grossProfit", "gross_profit", "profit"], "grossProfit");
  const commissionScaled = closeDetailObject === null
    ? null
    : optionalSignedInteger(closeDetailObject, ["commission"], "commission");
  const swapScaled = closeDetailObject === null
    ? null
    : optionalSignedInteger(closeDetailObject, ["swap"], "swap");
  const pnlConversionFeeScaled = closeDetailObject === null
    ? null
    : optionalSignedInteger(closeDetailObject, ["pnlConversionFee", "pnl_conversion_fee"], "pnlConversionFee") ?? 0n;
  if (closeDetailObject !== null && (
    moneyDigits === null
    || grossProfitScaled === null
    || commissionScaled === null
    || swapScaled === null
  )) {
    throw new CTraderSyncError(
      "CTRADER_MCP_DEAL_INVALID",
      "cTrader returned an incomplete authoritative closePositionDetail",
      false,
    );
  }
  if (pnlCents !== null && moneyDigits !== null) {
    const authoritativeNet = (grossProfitScaled ?? 0n) + (swapScaled ?? 0n)
      + (commissionScaled ?? 0n) - (pnlConversionFeeScaled ?? 0n);
    const legacyScaled = BigInt(pnlCents) * (10n ** BigInt(Math.max(0, moneyDigits - 2)));
    const authoritativeScaled = authoritativeNet * (10n ** BigInt(Math.max(0, 2 - moneyDigits)));
    if (legacyScaled !== authoritativeScaled) {
      throw new CTraderSyncError(
        "CTRADER_MCP_DEAL_INVALID",
        "cTrader returned conflicting realized P&L representations",
        false,
      );
    }
  }
  const role: McpDeal["role"] = ["ENTRY", "OPEN", "OPENING"].includes(roleText)
    ? "OPEN"
    : ["EXIT", "CLOSE", "CLOSING"].includes(roleText)
      ? "CLOSE"
      // The canonical stored envelope always contains closePositionDetail,
      // including an explicit null. Its normalized role is authoritative;
      // re-inferring OPEN from that null would erase an intentionally unknown
      // role and bypass the attested history-boundary review path.
      : origin !== "stored" && closeDetailPresent
        ? closeDetail === null ? "OPEN" : "CLOSE"
        : null;
  return {
    dealId,
    positionId,
    orderId: textValue(firstValue(raw, ["orderId", "order_id"]), "orderId"),
    symbolId,
    symbolName: textValue(firstValue(raw, ["symbolName", "symbol_name", "symbol"]), "symbolName"),
    accountId,
    side: tradeSide,
    role,
    filledVolumeCents: normalizedFilledVolume.value,
    filledVolumeSourceKey: normalizedFilledVolume.sourceKey,
    filledVolumeScale: normalizedFilledVolume.scale,
    executionPrice,
    executionTimestamp,
    dealStatus: parsedStatus !== null && Number.isSafeInteger(parsedStatus) ? parsedStatus : null,
    providerUpdatedTimestamp: optionalTimestamp(firstValue(raw, [
      "providerUpdatedTimestamp", "utcLastUpdateTimestamp", "updatedAt", "updated_at",
    ])),
    pnlCents,
    commissionCents: optionalCents(raw, ["commissionCents"]),
    swapCents: optionalCents(raw, ["swapCents"]),
    remoteCommissionRawUnits: optionalEstimatedSignedInteger(
      raw,
      origin === "stored" ? ["remoteCommissionRawUnits"] : ["commission"],
    ),
    remoteSwapRawUnits: optionalEstimatedSignedInteger(
      raw,
      origin === "stored" ? ["remoteSwapRawUnits"] : ["swap"],
    ),
    grossProfitScaled,
    commissionScaled,
    swapScaled,
    pnlConversionFeeScaled,
    moneyDigits,
    raw: envelope,
  };
}

function unwrapArray(value: unknown, keys: readonly string[], label: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null) {
    throw new CTraderSyncError("CTRADER_MCP_RESULT_INVALID", `cTrader returned an invalid ${label} response`, false);
  }
  const object = objectValue(value);
  for (const key of keys) if (Array.isArray(object[key])) return object[key] as unknown[];
  throw new CTraderSyncError("CTRADER_MCP_RESULT_INVALID", `cTrader returned an invalid ${label} response`, false);
}

function assertCompleteHistoryPage(value: unknown): void {
  const object = objectValue(value);
  if (
    object.hasMore === true
    || object.has_more === true
    || object.nextCursor !== undefined
    || object.next_cursor !== undefined
    || object.cursor !== undefined
  ) {
    throw new CTraderSyncError(
      "CTRADER_MCP_HISTORY_PAGINATION_UNSUPPORTED",
      "cTrader returned paginated history that cannot be imported losslessly",
      false,
    );
  }
  if (object.total !== undefined && object.limit !== undefined) {
    const total = Number(object.total);
    const page = unwrapArray(value, ["deals", "data", "result", "items", "history"], "deal history");
    if (Number.isFinite(total) && total > page.length) {
      throw new CTraderSyncError(
        "CTRADER_MCP_HISTORY_PAGINATION_UNSUPPORTED",
        "cTrader returned truncated history that cannot be imported losslessly",
        false,
      );
    }
  }
}

function historyPageIsIncomplete(value: unknown): boolean {
  const object = objectValue(value);
  if (
    object.hasMore === true
    || object.has_more === true
    || object.nextCursor !== undefined
    || object.next_cursor !== undefined
    || object.cursor !== undefined
  ) return true;
  if (object.total !== undefined && object.limit !== undefined) {
    const total = Number(object.total);
    const page = unwrapArray(value, ["deals", "data", "result", "items", "history"], "deal history");
    return Number.isFinite(total) && total > page.length;
  }
  return false;
}

function normalizedSymbolName(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Deliberately narrow journal aliases. These are identity comparisons only;
// they never alter the provider symbol stored on a linked trade. GOLD is the
// established Edgebook journal name for cTrader XAUUSD. BTC/USD differs only
// by punctuation from cTrader BTCUSD.
function reconciliationSymbolName(value: string): string {
  const normalized = normalizedSymbolName(value);
  return normalized === "GOLD" ? "XAUUSD" : normalized;
}

function invalidVerifiedSymbolOverride(): CTraderSyncError {
  return new CTraderSyncError(
    "CTRADER_MCP_VERIFIED_SYMBOL_OVERRIDE_INVALID",
    "The operator-verified cTrader symbol specification is invalid or is not bound to this connection",
    false,
  );
}

function strictOverrideText(value: unknown, maxLength = 200): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > maxLength
    || value.trim() !== value
    || /[\u0000-\u001f\u007f]/.test(value)
  ) throw invalidVerifiedSymbolOverride();
  return value;
}

function verifiedAccountSymbolOverrides(
  connection: Pick<McpConnectionRow, "id" | "user_id" | "external_account_id" | "provider_environment" | "token_generation">,
  providerMetadata: JsonRecord,
): VerifiedAccountSymbolOverrideSnapshot {
  const nested = providerMetadata[VERIFIED_SYMBOL_OVERRIDES_KEY];
  if (nested === undefined) {
    return { fingerprint: json({ present: false }), overrides: new Map() };
  }
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    throw invalidVerifiedSymbolOverride();
  }
  const rawMap = objectValue(nested);
  const entries = Object.entries(rawMap).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > MAX_VERIFIED_SYMBOL_OVERRIDES) throw invalidVerifiedSymbolOverride();
  const overrides = new Map<string, VerifiedAccountSymbolOverride>();
  const expectedKeys = [
    "baseUnitsPerLot",
    "connectionId",
    "environment",
    "externalAccountId",
    "measurementUnit",
    "purpose",
    "source",
    "symbolId",
    "symbolName",
    "tokenGeneration",
    "userId",
    "verifiedAt",
    "version",
  ];
  for (const [mapSymbolId, value] of entries) {
    const symbolId = strictOverrideText(mapSymbolId);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw invalidVerifiedSymbolOverride();
    }
    const raw = objectValue(value);
    if (json(Object.keys(raw).sort()) !== json(expectedKeys)) throw invalidVerifiedSymbolOverride();
    const verifiedAt = raw.verifiedAt;
    const verifiedTimestamp = typeof verifiedAt === "string" ? Date.parse(verifiedAt) : Number.NaN;
    const baseUnitsPerLot = raw.baseUnitsPerLot;
    if (
      raw.version !== 1
      || raw.purpose !== VERIFIED_SYMBOL_OVERRIDE_PURPOSE
      || raw.source !== VERIFIED_SYMBOL_OVERRIDE_SOURCE
      || raw.userId !== connection.user_id
      || raw.connectionId !== connection.id
      || raw.externalAccountId !== connection.external_account_id
      || raw.environment !== connection.provider_environment
      || raw.tokenGeneration !== String(connection.token_generation)
      || raw.symbolId !== symbolId
      || !Number.isSafeInteger(baseUnitsPerLot)
      || Number(baseUnitsPerLot) <= 0
      || Number(baseUnitsPerLot) > Math.floor(Number.MAX_SAFE_INTEGER / 100)
      || typeof verifiedAt !== "string"
      || !Number.isSafeInteger(verifiedTimestamp)
      || verifiedTimestamp <= 0
      || verifiedTimestamp > Date.now() + 5 * 60 * 1_000
      || new Date(verifiedTimestamp).toISOString() !== verifiedAt
    ) throw invalidVerifiedSymbolOverride();
    const symbolName = strictOverrideText(raw.symbolName);
    const measurementUnit = strictOverrideText(raw.measurementUnit, 32);
    if (!/^[A-Za-z][A-Za-z0-9 ./%_-]{0,31}$/.test(measurementUnit)) {
      throw invalidVerifiedSymbolOverride();
    }
    overrides.set(symbolId, {
      version: 1,
      purpose: VERIFIED_SYMBOL_OVERRIDE_PURPOSE,
      source: VERIFIED_SYMBOL_OVERRIDE_SOURCE,
      userId: connection.user_id,
      connectionId: connection.id,
      externalAccountId: connection.external_account_id,
      environment: connection.provider_environment,
      tokenGeneration: String(connection.token_generation),
      symbolId,
      symbolName,
      baseUnitsPerLot: Number(baseUnitsPerLot),
      measurementUnit,
      verifiedAt,
    });
  }
  const canonical = [...overrides.entries()].map(([symbolId, override]) => ({ symbolId, override }));
  return {
    fingerprint: json({ present: true, overrides: canonical }),
    overrides,
  };
}

function applyVerifiedAccountSymbolOverrides(
  symbols: readonly McpSymbol[],
  snapshot: VerifiedAccountSymbolOverrideSnapshot,
): McpSymbol[] {
  const providerById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  for (const override of snapshot.overrides.values()) {
    const providerSymbol = providerById.get(override.symbolId);
    if (!providerSymbol || providerSymbol.name !== override.symbolName) {
      throw new CTraderSyncError(
        "CTRADER_MCP_VERIFIED_SYMBOL_OVERRIDE_SYMBOL_MISMATCH",
        `The operator-verified cTrader specification no longer matches symbol ${override.symbolId}`,
        false,
      );
    }
    if (
      providerSymbol.lotSize !== null
      && providerSymbol.providerLotSizeScale === PROVIDER_BASE_UNITS_PER_LOT_SCALE
      && providerSymbol.lotSize !== override.baseUnitsPerLot
    ) {
      throw new CTraderSyncError(
        "CTRADER_MCP_VERIFIED_SYMBOL_OVERRIDE_PROVIDER_CONFLICT",
        `cTrader now reports a different authoritative contract size for ${providerSymbol.name}`,
        false,
      );
    }
  }
  return symbols.map((symbol) => {
    const override = snapshot.overrides.get(symbol.id);
    if (
      !override
      || (
        symbol.lotSize !== null
        && symbol.providerLotSizeScale === PROVIDER_BASE_UNITS_PER_LOT_SCALE
      )
    ) return symbol;
    return {
      ...symbol,
      lotSize: override.baseUnitsPerLot,
      lotSizeSource: VERIFIED_SYMBOL_OVERRIDE_SOURCE,
      providerLotSizeScale: null,
      verifiedOverride: override,
    };
  });
}

function assertVerifiedAccountSymbolOverridesUnchanged(
  locked: LockedMcpConnectionAttestationRow,
  expected: VerifiedAccountSymbolOverrideSnapshot,
): void {
  let current: VerifiedAccountSymbolOverrideSnapshot | null;
  try {
    current = verifiedAccountSymbolOverrides({
      id: locked.connection_id,
      user_id: locked.connection_user_id,
      external_account_id: locked.external_account_id,
      provider_environment: locked.provider_environment,
      token_generation: locked.token_generation,
    }, objectValue(locked.provider_metadata));
  } catch {
    current = null;
  }
  if (current?.fingerprint !== expected.fingerprint) {
    throw new CTraderSyncError(
      "CTRADER_MCP_VERIFIED_SYMBOL_OVERRIDE_CHANGED",
      "The operator-verified cTrader symbol specification changed during sync",
      false,
    );
  }
}

function compareDealIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  return left.localeCompare(right);
}

function optionalStrictIntegerId(raw: JsonRecord, aliases: readonly string[], field: string): string | null {
  const values = aliases.flatMap((key) => raw[key] === undefined || raw[key] === null ? [] : [raw[key]]);
  if (values.length === 0) return null;
  const normalized = values.map((value) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) {
      const number = Number(value.trim());
      if (Number.isSafeInteger(number)) return String(number);
    }
    throw new CTraderSyncError("CTRADER_MCP_METADATA_INVALID", `cTrader returned an invalid ${field}`, false);
  });
  if (normalized.some((value) => value !== normalized[0])) {
    throw new CTraderSyncError("CTRADER_MCP_METADATA_INVALID", `cTrader returned conflicting ${field} values`, false);
  }
  return normalized[0] ?? null;
}

function normalizeSymbols(value: unknown): McpSymbol[] {
  const rows = unwrapArray(value, ["symbols", "data", "result", "items"], "symbols");
  const symbols = new Map<string, McpSymbol>();
  for (const row of rows) {
    const raw = objectValue(row);
    const id = textValue(firstValue(raw, ["id", "symbolId", "symbol_id"]), "symbol ID");
    const name = textValue(firstValue(raw, ["name", "symbolName", "symbol_name"]), "symbol name");
    if (!id || !name) continue;
    const providerLotAliases = ["lotSize", "lot_size", "contractSize", "contract_size"] as const;
    const providerLots = providerLotAliases.flatMap((key) => {
      const candidate = raw[key];
      if (candidate === undefined || candidate === null) return [];
      const number = typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && /^\d+$/.test(candidate.trim())
          ? Number(candidate.trim())
          : Number.NaN;
      if (!Number.isSafeInteger(number) || number <= 0 || number > Math.floor(Number.MAX_SAFE_INTEGER / 100)) {
        throw new CTraderSyncError(
          "CTRADER_MCP_SYMBOL_SPEC_INVALID",
          `cTrader returned an invalid contract size for symbol ${id}`,
          false,
        );
      }
      return [number];
    });
    const providerLotNumber = providerLots[0] ?? null;
    if (providerLots.some((candidate) => candidate !== providerLotNumber)) {
      throw new CTraderSyncError(
        "CTRADER_MCP_SYMBOL_CONFLICT",
        `cTrader returned conflicting contract sizes for symbol ${id}`,
        false,
      );
    }
    const hasProviderLot = providerLotNumber !== null;
    const providerLotScaleAliases = [raw.lotSizeScale, raw.lot_size_scale]
      .filter((candidate) => candidate !== undefined && candidate !== null && candidate !== "")
      .map((candidate) => typeof candidate === "string" ? candidate.trim() : String(candidate));
    if (providerLotScaleAliases.some((candidate) => candidate !== providerLotScaleAliases[0])) {
      throw new CTraderSyncError(
        "CTRADER_MCP_SYMBOL_CONFLICT",
        `cTrader returned conflicting contract-size scales for symbol ${id}`,
        false,
      );
    }
    const providerLotSizeScale = providerLotScaleAliases[0] === PROVIDER_BASE_UNITS_PER_LOT_SCALE
      ? PROVIDER_BASE_UNITS_PER_LOT_SCALE
      : null;
    const normalized: McpSymbol = {
      id,
      name,
      baseAssetId: optionalStrictIntegerId(raw, ["baseAssetId", "base_asset_id"], "base asset ID"),
      quoteAssetId: optionalStrictIntegerId(raw, ["quoteAssetId", "quote_asset_id"], "quote asset ID"),
      category: textValue(firstValue(raw, [
        "symbolCategory", "category", "assetClass", "type", "symbolCategoryId",
      ]), "symbol category"),
      lotSize: hasProviderLot ? providerLotNumber : null,
      lotSizeSource: hasProviderLot ? "provider" : "unavailable",
      providerLotSizeScale,
      verifiedOverride: null,
      raw,
    };
    const previous = symbols.get(id);
    if (previous) {
      const sameCanonicalSpecification = normalizedSymbolName(previous.name) === normalizedSymbolName(normalized.name)
        && previous.baseAssetId === normalized.baseAssetId
        && previous.quoteAssetId === normalized.quoteAssetId
        && previous.category === normalized.category
        && previous.lotSize === normalized.lotSize
        && previous.lotSizeSource === normalized.lotSizeSource
        && previous.providerLotSizeScale === normalized.providerLotSizeScale
        && previous.verifiedOverride === normalized.verifiedOverride;
      if (!sameCanonicalSpecification) {
        throw new CTraderSyncError(
          "CTRADER_MCP_SYMBOL_CONFLICT",
          `cTrader returned conflicting specifications for symbol ${id}`,
          false,
        );
      }
      continue;
    }
    symbols.set(id, normalized);
  }
  if (symbols.size === 0) {
    throw new CTraderSyncError("CTRADER_MCP_SYMBOLS_EMPTY", "cTrader returned no usable symbols", false);
  }
  return [...symbols.values()];
}

function safeCursor(value: unknown): JsonRecord {
  return objectValue(value);
}

function cursorTimestamp(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= Date.now() + 24 * 60 * 60 * 1_000 ? parsed : null;
}

function cursorPositionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((candidate): candidate is string =>
    typeof candidate === "string"
    && candidate.length > 0
    && candidate.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(candidate));
  return [...new Set(ids)];
}

const REVIEWABLE_PROJECTION_ERRORS = new Set([
  "CTRADER_MCP_LOT_SIZE_UNAVAILABLE",
  "CTRADER_MCP_VOLUME_SCALE_UNAVAILABLE",
  "CTRADER_MCP_OPENING_LINEAGE_UNPROVEN",
  "CTRADER_MCP_POSITION_VOLUME_INVALID",
  "CTRADER_MCP_OPEN_SIDE_MISMATCH",
  "CTRADER_MCP_CLOSE_SIDE_MISMATCH",
  "CTRADER_MCP_VOLUME_INVALID",
  "CTRADER_MCP_CALCULATION_INVALID",
]);

// A missing symbol or a legacy/invalid contract-size quarantine does not
// invalidate exact provider money already tied to the same stored execution
// lineage. Ordinary missing lot metadata now projects in explicit base units.
// Structural lineage errors intentionally do not appear here and continue to
// clear the aggregate when quarantined.
const QUARANTINE_REASONS_PRESERVING_EXACT_MONEY = new Set([
  "CTRADER_MCP_SYMBOL_UNAVAILABLE",
  "CTRADER_MCP_LOT_SIZE_UNAVAILABLE",
]);

function projectionReviewReason(error: unknown): string | null {
  return error instanceof CTraderSyncError && REVIEWABLE_PROJECTION_ERRORS.has(error.code)
    ? error.code
    : null;
}

function reasonCounts(reasons: ReadonlyMap<string, string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const reason of reasons.values()) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}

function metadataTimestamp(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  try { return timestamp(value, "account registration timestamp"); } catch { return null; }
}

function accountMetadataObjects(
  value: unknown,
  wrapperKeys: readonly string[] = ACCOUNT_METADATA_WRAPPER_KEYS,
): JsonRecord[] {
  const objects: JsonRecord[] = [];
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  let arrayEntriesSeen = 0;
  for (let index = 0; index < pending.length; index += 1) {
    const candidate = pending[index];
    if (Array.isArray(candidate)) {
      arrayEntriesSeen += candidate.length;
      if (arrayEntriesSeen > MAX_ACCOUNT_METADATA_ARRAY_ENTRIES) {
        throw new CTraderSyncError(
          "CTRADER_MCP_METADATA_INVALID",
          "cTrader returned too many account metadata entries",
          false,
        );
      }
      pending.push(...candidate);
      continue;
    }
    if (typeof candidate !== "object" || candidate === null || visited.has(candidate)) continue;
    visited.add(candidate);
    const object = objectValue(candidate);
    objects.push(object);
    if (objects.length > MAX_ACCOUNT_METADATA_OBJECTS) {
      throw new CTraderSyncError(
        "CTRADER_MCP_METADATA_INVALID",
        "cTrader returned too many account metadata objects",
        false,
      );
    }
    for (const key of wrapperKeys) {
      if (Object.prototype.hasOwnProperty.call(object, key)) pending.push(object[key]);
    }
  }
  return objects;
}

function verifiedAccountAttribution(
  objects: readonly JsonRecord[],
  expectedAccountId: string,
  mismatch: () => CTraderSyncError,
): boolean {
  const explicit = accountIds(objects);
  if (explicit.some((value) => value !== expectedAccountId)) throw mismatch();
  return explicit.length > 0;
}

function historyResponseHasVerifiedAccount(
  value: unknown,
  expectedAccountId: string,
  wrapperKeys: readonly string[] = ACCOUNT_METADATA_WRAPPER_KEYS,
): boolean {
  if (Array.isArray(value)) return false;
  return verifiedAccountAttribution(
    accountMetadataObjects(value, wrapperKeys),
    expectedAccountId,
    accountHistoryMismatch,
  );
}

function accountCurrency(objects: readonly JsonRecord[]): string | null {
  const values = objects.flatMap((object) => [
    object.currency,
    object.currencyCode,
    object.currency_code,
    object.accountCurrency,
    object.account_currency,
  ]).filter((value) => value !== undefined && value !== null && value !== "");
  if (values.length === 0) return null;
  const normalized = values.map((value) => {
    if (typeof value !== "string") {
      throw new CTraderSyncError("CTRADER_MCP_CURRENCY_INVALID", "cTrader returned an invalid account currency", false);
    }
    const trimmed = value.trim();
    if (trimmed.length > 200 || /[\u0000-\u001f\u007f]/.test(trimmed)) {
      throw new CTraderSyncError("CTRADER_MCP_METADATA_INVALID", "cTrader returned invalid account metadata", false);
    }
    const canonical = trimmed.toUpperCase();
    if (!/^[A-Z0-9]{3,10}$/.test(canonical)) {
      throw new CTraderSyncError("CTRADER_MCP_CURRENCY_INVALID", "cTrader returned an invalid account currency", false);
    }
    return canonical;
  });
  if (normalized.some((value) => value !== normalized[0])) {
    throw new CTraderSyncError("CTRADER_MCP_CURRENCY_INVALID", "cTrader returned conflicting account currencies", false);
  }
  return normalized[0] ?? null;
}

function normalizeAssets(value: unknown): ReadonlyMap<string, string> {
  const rows = unwrapArray(value, ["assets", "data", "result", "items"], "assets");
  const assets = new Map<string, string>();
  for (const row of rows) {
    const raw = objectValue(row);
    const id = optionalStrictIntegerId(raw, ["assetId", "asset_id", "id"], "asset ID");
    if (id === null) continue;
    const name = textValue(firstValue(raw, ["name", "displayName", "display_name"]), "asset name");
    if (name === null) continue;
    const canonical = name.toUpperCase();
    if (!/^[A-Z0-9.]{2,20}$/.test(canonical)) {
      throw new CTraderSyncError("CTRADER_MCP_METADATA_INVALID", "cTrader returned an invalid asset name", false);
    }
    const previous = assets.get(id);
    if (previous !== undefined && previous !== canonical) {
      throw new CTraderSyncError("CTRADER_MCP_METADATA_INVALID", "cTrader returned conflicting asset names", false);
    }
    assets.set(id, canonical);
  }
  if (assets.size === 0) throw new CTraderSyncError("CTRADER_MCP_METADATA_INVALID", "cTrader returned no usable assets", false);
  return assets;
}

function accountDepositAssetId(objects: readonly JsonRecord[]): string | null {
  const values = objects.flatMap((object) => {
    const value = optionalStrictIntegerId(
      object,
      ["depositAssetId", "deposit_asset_id", "accountDepositAssetId", "account_deposit_asset_id"],
      "deposit asset ID",
    );
    return value === null ? [] : [value];
  });
  if (values.some((value) => value !== values[0])) {
    throw new CTraderSyncError("CTRADER_MCP_METADATA_INVALID", "cTrader returned conflicting deposit asset IDs", false);
  }
  return values[0] ?? null;
}

function accountMoneyDigits(objects: readonly JsonRecord[]): number | null {
  const candidates = objects.flatMap((raw) => [
    raw.moneyDigits,
    raw.money_digits,
    raw.accountMoneyDigits,
    raw.account_money_digits,
  ]).filter((value) => value !== undefined && value !== null && value !== "");
  if (candidates.length === 0) return null;
  const digits = candidates.map((value) => typeof value === "number" ? value : Number(value));
  if (digits.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 18 || value !== digits[0])) {
    throw new CTraderSyncError("CTRADER_MCP_METADATA_INVALID", "cTrader returned invalid account money digits", false);
  }
  return digits[0] ?? null;
}

function currencyContext(
  balanceResponse: unknown,
  accountInfoResponse: unknown,
  assets: ReadonlyMap<string, string>,
  assetsAvailable: boolean,
  providerMetadata: JsonRecord,
): McpCurrencyContext {
  const objects = [
    ...accountMetadataObjects(balanceResponse),
    ...accountMetadataObjects(accountInfoResponse),
    ...accountMetadataObjects(providerMetadata),
  ];
  const directCurrency = accountCurrency(objects);
  const depositAssetId = accountDepositAssetId(objects);
  const assetCurrency = depositAssetId === null ? null : assets.get(depositAssetId) ?? null;
  if (depositAssetId !== null && assetsAvailable && assetCurrency === null) {
    throw new CTraderSyncError("CTRADER_MCP_METADATA_INVALID", "cTrader deposit asset is unavailable", false);
  }
  if (directCurrency !== null && assetCurrency !== null && directCurrency !== assetCurrency) {
    throw new CTraderSyncError("CTRADER_MCP_CURRENCY_INVALID", "cTrader returned conflicting account currencies", false);
  }
  return {
    accountCurrency: directCurrency ?? assetCurrency,
    depositAssetId,
    accountMoneyDigits: accountMoneyDigits(objects),
    assetNames: assets,
  };
}

function historyStart(
  config: AppConfig,
  cursor: JsonRecord,
  providerMetadata: JsonRecord,
  now: number,
): number {
  const floor = metadataTimestamp(providerMetadata.historyFloorTimestamp);
  const floorKind = providerMetadata.historyFloorKind;
  if (
    floor === null
    || !["registration", "connection_time", "connection_time_empty_attested"].includes(String(floorKind))
  ) {
    throw new CTraderSyncError(
      "CTRADER_MCP_HISTORY_BOUND_MISSING",
      "Reconnect cTrader to establish an approved trade-history boundary",
      false,
      true,
    );
  }
  const syncedThrough = cursorTimestamp(cursor.syncedThroughTimestamp);
  if ((cursor.historyWindowComplete === true || cursor.fullHistoryComplete === true) && syncedThrough !== null) {
    return Math.max(floor, syncedThrough - config.cTrader.syncOverlapSeconds * 1_000);
  }
  return Math.min(floor, now);
}

function hasValidNoOpenPositionsAttestation(
  connection: McpConnectionRow,
  providerMetadata: JsonRecord,
): boolean {
  if (providerMetadata.historyFloorKind !== "connection_time_empty_attested") return true;
  const floor = metadataTimestamp(providerMetadata.historyFloorTimestamp);
  const attestation = objectValue(providerMetadata.noOpenPositionsAttestation);
  return floor !== null
    && attestation.version === 1
    && attestation.userId === connection.user_id
    && attestation.connectionId === connection.id
    && attestation.accountId === connection.external_account_id
    && attestation.environment === connection.provider_environment
    && attestation.boundaryTimestamp === floor;
}

function invalidAccountlessHistoryAttestation(): CTraderSyncError {
  return new CTraderSyncError(
    "CTRADER_MCP_ACCOUNTLESS_ATTESTATION_INVALID",
    "The operator-verified cTrader account attribution is invalid for this connection",
    false,
  );
}

function accountlessHistoryAttestationFingerprint(
  input: Omit<AccountlessHistoryAttributionAttestation, "fingerprint">,
): string {
  return json([
    input.version,
    input.purpose,
    input.source,
    input.userId,
    input.connectionId,
    input.externalAccountId,
    input.environment,
    input.tokenGeneration,
    input.acknowledgedAt,
  ]);
}

function accountlessHistoryAttestation(
  connection: Pick<McpConnectionRow, "id" | "user_id" | "external_account_id" | "provider_environment" | "token_generation">,
  providerMetadata: JsonRecord,
): AccountlessHistoryAttributionAttestation | null {
  const value = providerMetadata[ACCOUNTLESS_HISTORY_ATTESTATION_KEY];
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw invalidAccountlessHistoryAttestation();
  const raw = objectValue(value);
  const expectedKeys = [
    "acknowledgedAt",
    "connectionId",
    "environment",
    "externalAccountId",
    "purpose",
    "source",
    "tokenGeneration",
    "userId",
    "version",
  ];
  if (json(Object.keys(raw).sort()) !== json(expectedKeys)) throw invalidAccountlessHistoryAttestation();
  const acknowledgedAt = raw.acknowledgedAt;
  const acknowledgedTimestamp = typeof acknowledgedAt === "string" ? Date.parse(acknowledgedAt) : Number.NaN;
  if (
    raw.version !== 1
    || raw.purpose !== ACCOUNTLESS_HISTORY_ATTESTATION_PURPOSE
    || raw.source !== ACCOUNTLESS_HISTORY_ATTESTATION_SOURCE
    || raw.userId !== connection.user_id
    || raw.connectionId !== connection.id
    || raw.externalAccountId !== connection.external_account_id
    || raw.environment !== connection.provider_environment
    || raw.tokenGeneration !== String(connection.token_generation)
    || typeof acknowledgedAt !== "string"
    || !Number.isSafeInteger(acknowledgedTimestamp)
    || acknowledgedTimestamp <= 0
    || acknowledgedTimestamp > Date.now() + 5 * 60 * 1_000
    || new Date(acknowledgedTimestamp).toISOString() !== acknowledgedAt
  ) {
    throw invalidAccountlessHistoryAttestation();
  }
  const parsed: Omit<AccountlessHistoryAttributionAttestation, "fingerprint"> = {
    version: 1 as const,
    purpose: ACCOUNTLESS_HISTORY_ATTESTATION_PURPOSE,
    source: ACCOUNTLESS_HISTORY_ATTESTATION_SOURCE,
    userId: connection.user_id,
    connectionId: connection.id,
    externalAccountId: connection.external_account_id,
    environment: connection.provider_environment,
    tokenGeneration: String(connection.token_generation),
    acknowledgedAt,
  };
  return {
    ...parsed,
    fingerprint: accountlessHistoryAttestationFingerprint(parsed),
  };
}

function assertAccountlessHistoryAttestationUnchanged(
  locked: LockedMcpConnectionAttestationRow,
  expected: AccountlessHistoryAttributionAttestation | null,
): void {
  if (expected === null) return;
  let current: AccountlessHistoryAttributionAttestation | null;
  try {
    current = accountlessHistoryAttestation({
      id: locked.connection_id,
      user_id: locked.connection_user_id,
      external_account_id: locked.external_account_id,
      provider_environment: locked.provider_environment,
      token_generation: locked.token_generation,
    }, objectValue(locked.provider_metadata));
  } catch {
    current = null;
  }
  if (current?.fingerprint !== expected.fingerprint) {
    throw new CTraderSyncError(
      "CTRADER_MCP_ACCOUNTLESS_ATTESTATION_CHANGED",
      "The operator-verified cTrader account attribution changed during sync",
      false,
    );
  }
}

function normalizeMcpError(error: unknown): CTraderSyncError {
  if (error instanceof CTraderSyncError) return error;
  if (error instanceof CTraderMcpError) {
    const retryable = ["REQUEST_TIMEOUT", "REMOTE_RATE_LIMITED", "REMOTE_UNAVAILABLE", "SESSION_INVALID"].includes(error.code);
    const requiresReauth = error.code === "AUTH_REJECTED";
    return new CTraderSyncError(error.code, error.message, retryable, requiresReauth);
  }
  return new CTraderSyncError(
    "CTRADER_MCP_SYNC_FAILED",
    "The cTrader MCP sync failed",
    false,
  );
}

function localDateTime(value: number, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((candidate) => candidate.type === type)?.value;
    if (!found) throw new CTraderSyncError("CTRADER_MCP_TIME_FAILED", "Could not project the cTrader execution time", false);
    return found;
  };
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}:${part("second")}`,
  };
}

function decimal(value: number, digits = 10): string {
  if (!Number.isFinite(value)) throw new CTraderSyncError("CTRADER_MCP_CALCULATION_INVALID", "cTrader projection produced an invalid number", false);
  const fixed = value.toFixed(digits).replace(/\.?0+$/, "");
  return fixed === "-0" ? "0" : fixed;
}

function weightedPrice(deals: readonly McpDeal[]): number {
  const totalBigint = deals.reduce((sum, deal) => sum + deal.filledVolumeCents, 0n);
  if (totalBigint <= 0n || totalBigint > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CTraderSyncError("CTRADER_MCP_NUMERIC_OVERFLOW", "cTrader position volume exceeds safe bounds", false);
  }
  const total = Number(totalBigint);
  return deals.reduce(
    (sum, deal) => sum + deal.executionPrice * (Number(deal.filledVolumeCents) / total),
    0,
  );
}

function moneyFromCents(value: number): string {
  return decimal(value / 100, 10);
}

function sumScaledMoney(values: readonly { value: bigint; digits: number }[]): string | null {
  if (values.length === 0) return null;
  const targetDigits = values.reduce((maximum, item) => Math.max(maximum, item.digits), 0);
  const total = values.reduce((sum, item) => {
    const next = sum + item.value * (10n ** BigInt(targetDigits - item.digits));
    if (next > BigInt(Number.MAX_SAFE_INTEGER) || next < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new CTraderSyncError("CTRADER_MCP_NUMERIC_OVERFLOW", "cTrader monetary values exceed safe bounds", false);
    }
    return next;
  }, 0n);
  return scaledMoneyToDecimal(total, targetDigits);
}

function executionMoneyValues(deal: McpDeal): {
  pnl: string | null;
  commission: string | null;
  swap: string | null;
  moneyDigits: number | null;
  closePositionDetail: string | null;
} {
  if (
    deal.moneyDigits !== null
    && deal.grossProfitScaled !== null
    && deal.commissionScaled !== null
    && deal.swapScaled !== null
    && deal.pnlConversionFeeScaled !== null
  ) {
    const net = deal.grossProfitScaled + deal.swapScaled + deal.commissionScaled - deal.pnlConversionFeeScaled;
    return {
      pnl: scaledMoneyToDecimal(net, deal.moneyDigits),
      commission: scaledMoneyToDecimal(deal.commissionScaled, deal.moneyDigits),
      swap: scaledMoneyToDecimal(deal.swapScaled, deal.moneyDigits),
      moneyDigits: deal.moneyDigits,
      closePositionDetail: json({
        grossProfit: deal.grossProfitScaled.toString(),
        commission: deal.commissionScaled.toString(),
        swap: deal.swapScaled.toString(),
        pnlConversionFee: deal.pnlConversionFeeScaled.toString(),
        moneyDigits: deal.moneyDigits,
      }),
    };
  }
  return {
    pnl: deal.pnlCents === null ? null : moneyFromCents(deal.pnlCents),
    commission: deal.commissionCents === null ? null : moneyFromCents(deal.commissionCents),
    swap: deal.swapCents === null ? null : moneyFromCents(deal.swapCents),
    moneyDigits: deal.pnlCents === null && deal.commissionCents === null && deal.swapCents === null ? null : 2,
    closePositionDetail: null,
  };
}

function sumOptionalCents(deals: readonly McpDeal[], field: "commissionCents" | "swapCents"): string | null {
  const values = deals.map((deal) => deal[field]).filter((value): value is number => value !== null);
  if (values.length === 0) return null;
  const total = values.reduce((sum, value) => {
    const next = sum + BigInt(value);
    if (next > BigInt(Number.MAX_SAFE_INTEGER) || next < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new CTraderSyncError("CTRADER_MCP_NUMERIC_OVERFLOW", "cTrader monetary values exceed safe bounds", false);
    }
    return next;
  }, 0n);
  return moneyFromCents(Number(total));
}

function assetForSymbol(symbol: McpSymbol): McpProjection["asset"] {
  const name = normalizedSymbolName(symbol.name);
  if (/^(?:XAU|XAG|XTI|XBR)|GOLD|SILVER|OIL|BRENT|WTI|NATGAS/.test(name)) return "cm";
  if (/^(?:BTC|ETH|BNB|SOL|XRP|ADA)/.test(name)) return "cx";
  if (/^(?:US30|US500|SPX500|SP500|NAS100|UK100|GER40|AUS200|JPN225|FRA40)/.test(name)) return "ix";
  const category = (symbol.category ?? "").toLowerCase();
  if (/crypt|coin/.test(category)) return "cx";
  if (/index|indice/.test(category)) return "ix";
  if (/commod|metal|energy|oil|gas/.test(category)) return "cm";
  if (/stock|equit|share/.test(category)) return "eq";
  if (/forex|fx/.test(category) || /^[A-Z]{6}$/.test(name)) return "fx";
  return null;
}

function quantityLotSpecification(symbol: McpSymbol): {
  baseUnitsPerLot: number;
  source: "provider_versioned" | "verified_account_symbol_override";
  measurementUnit: string | null;
} | null {
  if (!Number.isSafeInteger(symbol.lotSize) || (symbol.lotSize ?? 0) <= 0) return null;
  if (
    symbol.lotSizeSource === "provider"
    && symbol.providerLotSizeScale === PROVIDER_BASE_UNITS_PER_LOT_SCALE
  ) {
    return {
      baseUnitsPerLot: symbol.lotSize ?? 0,
      source: "provider_versioned",
      measurementUnit: null,
    };
  }
  const override = symbol.verifiedOverride;
  if (
    symbol.lotSizeSource !== VERIFIED_SYMBOL_OVERRIDE_SOURCE
    || override === null
    || override.symbolId !== symbol.id
    || override.symbolName !== symbol.name
    || override.baseUnitsPerLot !== symbol.lotSize
  ) return null;
  return {
    baseUnitsPerLot: override.baseUnitsPerLot,
    source: VERIFIED_SYMBOL_OVERRIDE_SOURCE,
    measurementUnit: override.measurementUnit,
  };
}

function projectMcpPosition(
  dealsValue: readonly McpDeal[],
  symbol: McpSymbol,
  timeZone: string,
  currency: McpCurrencyContext,
  floorKind: string,
): McpProjection {
  const accountCurrency = currency.accountCurrency;
  const deals = [...dealsValue].sort((left, right) =>
    left.executionTimestamp - right.executionTimestamp || compareDealIds(left.dealId, right.dealId));
  const first = deals[0];
  if (!first) throw new CTraderSyncError("CTRADER_MCP_POSITION_EMPTY", "cTrader position has no deals", false);
  if (deals.some((deal) => deal.positionId !== first.positionId)) {
    throw new CTraderSyncError("CTRADER_MCP_POSITIONS_MIXED", "cTrader returned mixed positions", false);
  }
  if (deals.some((deal) => deal.symbolId !== first.symbolId) || symbol.id !== first.symbolId) {
    throw new CTraderSyncError(
      "CTRADER_MCP_POSITION_SYMBOL_MISMATCH",
      `Position ${first.positionId} contains conflicting symbol identities`,
      false,
    );
  }
  const explicitOpening = deals.filter((deal) => deal.role === "OPEN");
  const attestedBoundaryInference = [
    "connection_time_empty_attested",
    "historical_preview_empty_attested",
  ].includes(floorKind)
    && first.role === null
    && explicitOpening.length === 0;
  const lineageIsAuthoritative = floorKind === "registration"
    || explicitOpening[0] === first
    || attestedBoundaryInference;
  if (!lineageIsAuthoritative) {
    throw new CTraderSyncError(
      "CTRADER_MCP_OPENING_LINEAGE_UNPROVEN",
      `Position ${first.positionId} may have opened before the approved history boundary`,
      false,
    );
  }
  const openingSide = explicitOpening[0]?.side ?? first.side;
  if (deals.some((deal) => deal.role === "OPEN" && deal.side !== openingSide)) {
    throw new CTraderSyncError("CTRADER_MCP_OPEN_SIDE_MISMATCH", `Position ${first.positionId} has inconsistent opening sides`, false);
  }
  if (deals.some((deal) => deal.role === "CLOSE" && deal.side === openingSide)) {
    throw new CTraderSyncError("CTRADER_MCP_CLOSE_SIDE_MISMATCH", `Position ${first.positionId} has an invalid closing side`, false);
  }
  const opening = deals.filter((deal) => deal.role === "OPEN" || (deal.role === null && deal.side === openingSide));
  const closing = deals.filter((deal) => deal.role === "CLOSE" || (deal.role === null && deal.side !== openingSide));
  if (deals.some((deal) => deal.filledVolumeScale !== "unit_cents" || deal.filledVolumeSourceKey === null)) {
    throw new CTraderSyncError(
      "CTRADER_MCP_VOLUME_SCALE_UNAVAILABLE",
      `cTrader did not provide an authoritative volume scale for position ${first.positionId}`,
      false,
    );
  }
  if (
    symbol.lotSizeSource === VERIFIED_SYMBOL_OVERRIDE_SOURCE
    && deals.some((deal) => deal.filledVolumeSourceKey !== "filledVolume")
  ) {
    throw new CTraderSyncError(
      "CTRADER_MCP_VOLUME_SCALE_UNAVAILABLE",
      `The operator-verified contract size for ${symbol.name} is not paired with the verified cTrader filledVolume provenance`,
      false,
    );
  }
  const opened = opening.reduce((sum, deal) => sum + deal.filledVolumeCents, 0n);
  const closed = closing.reduce((sum, deal) => sum + deal.filledVolumeCents, 0n);
  if (closed > opened) {
    throw new CTraderSyncError(
      "CTRADER_MCP_POSITION_VOLUME_INVALID",
      `Position ${first.positionId} closes more volume than its imported opening lineage`,
      false,
    );
  }
  const entry = weightedPrice(opening);
  const exit = closing.length > 0 ? weightedPrice(closing) : null;
  const direction = openingSide === "BUY" ? "Long" : "Short";
  const hasAuthoritativeCloseMoney = (deal: McpDeal): boolean => deal.moneyDigits !== null
    && deal.grossProfitScaled !== null
    && deal.commissionScaled !== null
    && deal.swapScaled !== null
    && deal.pnlConversionFeeScaled !== null;
  const completeExplicitCents = closing.length > 0 && closing.every((deal) => deal.pnlCents !== null);
  const completeAuthoritativeCloseMoney = closing.length > 0 && closing.every(hasAuthoritativeCloseMoney);
  const completeProviderPnl = closing.length > 0 && closing.every((deal) =>
    deal.pnlCents !== null || hasAuthoritativeCloseMoney(deal));
  const mixedExactMoney = completeProviderPnl
    && !completeExplicitCents
    && !completeAuthoritativeCloseMoney;
  const dealNetScaled = (deal: McpDeal): { value: bigint; digits: number } => {
    if (hasAuthoritativeCloseMoney(deal)) {
      return {
        value: (deal.grossProfitScaled ?? 0n) + (deal.swapScaled ?? 0n)
          + (deal.commissionScaled ?? 0n) - (deal.pnlConversionFeeScaled ?? 0n),
        digits: deal.moneyDigits ?? 0,
      };
    }
    if (deal.pnlCents === null) {
      throw new CTraderSyncError("CTRADER_MCP_MONEY_SCALE_UNAVAILABLE", "cTrader did not expose authoritative realized P&L", false);
    }
    return { value: BigInt(deal.pnlCents), digits: 2 };
  };
  const realizedEvents = completeProviderPnl
    ? closing.map((deal) => {
        const local = localDateTime(deal.executionTimestamp, timeZone);
        const net = dealNetScaled(deal);
        const pnl = scaledMoneyToDecimal(net.value, net.digits);
        return {
          executionId: deal.dealId,
          executedAt: new Date(deal.executionTimestamp).toISOString(),
          date: local.date,
          time: local.time,
          closedVolumeCents: deal.filledVolumeCents.toString(),
          price: decimal(deal.executionPrice),
          pnl,
          grossProfit: deal.grossProfitScaled === null || deal.moneyDigits === null
            ? null : scaledMoneyToDecimal(deal.grossProfitScaled, deal.moneyDigits),
          commission: deal.commissionScaled !== null && deal.moneyDigits !== null
            ? scaledMoneyToDecimal(deal.commissionScaled, deal.moneyDigits)
            : deal.commissionCents === null ? null : moneyFromCents(deal.commissionCents),
          swap: deal.swapScaled !== null && deal.moneyDigits !== null
            ? scaledMoneyToDecimal(deal.swapScaled, deal.moneyDigits)
            : deal.swapCents === null ? null : moneyFromCents(deal.swapCents),
          pnlConversionFee: deal.pnlConversionFeeScaled === null || deal.moneyDigits === null
            ? null : scaledMoneyToDecimal(deal.pnlConversionFeeScaled, deal.moneyDigits),
        };
      })
    : [];
  let totalPnl: string | null = null;
  if (completeProviderPnl) {
    const normalized = closing.map(dealNetScaled);
    const totalDigits = normalized.reduce((maximum, item) => Math.max(maximum, item.digits), 0);
    const total = normalized.reduce((sum, item) => {
      const next = sum + item.value * (10n ** BigInt(totalDigits - item.digits));
      if (next > BigInt(Number.MAX_SAFE_INTEGER) || next < BigInt(Number.MIN_SAFE_INTEGER)) {
        throw new CTraderSyncError("CTRADER_MCP_NUMERIC_OVERFLOW", "cTrader realized P&L exceeds safe bounds", false);
      }
      return next;
    }, 0n);
    totalPnl = scaledMoneyToDecimal(total, totalDigits);
  }
  let calculatedGross: ReturnType<typeof calculateCTraderGrossFallback> = null;
  if (closed === opened && closing.length > 0) {
    try {
      calculatedGross = calculateCTraderGrossFallback({
        deals,
        openingSide,
        symbol,
        currency,
      });
    } catch (error) {
      if (error instanceof CTraderCalculatedGrossError) {
        throw new CTraderSyncError(
          error.code === "POSITION_VOLUME_INVALID"
            ? "CTRADER_MCP_POSITION_VOLUME_INVALID"
            : "CTRADER_MCP_NUMERIC_OVERFLOW",
          error.message,
          false,
        );
      }
      throw error;
    }
  }
  const entryLocal = localDateTime(first.executionTimestamp, timeZone);
  const lastClose = closing.at(-1) ?? null;
  const exitLocal = lastClose ? localDateTime(lastClose.executionTimestamp, timeZone) : null;
  const estimatedCommissionComplete = deals.every((deal) => deal.remoteCommissionRawUnits !== null);
  const observedSwapComplete = deals.every((deal) => deal.remoteSwapRawUnits !== null);
  const sameProviderCalendarDay = exitLocal !== null && entryLocal.date === exitLocal.date;
  const estimatedSwapComplete = observedSwapComplete || sameProviderCalendarDay;
  const estimateDigits = currency.accountMoneyDigits;
  let estimatedCommission: string | null = null;
  let estimatedSwap: string | null = null;
  let estimatedConversionFee: string | null = null;
  let estimatedOtherCharges: string | null = null;
  let estimatedFeesAndCharges: string | null = null;
  let estimatedNetPnl: string | null = null;
  if (
    totalPnl === null
    && calculatedGross !== null
    && estimateDigits !== null
    && estimatedCommissionComplete
    && estimatedSwapComplete
  ) {
    const commissionRaw = deals.reduce((sum, deal) => sum + (deal.remoteCommissionRawUnits ?? 0n), 0n);
    const swapRaw = observedSwapComplete
      ? deals.reduce((sum, deal) => sum + (deal.remoteSwapRawUnits ?? 0n), 0n)
      : 0n;
    const grossRaw = decimalMoneyToScaled(calculatedGross.calculatedGrossPnl, estimateDigits);
    if (grossRaw !== null) {
      // Quote and deposit currency identity is already a hard gate of the
      // calculated-gross result. Conversion and unobserved other charges are
      // therefore estimated as zero, never asserted as provider exact.
      const conversionRaw = 0n;
      const otherRaw = 0n;
      const feesRaw = commissionRaw + swapRaw - conversionRaw + otherRaw;
      estimatedCommission = scaledMoneyToDecimal(commissionRaw, estimateDigits);
      estimatedSwap = scaledMoneyToDecimal(swapRaw, estimateDigits);
      estimatedConversionFee = scaledMoneyToDecimal(conversionRaw, estimateDigits);
      estimatedOtherCharges = scaledMoneyToDecimal(otherRaw, estimateDigits);
      estimatedFeesAndCharges = scaledMoneyToDecimal(feesRaw, estimateDigits);
      estimatedNetPnl = scaledMoneyToDecimal(grossRaw + feesRaw, estimateDigits);
    }
  }
  const openVolume = opened - closed;
  if (opened > BigInt(Number.MAX_SAFE_INTEGER) || closed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CTraderSyncError(
      "CTRADER_MCP_NUMERIC_OVERFLOW",
      `Position ${first.positionId} volume exceeds safe projection bounds`,
      false,
    );
  }
  const lotSpecification = quantityLotSpecification(symbol);
  const lotDenominator = lotSpecification === null ? null : lotSpecification.baseUnitsPerLot * 100;
  if (lotDenominator !== null && (!Number.isSafeInteger(lotDenominator) || lotDenominator <= 0)) {
    throw new CTraderSyncError(
      "CTRADER_MCP_LOT_SIZE_UNAVAILABLE",
      `cTrader provided an unsafe contract size for ${symbol.name}`,
      false,
    );
  }
  const quantityBaseUnits = decimal(Number(opened) / 100);
  const quantityLots = lotDenominator === null ? null : decimal(Number(opened) / lotDenominator);
  const quantityUnit = quantityLots === null ? "base_units" : "lots";
  const quantity = quantityLots ?? quantityBaseUnits;
  const quantityBaseAssetName = symbol.baseAssetId === null
    ? null
    : currency.assetNames.get(symbol.baseAssetId) ?? null;
  const asset = assetForSymbol(symbol);
  const providerExecutionLineage = {
    version: 1,
    executionIds: deals.map((deal) => deal.dealId),
    closingExecutionIds: closing.map((deal) => deal.dealId),
    fingerprintSha256: createHash("sha256").update(json({
      positionId: first.positionId,
      executions: deals.map((deal) => ({
        dealId: deal.dealId,
        role: deal.role,
        side: deal.side,
        filledVolumeCents: deal.filledVolumeCents.toString(),
        executionTimestamp: deal.executionTimestamp,
      })),
    })).digest("hex"),
  };
  return {
    positionId: first.positionId,
    symbolId: first.symbolId,
    symbol: symbol.name,
    asset,
    direction,
    entryPrice: decimal(entry),
    exitPrice: exit === null ? null : decimal(exit),
    quantity,
    quantityUnit,
    quantityLots,
    quantityBaseUnits,
    pnl: totalPnl,
    isOpen: openVolume > 0n,
    tradeDate: entryLocal.date,
    entryAt: new Date(first.executionTimestamp).toISOString(),
    exitAt: lastClose ? new Date(lastClose.executionTimestamp).toISOString() : null,
    entryTime: entryLocal.time,
    exitTime: exitLocal?.time ?? null,
    brokerData: {
      provider: "ctrader",
      connectionMode: "mcp_read",
      readOnly: true,
      positionId: first.positionId,
      symbolId: first.symbolId,
      providerTradeDate: entryLocal.date,
      providerTradeDateTimeZone: timeZone,
      openedVolumeCents: opened.toString(),
      closedVolumeCents: closed.toString(),
      openVolumeCents: openVolume.toString(),
      providerExecutionLineage,
      quantityProjection: {
        version: 1,
        value: quantity,
        unit: quantityUnit,
        lots: quantityLots,
        baseUnits: quantityBaseUnits,
        baseAssetId: symbol.baseAssetId,
        baseAssetName: quantityBaseAssetName,
        volumeScale: "unit_cents",
        source: "provider_filled_volume",
        contractSizeUsed: lotSpecification === null ? null : {
          baseUnitsPerLot: lotSpecification.baseUnitsPerLot,
          source: lotSpecification.source,
          measurementUnit: lotSpecification.measurementUnit,
        },
      },
      pnlMethod: totalPnl === null
        ? "unavailable"
        : completeAuthoritativeCloseMoney
          ? "provider_close_detail_money_digits"
          : completeExplicitCents
            ? "provider_explicit_net_cents"
            : "provider_mixed_exact_money",
      // Only the explicitly vetted exact-money paths above may become the
      // canonical journal net. Generic Remote MCP commission/P&L aliases never
      // reach totalPnl and therefore remain provider_unavailable.
      pnlAuthority: totalPnl === null ? "provider_unavailable" : "provider",
      reconciledManualPnlPreserved: false,
      pnlComponentsCoverage: {
        version: 1,
        source: completeAuthoritativeCloseMoney
          ? "ProtoOAClosePositionDetail"
          : totalPnl === null ? "unavailable" : "RemoteMcpVettedExactNet",
        scope: "realized_closing_deals",
        tradeLevelExact: totalPnl !== null,
        grossProfit: completeAuthoritativeCloseMoney,
        brokerCommission: completeAuthoritativeCloseMoney,
        swap: completeAuthoritativeCloseMoney,
        pnlConversionFee: completeAuthoritativeCloseMoney,
        formula: completeAuthoritativeCloseMoney
          ? "grossProfit + swap + commission - pnlConversionFee"
          : totalPnl === null ? null : "provider_exact_net",
        otherAccountCashFlowsIncluded: false,
        otherAccountCashFlowsAttribution: "not_provided_by_position",
      },
      grossProfit: completeAuthoritativeCloseMoney ? sumScaledMoney(closing.map((deal) => ({
        value: deal.grossProfitScaled ?? 0n,
        digits: deal.moneyDigits ?? 0,
      }))) : null,
      commission: completeAuthoritativeCloseMoney ? sumScaledMoney(closing.map((deal) => ({
        value: deal.commissionScaled ?? 0n,
        digits: deal.moneyDigits ?? 0,
      }))) : mixedExactMoney ? null : sumOptionalCents(closing, "commissionCents"),
      swap: completeAuthoritativeCloseMoney ? sumScaledMoney(closing.map((deal) => ({
        value: deal.swapScaled ?? 0n,
        digits: deal.moneyDigits ?? 0,
      }))) : mixedExactMoney ? null : sumOptionalCents(closing, "swapCents"),
      pnlConversionFee: completeAuthoritativeCloseMoney ? sumScaledMoney(closing.map((deal) => ({
        value: deal.pnlConversionFeeScaled ?? 0n,
        digits: deal.moneyDigits ?? 0,
      }))) : null,
      realizedEvents,
      calculatedGrossPnl: calculatedGross?.calculatedGrossPnl ?? null,
      calculatedGrossCurrency: calculatedGross?.calculatedGrossCurrency ?? null,
      calculatedGrossMethod: calculatedGross?.calculatedGrossMethod ?? null,
      calculatedGrossEvents: calculatedGross?.calculatedGrossEvents ?? [],
      calculatedGrossProvenance: calculatedGross?.calculatedGrossProvenance ?? null,
      estimatedCommission,
      estimatedSwap,
      estimatedConversionFee,
      estimatedOtherCharges,
      estimatedFeesAndCharges,
      estimatedNetPnl,
      estimatedNetCurrency: estimatedNetPnl === null ? null : accountCurrency,
      estimatedNetMethod: estimatedNetPnl === null
        ? null
        : "remote_mcp_execution_commission_same_currency_v1",
      estimatedNetProvenance: estimatedNetPnl === null ? null : {
        version: 1,
        exact: false,
        source: "RemoteMcpGenericExecutionMoney",
        accountMoneyDigits: estimateDigits,
        accountCurrency,
        formula: "calculatedGrossPnl + estimatedCommission + estimatedSwap - estimatedConversionFee + estimatedOtherCharges",
        commission: {
          source: "sum_of_opening_and_closing_deal_commission",
          rawUnitsAssumedAtAccountMoneyDigits: true,
          executionCount: deals.length,
        },
        swap: observedSwapComplete
          ? { source: "sum_of_deal_swap", assumedZero: false }
          : { source: "same_provider_calendar_day_assumption", assumedZero: true },
        conversionFee: { source: "quote_deposit_currency_identity_assumption", assumedZero: true },
        otherCharges: { source: "not_exposed_by_remote_mcp", assumedZero: true },
        analyticsTreatment: "provisional_net_only",
      },
      accountCurrency,
      verifiedAccountSymbolOverride: symbol.verifiedOverride,
      classification: {
        symbolCategoryName: symbol.category,
        reviewNeeded: attestedBoundaryInference || (closing.length > 0 && totalPnl === null) || asset === null,
        lotSizeSource: symbol.lotSizeSource,
        quantityUnit,
        quantityLotsConversionAvailable: quantityLots !== null,
        openingLineage: explicitOpening[0] === first
          ? "provider"
          : attestedBoundaryInference
            ? floorKind === "historical_preview_empty_attested"
              ? "user_attested_empty_at_historical_boundary"
              : "user_attested_empty_at_connection"
            : "registration_bound",
      },
    },
  };
}

function dateValue(value: Date | string, field: string): number {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CTraderSyncError("CTRADER_HISTORICAL_IMPORT_INVALID", `Historical import has an invalid ${field}`, false);
  }
  return parsed;
}

function localDate(value: Date | string): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function finiteDecimal(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numericDifference(left: string | null, right: string | null): {
  absolute: number | null;
  relative: number | null;
} {
  const leftNumber = finiteDecimal(left);
  const rightNumber = finiteDecimal(right);
  if (leftNumber === null || rightNumber === null) return { absolute: null, relative: null };
  const absolute = Math.abs(leftNumber - rightNumber);
  const scale = Math.max(Math.abs(leftNumber), Math.abs(rightNumber), 1e-12);
  return { absolute, relative: absolute / scale };
}

function numericMatch(
  left: string | null,
  right: string | null,
  relativeTolerance: number,
  absoluteTolerance: number,
): boolean {
  if (left === null || right === null) return left === right;
  const difference = numericDifference(left, right);
  return difference.absolute !== null
    && difference.relative !== null
    && (difference.absolute <= absoluteTolerance || difference.relative <= relativeTolerance);
}

function historicalCandidateForPosition(
  projection: McpProjection,
  manualRows: readonly HistoricalManualTradeRow[],
): {
  classification: "high_confidence" | "ambiguous" | "deleted_manual" | "unmatched";
  confidence: number;
  manualTradeId: string | null;
  manualRowVersion: number | null;
  reasons: string[];
  differences: JsonRecord;
  candidateData: JsonRecord;
} {
  // Existing manual cTrader journals record quantity in lots. If this MCP
  // projection only has base units, even a same-symbol/date row is not a safe
  // duplicate candidate because its quantity identity cannot be compared.
  const plausible = projection.quantityLots === null ? [] : manualRows.filter((manual) =>
    reconciliationSymbolName(manual.symbol) === reconciliationSymbolName(projection.symbol)
    && manual.direction === projection.direction
    && localDate(manual.trade_date) === projection.tradeDate);
  const strict = plausible.filter((manual) =>
    numericMatch(manual.entry_price, projection.entryPrice, 0.0005, 0.00000001)
    && numericMatch(manual.exit_price, projection.exitPrice, 0.0005, 0.00000001)
    // Manual cTrader journals historically store lots. Never compare those
    // against an execution-only base-unit quantity as if they shared a unit.
    && projection.quantityLots !== null
    && numericMatch(manual.quantity, projection.quantityLots, 0.005, 0.00000001)
    && (manual.pnl === null || projection.pnl === null
      || numericMatch(manual.pnl, projection.pnl, 0.005, 0.01))
    && (manual.entry_at === null
      || Math.abs(dateValue(manual.entry_at, "manual entry time") - Date.parse(projection.entryAt)) <= 5 * 60 * 1_000)
    && (manual.exit_at === null || projection.exitAt === null
      || Math.abs(dateValue(manual.exit_at, "manual exit time") - Date.parse(projection.exitAt)) <= 5 * 60 * 1_000));
  const activeStrict = strict.filter((manual) => manual.deleted_at === null);
  const deletedStrict = strict.filter((manual) => manual.deleted_at !== null);
  const selected = activeStrict.length === 1 && strict.length === 1
    ? activeStrict[0]
    : activeStrict.length === 0 && deletedStrict.length === 1 && strict.length === 1
      ? deletedStrict[0]
      : null;
  const differences: JsonRecord = selected ? {
    entryPrice: numericDifference(selected.entry_price, projection.entryPrice),
    exitPrice: numericDifference(selected.exit_price, projection.exitPrice),
    quantity: numericDifference(selected.quantity, projection.quantityLots),
    pnl: numericDifference(selected.pnl, projection.pnl),
    entryTimeMs: selected.entry_at === null
      ? null
      : Math.abs(dateValue(selected.entry_at, "manual entry time") - Date.parse(projection.entryAt)),
    exitTimeMs: selected.exit_at === null || projection.exitAt === null
      ? null
      : Math.abs(dateValue(selected.exit_at, "manual exit time") - Date.parse(projection.exitAt)),
  } : {};
  const candidateIds = plausible.map((manual) => ({
    tradeId: manual.id,
    rowVersion: manual.row_version,
    deleted: manual.deleted_at !== null,
    strict: strict.some((candidate) => candidate.id === manual.id),
  }));
  const canPublishSeparate = projection.isOpen || projection.pnl !== null;
  if (activeStrict.length === 1 && strict.length === 1 && selected) {
    return {
      classification: "high_confidence",
      confidence: selected.entry_at === null ? 95 : 100,
      manualTradeId: selected.id,
      manualRowVersion: selected.row_version,
      reasons: ["unique_strict_manual_match", "same_account", "same_symbol_direction_date", "provider_values_within_strict_tolerance"],
      differences,
      candidateData: {
        manualCandidates: candidateIds,
        allowedActions: canPublishSeparate
          ? ["link_manual", "publish_separate", "reject"]
          : ["link_manual", "reject"],
        publishBlockedReason: canPublishSeparate ? null : "closed_provider_pnl_unavailable",
      },
    };
  }
  if (activeStrict.length === 0 && deletedStrict.length === 1 && strict.length === 1 && selected) {
    return {
      classification: "deleted_manual",
      confidence: 100,
      manualTradeId: selected.id,
      manualRowVersion: selected.row_version,
      reasons: ["unique_strict_deleted_manual_match", "deleted_trade_requires_explicit_suppression_review"],
      differences,
      candidateData: {
        manualCandidates: candidateIds,
        allowedActions: canPublishSeparate
          ? ["suppress_deleted", "publish_separate", "reject"]
          : ["suppress_deleted", "reject"],
        publishBlockedReason: canPublishSeparate ? null : "closed_provider_pnl_unavailable",
      },
    };
  }
  if (plausible.length > 0) {
    return {
      classification: "ambiguous",
      confidence: strict.length > 0 ? 70 : 40,
      manualTradeId: null,
      manualRowVersion: null,
      reasons: strict.length > 1
        ? ["multiple_strict_manual_matches", "manual_selection_required"]
        : ["plausible_manual_match_but_strict_identity_unproven", "manual_selection_required"],
      differences: {},
      candidateData: {
        manualCandidates: candidateIds,
        allowedActions: canPublishSeparate ? ["publish_separate", "reject"] : ["reject"],
        publishBlockedReason: canPublishSeparate ? null : "closed_provider_pnl_unavailable",
      },
    };
  }
  return {
    classification: "unmatched",
    confidence: 0,
    manualTradeId: null,
    manualRowVersion: null,
    reasons: ["no_manual_candidate_in_account_and_time_window"],
    differences: {},
    candidateData: {
      manualCandidates: [],
      allowedActions: canPublishSeparate ? ["publish_separate", "reject"] : ["reject"],
      publishBlockedReason: canPublishSeparate ? null : "closed_provider_pnl_unavailable",
    },
  };
}

function projectedTradeRecord(projection: McpProjection): JsonRecord {
  return {
    positionId: projection.positionId,
    symbol: projection.symbol,
    asset: projection.asset,
    direction: projection.direction,
    entryPrice: projection.entryPrice,
    exitPrice: projection.exitPrice,
    quantity: projection.quantity,
    quantityUnit: projection.quantityUnit,
    quantityLots: projection.quantityLots,
    quantityBaseUnits: projection.quantityBaseUnits,
    pnl: projection.pnl,
    isOpen: projection.isOpen,
    tradeDate: projection.tradeDate,
    entryAt: projection.entryAt,
    exitAt: projection.exitAt,
    entryTime: projection.entryTime,
    exitTime: projection.exitTime,
    brokerData: projection.brokerData,
  };
}

function localDateDistanceDays(left: Date | string, right: string): number | null {
  const parsedLeft = Date.parse(`${localDate(left)}T00:00:00.000Z`);
  const parsedRight = Date.parse(`${right}T00:00:00.000Z`);
  if (!Number.isFinite(parsedLeft) || !Number.isFinite(parsedRight)) return null;
  return Math.abs(parsedLeft - parsedRight) / (24 * 60 * 60 * 1_000);
}

function liveCandidateForPosition(
  projection: McpProjection,
  manualRows: readonly LiveManualTradeRow[],
): LiveReconciliationMatch {
  const exactDate = historicalCandidateForPosition(projection, manualRows);
  if (projection.quantityLots === null) return { ...exactDate, choices: [] };
  const exactChoices = manualRows.filter((manual) =>
    reconciliationSymbolName(manual.symbol) === reconciliationSymbolName(projection.symbol)
    && manual.direction === projection.direction
    && localDate(manual.trade_date) === projection.tradeDate);
  if (exactDate.classification !== "unmatched") return { ...exactDate, choices: exactChoices };

  // One-day drift is suggestion-only. It can occur when a manual date was
  // entered in local time while cTrader's execution crosses UTC midnight.
  // Never elevate it to high confidence or auto-link it.
  const adjacentChoices = manualRows.filter((manual) => {
    const dayDistance = localDateDistanceDays(manual.trade_date, projection.tradeDate);
    return dayDistance !== null && dayDistance <= 1
      && reconciliationSymbolName(manual.symbol) === reconciliationSymbolName(projection.symbol)
      && manual.direction === projection.direction
      && numericMatch(manual.entry_price, projection.entryPrice, 0.0005, 0.00000001)
      && numericMatch(manual.exit_price, projection.exitPrice, 0.0005, 0.00000001)
      && projection.quantityLots !== null
      && numericMatch(manual.quantity, projection.quantityLots, 0.005, 0.00000001);
  });
  if (adjacentChoices.length === 0) return { ...exactDate, choices: [] };
  return {
    classification: "ambiguous",
    confidence: adjacentChoices.length === 1 ? 60 : 40,
    manualTradeId: null,
    manualRowVersion: null,
    reasons: ["possible_manual_match_within_one_local_day", "explicit_manual_selection_required"],
    differences: {},
    choices: adjacentChoices,
  };
}

// Implementation is intentionally server-only. The browser never receives the
// trading-capable Remote MCP bearer token, and this adapter's dependency only
// exposes only the reviewed read calls above.
export class CTraderMcpSyncEngine {
  private readonly clientFactory: CTraderMcpReadClientFactory;

  constructor(
    private readonly database: Database,
    private readonly config: AppConfig,
    private readonly cipher: TokenCipher,
    private readonly events: EventBus,
    clientFactory?: CTraderMcpReadClientFactory,
  ) {
    this.clientFactory = clientFactory ?? ((token) => new CTraderMcpReadClient(token, {
      requestTimeoutMs: this.config.cTrader.requestTimeoutMs,
    }));
  }

  async syncConnection(
    connectionId: string,
    heartbeat: () => Promise<void> = async () => undefined,
  ): Promise<CTraderSyncResult> {
    const connection = await this.loadConnection(connectionId);
    const providerMetadata = objectValue(connection.provider_metadata);
    const operatorAccountAttestation = accountlessHistoryAttestation(connection, providerMetadata);
    const operatorSymbolOverrides = verifiedAccountSymbolOverrides(connection, providerMetadata);
    if (!connection.access_token_ciphertext) {
      throw new CTraderSyncError("CTRADER_REAUTH_REQUIRED", "Reconnect cTrader before syncing", false, true);
    }
    const bearerToken = this.cipher.decrypt(
      connection.access_token_ciphertext,
      connectionTokenAad(connection.id, "access"),
    );
    const client = this.clientFactory(bearerToken);
    try {
      const balanceRaw = await client.getBalance();
      await heartbeat();
      let assets = new Map<string, string>();
      let assetsAvailable = false;
      if (client.getAssets !== undefined) {
        try {
          assets = new Map(normalizeAssets(await client.getAssets()));
          assetsAvailable = true;
          await heartbeat();
        } catch (error) {
          if (!(error instanceof CTraderMcpError) || error.code !== "TOOL_UNAVAILABLE") throw error;
        }
      }
      const symbolsRaw = await client.getSymbols();
      await heartbeat();
      let accountInfoRaw: unknown = null;
      try {
        accountInfoRaw = await client.getAccountInfo();
      } catch (error) {
        if (!(error instanceof CTraderMcpError) || error.code !== "TOOL_UNAVAILABLE") throw error;
      }
      const sessionAccountVerified = verifiedAccountAttribution(
        [...accountMetadataObjects(balanceRaw), ...accountMetadataObjects(accountInfoRaw)],
        connection.external_account_id,
        () => new CTraderSyncError(
          "CTRADER_MCP_ACCOUNT_MISMATCH",
          "The cTrader credential no longer belongs to this connected account",
          false,
          true,
        ),
      );
      const symbols = applyVerifiedAccountSymbolOverrides(
        normalizeSymbols(symbolsRaw),
        operatorSymbolOverrides,
      );
      const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
      const cursorBefore = safeCursor(connection.sync_cursor);
      if (!hasValidNoOpenPositionsAttestation(connection, providerMetadata)) {
        throw new CTraderSyncError(
          "CTRADER_MCP_HISTORY_BOUND_MISSING",
          "Reconnect cTrader to establish a valid account-bound history boundary",
          false,
          true,
        );
      }
      const now = Date.now();
      const from = historyStart(this.config, cursorBefore, providerMetadata, now);
      let fetched = await this.fetchDeals(
        client,
        connection.external_account_id,
        from,
        now,
        heartbeat,
        {
          sessionAccountVerified,
          accountlessHistoryAttested: operatorAccountAttestation !== null,
        },
      );
      const enrichment = await this.enrichDealsFromPositionDetails(
        client,
        fetched,
        [
          ...positionsMissingAuthoritativePnl(fetched),
          ...await this.positionsNeedingPnlRefresh(connection),
        ],
        connection.external_account_id,
        sessionAccountVerified,
        operatorAccountAttestation !== null,
        true,
        heartbeat,
      );
      fetched = enrichment.deals;
      const currency = currencyContext(balanceRaw, accountInfoRaw, assets, assetsAvailable, providerMetadata);
      const result = await this.persist({
        connection,
        fetched,
        symbols,
        symbolById,
        cursorBefore,
        historyFloorTimestamp: metadataTimestamp(providerMetadata.historyFloorTimestamp) ?? from,
        queryFromTimestamp: from,
        syncedThroughTimestamp: now,
        currency,
        assetsAvailable,
        pnlEnrichment: enrichment.telemetry,
        operatorAccountAttestation,
        operatorSymbolOverrides,
      });
      await this.events.publish(connection.user_id, "ctrader.synced", {
        connectionId,
        mode: "mcp_read",
        counters: result.counters,
      }).catch(() => undefined);
      return result;
    } catch (error) {
      throw normalizeMcpError(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async previewHistoricalImport(
    importId: string,
    connectionId: string,
    heartbeat: () => Promise<void> = async () => undefined,
  ): Promise<CTraderSyncResult> {
    const previewDeadline = Date.now() + MAX_HISTORICAL_PREVIEW_ELAPSED_MS;
    const { historicalImport, connection } = await this.loadHistoricalImport(importId, connectionId);
    const cursorSnapshot = safeCursor(connection.sync_cursor);
    if (historicalImport.status === "review" || historicalImport.status === "completed") {
      return {
        userId: connection.user_id,
        connectionId: connection.id,
        counters: objectValue(historicalImport.counters) as CTraderHistoricalPreviewCounters,
        cursorBefore: cursorSnapshot,
        cursorAfter: cursorSnapshot,
      };
    }
    if (!["queued", "running"].includes(historicalImport.status)) {
      throw new CTraderSyncError(
        "CTRADER_HISTORICAL_IMPORT_UNAVAILABLE",
        "The historical cTrader preview is no longer runnable",
        false,
      );
    }
    if (!connection.access_token_ciphertext) {
      throw new CTraderSyncError("CTRADER_REAUTH_REQUIRED", "Reconnect cTrader before importing history", false, true);
    }
    const boundaryTimestamp = dateValue(historicalImport.boundary_at, "boundary");
    const throughTimestamp = dateValue(historicalImport.through_at, "upper boundary");
    if (
      boundaryTimestamp >= throughTimestamp
      || historicalImport.no_open_positions_attested !== true
      || Number(historicalImport.attestation_version) !== 1
      || historicalImport.attestation_purpose !== "historical_preview_reconciliation"
    ) {
      throw new CTraderSyncError(
        "CTRADER_HISTORICAL_ATTESTATION_INVALID",
        "The historical cTrader preview does not have a valid immutable flat-account attestation",
        false,
      );
    }
    const providerMetadata = objectValue(connection.provider_metadata);
    const operatorAccountAttestation = accountlessHistoryAttestation(connection, providerMetadata);
    const operatorSymbolOverrides = verifiedAccountSymbolOverrides(connection, providerMetadata);
    const normalHistoryFloor = metadataTimestamp(providerMetadata.historyFloorTimestamp);
    const requestedNormalFloor = dateValue(
      historicalImport.normal_history_floor_at_request,
      "approved normal history floor",
    );
    if (
      normalHistoryFloor === null
      || throughTimestamp !== requestedNormalFloor
      || requestedNormalFloor !== normalHistoryFloor
      || historicalImport.normal_history_floor_kind_at_request !== providerMetadata.historyFloorKind
      || historicalImport.normal_history_floor_kind_at_request !== "connection_time_empty_attested"
      || providerMetadata.historyReadValidated !== true
      || !hasValidNoOpenPositionsAttestation(connection, providerMetadata)
    ) {
      throw new CTraderSyncError(
        "CTRADER_HISTORICAL_BOUNDARY_CHANGED",
        "The historical cTrader preview upper bound no longer matches the approved normal history floor",
        false,
      );
    }
    const bearerToken = this.cipher.decrypt(
      connection.access_token_ciphertext,
      connectionTokenAad(connection.id, "access"),
    );
    const client = this.clientFactory(bearerToken);
    try {
      const balanceRaw = await client.getBalance();
      await heartbeat();
      let assets = new Map<string, string>();
      let assetsAvailable = false;
      if (client.getAssets !== undefined) {
        try {
          assets = new Map(normalizeAssets(await client.getAssets()));
          assetsAvailable = true;
          await heartbeat();
        } catch (error) {
          if (!(error instanceof CTraderMcpError) || error.code !== "TOOL_UNAVAILABLE") throw error;
        }
      }
      const symbolsRaw = await client.getSymbols();
      await heartbeat();
      let accountInfoRaw: unknown = null;
      try {
        accountInfoRaw = await client.getAccountInfo();
      } catch (error) {
        if (!(error instanceof CTraderMcpError) || error.code !== "TOOL_UNAVAILABLE") throw error;
      }
      const sessionAccountVerified = verifiedAccountAttribution(
        [...accountMetadataObjects(balanceRaw), ...accountMetadataObjects(accountInfoRaw)],
        historicalImport.external_account_id,
        () => new CTraderSyncError(
          "CTRADER_MCP_ACCOUNT_MISMATCH",
          "The cTrader credential no longer belongs to the historical import account",
          false,
          true,
        ),
      );
      const symbols = applyVerifiedAccountSymbolOverrides(
        normalizeSymbols(symbolsRaw),
        operatorSymbolOverrides,
      );
      const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
      let fetched = await this.fetchHistoricalPreviewDeals(
        client,
        historicalImport.external_account_id,
        boundaryTimestamp,
        throughTimestamp,
        heartbeat,
        previewDeadline,
        sessionAccountVerified,
        operatorAccountAttestation !== null,
      );
      const enrichment = await this.enrichDealsFromPositionDetails(
        client,
        fetched,
        positionsMissingAuthoritativePnl(fetched),
        historicalImport.external_account_id,
        sessionAccountVerified,
        operatorAccountAttestation !== null,
        false,
        heartbeat,
      );
      fetched = enrichment.deals;
      const currency = currencyContext(
        balanceRaw,
        accountInfoRaw,
        assets,
        assetsAvailable,
        objectValue(connection.provider_metadata),
      );
      const result = await this.persistHistoricalPreview({
        historicalImport,
        connection,
        fetched,
        symbols,
        symbolById,
        boundaryTimestamp,
        throughTimestamp,
        currency,
        assetsAvailable,
        pnlEnrichment: enrichment.telemetry,
        cursorSnapshot,
        previewDeadline,
        heartbeat,
        operatorAccountAttestation,
        operatorSymbolOverrides,
      });
      await this.events.publish(connection.user_id, "ctrader.historical_import.review_ready", {
        connectionId: connection.id,
        importId: historicalImport.id,
        counters: result.counters,
      }).catch(() => undefined);
      return result;
    } catch (error) {
      throw normalizeMcpError(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  private async loadHistoricalImport(
    importId: string,
    connectionId: string,
  ): Promise<{ historicalImport: HistoricalImportRow; connection: McpConnectionRow }> {
    const result = await this.database.query<HistoricalImportRow & McpConnectionRow>(
      `SELECT
         import.id, import.user_id, import.broker_connection_id,
         import.external_account_id, import.provider_environment,
         import.boundary_at, import.through_at,
         import.normal_history_floor_at_request,
         import.normal_history_floor_kind_at_request,
         import.boundary_local,
         import.time_zone, import.no_open_positions_attested,
         import.attestation_version, import.attestation_purpose,
         import.status, import.counters,
         connection.connected, connection.access_token_ciphertext,
         connection.encryption_key_version, connection.token_generation,
         connection.sync_cursor, connection.provider_metadata,
         connection.mapped_account_id, connection.legacy_mapped_account_id
       FROM ctrader_historical_imports import
       JOIN broker_connections connection
         ON connection.user_id=import.user_id
        AND connection.id=import.broker_connection_id
        AND connection.external_account_id=import.external_account_id
        AND connection.provider_environment=import.provider_environment
       WHERE import.id=$1 AND import.broker_connection_id=$2
         AND connection.provider='ctrader'
         AND connection.connection_mode='mcp_read'
         AND connection.oauth_scope='mcp_read'
       LIMIT 1`,
      [importId, connectionId],
    );
    const row = result.rows[0];
    if (!row || !row.connected) {
      throw new CTraderSyncError(
        "CTRADER_HISTORICAL_IMPORT_NOT_FOUND",
        "The account-bound historical cTrader preview is unavailable",
        false,
      );
    }
    const historicalImport: HistoricalImportRow = {
      id: row.id,
      user_id: row.user_id,
      broker_connection_id: row.broker_connection_id,
      external_account_id: row.external_account_id,
      provider_environment: row.provider_environment,
      boundary_at: row.boundary_at,
      through_at: row.through_at,
      normal_history_floor_at_request: row.normal_history_floor_at_request,
      normal_history_floor_kind_at_request: row.normal_history_floor_kind_at_request,
      boundary_local: row.boundary_local,
      time_zone: row.time_zone,
      no_open_positions_attested: row.no_open_positions_attested,
      attestation_version: row.attestation_version,
      attestation_purpose: row.attestation_purpose,
      status: row.status,
      counters: row.counters,
    };
    const connection: McpConnectionRow = {
      id: row.broker_connection_id,
      user_id: row.user_id,
      external_account_id: row.external_account_id,
      provider_environment: row.provider_environment,
      connected: row.connected,
      access_token_ciphertext: row.access_token_ciphertext,
      encryption_key_version: row.encryption_key_version,
      token_generation: row.token_generation,
      sync_cursor: row.sync_cursor,
      provider_metadata: row.provider_metadata,
      mapped_account_id: row.mapped_account_id,
      legacy_mapped_account_id: row.legacy_mapped_account_id,
    };
    return { historicalImport, connection };
  }

  private async loadConnection(connectionId: string): Promise<McpConnectionRow> {
    const result = await this.database.query<McpConnectionRow>(
      `SELECT id, user_id, external_account_id, provider_environment, connected,
              access_token_ciphertext, encryption_key_version, token_generation,
              sync_cursor, provider_metadata, mapped_account_id,
              legacy_mapped_account_id
       FROM broker_connections
       WHERE id=$1 AND provider='ctrader' AND connection_mode='mcp_read'
         AND oauth_scope='mcp_read' AND provider_environment IS NOT NULL
       LIMIT 1`,
      [connectionId],
    );
    const connection = result.rows[0];
    if (!connection || !connection.connected) {
      throw new CTraderSyncError("CTRADER_CONNECTION_NOT_FOUND", "The cTrader MCP connection is unavailable", false);
    }
    return connection;
  }

  private async positionsNeedingPnlRefresh(connection: McpConnectionRow): Promise<string[]> {
    const result = await this.database.query<{ external_position_id: string }>(
      `SELECT execution.external_position_id
       FROM trade_executions execution
       JOIN trades trade
         ON trade.user_id=execution.user_id
        AND trade.broker_connection_id=execution.broker_connection_id
        AND trade.external_trade_key=('position:' || execution.external_position_id)
       WHERE execution.user_id=$1 AND execution.broker_connection_id=$2
         AND execution.external_position_id IS NOT NULL
         AND trade.deleted_at IS NULL AND trade.is_open=false
         AND trade.broker_data->>'pnlMethod'='unavailable'
       GROUP BY execution.external_position_id
       ORDER BY max(execution.executed_at) DESC, execution.external_position_id ASC
       LIMIT $3`,
      [connection.user_id, connection.id, MAX_MCP_PNL_REFRESH_POSITIONS],
    );
    return result.rows.map((row) => row.external_position_id);
  }

  private async enrichDealsFromPositionDetails(
    client: CTraderMcpReadClientLike,
    deals: readonly McpDeal[],
    positionIds: readonly string[],
    accountId: string,
    sessionAccountVerified: boolean,
    accountlessHistoryAttested: boolean,
    includeMissingDeals: boolean,
    heartbeat: () => Promise<void>,
  ): Promise<{ deals: McpDeal[]; telemetry: McpPnlEnrichmentTelemetry }> {
    const requested = [...new Set(positionIds)].slice(0, MAX_MCP_PNL_REFRESH_POSITIONS);
    const telemetry: McpPnlEnrichmentTelemetry = {
      version: 1,
      requestedPositions: requested.length,
      attemptedPositions: 0,
      successfulResponses: 0,
      positionDetailsAvailable: requested.length === 0 ? null : client.getPositionDetails !== undefined,
      authoritativePositions: 0,
      unresolvedPositions: requested.length,
    };
    if (client.getPositionDetails === undefined || requested.length === 0) return { deals: [...deals], telemetry };
    const byId = new Map(deals.map((deal) => [deal.dealId, deal]));
    for (const positionId of requested) {
      let raw: unknown;
      telemetry.attemptedPositions += 1;
      try { raw = await client.getPositionDetails(positionId); } catch (error) {
        if (error instanceof CTraderMcpError && error.code === "TOOL_UNAVAILABLE") {
          telemetry.positionDetailsAvailable = false;
          break;
        }
        throw error;
      }
      telemetry.successfulResponses += 1;
      const responseAccountVerified = historyResponseHasVerifiedAccount(
        raw,
        accountId,
        POSITION_DETAIL_ACCOUNT_METADATA_WRAPPER_KEYS,
      );
      const rows = unwrapArray(raw, ["deals", "data", "result", "items", "history"], "position details");
      for (const row of rows) {
        if (isExplicitNonFilledZeroVolumeDeal(row)) continue;
        const detail = normalizeDeal(row, "provider");
        if (detail.positionId !== positionId) {
          throw new CTraderSyncError(
            "CTRADER_MCP_DEAL_INVALID",
            "cTrader position details returned a deal for a different position",
            false,
          );
        }
        if (detail.accountId !== null && detail.accountId !== accountId) throw accountHistoryMismatch();
        if (
          detail.accountId === null
          && !responseAccountVerified
          && !sessionAccountVerified
          && !accountlessHistoryAttested
        ) {
          throw new CTraderSyncError(
            "CTRADER_MCP_ACCOUNT_ATTRIBUTION_MISSING",
            `cTrader deal ${detail.dealId} has no account attribution`,
            false,
          );
        }
        const attributed = detail.accountId === null ? { ...detail, accountId } : detail;
        const previous = byId.get(attributed.dealId);
        if (previous === undefined) {
          if (includeMissingDeals) byId.set(attributed.dealId, attributed);
          continue;
        }
        byId.set(attributed.dealId, mergeDealFacts(previous, attributed));
      }
      await heartbeat();
    }
    const enriched = [...byId.values()].sort((left, right) =>
      left.executionTimestamp - right.executionTimestamp || compareDealIds(left.dealId, right.dealId));
    const missing = new Set(positionsMissingAuthoritativePnl(enriched));
    telemetry.authoritativePositions = requested.filter((positionId) => {
      const positionDeals = enriched.filter((deal) => deal.positionId === positionId);
      return positionDeals.length > 0
        && !missing.has(positionId)
        && positionDeals.some((deal) => deal.pnlCents !== null || deal.moneyDigits !== null);
    }).length;
    telemetry.unresolvedPositions = requested.length - telemetry.authoritativePositions;
    return { deals: enriched, telemetry };
  }

  private async fetchDeals(
    client: CTraderMcpReadClientLike,
    accountId: string,
    fromTimestamp: number,
    toTimestamp: number,
    heartbeat: () => Promise<void>,
    options: {
      splitIncompletePages?: boolean;
      absoluteDeadline?: number | null;
      maximumWindowMs?: number;
      sharedBudget?: HistoricalFetchBudget | null;
      sessionAccountVerified?: boolean;
      accountlessHistoryAttested?: boolean;
    } = {},
  ): Promise<McpDeal[]> {
    const {
      splitIncompletePages = false,
      absoluteDeadline = null,
      maximumWindowMs = MAX_HISTORY_WINDOW_MS,
      sharedBudget = null,
      sessionAccountVerified = false,
      accountlessHistoryAttested = false,
    } = options;
    const byId = new Map<string, McpDeal>();
    const budget = sharedBudget ?? {
      deadline: absoluteDeadline ?? Date.now() + MAX_HISTORICAL_PREVIEW_ELAPSED_MS,
      requestCount: 0,
      processedDeals: 0,
    };
    const enforcePreviewBudget = (depth: number): void => {
      if (!splitIncompletePages) return;
      if (
        budget.requestCount > MAX_HISTORICAL_PREVIEW_REQUESTS
        || depth > MAX_HISTORICAL_PREVIEW_SPLIT_DEPTH
        || budget.processedDeals > MAX_HISTORICAL_PREVIEW_DEALS
        || Date.now() > budget.deadline
      ) {
        throw new CTraderSyncError(
          "CTRADER_HISTORICAL_IMPORT_BUDGET_EXCEEDED",
          "The historical cTrader preview exceeded its safe processing budget",
          false,
        );
      }
    };
    const fetchWindow = async (start: number, end: number, depth = 0): Promise<void> => {
      if (splitIncompletePages && depth > 0 && end - start <= 1) {
        throw new CTraderSyncError(
          "CTRADER_MCP_HISTORY_SATURATED",
          "cTrader history is saturated within one millisecond and cannot be imported losslessly",
          false,
        );
      }
      budget.requestCount += 1;
      enforcePreviewBudget(depth);
      const raw = await client.getDeals({
        fromTimestamp: new Date(start).toISOString(),
        // Provider history ranges are inclusive at both ends. Convert our
        // canonical half-open [start,end) window to an inclusive millisecond
        // upper bound so adjacent validation partitions neither overlap nor
        // omit a boundary execution.
        toTimestamp: new Date(splitIncompletePages ? end - 1 : end).toISOString(),
      });
      enforcePreviewBudget(depth);
      if (splitIncompletePages && historyPageIsIncomplete(raw)) {
        if (end - start <= 1) {
          throw new CTraderSyncError(
            "CTRADER_MCP_HISTORY_SATURATED",
            "cTrader history is saturated within one millisecond and cannot be imported losslessly",
            false,
          );
        }
        const midpoint = start + Math.floor((end - start) / 2);
        await fetchWindow(start, midpoint, depth + 1);
        await fetchWindow(midpoint, end, depth + 1);
        enforcePreviewBudget(depth);
        return;
      }
      assertCompleteHistoryPage(raw);
      // Prefer explicit same-session or response-envelope attribution. Some
      // per-account Remote MCP tokens omit account fields from every read
      // response; only the separately operator-attested connection may inherit
      // identity in that shape. Every explicit identifier still fails closed
      // on a mismatch, regardless of the attestation.
      const responseAccountVerified = historyResponseHasVerifiedAccount(raw, accountId);
      const rows = unwrapArray(raw, ["deals", "data", "result", "items", "history"], "deal history");
      for (const row of rows) {
        if (isExplicitNonFilledZeroVolumeDeal(row)) continue;
        if (splitIncompletePages) {
          budget.processedDeals += 1;
          enforcePreviewBudget(depth);
        }
        const normalizedDeal = normalizeDeal(row, "provider");
        if (
          normalizedDeal.executionTimestamp < start
          || (splitIncompletePages ? normalizedDeal.executionTimestamp >= end : normalizedDeal.executionTimestamp > end)
        ) {
          throw new CTraderSyncError(
            "CTRADER_MCP_DEAL_OUTSIDE_WINDOW",
            `cTrader deal ${normalizedDeal.dealId} falls outside the immutable requested history window`,
            false,
          );
        }
        if (normalizedDeal.accountId !== null && normalizedDeal.accountId !== accountId) {
          throw accountHistoryMismatch();
        }
        if (
          normalizedDeal.accountId === null
          && !responseAccountVerified
          && !sessionAccountVerified
          && !accountlessHistoryAttested
        ) {
          throw new CTraderSyncError(
            "CTRADER_MCP_ACCOUNT_ATTRIBUTION_MISSING",
            `cTrader deal ${normalizedDeal.dealId} has no account attribution`,
            false,
          );
        }
        const deal: McpDeal = normalizedDeal.accountId === null
          ? { ...normalizedDeal, accountId }
          : normalizedDeal;
        const previous = byId.get(deal.dealId);
        byId.set(deal.dealId, previous === undefined ? deal : mergeDealFacts(previous, deal));
      }
      await heartbeat();
      enforcePreviewBudget(depth);
    };
    let cursor = Math.max(0, Math.min(fromTimestamp, toTimestamp - 1));
    while (cursor < toTimestamp) {
      const end = Math.min(cursor + maximumWindowMs, toTimestamp);
      await fetchWindow(cursor, end);
      cursor = end;
    }
    return [...byId.values()].sort((left, right) =>
      left.executionTimestamp - right.executionTimestamp || compareDealIds(left.dealId, right.dealId));
  }

  private async fetchHistoricalPreviewDeals(
    client: CTraderMcpReadClientLike,
    accountId: string,
    fromTimestamp: number,
    toTimestamp: number,
    heartbeat: () => Promise<void>,
    deadline: number,
    sessionAccountVerified: boolean,
    accountlessHistoryAttested: boolean,
  ): Promise<McpDeal[]> {
    const budget: HistoricalFetchBudget = { deadline, requestCount: 0, processedDeals: 0 };
    const fullRangePlan = await this.fetchDeals(
      client,
      accountId,
      fromTimestamp,
      toTimestamp,
      heartbeat,
      {
        splitIncompletePages: true,
        absoluteDeadline: deadline,
        maximumWindowMs: MAX_HISTORY_WINDOW_MS,
        sharedBudget: budget,
        sessionAccountVerified,
        accountlessHistoryAttested,
      },
    );
    const partitionPlan = await this.fetchDeals(
      client,
      accountId,
      fromTimestamp,
      toTimestamp,
      heartbeat,
      {
        splitIncompletePages: true,
        absoluteDeadline: deadline,
        maximumWindowMs: 60 * 60 * 1_000,
        sharedBudget: budget,
        sessionAccountVerified,
        accountlessHistoryAttested,
      },
    );
    const partitionById = new Map(partitionPlan.map((deal) => [deal.dealId, deal]));
    if (
      fullRangePlan.length !== partitionPlan.length
      || fullRangePlan.some((deal) => !partitionById.has(deal.dealId))
    ) {
      throw new CTraderSyncError(
        "CTRADER_HISTORICAL_IMPORT_INCOMPLETE",
        "cTrader returned inconsistent historical results; no preview data was staged",
        false,
      );
    }
    try {
      return fullRangePlan.map((deal) => mergeDealFacts(deal, partitionById.get(deal.dealId) as McpDeal));
    } catch (error) {
      if (error instanceof CTraderSyncError && error.code === "CTRADER_MCP_DUPLICATE_DEAL_CONFLICT") {
        throw new CTraderSyncError(
          "CTRADER_HISTORICAL_IMPORT_INCOMPLETE",
          "cTrader returned inconsistent historical results; no preview data was staged",
          false,
        );
      }
      throw error;
    }
  }

  private async persistHistoricalPreview(input: {
    historicalImport: HistoricalImportRow;
    connection: McpConnectionRow;
    fetched: McpDeal[];
    symbols: McpSymbol[];
    symbolById: ReadonlyMap<string, McpSymbol>;
    boundaryTimestamp: number;
    throughTimestamp: number;
    currency: McpCurrencyContext;
    assetsAvailable: boolean;
    pnlEnrichment: McpPnlEnrichmentTelemetry;
    cursorSnapshot: JsonRecord;
    previewDeadline: number;
    heartbeat: () => Promise<void>;
    operatorAccountAttestation: AccountlessHistoryAttributionAttestation | null;
    operatorSymbolOverrides: VerifiedAccountSymbolOverrideSnapshot;
  }): Promise<CTraderSyncResult> {
    const counters = await withTransaction(this.database, async (client) => {
      const enforcePersistenceDeadline = (): void => {
        if (Date.now() > input.previewDeadline) {
          throw new CTraderSyncError(
            "CTRADER_HISTORICAL_IMPORT_BUDGET_EXCEEDED",
            "The historical cTrader preview exceeded its safe processing budget",
            false,
          );
        }
      };
      enforcePersistenceDeadline();
      await lockAndValidateMappedAccountCurrency(client, {
        userId: input.connection.user_id,
        mappedAccountId: input.connection.mapped_account_id,
        legacyMappedAccountId: input.connection.legacy_mapped_account_id,
        providerCurrency: input.currency.accountCurrency,
      });
      const locked = await client.query<LockedMcpConnectionAttestationRow & {
        status: HistoricalImportRow["status"];
        counters: unknown;
        sync_cursor: unknown;
      }>(
        `SELECT import.status, import.counters, connection.token_generation,
                connection.connected, connection.sync_cursor,
                connection.id AS connection_id,
                connection.user_id AS connection_user_id,
                connection.external_account_id,
                connection.provider_environment,
                connection.provider_metadata,
                connection.mapped_account_id,
                connection.legacy_mapped_account_id
         FROM ctrader_historical_imports import
         JOIN broker_connections connection
           ON connection.user_id=import.user_id
          AND connection.id=import.broker_connection_id
          AND connection.external_account_id=import.external_account_id
          AND connection.provider_environment=import.provider_environment
         WHERE import.id=$1 AND import.user_id=$2
           AND import.broker_connection_id=$3
           AND import.external_account_id=$4
           AND import.provider_environment=$5
           AND import.boundary_at=$6 AND import.through_at=$7
           AND import.no_open_positions_attested=true
           AND import.attestation_version=1
           AND import.attestation_purpose='historical_preview_reconciliation'
           AND connection.connection_mode='mcp_read'
           AND connection.oauth_scope='mcp_read'
         FOR UPDATE OF import, connection`,
        [
          input.historicalImport.id,
          input.connection.user_id,
          input.connection.id,
          input.connection.external_account_id,
          input.connection.provider_environment,
          new Date(input.boundaryTimestamp),
          new Date(input.throughTimestamp),
        ],
      );
      const state = locked.rows[0];
      if (!state || !state.connected) {
        throw new CTraderSyncError(
          "CTRADER_HISTORICAL_IMPORT_CHANGED",
          "The historical cTrader preview identity changed before it could be staged",
          false,
        );
      }
      if (String(state.token_generation) !== String(input.connection.token_generation)) {
        throw new CTraderSyncError(
          "CTRADER_CONNECTION_CHANGED",
          "The cTrader connection changed during historical preview",
          true,
        );
      }
      if (state.mapped_account_id !== input.connection.mapped_account_id
        || state.legacy_mapped_account_id !== input.connection.legacy_mapped_account_id) {
        throw new CTraderSyncError(
          "CTRADER_ACCOUNT_MAPPING_CHANGED",
          "The mapped Edgebook account changed during the cTrader historical preview; retry with the current mapping",
          true,
        );
      }
      assertAccountlessHistoryAttestationUnchanged(state, input.operatorAccountAttestation);
      assertVerifiedAccountSymbolOverridesUnchanged(state, input.operatorSymbolOverrides);
      // A replay of an already-committed preview is a read-only success. This
      // protects a run whose final worker acknowledgement was lost.
      if (state.status === "review" || state.status === "completed") {
        return objectValue(state.counters) as CTraderHistoricalPreviewCounters;
      }
      if (!["queued", "running"].includes(state.status)) {
        throw new CTraderSyncError(
          "CTRADER_HISTORICAL_IMPORT_UNAVAILABLE",
          "The historical cTrader preview is no longer runnable",
          false,
        );
      }
      // Never allow this preview transaction to become a disguised cursor
      // rewind. The cursor is checked again while the connection row is locked
      // and is intentionally never updated below.
      if (json(safeCursor(state.sync_cursor)) !== json(input.cursorSnapshot)) {
        throw new CTraderSyncError(
          "CTRADER_NORMAL_SYNC_MOVED",
          "The normal cTrader cursor moved while the historical preview was running; retry the preview safely",
          true,
        );
      }

      const verifiedSymbols = input.symbols.filter((symbol) => symbol.verifiedOverride !== null);
      if (verifiedSymbols.length > 0) {
        await this.upsertSymbols(client, input.connection, verifiedSymbols);
      }

      const previewCounters: CTraderHistoricalPreviewCounters = {
        inserted: 0,
        updated: 0,
        fetchedDeals: input.fetched.length,
        insertedExecutions: 0,
        updatedExecutions: 0,
        insertedTrades: 0,
        updatedTrades: 0,
        unchangedTrades: 0,
        archivedTradesPreserved: 0,
        tombstonesPreserved: 0,
        positionsProjected: 0,
        positionsAwaitingReview: 0,
        positionsStaged: 0,
        highConfidence: 0,
        ambiguous: 0,
        deletedManual: 0,
        unmatched: 0,
        executionOnly: 0,
        providerReadTelemetry: {
          version: 1,
          assetsAvailable: input.assetsAvailable,
          assetCount: input.currency.assetNames.size,
          currencyResolved: input.currency.accountCurrency !== null,
          pnlEnrichment: input.pnlEnrichment,
        },
      };
      const externalExecutionIds = input.fetched.map((deal) => deal.dealId);
      const existingExecutionRows = externalExecutionIds.length === 0
        ? []
        : (await client.query<{ external_execution_id: string; raw_payload: unknown }>(
            `SELECT external_execution_id, raw_payload FROM trade_executions
             WHERE user_id=$1 AND broker_connection_id=$2
               AND external_execution_id=ANY($3::text[])`,
            [input.connection.user_id, input.connection.id, externalExecutionIds],
          )).rows;
      const existingExecutions = new Set(existingExecutionRows.map((row) => row.external_execution_id));
      const storedExecutionFacts = new Map(existingExecutionRows.flatMap((row) => {
        if (row.raw_payload === undefined || row.raw_payload === null) return [];
        try { return [[row.external_execution_id, normalizeDeal(row.raw_payload, "stored")] as const]; } catch {
          throw new CTraderSyncError(
            "CTRADER_MCP_STORED_DEAL_INVALID",
            `Stored cTrader execution ${row.external_execution_id} is invalid`,
            false,
          );
        }
      }));
      const mergedFetched = input.fetched.map((deal) => {
        const stored = storedExecutionFacts.get(deal.dealId);
        return stored === undefined ? deal : mergeDealFacts(stored, deal);
      });

      for (const [dealIndex, deal] of mergedFetched.entries()) {
        enforcePersistenceDeadline();
        if (dealIndex > 0 && dealIndex % 100 === 0) await input.heartbeat();
        const rawPayload = { edgebookMcpDeal: canonicalStoredDeal(deal) };
        const money = executionMoneyValues(deal);
        const stored = await client.query<{ id: string }>(
          `INSERT INTO trade_executions (
             id, user_id, broker_connection_id, external_execution_id,
             external_position_id, external_order_id, external_symbol_id,
             side, quantity, price, pnl, commission, swap, currency_code,
             executed_at, raw_payload, deal_status, filled_volume_cents,
             closed_volume_cents, money_digits, close_position_detail,
             provider_updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,
             $17,$18,NULL,$19,$20::jsonb,$21
           )
           ON CONFLICT (broker_connection_id, external_execution_id) DO UPDATE SET
             external_position_id=EXCLUDED.external_position_id,
             external_order_id=EXCLUDED.external_order_id,
             external_symbol_id=EXCLUDED.external_symbol_id,
             side=EXCLUDED.side,
             quantity=EXCLUDED.quantity,
             price=EXCLUDED.price,
             pnl=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.pnl ELSE EXCLUDED.pnl END,
             commission=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.commission ELSE EXCLUDED.commission END,
             swap=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.swap ELSE EXCLUDED.swap END,
             currency_code=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.currency_code ELSE EXCLUDED.currency_code END,
             executed_at=EXCLUDED.executed_at,
             raw_payload=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN jsonb_set(
                   EXCLUDED.raw_payload,
                   '{edgebookMcpDeal}',
                   (trade_executions.raw_payload->'edgebookMcpDeal')
                     || ((EXCLUDED.raw_payload->'edgebookMcpDeal')
                       - 'netPnlCents' - 'commissionCents' - 'swapCents' - 'closePositionDetail')
                 )
               ELSE EXCLUDED.raw_payload END,
             deal_status=EXCLUDED.deal_status,
             filled_volume_cents=EXCLUDED.filled_volume_cents,
             closed_volume_cents=NULL,
             money_digits=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.money_digits ELSE EXCLUDED.money_digits END,
             close_position_detail=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.close_position_detail ELSE EXCLUDED.close_position_detail END,
             provider_updated_at=EXCLUDED.provider_updated_at,
             imported_at=now()
           WHERE trade_executions.user_id=EXCLUDED.user_id
             AND trade_executions.raw_payload IS DISTINCT FROM EXCLUDED.raw_payload
           RETURNING id`,
          [
            randomUUID(),
            input.connection.user_id,
            input.connection.id,
            deal.dealId,
            deal.positionId,
            deal.orderId,
            deal.symbolId,
            deal.side,
            decimal(Number(deal.filledVolumeCents) / 100),
            decimal(deal.executionPrice),
            money.pnl,
            money.commission,
            money.swap,
            input.currency.accountCurrency,
            new Date(deal.executionTimestamp),
            json(rawPayload),
            deal.dealStatus,
            deal.filledVolumeCents.toString(),
            money.moneyDigits,
            money.closePositionDetail,
            deal.providerUpdatedTimestamp === null ? null : new Date(deal.providerUpdatedTimestamp),
          ],
        );
        let executionId = stored.rows[0]?.id ?? null;
        if (executionId === null) {
          executionId = (await client.query<{ id: string }>(
            `SELECT id FROM trade_executions
             WHERE user_id=$1 AND broker_connection_id=$2 AND external_execution_id=$3
             LIMIT 1`,
            [input.connection.user_id, input.connection.id, deal.dealId],
          )).rows[0]?.id ?? null;
        }
        if (executionId === null) {
          throw new CTraderSyncError(
            "CTRADER_HISTORICAL_EXECUTION_MISSING",
            "A historical cTrader execution could not be staged safely",
            true,
          );
        }
        await client.query(
          `INSERT INTO ctrader_historical_import_executions (
             user_id, broker_connection_id, import_id, execution_id
           ) VALUES ($1,$2,$3,$4)
           ON CONFLICT (user_id, import_id, execution_id) DO NOTHING`,
          [input.connection.user_id, input.connection.id, input.historicalImport.id, executionId],
        );
        if (existingExecutions.has(deal.dealId)) previewCounters.updatedExecutions += 1;
        else previewCounters.insertedExecutions += 1;
      }

      const boundaryDate = input.historicalImport.boundary_local.slice(0, 10);
      const throughDate = localDateTime(
        Math.max(input.boundaryTimestamp, input.throughTimestamp - 1),
        input.historicalImport.time_zone,
      ).date;
      const manualRows = (await client.query<HistoricalManualTradeRow>(
        `SELECT id, row_version, deleted_at, symbol, direction,
                entry_price::text, exit_price::text, quantity::text, pnl::text,
                trade_date, entry_at, exit_at
         FROM trades
         WHERE user_id=$1
           AND broker_connection_id IS NULL
           AND external_trade_key IS NULL
           AND source_system <> 'ctrader'
           AND trade_date BETWEEN $2::date AND $3::date
           AND (
             ($4::uuid IS NOT NULL AND account_id=$4::uuid)
             OR ($4::uuid IS NULL AND $5::text IS NOT NULL AND legacy_account_id=$5::text)
           )
         ORDER BY trade_date ASC, created_at ASC, id ASC
         LIMIT $6`,
        [
          input.connection.user_id,
          boundaryDate,
          throughDate,
          input.connection.mapped_account_id,
          input.connection.legacy_mapped_account_id,
          MAX_HISTORICAL_MANUAL_CANDIDATES + 1,
        ],
      )).rows;
      if (manualRows.length > MAX_HISTORICAL_MANUAL_CANDIDATES) {
        throw new CTraderSyncError(
          "CTRADER_HISTORICAL_IMPORT_BUDGET_EXCEEDED",
          "The historical cTrader preview exceeded its safe processing budget",
          false,
        );
      }
      const grouped = new Map<string, McpDeal[]>();
      for (const deal of mergedFetched) {
        const group = grouped.get(deal.positionId) ?? [];
        group.push(deal);
        grouped.set(deal.positionId, group);
      }
      if (grouped.size > MAX_HISTORICAL_PREVIEW_POSITIONS) {
        throw new CTraderSyncError(
          "CTRADER_HISTORICAL_IMPORT_BUDGET_EXCEEDED",
          "The historical cTrader preview exceeded its safe processing budget",
          false,
        );
      }

      // If a prior uncommitted worker attempt was externally interrupted after
      // staging in a non-transactional test double, rebuild pending candidates
      // deterministically. Resolved candidates are never touched.
      await client.query(
        `DELETE FROM ctrader_reconciliation_candidates
         WHERE user_id=$1 AND broker_connection_id=$2 AND import_id=$3
           AND status='pending'`,
        [input.connection.user_id, input.connection.id, input.historicalImport.id],
      );
      let positionIndex = 0;
      for (const [positionId, positionDeals] of grouped) {
        enforcePersistenceDeadline();
        if (positionIndex > 0 && positionIndex % 25 === 0) await input.heartbeat();
        positionIndex += 1;
        const orderedDeals = [...positionDeals].sort((left, right) =>
          left.executionTimestamp - right.executionTimestamp || compareDealIds(left.dealId, right.dealId));
        const first = orderedDeals[0];
        if (!first) continue;
        const externalTradeKey = `position:${positionId}`;
        const identityConflict = await client.query<{
          existing_trade_id: string | null;
          existing_trade_deleted_at: Date | string | null;
          existing_link_trade_id: string | null;
          tombstoned: boolean;
        }>(
          `SELECT
             (SELECT trade.id FROM trades trade
              WHERE trade.user_id=$1 AND trade.broker_connection_id=$2
                AND trade.external_trade_key=$3
              LIMIT 1) AS existing_trade_id,
             (SELECT trade.deleted_at FROM trades trade
              WHERE trade.user_id=$1 AND trade.broker_connection_id=$2
                AND trade.external_trade_key=$3
              LIMIT 1) AS existing_trade_deleted_at,
             (SELECT link.trade_id FROM ctrader_trade_links link
              WHERE link.user_id=$1 AND link.broker_connection_id=$2
                AND link.external_trade_key=$3
              LIMIT 1) AS existing_link_trade_id,
             EXISTS(
               SELECT 1 FROM ctrader_trade_tombstones tombstone
               WHERE tombstone.user_id=$1 AND tombstone.broker_connection_id=$2
                 AND tombstone.external_trade_key=$3
             ) AS tombstoned`,
          [input.connection.user_id, input.connection.id, externalTradeKey],
        );
        const conflict = identityConflict.rows[0];
        if (conflict?.tombstoned || conflict?.existing_trade_id || conflict?.existing_link_trade_id) {
          const reasons = conflict.tombstoned
            ? ["broker_tombstone_exists", "historical_preview_cannot_resurrect_deleted_intent"]
            : conflict.existing_link_trade_id
              ? ["broker_position_already_linked", "normal_sync_identity_already_resolved"]
              : conflict.existing_trade_deleted_at
                ? ["broker_position_already_archived", "historical_preview_cannot_resurrect_deleted_intent"]
                : ["already_imported_normal_sync", "normal_sync_identity_already_exists"];
          await client.query(
            `INSERT INTO ctrader_reconciliation_candidates (
               id, user_id, broker_connection_id, import_id,
               external_position_id, external_trade_key,
               classification, confidence, reasons, differences,
               candidate_data, projected_trade, status
             ) VALUES ($1,$2,$3,$4,$5,$6,'execution_only',100,$7::jsonb,'{}'::jsonb,$8::jsonb,NULL,'pending')
             ON CONFLICT (user_id, broker_connection_id, import_id, external_position_id)
             DO UPDATE SET classification='execution_only', confidence=100,
               reasons=EXCLUDED.reasons, differences='{}'::jsonb,
               candidate_data=EXCLUDED.candidate_data, projected_trade=NULL,
               manual_trade_id=NULL, manual_row_version=NULL,
               row_version=ctrader_reconciliation_candidates.row_version+1
             WHERE ctrader_reconciliation_candidates.status='pending'`,
            [
              randomUUID(),
              input.connection.user_id,
              input.connection.id,
              input.historicalImport.id,
              positionId,
              externalTradeKey,
              json(reasons),
              json({
                accountId: input.connection.external_account_id,
                environment: input.connection.provider_environment,
                externalPositionId: positionId,
                executionIds: orderedDeals.map((deal) => deal.dealId),
                completeWindow: true,
                existingTradeId: conflict.existing_trade_id,
                existingLinkTradeId: conflict.existing_link_trade_id,
                tombstoned: conflict.tombstoned,
                allowedActions: ["reject"],
              }),
            ],
          );
          previewCounters.positionsStaged += 1;
          previewCounters.executionOnly += 1;
          previewCounters.positionsAwaitingReview += 1;
          continue;
        }
        const symbol = input.symbolById.get(first.symbolId);
        let projection: McpProjection | null = null;
        let executionOnlyReason: string | null = null;
        if (!symbol) executionOnlyReason = "CTRADER_MCP_SYMBOL_UNAVAILABLE";
        else {
          try {
            projection = projectMcpPosition(
              orderedDeals,
              symbol,
              input.historicalImport.time_zone,
              input.currency,
              "historical_preview_empty_attested",
            );
          } catch (error) {
            executionOnlyReason = projectionReviewReason(error);
            if (executionOnlyReason === null) throw error;
          }
        }
        let classification: "high_confidence" | "ambiguous" | "deleted_manual" | "unmatched" | "execution_only";
        let confidence = 0;
        let manualTradeId: string | null = null;
        let manualRowVersion: number | null = null;
        let reasons: string[];
        let differences: JsonRecord = {};
        let candidateData: JsonRecord;
        let projectedTrade: JsonRecord | null = null;
        if (executionOnlyReason !== null || projection === null) {
          classification = "execution_only";
          reasons = [executionOnlyReason ?? "CTRADER_MCP_PROJECTION_INCOMPLETE", "financial_values_not_guessed"];
          candidateData = {
            accountId: input.connection.external_account_id,
            environment: input.connection.provider_environment,
            externalPositionId: positionId,
            executionIds: orderedDeals.map((deal) => deal.dealId),
            completeWindow: true,
            partialProjection: projection,
            allowedActions: ["reject"],
          };
        } else {
          const match = historicalCandidateForPosition(projection, manualRows);
          classification = match.classification;
          confidence = match.confidence;
          manualTradeId = match.manualTradeId;
          manualRowVersion = match.manualRowVersion;
          reasons = match.reasons;
          differences = match.differences;
          candidateData = {
            ...match.candidateData,
            accountId: input.connection.external_account_id,
            environment: input.connection.provider_environment,
            externalPositionId: positionId,
            executionIds: orderedDeals.map((deal) => deal.dealId),
            completeWindow: true,
          };
          projectedTrade = {
            positionId: projection.positionId,
            symbol: projection.symbol,
            asset: projection.asset,
            direction: projection.direction,
            entryPrice: projection.entryPrice,
            exitPrice: projection.exitPrice,
            quantity: projection.quantity,
            quantityUnit: projection.quantityUnit,
            quantityLots: projection.quantityLots,
            quantityBaseUnits: projection.quantityBaseUnits,
            pnl: projection.pnl,
            isOpen: projection.isOpen,
            tradeDate: projection.tradeDate,
            entryAt: projection.entryAt,
            exitAt: projection.exitAt,
            entryTime: projection.entryTime,
            exitTime: projection.exitTime,
            brokerData: {
              ...projection.brokerData,
              environment: input.connection.provider_environment,
              ctidTraderAccountId: input.connection.external_account_id,
              historicalImportId: input.historicalImport.id,
              historicalPreview: true,
            },
          };
        }
        await client.query(
          `INSERT INTO ctrader_reconciliation_candidates (
             id, user_id, broker_connection_id, import_id,
             external_position_id, external_trade_key,
             manual_trade_id, manual_row_version, classification, confidence,
             reasons, differences, candidate_data, projected_trade, status
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
             $11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,'pending'
           )
           ON CONFLICT (user_id, broker_connection_id, import_id, external_position_id)
           DO UPDATE SET
             external_trade_key=EXCLUDED.external_trade_key,
             manual_trade_id=EXCLUDED.manual_trade_id,
             manual_row_version=EXCLUDED.manual_row_version,
             classification=EXCLUDED.classification,
             confidence=EXCLUDED.confidence,
             reasons=EXCLUDED.reasons,
             differences=EXCLUDED.differences,
             candidate_data=EXCLUDED.candidate_data,
             projected_trade=EXCLUDED.projected_trade,
             row_version=ctrader_reconciliation_candidates.row_version+1
           WHERE ctrader_reconciliation_candidates.status='pending'`,
          [
            randomUUID(),
            input.connection.user_id,
            input.connection.id,
            input.historicalImport.id,
            positionId,
            `position:${positionId}`,
            manualTradeId,
            manualRowVersion,
            classification,
            confidence,
            json(reasons),
            json(differences),
            json(candidateData),
            projectedTrade === null ? null : json(projectedTrade),
          ],
        );
        previewCounters.positionsStaged += 1;
        if (classification === "high_confidence") previewCounters.highConfidence += 1;
        else if (classification === "ambiguous") previewCounters.ambiguous += 1;
        else if (classification === "deleted_manual") previewCounters.deletedManual += 1;
        else if (classification === "unmatched") previewCounters.unmatched += 1;
        else previewCounters.executionOnly += 1;
        if (classification === "execution_only") previewCounters.positionsAwaitingReview += 1;
        else previewCounters.positionsProjected += 1;
      }
      previewCounters.inserted = previewCounters.insertedExecutions;
      previewCounters.updated = previewCounters.updatedExecutions;
      enforcePersistenceDeadline();
      const importStatus = previewCounters.positionsStaged === 0 ? "completed" : "review";
      const updated = await client.query<{ id: string }>(
        `UPDATE ctrader_historical_imports SET
           status=$1, counters=$2::jsonb,
           error_code=NULL, error_message=NULL,
           row_version=row_version+1, finished_at=now()
         WHERE id=$3 AND user_id=$4 AND broker_connection_id=$5
           AND status IN ('queued','running')
         RETURNING id`,
        [
          importStatus,
          json(previewCounters),
          input.historicalImport.id,
          input.connection.user_id,
          input.connection.id,
        ],
      );
      if (!updated.rows[0]) {
        throw new CTraderSyncError(
          "CTRADER_HISTORICAL_IMPORT_CHANGED",
          "The historical cTrader preview changed before review staging completed",
          true,
        );
      }
      return previewCounters;
    });
    return {
      userId: input.connection.user_id,
      connectionId: input.connection.id,
      counters,
      cursorBefore: input.cursorSnapshot,
      cursorAfter: input.cursorSnapshot,
    };
  }

  private async persist(input: {
    connection: McpConnectionRow;
    fetched: McpDeal[];
    symbols: McpSymbol[];
    symbolById: ReadonlyMap<string, McpSymbol>;
    cursorBefore: JsonRecord;
    historyFloorTimestamp: number;
    queryFromTimestamp: number;
    syncedThroughTimestamp: number;
    currency: McpCurrencyContext;
    assetsAvailable: boolean;
    pnlEnrichment: McpPnlEnrichmentTelemetry;
    operatorAccountAttestation: AccountlessHistoryAttributionAttestation | null;
    operatorSymbolOverrides: VerifiedAccountSymbolOverrideSnapshot;
  }): Promise<CTraderSyncResult> {
    const persisted = await withTransaction(this.database, async (client) => {
      await lockAndValidateMappedAccountCurrency(client, {
        userId: input.connection.user_id,
        mappedAccountId: input.connection.mapped_account_id,
        legacyMappedAccountId: input.connection.legacy_mapped_account_id,
        providerCurrency: input.currency.accountCurrency,
      });
      const locked = await client.query<LockedMcpConnectionAttestationRow>(
        `SELECT connected, token_generation,
                id AS connection_id, user_id AS connection_user_id,
                external_account_id, provider_environment, provider_metadata,
                mapped_account_id, legacy_mapped_account_id
         FROM broker_connections
         WHERE id=$1 AND provider='ctrader' AND connection_mode='mcp_read'
           AND oauth_scope='mcp_read' AND provider_environment IS NOT NULL
           AND user_id=$2 AND external_account_id=$3 AND provider_environment=$4
         FOR UPDATE`,
        [
          input.connection.id,
          input.connection.user_id,
          input.connection.external_account_id,
          input.connection.provider_environment,
        ],
      );
      const lockedConnection = locked.rows[0];
      if (!lockedConnection?.connected) {
        throw new CTraderSyncError("CTRADER_DISCONNECTED", "The cTrader connection was disconnected during sync", false);
      }
      if (String(lockedConnection.token_generation) !== String(input.connection.token_generation)) {
        throw new CTraderSyncError("CTRADER_CONNECTION_CHANGED", "The cTrader connection changed during sync", true);
      }
      if (lockedConnection.mapped_account_id !== input.connection.mapped_account_id
        || lockedConnection.legacy_mapped_account_id !== input.connection.legacy_mapped_account_id) {
        throw new CTraderSyncError(
          "CTRADER_ACCOUNT_MAPPING_CHANGED",
          "The mapped Edgebook account changed during cTrader sync; retry with the current mapping",
          true,
        );
      }
      assertAccountlessHistoryAttestationUnchanged(lockedConnection, input.operatorAccountAttestation);
      assertVerifiedAccountSymbolOverridesUnchanged(lockedConnection, input.operatorSymbolOverrides);
      const lockedConnectionState: McpConnectionRow = {
        ...input.connection,
        mapped_account_id: lockedConnection.mapped_account_id,
        legacy_mapped_account_id: lockedConnection.legacy_mapped_account_id,
      };
      const counters: CTraderSyncCounters = {
        inserted: 0,
        updated: 0,
        fetchedDeals: input.fetched.length,
        insertedExecutions: 0,
        updatedExecutions: 0,
        insertedTrades: 0,
        updatedTrades: 0,
        unchangedTrades: 0,
        archivedTradesPreserved: 0,
        tombstonesPreserved: 0,
        positionsProjected: 0,
        positionsAwaitingReview: 0,
      };
      const executionIds = input.fetched.map((deal) => deal.dealId);
      const existingExecutionRows = executionIds.length === 0
        ? []
        : (await client.query<{ external_execution_id: string; raw_payload: unknown }>(
            `SELECT external_execution_id, raw_payload FROM trade_executions
             WHERE user_id=$1 AND broker_connection_id=$2 AND external_execution_id=ANY($3::text[])`,
            [input.connection.user_id, input.connection.id, executionIds],
          )).rows;
      const existingExecutions = new Set(existingExecutionRows.map((row) => row.external_execution_id));
      const storedExecutionFacts = new Map(existingExecutionRows.flatMap((row) => {
        if (row.raw_payload === undefined || row.raw_payload === null) return [];
        try { return [[row.external_execution_id, normalizeDeal(row.raw_payload, "stored")] as const]; } catch {
          throw new CTraderSyncError(
            "CTRADER_MCP_STORED_DEAL_INVALID",
            `Stored cTrader execution ${row.external_execution_id} is invalid`,
            false,
          );
        }
      }));
      const mergedFetched = input.fetched.map((deal) => {
        const stored = storedExecutionFacts.get(deal.dealId);
        return stored === undefined ? deal : mergeDealFacts(stored, deal);
      });
      for (const deal of mergedFetched) {
        const rawPayload = { edgebookMcpDeal: canonicalStoredDeal(deal) };
        const money = executionMoneyValues(deal);
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
             $17,$18,NULL,$19,$20::jsonb,$21
           )
           ON CONFLICT (broker_connection_id, external_execution_id) DO UPDATE SET
             external_position_id=EXCLUDED.external_position_id,
             external_order_id=EXCLUDED.external_order_id,
             external_symbol_id=EXCLUDED.external_symbol_id,
             side=EXCLUDED.side,
             quantity=EXCLUDED.quantity,
             price=EXCLUDED.price,
             pnl=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.pnl ELSE EXCLUDED.pnl END,
             commission=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.commission ELSE EXCLUDED.commission END,
             swap=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.swap ELSE EXCLUDED.swap END,
             currency_code=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.currency_code ELSE EXCLUDED.currency_code END,
             executed_at=EXCLUDED.executed_at,
             raw_payload=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN jsonb_set(
                   EXCLUDED.raw_payload,
                   '{edgebookMcpDeal}',
                   (trade_executions.raw_payload->'edgebookMcpDeal')
                     || ((EXCLUDED.raw_payload->'edgebookMcpDeal')
                       - 'netPnlCents' - 'commissionCents' - 'swapCents' - 'closePositionDetail')
                 )
               ELSE EXCLUDED.raw_payload END,
             deal_status=EXCLUDED.deal_status,
             filled_volume_cents=EXCLUDED.filled_volume_cents,
             closed_volume_cents=NULL,
             money_digits=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.money_digits ELSE EXCLUDED.money_digits END,
             close_position_detail=CASE
               WHEN EXCLUDED.pnl IS NULL AND EXCLUDED.close_position_detail IS NULL
                 AND (trade_executions.pnl IS NOT NULL OR trade_executions.close_position_detail IS NOT NULL)
                 THEN trade_executions.close_position_detail ELSE EXCLUDED.close_position_detail END,
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
            deal.side,
            decimal(Number(deal.filledVolumeCents) / 100),
            decimal(deal.executionPrice),
            money.pnl,
            money.commission,
            money.swap,
            input.currency.accountCurrency,
            new Date(deal.executionTimestamp),
            json(rawPayload),
            deal.dealStatus,
            deal.filledVolumeCents.toString(),
            money.moneyDigits,
            money.closePositionDetail,
            deal.providerUpdatedTimestamp === null ? null : new Date(deal.providerUpdatedTimestamp),
          ],
        );
        if (existingExecutions.has(deal.dealId)) counters.updatedExecutions += 1;
        else counters.insertedExecutions += 1;
      }

      await this.upsertSymbols(client, lockedConnectionState, input.symbols);
      // Retry previously quarantined positions on every sync. Their executions
      // are already stored server-side, so a later provider response that adds
      // authoritative symbol sizing can make them projectable without replaying
      // the complete account history.
      const positionIds = [...new Set([
        ...input.fetched.map((deal) => deal.positionId),
        ...cursorPositionIds(input.cursorBefore.positionsAwaitingReviewIds),
        ...cursorPositionIds(input.cursorBefore.positionsAwaitingLotConversionIds),
      ])];
      const awaitingReview = new Map<string, string>();
      const awaitingLotConversion = new Set<string>();
      if (positionIds.length > 0) {
        const stored = await client.query<StoredExecutionRow>(
          `SELECT external_position_id, raw_payload
           FROM trade_executions
           WHERE broker_connection_id=$1 AND external_position_id=ANY($2::text[])
             AND executed_at >= $3
           ORDER BY executed_at ASC, external_execution_id ASC`,
          [input.connection.id, positionIds, new Date(input.historyFloorTimestamp)],
        );
        const grouped = new Map<string, McpDeal[]>();
        for (const row of stored.rows) {
          let deal: McpDeal;
          try { deal = normalizeDeal(row.raw_payload, "stored"); } catch {
            throw new CTraderSyncError(
              "CTRADER_MCP_STORED_DEAL_INVALID",
              `Stored cTrader execution for position ${row.external_position_id} is invalid`,
              false,
            );
          }
          const group = grouped.get(row.external_position_id) ?? [];
          group.push(deal);
          grouped.set(row.external_position_id, group);
        }
        for (const positionId of positionIds) {
          if (await this.positionSuppressed(client, lockedConnectionState, positionId, counters)) continue;
          const deals = grouped.get(positionId);
          if (!deals || deals.length === 0) {
            await this.quarantineProjection(client, lockedConnectionState, positionId, "CTRADER_MCP_POSITION_MISSING");
            awaitingReview.set(positionId, "CTRADER_MCP_POSITION_MISSING");
            continue;
          }
          const first = deals[0];
          if (!first) continue;
          const symbol = input.symbolById.get(first.symbolId);
          if (!symbol) {
            await this.quarantineProjection(client, lockedConnectionState, positionId, "CTRADER_MCP_SYMBOL_UNAVAILABLE");
            awaitingReview.set(positionId, "CTRADER_MCP_SYMBOL_UNAVAILABLE");
            continue;
          }
          let projection: McpProjection;
          try {
            projection = projectMcpPosition(
              deals,
              symbol,
              this.config.cTrader.tradingTimeZone,
              input.currency,
              String(objectValue(input.connection.provider_metadata).historyFloorKind ?? "unknown"),
            );
          } catch (error) {
            const reason = projectionReviewReason(error);
            if (reason === null) throw error;
            await this.quarantineProjection(client, lockedConnectionState, positionId, reason);
            awaitingReview.set(positionId, reason);
            continue;
          }
          if (await this.stageLiveReconciliation(client, lockedConnectionState, projection)) {
            if (projection.quantityLots === null) awaitingLotConversion.add(positionId);
            counters.positionsProjected += 1;
            continue;
          }
          await this.upsertProjection(client, lockedConnectionState, projection, counters);
          if (projection.quantityLots === null) awaitingLotConversion.add(positionId);
          counters.positionsProjected += 1;
        }
      }
      counters.positionsAwaitingReview = awaitingReview.size;

      const lastDeal = input.fetched.at(-1) ?? null;
      const previousLastDealTimestamp = cursorTimestamp(input.cursorBefore.lastDealTimestamp);
      const lastDealTimestamp = Math.max(
        previousLastDealTimestamp ?? 0,
        lastDeal?.executionTimestamp ?? 0,
      ) || null;
      const refreshedDealAdvancesCursor = lastDeal !== null
        && (previousLastDealTimestamp === null || lastDeal.executionTimestamp >= previousLastDealTimestamp);
      const floorKind = objectValue(input.connection.provider_metadata).historyFloorKind;
      const cursorAfter = {
        version: 1,
        mode: "mcp_read",
        historyWindowComplete: true,
        fullHistoryComplete: floorKind === "registration",
        historyFloorKind: typeof floorKind === "string" ? floorKind : "unknown",
        historyStartTimestamp: input.historyFloorTimestamp,
        lastQueryFromTimestamp: input.queryFromTimestamp,
        syncedThroughTimestamp: input.syncedThroughTimestamp,
        lastDealTimestamp,
        lastDealId: refreshedDealAdvancesCursor
          ? lastDeal.dealId
          : typeof input.cursorBefore.lastDealId === "string" ? input.cursorBefore.lastDealId : null,
        positionsAwaitingReviewIds: [...awaitingReview.keys()].sort(),
        positionsAwaitingLotConversionIds: [...awaitingLotConversion].sort(),
      };
      const reviewReasonCounts = reasonCounts(awaitingReview);
      const reviewWarning = awaitingReview.size > 0
        ? `${awaitingReview.size} cTrader position${awaitingReview.size === 1 ? "" : "s"} imported as executions but withheld from the trade journal because authoritative projection data is incomplete or inconsistent. Edgebook did not guess financial values; these positions stay out of totals until cTrader exposes complete data or a verified review workflow is available.`
        : null;
      const metadata = {
        accountCurrency: input.currency.accountCurrency,
        depositAssetId: input.currency.depositAssetId,
        accountMoneyDigits: input.currency.accountMoneyDigits,
        providerReadTelemetry: {
          version: 1,
          assetsAvailable: input.assetsAvailable,
          assetCount: input.currency.assetNames.size,
          currencyResolved: input.currency.accountCurrency !== null,
          pnlEnrichment: input.pnlEnrichment,
        },
        lastErrorCode: null,
        lastErrorMessage: null,
        reauthRequired: false,
        readOnly: true,
        historyReadValidated: true,
        positionsAwaitingReview: awaitingReview.size,
        positionReviewReasons: reviewReasonCounts,
        lastWarningCode: reviewWarning === null ? null : "CTRADER_MCP_POSITIONS_AWAITING_REVIEW",
        lastWarningMessage: reviewWarning,
      };
      await client.query(
        `UPDATE broker_connections SET
           sync_cursor=$1::jsonb,
           provider_metadata=(provider_metadata
             - 'lastErrorCode' - 'lastErrorMessage'
             - 'lastWarningCode' - 'lastWarningMessage') || $2::jsonb,
           last_sync_at=now()
         WHERE id=$3 AND connection_mode='mcp_read'`,
        [json(cursorAfter), json(metadata), input.connection.id],
      );
      return { counters, cursorAfter };
    });
    return {
      userId: input.connection.user_id,
      connectionId: input.connection.id,
      counters: persisted.counters,
      cursorBefore: input.cursorBefore,
      cursorAfter: persisted.cursorAfter,
    };
  }

  private async positionSuppressed(
    client: PoolClient,
    connection: McpConnectionRow,
    positionId: string,
    counters: CTraderSyncCounters,
  ): Promise<boolean> {
    const externalKey = `position:${positionId}`;
    const pendingHistoricalReview = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM ctrader_reconciliation_candidates candidate
         JOIN ctrader_historical_imports import
           ON import.user_id=candidate.user_id
          AND import.broker_connection_id=candidate.broker_connection_id
          AND import.id=candidate.import_id
         WHERE candidate.user_id=$1
           AND candidate.broker_connection_id=$2
           AND candidate.external_position_id=$3
           AND candidate.external_trade_key=$4
           AND candidate.status='pending'
           AND import.status IN ('queued','running','review')
       ) AS exists`,
      [connection.user_id, connection.id, positionId, externalKey],
    );
    if (pendingHistoricalReview.rows[0]?.exists) return true;
    const tombstone = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM ctrader_trade_tombstones
         WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
       ) AS exists`,
      [connection.user_id, connection.id, externalKey],
    );
    if (tombstone.rows[0]?.exists) {
      await client.query(
        `DELETE FROM ctrader_live_reconciliation_candidates
         WHERE user_id=$1 AND broker_connection_id=$2 AND external_position_id=$3
           AND status='pending'`,
        [connection.user_id, connection.id, positionId],
      );
      counters.tombstonesPreserved += 1;
      return true;
    }
    // An environment-less legacy connection may be adopted for credential
    // continuity, but that does not prove which environment its old position
    // IDs came from. Never use those rows for suppression or adoption.
    if (objectValue(connection.provider_metadata).legacyEnvironmentWasUnbound === true) return false;
    const archivedLegacy = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM trades legacy_trade
         JOIN broker_connections legacy_connection
           ON legacy_connection.id=legacy_trade.broker_connection_id
         WHERE legacy_trade.user_id=$1 AND legacy_trade.broker_connection_id=$2
           AND legacy_trade.source_system='ctrader'
           AND legacy_trade.broker_trade_id=$3 AND legacy_trade.external_trade_key IS NULL
           AND legacy_trade.deleted_at IS NOT NULL
           AND legacy_connection.external_account_id=$4
           AND legacy_connection.provider_environment=$5
       ) AS exists`,
      [
        connection.user_id,
        connection.id,
        positionId,
        connection.external_account_id,
        connection.provider_environment,
      ],
    );
    if (archivedLegacy.rows[0]?.exists) {
      await client.query(
        `INSERT INTO ctrader_trade_tombstones (
           user_id, broker_connection_id, external_trade_key, external_position_id
         ) VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, broker_connection_id, external_trade_key) DO UPDATE SET
           external_position_id=EXCLUDED.external_position_id,
           purged_at=now()`,
        [connection.user_id, connection.id, externalKey, positionId],
      );
      await client.query(
        `DELETE FROM ctrader_live_reconciliation_candidates
         WHERE user_id=$1 AND broker_connection_id=$2 AND external_position_id=$3
           AND status='pending'`,
        [connection.user_id, connection.id, positionId],
      );
      counters.tombstonesPreserved += 1;
      return true;
    }
    const activeLegacy = await client.query<{ id: string }>(
      `SELECT legacy_trade.id FROM trades legacy_trade
       JOIN broker_connections legacy_connection
         ON legacy_connection.id=legacy_trade.broker_connection_id
       WHERE legacy_trade.user_id=$1 AND legacy_trade.broker_connection_id=$2
         AND legacy_trade.source_system='ctrader'
         AND legacy_trade.broker_trade_id=$3 AND legacy_trade.external_trade_key IS NULL
         AND legacy_trade.deleted_at IS NULL
         AND legacy_connection.external_account_id=$4
         AND legacy_connection.provider_environment=$5
       ORDER BY legacy_trade.updated_at DESC, legacy_trade.id ASC
       LIMIT 2`,
      [
        connection.user_id,
        connection.id,
        positionId,
        connection.external_account_id,
        connection.provider_environment,
      ],
    );
    if (activeLegacy.rows.length > 1) {
      throw new CTraderSyncError(
        "CTRADER_LEGACY_TRADE_IDENTITY_CONFLICT",
        `Multiple legacy cTrader trades match position ${positionId}`,
        false,
      );
    }
    const legacyTrade = activeLegacy.rows[0];
    if (legacyTrade) {
      await client.query(
        `UPDATE trades SET broker_connection_id=$1, external_trade_key=$2
         WHERE id=$3 AND user_id=$4 AND deleted_at IS NULL
           AND external_trade_key IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM trades current_trade
             WHERE current_trade.broker_connection_id=$1
               AND current_trade.external_trade_key=$2
           )`,
        [connection.id, externalKey, legacyTrade.id, connection.user_id],
      );
    }
    return false;
  }

  private async quarantineProjection(
    client: PoolClient,
    connection: McpConnectionRow,
    positionId: string,
    reason: string,
  ): Promise<void> {
    const externalKey = `position:${positionId}`;
    const preserveExactMoney = QUARANTINE_REASONS_PRESERVING_EXACT_MONEY.has(reason);
    await client.query(
      `UPDATE trades SET
         pnl=CASE
           WHEN $5::boolean
             AND broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
             THEN pnl
           ELSE NULL
         END,
         broker_data=(
           CASE
             WHEN $5::boolean
               AND broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
               THEN broker_data
             ELSE (broker_data
               - 'realizedEvents' - 'grossProfit' - 'commission' - 'swap' - 'pnlConversionFee')
               || jsonb_build_object(
                 'realizedEvents','[]'::jsonb,
                 'pnlMethod','unavailable',
                 'grossProfit',NULL,
                 'commission',NULL,
                 'swap',NULL,
                 'pnlConversionFee',NULL
               )
           END
           - 'calculatedGrossPnl' - 'calculatedGrossCurrency' - 'calculatedGrossMethod'
           - 'calculatedGrossEvents' - 'calculatedGrossProvenance'
           - 'estimatedCommission' - 'estimatedSwap' - 'estimatedConversionFee'
           - 'estimatedOtherCharges' - 'estimatedFeesAndCharges' - 'estimatedNetPnl'
           - 'estimatedNetCurrency' - 'estimatedNetMethod' - 'estimatedNetProvenance'
         ) || jsonb_build_object(
           'classification',
             (CASE
                WHEN jsonb_typeof(broker_data->'classification')='object'
                  THEN broker_data->'classification'
                ELSE '{}'::jsonb
              END) || jsonb_build_object(
                'projectionQuarantined',true,
                'projectionQuarantineReason',$4::text,
                'projectionQuarantinedAt',to_jsonb(now())
              )
         ),
         row_version=row_version+1,
         updated_at=now()
       WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
         AND deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ctrader_trade_links link
           WHERE link.user_id=trades.user_id
             AND link.broker_connection_id=trades.broker_connection_id
             AND link.external_trade_key=trades.external_trade_key
             AND link.trade_id=trades.id
         )
         AND (
           broker_data #> '{classification,projectionQuarantined}' IS DISTINCT FROM 'true'::jsonb
           OR broker_data #>> '{classification,projectionQuarantineReason}' IS DISTINCT FROM $4
           OR broker_data ?| ARRAY[
             'calculatedGrossPnl','calculatedGrossCurrency','calculatedGrossMethod',
             'calculatedGrossEvents','calculatedGrossProvenance',
             'estimatedCommission','estimatedSwap','estimatedConversionFee',
             'estimatedOtherCharges','estimatedFeesAndCharges','estimatedNetPnl',
             'estimatedNetCurrency','estimatedNetMethod','estimatedNetProvenance'
           ]
           OR (
             NOT ($5::boolean
               AND broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money'))
             AND (pnl IS NOT NULL OR broker_data->>'pnlMethod' IS DISTINCT FROM 'unavailable')
           )
         )`,
      [connection.user_id, connection.id, externalKey, reason, preserveExactMoney],
    );
    // A reviewed/manual link owns the aggregate P&L and journal fields, so the
    // quarantine above intentionally excludes it. Calculated gross is only a
    // projection of the now-invalid provider inputs, however, and must not
    // remain visible on a linked row after any projection quarantine.
    await client.query(
      `UPDATE trades SET
         broker_data=broker_data
           - 'calculatedGrossPnl' - 'calculatedGrossCurrency' - 'calculatedGrossMethod'
           - 'calculatedGrossEvents' - 'calculatedGrossProvenance'
           - 'estimatedCommission' - 'estimatedSwap' - 'estimatedConversionFee'
           - 'estimatedOtherCharges' - 'estimatedFeesAndCharges' - 'estimatedNetPnl'
           - 'estimatedNetCurrency' - 'estimatedNetMethod' - 'estimatedNetProvenance',
         row_version=row_version+1,
         updated_at=now()
       WHERE user_id=$1 AND deleted_at IS NULL
         AND broker_data ?| ARRAY[
           'calculatedGrossPnl','calculatedGrossCurrency','calculatedGrossMethod',
           'calculatedGrossEvents','calculatedGrossProvenance',
           'estimatedCommission','estimatedSwap','estimatedConversionFee',
           'estimatedOtherCharges','estimatedFeesAndCharges','estimatedNetPnl',
           'estimatedNetCurrency','estimatedNetMethod','estimatedNetProvenance'
         ]
         AND EXISTS (
           SELECT 1 FROM ctrader_trade_links link
           WHERE link.user_id=trades.user_id
             AND link.broker_connection_id=$2
             AND link.external_position_id=$3
             AND link.external_trade_key=$4
             AND link.trade_id=trades.id
         )`,
      [connection.user_id, connection.id, positionId, externalKey],
    );
  }

  private async upsertSymbols(
    client: PoolClient,
    connection: McpConnectionRow,
    symbols: readonly McpSymbol[],
  ): Promise<void> {
    for (const symbol of symbols) {
      await client.query(
        `INSERT INTO symbol_specs (
           id, provider, provider_environment, external_account_id,
           external_symbol_id, symbol_name, specification, fetched_at, expires_at
         ) VALUES ($1,'ctrader',$2,$3,$4,$5,$6::jsonb,now(),now()+($7::int*interval '1 second'))
         ON CONFLICT (provider, provider_environment, external_account_id, external_symbol_id)
         DO UPDATE SET symbol_name=EXCLUDED.symbol_name,
           specification=EXCLUDED.specification, fetched_at=now(), expires_at=EXCLUDED.expires_at`,
        [
          randomUUID(),
          connection.provider_environment,
          connection.external_account_id,
          symbol.id,
          symbol.name,
          json({
            symbolId: symbol.id,
            symbolName: symbol.name,
            baseAssetId: symbol.baseAssetId,
            quoteAssetId: symbol.quoteAssetId,
            lotSize: symbol.lotSize,
            lotSizeSource: symbol.lotSizeSource,
            providerLotSizeScale: symbol.providerLotSizeScale,
            verifiedAccountSymbolOverride: symbol.verifiedOverride,
            symbolCategory: symbol.category,
            connectionMode: "mcp_read",
          }),
          this.config.cTrader.symbolCacheSeconds,
        ],
      );
    }
  }

  private async stageLiveReconciliation(
    client: PoolClient,
    connection: McpConnectionRow,
    projection: McpProjection,
  ): Promise<boolean> {
    const externalKey = `position:${projection.positionId}`;
    const priorDecision = await client.query<{
      status: string;
      resolution_action: string | null;
    }>(
      `SELECT status, resolution_action
       FROM ctrader_live_reconciliation_candidates
       WHERE user_id=$1 AND broker_connection_id=$2 AND external_position_id=$3
       LIMIT 1`,
      [connection.user_id, connection.id, projection.positionId],
    );
    const terminal = priorDecision.rows[0] ?? null;
    // A dismissed suggestion or a separately published broker row must resume
    // the ordinary projection path so closes, realized P&L, and later provider
    // corrections continue to update the journal. Linked rows also flow through
    // upsertProjection, which follows ctrader_trade_links. Suppressed rows are
    // stopped earlier by positionSuppressed/tombstones.
    if (terminal && terminal.status !== "pending") return false;
    const existingBroker = await client.query<{ id: string; row_version: number; deleted_at: Date | string | null }>(
      `SELECT id, row_version, deleted_at FROM trades
       WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
       LIMIT 1`,
      [connection.user_id, connection.id, externalKey],
    );
    const brokerRow = existingBroker.rows[0] ?? null;
    if (brokerRow?.deleted_at !== null && brokerRow !== null) return false;

    const manualRows = (await client.query<LiveManualTradeRow>(
      `SELECT manual.id, manual.row_version, manual.deleted_at,
              manual.symbol, manual.direction, manual.entry_price::text,
              manual.exit_price::text, manual.quantity::text, manual.pnl::text,
              manual.trade_date, manual.entry_at, manual.exit_at,
              manual.strategy, manual.emotion, manual.notes, manual.tags,
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
    const match = liveCandidateForPosition(projection, manualRows);
    if (match.classification === "unmatched") {
      // A manual row may be edited, remapped, or permanently removed while a
      // suggestion is pending. Do not leave a stale actionable candidate while
      // allowing the now-unmatched provider trade through the normal path.
      await client.query(
        `DELETE FROM ctrader_live_reconciliation_candidates
         WHERE user_id=$1 AND broker_connection_id=$2 AND external_position_id=$3
           AND status='pending'`,
        [connection.user_id, connection.id, projection.positionId],
      );
      return false;
    }
    const choices = match.choices.map((manual) => ({
        id: manual.id,
        version: manual.row_version,
        deleted: manual.deleted_at !== null,
        symbol: manual.symbol,
        direction: manual.direction,
        date: localDate(manual.trade_date),
        hasStrategy: Boolean(manual.strategy?.trim()),
        hasEmotion: Boolean(manual.emotion?.trim()),
        hasPsychology: Object.keys(objectValue(manual.psychology)).length > 0,
        hasNotes: Boolean(manual.notes?.trim()),
        hasCustomFields: Object.keys(objectValue(manual.custom_fields)).length > 0,
        screenshotCount: Number(manual.screenshot_count ?? 0),
      }));
    const classification = brokerRow === null ? match.classification : "existing_pair";
    const projectionRecord = projectedTradeRecord(projection);
    const projectionFingerprint = createHash("sha256").update(json(projectionRecord)).digest();
    await client.query(
      `INSERT INTO ctrader_live_reconciliation_candidates (
         id, user_id, broker_connection_id, external_position_id,
         external_trade_key, manual_trade_id, manual_row_version,
         broker_trade_id, broker_row_version, classification, confidence,
         reasons, differences, candidate_data, projected_trade,
         projection_fingerprint, status
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,
         $15::jsonb,$16,'pending'
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
        randomUUID(), connection.user_id, connection.id, projection.positionId,
        externalKey, match.manualTradeId, match.manualRowVersion,
        brokerRow?.id ?? null, brokerRow?.row_version ?? null,
        classification, match.confidence, json(match.reasons), json(match.differences),
        json({ manualChoices: choices, preservedFields: [
          "id", "created_at", "trade_date", "strategy", "emotion", "notes", "tags",
          "psychology", "custom_fields", "stop_loss", "take_profit", "files",
        ] }),
        json(projectionRecord), projectionFingerprint,
      ],
    );
    // Existing broker rows stay provider-current while their duplicate manual
    // row is under review; only a broker-absent candidate must withhold insert.
    return brokerRow === null;
  }

  private async upsertProjection(
    client: PoolClient,
    connection: McpConnectionRow,
    projection: McpProjection,
    counters: CTraderSyncCounters,
  ): Promise<void> {
    const externalKey = `position:${projection.positionId}`;
    const linked = await client.query<ExistingTradeRow & { tombstoned: boolean }>(
      `SELECT trade.id, trade.deleted_at
              ,EXISTS(
                SELECT 1 FROM ctrader_trade_tombstones tombstone
                WHERE tombstone.user_id=link.user_id
                  AND tombstone.broker_connection_id=link.broker_connection_id
                  AND tombstone.external_trade_key=link.external_trade_key
              ) AS tombstoned
       FROM ctrader_trade_links link
       JOIN trades trade ON trade.user_id=link.user_id AND trade.id=link.trade_id
       WHERE link.user_id=$1 AND link.broker_connection_id=$2
         AND link.external_position_id=$3 AND link.external_trade_key=$4
       LIMIT 1`,
      [connection.user_id, connection.id, projection.positionId, externalKey],
    );
    const linkedTrade = linked.rows[0] ?? null;
    if (linkedTrade) {
      if (linkedTrade.deleted_at !== null || linkedTrade.tombstoned) {
        counters.archivedTradesPreserved += 1;
        if (linkedTrade.tombstoned) counters.tombstonesPreserved += 1;
        return;
      }
      const brokerData = {
        ...projection.brokerData,
        providerTradeDate: projection.tradeDate,
        classification: {
          ...objectValue(projection.brokerData.classification),
          projectionQuarantined: false,
          reconciledManualTrade: true,
        },
        environment: connection.provider_environment,
        ctidTraderAccountId: connection.external_account_id,
      };
      const updated = await client.query<{ id: string }>(
        `UPDATE trades SET
           account_id=$1::uuid,
           legacy_account_id=$2::text,
           symbol=$3, asset=COALESCE($4::text,asset), instrument=$3, direction=$5,
           entry_price=$6, exit_price=COALESCE($7::numeric,exit_price), quantity=$8,
           pnl=CASE
             WHEN $9::numeric IS NOT NULL THEN $9::numeric
             WHEN $16::jsonb->>'pnlMethod'='unavailable'
               AND broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
               AND broker_data #>> '{providerExecutionLineage,fingerprintSha256}' IS NOT NULL
               AND broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
                 = $16::jsonb #>> '{providerExecutionLineage,fingerprintSha256}'
               THEN pnl
             WHEN broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
               THEN NULL
             ELSE pnl
           END, is_open=$10,
           trade_date=COALESCE(trade_date,$11::date), entry_at=$12, exit_at=COALESCE($13::timestamptz,exit_at),
           legacy_entry_time=$14, legacy_exit_time=COALESCE($15::time,legacy_exit_time),
           broker_data=CASE
             WHEN $16::jsonb->>'pnlMethod'='unavailable'
               AND pnl IS NOT NULL
               AND COALESCE(broker_data->>'pnlMethod','') NOT IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
               THEN (broker_data || ($16::jsonb
                 - 'pnlAuthority' - 'reconciledManualPnlPreserved'))
                 || jsonb_build_object(
                   'pnlAuthority','preserved_reconciled_manual',
                   'reconciledManualPnlPreserved',true
                 )
             WHEN $16::jsonb->>'pnlMethod'='unavailable'
               AND broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
               AND broker_data #>> '{providerExecutionLineage,fingerprintSha256}' IS NOT NULL
               AND broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
                 = $16::jsonb #>> '{providerExecutionLineage,fingerprintSha256}'
               THEN broker_data || ($16::jsonb
                 - 'pnlMethod' - 'grossProfit' - 'commission' - 'swap'
                 - 'pnlConversionFee' - 'realizedEvents'
                 - 'pnlAuthority' - 'pnlComponentsCoverage'
                 - 'reconciledManualPnlPreserved')
             ELSE broker_data || $16::jsonb
           END,
           calculation_version=2,
           row_version=row_version+1, updated_at=now()
         WHERE id=$17 AND user_id=$18 AND deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM ctrader_trade_tombstones tombstone
             WHERE tombstone.user_id=$18
               AND tombstone.broker_connection_id=$19
               AND tombstone.external_trade_key=$20
           )
           AND (
             account_id IS DISTINCT FROM $1::uuid
             OR legacy_account_id IS DISTINCT FROM $2::text
             OR symbol IS DISTINCT FROM $3 OR asset IS DISTINCT FROM COALESCE($4::text,asset)
             OR instrument IS DISTINCT FROM $3 OR direction IS DISTINCT FROM $5
             OR entry_price IS DISTINCT FROM $6::numeric
             OR exit_price IS DISTINCT FROM COALESCE($7::numeric,exit_price)
             OR quantity IS DISTINCT FROM $8::numeric
             OR pnl IS DISTINCT FROM CASE
               WHEN $9::numeric IS NOT NULL THEN $9::numeric
               WHEN $16::jsonb->>'pnlMethod'='unavailable'
                 AND broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
                 AND broker_data #>> '{providerExecutionLineage,fingerprintSha256}' IS NOT NULL
                 AND broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
                   = $16::jsonb #>> '{providerExecutionLineage,fingerprintSha256}'
                 THEN pnl
               WHEN broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
                 THEN NULL
               ELSE pnl
             END
             OR is_open IS DISTINCT FROM $10
             OR entry_at IS DISTINCT FROM $12::timestamptz
             OR exit_at IS DISTINCT FROM COALESCE($13::timestamptz,exit_at)
             OR legacy_entry_time IS DISTINCT FROM $14::time
             OR legacy_exit_time IS DISTINCT FROM COALESCE($15::time,legacy_exit_time)
             OR broker_data IS DISTINCT FROM CASE
               WHEN $16::jsonb->>'pnlMethod'='unavailable'
                 AND pnl IS NOT NULL
                 AND COALESCE(broker_data->>'pnlMethod','') NOT IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
                 THEN (broker_data || ($16::jsonb
                   - 'pnlAuthority' - 'reconciledManualPnlPreserved'))
                   || jsonb_build_object(
                     'pnlAuthority','preserved_reconciled_manual',
                     'reconciledManualPnlPreserved',true
                   )
               WHEN $16::jsonb->>'pnlMethod'='unavailable'
                 AND broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
                 AND broker_data #>> '{providerExecutionLineage,fingerprintSha256}' IS NOT NULL
                 AND broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
                   = $16::jsonb #>> '{providerExecutionLineage,fingerprintSha256}'
                 THEN broker_data || ($16::jsonb
                   - 'pnlMethod' - 'grossProfit' - 'commission' - 'swap'
                   - 'pnlConversionFee' - 'realizedEvents'
                   - 'pnlAuthority' - 'pnlComponentsCoverage'
                   - 'reconciledManualPnlPreserved')
               ELSE broker_data || $16::jsonb
             END
             OR calculation_version IS DISTINCT FROM 2
           )
         RETURNING id`,
        [
          connection.mapped_account_id,
          connection.legacy_mapped_account_id,
          projection.symbol,
          projection.asset,
          projection.direction,
          projection.entryPrice,
          projection.exitPrice,
          projection.quantity,
          projection.pnl,
          projection.isOpen,
          projection.tradeDate,
          projection.entryAt,
          projection.exitAt,
          projection.entryTime,
          projection.exitTime,
          json(brokerData),
          linkedTrade.id,
          connection.user_id,
          connection.id,
          externalKey,
        ],
      );
      if (!updated.rows[0]) {
        const tombstone = await client.query<{ exists: boolean }>(
          `SELECT EXISTS(
             SELECT 1 FROM ctrader_trade_tombstones
             WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
           ) AS exists`,
          [connection.user_id, connection.id, externalKey],
        );
        if (tombstone.rows[0]?.exists) {
          counters.tombstonesPreserved += 1;
          return;
        }
      }
      await client.query(
        `UPDATE trade_executions SET trade_id=$1
         WHERE user_id=$2 AND broker_connection_id=$3
           AND external_position_id=$4 AND trade_id IS DISTINCT FROM $1`,
        [linkedTrade.id, connection.user_id, connection.id, projection.positionId],
      );
      if (updated.rows[0]) {
        counters.updatedTrades += 1;
        counters.updated += 1;
      } else counters.unchangedTrades += 1;
      return;
    }
    const existing = await client.query<ExistingTradeRow>(
      `SELECT id, deleted_at FROM trades
       WHERE broker_connection_id=$1 AND external_trade_key=$2
       LIMIT 1`,
      [connection.id, externalKey],
    );
    const previous = existing.rows[0] ?? null;
    if (previous?.deleted_at) {
      counters.archivedTradesPreserved += 1;
      return;
    }
    const brokerData = {
      ...projection.brokerData,
      providerTradeDate: projection.tradeDate,
      classification: {
        ...objectValue(projection.brokerData.classification),
        projectionQuarantined: false,
      },
      environment: connection.provider_environment,
      ctidTraderAccountId: connection.external_account_id,
    };
    const changed = await client.query<{ id: string }>(
      `INSERT INTO trades (
         id, user_id, account_id, legacy_account_id, broker_connection_id,
         source_system, ingestion_method, external_trade_key, broker_trade_id,
         symbol, asset, instrument, direction, entry_price, exit_price,
         quantity, pnl, is_open, trade_date, entry_at, exit_at,
         legacy_entry_time, legacy_exit_time, broker_data,
         calculation_version, row_version
       ) SELECT $1,$2,$3,$4,$5,'ctrader','api',$6,$7,$8,$9,$8,$10,$11,$12,
         $13,$14,$15,$16,$17,$18,$19,$20,$21::jsonb,2,1
       WHERE NOT EXISTS (
         SELECT 1 FROM ctrader_trade_tombstones tombstone
         WHERE tombstone.user_id=$2
           AND tombstone.broker_connection_id=$5
           AND tombstone.external_trade_key=$6
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
         pnl=CASE
           WHEN EXCLUDED.pnl IS NULL
             AND EXCLUDED.broker_data->>'pnlMethod'='unavailable'
             AND trades.broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
             AND trades.broker_data #>> '{providerExecutionLineage,fingerprintSha256}' IS NOT NULL
             AND trades.broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
               = EXCLUDED.broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
             THEN trades.pnl
           ELSE EXCLUDED.pnl
         END,
         is_open=EXCLUDED.is_open,
         entry_at=EXCLUDED.entry_at,
         exit_at=EXCLUDED.exit_at,
         legacy_entry_time=EXCLUDED.legacy_entry_time,
         legacy_exit_time=EXCLUDED.legacy_exit_time,
         broker_data=CASE
           WHEN EXCLUDED.pnl IS NULL
             AND EXCLUDED.broker_data->>'pnlMethod'='unavailable'
             AND trades.broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
             AND trades.broker_data #>> '{providerExecutionLineage,fingerprintSha256}' IS NOT NULL
             AND trades.broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
               = EXCLUDED.broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
             THEN trades.broker_data || (EXCLUDED.broker_data
               - 'pnlMethod' - 'grossProfit' - 'commission' - 'swap'
               - 'pnlConversionFee' - 'realizedEvents'
               - 'pnlAuthority' - 'pnlComponentsCoverage'
               - 'reconciledManualPnlPreserved')
           ELSE EXCLUDED.broker_data
         END,
         calculation_version=EXCLUDED.calculation_version,
         row_version=trades.row_version+1
       WHERE trades.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM ctrader_trade_tombstones tombstone
           WHERE tombstone.user_id=$2
             AND tombstone.broker_connection_id=$5
             AND tombstone.external_trade_key=$6
         )
         AND (
       (
         trades.account_id, trades.legacy_account_id, trades.broker_trade_id,
         trades.symbol, trades.asset, trades.instrument, trades.direction,
         trades.entry_price, trades.exit_price, trades.quantity,
         trades.is_open, trades.entry_at, trades.exit_at,
         trades.legacy_entry_time, trades.legacy_exit_time,
         trades.calculation_version
       ) IS DISTINCT FROM (
         EXCLUDED.account_id, EXCLUDED.legacy_account_id, EXCLUDED.broker_trade_id,
         EXCLUDED.symbol, EXCLUDED.asset, EXCLUDED.instrument, EXCLUDED.direction,
         EXCLUDED.entry_price, EXCLUDED.exit_price, EXCLUDED.quantity,
         EXCLUDED.is_open, EXCLUDED.entry_at, EXCLUDED.exit_at,
         EXCLUDED.legacy_entry_time, EXCLUDED.legacy_exit_time,
         EXCLUDED.calculation_version
       )
       OR trades.pnl IS DISTINCT FROM CASE
         WHEN EXCLUDED.pnl IS NULL
           AND EXCLUDED.broker_data->>'pnlMethod'='unavailable'
           AND trades.broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
           AND trades.broker_data #>> '{providerExecutionLineage,fingerprintSha256}' IS NOT NULL
           AND trades.broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
             = EXCLUDED.broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
           THEN trades.pnl
         ELSE EXCLUDED.pnl
       END
       OR trades.broker_data IS DISTINCT FROM CASE
         WHEN EXCLUDED.pnl IS NULL
           AND EXCLUDED.broker_data->>'pnlMethod'='unavailable'
           AND trades.broker_data->>'pnlMethod' IN ('provider_close_detail_money_digits','provider_explicit_net_cents','provider_mixed_exact_money')
           AND trades.broker_data #>> '{providerExecutionLineage,fingerprintSha256}' IS NOT NULL
           AND trades.broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
             = EXCLUDED.broker_data #>> '{providerExecutionLineage,fingerprintSha256}'
           THEN trades.broker_data || (EXCLUDED.broker_data
             - 'pnlMethod' - 'grossProfit' - 'commission' - 'swap'
             - 'pnlConversionFee' - 'realizedEvents'
             - 'pnlAuthority' - 'pnlComponentsCoverage'
             - 'reconciledManualPnlPreserved')
         ELSE EXCLUDED.broker_data
       END
       )
       RETURNING id`,
      [
        randomUUID(),
        connection.user_id,
        connection.mapped_account_id,
        connection.legacy_mapped_account_id,
        connection.id,
        externalKey,
        projection.positionId,
        projection.symbol,
        projection.asset,
        projection.direction,
        projection.entryPrice,
        projection.exitPrice,
        projection.quantity,
        projection.pnl,
        projection.isOpen,
        projection.tradeDate,
        projection.entryAt,
        projection.exitAt,
        projection.entryTime,
        projection.exitTime,
        json(brokerData),
      ],
    );
    if (!changed.rows[0]) {
      const tombstone = await client.query<{ exists: boolean }>(
        `SELECT EXISTS(
           SELECT 1 FROM ctrader_trade_tombstones
           WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
         ) AS exists`,
        [connection.user_id, connection.id, externalKey],
      );
      if (tombstone.rows[0]?.exists) {
        counters.tombstonesPreserved += 1;
        return;
      }
    }
    const tradeId = changed.rows[0]?.id ?? previous?.id ?? null;
    if (tradeId) {
      await client.query(
        `UPDATE trade_executions SET trade_id=$1
         WHERE broker_connection_id=$2 AND external_position_id=$3
           AND trade_id IS DISTINCT FROM $1`,
        [tradeId, connection.id, projection.positionId],
      );
    }
    if (!previous) {
      counters.insertedTrades += 1;
      counters.inserted += 1;
    } else if (changed.rows[0]) {
      counters.updatedTrades += 1;
      counters.updated += 1;
    } else counters.unchangedTrades += 1;
  }
}
