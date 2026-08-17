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
    CTRADER_MCP_ENABLED: "true",
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
    connectMcp: vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000090",
      connected: true,
      mode: "mcp_read",
    })),
    pendingOAuth: vi.fn(),
    listConnections: vi.fn(async () => []),
    createConnection: vi.fn(),
    connectionStatus: vi.fn(),
    listAccountCashFlows: vi.fn(async () => ({
      accountCashFlows: [{ balanceHistoryId: "88", amount: "-12.5" }],
      nextCursor: null,
    })),
    queueManualSync: vi.fn(),
    startHistoricalImport: vi.fn(async () => ({
      id: "00000000-0000-4000-8000-000000000070",
      connectionId: "00000000-0000-4000-8000-000000000090",
      status: "queued",
      boundaryAt: "2026-08-10T18:30:00.000Z",
      boundaryLocal: "2026-08-11T00:00",
      timeZone: "Asia/Kolkata",
      throughAt: "2026-08-12T05:00:00.000Z",
      acknowledgedAt: "2026-08-12T05:00:00.000Z",
      acknowledgeNoOpenPositionsAtBoundary: true,
      clientRequestId: "00000000-0000-4000-8000-000000000071",
      counters: {},
      error: null,
      version: 1,
      createdAt: "2026-08-12T05:00:00.000Z",
      finishedAt: null,
    })),
    currentHistoricalImport: vi.fn(async () => null),
    listReconciliationCandidates: vi.fn(async () => ({ historicalImport: {}, candidates: [] })),
    resolveReconciliationCandidate: vi.fn(async () => ({ candidate: {}, historicalImport: {} })),
    listLiveReconciliationCandidates: vi.fn(async () => ({ candidates: [] })),
    getLiveReconciliationCandidate: vi.fn(async () => ({ candidate: {} })),
    resolveLiveReconciliationCandidate: vi.fn(async () => ({ candidate: {} })),
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
    expect(response.json()).toMatchObject({ ctraderOAuthEnabled: true, ctraderMcpEnabled: true });
    await app.close();
  });

  it("returns a bounded tenant-scoped account cash-flow page", async () => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const response = await app.inject({
      method: "GET",
      url: "/api/ctrader/connections/00000000-0000-4000-8000-000000000090/cash-flows?limit=500",
      headers: { cookie: "edgebook_session=session-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      accountCashFlows: [{ balanceHistoryId: "88", amount: "-12.5" }],
      nextCursor: null,
    });
    expect(service.listAccountCashFlows).toHaveBeenCalledWith({
      userId: "00000000-0000-4000-8000-000000000002",
      connectionId: "00000000-0000-4000-8000-000000000090",
      limit: 500,
    });
    await app.close();
  });

  it("connects a copied MCP configuration only after explicit trading-credential acknowledgement", async () => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const response = await app.inject({
      method: "POST",
      url: "/api/ctrader/mcp/connect",
      headers: {
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
      },
      payload: {
        configuration: JSON.stringify({
          url: "https://mcp.ctrader.com/trading/mcp",
          headers: { Authorization: `Bearer ${"x".repeat(40)}` },
        }),
        environment: "live",
        accountId: "5032134",
        label: "The5ers",
        mappedLegacyAccountId: null,
        acknowledgeTradingCredentialRisk: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().connection).toMatchObject({ connected: true, mode: "mcp_read" });
    expect(service.connectMcp).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "5032134",
      environment: "live",
      label: "The5ers",
      acknowledgeNoOpenPositionsAtConnect: false,
    }));
    expect(response.body).not.toContain("Bearer");
    await app.close();
  });

  it("rejects MCP connection payloads without literal risk acknowledgement", async () => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const response = await app.inject({
      method: "POST",
      url: "/api/ctrader/mcp/connect",
      headers: {
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
      },
      payload: {
        configuration: `Bearer ${"x".repeat(40)}`,
        environment: "live",
        accountId: "5032134",
        acknowledgeTradingCredentialRisk: false,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.connectMcp).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires an explicit live or demo environment for MCP connections", async () => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const response = await app.inject({
      method: "POST",
      url: "/api/ctrader/mcp/connect",
      headers: {
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
      },
      payload: {
        configuration: `Bearer ${"x".repeat(40)}`,
        accountId: "5032134",
        acknowledgeTradingCredentialRisk: true,
      },
    });
    expect(response.statusCode).toBe(400);
    expect(service.connectMcp).not.toHaveBeenCalled();
    await app.close();
  });

  it("starts an explicitly attested, account-scoped historical preview", async () => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const connectionId = "00000000-0000-4000-8000-000000000090";
    const clientRequestId = "00000000-0000-4000-8000-000000000071";
    const response = await app.inject({
      method: "POST",
      url: `/api/ctrader/connections/${connectionId}/historical-imports`,
      headers: {
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
        "idempotency-key": clientRequestId,
      },
      payload: {
        boundaryLocal: "2026-08-11T00:00",
        timeZone: "Asia/Kolkata",
        boundaryAt: "2026-08-10T18:30:00.000Z",
        acknowledgeNoOpenPositionsAtBoundary: true,
        clientRequestId,
      },
    });
    expect(response.statusCode).toBe(202);
    expect(service.startHistoricalImport).toHaveBeenCalledWith(expect.objectContaining({
      connectionId,
      boundaryLocal: "2026-08-11T00:00",
      timeZone: "Asia/Kolkata",
      acknowledgeNoOpenPositionsAtBoundary: true,
      clientRequestId,
    }));
    await app.close();
  });

  it.each([
    { name: "no boundary attestation", header: "00000000-0000-4000-8000-000000000071", acknowledged: false, expected: 400 },
    { name: "mismatched idempotency identity", header: "00000000-0000-4000-8000-000000000072", acknowledged: true, expected: 409 },
  ])("rejects historical preview with $name", async ({ header, acknowledged, expected }) => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const response = await app.inject({
      method: "POST",
      url: "/api/ctrader/connections/00000000-0000-4000-8000-000000000090/historical-imports",
      headers: {
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
        "idempotency-key": header,
      },
      payload: {
        boundaryLocal: "2026-08-11T00:00",
        timeZone: "Asia/Kolkata",
        boundaryAt: "2026-08-10T18:30:00.000Z",
        acknowledgeNoOpenPositionsAtBoundary: acknowledged,
        clientRequestId: "00000000-0000-4000-8000-000000000071",
      },
    });
    expect(response.statusCode).toBe(expected);
    expect(service.startHistoricalImport).not.toHaveBeenCalled();
    await app.close();
  });

  it("requires If-Match and matching idempotency identity for reconciliation decisions", async () => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const clientRequestId = "00000000-0000-4000-8000-000000000073";
    const response = await app.inject({
      method: "POST",
      url: "/api/ctrader/connections/00000000-0000-4000-8000-000000000090/reconciliation/00000000-0000-4000-8000-000000000074/resolve",
      headers: {
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
        "idempotency-key": clientRequestId,
      },
      payload: {
        action: "link_manual",
        version: 1,
        importId: "00000000-0000-4000-8000-000000000070",
        clientRequestId,
      },
    });
    expect(response.statusCode).toBe(428);
    expect(service.resolveReconciliationCandidate).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes a versioned reconciliation decision only with matching preconditions", async () => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const clientRequestId = "00000000-0000-4000-8000-000000000073";
    const response = await app.inject({
      method: "POST",
      url: "/api/ctrader/connections/00000000-0000-4000-8000-000000000090/reconciliation/00000000-0000-4000-8000-000000000074/resolve",
      headers: {
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
        "idempotency-key": clientRequestId,
        "if-match": '"3"',
      },
      payload: {
        action: "suppress_deleted",
        version: 3,
        importId: "00000000-0000-4000-8000-000000000070",
        clientRequestId,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(service.resolveReconciliationCandidate).toHaveBeenCalledWith(expect.objectContaining({
      action: "suppress_deleted",
      expectedVersion: 3,
      clientRequestId,
    }));
    await app.close();
  });

  it("reads one exact live candidate for lost-response recovery without exposing terminal history in the list", async () => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const connectionId = "00000000-0000-4000-8000-000000000090";
    const candidateId = "00000000-0000-4000-8000-000000000074";
    const response = await app.inject({
      method: "GET",
      url: `/api/ctrader/connections/${connectionId}/live-reconciliation/${candidateId}`,
      headers: { cookie: "edgebook_session=session-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(service.getLiveReconciliationCandidate).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
      connectionId,
      candidateId,
    );
    await app.close();
  });

  it("passes a live manual choice only with matching version and idempotency preconditions", async () => {
    const service = mockService();
    const app = await buildApp(config(), dependencies(service));
    const clientRequestId = "00000000-0000-4000-8000-000000000073";
    const manualTradeId = "00000000-0000-4000-8000-000000000075";
    const response = await app.inject({
      method: "POST",
      url: "/api/ctrader/connections/00000000-0000-4000-8000-000000000090/live-reconciliation/00000000-0000-4000-8000-000000000074/resolve",
      headers: {
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
        "idempotency-key": clientRequestId,
        "if-match": '"3"',
      },
      payload: { action: "link_manual", version: 3, clientRequestId, manualTradeId },
    });
    expect(response.statusCode).toBe(200);
    expect(service.resolveLiveReconciliationCandidate).toHaveBeenCalledWith(expect.objectContaining({
      action: "link_manual",
      manualTradeId,
      expectedVersion: 3,
      clientRequestId,
    }));
    await app.close();
  });
});
