import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";
import type { ScreenshotStorage } from "../src/uploads/storage.js";

function testConfig(nodeEnv: "test" | "production" = "test", uploadRoot = path.resolve("test-uploads")) {
  return loadConfig({
    NODE_ENV: nodeEnv,
    HOST: "127.0.0.1",
    PORT: "3210",
    PUBLIC_ORIGIN: nodeEnv === "production" ? "https://edgebook.test" : "http://localhost:3210",
    DATABASE_URL: "postgresql://localhost/unused",
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    SESSION_PEPPER: "p".repeat(48),
    COOKIE_SECURE: nodeEnv === "production" ? "true" : "false",
    UPLOAD_ROOT: uploadRoot,
  });
}

function dependencies() {
  const query = vi.fn(async () => ({ rows: [{ ready: 1 }], rowCount: 1, command: "SELECT", oid: 0, fields: [] }));
  const database = {
    query,
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
  return { database, events, screenshotStorage, query };
}

describe("public server contract", () => {
  it("exposes health and complete capability discovery", async () => {
    const app = await buildApp(testConfig(), dependencies());
    const health = await app.inject({ method: "GET", url: "/healthz" });
    const config = await app.inject({ method: "GET", url: "/api/config" });
    expect(health.statusCode).toBe(200);
    expect(config.json()).toMatchObject({ authMode: "google", dataApiReady: true });
    expect(config.headers["cache-control"]).toBe("private, no-store");
    await app.close();
  });

  it("returns a null user for a browser without a session", async () => {
    const app = await buildApp(testConfig(), dependencies());
    const response = await app.inject({ method: "GET", url: "/api/auth/session" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: null });
    expect(response.headers["cache-control"]).toBe("private, no-store");
    await app.close();
  });

  it("makes data and API error responses non-cacheable", async () => {
    const app = await buildApp(testConfig(), dependencies());
    const dataResponse = await app.inject({ method: "GET", url: "/api/trades" });
    const missingResponse = await app.inject({ method: "GET", url: "/api/not-a-route" });
    expect(dataResponse.statusCode).toBe(401);
    expect(dataResponse.headers["cache-control"]).toBe("private, no-store");
    expect(missingResponse.statusCode).toBe(404);
    expect(missingResponse.headers["cache-control"]).toBe("private, no-store");
    await app.close();
  });

  it("reports ready only when every required migration is applied", async () => {
    const uploadRoot = await mkdtemp(path.join(tmpdir(), "edgebook-ready-"));
    const deps = dependencies();
    deps.query.mockImplementation(async (sql: unknown) => ({
      rows: String(sql).includes("schema_migrations") ? [{ applied: 4 }] : [{ ready: 1 }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    const app = await buildApp(testConfig("test", uploadRoot), deps);
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200);

    deps.query.mockImplementation(async (sql: unknown) => ({
      rows: String(sql).includes("schema_migrations") ? [{ applied: 3 }] : [{ ready: 1 }],
      rowCount: 1,
      command: "SELECT",
      oid: 0,
      fields: [],
    }));
    const incomplete = await app.inject({ method: "GET", url: "/readyz" });
    expect(incomplete.statusCode).toBe(503);
    await app.close();
    await rm(uploadRoot, { recursive: true, force: true });
  });

  it("rejects unsafe cross-origin production requests before authentication", async () => {
    const app = await buildApp(testConfig("production"), dependencies());
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/google",
      headers: { origin: "https://attacker.test" },
      payload: { credential: "x".repeat(200) },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ORIGIN_INVALID");
    await app.close();
  });

  it("never logs a rejected Google credential or verifier error", async () => {
    const secretMarker = "SENTINEL_JWT_DO_NOT_LOG";
    const credential = `${secretMarker}.${"x".repeat(100)}.signature`;
    let logs = "";
    const deps = dependencies();
    const app = await buildApp(testConfig("production"), {
      ...deps,
      loggerStream: { write: (message) => { logs += message; } },
      googleVerifier: {
        verify: vi.fn(async () => {
          throw new Error(`Rejected credential ${credential}`);
        }),
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/api/auth/google",
      headers: { origin: "https://edgebook.test" },
      payload: { credential },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("GOOGLE_TOKEN_INVALID");
    expect(logs).toContain("Rejected Google credential");
    expect(logs).not.toContain(secretMarker);
    expect(logs).not.toContain(credential);
    await app.close();
  });
});
