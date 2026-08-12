import path from "node:path";
import type { PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { hashToken } from "../src/auth/tokens.js";
import { loadConfig } from "../src/config.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";
import type { ScreenshotStorage } from "../src/uploads/storage.js";

const pepper = "p".repeat(48);
const userId = "00000000-0000-4000-8000-000000000002";
const tradeId = "00000000-0000-4000-8000-000000000075";

function result(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult;
}

describe("suppressed cTrader/manual reconciliation restore invariant", () => {
  it("locks and refuses to restore a manual row whose broker identity is suppressed", async () => {
    const transactionQueries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        transactionQueries.push(sql);
        if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return result([]);
        if (sql.includes("SELECT id, row_version FROM trades")) {
          return result([{ id: tradeId, row_version: 4 }]);
        }
        if (sql.includes("FROM ctrader_reconciliation_candidates candidate")) {
          return result([{ blocked: true }]);
        }
        if (sql.includes("UPDATE trades SET deleted_at=NULL")) {
          throw new Error("Suppressed trade restore reached the mutation query");
        }
        return result([]);
      }),
      release: vi.fn(),
    } as unknown as PoolClient;
    const database = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM sessions s")) {
          return result([{
            session_id: "00000000-0000-4000-8000-000000000001",
            csrf_hash: hashToken("csrf-test", pepper),
            user_id: userId,
            legacy_firebase_uid: null,
            email: "user@example.com",
            display_name: "User",
            avatar_url: null,
          }]);
        }
        return result([]);
      }),
      connect: vi.fn(async () => client),
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
    }), { database, events, screenshotStorage, ctraderService: null });

    const response = await app.inject({
      method: "POST",
      url: `/api/trades/${tradeId}/restore`,
      headers: {
        cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
        "x-csrf-token": "csrf-test",
        "if-match": '"4"',
      },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "CTRADER_SUPPRESSED_TRADE_RESTORE_BLOCKED",
    });
    const targetLock = transactionQueries.findIndex((sql) =>
      sql.includes("SELECT id, row_version FROM trades") && sql.includes("FOR UPDATE"));
    const suppressionRead = transactionQueries.findIndex((sql) =>
      sql.includes("FROM ctrader_reconciliation_candidates candidate"));
    expect(targetLock).toBeGreaterThanOrEqual(0);
    expect(suppressionRead).toBeGreaterThan(targetLock);
    expect(transactionQueries.some((sql) => sql.includes("UPDATE trades SET deleted_at=NULL"))).toBe(false);
    await app.close();
  });
});
