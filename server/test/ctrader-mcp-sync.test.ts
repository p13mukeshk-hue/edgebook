import path from "node:path";
import type { PoolClient, QueryResult } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AesGcmTokenCipher, connectionTokenAad } from "../src/ctrader/crypto.js";
import {
  CTraderMcpSyncEngine,
  type CTraderMcpReadClientLike,
} from "../src/ctrader/mcp-sync.js";
import { CTraderMcpError } from "../src/ctrader/mcp.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";

const connectionId = "00000000-0000-4000-8000-000000000090";
const userId = "00000000-0000-4000-8000-000000000002";
const tradeId = "00000000-0000-4000-8000-000000000099";
const now = new Date("2026-08-11T12:00:00.000Z");
const historyFloor = new Date("2026-08-09T15:59:26.205Z").getTime();

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
    CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 13).toString("base64url") }),
    CTRADER_ACTIVE_KEY_VERSION: "1",
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
    accountId: "5032134",
    filledVolume: "1000",
    executionPrice: 2_000,
    executionTimestamp: new Date("2026-08-10T10:00:00.000Z").getTime(),
    dealStatus: 2,
    authorization: "Bearer provider-must-not-be-stored",
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
    externalAccountId: "5032134",
    environment: "live",
    tokenGeneration: "1",
    acknowledgedAt: "2026-08-11T11:59:00.000Z",
    ...overrides,
  };
}

