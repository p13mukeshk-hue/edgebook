import path from "node:path";
import type { PoolClient, QueryResult } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AesGcmTokenCipher } from "../src/ctrader/crypto.js";
import { PostgresCTraderService } from "../src/ctrader/service.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";
import type { AuthContext } from "../src/types.js";

const userId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000090";
const requestId = "00000000-0000-4000-8000-000000000071";
const importId = "00000000-0000-4000-8000-000000000070";
const candidateId = "00000000-0000-4000-8000-000000000074";
const normalFloorAt = new Date("2026-08-12T03:00:00.000Z");

function result(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult;
}

const auth: AuthContext = {
  sessionId,
  csrfHash: Buffer.alloc(32),
  user: {
    id: userId,
    legacyFirebaseUid: null,
    email: "user@example.com",
    displayName: "User",
    avatarUrl: null,
  },
};

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
    CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 7).toString("base64url") }),
    CTRADER_ACTIVE_KEY_VERSION: "1",
  });
}

function historicalHarness(options: { providerMetadata?: Record<string, unknown> } = {}) {
  let stored: null | Record<string, unknown> = null;
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      queries.push({ sql, values });
      if (sql.includes("FROM ctrader_historical_imports") && sql.includes("client_request_id")) {
        return result(stored ? [stored] : []);
      }
      if (sql.startsWith("SELECT request_hash")) {
        return result(stored ? [{ request_hash: stored.request_hash }] : []);
      }
      if (sql.includes("SELECT external_account_id") && sql.includes("FROM broker_connections")) {
        return result([{
          external_account_id: "5050060",
          provider_environment: "live",
          connected: true,
          access_token_ciphertext: "encrypted",
          mapped_account_id: "00000000-0000-4000-8000-000000000099",
          legacy_mapped_account_id: "master-25k",
          provider_metadata: options.providerMetadata ?? {
            historyReadValidated: true,
            historyFloorTimestamp: normalFloorAt.getTime(),
            historyFloorKind: "connection_time_empty_attested",
            noOpenPositionsAttestation: {
              version: 1,
              userId,
              connectionId,
              accountId: "5050060",
              environment: "live",
              boundaryTimestamp: normalFloorAt.getTime(),
            },
          },
        }]);
      }
      if (sql.includes("FROM sync_runs") && sql.includes("status IN")) return result([]);
      if (sql.includes("FROM ctrader_historical_imports") && sql.includes("status IN")) return result([]);
      if (sql.includes("INSERT INTO ctrader_historical_imports")) {
        const now = new Date();
        stored = {
          id: values[0],
          broker_connection_id: values[2],
          status: "queued",
          boundary_at: values[5],
          boundary_local: values[6],
          time_zone: values[7],
          through_at: values[8],
          normal_history_floor_at_request: values[8],
          normal_history_floor_kind_at_request: values[9],
          acknowledged_at: now,
          no_open_positions_attested: true,
          client_request_id: values[10],
          request_hash: values[11],
          counters: {},
          error_code: null,
          error_message: null,
          row_version: 1,
          created_at: now,
          finished_at: null,
        };
        return result([stored]);
      }
      return result([]);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  const database = {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => result([])),
    end: vi.fn(async () => undefined),
  } as unknown as Database;
  const events = { publish: vi.fn() } as unknown as EventBus;
  const appConfig = config();
  const service = new PostgresCTraderService(
    database,
    appConfig,
    null,
    null,
    AesGcmTokenCipher.fromConfig(appConfig.cTrader),
    events,
    null,
  );
  return { service, queries };
}

