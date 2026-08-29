import path from "node:path";
import type { QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AesGcmTokenCipher } from "../src/ctrader/crypto.js";
import { PostgresCTraderService } from "../src/ctrader/service.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";

const userId = "00000000-0000-4000-8000-000000000002";
const registration = new Date("2026-08-01T00:00:00.000Z").getTime();
const through = new Date("2026-08-15T10:00:00.000Z").getTime();
const lastSyncAt = new Date("2026-08-15T10:00:01.000Z");

function result(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult;
}

function connectionRow(input: {
  id: string;
  label: string;
  mode: "official" | "mcp_read";
  cursor?: unknown;
  metadata?: unknown;
  lastSync?: Date | null;
  latestStatus?: string | null;
}) {
  return {
    id: input.id,
    connected: true,
    connection_mode: input.mode,
    external_account_id: input.id.slice(-4),
    provider_environment: "live",
    account_label: input.label,
    mapped_account_id: null,
    legacy_mapped_account_id: null,
    sync_cursor: input.cursor ?? {},
    provider_metadata: input.metadata ?? {},
    connected_at: new Date("2026-08-01T00:00:00.000Z"),
    last_sync_at: input.lastSync === undefined ? lastSyncAt : input.lastSync,
    disconnected_at: null,
    disconnect_reason: null,
    token_expires_at: null,
    latest_sync_id: input.latestStatus === undefined || input.latestStatus === null
      ? null
      : `00000000-0000-4000-8000-${input.id.slice(-12)}`,
    latest_sync_status: input.latestStatus ?? null,
    latest_sync_counters: {},
    latest_sync_error_code: input.latestStatus === "failed" ? "INITIAL_SYNC_FAILED" : null,
    latest_sync_error_message: input.latestStatus === "failed" ? "Initial sync failed" : null,
    latest_sync_started_at: null,
    latest_sync_finished_at: null,
  };
}

describe("public cTrader trade-history coverage", () => {
  it("only marks registration-to-through broker history complete and fails closed otherwise", async () => {
    const rows = [
      connectionRow({
        id: "00000000-0000-4000-8000-000000000101",
        label: "official-complete",
        mode: "official",
        cursor: {
          version: 1,
          fullHistoryComplete: true,
          registrationTimestamp: registration,
          syncedThroughTimestamp: through,
        },
        metadata: { registrationTimestamp: registration },
        latestStatus: "succeeded",
      }),
      connectionRow({
        id: "00000000-0000-4000-8000-000000000102",
        label: "mcp-registration-complete",
        mode: "mcp_read",
        cursor: {
          version: 1,
          historyWindowComplete: true,
          fullHistoryComplete: true,
          historyFloorKind: "registration",
          historyStartTimestamp: registration,
          syncedThroughTimestamp: through,
        },
        metadata: {
          historyReadValidated: true,
          registrationTimestamp: registration,
          historyFloorKind: "registration",
          historyFloorTimestamp: registration,
        },
        latestStatus: "succeeded",
      }),
      connectionRow({
        id: "00000000-0000-4000-8000-000000000103",
        label: "mcp-attested-bounded",
        mode: "mcp_read",
        cursor: {
          version: 1,
          historyWindowComplete: true,
          // Even a stale or forged full flag cannot turn an attested
          // connection-time floor into registration history.
          fullHistoryComplete: true,
          historyFloorKind: "connection_time_empty_attested",
          historyStartTimestamp: registration + 1_000,
          syncedThroughTimestamp: through,
        },
        metadata: {
          historyReadValidated: true,
          registrationTimestamp: null,
          historyFloorKind: "connection_time_empty_attested",
          historyFloorTimestamp: registration + 1_000,
        },
        latestStatus: "succeeded",
      }),
      connectionRow({
        id: "00000000-0000-4000-8000-000000000104",
        label: "mcp-connection-time-bounded",
        mode: "mcp_read",
        cursor: {
          version: 1,
          historyWindowComplete: true,
          fullHistoryComplete: true,
          historyFloorKind: "connection_time",
          historyStartTimestamp: registration + 1_000,
          syncedThroughTimestamp: through,
        },
        metadata: {
          historyReadValidated: true,
          historyFloorKind: "connection_time",
          historyFloorTimestamp: registration + 1_000,
        },
        latestStatus: "succeeded",
      }),
      connectionRow({
        id: "00000000-0000-4000-8000-000000000105",
        label: "never-synced",
        mode: "official",
        cursor: {},
        metadata: { registrationTimestamp: registration },
        lastSync: null,
      }),
      connectionRow({
        id: "00000000-0000-4000-8000-000000000106",
        label: "failed-initial",
        mode: "official",
        cursor: {},
        metadata: { registrationTimestamp: registration },
        lastSync: null,
        latestStatus: "failed",
      }),
      connectionRow({
        id: "00000000-0000-4000-8000-000000000107",
        label: "malformed-cursor",
        mode: "official",
        cursor: {
          version: 1,
          fullHistoryComplete: true,
          registrationTimestamp: String(registration),
          syncedThroughTimestamp: registration - 1,
        },
        metadata: { registrationTimestamp: registration },
        latestStatus: "succeeded",
      }),
    ];
    const queries: string[] = [];
    const database = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("FROM broker_connections c")) return result(rows);
        return result([]);
      }),
      connect: vi.fn(),
      end: vi.fn(async () => undefined),
    } as unknown as Database;
    const config = loadConfig({
      NODE_ENV: "test",
      PUBLIC_ORIGIN: "http://localhost:3210",
      DATABASE_URL: "postgresql://localhost/unused",
      GOOGLE_CLIENT_ID: "test-client.apps.googleusercontent.com",
      SESSION_PEPPER: "p".repeat(48),
      COOKIE_SECURE: "false",
      UPLOAD_ROOT: path.resolve("test-uploads"),
      CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 7).toString("base64url") }),
      CTRADER_ACTIVE_KEY_VERSION: "1",
    });
    const service = new PostgresCTraderService(
      database,
      config,
      null,
      null,
      AesGcmTokenCipher.fromConfig(config.cTrader),
      { publish: vi.fn() } as unknown as EventBus,
    );

    const connections = await service.listConnections(userId);
    const byLabel = new Map(connections.map(connection => [connection.label, connection]));
    expect(byLabel.get("official-complete")).toMatchObject({
      tradeHistoryComplete: true,
      tradeHistoryStartTimestamp: registration,
      tradeHistorySyncedThroughTimestamp: through,
    });
    expect(byLabel.get("mcp-registration-complete")).toMatchObject({
      tradeHistoryComplete: true,
      tradeHistoryStartTimestamp: registration,
      tradeHistorySyncedThroughTimestamp: through,
    });
    for (const label of [
      "mcp-attested-bounded",
      "mcp-connection-time-bounded",
      "never-synced",
      "failed-initial",
      "malformed-cursor",
    ]) {
      expect(byLabel.get(label)).toMatchObject({
        tradeHistoryComplete: false,
        tradeHistoryStartTimestamp: null,
        tradeHistorySyncedThroughTimestamp: null,
      });
    }
    expect(queries[0]).toContain("c.sync_cursor");

    const status = await service.connectionStatus(userId, rows[0]!.id);
    expect(status).toMatchObject({
      tradeHistoryComplete: true,
      tradeHistoryStartTimestamp: registration,
      tradeHistorySyncedThroughTimestamp: through,
      connection: {
        tradeHistoryComplete: true,
        tradeHistoryStartTimestamp: registration,
        tradeHistorySyncedThroughTimestamp: through,
      },
    });
  });
});
