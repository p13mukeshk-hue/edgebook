import path from "node:path";
import type { PoolClient, QueryResult } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AesGcmTokenCipher, connectionTokenAad } from "../src/ctrader/crypto.js";
import {
  CTraderMcpSyncEngine,
  type CTraderMcpReadClientLike,
} from "../src/ctrader/mcp-sync.js";
import { CTraderSyncError, type CTraderSyncResult } from "../src/ctrader/sync.js";
import { CTraderWorker } from "../src/ctrader/worker.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";

const userId = "00000000-0000-4000-8000-000000000002";
const connectionId = "00000000-0000-4000-8000-000000000090";
const otherConnectionId = "00000000-0000-4000-8000-000000000091";
const importId = "00000000-0000-4000-8000-000000000092";
const mappedAccountId = "00000000-0000-4000-8000-000000000093";
const boundary = new Date("2026-08-11T00:00:00.000Z");
const through = new Date("2026-08-12T12:00:00.000Z");
const now = new Date("2026-08-12T12:01:00.000Z");

function result(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult;
}

function config() {
  return loadConfig({
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "http://localhost:3210",
    DATABASE_URL: "postgresql://localhost/unused",
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    SESSION_PEPPER: "p".repeat(48),
    COOKIE_SECURE: "false",
    UPLOAD_ROOT: path.resolve("test-uploads"),
    CTRADER_MCP_ENABLED: "true",
    CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 17).toString("base64url") }),
    CTRADER_ACTIVE_KEY_VERSION: "1",
    CTRADER_TRADING_TIME_ZONE: "UTC",
  });
}

function deal(overrides: Record<string, unknown> = {}) {
  return {
    dealId: "1001",
    positionId: "9001",
    orderId: "8001",
    tradeSide: "BUY",
    dealType: "ENTRY",
    symbolId: "41",
    symbolName: "XAU/USD",
    accountId: "5050060",
    filledVolume: "1000",
    executionPrice: 2_000,
    executionTimestamp: new Date("2026-08-11T10:00:00.000Z").getTime(),
    dealStatus: 2,
    ...overrides,
  };
}