function reviewHarness(options: {
  identityConflict?: boolean;
  candidateOverrides?: Record<string, unknown>;
  manualSnapshot?: Record<string, unknown>;
  candidateCount?: number;
  deletedManualRowVersion?: number | null;
} = {}) {
  const projection = {
    positionId: "9001",
    symbol: "XAUUSD",
    asset: "cm",
    direction: "Long",
    entryPrice: "2400",
    exitPrice: "2410",
    quantityLots: "0.10",
    pnl: null,
    isOpen: false,
    tradeDate: "2026-08-11",
    entryAt: "2026-08-11T04:00:00.000Z",
    exitAt: "2026-08-11T05:00:00.000Z",
    entryTime: "09:30:00",
    exitTime: "10:30:00",
    brokerData: { provider: "ctrader" },
  };
  const historicalImport = {
    id: importId,
    broker_connection_id: connectionId,
    status: "review",
    boundary_at: new Date("2026-08-10T18:30:00.000Z"),
    boundary_local: "2026-08-11T00:00",
    time_zone: "Asia/Kolkata",
    through_at: new Date("2026-08-12T06:00:00.000Z"),
    normal_history_floor_at_request: new Date("2026-08-12T06:00:00.000Z"),
    normal_history_floor_kind_at_request: "connection_time_empty_attested",
    acknowledged_at: new Date("2026-08-12T06:00:00.000Z"),
    no_open_positions_attested: true,
    client_request_id: requestId,
    counters: {},
    error_code: null,
    error_message: null,
    row_version: 2,
    created_at: new Date("2026-08-12T06:00:00.000Z"),
    finished_at: new Date("2026-08-12T06:01:00.000Z"),
  };
  const candidate = {
    id: candidateId,
    import_id: importId,
    row_version: 1,
    status: "pending",
    classification: "high_confidence",
    confidence: 95,
    reasons: ["unique_strict_manual_match"],
    differences: {},
    projected_trade: projection,
    resolution_action: null,
    resolution_client_request_id: null,
    external_position_id: "9001",
    external_trade_key: "position:9001",
    manual_trade_id: "00000000-0000-4000-8000-000000000075",
    manual_row_version: 4,
    manual_deleted_at: null,
    manual_symbol: "XAUUSD",
    manual_direction: "Long",
    manual_trade_date: new Date("2026-08-11T00:00:00.000Z"),
    manual_has_psychology: true,
    manual_has_notes: true,
    manual_has_strategy: true,
    manual_has_emotion: true,
    screenshot_count: "2",
    ...options.candidateOverrides,
  };
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes("FROM ctrader_historical_imports") && sql.includes("WHERE id=")) return result([historicalImport]);
    if (sql.includes("FROM ctrader_reconciliation_candidates rc")) {
      return result(Array.from({ length: options.candidateCount ?? 1 }, (_, index) => ({
        ...candidate,
        id: index === 0 ? candidate.id : `candidate-${index}`,
      })));
    }
    if (sql.includes("FROM ctrader_reconciliation_resolutions")) return result([]);
    if (sql.includes("UPDATE ctrader_reconciliation_candidates")) return result([{ id: candidateId }]);
    if (sql.includes("FROM trades") && sql.includes("external_trade_key=$3")) {
      return result(options.identityConflict ? [{ id: "00000000-0000-4000-8000-000000000077" }] : []);
    }
    if (sql.includes("FROM ctrader_trade_tombstones")) return result([]);
    if (sql.includes("SELECT to_jsonb(t) AS row")) {
      return result([{
        row: options.manualSnapshot ?? { broker_data: {} },
        row_version: 4,
      }]);
    }
    if (sql.includes("SELECT t.id, to_jsonb(t) AS row, t.row_version")) {
      const actualVersion = options.deletedManualRowVersion ?? 4;
      return result(actualVersion === candidate.manual_row_version ? [{
        id: candidate.manual_trade_id,
        row: options.manualSnapshot ?? { broker_data: {} },
        row_version: actualVersion,
      }] : []);
    }
    if (sql.includes("UPDATE trades SET") && sql.includes("broker_connection_id=$1")) {
      return result([{ id: candidate.manual_trade_id }]);
    }
    return result([]);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const database = {
    query,
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  } as unknown as Database;
  const events = { publish: vi.fn() } as unknown as EventBus;
  const appConfig = config();
  const service = new PostgresCTraderService(
    database,
    appConfig,
    null,
    null,
    AesGcmTokenCipher.fromConfig(appConfig.cTrader),
    events,
    null,
  );
  return { service, queries };
}

afterEach(() => vi.useRealTimers());

