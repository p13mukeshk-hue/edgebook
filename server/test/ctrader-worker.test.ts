import path from "node:path";
import type { PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import type { Database } from "../src/db/database.js";
import type { CTraderSyncResult } from "../src/ctrader/sync.js";
import { CTraderWorker } from "../src/ctrader/worker.js";

const connectionId = "00000000-0000-4000-8000-000000000091";
const runId = "00000000-0000-4000-8000-000000000092";

function result(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "UPDATE", oid: 0, fields: [] } as QueryResult;
}

function config() {
  return loadConfig({
    NODE_ENV: "test",
    PUBLIC_ORIGIN: "http://localhost:3210",
    DATABASE_URL: "postgresql://localhost/unused",
    GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
    SESSION_PEPPER: "p".repeat(48),
    COOKIE_SECURE: "false",
    UPLOAD_ROOT: path.resolve("test-uploads"),
    CTRADER_MCP_ENABLED: "true",
    CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 9).toString("base64url") }),
    CTRADER_ACTIVE_KEY_VERSION: "1",
  });
}

function syncResult(): CTraderSyncResult {
  return {
    userId: "00000000-0000-4000-8000-000000000002",
    connectionId,
    cursorBefore: {},
    cursorAfter: { syncedThroughTimestamp: 123 },
    counters: {
      inserted: 1,
      updated: 0,
      fetchedDeals: 1,
      insertedExecutions: 1,
      updatedExecutions: 0,
      insertedTrades: 1,
      updatedTrades: 0,
      unchangedTrades: 0,
      archivedTradesPreserved: 0,
      tombstonesPreserved: 0,
      positionsProjected: 1,
      positionsAwaitingReview: 0,
    },
  };
}

describe("CTraderWorker connection-mode dispatch", () => {
  it.each(["official", "mcp_read"] as const)("runs the %s engine only", async (mode) => {
    const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
    const database = {
      query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
        queries.push({ sql, values });
        return result();
      }),
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const lockClient = { query: vi.fn(async () => result()), release: vi.fn() } as unknown as PoolClient;
    const officialEngine = { syncConnection: vi.fn(async () => syncResult()) };
    const mcpEngine = { syncConnection: vi.fn(async () => syncResult()) };
    const worker = new CTraderWorker(database, config(), officialEngine, mcpEngine, {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    });

    await (worker as unknown as {
      executeRun(run: {
        id: string;
        broker_connection_id: string;
        attempt_count: number;
        connection_mode: "official" | "mcp_read";
      }, client: PoolClient): Promise<void>;
    }).executeRun({
      id: runId,
      broker_connection_id: connectionId,
      attempt_count: 1,
      connection_mode: mode,
    }, lockClient);

    expect(mode === "official" ? officialEngine.syncConnection : mcpEngine.syncConnection)
      .toHaveBeenCalledWith(connectionId, expect.any(Function));
    expect(mode === "official" ? mcpEngine.syncConnection : officialEngine.syncConnection).not.toHaveBeenCalled();
    const succeeded = queries.find((query) => query.sql.includes("status='succeeded'"));
    expect(succeeded?.values).toEqual([
      "{}",
      JSON.stringify({ syncedThroughTimestamp: 123 }),
      JSON.stringify(syncResult().counters),
      runId,
    ]);
  });
});