function harness(dealsResponse: unknown, options: {
  symbolsResponse?: unknown;
  balanceResponse?: unknown;
  accountInfoResponse?: unknown;
  providerMetadata?: Record<string, unknown>;
  lockedProviderMetadata?: Record<string, unknown>;
  syncCursor?: Record<string, unknown>;
  archivedLegacy?: boolean;
  archivedLegacyConnectionId?: string;
  tombstoned?: boolean;
  activeLegacyIds?: string[];
  activeLegacyConnectionId?: string;
  existingTrade?: { id: string; deleted_at: Date | string | null };
} = {}) {
  const appConfig = config();
  const cipher = AesGcmTokenCipher.fromConfig(appConfig.cTrader);
  const providerMetadata = options.providerMetadata ?? {
    historyFloorTimestamp: historyFloor,
    historyFloorKind: "registration",
  };
  const storedExecutions: Array<{ position: string; payload: unknown }> = [];
  const clientQueries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const transactionClient = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      clientQueries.push({ sql, values });
      if (sql.includes("SELECT connected, token_generation")) {
        return result([{
          connected: true,
          token_generation: "1",
          connection_id: connectionId,
          connection_user_id: userId,
          external_account_id: "5032134",
          provider_environment: "live",
          provider_metadata: options.lockedProviderMetadata ?? providerMetadata,
        }]);
      }
      if (sql.includes("SELECT external_execution_id FROM trade_executions")) return result([]);
      if (sql.includes("INSERT INTO trade_executions")) {
        storedExecutions.push({ position: String(values[4]), payload: JSON.parse(String(values[15])) });
        return result([]);
      }
      if (sql.includes("SELECT external_position_id, raw_payload")) {
        return result(storedExecutions.map((execution) => ({
          external_position_id: execution.position,
          raw_payload: execution.payload,
        })));
      }
      if (sql.includes("SELECT EXISTS") && sql.includes("ctrader_trade_tombstones")) {
        return result([{ exists: options.tombstoned ?? false }]);
      }
      if (sql.includes("SELECT EXISTS") && sql.includes("external_trade_key IS NULL")) {
        const scoped = options.archivedLegacyConnectionId ?? connectionId;
        return result([{ exists: (options.archivedLegacy ?? false) && values[1] === scoped }]);
      }
      if (sql.includes("SELECT legacy_trade.id FROM trades") && sql.includes("external_trade_key IS NULL")) {
        const scoped = options.activeLegacyConnectionId ?? connectionId;
        return result(values[1] === scoped ? (options.activeLegacyIds ?? []).map((id) => ({ id })) : []);
      }
      if (sql.includes("SELECT id, deleted_at FROM trades")) {
        return result(options.existingTrade ? [options.existingTrade] : []);
      }
      if (sql.includes("INSERT INTO trades")) return result([{ id: tradeId }]);
      return result([]);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  const database = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM broker_connections")) {
        return result([{
          id: connectionId,
          user_id: userId,
          external_account_id: "5032134",
          provider_environment: "live",
          connected: true,
          access_token_ciphertext: cipher.encrypt("secret-mcp-token", connectionTokenAad(connectionId, "access")),
          encryption_key_version: 1,
          token_generation: "1",
          sync_cursor: options.syncCursor ?? {},
          provider_metadata: providerMetadata,
          mapped_account_id: null,
          legacy_mapped_account_id: null,
        }]);
      }
      return result([]);
    }),
    connect: vi.fn(async () => transactionClient),
    end: vi.fn(async () => undefined),
  } as unknown as Database;
  const readClient = {
    getBalance: vi.fn(async () => options.balanceResponse
      ?? { accountId: "5032134", currency: "USD" }),
    getSymbols: vi.fn(async () => options.symbolsResponse
      ?? [{ id: "41", name: "XAU/USD", lotSize: 100, symbolCategory: "Metals" }]),
    getAccountInfo: vi.fn(async () => options.accountInfoResponse ?? {}),
    getDeals: vi.fn(async () => dealsResponse),
    close: vi.fn(async () => undefined),
  } satisfies CTraderMcpReadClientLike;
  const events = { publish: vi.fn(async () => ({ id: 1 })) } as unknown as EventBus;
  const engine = new CTraderMcpSyncEngine(database, appConfig, cipher, events, () => readClient);
  return { engine, database, readClient, clientQueries, storedExecutions };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("CTraderMcpSyncEngine", () => {
  it("projects one position and preserves the registration history floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient, clientQueries, storedExecutions } = harness([
      deal(),
      deal({
        dealId: "1002",
        orderId: "8002",
        tradeSide: "SELL",
        dealType: "EXIT",
        netPnlCents: 10_000,
        commissionCents: -500,
        swapCents: -100,
        executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
      }),
    ]);

    const synced = await engine.syncConnection(connectionId);

    expect(readClient.getDeals).toHaveBeenCalledTimes(1);
    expect(readClient.getDeals).toHaveBeenCalledWith({
      fromTimestamp: new Date(historyFloor).toISOString(),
      toTimestamp: now.toISOString(),
    });
    expect(synced.counters).toMatchObject({ fetchedDeals: 2, insertedExecutions: 2, insertedTrades: 1 });
    expect(storedExecutions[0]?.payload).toMatchObject({
      edgebookMcpDeal: {
        filledVolumeCents: "1000",
        filledVolumeSourceKey: "filledVolume",
        filledVolumeScale: "unit_cents",
      },
    });
    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values.slice(5, 15)).toEqual([
      "position:9001", "9001", "XAU/USD", "cm", "Long", "2000", "2010", "0.1", "100", false,
    ]);
    expect(JSON.stringify(storedExecutions)).not.toContain("provider-must-not-be-stored");
    const brokerData = JSON.parse(String(tradeInsert?.values[20]));
    expect(brokerData).toMatchObject({
      pnlMethod: "provider_explicit_net_cents",
      grossProfit: null,
      commission: "-5",
      swap: "-1",
      classification: { projectionQuarantined: false },
    });
    const connectionUpdate = clientQueries.find((query) => query.sql.includes("UPDATE broker_connections SET"));
    expect(JSON.parse(String(connectionUpdate?.values[0]))).toMatchObject({
      historyWindowComplete: true,
      fullHistoryComplete: true,
      historyFloorKind: "registration",
      historyStartTimestamp: historyFloor,
      syncedThroughTimestamp: now.getTime(),
    });
    expect(readClient.close).toHaveBeenCalledOnce();
  });

  it("persists generic volume provenance but quarantines projection when its scale is unknown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries, storedExecutions } = harness([deal({
      filledVolume: undefined,
      volume: "1000",
    })]);

    const synced = await engine.syncConnection(connectionId);

    expect(synced.counters).toMatchObject({
      insertedExecutions: 1,
      insertedTrades: 0,
      positionsAwaitingReview: 1,
    });
    expect(storedExecutions[0]?.payload).toMatchObject({
      edgebookMcpDeal: {
        filledVolumeCents: "1000",
        filledVolumeSourceKey: "volume",
        filledVolumeScale: "unknown",
      },
    });
    expect(clientQueries.some((query) => query.sql.includes("INSERT INTO trades"))).toBe(false);
    const quarantine = clientQueries.find((query) => query.sql.includes("projectionQuarantined',true"));
    expect(quarantine?.values).toEqual([
      userId,
      connectionId,
      "position:9001",
      "CTRADER_MCP_VOLUME_SCALE_UNAVAILABLE",
    ]);
  });

  it("does not infer unit-cents semantics from a transformed snake-case volume alias", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries, storedExecutions } = harness([deal({
      filledVolume: undefined,
      filled_volume: "1000",
    })]);

    const synced = await engine.syncConnection(connectionId);

    expect(synced.counters).toMatchObject({ insertedExecutions: 1, insertedTrades: 0, positionsAwaitingReview: 1 });
    expect(storedExecutions[0]?.payload).toMatchObject({
      edgebookMcpDeal: {
        filledVolumeSourceKey: "filled_volume",
        filledVolumeScale: "unknown",
      },
    });
    expect(clientQueries.some((query) => query.sql.includes("INSERT INTO trades"))).toBe(false);
  });

  it("fails closed before persistence when volume aliases conflict", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database, storedExecutions } = harness([deal({ volume: "999" })]);

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_DEAL_INVALID",
      message: "cTrader returned conflicting filledVolume aliases",
    });
    expect(database.connect).not.toHaveBeenCalled();
    expect(storedExecutions).toHaveLength(0);
  });

  it("rejects provider attempts to spoof Edgebook's stored volume provenance envelope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const providerDeal = deal({ filledVolume: undefined, volume: "1000" });
    const { engine, database, storedExecutions } = harness([{
      ...providerDeal,
      edgebookMcpDeal: {
        ...providerDeal,
        volume: undefined,
        filledVolumeCents: "1000",
        filledVolumeSourceKey: "filledVolumeCents",
        filledVolumeScale: "unit_cents",
      },
    }]);

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_DEAL_INVALID",
      message: "cTrader returned reserved internal deal provenance",
    });
    expect(database.connect).not.toHaveBeenCalled();
    expect(storedExecutions).toHaveLength(0);
  });

  it("fails closed when cTrader indicates that a history page is incomplete", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database, readClient } = harness({ deals: [deal()], hasMore: true });
    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_HISTORY_PAGINATION_UNSUPPORTED",
    });
    expect(database.connect).not.toHaveBeenCalled();
    expect(readClient.close).toHaveBeenCalledOnce();
  });

  it.each(["provider error text", null, 42] as const)(
    "does not advance history when cTrader returns a primitive payload (%s)",
    async (payload) => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const { engine, database } = harness(payload);
      await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
        code: "CTRADER_MCP_RESULT_INVALID",
      });
      expect(database.connect).not.toHaveBeenCalled();
    },
  );

  it("inherits the exact session-verified account for an accountless deal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, storedExecutions } = harness([deal({ accountId: undefined })]);

    const synced = await engine.syncConnection(connectionId);

    expect(synced.counters).toMatchObject({ fetchedDeals: 1, insertedExecutions: 1 });
    expect(storedExecutions).toHaveLength(1);
    expect(storedExecutions[0]?.payload).toMatchObject({
      edgebookMcpDeal: { accountId: "5032134" },
    });
  });

  it("inherits a matching response-envelope account for accountless deal rows", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, storedExecutions } = harness({
      ctidTraderAccountId: "5032134",
      deals: [deal({ accountId: undefined })],
    });

    await engine.syncConnection(connectionId);

    expect(storedExecutions[0]?.payload).toMatchObject({
      edgebookMcpDeal: { accountId: "5032134" },
    });
  });

  it("fails closed when neither session metadata nor the response attributes an accountless deal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness([deal({ accountId: undefined })], {
      balanceResponse: { currency: "USD" },
      accountInfoResponse: {},
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_ATTRIBUTION_MISSING",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("accepts accountless rows only under the exact operator-verified per-account token attestation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const providerMetadata = {
      historyFloorTimestamp: historyFloor,
      historyFloorKind: "registration",
      accountlessHistoryAttributionAttestation: accountlessHistoryAttestation(),
    };
    const { engine, storedExecutions } = harness([deal({ accountId: undefined })], {
      balanceResponse: { currency: "USD" },
      accountInfoResponse: {},
      providerMetadata,
    });

    await engine.syncConnection(connectionId);

    expect(storedExecutions[0]?.payload).toMatchObject({
      edgebookMcpDeal: { accountId: "5032134" },
    });
  });

  it("rejects an operator accountless-history attestation bound to another account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database, readClient } = harness([deal({ accountId: undefined })], {
      providerMetadata: {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "registration",
        accountlessHistoryAttributionAttestation: accountlessHistoryAttestation({
          externalAccountId: "999999",
        }),
      },
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNTLESS_ATTESTATION_INVALID",
    });
    expect(readClient.getBalance).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rolls back without executions or cursor movement when the operator attestation is revoked after fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const providerMetadata = {
      historyFloorTimestamp: historyFloor,
      historyFloorKind: "registration",
      accountlessHistoryAttributionAttestation: accountlessHistoryAttestation(),
    };
    const { engine, clientQueries, storedExecutions } = harness([deal({ accountId: undefined })], {
      balanceResponse: { currency: "USD" },
      accountInfoResponse: {},
      providerMetadata,
      lockedProviderMetadata: {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "registration",
      },
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNTLESS_ATTESTATION_CHANGED",
    });
    expect(storedExecutions).toHaveLength(0);
    expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO trade_executions"))).toBe(false);
    expect(clientQueries.some(({ sql }) => sql.includes("UPDATE broker_connections SET"))).toBe(false);
  });

  it("does not let an operator attestation override an explicit deal account mismatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness([deal({ accountId: "999999" })], {
      balanceResponse: { currency: "USD" },
      accountInfoResponse: {},
      providerMetadata: {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "registration",
        accountlessHistoryAttributionAttestation: accountlessHistoryAttestation(),
      },
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_HISTORY_MISMATCH",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("accepts a matching history envelope even when session metadata omits account identity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, storedExecutions } = harness({
      ctidTraderAccountId: "5032134",
      deals: [deal({ accountId: undefined })],
    }, {
      balanceResponse: { currency: "USD" },
      accountInfoResponse: {},
    });

    await engine.syncConnection(connectionId);

    expect(storedExecutions[0]?.payload).toMatchObject({
      edgebookMcpDeal: { accountId: "5032134" },
    });
  });

  it.each([
    {
      balanceResponse: { accountId: "5032134", currency: "USD" },
      accountInfoResponse: { ctidTraderAccountId: "999999" },
    },
    {
      balanceResponse: { accountId: "5032134", ctidTraderAccountId: "999999", currency: "USD" },
      accountInfoResponse: {},
    },
  ])("fails closed on conflicting session account aliases", async (options) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness([deal({ accountId: undefined })], options);

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_MISMATCH",
      requiresReauth: true,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each([
    [
      { accountId: "5032134", currency: "USD" },
      { accountId: "999999", currency: "USD" },
    ],
    {
      account: { accountId: "5032134", currency: "USD" },
      result: { accountId: "999999", currency: "USD" },
    },
  ])("fails closed when a later account metadata entry conflicts", async (balanceResponse) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness([deal({ accountId: undefined })], {
      balanceResponse,
      accountInfoResponse: {},
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_MISMATCH",
      requiresReauth: true,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rejects account metadata arrays beyond the bounded inspection budget", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness([deal({ accountId: undefined })], {
      balanceResponse: Array.from({ length: 5_001 }, () => ({ currency: "USD" })),
      accountInfoResponse: {},
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_METADATA_INVALID",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("fails closed when a session response root conflicts with its selected nested account", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness([deal({ accountId: undefined })], {
      balanceResponse: {
        accountId: "999999",
        data: { accountId: "5032134", currency: "USD" },
      },
      accountInfoResponse: {},
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_MISMATCH",
      requiresReauth: true,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each([
    { ctidTraderAccountId: "999999", deals: [deal({ accountId: undefined })] },
    { ctidTraderAccountId: "5032134", deals: [deal({ accountId: "999999" })] },
    {
      accountId: "5032134",
      ctidTraderAccountId: "999999",
      deals: [deal({ accountId: undefined })],
    },
    [deal({ accountId: "5032134", ctidTraderAccountId: "999999" })],
    [deal({ accountId: "999999" })],
  ])("fails closed on an explicit deal-history account mismatch", async (dealsResponse) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness(dealsResponse);

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_HISTORY_MISMATCH",
      requiresReauth: true,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("persists executions and advances the cursor without guessing a missing lot size", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([deal()], {
      symbolsResponse: [{ id: "41", name: "XAU/USD", symbolCategory: "Metals" }],
      existingTrade: { id: tradeId, deleted_at: null },
    });
    const synced = await engine.syncConnection(connectionId);
    expect(synced.counters).toMatchObject({
      insertedExecutions: 1,
      insertedTrades: 0,
      positionsAwaitingReview: 1,
    });
    expect(clientQueries.some((query) => query.sql.includes("INSERT INTO trades"))).toBe(false);
    const quarantine = clientQueries.find((query) => query.sql.includes("projectionQuarantined',true"));
    expect(quarantine?.values).toEqual([
      userId,
      connectionId,
      "position:9001",
      "CTRADER_MCP_LOT_SIZE_UNAVAILABLE",
    ]);
    const connectionUpdate = clientQueries.find((query) => query.sql.includes("UPDATE broker_connections SET"));
    expect(JSON.parse(String(connectionUpdate?.values[0]))).toMatchObject({
      syncedThroughTimestamp: now.getTime(),
      positionsAwaitingReviewIds: ["9001"],
    });
    expect(JSON.parse(String(connectionUpdate?.values[1]))).toMatchObject({
      positionsAwaitingReview: 1,
      positionReviewReasons: { CTRADER_MCP_LOT_SIZE_UNAVAILABLE: 1 },
      lastWarningCode: "CTRADER_MCP_POSITIONS_AWAITING_REVIEW",
    });
  });

  it("keeps P&L null when cTrader supplies no authoritative realized P&L", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([
      deal(),
      deal({
        dealId: "1002",
        tradeSide: "SELL",
        dealType: "EXIT",
        executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
      }),
    ]);
    await engine.syncConnection(connectionId);
    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[13]).toBeNull();
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      pnlMethod: "unavailable",
      realizedEvents: [],
      classification: { reviewNeeded: true },
    });
  });

  it("does not reinterpret gross or unscaled fee aliases as net minor-unit P&L", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries, storedExecutions } = harness([
      deal(),
      deal({
        dealId: "1002",
        tradeSide: "SELL",
        dealType: "EXIT",
        executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
        grossPnl: 10_000,
        grossProfit: 10_000,
        commission: -500,
        swap: -100,
      }),
    ]);
    await engine.syncConnection(connectionId);
    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[13]).toBeNull();
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      pnlMethod: "unavailable",
      grossProfit: null,
      commission: null,
      swap: null,
      realizedEvents: [],
    });
    const executionInserts = clientQueries.filter((query) => query.sql.includes("INSERT INTO trade_executions"));
    expect(executionInserts.every((query) => query.values[18] === null)).toBe(true);
    const stored = JSON.parse(JSON.stringify(storedExecutions)) as Array<{
      payload: { edgebookMcpDeal: Record<string, unknown> };
    }>;
    expect(JSON.stringify(stored)).not.toMatch(/grossPnl|grossProfit/);
    expect(stored[1]?.payload.edgebookMcpDeal).toMatchObject({
      netPnlCents: null,
      commissionCents: null,
      swapCents: null,
    });
  });

  it("increments from the last successful synced-through cursor with overlap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const syncedThrough = new Date("2026-08-11T10:00:00.000Z").getTime();
    const { engine, readClient } = harness([], {
      syncCursor: {
        historyWindowComplete: true,
        syncedThroughTimestamp: syncedThrough,
        lastDealTimestamp: new Date("2026-08-01T00:00:00.000Z").getTime(),
      },
    });
    await engine.syncConnection(connectionId);
    expect(readClient.getDeals).toHaveBeenCalledWith({
      fromTimestamp: new Date(syncedThrough - 300_000).toISOString(),
      toTimestamp: now.toISOString(),
    });
  });

  it("quarantines a production-shaped connection-time deal without role, P&L or lot size", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries, storedExecutions } = harness([deal({
      dealType: undefined,
      pnl: 99_999,
    })], {
      symbolsResponse: [{ id: "41", name: "XAU/USD", symbolCategory: "Metals" }],
      providerMetadata: {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "connection_time",
      },
    });
    const synced = await engine.syncConnection(connectionId);
    expect(synced.counters).toMatchObject({
      insertedExecutions: 1,
      insertedTrades: 0,
      positionsAwaitingReview: 1,
    });
    expect(storedExecutions).toHaveLength(1);
    expect(JSON.stringify(storedExecutions)).not.toContain("99999");
    expect(clientQueries.some((query) => query.sql.includes("INSERT INTO trades"))).toBe(false);
  });

  it("projects a roleless future position only with an exact account-bound empty-position attestation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([deal({ dealType: undefined })], {
      providerMetadata: {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "connection_time_empty_attested",
        openingLineagePolicy: "user_attested_empty_at_connection",
        noOpenPositionsAttestation: {
          version: 1,
          userId,
          connectionId,
          accountId: "5032134",
          environment: "live",
          boundaryTimestamp: historyFloor,
        },
      },
    });
    const synced = await engine.syncConnection(connectionId);
    expect(synced.counters).toMatchObject({ insertedTrades: 1, positionsAwaitingReview: 0 });
    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      classification: {
        reviewNeeded: true,
        openingLineage: "user_attested_empty_at_connection",
      },
    });
  });

  it("rejects an attested floor whose immutable identity binding does not match the connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness([deal({ dealType: undefined })], {
      providerMetadata: {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "connection_time_empty_attested",
        openingLineagePolicy: "user_attested_empty_at_connection",
        noOpenPositionsAttestation: {
          version: 1,
          userId,
          connectionId,
          accountId: "5043464",
          environment: "live",
          boundaryTimestamp: historyFloor,
        },
      },
    });
    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_HISTORY_BOUND_MISSING",
      requiresReauth: true,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("orders digit-only deal IDs numerically when execution timestamps are equal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const sameTimestamp = new Date("2026-08-10T10:00:00.000Z").getTime();
    const { engine, clientQueries } = harness([
      deal({ dealId: "1000", dealType: undefined, tradeSide: "SELL", executionTimestamp: sameTimestamp }),
      deal({ dealId: "999", dealType: undefined, tradeSide: "BUY", executionTimestamp: sameTimestamp }),
    ], {
      providerMetadata: {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "connection_time_empty_attested",
        openingLineagePolicy: "user_attested_empty_at_connection",
        noOpenPositionsAttestation: {
          version: 1,
          userId,
          connectionId,
          accountId: "5032134",
          environment: "live",
          boundaryTimestamp: historyFloor,
        },
      },
    });
    await engine.syncConnection(connectionId);
    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[9]).toBe("Long");
  });

  it("tombstones an archived legacy position before opener-lineage validation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([
      deal({ dealType: undefined, tradeSide: "SELL" }),
    ], { archivedLegacy: true });
    const synced = await engine.syncConnection(connectionId);
    expect(synced.counters).toMatchObject({ tombstonesPreserved: 1, insertedTrades: 0 });
    expect(clientQueries.some((query) => query.sql.includes("INSERT INTO ctrader_trade_tombstones"))).toBe(true);
    expect(clientQueries.some((query) => query.sql.includes("INSERT INTO trades"))).toBe(false);
  });

  it("does not suppress or adopt the same position ID from another broker connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const otherConnectionId = "00000000-0000-4000-8000-000000000091";
    const { engine, clientQueries } = harness([deal()], {
      archivedLegacy: true,
      archivedLegacyConnectionId: otherConnectionId,
      activeLegacyIds: ["00000000-0000-4000-8000-000000000088"],
      activeLegacyConnectionId: otherConnectionId,
    });
    const synced = await engine.syncConnection(connectionId);
    expect(synced.counters).toMatchObject({ insertedTrades: 1, tombstonesPreserved: 0 });
    const archivedLookup = clientQueries.find((query) =>
      query.sql.includes("SELECT EXISTS") && query.sql.includes("external_trade_key IS NULL"));
    expect(archivedLookup?.sql).toContain("broker_connection_id=$2");
    expect(archivedLookup?.values).toEqual([userId, connectionId, "9001", "5032134", "live"]);
    expect(clientQueries.some((query) => query.sql.includes("INSERT INTO ctrader_trade_tombstones"))).toBe(false);
    expect(clientQueries.some((query) => query.sql.includes("UPDATE trades SET broker_connection_id"))).toBe(false);
  });

  it("never suppresses or adopts legacy rows whose environment provenance was unbound", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([deal()], {
      archivedLegacy: true,
      activeLegacyIds: ["00000000-0000-4000-8000-000000000088"],
      providerMetadata: {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "registration",
        legacyEnvironmentWasUnbound: true,
      },
    });
    const synced = await engine.syncConnection(connectionId);
    expect(synced.counters).toMatchObject({ insertedTrades: 1, tombstonesPreserved: 0 });
    expect(clientQueries.some((query) =>
      query.sql.includes("FROM trades legacy_trade") && query.sql.includes("external_trade_key IS NULL"))).toBe(false);
  });

  it("adopts one active legacy trade identity before projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const legacyTradeId = "00000000-0000-4000-8000-000000000088";
    const { engine, clientQueries } = harness([deal()], { activeLegacyIds: [legacyTradeId] });
    await engine.syncConnection(connectionId);
    const adoption = clientQueries.find((query) => query.sql.includes("UPDATE trades SET broker_connection_id"));
    expect(adoption?.values).toEqual([connectionId, "position:9001", legacyTradeId, userId]);
  });

  it("fails closed when more than one active legacy trade claims a position", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine } = harness([deal()], {
      activeLegacyIds: [
        "00000000-0000-4000-8000-000000000087",
        "00000000-0000-4000-8000-000000000088",
      ],
    });
    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_LEGACY_TRADE_IDENTITY_CONFLICT",
    });
  });

  it.each([
    ["AUTH_REJECTED", false, true],
    ["REMOTE_RATE_LIMITED", true, false],
    ["REMOTE_UNAVAILABLE", true, false],
  ] as const)("maps MCP provider error %s without scrubbing retryable credentials", async (code, retryable, requiresReauth) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient } = harness([]);
    readClient.getDeals.mockRejectedValue(new CTraderMcpError(code, "sanitized provider failure"));
    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({ code, retryable, requiresReauth });
  });

  it("does not reflect unexpected provider or credential details through sync errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, readClient } = harness([]);
    readClient.getDeals.mockRejectedValue(new Error("Bearer provider-secret remote body"));
    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_SYNC_FAILED",
      message: "The cTrader MCP sync failed",
    });
  });
});