describe("cTrader historical preview service", () => {
  it("creates one immutable-window job and canonically replays a lost response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T06:00:00.000Z"));
    const { service, queries } = historicalHarness();
    const input = {
      auth,
      connectionId,
      boundaryLocal: "2026-08-11T00:00",
      timeZone: "Asia/Kolkata",
      boundaryAt: "2026-08-10T18:30:00.000Z",
      acknowledgeNoOpenPositionsAtBoundary: true as const,
      clientRequestId: requestId,
      idempotencyKey: requestId,
    };
    const created = await service.startHistoricalImport(input);
    const replayed = await service.startHistoricalImport(input);
    expect(created).toMatchObject({
      connectionId,
      status: "queued",
      clientRequestId: requestId,
      acknowledgeNoOpenPositionsAtBoundary: true,
      boundaryAt: "2026-08-10T18:30:00.000Z",
      throughAt: normalFloorAt.toISOString(),
      normalHistoryFloorAt: normalFloorAt.toISOString(),
      normalHistoryFloorKind: "connection_time_empty_attested",
    });
    expect(replayed).toMatchObject({ id: created.id, replayed: true });
    expect(queries.filter((query) => query.sql.includes("INSERT INTO sync_runs"))).toHaveLength(1);
    expect(queries.filter((query) => query.sql.includes("INSERT INTO ctrader_historical_imports"))).toHaveLength(1);
    expect(queries.some((query) => query.sql.includes("UPDATE broker_connections"))).toBe(false);
    expect(queries.filter((query) => query.sql.includes("pg_advisory_xact_lock"))).toHaveLength(4);
    const firstRequestLock = queries.findIndex((query) =>
      query.sql.includes("pg_advisory_xact_lock") && String(query.values[0]).startsWith("ctrader:history:"));
    const firstConnectionLock = queries.findIndex((query, index) =>
      index > firstRequestLock && query.sql.includes("pg_advisory_xact_lock") && query.values[0] === connectionId);
    const firstConnectionRead = queries.findIndex((query) =>
      query.sql.includes("SELECT external_account_id") && query.sql.includes("FROM broker_connections"));
    expect(firstRequestLock).toBeGreaterThanOrEqual(0);
    expect(firstConnectionLock).toBeGreaterThan(firstRequestLock);
    expect(firstConnectionRead).toBeGreaterThan(firstConnectionLock);
  });

  it("rejects idempotency-key reuse with a different historical boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T06:00:00.000Z"));
    const { service } = historicalHarness();
    const common = {
      auth,
      connectionId,
      timeZone: "Asia/Kolkata",
      acknowledgeNoOpenPositionsAtBoundary: true as const,
      clientRequestId: requestId,
      idempotencyKey: requestId,
    };
    await service.startHistoricalImport({
      ...common,
      boundaryLocal: "2026-08-11T00:00",
      boundaryAt: "2026-08-10T18:30:00.000Z",
    });
    await expect(service.startHistoricalImport({
      ...common,
      boundaryLocal: "2026-08-10T00:00",
      boundaryAt: "2026-08-09T18:30:00.000Z",
    })).rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("rejects a UTC instant that does not match the supplied local boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T06:00:00.000Z"));
    const { service, queries } = historicalHarness();
    await expect(service.startHistoricalImport({
      auth,
      connectionId,
      boundaryLocal: "2026-08-11T00:00",
      timeZone: "Asia/Kolkata",
      boundaryAt: "2026-08-11T00:00:00.000Z",
      acknowledgeNoOpenPositionsAtBoundary: true,
      clientRequestId: requestId,
      idempotencyKey: requestId,
    })).rejects.toMatchObject({ statusCode: 400, code: "HISTORICAL_BOUNDARY_MISMATCH" });
    expect(queries).toHaveLength(0);
  });

  it("rejects a boundary with no gap before the approved normal-sync floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T06:00:00.000Z"));
    const { service, queries } = historicalHarness();
    await expect(service.startHistoricalImport({
      auth,
      connectionId,
      boundaryLocal: "2026-08-12T08:30",
      timeZone: "Asia/Kolkata",
      boundaryAt: normalFloorAt.toISOString(),
      acknowledgeNoOpenPositionsAtBoundary: true,
      clientRequestId: requestId,
      idempotencyKey: requestId,
    })).rejects.toMatchObject({ statusCode: 409, code: "HISTORICAL_IMPORT_NO_GAP" });
    expect(queries.some((entry) => entry.sql.includes("INSERT INTO ctrader_historical_imports"))).toBe(false);
  });

  it("accepts only an account-bound empty-attested normal floor", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T06:00:00.000Z"));
    const { service, queries } = historicalHarness({
      providerMetadata: {
        historyReadValidated: true,
        historyFloorTimestamp: normalFloorAt.getTime(),
        historyFloorKind: "registration",
      },
    });
    await expect(service.startHistoricalImport({
      auth,
      connectionId,
      boundaryLocal: "2026-08-11T00:00",
      timeZone: "Asia/Kolkata",
      boundaryAt: "2026-08-10T18:30:00.000Z",
      acknowledgeNoOpenPositionsAtBoundary: true,
      clientRequestId: requestId,
      idempotencyKey: requestId,
    })).rejects.toMatchObject({ statusCode: 409, code: "CTRADER_HISTORY_FLOOR_UNAPPROVED" });
    expect(queries.some((entry) => entry.sql.includes("INSERT INTO ctrader_historical_imports"))).toBe(false);
  });

  it("allows linking a unique manual match but withholds publishing when closed provider P&L is absent", async () => {
    const { service } = reviewHarness();
    const response = await service.listReconciliationCandidates(userId, connectionId, importId);
    expect(response.candidates[0]).toMatchObject({
      classification: "high_confidence",
      allowedActions: ["link_manual", "reject"],
      manualTrade: {
        hasStrategy: true,
        hasEmotion: true,
        hasPsychology: true,
        hasNotes: true,
        screenshotCount: 2,
      },
      brokerTrade: { pnl: null },
    });
  });

  it("fails closed instead of returning an oversized reconciliation review", async () => {
    const { service, queries } = reviewHarness({ candidateCount: 501 });
    await expect(service.listReconciliationCandidates(userId, connectionId, importId))
      .rejects.toMatchObject({ statusCode: 409, code: "CTRADER_RECONCILIATION_LIMIT_EXCEEDED" });
    const candidateRead = queries.find((entry) => entry.sql.includes("FROM ctrader_reconciliation_candidates rc"));
    expect(candidateRead?.sql).toContain("LIMIT 501");
  });

  it("fails closed if a client attempts to publish a closed projection without provider P&L", async () => {
    const { service, queries } = reviewHarness();
    const decisionId = "00000000-0000-4000-8000-000000000073";
    await expect(service.resolveReconciliationCandidate({
      auth,
      connectionId,
      candidateId,
      importId,
      action: "publish_separate",
      expectedVersion: 1,
      clientRequestId: decisionId,
      idempotencyKey: decisionId,
    })).rejects.toMatchObject({ statusCode: 409, code: "RECONCILIATION_PNL_UNAVAILABLE" });
    expect(queries.some((entry) => entry.sql.includes("INSERT INTO trades"))).toBe(false);
    const requestLock = queries.findIndex((entry) =>
      entry.sql.includes("pg_advisory_xact_lock") && String(entry.values[0]).startsWith("ctrader:resolution:"));
    const connectionLock = queries.findIndex((entry, index) =>
      index > requestLock && entry.sql.includes("pg_advisory_xact_lock") && entry.values[0] === connectionId);
    const candidateLock = queries.findIndex((entry) =>
      entry.sql.includes("FROM ctrader_reconciliation_candidates rc") && entry.sql.includes("FOR UPDATE OF rc"));
    expect(requestLock).toBeGreaterThanOrEqual(0);
    expect(connectionLock).toBeGreaterThan(requestLock);
    expect(candidateLock).toBeGreaterThan(connectionLock);
  });

  it("detects a normal-sync identity owner before a reviewed link can race it", async () => {
    const { service, queries } = reviewHarness({ identityConflict: true });
    const decisionId = "00000000-0000-4000-8000-000000000073";
    await expect(service.resolveReconciliationCandidate({
      auth,
      connectionId,
      candidateId,
      importId,
      action: "link_manual",
      expectedVersion: 1,
      clientRequestId: decisionId,
      idempotencyKey: decisionId,
    })).rejects.toMatchObject({ statusCode: 409, code: "RECONCILIATION_IDENTITY_CONFLICT" });
    expect(queries.some((entry) => entry.sql.includes("INSERT INTO ctrader_trade_links"))).toBe(false);
  });

  it("refuses to suppress a deleted match whose staged manual row version is stale", async () => {
    const { service, queries } = reviewHarness({
      candidateOverrides: {
        classification: "deleted_manual",
        manual_deleted_at: new Date("2026-08-12T00:00:00.000Z"),
      },
      deletedManualRowVersion: 5,
    });
    const decisionId = "00000000-0000-4000-8000-000000000073";
    await expect(service.resolveReconciliationCandidate({
      auth,
      connectionId,
      candidateId,
      importId,
      action: "suppress_deleted",
      expectedVersion: 1,
      clientRequestId: decisionId,
      idempotencyKey: decisionId,
    })).rejects.toMatchObject({ statusCode: 409, code: "DELETED_MATCH_CHANGED" });
    const deletedMatchRead = queries.find((entry) =>
      entry.sql.includes("SELECT t.id, to_jsonb(t) AS row, t.row_version"));
    expect(deletedMatchRead?.sql).toContain("t.row_version=$3");
    expect(deletedMatchRead?.sql).toContain("t.account_id=c.mapped_account_id");
    expect(deletedMatchRead?.values).toEqual([
      "00000000-0000-4000-8000-000000000075", userId, 4, connectionId,
    ]);
    expect(queries.some((entry) => entry.sql.includes("INSERT INTO ctrader_trade_tombstones"))).toBe(false);
  });

  it("links provider facts while preserving unrelated manual broker provenance", async () => {
    const sentinel = { manualProvenance: { importBatch: "legacy-safe-sentinel" } };
    const { service, queries } = reviewHarness({ manualSnapshot: { broker_data: sentinel } });
    const decisionId = "00000000-0000-4000-8000-000000000073";
    await service.resolveReconciliationCandidate({
      auth,
      connectionId,
      candidateId,
      importId,
      action: "link_manual",
      expectedVersion: 1,
      clientRequestId: decisionId,
      idempotencyKey: decisionId,
    });
    const tradeUpdate = queries.find((entry) =>
      entry.sql.includes("UPDATE trades SET") && entry.sql.includes("broker_connection_id=$1"));
    expect(tradeUpdate?.sql).toContain("broker_data=broker_data || $17::jsonb");
    const privateSnapshot = queries.find((entry) =>
      entry.sql.includes("INSERT INTO ctrader_reconciliation_resolutions"));
    expect(String(privateSnapshot?.values[8])).toContain("legacy-safe-sentinel");
  });

  it("completes the import after the last pending candidate is non-destructively rejected", async () => {
    const { service, queries } = reviewHarness({
      candidateOverrides: {
        classification: "execution_only",
        manual_trade_id: null,
        manual_row_version: null,
        projected_trade: null,
      },
    });
    const decisionId = "00000000-0000-4000-8000-000000000073";
    await service.resolveReconciliationCandidate({
      auth,
      connectionId,
      candidateId,
      importId,
      action: "reject",
      expectedVersion: 1,
      clientRequestId: decisionId,
      idempotencyKey: decisionId,
    });
    expect(queries.some((entry) =>
      entry.sql.includes("UPDATE ctrader_historical_imports")
      && entry.sql.includes("NOT EXISTS")
      && entry.sql.includes("status='completed'"))).toBe(true);
    expect(queries.some((entry) => entry.sql.includes("INSERT INTO trades"))).toBe(false);
    expect(queries.some((entry) => entry.sql.includes("DELETE FROM trades"))).toBe(false);
  });
});
