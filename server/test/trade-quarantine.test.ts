import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { hashToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";
import type { ScreenshotStorage } from "../src/uploads/storage.js";

const pepper = "p".repeat(48);

describe("quarantined broker projections", () => {
  it("excludes quarantined projections from the active trade API", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM sessions s")) {
          return { rows: [{
            session_id: "00000000-0000-4000-8000-000000000001",
            csrf_hash: hashToken("csrf-test", pepper),
            user_id: "00000000-0000-4000-8000-000000000002",
            legacy_firebase_uid: null,
            email: "user@example.com",
            display_name: "User",
            avatar_url: null,
          }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }),
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const events = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      publish: vi.fn(), replay: vi.fn(async () => []), subscribe: vi.fn(() => () => undefined),
    } as unknown as EventBus;
    const screenshotStorage = {
      ensureRoot: vi.fn(async () => undefined), process: vi.fn(), save: vi.fn(),
      open: vi.fn(), remove: vi.fn(), assertDiskCapacity: vi.fn(),
    } as unknown as ScreenshotStorage;
    const app = await buildApp(loadConfig({
      NODE_ENV: "test",
      PUBLIC_ORIGIN: "http://localhost:3210",
      DATABASE_URL: "postgresql://localhost/unused",
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
      SESSION_PEPPER: pepper,
      COOKIE_SECURE: "false",
      UPLOAD_ROOT: path.resolve("test-uploads"),
    }), { database, events, screenshotStorage });
    const response = await app.inject({
      method: "GET",
      url: "/api/trades",
      headers: { cookie: "edgebook_session=session-token" },
    });
    expect(response.statusCode).toBe(200);
    const activeQuery = queries.find((sql) => sql.includes("SELECT") && sql.includes("FROM trades"));
    expect(activeQuery).toContain("projectionQuarantined");
    expect(activeQuery).toContain("IS DISTINCT FROM 'true'::jsonb");
    await app.close();
  });
});
