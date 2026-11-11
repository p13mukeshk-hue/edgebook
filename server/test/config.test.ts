import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, loadDatabaseConfig, loadStorageCleanupConfig } from "../src/config.js";

function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "http://localhost:3210",
    DATABASE_URL: "postgresql://localhost/edgebook_test",
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    SESSION_PEPPER: "x".repeat(48),
    COOKIE_SECURE: "false",
    UPLOAD_ROOT: path.resolve("test-uploads"),
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("uses the collision-free local port and parses typed values", () => {
    const config = loadConfig(environment({ DB_POOL_MAX: "17", TRUST_PROXY: "true" }));
    expect(config.port).toBe(3210);
    expect(config.dbPoolMax).toBe(17);
    expect(config.trustProxy).toBe(true);
  });

  it("rejects insecure production cookies", () => {
    expect(() => loadConfig(environment({
      NODE_ENV: "production",
      PUBLIC_ORIGIN: "https://edgebook.trade",
      COOKIE_SECURE: "false",
    }))).toThrow(/COOKIE_SECURE/);
  });

  it("rejects a short session pepper", () => {
    expect(() => loadConfig(environment({ SESSION_PEPPER: "short" }))).toThrow(/SESSION_PEPPER/);
  });

  it("rejects a cross-origin cTrader callback", () => {
    expect(() => loadConfig(environment({
      CTRADER_CLIENT_ID: "client",
      CTRADER_CLIENT_SECRET: "secret",
      CTRADER_REDIRECT_URI: "https://attacker.test/api/auth/ctrader/callback",
      CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32).toString("base64url") }),
      CTRADER_ACTIVE_KEY_VERSION: "1",
    }))).toThrow(/CTRADER_REDIRECT_URI/);
  });

  it("treats blank staged cTrader variables as disabled defaults", () => {
    const config = loadConfig(environment({
      CTRADER_CLIENT_ID: "",
      CTRADER_CLIENT_SECRET: "",
      CTRADER_REDIRECT_URI: "",
      CTRADER_ENCRYPTION_KEYS: "",
      CTRADER_ACTIVE_KEY_VERSION: "",
      CTRADER_OAUTH_STATE_TTL_SECONDS: "",
      CTRADER_GRANT_TTL_SECONDS: "",
      CTRADER_REQUEST_TIMEOUT_MS: "",
      CTRADER_SYNC_INTERVAL_SECONDS: "",
      CTRADER_STALE_AFTER_SECONDS: "",
      CTRADER_SYNC_OVERLAP_SECONDS: "",
      CTRADER_HISTORY_START_TIMESTAMP: "",
      CTRADER_REFRESH_SKEW_SECONDS: "",
      CTRADER_MAX_DEALS_PER_REQUEST: "",
      CTRADER_SYMBOL_CACHE_SECONDS: "",
      CTRADER_TRADING_TIME_ZONE: "",
      SCHEDULER_ENABLED: "",
    }));

    expect(config.cTrader).toMatchObject({
      enabled: false,
      available: false,
      mcpEnabled: false,
      storageEnabled: false,
      activeKeyVersion: null,
      oauthStateTtlSeconds: 300,
      maxDealsPerRequest: 1_000,
      tradingTimeZone: "Asia/Kolkata",
      schedulerEnabled: false,
    });
  });

  it("rejects a partially configured cTrader integration", () => {
    expect(() => loadConfig(environment({ CTRADER_CLIENT_ID: "client-only" })))
      .toThrow(/All cTrader client and redirect variables/);
  });

  it("enables MCP compatibility only with encrypted credential storage", () => {
    const config = loadConfig(environment({
      CTRADER_CLIENT_ID: "",
      CTRADER_CLIENT_SECRET: "",
      CTRADER_REDIRECT_URI: "",
      CTRADER_MCP_ENABLED: "true",
      CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32).toString("base64url") }),
      CTRADER_ACTIVE_KEY_VERSION: "1",
    }));
    expect(config.cTrader).toMatchObject({
      enabled: false,
      available: true,
      mcpEnabled: true,
      storageEnabled: true,
    });
  });

  it("rejects MCP compatibility without an encryption keyring", () => {
    expect(() => loadConfig(environment({
      CTRADER_CLIENT_ID: "",
      CTRADER_CLIENT_SECRET: "",
      CTRADER_REDIRECT_URI: "",
      CTRADER_MCP_ENABLED: "true",
    }))).toThrow(/CTRADER_MCP_ENABLED requires/);
  });

  it("loads one-shot database and cleanup tools without authentication secrets", () => {
    expect(loadDatabaseConfig({ DATABASE_URL: "postgresql://localhost/edgebook" })).toEqual({
      databaseUrl: "postgresql://localhost/edgebook",
      dbPoolMax: 10,
    });
    expect(loadStorageCleanupConfig({
      DATABASE_URL: "postgresql://localhost/edgebook",
      UPLOAD_ROOT: path.resolve("test-uploads"),
    })).toMatchObject({
      databaseUrl: "postgresql://localhost/edgebook",
      dbPoolMax: 10,
      uploadRoot: path.resolve("test-uploads"),
    });
  });
});
