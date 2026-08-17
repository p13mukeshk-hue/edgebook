import path from "node:path";
import type { PoolClient, QueryResult } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { CTraderGateway } from "../src/ctrader/client.js";
import { AesGcmTokenCipher, connectionTokenAad } from "../src/ctrader/crypto.js";
import type { CTraderOAuthClient } from "../src/ctrader/oauth.js";
import type { CTraderDeal } from "../src/ctrader/protocol.js";
import { CTraderSyncEngine } from "../src/ctrader/sync.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";

const userId = "00000000-0000-4000-8000-000000000002";
const connectionId = "00000000-0000-4000-8000-000000000090";

function result(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult;
}

describe("official cTrader account-ledger sync", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("backfills cash flows from registration and persists exact money separately from trades", async () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const registration = new Date("2026-08-12T12:00:00.000Z").getTime();
    vi.setSystemTime(now);
    const config = loadConfig({
      NODE_ENV: "test",
      PUBLIC_ORIGIN: "http://localhost:3210",
      DATABASE_URL: "postgresql://localhost/unused",
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
      SESSION_PEPPER: "p".repeat(48),
      COOKIE_SECURE: "false",
      UPLOAD_ROOT: path.resolve("test-uploads"),
      CTRADER_CLIENT_ID: "official-client",
      CTRADER_CLIENT_SECRET: "official-secret",
      CTRADER_REDIRECT_URI: "http://localhost:3210/api/auth/ctrader/callback",
      CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 4).toString("base64url") }),
      CTRADER_ACTIVE_KEY_VERSION: "1",
    });
    const cipher = AesGcmTokenCipher.fromConfig(config.cTrader);
    const clientQueries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        clientQueries.push({ sql, values });
        if (sql.includes("SELECT connected, mapped_account_id, legacy_mapped_account_id")) {
          return result([{ connected: true, mapped_account_id: null, legacy_mapped_account_id: null }]);
        }
        if (sql.includes("count(*)::text AS total_rows")) {
          return result([{ total_rows: "2", scaled_rows: "1", unscaled_rows: "1" }]);
        }
        if (sql.includes("AND (money_digits_source<>'cash_flow'")) {
          return result([{
            external_cash_flow_id: "89",
            occurred_at: new Date("2026-08-13T10:00:00.000Z"),
          }]);
        }
        if (sql.includes("SELECT external_cash_flow_id")) return result([]);
        if (sql.includes("INSERT INTO ctrader_account_cash_flows")) {
          return result([{ id: "00000000-0000-4000-8000-000000000099" }]);
        }
        if (sql.includes("UPDATE ctrader_account_cash_flows SET")) return result([]);
        return result([]);
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const database = {
      query: vi.fn(async (sql: string) => {
        if (!sql.includes("FROM broker_connections")) return result([]);
        return result([{
          id: connectionId,
          user_id: userId,
          external_account_id: "5032134",
          provider_environment: "live",
          connected: true,
          access_token_ciphertext: cipher.encrypt("access", connectionTokenAad(connectionId, "access")),
          refresh_token_ciphertext: cipher.encrypt("refresh", connectionTokenAad(connectionId, "refresh")),
          encryption_key_version: 1,
          token_expires_at: new Date("2026-09-01T00:00:00.000Z"),
          token_generation: "1",
          sync_cursor: {},
          provider_metadata: {},
          mapped_account_id: null,
          legacy_mapped_account_id: null,
        }]);
      }),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const listCashFlows = vi.fn(async () => [
      {
        balanceHistoryId: "88",
        operationType: 17,
        operationName: "BALANCE_WITHDRAW_GSL_CHARGE",
        balance: 249_875n,
        delta: -125n,
        changeBalanceTimestamp: new Date("2026-08-13T09:00:00.000Z").getTime(),
        balanceVersion: 9n,
        equity: 249_902n,
        moneyDigits: 1,
      },
      {
        balanceHistoryId: "89",
        operationType: null,
        operationName: "BALANCE_FUTURE_BROKER_ADJUSTMENT",
        balance: 249_874n,
        delta: -1n,
        changeBalanceTimestamp: new Date("2026-08-13T10:00:00.000Z").getTime(),
        balanceVersion: 10n,
        equity: null,
        moneyDigits: null,
      },
    ]);
    const close = vi.fn(async () => undefined);
    const gateway = {
      openAccount: vi.fn(async () => ({
        getTraderMetadata: async () => ({
          registrationTimestamp: registration,
          depositAssetId: "1",
          moneyDigits: 2,
          balance: 2_489_291n,
          balanceVersion: 77n,
          raw: {},
        }),
        listAssets: async () => [{ assetId: "1", name: "USD", displayName: null, digits: 2, raw: {} }],
        listAssetClasses: async () => [],
        listSymbolCategories: async () => [],
        listSymbols: async () => [],
        getSymbolDetails: async () => [],
        listDeals: async () => ({ deals: [], hasMore: false }),
        listCashFlows,
        close,
      })),
    } as unknown as CTraderGateway;
    const engine = new CTraderSyncEngine(
      database,
      config,
      {} as CTraderOAuthClient,
      gateway,
      cipher,
      { publish: vi.fn(async () => ({ id: 1 })) } as unknown as EventBus,
    );

    const sync = await engine.syncConnection(connectionId);
    expect(listCashFlows).toHaveBeenCalledWith(registration, now.getTime());
    expect(sync.counters).toMatchObject({
      fetchedAccountCashFlows: 2,
      insertedAccountCashFlows: 2,
      updatedAccountCashFlows: 0,
      totalAccountCashFlows: 2,
      scaledAccountCashFlows: 1,
      unscaledAccountCashFlows: 1,
      pendingCashFlowMoneyRetries: 1,
    });
    expect(sync.cursorAfter).toMatchObject({
      cashFlowHistoryComplete: true,
      cashFlowSyncedThroughTimestamp: now.getTime(),
      lastCashFlowId: "89",
      cashFlowMoneyRetries: [expect.objectContaining({ balanceHistoryId: "89" })],
    });
    const metadataUpdate = clientQueries.find(query => query.sql.includes("provider_metadata="));
    expect(JSON.parse(String(metadataUpdate?.values[1]))).toMatchObject({
      accountBalance: "24892.91",
      accountBalanceRawUnits: "2489291",
      accountBalanceVersion: "77",
      accountBalanceMoneyDigits: 2,
      accountBalanceSource: "ProtoOATrader",
      accountBalanceScalingStatus: "exact",
      accountBalanceAsOf: now.toISOString(),
      accountCashFlowHistoryComplete: true,
      accountCashFlowHistoryStartTimestamp: registration,
      accountCashFlowSyncedThroughTimestamp: now.getTime(),
      accountCashFlowMonetaryScaleComplete: false,
      accountCashFlowTotalRows: 2,
      accountCashFlowScaledRows: 1,
      accountCashFlowUnscaledRows: 1,
      accountCashFlowPendingScaleRetries: 1,
    });
    const inserts = clientQueries.filter(query => query.sql.includes("INSERT INTO ctrader_account_cash_flows"));
    const insert = inserts[0];
    expect(insert?.values).toEqual(expect.arrayContaining([
      userId,
      connectionId,
      "88",
      "BALANCE_WITHDRAW_GSL_CHARGE",
      "-12.5",
      "24987.5",
      "24990.2",
      "USD",
    ]));
    expect(insert?.values[13]).toBe(1);
    expect(insert?.values[14]).toBe("cash_flow");
    expect(insert?.sql).toContain("ON CONFLICT (broker_connection_id, external_cash_flow_id)");
    expect(insert?.sql).toContain("IS DISTINCT FROM");
    expect(insert?.sql).not.toMatch(/trade_id|position_id/i);
    expect(inserts[1]?.values.slice(3, 17)).toEqual([
      "89", null, "BALANCE_FUTURE_BROKER_ADJUSTMENT",
      null, null, null,
      "-1", "249874", null,
      "USD", null, "unavailable", "10", new Date("2026-08-13T10:00:00.000Z"),
    ]);
    expect(clientQueries.some(query => /money_digits_source\s*=\s*'account'\s*,/.test(query.sql))).toBe(false);
    expect(close).toHaveBeenCalledOnce();
    expect(clientQueries[0]?.sql).toBe("BEGIN");
    expect(clientQueries.at(-1)?.sql).toBe("COMMIT");
    expect(clientQueries.some(query => query.sql === "ROLLBACK")).toBe(false);
  });

  it("keeps a staged manual duplicate non-resolvable until exact close money restages it", async () => {
    const now = new Date("2026-08-13T12:00:00.000Z");
    const registration = new Date("2026-08-01T00:00:00.000Z").getTime();
    vi.setSystemTime(now);
    const mappedAccountId = "00000000-0000-4000-8000-000000000093";
    const manualTradeId = "00000000-0000-4000-8000-000000000301";
    const openRaw = {
      dealId: "1001", orderId: "501", positionId: "9001",
      volume: "1000000", filledVolume: "1000000", symbolId: "41",
      createTimestamp: String(new Date("2026-08-11T04:00:00.000Z").getTime()),
      executionTimestamp: String(new Date("2026-08-11T04:00:00.000Z").getTime()),
      executionPrice: 2000, tradeSide: "BUY", dealStatus: "FILLED", moneyDigits: 2,
    };
    const closeRaw = {
      dealId: "1002", orderId: "502", positionId: "9001",
      volume: "1000000", filledVolume: "1000000", symbolId: "41",
      createTimestamp: String(new Date("2026-08-11T05:00:00.000Z").getTime()),
      executionTimestamp: String(new Date("2026-08-11T05:00:00.000Z").getTime()),
      executionPrice: 2010, tradeSide: "SELL", dealStatus: "FILLED", moneyDigits: 2,
      closePositionDetail: {
        entryPrice: 2000,
        grossProfit: "1000",
        swap: "0",
        commission: "-100",
        balance: "2489291",
        closedVolume: "1000000",
        moneyDigits: 2,
        pnlConversionFee: "0",
      },
    };
    const weakCloseRaw = {
      ...closeRaw,
      closePositionDetail: {
        ...closeRaw.closePositionDetail,
        moneyDigits: undefined,
      },
    };
    const deal = (raw: typeof openRaw | typeof closeRaw | typeof weakCloseRaw): CTraderDeal => ({
      ...raw,
      dealId: raw.dealId,
      orderId: raw.orderId,
      positionId: raw.positionId,
      volumeCents: 1_000_000n,
      filledVolumeCents: 1_000_000n,
      symbolId: "41",
      createTimestamp: Number(raw.createTimestamp),
      executionTimestamp: Number(raw.executionTimestamp),
      providerUpdatedTimestamp: null,
      executionPrice: raw.executionPrice,
      tradeSide: raw.tradeSide as "BUY" | "SELL",
      dealStatus: 2 as const,
      moneyDigits: 2,
      commission: null,
      closePositionDetail: "closePositionDetail" in raw ? {
        entryPrice: 2000,
        grossProfit: 1_000n,
        swap: 0n,
        commission: -100n,
        balance: 2_489_291n,
        closedVolumeCents: 1_000_000n,
        moneyDigits: typeof raw.closePositionDetail.moneyDigits === "number"
          ? raw.closePositionDetail.moneyDigits
          : null,
        pnlConversionFee: 0n,
        raw: raw.closePositionDetail,
      } : null,
      raw,
    });
    const openDeal = deal(openRaw);
    const exactCloseDeal = deal(closeRaw);
    const weakCloseDeal = deal(weakCloseRaw);
    let exactCloseAvailable = false;
    const config = loadConfig({
      NODE_ENV: "test",
      PUBLIC_ORIGIN: "http://localhost:3210",
      DATABASE_URL: "postgresql://localhost/unused",
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
      SESSION_PEPPER: "p".repeat(48),
      COOKIE_SECURE: "false",
      UPLOAD_ROOT: path.resolve("test-uploads"),
      CTRADER_CLIENT_ID: "official-client",
      CTRADER_CLIENT_SECRET: "official-secret",
      CTRADER_REDIRECT_URI: "http://localhost:3210/api/auth/ctrader/callback",
      CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 4).toString("base64url") }),
      CTRADER_ACTIVE_KEY_VERSION: "1",
    });
    const cipher = AesGcmTokenCipher.fromConfig(config.cTrader);
    const clientQueries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        clientQueries.push({ sql, values });
        if (sql.includes("FROM accounts") && sql.includes("FOR SHARE")) {
          return result([{ id: mappedAccountId, legacy_account_id: "master-25k", currency_code: "USD" }]);
        }
        if (sql.includes("SELECT connected, mapped_account_id, legacy_mapped_account_id")) {
          return result([{ connected: true, mapped_account_id: mappedAccountId, legacy_mapped_account_id: "master-25k" }]);
        }
        if (sql.includes("SELECT external_execution_id, raw_payload")) return result([]);
        if (sql.includes("SELECT external_position_id, raw_payload")) {
          return result([
            { external_position_id: "9001", raw_payload: openRaw },
            { external_position_id: "9001", raw_payload: exactCloseAvailable ? closeRaw : weakCloseRaw },
          ]);
        }
        if (sql.includes("ctrader_trade_tombstones") && sql.includes("SELECT EXISTS")) return result([{ exists: false }]);
        if (sql.includes("SELECT status FROM ctrader_live_reconciliation_candidates")) return result([]);
        if (sql.includes("SELECT id, row_version, deleted_at FROM trades")) return result([]);
        if (sql.includes("FROM trades manual") && sql.includes("manual.trade_date BETWEEN")) {
          return result([{
            id: manualTradeId,
            row_version: 4,
            deleted_at: null,
            symbol: "GOLD",
            direction: "Long",
            entry_price: "2000",
            exit_price: "2010",
            quantity: "0.1",
            pnl: "9",
            trade_date: "2026-08-11",
            entry_at: null,
            exit_at: null,
            strategy: "Breakout",
            emotion: "Calm",
            notes: "Keep psychology",
            psychology: { review: "kept" },
            custom_fields: { setup: "A" },
            screenshot_count: "2",
          }]);
        }
        return result([]);
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const database = {
      query: vi.fn(async (sql: string) => sql.includes("FROM broker_connections") ? result([{
        id: connectionId,
        user_id: userId,
        external_account_id: "5050060",
        provider_environment: "live",
        connected: true,
        access_token_ciphertext: cipher.encrypt("access", connectionTokenAad(connectionId, "access")),
        refresh_token_ciphertext: cipher.encrypt("refresh", connectionTokenAad(connectionId, "refresh")),
        encryption_key_version: 1,
        token_expires_at: new Date("2026-09-01T00:00:00.000Z"),
        token_generation: "1",
        sync_cursor: {},
        provider_metadata: {},
        mapped_account_id: mappedAccountId,
        legacy_mapped_account_id: "master-25k",
      }]) : result([])),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const gateway = {
      openAccount: vi.fn(async () => ({
        getTraderMetadata: async () => ({
          registrationTimestamp: registration,
          depositAssetId: "1",
          moneyDigits: 2,
          balance: 2_489_291n,
          balanceVersion: 77n,
          raw: {},
        }),
        listAssets: async () => [{ assetId: "1", name: "USD", displayName: null, digits: 2, raw: {} }],
        listAssetClasses: async () => [],
        listSymbolCategories: async () => [],
        listSymbols: async () => [{
          symbolId: "41", symbolName: "XAUUSD", baseAssetId: null, quoteAssetId: null,
          symbolCategoryId: null, raw: {},
        }],
        getSymbolDetails: async () => [{
          symbolId: "41", symbolName: "XAUUSD", lotSizeCents: 10_000_000n,
          digits: 2, pipPosition: 1, raw: {},
        }],
        listDeals: async (from: number, to: number) => ({
          deals: [openDeal, exactCloseAvailable ? exactCloseDeal : weakCloseDeal]
            .filter(observation => observation.executionTimestamp >= from && observation.executionTimestamp <= to),
          hasMore: false,
        }),
        listCashFlows: async () => [],
        close: vi.fn(async () => undefined),
      })),
    } as unknown as CTraderGateway;
    const engine = new CTraderSyncEngine(
      database,
      config,
      {} as CTraderOAuthClient,
      gateway,
      cipher,
      { publish: vi.fn(async () => ({ id: 1 })) } as unknown as EventBus,
    );

    const incompleteSync = await engine.syncConnection(connectionId);
    expect(incompleteSync.counters).toMatchObject({ positionsProjected: 1, insertedTrades: 0 });
    const incompleteStage = clientQueries
      .filter(query => query.sql.includes("INSERT INTO ctrader_live_reconciliation_candidates"))[0];
    expect(JSON.parse(String(incompleteStage?.values[12]))).toMatchObject({
      exactMoneyRepairPending: true,
      exactMoneyRepairReason: "close_position_detail_money_digits_unavailable",
    });
    expect(JSON.parse(String(incompleteStage?.values[13]))).toMatchObject({
      pnl: null,
      brokerData: {
        pnlAuthority: "provider_unavailable",
        pnlMethod: "partial_provider_close_detail_unavailable",
        realizedEvents: [],
      },
    });
    expect(incompleteStage?.values[14]).toEqual(Buffer.alloc(32, 0xff));

    exactCloseAvailable = true;
    const sync = await engine.syncConnection(connectionId);

    expect(sync.counters).toMatchObject({ positionsProjected: 1, insertedTrades: 0 });
    const staged = clientQueries
      .filter(query => query.sql.includes("INSERT INTO ctrader_live_reconciliation_candidates"))[1];
    expect(staged?.values.slice(5, 11)).toEqual([manualTradeId, 4, null, null, "high_confidence", 100]);
    const exactCandidateData = JSON.parse(String(staged?.values[12]));
    expect(exactCandidateData).toMatchObject({
      manualChoices: [{ id: manualTradeId, symbol: "GOLD", screenshotCount: 2 }],
    });
    expect(exactCandidateData).not.toHaveProperty("exactMoneyRepairPending");
    expect(staged?.values[14]).not.toEqual(Buffer.alloc(32, 0xff));
    expect(JSON.parse(String(staged?.values[13]))).toMatchObject({
      symbol: "XAUUSD",
      quantity: "0.1",
      quantityUnit: "lots",
      quantityBaseUnits: "10000",
      pnl: "9",
      brokerData: {
        connectionMode: "official",
        grossProfit: "10",
        commission: "-1",
        quantityProjection: {
          value: "0.1", unit: "lots", lots: "0.1", baseUnits: "10000",
          volumeScale: "unit_cents", source: "provider_filled_volume",
        },
      },
    });
    expect(clientQueries.some(query => /INSERT INTO trades\s*\(/.test(query.sql))).toBe(false);
  });

  it("durably refetches an old unscaled cash flow and upgrades it only when the row exponent appears", async () => {
    const firstNow = new Date("2026-08-13T12:00:00.000Z");
    const registration = new Date("2026-08-12T12:00:00.000Z").getTime();
    const flowAt = new Date("2026-08-12T13:00:00.000Z").getTime();
    vi.setSystemTime(firstNow);
    const config = loadConfig({
      NODE_ENV: "test", PUBLIC_ORIGIN: "http://localhost:3210", DATABASE_URL: "postgresql://localhost/unused",
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", SESSION_PEPPER: "p".repeat(48),
      COOKIE_SECURE: "false", UPLOAD_ROOT: path.resolve("test-uploads"),
      CTRADER_CLIENT_ID: "official-client", CTRADER_CLIENT_SECRET: "official-secret",
      CTRADER_REDIRECT_URI: "http://localhost:3210/api/auth/ctrader/callback",
      CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 4).toString("base64url") }),
      CTRADER_ACTIVE_KEY_VERSION: "1",
    });
    const cipher = AesGcmTokenCipher.fromConfig(config.cTrader);
    let syncCursor: Record<string, unknown> = {};
    let providerHasRowExponent = false;
    type StoredFlow = {
      external_cash_flow_id: string; operation_type: number | null; operation_name: string;
      amount: string | null; balance: string | null; equity: string | null;
      raw_delta: string; raw_balance: string; raw_equity: string | null; currency_code: string;
      money_digits: number | null; money_digits_source: "cash_flow" | "account" | "unavailable";
      balance_version: string | null; occurred_at: Date;
    };
    const flows = new Map<string, StoredFlow>();
    const client = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        if (sql.includes("SELECT connected, mapped_account_id, legacy_mapped_account_id")) {
          return result([{ connected: true, mapped_account_id: null, legacy_mapped_account_id: null }]);
        }
        if (sql.includes("SELECT external_execution_id, external_position_id, executed_at")) return result([]);
        if (sql.includes("UPDATE ctrader_account_cash_flows SET") && sql.includes("money_digits_source='account'")) {
          let changed = 0;
          for (const flow of flows.values()) {
            if (flow.money_digits_source !== "account") continue;
            Object.assign(flow, { amount: null, balance: null, equity: null, money_digits: null, money_digits_source: "unavailable" });
            changed += 1;
          }
          return { ...result([]), rowCount: changed };
        }
        if (sql.includes("SELECT external_cash_flow_id") && sql.includes("ANY($2::text[])")) {
          return result((values[1] as string[]).flatMap(id => flows.get(id) ?? []));
        }
        if (sql.includes("INSERT INTO ctrader_account_cash_flows")) {
          const stored: StoredFlow = {
            external_cash_flow_id: String(values[3]), operation_type: values[4] as number | null,
            operation_name: String(values[5]), amount: values[6] as string | null,
            balance: values[7] as string | null, equity: values[8] as string | null,
            raw_delta: String(values[9]), raw_balance: String(values[10]), raw_equity: values[11] as string | null,
            currency_code: String(values[12]), money_digits: values[13] as number | null,
            money_digits_source: values[14] as StoredFlow["money_digits_source"],
            balance_version: values[15] as string | null, occurred_at: values[16] as Date,
          };
          flows.set(stored.external_cash_flow_id, stored);
          return result([{ id: "00000000-0000-4000-8000-000000000099" }]);
        }
        if (sql.includes("count(*)::text AS total_rows")) {
          const all = [...flows.values()];
          const scaled = all.filter(flow => flow.money_digits_source === "cash_flow" && flow.money_digits !== null).length;
          return result([{ total_rows: String(all.length), scaled_rows: String(scaled), unscaled_rows: String(all.length - scaled) }]);
        }
        if (sql.includes("AND (money_digits_source<>'cash_flow'")) {
          return result([...flows.values()].filter(flow => flow.money_digits_source !== "cash_flow" || flow.money_digits === null));
        }
        if (sql.includes("sync_cursor=$1::jsonb")) {
          syncCursor = JSON.parse(String(values[0]));
          return result([]);
        }
        return result([]);
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const database = {
      query: vi.fn(async (sql: string) => sql.includes("FROM broker_connections") ? result([{
        id: connectionId, user_id: userId, external_account_id: "5032134", provider_environment: "live",
        connected: true, access_token_ciphertext: cipher.encrypt("access", connectionTokenAad(connectionId, "access")),
        refresh_token_ciphertext: cipher.encrypt("refresh", connectionTokenAad(connectionId, "refresh")),
        encryption_key_version: 1, token_expires_at: new Date("2026-09-01T00:00:00.000Z"),
        token_generation: "1", sync_cursor: syncCursor, provider_metadata: {}, mapped_account_id: null,
        legacy_mapped_account_id: null,
      }]) : result([])),
      connect: vi.fn(async () => client), end: vi.fn(async () => undefined),
    } as unknown as Database;
    const listCashFlows = vi.fn(async (from: number, to: number) => {
      if (flowAt < from || flowAt > to) return [];
      return [{
        balanceHistoryId: "88", operationType: 17, operationName: "BALANCE_WITHDRAW_GSL_CHARGE",
        balance: 249_875n, delta: -125n, changeBalanceTimestamp: flowAt, balanceVersion: 9n,
        equity: 249_902n, moneyDigits: providerHasRowExponent ? 2 : null,
      }];
    });
    const gateway = {
      openAccount: vi.fn(async () => ({
        getTraderMetadata: async () => ({ registrationTimestamp: registration, depositAssetId: "1", moneyDigits: 4, balance: 2_489_291n, balanceVersion: 77n, raw: {} }),
        listAssets: async () => [{ assetId: "1", name: "USD", displayName: null, digits: 2, raw: {} }],
        listAssetClasses: async () => [], listSymbolCategories: async () => [], listSymbols: async () => [],
        getSymbolDetails: async () => [], listDeals: async () => ({ deals: [], hasMore: false }),
        listCashFlows, close: vi.fn(async () => undefined),
      })),
    } as unknown as CTraderGateway;
    const engine = new CTraderSyncEngine(
      database, config, {} as CTraderOAuthClient, gateway, cipher,
      { publish: vi.fn(async () => ({ id: 1 })) } as unknown as EventBus,
    );

    const initial = await engine.syncConnection(connectionId);
    expect(flows.get("88")).toMatchObject({ amount: null, money_digits: null, money_digits_source: "unavailable" });
    expect(initial.cursorAfter.cashFlowMoneyRetries).toEqual([expect.objectContaining({ balanceHistoryId: "88" })]);
    expect(initial.counters).toMatchObject({ unscaledAccountCashFlows: 1, pendingCashFlowMoneyRetries: 1 });

    providerHasRowExponent = true;
    vi.setSystemTime(new Date(firstNow.getTime() + 5 * 60 * 1_000));
    const upgraded = await engine.syncConnection(connectionId);
    expect(listCashFlows.mock.calls).toContainEqual([flowAt, flowAt]);
    expect(flows.get("88")).toMatchObject({ amount: "-1.25", money_digits: 2, money_digits_source: "cash_flow" });
    expect(upgraded.cursorAfter.cashFlowMoneyRetries).toEqual([]);
    expect(upgraded.counters).toMatchObject({
      attemptedCashFlowMoneyRetries: 1, completedCashFlowMoneyRetries: 1,
      pendingCashFlowMoneyRetries: 0, scaledAccountCashFlows: 1, unscaledAccountCashFlows: 0,
    });
  });

  it("durably retries an old incomplete close outside overlap, backs off empty results, and upgrades exact net", async () => {
    const firstNow = new Date("2026-08-13T12:00:00.000Z");
    const registration = new Date("2026-08-01T00:00:00.000Z").getTime();
    const openAt = new Date("2026-08-10T09:00:00.000Z").getTime();
    const closeAt = new Date("2026-08-10T10:00:00.000Z").getTime();
    vi.setSystemTime(firstNow);
    const openRaw = {
      dealId: "2001", orderId: "601", positionId: "9901",
      volume: "1000000", filledVolume: "1000000", symbolId: "41",
      createTimestamp: String(openAt), executionTimestamp: String(openAt),
      executionPrice: 2000, tradeSide: "BUY", dealStatus: "FILLED", moneyDigits: 2,
    };
    const weakCloseDetail = {
      entryPrice: 2000, grossProfit: "1000", swap: "0", commission: "-100",
      balance: "2489291", closedVolume: "1000000", pnlConversionFee: "0",
    };
    const weakCloseRaw = {
      dealId: "2002", orderId: "602", positionId: "9901",
      volume: "1000000", filledVolume: "1000000", symbolId: "41",
      createTimestamp: String(closeAt), executionTimestamp: String(closeAt),
      executionPrice: 2010, tradeSide: "SELL", dealStatus: "FILLED", moneyDigits: 2,
      closePositionDetail: weakCloseDetail,
    };
    const exactCloseDetail = {
      ...weakCloseDetail, moneyDigits: 2,
    };
    const exactCloseRaw = { ...weakCloseRaw, closePositionDetail: exactCloseDetail };
    const deal = (raw: typeof openRaw | typeof weakCloseRaw | typeof exactCloseRaw): CTraderDeal => ({
      dealId: raw.dealId,
      orderId: raw.orderId,
      positionId: raw.positionId,
      volumeCents: 1_000_000n,
      filledVolumeCents: 1_000_000n,
      symbolId: raw.symbolId,
      createTimestamp: Number(raw.createTimestamp),
      executionTimestamp: Number(raw.executionTimestamp),
      providerUpdatedTimestamp: null,
      executionPrice: raw.executionPrice,
      tradeSide: raw.tradeSide as "BUY" | "SELL",
      dealStatus: 2,
      moneyDigits: 2,
      commission: null,
      closePositionDetail: "closePositionDetail" in raw ? {
        entryPrice: 2000,
        grossProfit: 1_000n,
        swap: 0n,
        commission: -100n,
        balance: 2_489_291n,
        closedVolumeCents: 1_000_000n,
        moneyDigits: "moneyDigits" in raw.closePositionDetail ? raw.closePositionDetail.moneyDigits : null,
        pnlConversionFee: 0n,
        raw: raw.closePositionDetail,
      } : null,
      raw,
    });
    const open = deal(openRaw);
    const weakClose = deal(weakCloseRaw);
    const exactClose = deal(exactCloseRaw);
    const config = loadConfig({
      NODE_ENV: "test",
      PUBLIC_ORIGIN: "http://localhost:3210",
      DATABASE_URL: "postgresql://localhost/unused",
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
      SESSION_PEPPER: "p".repeat(48),
      COOKIE_SECURE: "false",
      UPLOAD_ROOT: path.resolve("test-uploads"),
      CTRADER_CLIENT_ID: "official-client",
      CTRADER_CLIENT_SECRET: "official-secret",
      CTRADER_REDIRECT_URI: "http://localhost:3210/api/auth/ctrader/callback",
      CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 9).toString("base64url") }),
      CTRADER_ACTIVE_KEY_VERSION: "1",
    });
    const cipher = AesGcmTokenCipher.fromConfig(config.cTrader);
    let syncCursor: Record<string, unknown> = {};
    let oldWindowResponse: "weak" | "empty" | "exact" = "weak";
    const executions = new Map<string, { positionId: string; rawPayload: unknown }>();
    let storedTrade: {
      id: string;
      row_version: number;
      deleted_at: null;
      pnl: string | null;
      broker_data: Record<string, unknown>;
      reconciled_manual_trade: false;
    } | null = null;
    const clientQueries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        clientQueries.push({ sql, values });
        if (sql.includes("SELECT connected, mapped_account_id, legacy_mapped_account_id")) {
          return result([{ connected: true, mapped_account_id: null, legacy_mapped_account_id: null }]);
        }
        if (sql.includes("SELECT external_execution_id, raw_payload")) {
          const ids = values[1] as string[];
          return result(ids.flatMap((id) => {
            const execution = executions.get(id);
            return execution ? [{ external_execution_id: id, raw_payload: execution.rawPayload }] : [];
          }));
        }
        if (sql.includes("SELECT external_execution_id, external_position_id, executed_at")) {
          return result([...executions.entries()].flatMap(([executionId, execution]) => {
            const raw = execution.rawPayload as { executionTimestamp?: string; closePositionDetail?: { moneyDigits?: number } };
            return raw.closePositionDetail && raw.closePositionDetail.moneyDigits === undefined
              ? [{
                  external_execution_id: executionId,
                  external_position_id: execution.positionId,
                  executed_at: new Date(Number(raw.executionTimestamp)),
                }]
              : [];
          }));
        }
        if (sql.includes("INSERT INTO trade_executions")) {
          executions.set(String(values[3]), {
            positionId: String(values[4]),
            rawPayload: JSON.parse(String(values[15])),
          });
          return result([]);
        }
        if (sql.includes("SELECT external_cash_flow_id")) return result([]);
        if (sql.includes("UPDATE ctrader_account_cash_flows SET")) return result([]);
        if (sql.includes("SELECT external_position_id, raw_payload")) {
          const positions = new Set(values[1] as string[]);
          return result([...executions.entries()].flatMap(([executionId, execution]) =>
            positions.has(execution.positionId)
              ? [{ external_execution_id: executionId, external_position_id: execution.positionId, raw_payload: execution.rawPayload }]
              : []));
        }
        if (sql.includes("ctrader_trade_tombstones") && sql.includes("SELECT EXISTS")) {
          return result([{ exists: false }]);
        }
        if (sql.includes("SELECT status FROM ctrader_live_reconciliation_candidates")) return result([]);
        if (sql.includes("SELECT id, row_version, deleted_at FROM trades")) {
          return storedTrade === null ? result([]) : result([storedTrade]);
        }
        if (sql.includes("FROM trades manual") && sql.includes("manual.trade_date BETWEEN")) return result([]);
        if (sql.includes("trade.pnl::text") && sql.includes("reconciled_manual_trade")) {
          return storedTrade === null ? result([]) : result([storedTrade]);
        }
        if (/INSERT INTO trades\s*\(/.test(sql)) {
          storedTrade = {
            id: "00000000-0000-4000-8000-000000000401",
            row_version: (storedTrade?.row_version ?? 0) + 1,
            deleted_at: null,
            pnl: values[13] === null ? null : String(values[13]),
            broker_data: JSON.parse(String(values[20])),
            reconciled_manual_trade: false,
          };
          return result([{ id: storedTrade.id }]);
        }
        if (sql.includes("sync_cursor=$1::jsonb")) {
          syncCursor = JSON.parse(String(values[0]));
          return result([]);
        }
        return result([]);
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const database = {
      query: vi.fn(async (sql: string) => sql.includes("FROM broker_connections") ? result([{
        id: connectionId,
        user_id: userId,
        external_account_id: "5032134",
        provider_environment: "live",
        connected: true,
        access_token_ciphertext: cipher.encrypt("access", connectionTokenAad(connectionId, "access")),
        refresh_token_ciphertext: cipher.encrypt("refresh", connectionTokenAad(connectionId, "refresh")),
        encryption_key_version: 1,
        token_expires_at: new Date("2026-09-01T00:00:00.000Z"),
        token_generation: "1",
        sync_cursor: syncCursor,
        provider_metadata: {},
        mapped_account_id: null,
        legacy_mapped_account_id: null,
      }]) : result([])),
      connect: vi.fn(async () => client),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const listDeals = vi.fn(async (from: number, to: number) => {
      const observations = oldWindowResponse === "weak"
        ? [open, weakClose]
        : oldWindowResponse === "exact" ? [exactClose] : [];
      return {
        deals: observations.filter(observation => observation.executionTimestamp >= from && observation.executionTimestamp <= to),
        hasMore: false,
      };
    });
    const close = vi.fn(async () => undefined);
    const gateway = {
      openAccount: vi.fn(async () => ({
        getTraderMetadata: async () => ({
          registrationTimestamp: registration,
          depositAssetId: "1",
          moneyDigits: 2,
          balance: 2_489_291n,
          balanceVersion: 77n,
          raw: {},
        }),
        listAssets: async () => [{ assetId: "1", name: "USD", displayName: null, digits: 2, raw: {} }],
        listAssetClasses: async () => [],
        listSymbolCategories: async () => [],
        listSymbols: async () => [{
          symbolId: "41", symbolName: "XAUUSD", baseAssetId: null, quoteAssetId: null,
          symbolCategoryId: null, raw: {},
        }],
        getSymbolDetails: async (ids: string[]) => ids.map(() => ({
          symbolId: "41", symbolName: "XAUUSD", lotSizeCents: 10_000_000n,
          digits: 2, pipPosition: 1, raw: {},
        })),
        listDeals,
        listCashFlows: async () => [],
        close,
      })),
    } as unknown as CTraderGateway;
    const engine = new CTraderSyncEngine(
      database,
      config,
      {} as CTraderOAuthClient,
      gateway,
      cipher,
      { publish: vi.fn(async () => ({ id: 1 })) } as unknown as EventBus,
    );

    const initial = await engine.syncConnection(connectionId);
    expect(initial.cursorAfter.syncedThroughTimestamp).toBe(firstNow.getTime());
    expect(initial.counters).toMatchObject({
      attemptedExactMoneyRetries: 0,
      completedExactMoneyRetries: 0,
      pendingExactMoneyRetries: 1,
    });
    expect(initial.cursorAfter.exactMoneyRetries).toEqual([expect.objectContaining({
      executionId: "2002",
      positionId: "9901",
      executionTimestamp: closeAt,
      attemptCount: 0,
      nextAttemptAt: firstNow.getTime() + 5 * 60 * 1_000,
    })]);
    expect(storedTrade?.pnl).toBeNull();
    const runtimeTradeRepair = clientQueries.find(query => query.sql.includes("UPDATE trades SET")
      && query.sql.includes("partial_provider_close_detail_unavailable"));
    expect(runtimeTradeRepair?.sql).toContain("external_trade_key='position:'");
    expect(runtimeTradeRepair?.sql).toContain("preserved_reconciled_manual");
    const runtimeCandidateRepair = clientQueries.find(query => query.sql.includes("UPDATE ctrader_live_reconciliation_candidates AS candidate"));
    expect(runtimeCandidateRepair?.values).toEqual([userId, connectionId]);
    expect(runtimeCandidateRepair?.sql).toContain("exactMoneyRepairPending");
    expect(runtimeCandidateRepair?.sql).not.toMatch(/LIMIT|ANY\s*\(/i);

    oldWindowResponse = "empty";
    const emptyRetryAt = new Date(firstNow.getTime() + 5 * 60 * 1_000);
    vi.setSystemTime(emptyRetryAt);
    const callsBeforeEmpty = listDeals.mock.calls.length;
    const emptyRetry = await engine.syncConnection(connectionId);
    const emptyCalls = listDeals.mock.calls.slice(callsBeforeEmpty);
    expect(emptyCalls).toContainEqual([closeAt - 60_000, closeAt + 60_000, config.cTrader.maxDealsPerRequest]);
    expect(emptyRetry.counters).toMatchObject({
      attemptedExactMoneyRetries: 1,
      completedExactMoneyRetries: 0,
      pendingExactMoneyRetries: 1,
    });
    expect(emptyRetry.cursorAfter.exactMoneyRetries).toEqual([expect.objectContaining({
      executionId: "2002",
      attemptCount: 1,
      lastAttemptAt: emptyRetryAt.getTime(),
      nextAttemptAt: emptyRetryAt.getTime() + 5 * 60 * 1_000,
    })]);

    oldWindowResponse = "exact";
    vi.setSystemTime(new Date(emptyRetryAt.getTime() + 4 * 60 * 1_000));
    const callsBeforeBackoff = listDeals.mock.calls.length;
    const backoff = await engine.syncConnection(connectionId);
    expect(backoff.counters.attemptedExactMoneyRetries).toBe(0);
    expect(listDeals.mock.calls.slice(callsBeforeBackoff).some(([from, to]) => from <= closeAt && to >= closeAt)).toBe(false);

    const exactRetryAt = new Date(emptyRetryAt.getTime() + 5 * 60 * 1_000);
    vi.setSystemTime(exactRetryAt);
    const callsBeforeExact = listDeals.mock.calls.length;
    const upgraded = await engine.syncConnection(connectionId);
    const exactCalls = listDeals.mock.calls.slice(callsBeforeExact);
    expect(exactCalls).toContainEqual([closeAt - 60_000, closeAt + 60_000, config.cTrader.maxDealsPerRequest]);
    expect(upgraded.cursorAfter.syncedThroughTimestamp).toBe(exactRetryAt.getTime());
    expect(upgraded.counters).toMatchObject({
      attemptedExactMoneyRetries: 1,
      completedExactMoneyRetries: 1,
      pendingExactMoneyRetries: 0,
    });
    expect(upgraded.cursorAfter.exactMoneyRetries).toEqual([]);
    expect(storedTrade?.pnl).toBe("9");
    expect(storedTrade?.broker_data).toMatchObject({
      pnlAuthority: "provider",
      pnlMethod: "provider_close_detail_money_digits",
      grossProfit: "10",
      commission: "-1",
    });
    expect(executions.get("2002")?.rawPayload).toMatchObject({ closePositionDetail: exactCloseDetail });

    syncCursor = {
      ...upgraded.cursorAfter,
      exactMoneyRetryQueueVersion: 1,
      exactMoneyRetries: [{ executionId: "2002", positionId: "9901", untrustedWindowStart: 0 }],
    };
    const callsBeforeMalformed = listDeals.mock.calls.length;
    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_EXACT_MONEY_RETRY_CURSOR_INVALID",
      retryable: false,
    });
    expect(listDeals).toHaveBeenCalledTimes(callsBeforeMalformed);
    expect(close).toHaveBeenCalledTimes(5);
    expect(clientQueries.filter(query => query.sql === "ROLLBACK")).toHaveLength(0);
  });
});