function accountlessHistoryAttestation(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    purpose: "accountless_remote_mcp_history_attribution",
    source: "operator_verified_per_account_remote_mcp_token",
    userId,
    connectionId,
    externalAccountId: "5050060",
    environment: "live",
    tokenGeneration: "1",
    acknowledgedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

function verifiedSymbolOverrides(overrides: Record<string, unknown> = {}) {
  return {
    "41": {
      version: 1,
      purpose: "operator_verified_ctrader_symbol_specification",
      source: "verified_account_symbol_override",
      userId,
      connectionId,
      externalAccountId: "5050060",
      environment: "live",
      tokenGeneration: "1",
      symbolId: "41",
      symbolName: "XAU/USD",
      baseUnitsPerLot: 100,
      measurementUnit: "Oz",
      verifiedAt: "2026-08-12T12:00:00.000Z",
      ...overrides,
    },
  };
}

function closedPosition(withPnl = true): unknown[] {
  return [
    deal(),
    deal({
      dealId: "1002",
      orderId: "8002",
      tradeSide: "SELL",
      dealType: "EXIT",
      executionPrice: 2_010,
      executionTimestamp: new Date("2026-08-11T11:00:00.000Z").getTime(),
      ...(withPnl ? { netPnlCents: 2_500 } : {}),
    }),
  ];
}

type ManualRow = {
  id: string;
  row_version: number;
  deleted_at: Date | string | null;
  symbol: string;
  direction: "Long" | "Short";
  entry_price: string;
  exit_price: string | null;
  quantity: string;
  pnl: string | null;
  trade_date: string;
  entry_at: string | null;
  exit_at: string | null;
};

function manual(id: string, overrides: Partial<ManualRow> = {}): ManualRow {
  return {
    id,
    row_version: 3,
    deleted_at: null,
    symbol: "XAU/USD",
    direction: "Long",
    entry_price: "2000",
    exit_price: "2010",
    quantity: "0.1",
    pnl: "25",
    trade_date: "2026-08-11",
    entry_at: null,
    exit_at: null,
    ...overrides,
  };
}

function harness(options: {
  deals?: unknown[];
  symbols?: unknown[];
  manualRows?: ManualRow[];
  importStatus?: "queued" | "running" | "review" | "completed";
  existingExecutionIds?: string[];
  existingExecutionPayloads?: Record<string, unknown>;
  identityConflict?: Record<string, unknown>;
  floorKind?: string;
  advanceClockOnConnect?: boolean;
  balanceResponse?: unknown;
  assetsResponse?: unknown;
  accountInfoResponse?: unknown;
  operatorAccountAttestation?: Record<string, unknown>;
  verifiedSymbolOverrides?: Record<string, unknown>;
  providerMetadataOverrides?: Record<string, unknown>;
  lockedProviderMetadata?: Record<string, unknown>;
  positionDetailsResponse?: unknown;
  mappedAccountCurrency?: string;
} = {}) {
  const appConfig = config();
  const cipher = AesGcmTokenCipher.fromConfig(appConfig.cTrader);
  const providerMetadata = {
    historyFloorTimestamp: through.getTime(),
    historyFloorKind: options.floorKind ?? "connection_time_empty_attested",
    historyReadValidated: true,
    noOpenPositionsAttestation: {
      version: 1,
      userId,
      connectionId,
      accountId: "5050060",
      environment: "live",
      boundaryTimestamp: through.getTime(),
    },
    ...(options.operatorAccountAttestation === undefined
      ? {}
      : { accountlessHistoryAttributionAttestation: options.operatorAccountAttestation }),
    ...(options.verifiedSymbolOverrides === undefined
      ? {}
      : { verifiedAccountSymbolOverrides: options.verifiedSymbolOverrides }),
    ...(options.providerMetadataOverrides ?? {}),
  };
  let status = options.importStatus ?? "running";
  let counters: Record<string, unknown> = {};
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const executionIds = new Map<string, string>();
  for (const [index, id] of (options.existingExecutionIds ?? []).entries()) {
    executionIds.set(id, `00000000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`);
  }
  const candidateRows: Array<{ sql: string; values: readonly unknown[] }> = [];
  let importedStatus: string | null = null;
  const transactionClient = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("FROM accounts") && sql.includes("FOR SHARE")) {
        return result([{
          id: mappedAccountId,
          legacy_account_id: "legacy-collision",
          currency_code: options.mappedAccountCurrency ?? "USD",
        }]);
      }
      if (sql.includes("SELECT import.status, import.counters")) {
        return result([{
          status,
          counters,
          token_generation: "1",
          connected: true,
          sync_cursor: { version: 1, syncedThroughTimestamp: 1234 },
          connection_id: connectionId,
          connection_user_id: userId,
          external_account_id: "5050060",
          provider_environment: "live",
          provider_metadata: options.lockedProviderMetadata ?? providerMetadata,
          mapped_account_id: mappedAccountId,
          legacy_mapped_account_id: "legacy-collision",
        }]);
      }
      if (sql.includes("SELECT external_execution_id") && sql.includes("FROM trade_executions")) {
        return result([...executionIds.keys()].map((external_execution_id) => ({
          external_execution_id,
          raw_payload: options.existingExecutionPayloads?.[external_execution_id],
        })));
      }
      if (sql.includes("INSERT INTO trade_executions")) {
        const externalId = String(values[3]);
        let id = executionIds.get(externalId);
        if (!id) {
          id = `00000000-0000-4000-8000-${String(200 + executionIds.size).padStart(12, "0")}`;
          executionIds.set(externalId, id);
        }
        return result([{ id }]);
      }
      if (sql.includes("SELECT id FROM trade_executions")) {
        const id = executionIds.get(String(values[2]));
        return result(id ? [{ id }] : []);
      }
      if (sql.includes("FROM trades") && sql.includes("broker_connection_id IS NULL")) {
        return result(options.manualRows ?? []);
      }
      if (sql.includes("AS existing_trade_id")) {
        return result([{
          existing_trade_id: null,
          existing_trade_deleted_at: null,
          existing_link_trade_id: null,
          tombstoned: false,
          ...options.identityConflict,
        }]);
      }
      if (sql.includes("INSERT INTO ctrader_reconciliation_candidates")) {
        candidateRows.push({ sql, values });
        return result([]);
      }
      if (sql.includes("UPDATE ctrader_historical_imports SET") && sql.includes("counters=")) {
        importedStatus = String(values[0]);
        counters = JSON.parse(String(values[1])) as Record<string, unknown>;
        status = importedStatus as typeof status;
        return result([{ id: importId }]);
      }
      return result([]);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  const database = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("FROM ctrader_historical_imports import")) {
        if (values[0] !== importId || values[1] !== connectionId) return result([]);
        return result([{
          id: importId,
          user_id: userId,
          broker_connection_id: connectionId,
          external_account_id: "5050060",
          provider_environment: "live",
          boundary_at: boundary,
          through_at: through,
          normal_history_floor_at_request: through,
          normal_history_floor_kind_at_request: options.floorKind ?? "connection_time_empty_attested",
          boundary_local: "2026-08-11T00:00",
          time_zone: "UTC",
          no_open_positions_attested: true,
          attestation_version: 1,
          attestation_purpose: "historical_preview_reconciliation",
          status,
          counters,
          connected: true,
          access_token_ciphertext: cipher.encrypt("secret", connectionTokenAad(connectionId, "access")),
          encryption_key_version: 1,
          token_generation: "1",
          sync_cursor: { version: 1, syncedThroughTimestamp: 1234 },
          provider_metadata: providerMetadata,
          mapped_account_id: mappedAccountId,
          legacy_mapped_account_id: "legacy-collision",
        }]);
      }
      return result([]);
    }),
    connect: vi.fn(async () => {
      if (options.advanceClockOnConnect) {
        vi.setSystemTime(new Date(now.getTime() + 10 * 60 * 1_000 + 1));
      }
      return transactionClient;
    }),
    end: vi.fn(async () => undefined),
  } as unknown as Database;
  const readClient = {
    getBalance: vi.fn(async () => options.balanceResponse
      ?? { accountId: "5050060", currency: "USD" }),
    getAssets: vi.fn(async () => options.assetsResponse ?? [{ assetId: "15", name: "USD" }]),
    getSymbols: vi.fn(async () => options.symbols ?? [
      {
        id: "41", name: "XAU/USD", lotSize: 100,
        lotSizeScale: "base_units_per_lot_v1", symbolCategory: "Metals",
      },
    ]),
    getAccountInfo: vi.fn(async () => options.accountInfoResponse ?? {}),
    getDeals: vi.fn(async (request: { fromTimestamp: string; toTimestamp: string }) => {
      const from = Date.parse(request.fromTimestamp);
      const to = Date.parse(request.toTimestamp);
      return (options.deals ?? closedPosition()).filter((row) => {
        const value = row as Record<string, unknown>;
        const rawTimestamp = value.executionTimestamp;
        const executedAt = typeof rawTimestamp === "number" ? rawTimestamp : Number(rawTimestamp);
        return Number.isFinite(executedAt) && executedAt >= from && executedAt <= to;
      });
    }),
    getPositionDetails: vi.fn(async () => options.positionDetailsResponse ?? { deals: [] }),
    close: vi.fn(async () => undefined),
  } satisfies CTraderMcpReadClientLike;
  const events = { publish: vi.fn(async () => ({ id: 1 })) } as unknown as EventBus;
  const engine = new CTraderMcpSyncEngine(database, appConfig, cipher, events, () => readClient);
  return { engine, database, readClient, queries, candidateRows, getStatus: () => importedStatus };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CTraderMcpSyncEngine historical preview", () => {
  it("stages a unique manual match without touching the normal cursor or visible trades", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, queries, candidateRows } = harness({
      deals: closedPosition(false),
      manualRows: [manual("00000000-0000-4000-8000-000000000301")],
    });

    const preview = await engine.previewHistoricalImport(importId, connectionId);

    expect(preview.cursorBefore).toEqual({ version: 1, syncedThroughTimestamp: 1234 });
    expect(preview.cursorAfter).toEqual(preview.cursorBefore);
    const executionInsert = queries.find(({ sql }) => sql.includes("INSERT INTO trade_executions"));
    expect(JSON.parse(String(executionInsert?.values[15]))).toMatchObject({
      edgebookMcpDeal: {
        filledVolumeCents: "1000",
        filledVolumeSourceKey: "filledVolume",
        filledVolumeScale: "unit_cents",
      },
    });
    expect(queries.some(({ sql }) => sql.includes("INSERT INTO trades"))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes("UPDATE broker_connections SET"))).toBe(false);
    const values = candidateRows[0]?.values;
    expect(values?.[8]).toBe("high_confidence");
    expect(values?.[6]).toBe("00000000-0000-4000-8000-000000000301");
    const candidateData = JSON.parse(String(values?.[12])) as { allowedActions: string[]; publishBlockedReason: string };
    expect(candidateData.allowedActions).toEqual(["link_manual", "reject"]);
    expect(candidateData.publishBlockedReason).toBe("closed_provider_pnl_unavailable");
    expect(JSON.parse(String(values?.[13]))).toMatchObject({ pnl: null, quantityLots: "0.1" });
  });

  it("stages authoritative historical close money using the nested provider moneyDigits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const baseHistoricalDeals = closedPosition(false);
    const historicalDetails = baseHistoricalDeals.map((row, index) => index === 0 ? row : {
      ...(row as Record<string, unknown>),
      closePositionDetail: {
        grossProfit: 250_000,
        swap: -10_000,
        commission: -5_000,
        pnlConversionFee: 1_000,
        moneyDigits: 4,
      },
    });
    const { engine, queries, candidateRows, readClient } = harness({
      deals: baseHistoricalDeals,
      balanceResponse: { accountId: "5050060", depositAssetId: 15, moneyDigits: 2 },
      assetsResponse: { assets: [{ assetId: 15, name: "USD", displayName: "USD" }] },
      symbols: [{
        id: "41",
        name: "XAU/USD",
        baseAssetId: 17,
        quoteAssetId: 15,
        lotSize: 100,
        symbolCategory: "Metals",
      }],
      positionDetailsResponse: { deals: historicalDetails },
    });

    const preview = await engine.previewHistoricalImport(importId, connectionId);

    expect(preview.counters).toMatchObject({
      positionsStaged: 1,
      executionOnly: 0,
      providerReadTelemetry: {
        version: 1,
        assetsAvailable: true,
        assetCount: 1,
        currencyResolved: true,
        pnlEnrichment: {
          requestedPositions: 1,
          attemptedPositions: 1,
          successfulResponses: 1,
          positionDetailsAvailable: true,
          authoritativePositions: 1,
          unresolvedPositions: 0,
        },
      },
    });
    expect(readClient.getAssets).toHaveBeenCalledOnce();
    expect(readClient.getPositionDetails).toHaveBeenCalledWith("9001");
    const executionInserts = queries.filter(({ sql }) => sql.includes("INSERT INTO trade_executions"));
    expect(executionInserts[1]?.values.slice(10, 13)).toEqual(["23.4", "-0.5", "-1"]);
    expect(executionInserts.every(({ values }) => values[13] === "USD")).toBe(true);
    expect(executionInserts[1]?.values[18]).toBe(4);
    expect(JSON.parse(String(executionInserts[1]?.values[19]))).toMatchObject({
      grossProfit: "250000",
      moneyDigits: 4,
    });
    const projected = JSON.parse(String(candidateRows[0]?.values[13])) as Record<string, unknown>;
    expect(projected).toMatchObject({ pnl: "23.4" });
    expect(candidateRows[0]?.values[8]).toBe("unmatched");
    const candidateData = JSON.parse(String(candidateRows[0]?.values[12])) as {
      allowedActions: string[];
      publishBlockedReason: string | null;
    };
    expect(candidateData.allowedActions).toEqual(["publish_separate", "reject"]);
    expect(candidateData.publishBlockedReason).toBeNull();
  });

  it("stages mixed exact-money historical closes without requesting P&L enrichment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, queries, candidateRows, readClient } = harness({
      deals: [
        deal(),
        deal({
          dealId: "1002",
          orderId: "8002",
          tradeSide: "SELL",
          dealType: "EXIT",
          filledVolume: "400",
          executionPrice: 2_005,
          executionTimestamp: new Date("2026-08-11T10:30:00.000Z").getTime(),
          netPnlCents: 500,
          commissionCents: -50,
          swapCents: 0,
        }),
        deal({
          dealId: "1003",
          orderId: "8003",
          tradeSide: "SELL",
          dealType: "EXIT",
          filledVolume: "600",
          executionPrice: 2_010,
          executionTimestamp: new Date("2026-08-11T11:00:00.000Z").getTime(),
          closePositionDetail: {
            grossProfit: 200_000,
            swap: -10_000,
            commission: -5_000,
            pnlConversionFee: 1_000,
            moneyDigits: 4,
          },
        }),
      ],
    });

    const preview = await engine.previewHistoricalImport(importId, connectionId);

    expect(readClient.getPositionDetails).not.toHaveBeenCalled();
    expect(preview.counters).toMatchObject({
      positionsStaged: 1,
      executionOnly: 0,
      providerReadTelemetry: {
        pnlEnrichment: {
          requestedPositions: 0,
          attemptedPositions: 0,
          authoritativePositions: 0,
          unresolvedPositions: 0,
        },
      },
    });
    const executionInserts = queries.filter(({ sql }) => sql.includes("INSERT INTO trade_executions"));
    expect(executionInserts.map(({ values }) => values[10])).toEqual([null, "5", "18.4"]);
    expect(executionInserts.map(({ values }) => values[18])).toEqual([null, 2, 4]);
    const projected = JSON.parse(String(candidateRows[0]?.values[13]));
    expect(projected).toMatchObject({
      pnl: "23.4",
      brokerData: {
        pnlMethod: "provider_mixed_exact_money",
        grossProfit: null,
        commission: null,
        swap: null,
        pnlConversionFee: null,
        realizedEvents: [
          { executionId: "1002", pnl: "5" },
          { executionId: "1003", pnl: "18.4" },
        ],
      },
    });
    expect(candidateRows[0]?.values[8]).toBe("unmatched");
  });

  it("retains stored authoritative close money on an incomplete historical replay", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const historicalDeals = closedPosition(false);
    const closing = historicalDeals[1] as Record<string, unknown>;
    const storedClosing = {
      edgebookMcpDeal: {
        version: 1,
        dealId: String(closing.dealId), positionId: "9001", orderId: "8002", symbolId: "41",
        symbolName: "XAU/USD", accountId: "5050060", side: "SELL", role: "CLOSE",
        filledVolumeCents: "1000", filledVolumeSourceKey: "filledVolume",
        filledVolumeScale: "unit_cents", executionPrice: 2_010,
        executionTimestamp: Number(closing.executionTimestamp), dealStatus: 2,
        providerUpdatedTimestamp: null, netPnlCents: null, commissionCents: null, swapCents: null,
        closePositionDetail: {
          grossProfit: "250000", swap: "-10000", commission: "-5000",
          pnlConversionFee: "1000", moneyDigits: 4,
        },
      },
    };
    const { engine, candidateRows, queries } = harness({
      deals: historicalDeals,
      existingExecutionIds: [String(closing.dealId)],
      existingExecutionPayloads: { [String(closing.dealId)]: storedClosing },
    });

    await engine.previewHistoricalImport(importId, connectionId);

    const projected = JSON.parse(String(candidateRows[0]?.values[13]));
    expect(projected).toMatchObject({
      pnl: "23.4",
      brokerData: { pnlMethod: "provider_close_detail_money_digits" },
    });
    const closeUpsert = queries.filter(({ sql }) => sql.includes("INSERT INTO trade_executions"))[1];
    expect(closeUpsert?.values[10]).toBe("23.4");
    expect(closeUpsert?.sql).toContain("trade_executions.raw_payload");
  });

  it.each([
    "accountId", "account_id", "ctidTraderAccountId", "ctidTradingAccountId", "traderAccountId",
  ])("rejects historical position details with mismatched position-wrapper %s", async (accountKey) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const accountlessDeals = closedPosition(false).map((row) => ({
      ...(row as Record<string, unknown>),
      accountId: undefined,
    }));
    const { engine, database } = harness({
      deals: accountlessDeals,
      positionDetailsResponse: {
        position: { positionId: "9001", [accountKey]: "different-account" },
        deals: accountlessDeals,
      },
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_HISTORY_MISMATCH",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rejects historical position details with a mismatched account in the orders wrapper", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const accountlessDeals = closedPosition(false).map((row) => ({
      ...(row as Record<string, unknown>),
      accountId: undefined,
    }));
    const { engine, database } = harness({
      deals: accountlessDeals,
      positionDetailsResponse: {
        orders: [{ orderId: "7001", ctidTraderAccountId: "different-account" }],
        deals: accountlessDeals,
      },
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_HISTORY_MISMATCH",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("stages generic quantity as execution-only with its unknown volume scale preserved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, queries, candidateRows } = harness({
      deals: closedPosition().map((row) => ({
        ...(row as Record<string, unknown>),
        filledVolume: undefined,
        quantity: "1000",
      })),
    });

    const preview = await engine.previewHistoricalImport(importId, connectionId);

    expect(preview.counters).toMatchObject({ positionsStaged: 1, executionOnly: 1, positionsAwaitingReview: 1 });
    const executionInsert = queries.find(({ sql }) => sql.includes("INSERT INTO trade_executions"));
    expect(JSON.parse(String(executionInsert?.values[15]))).toMatchObject({
      edgebookMcpDeal: {
        filledVolumeCents: "1000",
        filledVolumeSourceKey: "quantity",
        filledVolumeScale: "unknown",
      },
    });
    expect(candidateRows[0]?.values[8]).toBe("execution_only");
    expect(JSON.parse(String(candidateRows[0]?.values[10]))).toEqual([
      "CTRADER_MCP_VOLUME_SCALE_UNAVAILABLE",
      "financial_values_not_guessed",
    ]);
  });

  it("fails the historical preview before persistence when volume aliases conflict", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness({
      deals: closedPosition().map((row, index) => index === 0
        ? { ...(row as Record<string, unknown>), volume: "999" }
        : row),
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_DEAL_INVALID",
      message: "cTrader returned conflicting filledVolume aliases",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rejects stored-provenance envelope spoofing in historical provider rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness({
      deals: closedPosition().map((row, index) => {
        if (index !== 0) return row;
        const providerDeal = {
          ...(row as Record<string, unknown>),
          filledVolume: undefined,
          volume: "1000",
        };
        return {
          ...providerDeal,
          edgebookMcpDeal: {
            ...providerDeal,
            volume: undefined,
            filledVolumeCents: "1000",
            filledVolumeSourceKey: "filledVolumeCents",
            filledVolumeScale: "unit_cents",
          },
        };
      }),
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_DEAL_INVALID",
      message: "cTrader returned reserved internal deal provenance",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("accepts accountless rows under the exact historical account session in both validation plans", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient, candidateRows } = harness({
      deals: closedPosition().map((row) => ({
        ...(row as Record<string, unknown>),
        accountId: undefined,
      })),
    });

    const preview = await engine.previewHistoricalImport(importId, connectionId);

    expect(readClient.getDeals.mock.calls.length).toBeGreaterThan(1);
    expect(preview.counters).toMatchObject({ fetchedDeals: 2, positionsStaged: 1 });
    expect(candidateRows).toHaveLength(1);
    const candidateData = JSON.parse(String(candidateRows[0]?.values[12])) as Record<string, unknown>;
    expect(candidateData).toMatchObject({ accountId: "5050060" });
  });

  it("fails the historical dual-plan preview on an explicit row account mismatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness({
      deals: closedPosition().map((row, index) => index === 0
        ? { ...(row as Record<string, unknown>), accountId: "999999" }
        : row),
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_HISTORY_MISMATCH",
      requiresReauth: true,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("fails the historical dual-plan preview when accountless rows have no positive account proof", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness({
      deals: closedPosition().map((row) => ({
        ...(row as Record<string, unknown>),
        accountId: undefined,
      })),
      balanceResponse: { currency: "USD" },
      accountInfoResponse: {},
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_ATTRIBUTION_MISSING",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("stages accountless historical rows under the exact operator-verified per-account token attestation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, candidateRows } = harness({
      deals: closedPosition().map((row) => ({
        ...(row as Record<string, unknown>),
        accountId: undefined,
      })),
      balanceResponse: { currency: "USD" },
      accountInfoResponse: {},
      operatorAccountAttestation: accountlessHistoryAttestation(),
    });

    const preview = await engine.previewHistoricalImport(importId, connectionId);

    expect(preview.counters).toMatchObject({ fetchedDeals: 2, positionsStaged: 1 });
    const candidateData = JSON.parse(String(candidateRows[0]?.values[12])) as Record<string, unknown>;
    expect(candidateData).toMatchObject({ accountId: "5050060" });
  });

  it("rejects historical use of an operator attestation bound to another environment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database, readClient } = harness({
      deals: closedPosition().map((row) => ({
        ...(row as Record<string, unknown>),
        accountId: undefined,
      })),
      operatorAccountAttestation: accountlessHistoryAttestation({ environment: "demo" }),
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNTLESS_ATTESTATION_INVALID",
    });
    expect(readClient.getBalance).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rolls back historical staging when the operator attestation is revoked after fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const lockedProviderMetadata = {
      historyFloorTimestamp: through.getTime(),
      historyFloorKind: "connection_time_empty_attested",
      historyReadValidated: true,
      noOpenPositionsAttestation: {
        version: 1,
        userId,
        connectionId,
        accountId: "5050060",
        environment: "live",
        boundaryTimestamp: through.getTime(),
      },
    };
    const { engine, queries, candidateRows, getStatus } = harness({
      deals: closedPosition().map((row) => ({
        ...(row as Record<string, unknown>),
        accountId: undefined,
      })),
      balanceResponse: { currency: "USD" },
      accountInfoResponse: {},
      operatorAccountAttestation: accountlessHistoryAttestation(),
      lockedProviderMetadata,
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNTLESS_ATTESTATION_CHANGED",
    });
    expect(queries.some(({ sql }) => sql.includes("INSERT INTO trade_executions"))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes("UPDATE ctrader_historical_imports SET"))).toBe(false);
    expect(candidateRows).toHaveLength(0);
    expect(getStatus()).toBeNull();
  });

  it.each([
    {
      balanceResponse: { accountId: "5050060", currency: "USD" },
      accountInfoResponse: { ctidTraderAccountId: "999999" },
    },
    {
      balanceResponse: { accountId: "5050060", ctidTraderAccountId: "999999", currency: "USD" },
      accountInfoResponse: {},
    },
  ])("fails the historical preview on conflicting session account aliases", async (identity) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness(identity);

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_MISMATCH",
      requiresReauth: true,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each([
    [
      { accountId: "5050060", currency: "USD" },
      { accountId: "999999", currency: "USD" },
    ],
    {
      account: { accountId: "5050060", currency: "USD" },
      result: { accountId: "999999", currency: "USD" },
    },
  ])("fails the historical preview when a later account metadata entry conflicts", async (balanceResponse) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness({
      balanceResponse,
      accountInfoResponse: {},
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_MISMATCH",
      requiresReauth: true,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "currency across provider metadata wrappers",
      balanceResponse: { accountId: "5050060", currency: "USD", depositAssetId: 15, moneyDigits: 2 },
      accountInfoResponse: {},
      providerMetadataOverrides: { result: { accountCurrency: "EUR" } },
      expectedCode: "CTRADER_MCP_CURRENCY_INVALID",
    },
    {
      label: "deposit asset across balance/account-info aliases",
      balanceResponse: { accountId: "5050060", deposit_asset_id: 15, moneyDigits: 2 },
      accountInfoResponse: { data: { accountId: "5050060", accountDepositAssetId: 16 } },
      providerMetadataOverrides: {},
      expectedCode: "CTRADER_MCP_METADATA_INVALID",
    },
    {
      label: "money digits across nested wrappers",
      balanceResponse: { accountId: "5050060", depositAssetId: 15, accountMoneyDigits: 2 },
      accountInfoResponse: { result: { accountId: "5050060", money_digits: 3 } },
      providerMetadataOverrides: {},
      expectedCode: "CTRADER_MCP_METADATA_INVALID",
    },
  ])("fails the historical preview on conflicting $label", async ({
    balanceResponse, accountInfoResponse, providerMetadataOverrides, expectedCode,
  }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness({
      balanceResponse,
      accountInfoResponse,
      providerMetadataOverrides,
      assetsResponse: [{ assetId: 15, name: "USD" }, { assetId: 16, name: "EUR" }],
      deals: [],
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({ code: expectedCode });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("fails the historical preview when a session root conflicts with selected nested account metadata", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness({
      balanceResponse: {
        ctidTraderAccountId: "999999",
        data: { accountId: "5050060", currency: "USD" },
      },
      accountInfoResponse: {},
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_MISMATCH",
      requiresReauth: true,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("fails the historical preview on conflicting aliases within a deal row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness({
      deals: closedPosition().map((row, index) => index === 0
        ? {
            ...(row as Record<string, unknown>),
            accountId: "5050060",
            ctidTraderAccountId: "999999",
          }
        : row),
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_HISTORY_MISMATCH",
      requiresReauth: true,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("stages an unknown-contract trade with exact base-unit quantity and no false manual match", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, candidateRows } = harness({
      symbols: [{ id: "41", name: "XAU/USD", symbolCategory: "Metals" }],
      manualRows: [manual("00000000-0000-4000-8000-000000000302")],
    });

    await engine.previewHistoricalImport(importId, connectionId);

    const values = candidateRows[0]?.values;
    expect(values?.[8]).toBe("unmatched");
    expect(values?.[6]).toBeNull();
    expect(values?.[7]).toBeNull();
    const projected = JSON.parse(String(values?.[13])) as Record<string, unknown>;
    expect(projected).toMatchObject({
      quantity: "10",
      quantityUnit: "base_units",
      quantityLots: null,
      quantityBaseUnits: "10",
      brokerData: {
        quantityProjection: {
          value: "10", unit: "base_units", lots: null, baseUnits: "10",
          volumeScale: "unit_cents", source: "provider_filled_volume",
        },
      },
    });
  });

  it("uses an exact account-bound operator symbol override in historical preview", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, candidateRows, queries } = harness({
      deals: closedPosition(false).map((row) => ({
        ...(row as Record<string, unknown>),
        filledVolume: "200",
      })),
      symbols: [{ id: "41", name: "XAU/USD", symbolCategory: "Metals" }],
      verifiedSymbolOverrides: verifiedSymbolOverrides(),
      manualRows: [],
    });

    const preview = await engine.previewHistoricalImport(importId, connectionId);

    expect(preview.counters).toMatchObject({ positionsProjected: 1, positionsAwaitingReview: 0 });
    const values = candidateRows[0]?.values;
    expect(values?.[8]).toBe("unmatched");
    const projected = JSON.parse(String(values?.[13])) as Record<string, unknown>;
    expect(projected).toMatchObject({
      quantityLots: "0.02",
      pnl: null,
      brokerData: {
        pnlMethod: "unavailable",
        verifiedAccountSymbolOverride: {
          source: "verified_account_symbol_override",
          symbolId: "41",
          baseUnitsPerLot: 100,
        },
      },
    });
    const symbolUpsert = queries.find(({ sql }) => sql.includes("INSERT INTO symbol_specs"));
    expect(JSON.parse(String(symbolUpsert?.values[5]))).toMatchObject({
      lotSize: 100,
      lotSizeSource: "verified_account_symbol_override",
    });
  });

  it("rolls back historical staging when an operator symbol override changes after fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const verified = verifiedSymbolOverrides();
    const { engine, candidateRows, queries } = harness({
      deals: closedPosition(false).map((row) => ({
        ...(row as Record<string, unknown>),
        filledVolume: "200",
      })),
      symbols: [{ id: "41", name: "XAU/USD", symbolCategory: "Metals" }],
      verifiedSymbolOverrides: verified,
      lockedProviderMetadata: {
        historyFloorTimestamp: through.getTime(),
        historyFloorKind: "connection_time_empty_attested",
        historyReadValidated: true,
        noOpenPositionsAttestation: {
          version: 1,
          userId,
          connectionId,
          accountId: "5050060",
          environment: "live",
          boundaryTimestamp: through.getTime(),
        },
      },
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_VERIFIED_SYMBOL_OVERRIDE_CHANGED",
    });
    expect(candidateRows).toHaveLength(0);
    expect(queries.some(({ sql }) => sql.includes("INSERT INTO trade_executions"))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes("UPDATE ctrader_historical_imports SET") && sql.includes("counters="))).toBe(false);
  });

  it("fails historical preview when provider emits an invalid explicit contract size", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness({
      symbols: [{ id: "41", name: "XAU/USD", lotSize: "100.5", symbolCategory: "Metals" }],
      verifiedSymbolOverrides: verifiedSymbolOverrides(),
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_SYMBOL_SPEC_INVALID",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rejects conflicting duplicate provider symbol specifications", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness({
      symbols: [
        { id: "41", name: "XAU/USD", lotSize: 100, symbolCategory: "Metals" },
        { id: "41", name: "BTC/USD", lotSize: 1, symbolCategory: "Crypto" },
      ],
    });
    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_SYMBOL_CONFLICT",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("deduplicates exact canonical duplicate symbol specifications", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const specification = { id: "41", name: "XAU/USD", lotSize: 100, symbolCategory: "Metals" };
    const { engine, candidateRows } = harness({ symbols: [specification, { ...specification }] });
    await engine.previewHistoricalImport(importId, connectionId);
    expect(candidateRows).toHaveLength(1);
  });

  it("rejects mixed symbol identities inside one provider position", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, candidateRows } = harness({
      symbols: [
        { id: "41", name: "XAU/USD", lotSize: 100, symbolCategory: "Metals" },
        { id: "42", name: "BTC/USD", lotSize: 1, symbolCategory: "Crypto" },
      ],
      deals: [
        deal(),
        deal({ dealId: "1002", symbolId: "42", tradeSide: "SELL", dealType: "EXIT" }),
      ],
    });
    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_POSITION_SYMBOL_MISMATCH",
    });
    expect(candidateRows).toHaveLength(0);
  });

  it("rejects unsafe aggregate money rather than overflowing provider P&L", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, candidateRows } = harness({
      deals: [
        deal(),
        deal({
          dealId: "1002",
          tradeSide: "SELL",
          dealType: "EXIT",
          filledVolume: "500",
          netPnlCents: Number.MAX_SAFE_INTEGER,
        }),
        deal({
          dealId: "1003",
          tradeSide: "SELL",
          dealType: "EXIT",
          filledVolume: "500",
          netPnlCents: 1,
        }),
      ],
    });
    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_NUMERIC_OVERFLOW",
    });
    expect(candidateRows).toHaveLength(0);
  });

  it("rejects oversized provider account metadata before persistence amplification", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient, database } = harness();
    readClient.getBalance.mockResolvedValue({ accountId: "5050060", currency: "X".repeat(4 * 1024 * 1024) });
    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_METADATA_INVALID",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("fails closed when cTrader returns a deal outside the exact immutable half-open window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database, readClient } = harness();
    readClient.getDeals.mockResolvedValue([deal({ executionTimestamp: through.getTime() })]);

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_DEAL_OUTSIDE_WINDOW",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("bounds recursive incomplete-page splitting and fails closed on a saturated provider", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient, database } = harness();
    readClient.getDeals.mockResolvedValue({ deals: [], hasMore: true });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_HISTORICAL_IMPORT_BUDGET_EXCEEDED",
    });
    expect(readClient.getDeals.mock.calls.length).toBeLessThanOrEqual(35);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each([
    { label: "full-range plan", omitFromFull: true },
    { label: "partition plan", omitFromFull: false },
  ])("detects a deal missing from the $label", async ({ omitFromFull }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient, database } = harness();
    const rows = closedPosition();
    readClient.getDeals.mockImplementation(async (request) => {
      const from = Date.parse(request.fromTimestamp);
      const to = Date.parse(request.toTimestamp);
      const isFullRange = to - from > 60 * 60 * 1_000;
      const selected = (omitFromFull === isFullRange ? rows.slice(0, 1) : rows).filter((row) => {
        const executedAt = Number((row as Record<string, unknown>).executionTimestamp);
        return executedAt >= from && executedAt <= to;
      });
      return selected;
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_HISTORICAL_IMPORT_INCOMPLETE",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("accepts reordered but canonically identical dual-plan history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient, candidateRows } = harness();
    const rows = closedPosition();
    readClient.getDeals.mockImplementation(async (request) => {
      const from = Date.parse(request.fromTimestamp);
      const to = Date.parse(request.toTimestamp);
      return [...rows].reverse().filter((row) => {
        const executedAt = Number((row as Record<string, unknown>).executionTimestamp);
        return executedAt >= from && executedAt <= to;
      });
    });
    await engine.previewHistoricalImport(importId, connectionId);
    expect(candidateRows).toHaveLength(1);
  });

  it("rejects a canonical payload discrepancy between validation plans", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient, database } = harness();
    const rows = closedPosition();
    readClient.getDeals.mockImplementation(async (request) => {
      const from = Date.parse(request.fromTimestamp);
      const to = Date.parse(request.toTimestamp);
      const isFullRange = to - from > 60 * 60 * 1_000;
      return rows.filter((row) => {
        const executedAt = Number((row as Record<string, unknown>).executionTimestamp);
        return executedAt >= from && executedAt <= to;
      }).map((row) => isFullRange ? row : {
        ...(row as Record<string, unknown>),
        executionPrice: String((row as Record<string, unknown>).dealId) === "1001" ? 2_001 : 2_010,
      });
    });
    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_HISTORICAL_IMPORT_INCOMPLETE",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("shares the 128-request budget across the full and partition validation plans", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient, database } = harness({ deals: [] });
    readClient.getDeals.mockImplementation(async (request) => {
      const duration = Date.parse(request.toTimestamp) - Date.parse(request.fromTimestamp) + 1;
      return duration > 34 * 60 * 1_000 ? { deals: [], hasMore: true } : [];
    });
    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_HISTORICAL_IMPORT_BUDGET_EXCEEDED",
    });
    expect(readClient.getDeals.mock.calls.length).toBeLessThanOrEqual(128);
    expect(readClient.getDeals.mock.calls.length).toBeGreaterThan(100);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("fails an import that exceeds its absolute elapsed deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient, database } = harness({ deals: [] });
    readClient.getDeals.mockImplementation(async () => {
      vi.setSystemTime(new Date(now.getTime() + 10 * 60 * 1_000 + 1));
      return [];
    });

    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_HISTORICAL_IMPORT_BUDGET_EXCEEDED",
      retryable: false,
    });
    expect(readClient.getDeals).toHaveBeenCalledTimes(1);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rolls back when the absolute deadline expires during persistence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, candidateRows } = harness({ advanceClockOnConnect: true });
    // Advancing when the transaction client is checked out leaves fetch valid
    // but makes the first persistence deadline check fail atomically.
    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_HISTORICAL_IMPORT_BUDGET_EXCEEDED",
    });
    expect(candidateRows).toHaveLength(0);
  });

  it("rejects more than 250 staged positions before any candidate is inserted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const deals = Array.from({ length: 251 }, (_, index) => deal({
      dealId: String(10_000 + index),
      positionId: String(20_000 + index),
      executionTimestamp: boundary.getTime() + 1_000 + index,
    }));
    const { engine, candidateRows } = harness({ deals });
    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_HISTORICAL_IMPORT_BUDGET_EXCEEDED",
    });
    expect(candidateRows).toHaveLength(0);
  });

  it("rejects more than 5,000 unique executions before persistence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const deals = Array.from({ length: 5_001 }, (_, index) => deal({
      dealId: String(30_000 + index),
      executionTimestamp: boundary.getTime() + 1_000 + index,
    }));
    const { engine, database } = harness({ deals });
    await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
      code: "CTRADER_HISTORICAL_IMPORT_BUDGET_EXCEEDED",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "deleted",
      rows: [manual("00000000-0000-4000-8000-000000000303", { deleted_at: now })],
      classification: "deleted_manual",
    },
    {
      label: "ambiguous",
      rows: [
        manual("00000000-0000-4000-8000-000000000304"),
        manual("00000000-0000-4000-8000-000000000305"),
      ],
      classification: "ambiguous",
    },
  ])("keeps $label manual matches in explicit review", async ({ rows, classification }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, candidateRows } = harness({ manualRows: rows });
    await engine.previewHistoricalImport(importId, connectionId);
    expect(candidateRows[0]?.values[8]).toBe(classification);
  });

  it("uses a normalized account mapping exclusively and treats the legacy mapping as fallback only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, queries } = harness();
    await engine.previewHistoricalImport(importId, connectionId);
    const manualQuery = queries.find(({ sql }) =>
      sql.includes("FROM trades") && sql.includes("broker_connection_id IS NULL"));
    expect(manualQuery?.sql).toContain("$4::uuid IS NULL AND $5::text IS NOT NULL");
    expect(manualQuery?.values[3]).toBe(mappedAccountId);
    expect(manualQuery?.values[4]).toBe("legacy-collision");
  });

  it("rejects an import requested through a different broker connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness();
    await expect(engine.previewHistoricalImport(importId, otherConnectionId)).rejects.toMatchObject({
      code: "CTRADER_HISTORICAL_IMPORT_NOT_FOUND",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each(["registration", "connection_time"])(
    "rejects %s as an unsafe cross-floor historical stitching proof",
    async (floorKind) => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const { engine, database } = harness({ floorKind });
      await expect(engine.previewHistoricalImport(importId, connectionId)).rejects.toMatchObject({
        code: "CTRADER_HISTORICAL_BOUNDARY_CHANGED",
      });
      expect(database.connect).not.toHaveBeenCalled();
    },
  );

  it("is retry-safe after review commit and does not fetch or persist twice", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient, queries } = harness();
    await engine.previewHistoricalImport(importId, connectionId);
    const firstFetchCount = readClient.getDeals.mock.calls.length;
    await engine.previewHistoricalImport(importId, connectionId);
    expect(firstFetchCount).toBeGreaterThan(1);
    expect(readClient.getDeals).toHaveBeenCalledTimes(firstFetchCount);
    expect(queries.filter(({ sql }) => sql.includes("INSERT INTO trade_executions"))).toHaveLength(2);
  });

  it("completes an empty immutable window instead of leaving an unresolvable active review", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, getStatus } = harness({ deals: [] });
    await engine.previewHistoricalImport(importId, connectionId);
    expect(getStatus()).toBe("completed");
  });

  it.each([
    {
      label: "tombstoned",
      conflict: { tombstoned: true },
      reason: "broker_tombstone_exists",
    },
    {
      label: "already imported",
      conflict: { existing_trade_id: "00000000-0000-4000-8000-000000000399" },
      reason: "already_imported_normal_sync",
    },
  ])("does not resurrect or republish a $label broker identity", async ({ conflict, reason }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, candidateRows, queries } = harness({ identityConflict: conflict });
    await engine.previewHistoricalImport(importId, connectionId);
    const values = candidateRows[0]?.values;
    expect(candidateRows[0]?.sql).toContain("'execution_only'");
    expect(JSON.parse(String(values?.[6]))).toContain(reason);
    expect(candidateRows[0]?.sql).toContain("projected_trade, status");
    expect(candidateRows[0]?.sql).toContain("$8::jsonb,NULL,'pending'");
    expect(queries.some(({ sql }) => sql.includes("INSERT INTO trades"))).toBe(false);
  });
});

