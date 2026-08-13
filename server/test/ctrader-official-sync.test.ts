import path from "node:path";
import type { PoolClient, QueryResult } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { CTraderGateway } from "../src/ctrader/client.js";
import { AesGcmTokenCipher, connectionTokenAad } from "../src/ctrader/crypto.js";
import type { CTraderOAuthClient } from "../src/ctrader/oauth.js";
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
        if (sql.includes("SELECT external_cash_flow_id")) return result([]);
        if (sql.includes("INSERT INTO ctrader_account_cash_flows")) {
          return result([{ id: "00000000-0000-4000-8000-000000000099" }]);
        }
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
        getTraderMetadata: async () => ({ registrationTimestamp: registration, depositAssetId: "1", moneyDigits: null, raw: {} }),
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
    });
    expect(sync.cursorAfter).toMatchObject({
      cashFlowHistoryComplete: true,
      cashFlowSyncedThroughTimestamp: now.getTime(),
      lastCashFlowId: "89",
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
    expect(close).toHaveBeenCalledOnce();
    expect(clientQueries[0]?.sql).toBe("BEGIN");
    expect(clientQueries.at(-1)?.sql).toBe("COMMIT");
    expect(clientQueries.some(query => query.sql === "ROLLBACK")).toBe(false);
  });
});
