import { randomUUID } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";
import type { AppConfig } from "../config.js";
import type { Database } from "../db/database.js";
import { withTransaction } from "../db/database.js";
import type { EventBus } from "../events/event-bus.js";
import { connectionTokenAad, type TokenCipher } from "./crypto.js";
import { CTraderMcpError, CTraderMcpReadClient } from "./mcp.js";
import { CTraderSyncError, type CTraderSyncCounters, type CTraderSyncResult } from "./sync.js";

const MAX_HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

type JsonRecord = Record<string, unknown>;

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

type ExistingTradeRow = QueryResultRow & {
  id: string;
  deleted_at: Date | string | null;
};

type StoredExecutionRow = QueryResultRow & {
  external_position_id: string;
  raw_payload: unknown;
};

type McpSymbol = {
  id: string;
  name: string;
  category: string | null;
  lotSize: number | null;
  lotSizeSource: "provider" | "unavailable";
  raw: JsonRecord;
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
  executionPrice: number;
  executionTimestamp: number;
  dealStatus: number | null;
  providerUpdatedTimestamp: number | null;
  pnlCents: number | null;
  commissionCents: number | null;
  swapCents: number | null;
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
  quantityLots: string;
  pnl: string | null;
  isOpen: boolean;
  tradeDate: string;
  entryAt: string;
  exitAt: string | null;
  entryTime: string;
  exitTime: string | null;
  brokerData: JsonRecord;
};

export interface CTraderMcpReadClientLike {
  getAccountInfo(): Promise<unknown>;
  getBalance(): Promise<unknown>;
  getSymbols(): Promise<unknown>;
  getDeals(request: { fromTimestamp: string; toTimestamp: string }): Promise<unknown>;
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
  if (!Number.isFinite(number) || (positive && number <= 0)) {
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
    executionPrice: deal.executionPrice,
    executionTimestamp: deal.executionTimestamp,
    dealStatus: deal.dealStatus,
    providerUpdatedTimestamp: deal.providerUpdatedTimestamp,
    // Monetary values are accepted only when the provider names their exact
    // semantics and scale. Generic `pnl`/`commission` aliases are deliberately
    // not persisted as money because the Remote MCP contract does not define
    // whether they are gross/net or major/minor currency units.
    netPnlCents: deal.pnlCents,
    commissionCents: deal.commissionCents,
    swapCents: deal.swapCents,
  };
}

