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
  type CTraderDeal,
  type CTraderEnvironment,
  type CTraderLightSymbol,
  type CTraderSymbolCategory,
  type CTraderSymbolSpec,
  type CTraderTraderMetadata,
} from "./protocol.js";

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
        // The most recent payload wins, while persistence still records the
        // provider update timestamp and keeps the operation idempotent.
        const previousUpdate = previous.providerUpdatedTimestamp ?? previous.executionTimestamp;
        const nextUpdate = deal.providerUpdatedTimestamp ?? deal.executionTimestamp;
        if (nextUpdate >= previousUpdate) deals.set(deal.dealId, deal);
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
    cursorBefore: Record<string, unknown>;
    registrationTimestamp: number;
    syncedThroughTimestamp: number;
  }): Promise<CTraderSyncResult> {
    const result = await withTransaction(this.database, async (client) => {
      const locked = await client.query<{ connected: boolean }>(
        `SELECT connected FROM broker_connections
         WHERE id=$1 AND provider='ctrader' AND connection_mode='official'
           AND oauth_scope='accounts'
           AND provider_environment IS NOT NULL FOR UPDATE`,
        [input.connection.id],
      );
      if (!locked.rows[0]?.connected) {
        throw new CTraderSyncError("CTRADER_DISCONNECTED", "The cTrader connection was disconnected during sync", false);
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
      };
      const dealIds = input.fetchedDeals.map((deal) => deal.dealId);
      const existingExecutions = dealIds.length === 0
        ? new Set<string>()
        : new Set((await client.query<{ external_execution_id: string }>(
            `SELECT external_execution_id FROM trade_executions
             WHERE broker_connection_id=$1 AND external_execution_id=ANY($2::text[])`,
            [input.connection.id, dealIds],
          )).rows.map((row) => row.external_execution_id));

      for (const deal of input.fetchedDeals) {
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
        if (existingExecutions.has(deal.dealId)) counters.updatedExecutions += 1;
        else counters.insertedExecutions += 1;
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
        lastDealTimestamp: input.fetchedDeals.at(-1)?.executionTimestamp
          ?? safeTimestamp(input.cursorBefore.lastDealTimestamp),
        lastDealId: input.fetchedDeals.at(-1)?.dealId
          ?? (typeof input.cursorBefore.lastDealId === "string" ? input.cursorBefore.lastDealId : null),
      };
      const metadata = {
        registrationTimestamp: input.registrationTimestamp,
        depositAssetId: input.trader.depositAssetId,
        accountCurrency: this.accountCurrency(input.trader, input.assets),
        accountMoneyDigits: input.trader.moneyDigits,
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
      `SELECT id, deleted_at FROM trades
       WHERE broker_connection_id=$1 AND external_trade_key=$2
       LIMIT 1`,
      [input.connection.id, externalKey],
    );
    const previous = existing.rows[0] ?? null;
    if (previous?.deleted_at) {
      counters.archivedTradesPreserved += 1;
      return;
    }
    const brokerData = {
      provider: "ctrader",
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
      accountCurrency: this.accountCurrency(input.trader, input.assets),
      classification: projection.classification,
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