describe("CTraderWorker historical preview dispatch", () => {
  function workerResult(): CTraderSyncResult {
    return {
      userId,
      connectionId,
      cursorBefore: { syncedThroughTimestamp: 1234 },
      cursorAfter: { syncedThroughTimestamp: 1234 },
      counters: {
        inserted: 2,
        updated: 0,
        fetchedDeals: 2,
        insertedExecutions: 2,
        updatedExecutions: 0,
        insertedTrades: 0,
        updatedTrades: 0,
        unchangedTrades: 0,
        archivedTradesPreserved: 0,
        tombstonesPreserved: 0,
        positionsProjected: 1,
        positionsAwaitingReview: 0,
      },
    };
  }

  function workerHarness(preview: () => Promise<CTraderSyncResult>) {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const database = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        return result();
      }),
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const official = { syncConnection: vi.fn(async () => workerResult()) };
    const mcp = {
      syncConnection: vi.fn(async () => workerResult()),
      previewHistoricalImport: vi.fn(preview),
    };
    const worker = new CTraderWorker(database, config(), official, mcp, {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    });
    const lockClient = { query: vi.fn(async () => result()), release: vi.fn() } as unknown as PoolClient;
    const run = {
      id: "00000000-0000-4000-8000-000000000094",
      broker_connection_id: connectionId,
      attempt_count: 1,
      connection_mode: "mcp_read" as const,
      sync_type: "historical_preview",
      historical_import_user_id: userId,
      historical_import_id: importId,
    };
    return { worker, lockClient, run, queries, official, mcp };
  }

  it("dispatches historical_preview to the isolated MCP preview method", async () => {
    const { worker, lockClient, run, queries, official, mcp } = workerHarness(async () => workerResult());
    await (worker as unknown as {
      executeRun(run: typeof run, client: PoolClient): Promise<void>;
    }).executeRun(run, lockClient);

    expect(mcp.previewHistoricalImport).toHaveBeenCalledWith(importId, connectionId, expect.any(Function));
    expect(mcp.syncConnection).not.toHaveBeenCalled();
    expect(official.syncConnection).not.toHaveBeenCalled();
    const succeeded = queries.find(({ sql }) => sql.includes("status='succeeded'"));
    expect(succeeded?.values[0]).toBe(JSON.stringify({ syncedThroughTimestamp: 1234 }));
    expect(succeeded?.values[1]).toBe(JSON.stringify({ syncedThroughTimestamp: 1234 }));
  });

  it("fails only the import workflow and does not stamp the normal connection error metadata", async () => {
    const failure = new CTraderSyncError(
      "CTRADER_HISTORICAL_IMPORT_INVALID",
      "Historical import cannot be staged",
      false,
    );
    const { worker, lockClient, run, queries } = workerHarness(async () => { throw failure; });
    await (worker as unknown as {
      executeRun(run: typeof run, client: PoolClient): Promise<void>;
    }).executeRun(run, lockClient);

    expect(queries.some(({ sql }) =>
      sql.includes("UPDATE ctrader_historical_imports SET") && sql.includes("status='failed'"))).toBe(true);
    expect(queries.some(({ sql }) => sql.includes("UPDATE broker_connections SET"))).toBe(false);
  });

  it("acknowledges a committed preview after the worker dies before run finalization", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("UPDATE sync_runs run SET") && sql.includes("import.status IN ('review','completed')")) {
          return result([{ id: "00000000-0000-4000-8000-000000000094" }]);
        }
        return result([]);
      }),
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const worker = new CTraderWorker(database, config(), null, null, {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    });

    await (worker as unknown as { recoverStaleRuns(): Promise<void> }).recoverStaleRuns();

    const acknowledgement = queries.find((sql) =>
      sql.includes("UPDATE sync_runs run SET") && sql.includes("import.status IN ('review','completed')"));
    expect(acknowledgement).toContain("status='succeeded'");
    expect(acknowledgement).toContain("counters=import.counters");
    expect(acknowledgement).toContain("cursor_before=connection.sync_cursor");
  });
});

