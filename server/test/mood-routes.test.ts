import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { hashToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";
import type { ScreenshotStorage } from "../src/uploads/storage.js";

const pepper = "p".repeat(48);
const userId = "00000000-0000-4000-8000-000000000002";

describe("mood create concurrency", () => {
  it("does not overwrite a divergent existing legacy mood", async () => {
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM sessions s")) {
          return {
            rows: [{
              session_id: "00000000-0000-4000-8000-000000000001",
              csrf_hash: hashToken("csrf-test", pepper),
              user_id: userId,
              legacy_firebase_uid: null,
              email: "user@example.com",
              display_name: "User",
              avatar_url: null,
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("INSERT INTO mood_checkins")) return { rows: [], rowCount: 0 };
        if (sql.includes("FROM mood_checkins")) {
          return {
            rows: [{
              id: "00000000-0000-4000-8000-000000000003",
              legacy_id: "mood-1",
              kind: "Morning",
              emotion: "Calm",
              confidence: 8,
              notes: "newer edit from another device",
              occurred_at: null,
              local_date: "2026-08-09",
              local_time: "09:00:00",
              metadata: {},
              created_at: "2026-08-09T03:30:00.000Z",
              updated_at: "2026-08-09T04:00:00.000Z",
            }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 0 };
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
    const config = loadConfig({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "3210",
      PUBLIC_ORIGIN: "http://localhost:3210",
      DATABASE_URL: "postgresql://localhost/unused",
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
      SESSION_PEPPER: pepper,
      COOKIE_SECURE: "false",
      UPLOAD_ROOT: path.resolve("test-uploads"),
    });
    const app = await buildApp(config, { database, events, screenshotStorage, ctraderService: null });
    const response = await app.inject({
      method: "POST",
      url: "/api/moods",
      headers: {
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
      },
      payload: {
        mood: {
          id: "mood-1",
          type: "Morning",
          emotion: "Calm",
          confidence: 8,
          notes: "stale cached edit",
          date: "2026-08-09",
          time: "09:00",
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("CONFLICT");
    const insert = queries.find((sql) => sql.includes("INSERT INTO mood_checkins"));
    expect(insert).toContain("DO NOTHING");
    expect(insert).not.toContain("DO UPDATE");
    expect(events.publish).not.toHaveBeenCalled();
    await app.close();
  });
});
