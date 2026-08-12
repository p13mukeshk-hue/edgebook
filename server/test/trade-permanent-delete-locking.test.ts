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
const connectionId = "00000000-0000-4000-8000-000000000076";
const publicId = "manual-trade-75";

function result(rows: unknown[] = [], command = "SELECT"): QueryResult {
  return { rows, rowCount: rows.length, command, oid: 0, fields: [] } as QueryResult;
}

type Identity = {
  id: string;
  legacy_firebase_doc_id: string | null;
  row_version: number;
  deleted_at: string | null;
  source_system: string;
  trade_connection_id: string | null;
  trade_external_key: string | null;
  link_connection_id: string | null;
  link_external_key: string | null;
};

function identity(overrides: Partial<Identity> = {}): Identity {
  return {
    id: tradeId,
    legacy_firebase_doc_id: publicId,
    row_version: 4,
    deleted_at: "2026-08-12T00:00:00.000Z",
    source_system: "manual",
    trade_connection_id: null,
    trade_external_key: null,
    link_connection_id: connectionId,
    link_external_key: "position:7001",
    ...overrides,
  };
}

type HarnessOptions = {
  discovered?: Identity;
  locked?: Identity;
  storageKeys?: string[];
  tombstoneExists?: boolean;
  queuedKeys?: string[];
};

