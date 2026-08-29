import path from "node:path";
import type { PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { grantTokenAad, AesGcmTokenCipher } from "../src/ctrader/crypto.js";
import { PostgresCTraderService } from "../src/ctrader/service.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";
import type { AuthContext } from "../src/types.js";

const userId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000001";
const grantId = "00000000-0000-4000-8000-000000000081";
const connectionId = "00000000-0000-4000-8000-000000000090";

function result(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult;
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

function harness(prior: {
  connected: boolean;
  connection_mode: "official" | "mcp_read";
  provider_metadata?: Record<string, unknown>;
  identityIds?: string[];
}) {
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
    CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 11).toString("base64url") }),
    CTRADER_ACTIVE_KEY_VERSION: "1",
  });
  const cipher = AesGcmTokenCipher.fromConfig(config.cTrader);
  const clientQueries: Array<{ sql: string; values: readonly unknown[] }> = [];
  let identityRead = 0;
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      clientQueries.push({ sql, values });
      if (sql.includes("FROM ctrader_oauth_grants")) {
        return result([{
          id: grantId,
          user_id: userId,
          session_id: sessionId,
          access_token_ciphertext: cipher.encrypt("official-access", grantTokenAad(grantId, "access")),
          refresh_token_ciphertext: cipher.encrypt("official-refresh", grantTokenAad(grantId, "refresh")),
          encryption_key_version: 1,
          token_expires_at: new Date(Date.now() + 3_600_000),
          authorized_accounts: [{
            ctidTraderAccountId: "5032134",
            environment: "live",
            traderLogin: "5032134",
            brokerTitleShort: "The5ers",
            lastClosingDealTimestamp: null,
            lastBalanceUpdateTimestamp: null,
          }],
          expires_at: new Date(Date.now() + 600_000),
          consumed_at: null,
        }]);
      }
      if (sql.includes("FROM broker_connections") && sql.includes("connection_mode")) {
        const id = prior.identityIds?.[identityRead++] ?? connectionId;
        return result([{ id, provider_environment: "live", ...prior }]);
      }
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
          connection_mode: "official",
          external_account_id: "5032134",
          provider_environment: "live",
          account_label: null,
          mapped_account_id: null,
          legacy_mapped_account_id: null,
          provider_metadata: {},
          connected_at: new Date(),
          last_sync_at: null,
          disconnected_at: null,
          disconnect_reason: null,
          token_expires_at: new Date(Date.now() + 3_600_000),
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
  const events = { publish: vi.fn(async () => ({ id: 1 })) } as unknown as EventBus;
  const service = new PostgresCTraderService(database, config, null, null, cipher, events);
  return { service, clientQueries };
}

describe("cTrader cross-mode identity", () => {
  it("atomically upgrades an active MCP connection to official OAuth in place", async () => {
    const { service, clientQueries } = harness({ connected: true, connection_mode: "mcp_read" });
    await service.createConnection({
      auth,
      grantId,
      ctidTraderAccountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    });
    const insert = clientQueries.find((query) => query.sql.includes("INSERT INTO broker_connections"));
    expect(insert?.values[0]).toBe(connectionId);
    expect(insert?.sql).toContain("connection_mode=EXCLUDED.connection_mode");
    expect(insert?.sql).toContain("sync_cursor=CASE");
    const cancelRunIndex = clientQueries.findIndex((query) => query.sql.includes("UPDATE sync_runs") && query.sql.includes("CONNECTION_MODE_UPGRADED"));
    const cancelImportIndex = clientQueries.findIndex((query) => query.sql.includes("UPDATE ctrader_historical_imports") && query.sql.includes("CONNECTION_MODE_UPGRADED"));
    const retirePendingLiveIndex = clientQueries.findIndex((query) => query.sql.includes("DELETE FROM ctrader_live_reconciliation_candidates"));
    const officialRunIndex = clientQueries.findIndex((query) => query.sql.includes("INSERT INTO sync_runs") && query.values.includes(`oauth:${grantId}`));
    expect(cancelRunIndex).toBeGreaterThan(-1);
    expect(cancelImportIndex).toBeGreaterThan(cancelRunIndex);
    expect(retirePendingLiveIndex).toBeGreaterThan(cancelImportIndex);
    expect(officialRunIndex).toBeGreaterThan(retirePendingLiveIndex);
    expect(clientQueries[cancelRunIndex]?.sql).toContain("status IN ('queued','running')");
    expect(clientQueries[cancelImportIndex]?.sql).toContain("import.broker_connection_id=$1 AND import.user_id=$2");
    expect(clientQueries[cancelImportIndex]?.sql).toContain("status IN ('queued','running','review')");
    expect(clientQueries[retirePendingLiveIndex]?.sql).toContain("status='pending'");
    expect(clientQueries.some((query) => query.sql.includes("connected=false"))).toBe(false);
    expect(clientQueries.filter((query) => query.sql.includes("resolve") || query.sql.includes("FROM broker_connections")))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ sql: expect.not.stringContaining("FOR UPDATE") }),
        expect.objectContaining({ sql: expect.stringContaining("FOR UPDATE") }),
      ]));
  });

  it("fails closed if connection identity changes between discovery and the locked upgrade", async () => {
    const changedId = "00000000-0000-4000-8000-000000000091";
    const { service, clientQueries } = harness({
      connected: true,
      connection_mode: "mcp_read",
      identityIds: [connectionId, changedId],
    });
    await expect(service.createConnection({
      auth,
      grantId,
      ctidTraderAccountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    })).rejects.toMatchObject({ statusCode: 409, code: "CTRADER_CONNECTION_CHANGED" });
    expect(clientQueries.some((query) => query.sql.includes("INSERT INTO broker_connections"))).toBe(false);
    expect(clientQueries.some((query) => query.sql.includes("SET consumed_at=now()"))).toBe(false);
  });

  it("switches a disconnected MCP connection to official in place", async () => {
    const { service, clientQueries } = harness({
      connected: false,
      connection_mode: "mcp_read",
      provider_metadata: { legacyEnvironmentWasUnbound: true },
    });
    await service.createConnection({
      auth,
      grantId,
      ctidTraderAccountId: "5032134",
      mappedLegacyAccountId: null,
      label: null,
    });
    const insert = clientQueries.find((query) => query.sql.includes("INSERT INTO broker_connections"));
    expect(insert?.values[0]).toBe(connectionId);
    expect(JSON.parse(String(insert?.values[11]))).toMatchObject({ legacyEnvironmentWasUnbound: true });
    expect(insert?.sql).toContain("connection_mode=EXCLUDED.connection_mode");
    expect(insert?.sql).toContain("sync_cursor=CASE");
    expect(insert?.sql).toContain("ON CONFLICT (user_id, provider, provider_environment, external_account_id)");
  });
});