describe("normal MCP sync after reviewed reconciliation", () => {
  const connection = {
    id: connectionId,
    user_id: userId,
    external_account_id: "5050060",
    provider_environment: "live",
    connected: true,
    access_token_ciphertext: "ciphertext",
    encryption_key_version: 1,
    token_generation: "1",
    sync_cursor: {},
    provider_metadata: {},
    mapped_account_id: mappedAccountId,
    legacy_mapped_account_id: null,
  };
  const projection = {
    positionId: "9001",
    symbolId: "41",
    symbol: "XAU/USD",
    asset: "cm" as const,
    direction: "Long" as const,
    entryPrice: "2000",
    exitPrice: "2010",
    quantityLots: "0.1",
    pnl: null,
    isOpen: false,
    tradeDate: "2026-08-11",
    entryAt: "2026-08-11T10:00:00.000Z",
    exitAt: "2026-08-11T11:00:00.000Z",
    entryTime: "10:00:00",
    exitTime: "11:00:00",
    brokerData: { provider: "ctrader", classification: {} },
  };
  const counters = {
    inserted: 0,
    updated: 0,
    fetchedDeals: 0,
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

  function bareEngine() {
    const appConfig = config();
    const cipher = AesGcmTokenCipher.fromConfig(appConfig.cTrader);
    const database = { query: vi.fn(), connect: vi.fn(), end: vi.fn() } as unknown as Database;
    return new CTraderMcpSyncEngine(
      database,
      appConfig,
      cipher,
      { publish: vi.fn() } as unknown as EventBus,
    );
  }

  it("enriches a linked manual row while preserving manual P&L when provider P&L is unavailable", async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes("FROM ctrader_trade_links link") && sql.includes("JOIN trades trade")) {
          return result([{ id: "00000000-0000-4000-8000-000000000401", deleted_at: null }]);
        }
        if (sql.includes("UPDATE trades SET")) {
          return result([{ id: "00000000-0000-4000-8000-000000000401" }]);
        }
        return result([]);
      }),
    } as unknown as PoolClient;
    const engine = bareEngine();

    await (engine as unknown as {
      upsertProjection(
        client: PoolClient,
        connection: typeof connection,
        projection: typeof projection,
        counters: typeof counters,
      ): Promise<void>;
    }).upsertProjection(client, connection, projection, { ...counters });

    const update = queries.find(({ sql }) => sql.includes("UPDATE trades SET"));
    expect(update?.sql).toContain("WHEN $9::numeric IS NOT NULL THEN $9::numeric");
    expect(update?.sql).toContain("ELSE pnl");
    expect(update?.values[8]).toBeNull();
    expect(update?.sql).not.toContain("strategy=");
    expect(update?.sql).not.toContain("psychology=");
    expect(update?.sql).not.toContain("custom_fields=");
  });

  it.each(["linked", "unlinked"] as const)(
    "applies source-ranked provider P&L transitions atomically for %s projections",
    async (pathKind) => {
      const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
      const client = {
        query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
          queries.push({ sql, values });
          if (sql.includes("FROM ctrader_trade_links link") && sql.includes("JOIN trades trade")) {
            return result(pathKind === "linked" ? [{
              id: "00000000-0000-4000-8000-000000000401",
              deleted_at: null,
              tombstoned: false,
            }] : []);
          }
          if (sql.includes("SELECT id, deleted_at FROM trades")) {
            return result(pathKind === "unlinked" ? [{
              id: "00000000-0000-4000-8000-000000000402",
              deleted_at: null,
            }] : []);
          }
          if (sql.includes("UPDATE trades SET") || sql.includes("INSERT INTO trades")) {
            return result([{ id: "00000000-0000-4000-8000-000000000401" }]);
          }
          return result([]);
        }),
      } as unknown as PoolClient;
      const engine = bareEngine();

      await (engine as unknown as {
        upsertProjection(
          client: PoolClient,
          connection: typeof connection,
          projection: typeof projection,
          counters: typeof counters,
        ): Promise<void>;
      }).upsertProjection(client, connection, {
        ...projection,
        pnl: null,
        brokerData: {
          ...projection.brokerData,
          pnlMethod: "unavailable",
          providerExecutionLineage: { fingerprintSha256: "same-lineage" },
          realizedEvents: [],
        },
      }, { ...counters });

      const write = queries.find(({ sql }) => pathKind === "linked"
        ? sql.includes("UPDATE trades SET")
        : sql.includes("INSERT INTO trades"));
      expect(write).toBeDefined();
      expect(write?.sql).toContain("provider_close_detail_money_digits");
      expect(write?.sql).toContain("provider_explicit_net_cents");
      expect(write?.sql).toContain("provider_mixed_exact_money");
      expect(write?.sql).toContain("providerExecutionLineage,fingerprintSha256");
      expect(write?.sql).toContain("- 'pnlMethod' - 'grossProfit' - 'commission' - 'swap'");
      expect(write?.sql).toContain("- 'pnlConversionFee' - 'realizedEvents'");
      expect(write?.sql).toMatch(pathKind === "linked"
        ? /WHEN \$9::numeric IS NOT NULL THEN \$9::numeric[\s\S]*?THEN pnl[\s\S]*?THEN NULL[\s\S]*?ELSE pnl/
        : /THEN trades\.pnl[\s\S]*?ELSE EXCLUDED\.pnl/);
      expect(write?.sql).toContain("broker_data IS DISTINCT FROM CASE");

      type MoneyState = {
        pnl: string | null;
        method: "unavailable" | "provider_close_detail_money_digits" | "provider_explicit_net_cents"
          | "provider_mixed_exact_money";
        lineage: string;
        realizedEvents: string[];
      };
      const transition = (stored: MoneyState, incoming: MoneyState, linked: boolean): MoneyState => {
        const storedExact = stored.method !== "unavailable";
        const sameLineage = stored.lineage === incoming.lineage;
        if (incoming.method === "unavailable" && storedExact && sameLineage) return stored;
        if (linked && incoming.method === "unavailable" && !storedExact) {
          return { ...incoming, pnl: stored.pnl };
        }
        return incoming;
      };
      const exact = (pnl: string, lineage = "same-lineage"): MoneyState => ({
        pnl,
        method: "provider_close_detail_money_digits",
        lineage,
        realizedEvents: [`close:${pnl}`],
      });
      const mixedExact = (pnl: string, lineage = "same-lineage"): MoneyState => ({
        pnl,
        method: "provider_mixed_exact_money",
        lineage,
        realizedEvents: [`partial-close:${pnl}`],
      });
      const unavailable = (lineage = "same-lineage"): MoneyState => ({
        pnl: null,
        method: "unavailable",
        lineage,
        realizedEvents: [],
      });

      expect(transition(exact("25"), unavailable(), pathKind === "linked")).toEqual(exact("25"));
      expect(transition(mixedExact("23.4"), unavailable(), pathKind === "linked"))
        .toEqual(mixedExact("23.4"));
      expect(transition(exact("25"), unavailable("new-close"), pathKind === "linked"))
        .toEqual(unavailable("new-close"));
      expect(transition(unavailable(), exact("25"), pathKind === "linked")).toEqual(exact("25"));
      expect(transition(exact("25"), exact("27"), pathKind === "linked")).toEqual(exact("27"));
      if (pathKind === "linked") {
        expect(transition({ ...unavailable(), pnl: "19" }, unavailable(), true)).toEqual({
          ...unavailable(),
          pnl: "19",
        });
      }
    },
  );

  it("never nulls or quarantines a linked manual row when a later projection is incomplete", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return result([]);
      }),
    } as unknown as PoolClient;
    const engine = bareEngine();

    await (engine as unknown as {
      quarantineProjection(
        client: PoolClient,
        connection: typeof connection,
        positionId: string,
        reason: string,
      ): Promise<void>;
    }).quarantineProjection(client, connection, "9001", "CTRADER_MCP_LOT_SIZE_UNAVAILABLE");

    expect(queries[0]).toContain("NOT EXISTS");
    expect(queries[0]).toContain("FROM ctrader_trade_links link");
    expect(queries[0]).toContain("link.trade_id=trades.id");
    expect(queries[0]).toContain("provider_mixed_exact_money");
    expect(queries[1]).toContain("EXISTS");
    expect(queries[1]).toContain("FROM ctrader_trade_links link");
    expect(queries[1]).toContain("link.external_position_id=$3");
    expect(queries[1]).toContain("- 'calculatedGrossPnl' - 'calculatedGrossCurrency' - 'calculatedGrossMethod'");
    expect(queries[1]).toContain("- 'calculatedGrossEvents' - 'calculatedGrossProvenance'");
    expect(queries[1]).not.toContain("pnl=");
  });

  it("withholds only positions that still have a pending historical review", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        return sql.includes("ctrader_reconciliation_candidates")
          ? result([{ exists: true }])
          : result([{ exists: false }]);
      }),
    } as unknown as PoolClient;
    const engine = bareEngine();

    const suppressed = await (engine as unknown as {
      positionSuppressed(
        client: PoolClient,
        connection: typeof connection,
        positionId: string,
        counters: typeof counters,
      ): Promise<boolean>;
    }).positionSuppressed(client, connection, "9001", { ...counters });

    expect(suppressed).toBe(true);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("candidate.status='pending'");
    expect(queries[0]).toContain("import.status IN ('queued','running','review')");
  });

  it("atomically refuses a normal projection when a purge tombstone wins the interleaving", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM ctrader_trade_links link") && sql.includes("JOIN trades trade")) return result([]);
        if (sql.includes("SELECT id, deleted_at FROM trades")) return result([]);
        // Simulate the tombstone committing after the early lookups but before
        // the guarded INSERT statement evaluates its NOT EXISTS predicate.
        if (sql.includes("INSERT INTO trades")) return result([]);
        if (sql.includes("SELECT EXISTS") && sql.includes("ctrader_trade_tombstones")) {
          return result([{ exists: true }]);
        }
        return result([]);
      }),
    } as unknown as PoolClient;
    const engine = bareEngine();
    const mutableCounters = { ...counters };

    await (engine as unknown as {
      upsertProjection(
        client: PoolClient,
        connection: typeof connection,
        projection: typeof projection,
        counters: typeof counters,
      ): Promise<void>;
    }).upsertProjection(client, connection, { ...projection, pnl: "25" }, mutableCounters);

    const insert = queries.find((sql) => sql.includes("INSERT INTO trades"));
    expect(insert).toContain("WHERE NOT EXISTS");
    expect(insert).toContain("ctrader_trade_tombstones");
    expect(insert).toContain("DO UPDATE SET");
    expect(insert?.match(/NOT EXISTS/g)?.length).toBe(2);
    expect(mutableCounters.tombstonesPreserved).toBe(1);
    expect(mutableCounters.insertedTrades).toBe(0);
    expect(queries.some((sql) => sql.includes("UPDATE trade_executions SET trade_id"))).toBe(false);
  });
});