function normalizeDeal(value: unknown): McpDeal {
  const envelope = objectValue(value);
  const canonical = objectValue(envelope.edgebookMcpDeal);
  const raw = Object.keys(canonical).length > 0 ? canonical : envelope;
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
  const filledVolumeCents = positiveInteger(
    firstValue(raw, ["filledVolumeCents", "filledVolume", "filled_volume", "volume", "quantity"]),
    "filledVolume",
  );
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
  const accountId = textValue(firstValue(raw, [
    "accountId", "account_id", "ctidTraderAccountId", "traderAccountId",
  ]), "accountId");
  const pnlCents = optionalCents(raw, ["netPnlCents", "netProfitCents"]);
  const role: McpDeal["role"] = ["ENTRY", "OPEN", "OPENING"].includes(roleText)
    ? "OPEN"
    : ["EXIT", "CLOSE", "CLOSING"].includes(roleText)
      ? "CLOSE"
      : closeDetailPresent
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
    filledVolumeCents,
    executionPrice,
    executionTimestamp,
    dealStatus: parsedStatus !== null && Number.isSafeInteger(parsedStatus) ? parsedStatus : null,
    providerUpdatedTimestamp: optionalTimestamp(firstValue(raw, [
      "providerUpdatedTimestamp", "utcLastUpdateTimestamp", "updatedAt", "updated_at",
    ])),
    pnlCents,
    commissionCents: optionalCents(raw, ["commissionCents"]),
    swapCents: optionalCents(raw, ["swapCents"]),
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

function normalizedSymbolName(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function compareDealIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  return left.localeCompare(right);
}

function normalizeSymbols(value: unknown): McpSymbol[] {
  const rows = unwrapArray(value, ["symbols", "data", "result", "items"], "symbols");
  const symbols: McpSymbol[] = [];
  for (const row of rows) {
    const raw = objectValue(row);
    const id = textValue(firstValue(raw, ["id", "symbolId", "symbol_id"]), "symbol ID");
    const name = textValue(firstValue(raw, ["name", "symbolName", "symbol_name"]), "symbol name");
    if (!id || !name) continue;
    const providerLot = firstValue(raw, ["lotSize", "lot_size", "contractSize", "contract_size"]);
    const providerLotNumber = providerLot === null ? null : Number(providerLot);
    const hasProviderLot = providerLotNumber !== null && Number.isFinite(providerLotNumber) && providerLotNumber > 0;
    symbols.push({
      id,
      name,
      category: textValue(firstValue(raw, [
        "symbolCategory", "category", "assetClass", "type", "symbolCategoryId",
      ]), "symbol category"),
      lotSize: hasProviderLot ? providerLotNumber : null,
      lotSizeSource: hasProviderLot ? "provider" : "unavailable",
      raw,
    });
  }
  if (symbols.length === 0) {
    throw new CTraderSyncError("CTRADER_MCP_SYMBOLS_EMPTY", "cTrader returned no usable symbols", false);
  }
  return symbols;
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
  "CTRADER_MCP_OPENING_LINEAGE_UNPROVEN",
  "CTRADER_MCP_POSITION_VOLUME_INVALID",
  "CTRADER_MCP_OPEN_SIDE_MISMATCH",
  "CTRADER_MCP_CLOSE_SIDE_MISMATCH",
  "CTRADER_MCP_VOLUME_INVALID",
  "CTRADER_MCP_CALCULATION_INVALID",
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

function unwrapFirstObject(value: unknown): JsonRecord {
  if (Array.isArray(value)) return objectValue(value[0]);
  const root = objectValue(value);
  for (const key of ["account", "balance", "data", "result"] as const) {
    const nested = root[key];
    if (Array.isArray(nested)) return objectValue(nested[0]);
    if (typeof nested === "object" && nested !== null) return objectValue(nested);
  }
  return root;
}

function firstText(objects: readonly JsonRecord[], keys: readonly string[]): string | null {
  for (const object of objects) {
    for (const key of keys) {
      const value = object[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }
  return null;
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
  const total = deals.reduce((sum, deal) => sum + Number(deal.filledVolumeCents), 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new CTraderSyncError("CTRADER_MCP_VOLUME_INVALID", "cTrader position has no positive volume", false);
  }
  return deals.reduce(
    (sum, deal) => sum + deal.executionPrice * (Number(deal.filledVolumeCents) / total),
    0,
  );
}

function moneyFromCents(value: number): string {
  return decimal(value / 100, 10);
}

function sumOptionalCents(deals: readonly McpDeal[], field: "commissionCents" | "swapCents"): string | null {
  const values = deals.map((deal) => deal[field]).filter((value): value is number => value !== null);
  return values.length === 0 ? null : moneyFromCents(values.reduce((sum, value) => sum + value, 0));
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

function projectMcpPosition(
  dealsValue: readonly McpDeal[],
  symbol: McpSymbol,
  timeZone: string,
  accountCurrency: string | null,
  floorKind: string,
): McpProjection {
  const deals = [...dealsValue].sort((left, right) =>
    left.executionTimestamp - right.executionTimestamp || compareDealIds(left.dealId, right.dealId));
  const first = deals[0];
  if (!first) throw new CTraderSyncError("CTRADER_MCP_POSITION_EMPTY", "cTrader position has no deals", false);
  if (deals.some((deal) => deal.positionId !== first.positionId)) {
    throw new CTraderSyncError("CTRADER_MCP_POSITIONS_MIXED", "cTrader returned mixed positions", false);
  }
  const explicitOpening = deals.filter((deal) => deal.role === "OPEN");
  const attestedBoundaryInference = floorKind === "connection_time_empty_attested"
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
  if (symbol.lotSize === null) {
    throw new CTraderSyncError(
      "CTRADER_MCP_LOT_SIZE_UNAVAILABLE",
      `cTrader did not provide an authoritative contract size for ${symbol.name}`,
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
  const completeProviderPnl = closing.length > 0 && closing.every((deal) => deal.pnlCents !== null);
  const realizedEvents = completeProviderPnl
    ? closing.map((deal) => {
        const local = localDateTime(deal.executionTimestamp, timeZone);
        const pnl = moneyFromCents(deal.pnlCents ?? 0);
        return {
          executionId: deal.dealId,
          executedAt: new Date(deal.executionTimestamp).toISOString(),
          date: local.date,
          time: local.time,
          closedVolumeCents: deal.filledVolumeCents.toString(),
          price: decimal(deal.executionPrice),
          pnl,
          grossProfit: null,
          commission: deal.commissionCents === null ? null : moneyFromCents(deal.commissionCents),
          swap: deal.swapCents === null ? null : moneyFromCents(deal.swapCents),
          pnlConversionFee: null,
        };
      })
    : [];
  const totalPnl = completeProviderPnl
    ? moneyFromCents(closing.reduce((sum, deal) => sum + (deal.pnlCents ?? 0), 0))
    : null;
  const entryLocal = localDateTime(first.executionTimestamp, timeZone);
  const lastClose = closing.at(-1) ?? null;
  const exitLocal = lastClose ? localDateTime(lastClose.executionTimestamp, timeZone) : null;
  const openVolume = opened - closed;
  const quantityLots = Number(opened) / (symbol.lotSize * 100);
  const asset = assetForSymbol(symbol);
  return {
    positionId: first.positionId,
    symbolId: first.symbolId,
    symbol: symbol.name,
    asset,
    direction,
    entryPrice: decimal(entry),
    exitPrice: exit === null ? null : decimal(exit),
    quantityLots: decimal(quantityLots),
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
      openedVolumeCents: opened.toString(),
      closedVolumeCents: closed.toString(),
      openVolumeCents: openVolume.toString(),
      pnlMethod: totalPnl === null ? "unavailable" : "provider_explicit_net_cents",
      grossProfit: null,
      commission: sumOptionalCents(closing, "commissionCents"),
      swap: sumOptionalCents(closing, "swapCents"),
      pnlConversionFee: null,
      realizedEvents,
      accountCurrency,
      classification: {
        symbolCategoryName: symbol.category,
        reviewNeeded: attestedBoundaryInference || (closing.length > 0 && totalPnl === null) || asset === null,
        lotSizeSource: symbol.lotSizeSource,
        openingLineage: explicitOpening[0] === first
          ? "provider"
          : attestedBoundaryInference
            ? "user_attested_empty_at_connection"
            : "registration_bound",
      },
    },
  };
}

// Implementation is intentionally server-only. The browser never receives the
// trading-capable Remote MCP bearer token, and this adapter's dependency only
// exposes the four reviewed read calls above.
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
      const symbolsRaw = await client.getSymbols();
      await heartbeat();
      let accountInfoRaw: unknown = null;
      try {
        accountInfoRaw = await client.getAccountInfo();
      } catch (error) {
        if (!(error instanceof CTraderMcpError) || error.code !== "TOOL_UNAVAILABLE") throw error;
      }
      const balance = unwrapFirstObject(balanceRaw);
      const accountInfo = unwrapFirstObject(accountInfoRaw);
      const detectedAccount = firstText([balance, accountInfo], [
        "accountId", "account_id", "ctidTraderAccountId", "traderAccountId",
      ]);
      if (detectedAccount !== null && detectedAccount !== connection.external_account_id) {
        throw new CTraderSyncError(
          "CTRADER_MCP_ACCOUNT_MISMATCH",
          "The cTrader credential no longer belongs to this connected account",
          false,
          true,
        );
      }
      const symbols = normalizeSymbols(symbolsRaw);
      const symbolById = new Map(symbols.map((symbol) => [symbol.id, symbol]));
      const cursorBefore = safeCursor(connection.sync_cursor);
      const providerMetadata = objectValue(connection.provider_metadata);
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
      const fetched = await this.fetchDeals(client, connection.external_account_id, from, now, heartbeat);
      const accountCurrency = firstText([balance, accountInfo, providerMetadata], [
        "currency", "currencyCode", "accountCurrency",
      ])?.toUpperCase() ?? null;
      const result = await this.persist({
        connection,
        fetched,
        symbols,
        symbolById,
        cursorBefore,
        historyFloorTimestamp: metadataTimestamp(providerMetadata.historyFloorTimestamp) ?? from,
        queryFromTimestamp: from,
        syncedThroughTimestamp: now,
        accountCurrency,
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

  private async fetchDeals(
    client: CTraderMcpReadClientLike,
    accountId: string,
    fromTimestamp: number,
    toTimestamp: number,
    heartbeat: () => Promise<void>,
  ): Promise<McpDeal[]> {
    const byId = new Map<string, McpDeal>();
    let sawAnyDeal = false;
    let sawMatchingAccount = false;
    let cursor = Math.max(0, Math.min(fromTimestamp, toTimestamp - 1));
    while (cursor < toTimestamp) {
      const end = Math.min(cursor + MAX_HISTORY_WINDOW_MS, toTimestamp);
      const raw = await client.getDeals({
        fromTimestamp: new Date(cursor).toISOString(),
        toTimestamp: new Date(end).toISOString(),
      });
      assertCompleteHistoryPage(raw);
      const rows = unwrapArray(raw, ["deals", "data", "result", "items", "history"], "deal history");
      for (const row of rows) {
        const deal = normalizeDeal(row);
        sawAnyDeal = true;
        if (deal.accountId === null) {
          throw new CTraderSyncError(
            "CTRADER_MCP_ACCOUNT_ATTRIBUTION_MISSING",
            `cTrader deal ${deal.dealId} has no account attribution`,
            false,
          );
        }
        if (deal.accountId !== accountId) continue;
        sawMatchingAccount = true;
        const previous = byId.get(deal.dealId);
        if (previous && json(canonicalStoredDeal(previous)) !== json(canonicalStoredDeal(deal))) {
          throw new CTraderSyncError(
            "CTRADER_MCP_DUPLICATE_DEAL_CONFLICT",
            `cTrader returned conflicting data for deal ${deal.dealId}`,
            false,
          );
        }
        byId.set(deal.dealId, deal);
      }
      await heartbeat();
      cursor = end;
    }
    if (sawAnyDeal && !sawMatchingAccount) {
      throw new CTraderSyncError(
        "CTRADER_MCP_ACCOUNT_HISTORY_MISMATCH",
        "cTrader returned history for a different account",
        false,
        true,
      );
    }
    return [...byId.values()].sort((left, right) =>
      left.executionTimestamp - right.executionTimestamp || compareDealIds(left.dealId, right.dealId));
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
    accountCurrency: string | null;
  }): Promise<CTraderSyncResult> {
    const persisted = await withTransaction(this.database, async (client) => {
      const locked = await client.query<{ connected: boolean; token_generation: string | number }>(
        `SELECT connected, token_generation FROM broker_connections
         WHERE id=$1 AND provider='ctrader' AND connection_mode='mcp_read'
           AND oauth_scope='mcp_read' AND provider_environment IS NOT NULL
         FOR UPDATE`,
        [input.connection.id],
      );
      const lockedConnection = locked.rows[0];
      if (!lockedConnection?.connected) {
        throw new CTraderSyncError("CTRADER_DISCONNECTED", "The cTrader connection was disconnected during sync", false);
      }
      if (String(lockedConnection.token_generation) !== String(input.connection.token_generation)) {
        throw new CTraderSyncError("CTRADER_CONNECTION_CHANGED", "The cTrader connection changed during sync", true);
      }
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
      const existingExecutions = executionIds.length === 0
        ? new Set<string>()
        : new Set((await client.query<{ external_execution_id: string }>(
            `SELECT external_execution_id FROM trade_executions
             WHERE broker_connection_id=$1 AND external_execution_id=ANY($2::text[])`,
            [input.connection.id, executionIds],
          )).rows.map((row) => row.external_execution_id));
      for (const deal of input.fetched) {
        const rawPayload = { edgebookMcpDeal: canonicalStoredDeal(deal) };
        const moneyDigits = deal.pnlCents === null
          && deal.commissionCents === null
          && deal.swapCents === null
          ? null
          : 2;
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
             $17,$18,NULL,$19,NULL,$20
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
             closed_volume_cents=NULL,
             money_digits=EXCLUDED.money_digits,
             close_position_detail=NULL,
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
            deal.pnlCents === null ? null : moneyFromCents(deal.pnlCents),
            deal.commissionCents === null ? null : moneyFromCents(deal.commissionCents),
            deal.swapCents === null ? null : moneyFromCents(deal.swapCents),
            input.accountCurrency,
            new Date(deal.executionTimestamp),
            json(rawPayload),
            deal.dealStatus,
            deal.filledVolumeCents.toString(),
            moneyDigits,
            deal.providerUpdatedTimestamp === null ? null : new Date(deal.providerUpdatedTimestamp),
          ],
        );
        if (existingExecutions.has(deal.dealId)) counters.updatedExecutions += 1;
        else counters.insertedExecutions += 1;
      }

      await this.upsertSymbols(client, input.connection, input.symbols);
      // Retry previously quarantined positions on every sync. Their executions
      // are already stored server-side, so a later provider response that adds
      // authoritative symbol sizing can make them projectable without replaying
      // the complete account history.
      const positionIds = [...new Set([
        ...input.fetched.map((deal) => deal.positionId),
        ...cursorPositionIds(input.cursorBefore.positionsAwaitingReviewIds),
      ])];
      const awaitingReview = new Map<string, string>();
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
          try { deal = normalizeDeal(row.raw_payload); } catch {
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
          if (await this.positionSuppressed(client, input.connection, positionId, counters)) continue;
          const deals = grouped.get(positionId);
          if (!deals || deals.length === 0) {
            await this.quarantineProjection(client, input.connection, positionId, "CTRADER_MCP_POSITION_MISSING");
            awaitingReview.set(positionId, "CTRADER_MCP_POSITION_MISSING");
            continue;
          }
          const first = deals[0];
          if (!first) continue;
          const symbol = input.symbolById.get(first.symbolId);
          if (!symbol) {
            await this.quarantineProjection(client, input.connection, positionId, "CTRADER_MCP_SYMBOL_UNAVAILABLE");
            awaitingReview.set(positionId, "CTRADER_MCP_SYMBOL_UNAVAILABLE");
            continue;
          }
          let projection: McpProjection;
          try {
            projection = projectMcpPosition(
              deals,
              symbol,
              this.config.cTrader.tradingTimeZone,
              input.accountCurrency,
              String(objectValue(input.connection.provider_metadata).historyFloorKind ?? "unknown"),
            );
          } catch (error) {
            const reason = projectionReviewReason(error);
            if (reason === null) throw error;
            await this.quarantineProjection(client, input.connection, positionId, reason);
            awaitingReview.set(positionId, reason);
            continue;
          }
          await this.upsertProjection(client, input.connection, projection, counters);
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
        lastDealId: lastDeal?.dealId
          ?? (typeof input.cursorBefore.lastDealId === "string" ? input.cursorBefore.lastDealId : null),
        positionsAwaitingReviewIds: [...awaitingReview.keys()].sort(),
      };
      const reviewReasonCounts = reasonCounts(awaitingReview);
      const reviewWarning = awaitingReview.size > 0
        ? `${awaitingReview.size} cTrader position${awaitingReview.size === 1 ? "" : "s"} imported as executions but withheld from the trade journal because authoritative projection data is incomplete or inconsistent. Edgebook did not guess financial values; these positions stay out of totals until cTrader exposes complete data or a verified review workflow is available.`
        : null;
      const metadata = {
        accountCurrency: input.accountCurrency,
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
    const tombstone = await client.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM ctrader_trade_tombstones
         WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
       ) AS exists`,
      [connection.user_id, connection.id, externalKey],
    );
    if (tombstone.rows[0]?.exists) {
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
    await client.query(
      `UPDATE trades SET
         pnl=NULL,
         broker_data=(broker_data
           - 'realizedEvents' - 'grossProfit' - 'commission' - 'swap' - 'pnlConversionFee')
           || jsonb_build_object(
             'realizedEvents','[]'::jsonb,
             'pnlMethod','unavailable',
             'grossProfit',NULL,
             'commission',NULL,
             'swap',NULL,
             'pnlConversionFee',NULL,
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
         AND (
           broker_data #> '{classification,projectionQuarantined}' IS DISTINCT FROM 'true'::jsonb
           OR broker_data #>> '{classification,projectionQuarantineReason}' IS DISTINCT FROM $4
           OR pnl IS NOT NULL
         )`,
      [connection.user_id, connection.id, externalKey, reason],
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
            lotSize: symbol.lotSize,
            lotSizeSource: symbol.lotSizeSource,
            symbolCategory: symbol.category,
            connectionMode: "mcp_read",
          }),
          this.config.cTrader.symbolCacheSeconds,
        ],
      );
    }
  }

  private async upsertProjection(
    client: PoolClient,
    connection: McpConnectionRow,
    projection: McpProjection,
    counters: CTraderSyncCounters,
  ): Promise<void> {
    const externalKey = `position:${projection.positionId}`;
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
         trade_date=EXCLUDED.trade_date,
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
         trades.is_open, trades.trade_date, trades.entry_at, trades.exit_at,
         trades.legacy_entry_time, trades.legacy_exit_time, trades.broker_data,
         trades.calculation_version
       ) IS DISTINCT FROM (
         EXCLUDED.account_id, EXCLUDED.legacy_account_id, EXCLUDED.broker_trade_id,
         EXCLUDED.symbol, EXCLUDED.asset, EXCLUDED.instrument, EXCLUDED.direction,
         EXCLUDED.entry_price, EXCLUDED.exit_price, EXCLUDED.quantity, EXCLUDED.pnl,
         EXCLUDED.is_open, EXCLUDED.trade_date, EXCLUDED.entry_at, EXCLUDED.exit_at,
         EXCLUDED.legacy_entry_time, EXCLUDED.legacy_exit_time, EXCLUDED.broker_data,
         EXCLUDED.calculation_version
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
        projection.quantityLots,
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
