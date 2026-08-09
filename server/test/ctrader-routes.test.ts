import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { hashToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import type { CTraderBrokerService } from "../src/ctrader/service.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";
import type { ScreenshotStorage } from "../src/uploads/storage.js";

const pepper = "p".repeat(48);

function config() {
  return loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: "3210",
    PUBLIC_ORIGIN: "http://localhost:3210",
    DATABASE_URL: "postgresql://localhost/unused",
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    SESSION_PEPPER: pepper,
    COOKIE_SECURE: "false",
    UPLOAD_ROOT: path.resolve("test-uploads"),
    CTRADER_CLIENT_ID: "client-id",
    CTRADER_CLIENT_SECRET: "client-secret",
    CTRADER_REDIRECT_URI: "http://localhost:3210/api/auth/ctrader/callback",
    CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 1).toString("base64url") }),
    CTRADER_ACTIVE_KEY_VERSION: "1",
  });
}

function mockService() {
  return {
    startOAuth: vi.fn(async () => ({
      authorizationUrl: "https://id.ctrader.com/my/settings/openapi/grantingaccess/?state=opaque",
      expiresAt: "2026-08-09T00:00:00.000Z",
    })),
    rejectOAuth: vi.fn(async () => undefined),
    completeOAuth: vi.fn(async () => undefined),
    pendingOAuth: vi.fn(),
    listConnections: vi.fn(async () => []),
    createConnection: vi.fn(),
    connectionStatus: vi.fn(),
    queueManualSync: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as CTraderBrokerService;
}

function dependencies(service: CTraderBrokerService, csrf = "csrf-test") {
  const database = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM sessions s")) {
        return {
          rows: [{
            session_id: "00000000-0000-4000-8000-000000000001",
            csrf_hash: hashToken(csrf, pepper),
            user_id: "00000000-0000-4000-8000-000000000002",
            legacy_firebase_uid: null,
            email: "user@example.com",
            display_name: "User",
            avatar_url: null,
          }],
          rowCount: 1,
        };
      }
      return { rows: [{ ready: 1 }], rowCount: 1 };
    }),
    connect: vi.fn(),
    end: vi.fn(async () => undefined),
  } as unknown as Database;
  const events = {
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    publish: vi.fn(),
    replay: vi.fn(async () => []),
    subscribe: vi.fn(() => () => undefined),
  } as unknown as EventBus;
  const screenshotStorage = {
    ensureRoot: vi.fn(async () => undefined),
    process: vi.fn(),
    save: vi.fn(),
    open: vi.fn(),
    remove: vi.fn(),
    assertDiskCapacity: vi.fn(),
  } as unknown as ScreenshotStorage;
  return { database, events, screenshotStorage, ctraderService: service };
}

describe("cTrader HTTP contract", () => {
  it("starts a session-bound OAuth flow only with CSRF", async () => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const response = await app.inject({
      method: "POST",
      url: "/api/ctrader/oauth/start",
      headers: {
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
      },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().authorizationUrl).toMatch(/^https:\/\/id\.ctrader\.com\//);
    expect(service.startOAuth).toHaveBeenCalledOnce();
    await app.close();
  });

  it("uses a fixed 303 callback target and never reflects code or state", async () => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const state = "s".repeat(43);
    const response = await app.inject({
      method: "GET",
      url: `/api/auth/ctrader/callback?state=${state}&code=provider-secret-code`,
      headers: { cookie: "edgebook_session=session-token" },
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("http://localhost:3210/app.html?ctrader=select");
    expect(response.headers.location).not.toContain("provider-secret-code");
    expect(response.headers.location).not.toContain(state);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(service.completeOAuth).toHaveBeenCalledOnce();
    await app.close();
  });

  it("advertises cTrader only when the complete server configuration is present", async () => {
    const app = await buildApp(config(), dependencies(mockService()));
    const response = await app.inject({ method: "GET", url: "/api/config" });
    expect(response.json().ctraderEnabled).toBe(true);
    await app.close();
  });
});
