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

function verifiedSymbolOverrides(overrides: Record<string, unknown> = {}) {
  return {
    "41": {
      version: 1,
      purpose: "operator_verified_ctrader_symbol_specification",
      source: "verified_account_symbol_override",
      userId,
      connectionId,
      externalAccountId: "5032134",
      environment: "live",
      tokenGeneration: "1",
      symbolId: "41",
      symbolName: "XAU/USD",
      baseUnitsPerLot: 100,
      measurementUnit: "Oz",
      verifiedAt: "2026-08-11T11:59:00.000Z",
      ...overrides,
    },
  };
}

function harness(dealsResponse: unknown, options: {
  symbolsResponse?: unknown;
  balanceResponse?: unknown;
  assetsResponse?: unknown;
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
  positionDetailsResponse?: unknown;
  pnlRefreshPositionIds?: string[];
  storedExecutionPayloads?: Record<string, unknown>;
  linkedTrade?: { id: string; deleted_at: Date | string | null; tombstoned: boolean };
  liveManualRows?: Array<Record<string, unknown>>;
  liveExistingBroker?: { id: string; row_version: number; deleted_at: Date | string | null };
  liveCandidateDecision?: { status: string; resolution_action: string | null };
  mappedAccountId?: string | null;
  mappedLegacyAccountId?: string | null;
  lockedMappedAccountId?: string | null;
  lockedMappedLegacyAccountId?: string | null;
  mappedAccountCurrency?: string;
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
      if (sql.includes("FROM accounts") && sql.includes("FOR SHARE")) {
        return result(options.mappedAccountId ? [{
          id: options.mappedAccountId,
          legacy_account_id: options.mappedLegacyAccountId ?? null,
          currency_code: options.mappedAccountCurrency ?? "USD",
        }] : []);
      }
      if (sql.includes("SELECT connected, token_generation")) {
        return result([{
          connected: true,
          token_generation: "1",
          connection_id: connectionId,
          connection_user_id: userId,
          external_account_id: "5032134",
          provider_environment: "live",
          provider_metadata: options.lockedProviderMetadata ?? providerMetadata,
          mapped_account_id: options.lockedMappedAccountId === undefined
            ? options.mappedAccountId ?? null : options.lockedMappedAccountId,
          legacy_mapped_account_id: options.lockedMappedLegacyAccountId === undefined
            ? options.mappedLegacyAccountId ?? null : options.lockedMappedLegacyAccountId,
        }]);
      }
      if (sql.includes("SELECT external_execution_id") && sql.includes("FROM trade_executions")) {
        return result(Object.entries(options.storedExecutionPayloads ?? {}).map(([external_execution_id, raw_payload]) => ({
          external_execution_id,
          raw_payload,
        })));
      }
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
      if (sql.includes("FROM ctrader_live_reconciliation_candidates") && sql.includes("resolution_action")) {
        return result(options.liveCandidateDecision ? [options.liveCandidateDecision] : []);
      }
      if (sql.includes("SELECT id, row_version, deleted_at FROM trades")) {
        return result(options.liveExistingBroker ? [options.liveExistingBroker] : []);
      }
      if (sql.includes("FROM ctrader_trade_links link")) {
        return result(options.linkedTrade ? [options.linkedTrade] : []);
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
      if (sql.includes("FROM trades manual") && sql.includes("manual.broker_connection_id IS NULL")) {
        return result(options.liveManualRows ?? []);
      }
      if (sql.includes("INSERT INTO trades")) return result([{ id: tradeId }]);
      return result([]);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  const database = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("SELECT execution.external_position_id")) {
        return result((options.pnlRefreshPositionIds ?? []).map((external_position_id) => ({ external_position_id })));
      }
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
          mapped_account_id: options.mappedAccountId ?? null,
          legacy_mapped_account_id: options.mappedLegacyAccountId ?? null,
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
    getAssets: vi.fn(async () => options.assetsResponse ?? [{ assetId: "15", name: "USD" }]),
    getSymbols: vi.fn(async () => options.symbolsResponse
      ?? [{
        id: "41", name: "XAU/USD", lotSize: 100,
        lotSizeScale: "base_units_per_lot_v1", symbolCategory: "Metals",
      }]),
    getAccountInfo: vi.fn(async () => options.accountInfoResponse ?? {}),
    getDeals: vi.fn(async () => dealsResponse),
    getPositionDetails: vi.fn(async () => options.positionDetailsResponse ?? { deals: [] }),
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
    expect(tradeInsert?.sql).not.toMatch(/DO UPDATE SET[\s\S]*?trade_date\s*=\s*EXCLUDED\.trade_date/);
    const brokerData = JSON.parse(String(tradeInsert?.values[20]));
    expect(brokerData).toMatchObject({
      providerTradeDate: "2026-08-10",
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

  it("resolves live deposit-asset currency and persists bounded exact-P&L capability telemetry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const closing = deal({
      dealId: "1002",
      orderId: "8002",
      tradeSide: "SELL",
      dealType: "EXIT",
      executionPrice: 2_010,
      executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
    });
    const closingWithExactMoney = {
      ...closing,
      closePositionDetail: {
        grossProfit: "2500",
        commission: "-18",
        swap: "0",
        pnlConversionFee: "0",
        moneyDigits: 2,
      },
    };
    const { engine, readClient, clientQueries } = harness([deal(), closing], {
      balanceResponse: { accountId: "5032134", depositAssetId: 15, moneyDigits: 2 },
      assetsResponse: { assets: [{ assetId: 15, displayName: "USD", name: "USD" }] },
      symbolsResponse: [{
        symbolId: 41,
        symbolName: "XAU/USD",
        baseAssetId: 17,
        quoteAssetId: 15,
        lotSize: 100,
        symbolCategory: "Metals",
      }],
      positionDetailsResponse: { deals: [deal(), closingWithExactMoney] },
    });

    await engine.syncConnection(connectionId);

    expect(readClient.getAssets).toHaveBeenCalledOnce();
    expect(readClient.getPositionDetails).toHaveBeenCalledWith("9001");
    const executionInserts = clientQueries.filter(({ sql }) => sql.includes("INSERT INTO trade_executions"));
    expect(executionInserts).toHaveLength(2);
    expect(executionInserts.every(({ values }) => values[13] === "USD")).toBe(true);
    const symbolUpsert = clientQueries.find(({ sql }) => sql.includes("INSERT INTO symbol_specs"));
    expect(JSON.parse(String(symbolUpsert?.values[5]))).toMatchObject({
      baseAssetId: "17",
      quoteAssetId: "15",
    });
    const connectionUpdate = clientQueries.find(({ sql }) => sql.includes("sync_cursor=$1::jsonb"));
    expect(JSON.parse(String(connectionUpdate?.values[1]))).toMatchObject({
      accountCurrency: "USD",
      depositAssetId: "15",
      accountMoneyDigits: 2,
      providerReadTelemetry: {
        version: 1,
        assetsAvailable: true,
        assetCount: 1,
        currencyResolved: true,
        pnlEnrichment: {
          version: 1,
          requestedPositions: 1,
          attemptedPositions: 1,
          successfulResponses: 1,
          positionDetailsAvailable: true,
          authoritativePositions: 1,
          unresolvedPositions: 0,
        },
      },
    });
  });

  it("fails closed when a returned deposit asset cannot be resolved", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness([], {
      balanceResponse: { accountId: "5032134", depositAssetId: 15, moneyDigits: 2 },
      assetsResponse: { assets: [{ assetId: 16, name: "EUR" }] },
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_METADATA_INVALID",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "currency across a provider metadata wrapper",
      balanceResponse: { accountId: "5032134", currency: "USD", depositAssetId: 15, moneyDigits: 2 },
      accountInfoResponse: {},
      providerMetadataExtra: { data: { currencyCode: "EUR" } },
      expectedCode: "CTRADER_MCP_CURRENCY_INVALID",
    },
    {
      label: "deposit asset across a balance wrapper",
      balanceResponse: {
        accountId: "5032134", depositAssetId: 15, moneyDigits: 2,
        result: { accountId: "5032134", deposit_asset_id: 16 },
      },
      accountInfoResponse: {},
      providerMetadataExtra: {},
      expectedCode: "CTRADER_MCP_METADATA_INVALID",
    },
    {
      label: "money digits across account-info aliases",
      balanceResponse: { accountId: "5032134", depositAssetId: 15, moneyDigits: 2 },
      accountInfoResponse: { account: { accountId: "5032134", account_money_digits: 3 } },
      providerMetadataExtra: {},
      expectedCode: "CTRADER_MCP_METADATA_INVALID",
    },
  ])("fails closed on conflicting normal-sync $label", async ({
    balanceResponse, accountInfoResponse, providerMetadataExtra, expectedCode,
  }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const providerMetadata = {
      historyFloorTimestamp: historyFloor,
      historyFloorKind: "registration",
      ...providerMetadataExtra,
    };
    const { engine, database } = harness([], {
      balanceResponse,
      accountInfoResponse,
      assetsResponse: [{ assetId: 15, name: "USD" }, { assetId: 16, name: "EUR" }],
      providerMetadata,
      lockedProviderMetadata: providerMetadata,
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({ code: expectedCode });
    expect(database.connect).not.toHaveBeenCalled();
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
      false,
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

  it("publishes exact base-unit quantity and advances the cursor without guessing a missing lot size", async () => {
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
      updatedTrades: 1,
      positionsAwaitingReview: 0,
    });
    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[12]).toBe("10");
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      quantityProjection: {
        version: 1,
        value: "10",
        unit: "base_units",
        lots: null,
        baseUnits: "10",
        volumeScale: "unit_cents",
        source: "provider_filled_volume",
        contractSizeUsed: null,
      },
      classification: {
        quantityUnit: "base_units",
        quantityLotsConversionAvailable: false,
      },
    });
    const connectionUpdate = clientQueries.find((query) => query.sql.includes("UPDATE broker_connections SET"));
    expect(JSON.parse(String(connectionUpdate?.values[0]))).toMatchObject({
      syncedThroughTimestamp: now.getTime(),
      positionsAwaitingReviewIds: [],
      positionsAwaitingLotConversionIds: ["9001"],
    });
    expect(JSON.parse(String(connectionUpdate?.values[1]))).toMatchObject({
      positionsAwaitingReview: 0,
      positionReviewReasons: {},
      lastWarningCode: null,
    });
  });

  it("safely converts the same position from base-unit quantity to lots after an exact operator symbol override", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const providerMetadata: Record<string, unknown> = {
      historyFloorTimestamp: historyFloor,
      historyFloorKind: "registration",
    };
    const syncCursor: Record<string, unknown> = {};
    const providerDeals = [
      deal({ filledVolume: "200" }),
      deal({
        dealId: "1002",
        orderId: "8002",
        tradeSide: "SELL",
        dealType: "EXIT",
        filledVolume: "200",
        executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
      }),
    ];
    const { engine, clientQueries, storedExecutions } = harness(providerDeals, {
      symbolsResponse: [{ id: "41", name: "XAU/USD", symbolCategory: "Metals" }],
      providerMetadata,
      syncCursor,
    });

    const first = await engine.syncConnection(connectionId);
    expect(first.counters).toMatchObject({
      insertedExecutions: 2,
      insertedTrades: 1,
      positionsAwaitingReview: 0,
    });
    expect(storedExecutions).toHaveLength(2);
    expect(first.cursorAfter).toMatchObject({ positionsAwaitingLotConversionIds: ["9001"] });
    const firstTradeInsert = clientQueries.find(({ sql }) => sql.includes("INSERT INTO trades"));
    expect(firstTradeInsert?.values[12]).toBe("2");
    expect(JSON.parse(String(firstTradeInsert?.values[20]))).toMatchObject({
      positionId: "9001",
      quantityProjection: { value: "2", unit: "base_units", lots: null, baseUnits: "2" },
    });
    Object.assign(syncCursor, first.cursorAfter);
    providerMetadata.verifiedAccountSymbolOverrides = verifiedSymbolOverrides();
    providerDeals.splice(0, providerDeals.length);
    clientQueries.splice(0, clientQueries.length);

    const retried = await engine.syncConnection(connectionId);

    expect(retried.counters).toMatchObject({
      fetchedDeals: 0,
      insertedExecutions: 0,
      insertedTrades: 1,
      positionsProjected: 1,
      positionsAwaitingReview: 0,
    });
    const tradeInsert = clientQueries.find(({ sql }) => sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[12]).toBe("0.02");
    expect(tradeInsert?.values[13]).toBeNull();
    expect(tradeInsert?.values[5]).toBe(firstTradeInsert?.values[5]);
    expect(tradeInsert?.sql).toContain("ON CONFLICT (broker_connection_id, external_trade_key)");
    expect(tradeInsert?.sql).not.toContain("id=EXCLUDED.id");
    expect(tradeInsert?.sql).toContain("row_version=trades.row_version+1");
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      pnlMethod: "unavailable",
      verifiedAccountSymbolOverride: {
        source: "verified_account_symbol_override",
        symbolId: "41",
        baseUnitsPerLot: 100,
        measurementUnit: "Oz",
      },
      classification: {
        lotSizeSource: "verified_account_symbol_override",
        quantityUnit: "lots",
        quantityLotsConversionAvailable: true,
        projectionQuarantined: false,
      },
      quantityProjection: {
        value: "0.02", unit: "lots", lots: "0.02", baseUnits: "2",
        contractSizeUsed: { baseUnitsPerLot: 100, source: "verified_account_symbol_override" },
      },
    });
    const symbolUpsert = clientQueries.find(({ sql }) => sql.includes("INSERT INTO symbol_specs"));
    expect(JSON.parse(String(symbolUpsert?.values[5]))).toMatchObject({
      lotSize: 100,
      lotSizeSource: "verified_account_symbol_override",
      verifiedAccountSymbolOverride: { source: "verified_account_symbol_override" },
    });
    expect(retried.cursorAfter).toMatchObject({
      positionsAwaitingReviewIds: [],
      positionsAwaitingLotConversionIds: [],
    });
  });

  it.each([
    { field: "userId", value: "00000000-0000-4000-8000-000000000003" },
    { field: "connectionId", value: "00000000-0000-4000-8000-000000000091" },
    { field: "externalAccountId", value: "999999" },
    { field: "environment", value: "demo" },
    { field: "tokenGeneration", value: "2" },
    { field: "baseUnitsPerLot", value: 100.5 },
    { field: "measurementUnit", value: "Oz\nunsafe" },
    { field: "purpose", value: "untrusted" },
  ])("rejects an invalid operator symbol override binding: $field", async ({ field, value }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database, readClient } = harness([], {
      providerMetadata: {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "registration",
        verifiedAccountSymbolOverrides: verifiedSymbolOverrides({ [field]: value }),
      },
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_VERIFIED_SYMBOL_OVERRIDE_INVALID",
    });
    expect(readClient.getBalance).not.toHaveBeenCalled();
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rejects an override whose exact symbol name no longer matches cTrader", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness([], {
      symbolsResponse: [{ id: "41", name: "XAUUSD", symbolCategory: "Metals" }],
      providerMetadata: {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "registration",
        verifiedAccountSymbolOverrides: verifiedSymbolOverrides(),
      },
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_VERIFIED_SYMBOL_OVERRIDE_SYMBOL_MISMATCH",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it.each([
    { lotSize: "100.5", expectedCode: "CTRADER_MCP_SYMBOL_SPEC_INVALID" },
    { lotSize: -100, expectedCode: "CTRADER_MCP_SYMBOL_SPEC_INVALID" },
  ])("does not mask a provider contract-size disagreement ($lotSize)", async ({ lotSize, expectedCode }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness([], {
      symbolsResponse: [{ id: "41", name: "XAU/USD", lotSize, symbolCategory: "Metals" }],
      providerMetadata: {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "registration",
        verifiedAccountSymbolOverrides: verifiedSymbolOverrides(),
      },
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({ code: expectedCode });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("does not treat an unscaled provider lotSize as authoritative against a verified override", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const providerMetadata = {
      historyFloorTimestamp: historyFloor,
      historyFloorKind: "registration",
      verifiedAccountSymbolOverrides: verifiedSymbolOverrides(),
    };
    const { engine, clientQueries } = harness([deal()], {
      symbolsResponse: [{ id: "41", name: "XAU/USD", lotSize: 50, symbolCategory: "Metals" }],
      providerMetadata,
      lockedProviderMetadata: providerMetadata,
    });

    await engine.syncConnection(connectionId);

    const tradeInsert = clientQueries.find(({ sql }) => sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[12]).toBe("0.1");
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      verifiedAccountSymbolOverride: { baseUnitsPerLot: 100 },
      quantityProjection: {
        value: "0.1",
        unit: "lots",
        baseUnits: "10",
        contractSizeUsed: { baseUnitsPerLot: 100, source: "verified_account_symbol_override" },
      },
    });
  });

  it.each(["revoked", "changed"] as const)(
    "rolls back before writes when an operator symbol override is $case after fetch",
    async (race) => {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      const providerMetadata = {
        historyFloorTimestamp: historyFloor,
        historyFloorKind: "registration",
        verifiedAccountSymbolOverrides: verifiedSymbolOverrides(),
      };
      const lockedProviderMetadata = race === "revoked"
        ? { historyFloorTimestamp: historyFloor, historyFloorKind: "registration" }
        : {
            ...providerMetadata,
            verifiedAccountSymbolOverrides: verifiedSymbolOverrides({ baseUnitsPerLot: 101 }),
          };
      const { engine, clientQueries, storedExecutions } = harness([deal({ filledVolume: "200" })], {
        symbolsResponse: [{ id: "41", name: "XAU/USD", symbolCategory: "Metals" }],
        providerMetadata,
        lockedProviderMetadata,
      });

      await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
        code: "CTRADER_MCP_VERIFIED_SYMBOL_OVERRIDE_CHANGED",
      });
      expect(storedExecutions).toHaveLength(0);
      expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO trade_executions"))).toBe(false);
      expect(clientQueries.some(({ sql }) => sql.includes("UPDATE broker_connections SET"))).toBe(false);
    },
  );

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

  it.each([
    { manualSymbol: "GOLD", providerSymbol: "XAUUSD" },
    { manualSymbol: "BTC/USD", providerSymbol: "BTCUSD" },
  ])("stages a live manual match for the narrow $manualSymbol provider alias", async ({ manualSymbol, providerSymbol }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([
      deal({ symbolName: providerSymbol }),
      deal({
        dealId: "1002",
        tradeSide: "SELL",
        dealType: "EXIT",
        symbolName: providerSymbol,
        executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
      }),
    ], {
      symbolsResponse: [{
        id: "41", name: providerSymbol, lotSize: 100,
        lotSizeScale: "base_units_per_lot_v1", symbolCategory: "Metals",
      }],
      liveManualRows: [{
        id: "00000000-0000-4000-8000-000000000301",
        row_version: 3,
        deleted_at: null,
        symbol: manualSymbol,
        direction: "Long",
        entry_price: "2000",
        exit_price: "2010",
        quantity: "0.1",
        pnl: "12",
        trade_date: "2026-08-10",
        entry_at: null,
        exit_at: null,
        strategy: "Breakout",
        emotion: "Calm",
        notes: "journal",
        tags: [],
        psychology: { review: "kept" },
        custom_fields: { setup: "A" },
        screenshot_count: "2",
      }],
    });

    const synced = await engine.syncConnection(connectionId);

    expect(synced.counters).toMatchObject({ insertedTrades: 0, positionsProjected: 1 });
    const staged = clientQueries.find(({ sql }) => sql.includes("INSERT INTO ctrader_live_reconciliation_candidates"));
    expect(staged?.values.slice(5, 11)).toEqual([
      "00000000-0000-4000-8000-000000000301", 3, null, null, "high_confidence", 95,
    ]);
    expect(JSON.parse(String(staged?.values[13]))).toMatchObject({
      manualChoices: [{ id: "00000000-0000-4000-8000-000000000301", screenshotCount: 2 }],
    });
    expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO trades"))).toBe(false);
  });

  it("does not match an equal-looking manual lot value to a cTrader base-unit quantity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([deal()], {
      symbolsResponse: [{ id: "41", name: "XAU/USD", symbolCategory: "Metals" }],
      liveManualRows: [{
        id: "00000000-0000-4000-8000-000000000304", row_version: 1, deleted_at: null,
        symbol: "XAU/USD", direction: "Long", entry_price: "2000", exit_price: null,
        // Numerically equal to the projected 10 base units, but this legacy
        // manual cTrader journal quantity is expressed in lots.
        quantity: "10", pnl: null, trade_date: "2026-08-10", entry_at: null, exit_at: null,
        strategy: "manual", emotion: null, notes: "keep", tags: [], psychology: {},
        custom_fields: {}, screenshot_count: 0,
      }],
    });

    const synced = await engine.syncConnection(connectionId);

    expect(synced.counters).toMatchObject({ insertedTrades: 1, positionsProjected: 1 });
    expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO ctrader_live_reconciliation_candidates"))).toBe(false);
    const insert = clientQueries.find(({ sql }) => sql.includes("INSERT INTO trades"));
    expect(insert?.values[12]).toBe("10");
    expect(JSON.parse(String(insert?.values[20]))).toMatchObject({
      quantityProjection: { value: "10", unit: "base_units", lots: null },
    });
  });

  it("suggests an adjacent-day manual match only as ambiguous explicit review", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([
      deal(),
      deal({
        dealId: "1002", tradeSide: "SELL", dealType: "EXIT", executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
      }),
    ], {
      liveManualRows: [{
        id: "00000000-0000-4000-8000-000000000302", row_version: 2, deleted_at: null,
        symbol: "XAU/USD", direction: "Long", entry_price: "2000", exit_price: "2010",
        quantity: "0.1", pnl: null, trade_date: "2026-08-11", entry_at: null, exit_at: null,
        strategy: null, emotion: null, notes: null, tags: [], psychology: {}, custom_fields: {}, screenshot_count: 0,
      }],
    });

    await engine.syncConnection(connectionId);

    const staged = clientQueries.find(({ sql }) => sql.includes("INSERT INTO ctrader_live_reconciliation_candidates"));
    expect(staged?.values[5]).toBeNull();
    expect(staged?.values[9]).toBe("ambiguous");
    expect(JSON.parse(String(staged?.values[11]))).toContain("explicit_manual_selection_required");
  });

  it("publishes a broker trade on the next sync after a manual-match suggestion is rejected", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([deal()], {
      liveCandidateDecision: { status: "rejected", resolution_action: "reject" },
      liveManualRows: [{
        id: "00000000-0000-4000-8000-000000000303", row_version: 1, deleted_at: null,
        symbol: "XAU/USD", direction: "Long", entry_price: "2000", exit_price: null,
        quantity: "0.1", pnl: null, trade_date: "2026-08-10", entry_at: null, exit_at: null,
        strategy: "manual", emotion: null, notes: "keep", tags: [], psychology: {},
        custom_fields: {}, screenshot_count: 1,
      }],
    });

    const synced = await engine.syncConnection(connectionId);

    expect(synced.counters).toMatchObject({ insertedTrades: 1, positionsProjected: 1 });
    expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO ctrader_live_reconciliation_candidates"))).toBe(false);
    expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO trades"))).toBe(true);
  });

  it("retires a stale pending candidate before publishing when its manual match disappeared", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([deal()], {
      liveCandidateDecision: { status: "pending", resolution_action: null },
      liveManualRows: [],
    });

    await engine.syncConnection(connectionId);

    const retirement = clientQueries.find(({ sql }) =>
      sql.includes("DELETE FROM ctrader_live_reconciliation_candidates") && sql.includes("status='pending'"));
    const brokerInsert = clientQueries.find(({ sql }) => sql.includes("INSERT INTO trades"));
    expect(retirement).toBeDefined();
    expect(brokerInsert).toBeDefined();
    expect(clientQueries.indexOf(retirement!)).toBeLessThan(clientQueries.indexOf(brokerInsert!));
  });

  it("retires a pending live candidate when a purge tombstone suppresses its provider position", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([deal()], {
      tombstoned: true,
      liveCandidateDecision: { status: "pending", resolution_action: null },
    });

    const synced = await engine.syncConnection(connectionId);

    expect(synced.counters).toMatchObject({ insertedTrades: 0, tombstonesPreserved: 1 });
    expect(clientQueries.some(({ sql }) =>
      sql.includes("DELETE FROM ctrader_live_reconciliation_candidates") && sql.includes("status='pending'"))).toBe(true);
    expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO trades"))).toBe(false);
  });

  it("fails closed before writes when the account mapping changes during provider fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const initialAccountId = "00000000-0000-4000-8000-000000000401";
    const lockedAccountId = "00000000-0000-4000-8000-000000000402";
    const { engine, clientQueries } = harness([deal()], {
      mappedAccountId: initialAccountId,
      mappedLegacyAccountId: "old-account",
      lockedMappedAccountId: lockedAccountId,
      lockedMappedLegacyAccountId: "current-account",
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_ACCOUNT_MAPPING_CHANGED",
      retryable: true,
    });
    expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO trade_executions"))).toBe(false);
    expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO trades"))).toBe(false);
  });

  it("continues updating a separately published broker trade with later close and P&L facts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([
      deal(),
      deal({
        dealId: "1002", tradeSide: "SELL", dealType: "EXIT", executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(), netPnlCents: 2_500,
      }),
    ], {
      liveCandidateDecision: { status: "published", resolution_action: "publish_separate" },
      existingTrade: { id: tradeId, deleted_at: null },
      liveExistingBroker: { id: tradeId, row_version: 2, deleted_at: null },
    });

    await engine.syncConnection(connectionId);

    expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO ctrader_live_reconciliation_candidates"))).toBe(false);
    const brokerUpsert = clientQueries.find(({ sql }) => sql.includes("INSERT INTO trades"));
    expect(brokerUpsert?.values[13]).toBe("25");
    expect(brokerUpsert?.values[14]).toBe(false);
  });

  it("keeps an existing broker row provider-current while an existing-pair merge is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([
      deal(),
      deal({
        dealId: "1002", tradeSide: "SELL", dealType: "EXIT", executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(), netPnlCents: 2_500,
      }),
    ], {
      existingTrade: { id: tradeId, deleted_at: null },
      liveExistingBroker: { id: tradeId, row_version: 2, deleted_at: null },
      liveManualRows: [{
        id: "00000000-0000-4000-8000-000000000304", row_version: 1, deleted_at: null,
        symbol: "XAU/USD", direction: "Long", entry_price: "2000", exit_price: "2010",
        quantity: "0.1", pnl: null, trade_date: "2026-08-10", entry_at: null, exit_at: null,
        strategy: "manual", emotion: null, notes: "merge me", tags: [], psychology: {},
        custom_fields: {}, screenshot_count: 0,
      }],
    });

    await engine.syncConnection(connectionId);

    expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO ctrader_live_reconciliation_candidates"))).toBe(true);
    const brokerUpsert = clientQueries.find(({ sql }) => sql.includes("INSERT INTO trades"));
    expect(brokerUpsert?.values[13]).toBe("25");
    expect(brokerUpsert?.values[14]).toBe(false);
  });

  it("uses authoritative nested close money with its provider moneyDigits", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const opening = deal();
    const closing = deal({
      dealId: "1002",
      tradeSide: "SELL",
      dealType: "EXIT",
      executionPrice: 2_010,
      executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
    });
    const authoritativeClosing = {
      ...closing,
      closePositionDetail: {
        grossProfit: 250_000,
        swap: -10_000,
        commission: -5_000,
        pnlConversionFee: 1_000,
        moneyDigits: 4,
      },
    };
    const { engine, clientQueries, storedExecutions, readClient } = harness([
      opening,
      closing,
    ], { positionDetailsResponse: { deals: [opening, authoritativeClosing] } });

    await engine.syncConnection(connectionId);

    expect(readClient.getPositionDetails).toHaveBeenCalledWith("9001");

    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[13]).toBe("23.4");
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      pnlMethod: "provider_close_detail_money_digits",
      pnlAuthority: "provider",
      pnlComponentsCoverage: {
        source: "ProtoOAClosePositionDetail",
        tradeLevelExact: true,
        grossProfit: true,
        brokerCommission: true,
        swap: true,
        pnlConversionFee: true,
        otherAccountCashFlowsIncluded: false,
      },
      grossProfit: "25",
      commission: "-0.5",
      swap: "-1",
      pnlConversionFee: "0.1",
      realizedEvents: [{ pnl: "23.4", grossProfit: "25", commission: "-0.5", swap: "-1" }],
    });
    const executionInsert = clientQueries.filter((query) => query.sql.includes("INSERT INTO trade_executions"))[1];
    expect(executionInsert?.values.slice(10, 13)).toEqual(["23.4", "-0.5", "-1"]);
    expect(executionInsert?.values[18]).toBe(4);
    expect(JSON.parse(String(executionInsert?.values[19]))).toMatchObject({ moneyDigits: 4, grossProfit: "250000" });
    expect(storedExecutions[1]?.payload).toMatchObject({
      edgebookMcpDeal: {
        closePositionDetail: { moneyDigits: 4, grossProfit: "250000" },
      },
    });
  });

  it("completes mixed exact-money closes without scheduling another P&L enrichment", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries, readClient } = harness([
      deal(),
      deal({
        dealId: "1002",
        orderId: "8002",
        tradeSide: "SELL",
        dealType: "EXIT",
        filledVolume: "400",
        executionPrice: 2_005,
        executionTimestamp: new Date("2026-08-10T10:30:00.000Z").getTime(),
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
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
        closePositionDetail: {
          grossProfit: 200_000,
          swap: -10_000,
          commission: -5_000,
          pnlConversionFee: 1_000,
          moneyDigits: 4,
        },
      }),
    ]);

    await engine.syncConnection(connectionId);

    expect(readClient.getPositionDetails).not.toHaveBeenCalled();
    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[13]).toBe("23.4");
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      pnlMethod: "provider_mixed_exact_money",
      grossProfit: null,
      commission: null,
      swap: null,
      pnlConversionFee: null,
      realizedEvents: [
        { executionId: "1002", pnl: "5", commission: "-0.5", swap: "0" },
        { executionId: "1003", pnl: "18.4", grossProfit: "20", commission: "-0.5", swap: "-1" },
      ],
    });
  });

  it("retains stored exact close money when the same execution replay omits it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const opening = deal();
    const closing = deal({
      dealId: "1002", tradeSide: "SELL", dealType: "EXIT", executionPrice: 2_010,
      executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
    });
    const storedClosing = {
      edgebookMcpDeal: {
        version: 1,
        dealId: "1002", positionId: "9001", orderId: "8001", symbolId: "41",
        symbolName: "XAU/USD", accountId: "5032134", side: "SELL", role: "CLOSE",
        filledVolumeCents: "1000", filledVolumeSourceKey: "filledVolume",
        filledVolumeScale: "unit_cents", executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
        dealStatus: 2, providerUpdatedTimestamp: null, netPnlCents: null,
        commissionCents: null, swapCents: null,
        closePositionDetail: {
          grossProfit: "250000", commission: "-5000", swap: "-10000",
          pnlConversionFee: "1000", moneyDigits: 4,
        },
      },
    };
    const { engine, clientQueries } = harness([opening, closing], {
      storedExecutionPayloads: { "1002": storedClosing },
    });

    await engine.syncConnection(connectionId);

    const tradeInsert = clientQueries.find(({ sql }) => sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[13]).toBe("23.4");
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      pnlMethod: "provider_close_detail_money_digits",
      realizedEvents: [{ executionId: "1002", pnl: "23.4" }],
    });
    const closingUpsert = clientQueries.filter(({ sql }) => sql.includes("INSERT INTO trade_executions"))[1];
    expect(closingUpsert?.values[10]).toBe("23.4");
    expect(closingUpsert?.values[18]).toBe(4);
    expect(closingUpsert?.sql).toContain("trade_executions.close_position_detail");
  });

  it("fails closed when a stored exact execution conflicts with a replayed exact value", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const closing = deal({
      dealId: "1002", tradeSide: "SELL", dealType: "EXIT", executionPrice: 2_010,
      executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(), netPnlCents: 2_500,
    });
    const storedClosing = {
      edgebookMcpDeal: {
        version: 1,
        dealId: "1002", positionId: "9001", orderId: "8001", symbolId: "41",
        symbolName: "XAU/USD", accountId: "5032134", side: "SELL", role: "CLOSE",
        filledVolumeCents: "1000", filledVolumeSourceKey: "filledVolume",
        filledVolumeScale: "unit_cents", executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
        dealStatus: 2, providerUpdatedTimestamp: null, netPnlCents: 2_400,
        commissionCents: null, swapCents: null,
      },
    };
    const { engine, clientQueries } = harness([deal(), closing], {
      storedExecutionPayloads: { "1002": storedClosing },
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_DUPLICATE_DEAL_CONFLICT",
    });
    expect(clientQueries.some(({ sql }) => sql.includes("INSERT INTO trade_executions"))).toBe(false);
  });

  it("stores the live XAUUSD calculated gross separately while exact net remains unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T01:00:00.000Z"));
    const liveMetadata = {
      historyFloorTimestamp: historyFloor,
      historyFloorKind: "registration",
      verifiedAccountSymbolOverrides: verifiedSymbolOverrides({
        symbolName: "XAUUSD",
      }),
    };
    const { engine, clientQueries } = harness([
      deal({
        dealId: "6678962", positionId: "4556640", tradeSide: "SELL", dealType: undefined,
        symbolName: "XAUUSD", filledVolume: "200", executionPrice: 4_401.84,
        commission: -9,
        executionTimestamp: new Date("2026-08-12T04:49:17.842Z").getTime(),
      }),
      deal({
        dealId: "6679278", positionId: "4556640", tradeSide: "BUY", dealType: undefined,
        symbolName: "XAUUSD", filledVolume: "200", executionPrice: 4_391.51,
        commission: -9,
        executionTimestamp: new Date("2026-08-12T05:30:01.003Z").getTime(),
      }),
    ], {
      providerMetadata: liveMetadata,
      lockedProviderMetadata: liveMetadata,
      balanceResponse: { accountId: "5032134", depositAssetId: "15", moneyDigits: 2 },
      assetsResponse: [{ assetId: "15", name: "USD" }, { assetId: "17", name: "XAU" }],
      symbolsResponse: [{
        id: "41", name: "XAUUSD", baseAssetId: "17", quoteAssetId: "15", symbolCategory: "Metals",
      }],
    });

    await engine.syncConnection(connectionId);

    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[13]).toBeNull();
    const brokerData = JSON.parse(String(tradeInsert?.values[20]));
    expect(brokerData).toMatchObject({
      pnlMethod: "unavailable",
      realizedEvents: [],
      calculatedGrossPnl: "20.66",
      calculatedGrossCurrency: "USD",
      calculatedGrossMethod: "fill_price_base_units_identity_conversion_v1",
      estimatedCommission: "-0.18",
      estimatedSwap: "0",
      estimatedConversionFee: "0",
      estimatedOtherCharges: "0",
      estimatedFeesAndCharges: "-0.18",
      estimatedNetPnl: "20.48",
      estimatedNetCurrency: "USD",
      estimatedNetMethod: "remote_mcp_execution_commission_same_currency_v1",
      estimatedNetProvenance: {
        exact: false,
        commission: { executionCount: 2, rawUnitsAssumedAtAccountMoneyDigits: true },
        swap: { assumedZero: true, source: "same_provider_calendar_day_assumption" },
        analyticsTreatment: "provisional_net_only",
      },
      calculatedGrossProvenance: {
        feesIncluded: false,
        analyticsTreatment: "excluded_from_net_pnl",
        accountMoneyDigits: 2,
        baseAssetId: "17",
        baseAssetName: "XAU",
        roundingRule: "half_away_from_zero_at_account_money_digits",
        quoteAssetId: "15",
        depositAssetId: "15",
        conversionRate: "1",
        symbolSpec: {
          symbolId: "41", baseUnitsPerLot: 100,
          lotSizeSource: "verified_account_symbol_override", measurementUnit: "Oz",
        },
      },
    });
  });

  it("calculates gross from exact filled base units when no contract size is available", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([
      deal({ filledVolume: "1000" }),
      deal({
        dealId: "1002", orderId: "8002", tradeSide: "SELL", dealType: "EXIT",
        filledVolume: "1000", executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
      }),
    ], {
      balanceResponse: { accountId: "5032134", depositAssetId: "15", moneyDigits: 2 },
      assetsResponse: [{ assetId: "15", name: "USD" }, { assetId: "17", name: "XAU" }],
      symbolsResponse: [{
        id: "41", name: "XAU/USD", baseAssetId: "17", quoteAssetId: "15", symbolCategory: "Metals",
      }],
    });

    await engine.syncConnection(connectionId);

    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[12]).toBe("10");
    expect(tradeInsert?.values[13]).toBeNull();
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      quantityProjection: {
        value: "10", unit: "base_units", lots: null, baseUnits: "10", contractSizeUsed: null,
      },
      calculatedGrossPnl: "100",
      calculatedGrossCurrency: "USD",
      calculatedGrossMethod: "fill_price_base_units_identity_conversion_v1",
      calculatedGrossProvenance: {
        volumeInterpretation: "provider_filled_volume_cents_to_base_units",
        contractSizeRequiredForCalculation: false,
        baseAssetId: "17", quoteAssetId: "15", depositAssetId: "15",
        symbolSpec: { baseUnitsPerLot: null, quantityLotsConversionAvailable: false },
      },
    });
  });

  it("includes observed deal swap with opening and closing commissions in estimated net", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([
      deal({ commission: -9, swap: 0 }),
      deal({
        dealId: "1002", orderId: "8002", tradeSide: "SELL", dealType: "EXIT",
        commission: -9, swap: -5, executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
      }),
    ], {
      balanceResponse: { accountId: "5032134", depositAssetId: "15", moneyDigits: 2 },
      assetsResponse: [{ assetId: "15", name: "USD" }, { assetId: "17", name: "XAU" }],
      symbolsResponse: [{
        id: "41", name: "XAU/USD", baseAssetId: "17", quoteAssetId: "15",
        lotSize: 100, lotSizeScale: "base_units_per_lot_v1", symbolCategory: "Metals",
      }],
    });

    await engine.syncConnection(connectionId);

    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[13]).toBeNull();
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      calculatedGrossPnl: "100",
      estimatedCommission: "-0.18",
      estimatedSwap: "-0.05",
      estimatedFeesAndCharges: "-0.23",
      estimatedNetPnl: "99.77",
      estimatedNetProvenance: {
        swap: { source: "sum_of_deal_swap", assumedZero: false },
      },
    });
  });

  it("estimates net for a short overnight trade when commission is observed and swap is absent", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T04:00:00.000Z"));
    const { engine, clientQueries } = harness([
      deal({
        dealId: "6775120", positionId: "4626156", tradeSide: "SELL", dealType: undefined,
        symbolName: "XAUUSD", filledVolume: "200", executionPrice: 4_369.45, commission: -9,
        executionTimestamp: new Date("2026-08-18T16:22:00.893Z").getTime(),
      }),
      deal({
        dealId: "6776753", positionId: "4626156", tradeSide: "BUY", dealType: undefined,
        symbolName: "XAUUSD", filledVolume: "200", executionPrice: 4_348.57, commission: -9,
        executionTimestamp: new Date("2026-08-18T19:48:05.800Z").getTime(),
      }),
    ], {
      balanceResponse: { accountId: "5032134", depositAssetId: "15", moneyDigits: 2 },
      assetsResponse: [{ assetId: "15", name: "USD" }, { assetId: "17", name: "XAU" }],
      symbolsResponse: [{
        id: "41", name: "XAU/USD", baseAssetId: "17", quoteAssetId: "15",
        lotSize: 100, lotSizeScale: "base_units_per_lot_v1", symbolCategory: "Metals",
      }],
    });

    await engine.syncConnection(connectionId);

    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      calculatedGrossPnl: "41.76",
      estimatedCommission: "-0.18",
      estimatedSwap: "0",
      estimatedFeesAndCharges: "-0.18",
      estimatedNetPnl: "41.58",
      estimatedNetProvenance: {
        swap: {
          source: "short_duration_no_observed_swap_assumption",
          assumedZero: true,
          maxDurationHours: 12,
        },
      },
    });
  });

  it("withholds estimated net for a long overnight trade when swap is not observed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([
      deal({ commission: -9, executionTimestamp: new Date("2026-08-10T10:00:00.000Z").getTime() }),
      deal({
        dealId: "1002", orderId: "8002", tradeSide: "SELL", dealType: "EXIT",
        commission: -9, executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-11T11:00:00.000Z").getTime(),
      }),
    ], {
      balanceResponse: { accountId: "5032134", depositAssetId: "15", moneyDigits: 2 },
      assetsResponse: [{ assetId: "15", name: "USD" }, { assetId: "17", name: "XAU" }],
      symbolsResponse: [{
        id: "41", name: "XAU/USD", baseAssetId: "17", quoteAssetId: "15",
        lotSize: 100, lotSizeScale: "base_units_per_lot_v1", symbolCategory: "Metals",
      }],
    });

    await engine.syncConnection(connectionId);

    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(JSON.parse(String(tradeInsert?.values[20]))).toMatchObject({
      calculatedGrossPnl: "100",
      estimatedFeesAndCharges: null,
      estimatedNetPnl: null,
      estimatedNetMethod: null,
    });
  });

  it("does not calculate gross when the provider quote asset differs from the deposit asset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([
      deal(),
      deal({
        dealId: "1002", tradeSide: "SELL", dealType: "EXIT", executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
      }),
    ], {
      balanceResponse: { accountId: "5032134", depositAssetId: "15", moneyDigits: 2 },
      assetsResponse: [{ assetId: "15", name: "USD" }, { assetId: "16", name: "EUR" }],
      symbolsResponse: [{
        id: "41", name: "XAU/USD", baseAssetId: "17", quoteAssetId: "16",
        lotSize: 100, symbolCategory: "Metals",
      }],
    });

    await engine.syncConnection(connectionId);

    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    const brokerData = JSON.parse(String(tradeInsert?.values[20]));
    expect(tradeInsert?.values[13]).toBeNull();
    expect(brokerData).toMatchObject({ pnlMethod: "unavailable", pnlAuthority: "provider_unavailable" });
    expect(brokerData).toMatchObject({
      calculatedGrossPnl: null,
      calculatedGrossCurrency: null,
      calculatedGrossMethod: null,
      calculatedGrossEvents: [],
      calculatedGrossProvenance: null,
    });
  });

  it("provider exact net supersedes calculated gross in canonical P&L while retaining its audit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, clientQueries } = harness([
      deal(),
      deal({
        dealId: "1002", tradeSide: "SELL", dealType: "EXIT", executionPrice: 2_010,
        executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(), netPnlCents: 2_500,
      }),
    ], {
      existingTrade: { id: tradeId, deleted_at: null },
      balanceResponse: { accountId: "5032134", depositAssetId: "15", moneyDigits: 2 },
      assetsResponse: [{ assetId: "15", name: "USD" }, { assetId: "17", name: "XAU" }],
      symbolsResponse: [{
        id: "41", name: "XAU/USD", baseAssetId: "17", quoteAssetId: "15",
        lotSize: 100, lotSizeScale: "base_units_per_lot_v1", symbolCategory: "Metals",
      }],
    });

    await engine.syncConnection(connectionId);

    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[13]).toBe("25");
    const brokerData = JSON.parse(String(tradeInsert?.values[20]));
    expect(brokerData).toMatchObject({
      pnlMethod: "provider_explicit_net_cents",
      pnlAuthority: "provider",
      pnlComponentsCoverage: {
        source: "RemoteMcpVettedExactNet",
        tradeLevelExact: true,
        grossProfit: false,
        brokerCommission: false,
        swap: false,
        pnlConversionFee: false,
        formula: "provider_exact_net",
      },
      calculatedGrossPnl: "100",
      calculatedGrossProvenance: {
        providerExactNetPriority: true,
        inputFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(brokerData.realizedEvents).toHaveLength(1);
  });

  it("fails closed when explicit cents conflict with authoritative close money", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const { engine, database } = harness([deal({
      dealType: "EXIT",
      tradeSide: "SELL",
      netPnlCents: 2_341,
      closePositionDetail: {
        grossProfit: 250_000,
        swap: -10_000,
        commission: -5_000,
        pnlConversionFee: 1_000,
        moneyDigits: 4,
      },
    })]);

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_DEAL_INVALID",
      message: "cTrader returned conflicting realized P&L representations",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("re-fetches a previously stored closed position without regressing the normal sync cursor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const opening = deal();
    const closing = deal({
      dealId: "1002", tradeSide: "SELL", dealType: "EXIT", executionPrice: 2_010,
      executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
      closePositionDetail: {
        grossProfit: 250_000, swap: -10_000, commission: -5_000, pnlConversionFee: 1_000, moneyDigits: 4,
      },
    });
    const rejected = deal({
      dealId: "1003", tradeSide: "BUY", dealType: "ENTRY", dealStatus: "INTERNALLY_REJECTED",
      filledVolume: "0", volume: "200", executionPrice: 0,
      executionTimestamp: new Date("2026-08-10T10:59:59.000Z").getTime(),
    });
    const newerCursorTimestamp = new Date("2026-08-11T10:00:00.000Z").getTime();
    const { engine, readClient, clientQueries, storedExecutions } = harness([], {
      pnlRefreshPositionIds: ["9001"],
      positionDetailsResponse: { deals: [opening, rejected, closing] },
      syncCursor: {
        historyWindowComplete: true,
        syncedThroughTimestamp: newerCursorTimestamp,
        lastDealTimestamp: newerCursorTimestamp,
        lastDealId: "newer-deal",
      },
    });

    await engine.syncConnection(connectionId);

    expect(readClient.getPositionDetails).toHaveBeenCalledWith("9001");
    expect(storedExecutions.map((execution) => (execution.payload as { edgebookMcpDeal?: { dealId?: string } })
      .edgebookMcpDeal?.dealId)).not.toContain("1003");
    const tradeInsert = clientQueries.find((query) => query.sql.includes("INSERT INTO trades"));
    expect(tradeInsert?.values[13]).toBe("23.4");
    const connectionUpdate = clientQueries.find((query) => query.sql.includes("UPDATE broker_connections SET"));
    expect(JSON.parse(String(connectionUpdate?.values[0]))).toMatchObject({
      lastDealTimestamp: newerCursorTimestamp,
      lastDealId: "newer-deal",
    });
  });

  it("upgrades a linked manual trade with non-null displayed P&L when provider provenance is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const opening = deal();
    const closing = deal({
      dealId: "1002", tradeSide: "SELL", dealType: "EXIT", executionPrice: 2_010,
      executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
      closePositionDetail: {
        grossProfit: 250_000, swap: -10_000, commission: -5_000, pnlConversionFee: 1_000, moneyDigits: 4,
      },
    });
    const { engine, database, clientQueries } = harness([], {
      pnlRefreshPositionIds: ["9001"],
      positionDetailsResponse: { deals: [opening, closing] },
      linkedTrade: { id: "00000000-0000-4000-8000-000000000301", deleted_at: null, tombstoned: false },
      syncCursor: {
        historyWindowComplete: true,
        syncedThroughTimestamp: new Date("2026-08-11T10:00:00.000Z").getTime(),
      },
    });

    await engine.syncConnection(connectionId);

    const refreshQuery = vi.mocked(database.query).mock.calls.find(([sql]) =>
      String(sql).includes("SELECT execution.external_position_id"));
    expect(String(refreshQuery?.[0])).toContain("trade.broker_data->>'pnlMethod'='unavailable'");
    expect(String(refreshQuery?.[0])).not.toContain("trade.pnl IS NULL");
    const linkedUpdate = clientQueries.find(({ sql }) =>
      sql.includes("UPDATE trades SET") && sql.includes("WHEN $9::numeric IS NOT NULL THEN $9::numeric"));
    expect(linkedUpdate?.values[8]).toBe("23.4");
    expect(linkedUpdate?.sql).toContain("trade_date=COALESCE(trade_date,$11::date)");
    expect(linkedUpdate?.sql).not.toContain("trade_date=$11");
    expect(JSON.parse(String(linkedUpdate?.values[15]))).toMatchObject({
      providerTradeDate: "2026-08-10",
      pnlMethod: "provider_close_detail_money_digits",
      classification: { reconciledManualTrade: true },
    });
  });

  it.each([
    "accountId", "account_id", "ctidTraderAccountId", "ctidTradingAccountId", "traderAccountId",
  ])("rejects a mismatched %s inside the position-detail position wrapper", async (accountKey) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const opening = deal({ accountId: undefined });
    const closing = deal({
      dealId: "1002", accountId: undefined, tradeSide: "SELL", dealType: "EXIT", executionPrice: 2_010,
      executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
    });
    const { engine, database } = harness([opening, closing], {
      positionDetailsResponse: {
        position: { positionId: "9001", [accountKey]: "different-account" },
        deals: [opening, closing],
      },
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_HISTORY_MISMATCH",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rejects a mismatched account inside the position-detail orders wrapper", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const opening = deal({ accountId: undefined });
    const closing = deal({
      dealId: "1002", accountId: undefined, tradeSide: "SELL", dealType: "EXIT", executionPrice: 2_010,
      executionTimestamp: new Date("2026-08-10T11:00:00.000Z").getTime(),
    });
    const { engine, database } = harness([opening, closing], {
      positionDetailsResponse: {
        orders: [{ orderId: "7001", ctidTraderAccountId: "different-account" }],
        deals: [opening, closing],
      },
    });

    await expect(engine.syncConnection(connectionId)).rejects.toMatchObject({
      code: "CTRADER_MCP_ACCOUNT_HISTORY_MISMATCH",
    });
    expect(database.connect).not.toHaveBeenCalled();
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
      pnlAuthority: "provider_unavailable",
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
