import path from "node:path";
import type { PoolClient, QueryResult } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AesGcmTokenCipher } from "../src/ctrader/crypto.js";
import {
  PostgresCTraderService,
  type CTraderMcpConnector,
} from "../src/ctrader/service.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";
import type { AuthContext } from "../src/types.js";

const userId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000090";

afterEach(() => {
  vi.useRealTimers();
});

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
    CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 7).toString("base64url") }),
    CTRADER_ACTIVE_KEY_VERSION: "1",
  });
}

const auth: AuthContext = {
  sessionId,
  csrfHash: Buffer.alloc(32),
  user: {
    id: userId,
    legacyFirebaseUid: null,
    email: "user@example.com",
    displayName: "User",
    avatarUrl: null,
  },
};

function harness(
  balanceAccountId = "5032134",
  priorConnection: {
    id: string;
    connected: boolean;
    connection_mode: "official" | "mcp_read";
    provider_environment?: "live" | "demo" | null;
    provider_metadata?: Record<string, unknown>;
  } | Array<{
    id: string;
    connected: boolean;
    connection_mode: "official" | "mcp_read";
    provider_environment?: "live" | "demo" | null;
    provider_metadata?: Record<string, unknown>;
  }> | null = null,
  historyFloor: Date | null = null,
) {
  const clientQueries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      clientQueries.push({ sql, values });
      if (sql.includes("FROM broker_connections") && sql.includes("connection_mode")) {
        const rows = priorConnection === null ? [] : Array.isArray(priorConnection) ? priorConnection : [priorConnection];
        return result(rows.map((row) => ({ provider_environment: "live", ...row })));
      }
      if (sql.includes("max(deleted_at) AS history_floor")) return result([{
        history_floor: historyFloor,
        archived_count: historyFloor === null ? "0" : "120",
        missing_identity_count: "0",
      }]);
      if (sql.includes("UPDATE broker_connections SET provider_environment")) return result([{ id: connectionId }]);
      return result([]);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  const database = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM broker_connections c")) {
        return result([{
          id: connectionId,
          connected: true,
          connection_mode: "mcp_read",
          external_account_id: balanceAccountId,
          provider_environment: "live",
          account_label: "The5ers",
          mapped_account_id: null,
          legacy_mapped_account_id: null,
          provider_metadata: { accountCurrency: "USD" },
          connected_at: new Date("2026-08-11T00:00:00.000Z"),
          last_sync_at: null,
          disconnected_at: null,
          disconnect_reason: null,
          token_expires_at: null,
          latest_sync_id: null,
          latest_sync_status: null,
          latest_sync_counters: null,
          latest_sync_error_code: null,
          latest_sync_error_message: null,
          latest_sync_started_at: null,
          latest_sync_finished_at: null,
        }]);
      }
      return result([]);
    }),
    end: vi.fn(async () => undefined),
  } as unknown as Database;
  const events = {
    publish: vi.fn(async () => ({ id: 1, userId, type: "ctrader.connected", payload: {}, occurredAt: new Date().toISOString() })),
  } as unknown as EventBus;
  const mcp = {
    validateConfiguration: vi.fn(async () => ({
      bearerToken: "secret-session-bound-mcp-token",
      balance: { accountId: balanceAccountId, currency: "USD", environment: "live" },
      symbols: [{ id: "1", name: "XAU/USD" }],
      historyProbe: [],
      accountInfo: { createdAt: "2026-01-01T00:00:00.000Z" },
    })),
  } satisfies CTraderMcpConnector;
  const appConfig = config();
  const service = new PostgresCTraderService(
    database,
    appConfig,
    null,
    null,
    AesGcmTokenCipher.fromConfig(appConfig.cTrader),
    events,
    mcp,
  );
  return { service, database, mcp, clientQueries };
}

