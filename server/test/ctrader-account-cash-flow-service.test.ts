import path from "node:path";
import type { QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AesGcmTokenCipher } from "../src/ctrader/crypto.js";
import { accountCashFlowCategory, PostgresCTraderService } from "../src/ctrader/service.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";

const userId = "00000000-0000-4000-8000-000000000002";
const connectionId = "00000000-0000-4000-8000-000000000090";

function result(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult;
}

describe("cTrader account cash-flow status API", () => {
  it("returns a tenant-bound broker ledger without inventing trade attribution", async () => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    let providerMetadata: Record<string, unknown> = {
      accountCurrency: "USD",
      accountBalance: "24892.91",
      accountBalanceRawUnits: "2489291",
      accountBalanceMoneyDigits: 2,
      accountBalanceVersion: "77",
      accountBalanceAsOf: "2026-08-13T10:00:00.000Z",
      accountBalanceSource: "ProtoOATrader",
      accountBalanceScalingStatus: "exact",
      accountCashFlowHistoryComplete: true,
      accountCashFlowHistoryStartTimestamp: new Date("2026-08-01T00:00:00.000Z").getTime(),
      accountCashFlowSyncedThroughTimestamp: new Date("2026-08-13T10:00:00.000Z").getTime(),
      accountCashFlowMonetaryScaleComplete: true,
      accountCashFlowTotalRows: 1,
      accountCashFlowScaledRows: 1,
      accountCashFlowUnscaledRows: 0,
      accountCashFlowPendingScaleRetries: 0,
    };
    let latestSyncStatus: string | null = null;
    const database = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        if (sql.includes("FROM broker_connections c")) {
          return result([{
            id: connectionId,
            connected: true,
            connection_mode: "official",
            external_account_id: "5032134",
            provider_environment: "live",
            account_label: null,
            mapped_account_id: null,
            legacy_mapped_account_id: null,
            provider_metadata: providerMetadata,
            connected_at: new Date("2026-08-01T00:00:00.000Z"),
            last_sync_at: new Date("2026-08-13T10:00:00.000Z"),
            disconnected_at: null,
            disconnect_reason: null,
            token_expires_at: new Date("2026-09-01T00:00:00.000Z"),
            latest_sync_id: null,
            latest_sync_status: latestSyncStatus,
            latest_sync_counters: null,
            latest_sync_error_code: null,
            latest_sync_error_message: null,
            latest_sync_started_at: null,
            latest_sync_finished_at: null,
          }]);
        }
        if (sql.includes("FROM ctrader_account_cash_flows")) {
          return result([{
            external_cash_flow_id: "88",
            operation_type: 17,
            operation_name: "BALANCE_WITHDRAW_GSL_CHARGE",
            amount: "-12.500000000000000000",
            balance: "24987.500000000000000000",
            equity: "24990.250000000000000000",
            raw_delta: "-125",
            raw_balance: "249875",
            raw_equity: "249902",
            currency_code: "USD",
            money_digits: 2,
            money_digits_source: "cash_flow",
            balance_version: "9",
            occurred_at: new Date("2026-08-13T09:00:00.000Z"),
          }]);
        }
        return result([]);
      }),
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const config = loadConfig({
      NODE_ENV: "test",
      PUBLIC_ORIGIN: "http://localhost:3210",
      DATABASE_URL: "postgresql://localhost/unused",
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
      SESSION_PEPPER: "p".repeat(48),
      COOKIE_SECURE: "false",
      UPLOAD_ROOT: path.resolve("test-uploads"),
      CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 6).toString("base64url") }),
      CTRADER_ACTIVE_KEY_VERSION: "1",
    });
    const service = new PostgresCTraderService(
      database,
      config,
      null,
      null,
      AesGcmTokenCipher.fromConfig(config.cTrader),
      { publish: vi.fn() } as unknown as EventBus,
    );

    const status = await service.connectionStatus(userId, connectionId);
    expect(status.connection).toMatchObject({
      accountBalance: "24892.91",
      accountBalanceRawUnits: "2489291",
      accountBalanceMoneyDigits: 2,
      accountBalanceVersion: "77",
      accountBalanceSource: "ProtoOATrader",
      accountBalanceScalingStatus: "exact",
      accountCashFlowHistoryComplete: true,
      accountCashFlowHistoryStartTimestamp: new Date("2026-08-01T00:00:00.000Z").getTime(),
      accountCashFlowSyncedThroughTimestamp: new Date("2026-08-13T10:00:00.000Z").getTime(),
      accountCashFlowMonetaryScaleComplete: true,
      accountCashFlowTotalRows: 1,
      accountCashFlowScaledRows: 1,
      accountCashFlowUnscaledRows: 0,
      accountCashFlowPendingScaleRetries: 0,
    });
    expect(status).toMatchObject({
      accountCashFlowHistoryComplete: true,
      accountCashFlowHistoryStartTimestamp: new Date("2026-08-01T00:00:00.000Z").getTime(),
      accountCashFlowSyncedThroughTimestamp: new Date("2026-08-13T10:00:00.000Z").getTime(),
      accountCashFlowMonetaryScaleComplete: true,
      accountCashFlowTotalRows: 1,
      accountCashFlowScaledRows: 1,
      accountCashFlowUnscaledRows: 0,
      accountCashFlowPendingScaleRetries: 0,
    });
    expect(status.accountCashFlows).toEqual([{
      balanceHistoryId: "88",
      operationType: 17,
      operationName: "BALANCE_WITHDRAW_GSL_CHARGE",
      amount: "-12.5",
      balance: "24987.5",
      equity: "24990.25",
      rawAmountUnits: "-125",
      rawBalanceUnits: "249875",
      rawEquityUnits: "249902",
      currency: "USD",
      moneyDigits: 2,
      moneyDigitsSource: "cash_flow",
      balanceVersion: "9",
      occurredAt: "2026-08-13T09:00:00.000Z",
      category: "trading_related_adjustment",
      includedInTradePnl: false,
      positionAttribution: "not_available_from_ctrader",
      scalingStatus: "exact",
    }]);
    const ledgerQuery = queries.find(query => query.sql.includes("FROM ctrader_account_cash_flows"));
    expect(ledgerQuery?.values).toEqual([userId, connectionId]);
    expect(ledgerQuery?.sql).not.toMatch(/external_note|trade_id/i);

    const page = await service.listAccountCashFlows({ userId, connectionId, limit: 200 });
    expect(page).toMatchObject({
      accountCashFlows: [expect.objectContaining({ balanceHistoryId: "88" })],
      nextCursor: null,
    });
    const pagedQuery = queries.filter(query => query.sql.includes("FROM ctrader_account_cash_flows")).at(-1);
    expect(pagedQuery?.values).toEqual([userId, connectionId, 201]);

    // A populated/exhausted DB page does not prove that the provider history
    // seed completed. Failed/never-seeded metadata remains explicitly partial.
    providerMetadata = {};
    latestSyncStatus = "failed";
    const failedInitial = await service.connectionStatus(userId, connectionId);
    expect(failedInitial).toMatchObject({
      accountCashFlowHistoryComplete: false,
      accountCashFlowHistoryStartTimestamp: null,
      accountCashFlowSyncedThroughTimestamp: null,
      connection: {
        accountCashFlowHistoryComplete: false,
        accountCashFlowHistoryStartTimestamp: null,
        accountCashFlowSyncedThroughTimestamp: null,
        accountCashFlowMonetaryScaleComplete: false,
        accountCashFlowTotalRows: 0,
        accountCashFlowScaledRows: 0,
        accountCashFlowUnscaledRows: 0,
        accountCashFlowPendingScaleRetries: 0,
      },
    });
  });

  it("never exposes legacy account-scaled cash-flow values as exact", async () => {
    const database = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM broker_connections c")) return result([{
          id: connectionId, connected: true, connection_mode: "official",
          external_account_id: "5032134", provider_environment: "live", account_label: null,
          mapped_account_id: null, legacy_mapped_account_id: null, sync_cursor: {},
          provider_metadata: {}, connected_at: null, last_sync_at: null, disconnected_at: null,
          disconnect_reason: null, token_expires_at: null, latest_sync_id: null,
          latest_sync_status: null, latest_sync_counters: null, latest_sync_error_code: null,
          latest_sync_error_message: null, latest_sync_started_at: null, latest_sync_finished_at: null,
        }]);
        if (sql.includes("FROM ctrader_account_cash_flows")) return result([{
          external_cash_flow_id: "99", operation_type: 17,
          operation_name: "BALANCE_WITHDRAW_GSL_CHARGE", amount: "-1.25", balance: "100",
          equity: "100", raw_delta: "-125", raw_balance: "10000", raw_equity: "10000",
          currency_code: "USD", money_digits: 2, money_digits_source: "account",
          balance_version: null, occurred_at: new Date("2026-08-13T09:00:00.000Z"),
        }]);
        return result([]);
      }),
      connect: vi.fn(), end: vi.fn(async () => undefined),
    } as unknown as Database;
    const config = loadConfig({
      NODE_ENV: "test", PUBLIC_ORIGIN: "http://localhost:3210", DATABASE_URL: "postgresql://localhost/unused",
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com", SESSION_PEPPER: "p".repeat(48),
      COOKIE_SECURE: "false", UPLOAD_ROOT: path.resolve("test-uploads"),
      CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 6).toString("base64url") }),
      CTRADER_ACTIVE_KEY_VERSION: "1",
    });
    const service = new PostgresCTraderService(
      database, config, null, null, AesGcmTokenCipher.fromConfig(config.cTrader),
      { publish: vi.fn() } as unknown as EventBus,
    );
    const status = await service.connectionStatus(userId, connectionId);
    expect(status.accountCashFlows[0]).toMatchObject({
      amount: null, balance: null, equity: null, moneyDigits: null,
      moneyDigitsSource: "unavailable", scalingStatus: "money_digits_unavailable",
    });
  });

  it("categorizes known account adjustments and fails closed for future types", () => {
    expect(accountCashFlowCategory(0)).toBe("funding");
    expect(accountCashFlowCategory(17)).toBe("trading_related_adjustment");
    expect(accountCashFlowCategory(27)).toBe("non_trading_economics");
    expect(accountCashFlowCategory(39)).toBe("bonus_or_protection");
    expect(accountCashFlowCategory(2_147_483_647)).toBe("unknown");
    expect(accountCashFlowCategory(null)).toBe("unknown");
  });
});