async function harness(options: HarnessOptions = {}) {
  const timeline: string[] = [];
  const discovered = options.discovered ?? identity();
  const locked = options.locked ?? discovered;
  const storageKeys = options.storageKeys ?? ["users/u/trades/t/one.webp", "users/u/trades/t/two.webp"];
  const queuedKeys = options.queuedKeys ?? storageKeys;
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      timeline.push(`tx:${sql}`);
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return result([], sql);
      if (sql.includes("FROM trades t") && !sql.includes("FOR UPDATE OF t")) {
        expect(values).toEqual([userId, publicId]);
        return result([discovered]);
      }
      if (sql.includes("pg_advisory_xact_lock")) {
        expect(values).toEqual([connectionId]);
        return result([]);
      }
      if (sql.includes("FROM trades t") && sql.includes("FOR UPDATE OF t")) {
        expect(values).toEqual([userId, tradeId]);
        return result([locked]);
      }
      if (sql.includes("SELECT storage_key FROM file_objects")) {
        return result(storageKeys.map((storage_key) => ({ storage_key })));
      }
      if (sql.includes("DELETE FROM trades")) return result([{ id: tradeId }], "DELETE");
      if (sql.includes("FROM ctrader_trade_tombstones")) {
        return result([{ exists: options.tombstoneExists ?? true }]);
      }
      if (sql.includes("DELETE FROM ctrader_live_reconciliation_candidates")) return result([], "DELETE");
      if (sql.includes("SELECT storage_key FROM file_deletion_queue")) {
        return result(queuedKeys.map((storage_key) => ({ storage_key })));
      }
      throw new Error(`Unexpected permanent-delete transaction query: ${sql}`);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  const database = {
    query: vi.fn(async (sql: string) => {
      timeline.push(`pool:${sql}`);
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
      if (sql.includes("UPDATE file_deletion_queue SET completed_at")) return result([], "UPDATE");
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
    open: vi.fn(),
    remove: vi.fn(async (storageKey: string) => {
      timeline.push(`storage:remove:${storageKey}`);
    }),
    assertDiskCapacity: vi.fn(),
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
  return { app, client, database, screenshotStorage, timeline };
}

function requestHeaders(version = 4) {
  return {
    cookie: "edgebook_session=session-token; edgebook_csrf=csrf-test",
    "x-csrf-token": "csrf-test",
    "if-match": `\"${version}\"`,
    "x-confirm-permanent-delete": publicId,
  };
}

describe("permanent trade purge serialization", () => {
  it("takes the linked cTrader connection lock before the trade lock and commits durable cleanup guards", async () => {
    const { app, screenshotStorage, timeline } = await harness();
    const response = await app.inject({
      method: "DELETE",
      url: `/api/trades/${publicId}/permanent`,
      headers: requestHeaders(),
    });
    expect(response.statusCode).toBe(204);

    const discovery = timeline.findIndex((entry) => entry.includes("FROM trades t") && !entry.includes("FOR UPDATE OF t"));
    const connectionLock = timeline.findIndex((entry) => entry.includes("pg_advisory_xact_lock"));
    const tradeLock = timeline.findIndex((entry) => entry.includes("FOR UPDATE OF t"));
    const fileLock = timeline.findIndex((entry) => entry.includes("SELECT storage_key FROM file_objects"));
    const deletion = timeline.findIndex((entry) => entry.includes("DELETE FROM trades"));
    const tombstoneGuard = timeline.findIndex((entry) => entry.includes("FROM ctrader_trade_tombstones"));
    const liveCandidateRetirement = timeline.findIndex((entry) =>
      entry.includes("DELETE FROM ctrader_live_reconciliation_candidates"));
    const deletionQueueGuard = timeline.findIndex((entry) => entry.includes("SELECT storage_key FROM file_deletion_queue"));
    const commit = timeline.findIndex((entry) => entry === "tx:COMMIT");
    const firstStorageRemoval = timeline.findIndex((entry) => entry.startsWith("storage:remove:"));
    expect(discovery).toBeGreaterThanOrEqual(0);
    expect(connectionLock).toBeGreaterThan(discovery);
    expect(tradeLock).toBeGreaterThan(connectionLock);
    expect(fileLock).toBeGreaterThan(tradeLock);
    expect(deletion).toBeGreaterThan(fileLock);
    expect(tombstoneGuard).toBeGreaterThan(deletion);
    expect(liveCandidateRetirement).toBeGreaterThan(tombstoneGuard);
    expect(deletionQueueGuard).toBeGreaterThan(liveCandidateRetirement);
    expect(commit).toBeGreaterThan(deletionQueueGuard);
    expect(firstStorageRemoval).toBeGreaterThan(commit);
    expect(screenshotStorage.remove).toHaveBeenCalledTimes(2);
    await app.close();
  });

  it("does not take a connection advisory lock for an ordinary unlinked manual trade", async () => {
    const manual = identity({ link_connection_id: null, link_external_key: null });
    const { app, timeline } = await harness({ discovered: manual, locked: manual, storageKeys: [] });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/trades/${publicId}/permanent`,
      headers: requestHeaders(),
    });
    expect(response.statusCode).toBe(204);
    expect(timeline.some((entry) => entry.includes("pg_advisory_xact_lock"))).toBe(false);
    expect(timeline.some((entry) => entry.includes("FROM ctrader_trade_tombstones"))).toBe(false);
    expect(timeline.findIndex((entry) => entry.includes("FOR UPDATE OF t")))
      .toBeLessThan(timeline.findIndex((entry) => entry.includes("DELETE FROM trades")));
    await app.close();
  });

  it("rolls back without deleting if a manual trade becomes linked during lock acquisition", async () => {
    const initiallyManual = identity({ link_connection_id: null, link_external_key: null });
    const { app, timeline } = await harness({ discovered: initiallyManual, locked: identity(), storageKeys: [] });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/trades/${publicId}/permanent`,
      headers: requestHeaders(),
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({ code: "TRADE_BROKER_IDENTITY_CHANGED" });
    expect(timeline.some((entry) => entry.includes("DELETE FROM trades"))).toBe(false);
    expect(timeline).toContain("tx:ROLLBACK");
    await app.close();
  });

  it("locks the connection first but performs no deletion for a stale row version", async () => {
    const { app, timeline } = await harness({ locked: identity({ row_version: 5 }), storageKeys: [] });
    const response = await app.inject({
      method: "DELETE",
      url: `/api/trades/${publicId}/permanent`,
      headers: requestHeaders(4),
    });
    expect(response.statusCode).toBe(409);
    const connectionLock = timeline.findIndex((entry) => entry.includes("pg_advisory_xact_lock"));
    const tradeLock = timeline.findIndex((entry) => entry.includes("FOR UPDATE OF t"));
    expect(connectionLock).toBeGreaterThanOrEqual(0);
    expect(tradeLock).toBeGreaterThan(connectionLock);
    expect(timeline.some((entry) => entry.includes("SELECT storage_key FROM file_objects"))).toBe(false);
    expect(timeline.some((entry) => entry.includes("DELETE FROM trades"))).toBe(false);
    expect(timeline).toContain("tx:ROLLBACK");
    await app.close();
  });
});
