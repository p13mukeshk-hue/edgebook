import path from "node:path";
import type { QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { CTraderGateway } from "../src/ctrader/client.js";
import { AesGcmTokenCipher } from "../src/ctrader/crypto.js";
import type { CTraderOAuthClient } from "../src/ctrader/oauth.js";
import { PostgresCTraderService } from "../src/ctrader/service.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";
import type { AuthContext } from "../src/types.js";

function result(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult;
}

describe("cTrader provider metadata bounds", () => {
  it("rejects a multi-megabyte broker title before writing an OAuth grant", async () => {
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
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("UPDATE oauth_transactions SET consumed_at")) {
          return result([{ id: "00000000-0000-4000-8000-000000000071" }]);
        }
        if (sql.includes("INSERT INTO ctrader_oauth_grants")) {
          throw new Error("Oversized provider metadata reached persistence");
        }
        return result([]);
      }),
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const oauth = {
      authorizationUrl: vi.fn(),
      exchangeAuthorizationCode: vi.fn(async () => ({
        accessToken: "official-access",
        refreshToken: "official-refresh",
        expiresIn: 3_600,
        tokenType: "bearer",
      })),
      refresh: vi.fn(),
    } as unknown as CTraderOAuthClient;
    const gateway = {
      discoverAccounts: vi.fn(async () => [{
        ctidTraderAccountId: "5032134",
        environment: "live" as const,
        traderLogin: "5032134",
        brokerTitleShort: "B".repeat(2 * 1024 * 1024),
        lastClosingDealTimestamp: null,
        lastBalanceUpdateTimestamp: null,
      }]),
      openAccount: vi.fn(),
    } as unknown as CTraderGateway;
    const events = { publish: vi.fn() } as unknown as EventBus;
    const service = new PostgresCTraderService(
      database,
      config,
      oauth,
      gateway,
      AesGcmTokenCipher.fromConfig(config.cTrader),
      events,
    );
    const auth: AuthContext = {
      sessionId: "00000000-0000-4000-8000-000000000001",
      csrfHash: Buffer.alloc(32),
      user: {
        id: "00000000-0000-4000-8000-000000000002",
        legacyFirebaseUid: null,
        email: "user@example.com",
        displayName: "User",
        avatarUrl: null,
      },
    };

    await expect(service.completeOAuth("valid-state-token-that-is-long-enough-for-claim", "code", auth))
      .rejects.toMatchObject({ statusCode: 502, code: "CTRADER_PROVIDER_METADATA_INVALID" });
    expect(queries.some((sql) => sql.includes("INSERT INTO ctrader_oauth_grants"))).toBe(false);
  });
});