describe("cTrader MCP connection service", () => {
  it("validates, encrypts and queues a mode-isolated connection without returning the token", async () => {
    const { service, mcp, clientQueries } = harness();
    const copied = JSON.stringify({
      url: "https://mcp.ctrader.com/trading/mcp",
      headers: { Authorization: "Bearer secret-session-bound-mcp-token" },
    });
    const connection = await service.connectMcp({
      auth,
      configuration: copied,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: "The5ers",
    });
    expect(mcp.validateConfiguration).toHaveBeenCalledWith(copied);
    expect(connection).toMatchObject({ connected: true, mode: "mcp_read", ctidTraderAccountId: "5032134" });
    expect(JSON.stringify(connection)).not.toContain("secret-session-bound-mcp-token");
    const insert = clientQueries.find((query) => query.sql.includes("INSERT INTO broker_connections"));
    expect(insert?.values.join(" ")).not.toContain("secret-session-bound-mcp-token");
    expect(String(insert?.values[7])).toContain('"algorithm":"A256GCM"');
    expect(JSON.parse(String(insert?.values[9]))).toMatchObject({
      integrationMode: "mcp_read",
      historyReadValidated: true,
      credentialCanTrade: true,
      readOnly: true,
    });
    expect(clientQueries.some((query) => query.sql.includes("INSERT INTO sync_runs"))).toBe(true);
  });

  it("rejects an account ID that differs from the authenticated MCP account", async () => {
    const { service, database } = harness("5043464");
    await expect(service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    })).rejects.toMatchObject({ code: "CTRADER_MCP_ACCOUNT_MISMATCH", statusCode: 400 });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rejects a selected environment that contradicts authenticated MCP metadata", async () => {
    const { service, database } = harness();
    await expect(service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "demo",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    })).rejects.toMatchObject({
      code: "CTRADER_MCP_ENVIRONMENT_MISMATCH",
      statusCode: 400,
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("does not reflect provider or credential details on validation failure", async () => {
    const { service, mcp } = harness();
    mcp.validateConfiguration = vi.fn(async () => {
      throw new Error("Bearer provider-secret remote body");
    });
    await expect(service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    })).rejects.toMatchObject({
      code: "CTRADER_MCP_VALIDATION_FAILED",
      message: "cTrader could not validate this Remote MCP configuration",
    });
  });

  it.each([
    ["AUTH_REJECTED", 401, "CTRADER_MCP_AUTH_FAILED"],
    ["REMOTE_RATE_LIMITED", 429, "CTRADER_MCP_RATE_LIMITED"],
    ["REMOTE_UNAVAILABLE", 503, "CTRADER_MCP_UNAVAILABLE"],
  ] as const)("maps provider status %s without reflecting its details", async (providerCode, statusCode, code) => {
    const { service, mcp } = harness();
    mcp.validateConfiguration = vi.fn(async () => {
      throw Object.assign(new Error("private provider token response"), { code: providerCode });
    });
    await expect(service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    })).rejects.toMatchObject({ statusCode, code });
  });

  it("reports a missing trade-history tool without creating a connection", async () => {
    const { service, mcp, database } = harness();
    mcp.validateConfiguration = vi.fn(async () => {
      throw Object.assign(new Error("missing get_deals"), { code: "TOOL_UNAVAILABLE" });
    });
    await expect(service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    })).rejects.toMatchObject({
      statusCode: 422,
      code: "CTRADER_MCP_HISTORY_UNAVAILABLE",
    });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it("rejects switching a currently connected account from official OAuth", async () => {
    const { service, clientQueries } = harness("5032134", {
      id: connectionId,
      connected: true,
      connection_mode: "official",
    });
    await expect(service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "CTRADER_CONNECTION_MODE_CONFLICT",
    });
    expect(clientQueries.some((query) => query.sql.includes("INSERT INTO broker_connections"))).toBe(false);
  });

  it("switches a disconnected account in place so broker trade identity is preserved", async () => {
    const { service, clientQueries } = harness("5032134", {
      id: connectionId,
      connected: false,
      connection_mode: "official",
    });
    await service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    });
    const insert = clientQueries.find((query) => query.sql.includes("INSERT INTO broker_connections"));
    expect(insert?.values[0]).toBe(connectionId);
    expect(insert?.sql).toContain("connection_mode=EXCLUDED.connection_mode");
    expect(insert?.sql).toContain("sync_cursor=CASE");
    expect(insert?.sql).toContain("ON CONFLICT (user_id, provider, provider_environment, external_account_id)");
  });

  it("adopts one disconnected environment-less legacy connection in place", async () => {
    const { service, clientQueries } = harness("5032134", {
      id: connectionId,
      connected: false,
      connection_mode: "official",
      provider_environment: null,
    });
    await service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    });
    const adopted = clientQueries.find((query) => query.sql.includes("UPDATE broker_connections SET provider_environment"));
    expect(adopted?.values).toEqual(["live", connectionId]);
    const insert = clientQueries.find((query) => query.sql.includes("INSERT INTO broker_connections"));
    expect(insert?.values[0]).toBe(connectionId);
  });

  it("fails closed when exact and environment-less identities both exist", async () => {
    const { service } = harness("5032134", [
      { id: connectionId, connected: false, connection_mode: "mcp_read", provider_environment: "live" },
      { id: "00000000-0000-4000-8000-000000000091", connected: false, connection_mode: "official", provider_environment: null },
    ]);
    await expect(service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    })).rejects.toMatchObject({
      statusCode: 409,
      code: "CTRADER_CONNECTION_IDENTITY_CONFLICT",
    });
  });

  it("records the latest user reset as the initial MCP history floor", async () => {
    const reset = new Date("2026-08-09T15:59:26.205Z");
    const { service, clientQueries } = harness("5032134", null, reset);
    await service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    });
    const insert = clientQueries.find((query) => query.sql.includes("INSERT INTO broker_connections"));
    expect(JSON.parse(String(insert?.values[9]))).toMatchObject({
      historyFloorTimestamp: reset.getTime(),
      historyFloorKind: "user_reset",
      openingLineagePolicy: "archived_position_suppression_then_first_side_review",
    });
  });

  it("preserves an approved same-mode history floor across reconnects", async () => {
    const originalFloor = new Date("2026-08-10T08:00:00.000Z").getTime();
    const { service, mcp, clientQueries } = harness("5032134", {
      id: connectionId,
      connected: false,
      connection_mode: "mcp_read",
      provider_metadata: {
        historyFloorTimestamp: originalFloor,
        historyFloorKind: "connection_time",
      },
    });
    mcp.validateConfiguration = vi.fn(async () => ({
      bearerToken: "replacement-session-token",
      balance: { accountId: "5032134", currency: "USD", environment: "live" },
      symbols: [{ id: "1", name: "XAU/USD" }],
      historyProbe: [],
      accountInfo: {},
    }));
    await service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    });
    const insert = clientQueries.find((query) => query.sql.includes("INSERT INTO broker_connections"));
    expect(JSON.parse(String(insert?.values[9]))).toMatchObject({
      historyFloorTimestamp: originalFloor,
      historyFloorKind: "connection_time",
    });
    expect(insert?.values[10]).toBe(false);
    expect(insert?.sql).toContain("ELSE broker_connections.sync_cursor");
  });

  it("captures a connection-time floor before remote validation starts", async () => {
    vi.useFakeTimers();
    const attemptStartedAt = new Date("2026-08-11T08:00:00.000Z");
    vi.setSystemTime(attemptStartedAt);
    const { service, mcp, clientQueries } = harness();
    mcp.validateConfiguration = vi.fn(async () => {
      vi.setSystemTime(new Date("2026-08-11T08:05:00.000Z"));
      return {
        bearerToken: "replacement-session-token",
        balance: { accountId: "5032134", currency: "USD", environment: "live" },
        symbols: [{ id: "1", name: "XAU/USD" }],
        historyProbe: [],
        accountInfo: {},
      };
    });
    await service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    });
    const insert = clientQueries.find((query) => query.sql.includes("INSERT INTO broker_connections"));
    expect(JSON.parse(String(insert?.values[9]))).toMatchObject({
      historyFloorTimestamp: attemptStartedAt.getTime(),
      historyFloorKind: "connection_time",
    });
  });

  it("adopts a newly discovered earlier registration floor and resets the stale cursor", async () => {
    const originalFloor = new Date("2026-08-10T08:00:00.000Z").getTime();
    const registrationFloor = new Date("2026-01-01T00:00:00.000Z").getTime();
    const { service, clientQueries } = harness("5032134", {
      id: connectionId,
      connected: false,
      connection_mode: "mcp_read",
      provider_metadata: {
        historyFloorTimestamp: originalFloor,
        historyFloorKind: "connection_time",
      },
    });
    await service.connectMcp({
      auth,
      configuration: `Bearer ${"x".repeat(40)}`,
      environment: "live",
      accountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    });
    const insert = clientQueries.find((query) => query.sql.includes("INSERT INTO broker_connections"));
    expect(JSON.parse(String(insert?.values[9]))).toMatchObject({
      historyFloorTimestamp: registrationFloor,
      historyFloorKind: "registration",
    });
    expect(insert?.values[10]).toBe(true);
    expect(insert?.sql).toContain("OR $11::boolean");
  });
});
