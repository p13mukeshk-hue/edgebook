import path from "node:path";
import type { PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config.js";
import { AesGcmTokenCipher } from "../src/ctrader/crypto.js";
import { PostgresCTraderService } from "../src/ctrader/service.js";
import type { Database } from "../src/db/database.js";
import type { EventBus } from "../src/events/event-bus.js";
import type { AuthContext } from "../src/types.js";

const userId = "00000000-0000-4000-8000-000000000002";
const sessionId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000090";
const candidateId = "00000000-0000-4000-8000-000000000074";
const manualTradeId = "00000000-0000-4000-8000-000000000075";
const brokerTradeId = "00000000-0000-4000-8000-000000000076";
const decisionId = "00000000-0000-4000-8000-000000000073";

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

function result(rows: unknown[] = [], rowCount = rows.length): QueryResult {
  return { rows, rowCount, command: "SELECT", oid: 0, fields: [] } as QueryResult;
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
    CTRADER_ENCRYPTION_KEYS: JSON.stringify({ 1: Buffer.alloc(32, 7).toString("base64url") }),
    CTRADER_ACTIVE_KEY_VERSION: "1",
  });
}

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
  brokerData: { provider: "ctrader", dealIds: ["100", "101"] },
};

const manualSnapshot = {
  id: manualTradeId,
  pnl: "57.25",
  strategy: "Fibonacci continuation",
  emotion: "calm",
  notes: "Waited for confirmation",
  tags: ["patient", "A+"],
  psychology: { confidence: 8, discipline: 9 },
  custom_fields: { setupGrade: "A+", executionQuality: "Good" },
  created_at: "2026-08-11T03:58:00.000Z",
  broker_data: { manualProvenance: "keep-me" },
};

type CandidateClassification = "high_confidence" | "ambiguous" | "deleted_manual" | "existing_pair";

type HarnessOptions = {
  classification?: CandidateClassification;
  candidateVersion?: number;
  manualAvailable?: boolean;
  manualDeleted?: boolean;
  brokerTrade?: boolean;
  brokerAvailable?: boolean;
  tombstoned?: boolean;
  historicalAuditDependency?: boolean;
  projection?: Record<string, unknown>;
  eventFailure?: boolean;
  connectionMode?: "official" | "mcp_read";
  exactMoneyRepairPending?: boolean;
};

function connectionRow(mode: "official" | "mcp_read" = "mcp_read") {
  return {
    id: connectionId,
    connected: true,
    connection_mode: mode,
    external_account_id: "5050060",
    provider_environment: "live",
    account_label: "25K",
    mapped_account_id: "00000000-0000-4000-8000-000000000099",
    legacy_mapped_account_id: "master-25k",
    provider_metadata: {},
    connected_at: new Date("2026-08-10T00:00:00.000Z"),
    last_sync_at: null,
    disconnected_at: null,
    disconnect_reason: null,
    token_expires_at: null,
    latest_sync_id: null,
    latest_sync_status: null,
    latest_sync_counters: null,
    latest_sync_error_code: null,
    latest_sync_error_message: null,
    latest_sync_started_at: null,
    latest_sync_finished_at: null,
  };
}

function liveHarness(options: HarnessOptions = {}) {
  const classification = options.classification ?? "high_confidence";
  const manualDeleted = options.manualDeleted ?? classification === "deleted_manual";
  const hasBrokerTrade = options.brokerTrade ?? classification === "existing_pair";
  const advertisedManual = {
    id: manualTradeId,
    version: 4,
    deleted: manualDeleted,
    symbol: "GOLD",
    direction: "Long",
    date: "2026-08-11",
    hasStrategy: true,
    hasEmotion: true,
    hasPsychology: true,
    hasNotes: true,
    hasCustomFields: true,
    screenshotCount: 2,
  };
  const candidate: Record<string, unknown> = {
    id: candidateId,
    row_version: options.candidateVersion ?? 1,
    status: "pending",
    classification,
    confidence: classification === "ambiguous" ? 60 : 95,
    reasons: [classification === "ambiguous" ? "adjacent_local_date" : "unique_strict_manual_match"],
    differences: {},
    candidate_data: {
      manualChoices: [advertisedManual],
      ...(options.exactMoneyRepairPending === true
        ? {
            exactMoneyRepairPending: true,
            exactMoneyRepairReason: "close_position_detail_money_digits_unavailable",
          }
        : {}),
    },
    projected_trade: options.projection ?? projection,
    manual_trade_id: classification === "ambiguous" ? null : manualTradeId,
    manual_row_version: classification === "ambiguous" ? null : 4,
    broker_trade_id: hasBrokerTrade ? brokerTradeId : null,
    broker_row_version: hasBrokerTrade ? 3 : null,
    external_position_id: "9001",
    external_trade_key: "position:9001",
    resolution_action: null,
    resolution_client_request_id: null,
    manual_deleted_at: manualDeleted ? new Date("2026-08-12T00:00:00.000Z") : null,
    manual_symbol: "GOLD",
    manual_direction: "Long",
    manual_trade_date: new Date("2026-08-11T00:00:00.000Z"),
    manual_has_psychology: true,
    manual_has_notes: true,
    manual_has_strategy: true,
    manual_has_emotion: true,
    manual_has_custom_fields: true,
    screenshot_count: "2",
  };
  let resolution: { request_hash: Buffer; candidate_id: string } | null = null;
  const queries: Array<{ sql: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes("SELECT request_hash, candidate_id FROM ctrader_live_reconciliation_resolutions")) {
      return result(resolution ? [resolution] : []);
    }
    if (sql.includes("FROM broker_connections c") && sql.includes("LEFT JOIN LATERAL")) {
      return result([connectionRow(options.connectionMode)]);
    }
    if (sql.includes("FROM ctrader_live_reconciliation_candidates candidate") && sql.includes("FOR UPDATE")) {
      return result([candidate]);
    }
    if (sql.includes("FROM ctrader_live_reconciliation_candidates candidate")) {
      return result([candidate]);
    }
    if (sql.includes("FROM trades manual") && sql.includes("to_jsonb(manual)")) {
      return result(options.manualAvailable === false ? [] : [{
        row: manualSnapshot,
        row_version: 4,
        deleted_at: manualDeleted ? new Date("2026-08-12T00:00:00.000Z") : null,
      }]);
    }
    if (sql.includes("FROM trades broker") && sql.includes("to_jsonb(broker)")) {
      return result(hasBrokerTrade && options.brokerAvailable !== false ? [{
        row: { id: brokerTradeId, source_system: "ctrader", pnl: "103.40" },
        row_version: 3,
      }] : []);
    }
    if (sql.includes("SELECT EXISTS") && sql.includes("ctrader_trade_tombstones")) {
      return result([{ exists: options.tombstoned === true }]);
    }
    if (sql.includes("SELECT EXISTS") && sql.includes("ctrader_reconciliation_resolutions")) {
      return result([{ exists: options.historicalAuditDependency === true }]);
    }
    if (sql.includes("SELECT id FROM trades") && sql.includes("deleted_at IS NOT NULL")) {
      return result(options.manualAvailable === false ? [] : [{ id: manualTradeId }]);
    }
    if (sql.includes("DELETE FROM trades") && sql.includes("RETURNING id")) {
      return result(hasBrokerTrade ? [{ id: brokerTradeId }] : []);
    }
    if (sql.includes("UPDATE trades SET") && sql.includes("broker_connection_id=$1")) {
      return result([{ id: manualTradeId }]);
    }
    if (sql.includes("UPDATE ctrader_live_reconciliation_candidates SET")) {
      candidate.status = values[0];
      candidate.resolution_action = values[1];
      candidate.row_version = Number(candidate.row_version) + 1;
      return result([], 1);
    }
    if (sql.includes("INSERT INTO ctrader_live_reconciliation_resolutions")) {
      resolution = { request_hash: values[5] as Buffer, candidate_id: values[3] as string };
      candidate.resolution_client_request_id = values[4];
      return result([], 1);
    }
    return result([]);
  });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const database = {
    query,
    connect: vi.fn(async () => client),
    end: vi.fn(async () => undefined),
  } as unknown as Database;
  const events = {
    publish: options.eventFailure
      ? vi.fn(async () => { throw new Error("event bus unavailable"); })
      : vi.fn(async () => undefined),
  } as unknown as EventBus;
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
  return { service, queries, events, candidate };
}

function resolutionInput(overrides: Partial<Parameters<PostgresCTraderService["resolveLiveReconciliationCandidate"]>[0]> = {}) {
  return {
    auth,
    connectionId,
    candidateId,
    action: "link_manual" as const,
    manualTradeId,
    expectedVersion: 1,
    clientRequestId: decisionId,
    idempotencyKey: decisionId,
    ...overrides,
  };
}

describe("cTrader live reconciliation service", () => {
  it("lists the staged broker projection and manual preservation indicators", async () => {
    const { service, queries } = liveHarness();

    const response = await service.listLiveReconciliationCandidates(userId, connectionId);

    expect(response.candidates).toEqual([expect.objectContaining({
      id: candidateId,
      version: 1,
      status: "pending",
      classification: "high_confidence",
      allowedActions: ["link_manual", "publish_separate"],
      manualTrade: expect.objectContaining({
        id: manualTradeId,
        hasStrategy: true,
        hasEmotion: true,
        hasPsychology: true,
        hasNotes: true,
        hasCustomFields: true,
        screenshotCount: 2,
      }),
      manualChoices: [expect.objectContaining({ id: manualTradeId, version: 4 })],
      brokerTrade: expect.objectContaining({ positionId: "9001", symbol: "XAUUSD", pnl: null }),
    })]);
    const listQuery = queries.find(({ sql }) => sql.includes("FROM ctrader_live_reconciliation_candidates candidate"));
    expect(listQuery?.sql).toContain("candidate.status='pending'");
    expect(listQuery?.sql).toContain("JOIN broker_connections connection");
  });

  it("keeps the pending review usable after more than 500 terminal lifetime decisions", async () => {
    const { service, queries } = liveHarness();

    const response = await service.listLiveReconciliationCandidates(userId, connectionId);

    expect(response.candidates).toHaveLength(1);
    const listQuery = queries.find(({ sql }) =>
      sql.includes("FROM ctrader_live_reconciliation_candidates candidate")
      && sql.includes("LIMIT 501"));
    // The database applies this predicate before the cap. Thus any number of
    // linked/published/suppressed/rejected lifetime rows cannot consume it.
    expect(listQuery?.sql).toContain("candidate.status='pending'");
    expect(listQuery?.sql).not.toContain("CASE WHEN candidate.status='pending'");
  });

  it("keeps an exact-money repair candidate pending but blocks every financial resolution", async () => {
    const { service, queries } = liveHarness({
      connectionMode: "official",
      exactMoneyRepairPending: true,
    });

    const response = await service.listLiveReconciliationCandidates(userId, connectionId);

    expect(response.candidates[0]).toMatchObject({
      status: "pending",
      allowedActions: [],
    });
    await expect(service.resolveLiveReconciliationCandidate(resolutionInput()))
      .rejects.toMatchObject({
        statusCode: 409,
        code: "CTRADER_EXACT_MONEY_REPAIR_PENDING",
      });
    expect(queries.some(({ sql }) => sql.includes("UPDATE trades SET"))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes("UPDATE ctrader_live_reconciliation_candidates SET"))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes("INSERT INTO ctrader_live_reconciliation_resolutions"))).toBe(false);
  });

  it("does not offer nondeterministic reject for a withheld official history position", async () => {
    const { service } = liveHarness({
      connectionMode: "official",
      projection: {
        ...projection,
        brokerData: {
          ...projection.brokerData,
          connectionMode: "official",
        },
      },
    });

    const response = await service.listLiveReconciliationCandidates(userId, connectionId);

    expect(response.candidates[0]?.allowedActions).toEqual(["link_manual", "publish_separate"]);
    await expect(service.resolveLiveReconciliationCandidate({
      ...resolutionInput(),
      action: "reject",
    })).rejects.toMatchObject({ code: "RECONCILIATION_ACTION_INVALID" });
  });

  it("lets an official deleted-manual match publish separately instead of forcing suppression", async () => {
    const { service } = liveHarness({
      classification: "deleted_manual",
      connectionMode: "official",
      projection: {
        ...projection,
        brokerData: { ...projection.brokerData, connectionMode: "official" },
      },
    });

    const response = await service.listLiveReconciliationCandidates(userId, connectionId);

    expect(response.candidates[0]?.allowedActions).toEqual(["suppress_deleted", "publish_separate"]);
  });

  it("links a high-confidence match without overwriting subjective fields, screenshots, or manual P&L", async () => {
    const { service, queries, events } = liveHarness();

    const response = await service.resolveLiveReconciliationCandidate(resolutionInput());

    expect(response.candidate).toMatchObject({ status: "linked", version: 2, resolutionAction: "link_manual" });
    const manualRead = queries.find((entry) => entry.sql.includes("FROM trades manual"));
    expect(manualRead?.sql).toContain("manual.broker_connection_id IS NULL");
    expect(manualRead?.sql).toContain("manual.external_trade_key IS NULL");
    expect(manualRead?.sql).toContain("manual.account_id=connection.mapped_account_id");
    expect(manualRead?.values).toEqual([manualTradeId, userId, 4, connectionId]);

    const update = queries.find((entry) =>
      entry.sql.includes("UPDATE trades SET") && entry.sql.includes("broker_connection_id=$1"));
    expect(update?.sql).toContain("exit_price=COALESCE($8,exit_price)");
    expect(update?.sql).toContain("pnl=COALESCE($10,pnl)");
    expect(update?.sql).toContain("trade_date=COALESCE(trade_date,$12::date)");
    expect(update?.sql).not.toMatch(/\b(strategy|emotion|notes|tags|psychology|custom_fields|created_at)\s*=/);
    expect(update?.values[9]).toBeNull();
    expect(JSON.parse(String(update?.values[16]))).toMatchObject({
      provider: "ctrader",
      providerTradeDate: "2026-08-11",
      pnlAuthority: "preserved_reconciled_manual",
      reconciledManualPnlPreserved: true,
    });
    expect(update?.values.slice(17)).toEqual([manualTradeId, userId, 4]);
    expect(queries.some((entry) => entry.sql.includes("UPDATE file_objects"))).toBe(false);

    const ledger = queries.find((entry) => entry.sql.includes("INSERT INTO ctrader_live_reconciliation_resolutions"));
    expect(String(ledger?.values[8])).toContain("Fibonacci continuation");
    expect(String(ledger?.values[8])).toContain("keep-me");
    expect(String(ledger?.values[10])).toContain("dealIds");
    const audit = queries.find((entry) => entry.sql.includes("ctrader.live_reconciliation_resolved"));
    expect(audit?.sql).toContain("CASE WHEN $5::text='link_manual'");
    expect(audit?.sql).toContain("'trade_date','stop_loss','take_profit'");
    expect(events.publish).toHaveBeenCalledTimes(2);
  });

  it("resolves an official exact-money candidate and makes broker net authoritative", async () => {
    const officialProjection = {
      ...projection,
      quantity: "0.1",
      quantityUnit: "lots",
      quantityLots: "0.1",
      quantityBaseUnits: "10000",
      pnl: "9",
      brokerData: {
        provider: "ctrader",
        connectionMode: "official",
        pnlMethod: "provider_close_detail_money_digits",
        pnlAuthority: "provider",
        grossProfit: "10",
        commission: "-1",
        swap: "0",
        pnlConversionFee: "0",
        quantityProjection: {
          version: 1,
          value: "0.1",
          unit: "lots",
          lots: "0.1",
          baseUnits: "10000",
          volumeScale: "unit_cents",
          source: "provider_filled_volume",
        },
      },
    };
    const { service, queries } = liveHarness({
      connectionMode: "official",
      projection: officialProjection,
    });

    await service.resolveLiveReconciliationCandidate(resolutionInput());

    const candidateLock = queries.find(({ sql }) =>
      sql.includes("FROM ctrader_live_reconciliation_candidates candidate")
      && sql.includes("FOR UPDATE"));
    expect(candidateLock?.sql).toContain("connection.connection_mode='official'");
    expect(candidateLock?.sql).toContain("connection.oauth_scope='accounts'");
    const update = queries.find(({ sql }) =>
      sql.includes("UPDATE trades SET") && sql.includes("broker_connection_id=$1"));
    expect(update?.values[9]).toBe("9");
    expect(JSON.parse(String(update?.values[16]))).toMatchObject({
      connectionMode: "official",
      pnlAuthority: "provider",
      grossProfit: "10",
      commission: "-1",
      quantityProjection: { unit: "lots", baseUnits: "10000" },
    });
  });

  it("merges an already-published broker row into the manual ID and removes only the merge tombstone", async () => {
    const { service, queries } = liveHarness({ classification: "existing_pair", brokerTrade: true });

    await service.resolveLiveReconciliationCandidate(resolutionInput());

    const fileMove = queries.find((entry) => entry.sql.includes("UPDATE file_objects SET trade_id=$1"));
    const executionDetach = queries.find((entry) => entry.sql.includes("UPDATE trade_executions SET trade_id=NULL"));
    const brokerDelete = queries.find((entry) => entry.sql.includes("DELETE FROM trades") && entry.sql.includes("RETURNING id"));
    const tombstoneCleanup = queries.find((entry) => entry.sql.includes("DELETE FROM ctrader_trade_tombstones"));
    const link = queries.find((entry) => entry.sql.includes("INSERT INTO ctrader_trade_links"));
    const executionAttach = queries.find((entry) => entry.sql.includes("UPDATE trade_executions SET trade_id=$1"));
    expect(fileMove?.values).toEqual([manualTradeId, userId, brokerTradeId]);
    expect(executionDetach?.values).toEqual([userId, connectionId, "9001", brokerTradeId]);
    expect(brokerDelete?.values).toEqual([brokerTradeId, userId, 3]);
    expect(tombstoneCleanup?.values).toEqual([userId, connectionId, "position:9001"]);
    expect(link?.values).toEqual([userId, connectionId, "9001", "position:9001", manualTradeId]);
    expect(executionAttach?.values).toEqual([manualTradeId, userId, connectionId, "9001"]);
    expect(queries.indexOf(fileMove!)).toBeLessThan(queries.indexOf(brokerDelete!));
    expect(queries.indexOf(brokerDelete!)).toBeLessThan(queries.indexOf(tombstoneCleanup!));
    expect(queries.indexOf(tombstoneCleanup!)).toBeLessThan(queries.indexOf(link!));

    const candidateUpdate = queries.find((entry) => entry.sql.includes("merged_broker_snapshot=$4::jsonb"));
    expect(String(candidateUpdate?.values[3])).toContain(brokerTradeId);
    const ledger = queries.find((entry) => entry.sql.includes("INSERT INTO ctrader_live_reconciliation_resolutions"));
    expect(String(ledger?.values[9])).toContain(brokerTradeId);
  });

  it("fails closed instead of deleting a broker row protected by historical-import audit evidence", async () => {
    const { service, queries } = liveHarness({
      classification: "existing_pair",
      brokerTrade: true,
      historicalAuditDependency: true,
    });

    await expect(service.resolveLiveReconciliationCandidate(resolutionInput()))
      .rejects.toMatchObject({ statusCode: 409, code: "RECONCILIATION_AUDIT_DEPENDENCY" });

    expect(queries.some(({ sql }) => sql.includes("DELETE FROM trades"))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes("UPDATE file_objects"))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes("INSERT INTO ctrader_live_reconciliation_resolutions"))).toBe(false);
  });

  it("revalidates an existing broker row before resolving publish-separate", async () => {
    const { service, queries } = liveHarness({
      // Defense in depth for a malformed/stale candidate that advertises a
      // publish action while already carrying a broker row.
      classification: "high_confidence",
      brokerTrade: true,
      brokerAvailable: false,
    });

    await expect(service.resolveLiveReconciliationCandidate(
      resolutionInput({ action: "publish_separate", manualTradeId: null }),
    )).rejects.toMatchObject({ statusCode: 409, code: "RECONCILIATION_IDENTITY_CONFLICT" });

    expect(queries.some(({ sql }) => sql.includes("UPDATE ctrader_live_reconciliation_candidates SET"))).toBe(false);
  });

  it("rejects every resolution action after a purge or suppression tombstone wins", async () => {
    const { service, queries } = liveHarness({ tombstoned: true });

    await expect(service.resolveLiveReconciliationCandidate(resolutionInput()))
      .rejects.toMatchObject({ statusCode: 409, code: "RECONCILIATION_IDENTITY_CONFLICT" });

    expect(queries.some(({ sql }) => sql.includes("FROM trades manual"))).toBe(false);
    expect(queries.some(({ sql }) => sql.includes("UPDATE ctrader_live_reconciliation_candidates SET"))).toBe(false);
  });

  it("rejects linking if the selected manual row no longer belongs to the mapped account", async () => {
    const { service, queries } = liveHarness({ manualAvailable: false });

    await expect(service.resolveLiveReconciliationCandidate(resolutionInput()))
      .rejects.toMatchObject({ statusCode: 409, code: "MANUAL_TRADE_CHANGED" });

    const manualRead = queries.find((entry) => entry.sql.includes("FROM trades manual"));
    expect(manualRead?.sql).toContain("manual.account_id=connection.mapped_account_id");
    expect(manualRead?.sql).toContain("manual.legacy_account_id=connection.legacy_mapped_account_id");
    expect(queries.some((entry) => entry.sql.includes("INSERT INTO ctrader_trade_links"))).toBe(false);
    expect(queries.some((entry) => entry.sql.includes("UPDATE ctrader_live_reconciliation_candidates SET"))).toBe(false);
  });

  it("rejects a stale candidate version before touching either trade", async () => {
    const { service, queries } = liveHarness({ candidateVersion: 2 });

    await expect(service.resolveLiveReconciliationCandidate(resolutionInput()))
      .rejects.toMatchObject({ statusCode: 409, code: "VERSION_CONFLICT" });

    expect(queries.some((entry) => entry.sql.includes("FROM trades manual"))).toBe(false);
    expect(queries.some((entry) => entry.sql.includes("UPDATE trades SET"))).toBe(false);
  });

  it("canonically replays one decision and rejects reuse of its idempotency key for another payload", async () => {
    const { service, queries } = liveHarness({ classification: "existing_pair", brokerTrade: true });
    const input = resolutionInput({ action: "reject", manualTradeId: null });

    const first = await service.resolveLiveReconciliationCandidate(input);
    const replay = await service.resolveLiveReconciliationCandidate(input);
    expect(replay).toEqual(first);
    expect(queries.filter((entry) => entry.sql.includes("INSERT INTO ctrader_live_reconciliation_resolutions"))).toHaveLength(1);
    expect(queries.filter((entry) => entry.sql.includes("UPDATE ctrader_live_reconciliation_candidates SET"))).toHaveLength(1);
    const ledger = queries.find((entry) => entry.sql.includes("INSERT INTO ctrader_live_reconciliation_resolutions"));
    expect(ledger?.values[7]).toBeNull();

    await expect(service.resolveLiveReconciliationCandidate({ ...input, action: "publish_separate" }))
      .rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_CONFLICT" });
  });

  it("suppresses a versioned deleted manual match with a tenant-scoped tombstone", async () => {
    const { service, queries } = liveHarness({ classification: "deleted_manual", manualDeleted: true });

    const response = await service.resolveLiveReconciliationCandidate(resolutionInput({ action: "suppress_deleted" }));

    expect(response.candidate).toMatchObject({ status: "suppressed", resolutionAction: "suppress_deleted" });
    const deletedRead = queries.find((entry) =>
      entry.sql.includes("SELECT id FROM trades") && entry.sql.includes("deleted_at IS NOT NULL"));
    expect(deletedRead?.sql).toContain("trades.account_id=connection.mapped_account_id");
    expect(deletedRead?.values).toEqual([manualTradeId, userId, 4, connectionId]);
    const tombstone = queries.find((entry) => entry.sql.includes("INSERT INTO ctrader_trade_tombstones"));
    expect(tombstone?.values).toEqual([userId, connectionId, "position:9001", "9001"]);
    expect(queries.some((entry) => entry.sql.includes("UPDATE trades SET"))).toBe(false);
  });

  it("publishes a separate provider row with account mapping and rejects without trade mutation", async () => {
    const publishHarness = liveHarness({ projection: { ...projection, pnl: "103.40" } });
    const published = await publishHarness.service.resolveLiveReconciliationCandidate(
      resolutionInput({ action: "publish_separate", manualTradeId: null }),
    );
    expect(published.candidate.status).toBe("published");
    const insert = publishHarness.queries.find((entry) => entry.sql.includes("INSERT INTO trades"));
    expect(insert?.sql).toContain("connection.mapped_account_id");
    expect(insert?.sql).toContain("connection.legacy_mapped_account_id");
    expect(insert?.values[1]).toBe(userId);
    expect(insert?.values[2]).toBe("position:9001");
    expect(insert?.values[10]).toBe("103.40");
    expect(insert?.values[18]).toBe(connectionId);

    const rejectHarness = liveHarness({ classification: "existing_pair", brokerTrade: true });
    const rejected = await rejectHarness.service.resolveLiveReconciliationCandidate(
      resolutionInput({ action: "reject", manualTradeId: null }),
    );
    expect(rejected.candidate.status).toBe("rejected");
    expect(rejectHarness.queries.some((entry) => entry.sql.includes("INSERT INTO trades"))).toBe(false);
    expect(rejectHarness.queries.some((entry) => entry.sql.includes("UPDATE trades SET"))).toBe(false);
    expect(rejectHarness.queries.some((entry) => entry.sql.includes("INSERT INTO ctrader_trade_tombstones"))).toBe(false);
    expect(rejectHarness.events.publish).toHaveBeenCalledTimes(1);
  });

  it("commits a resolution even when both best-effort event publications fail", async () => {
    const { service, queries, events } = liveHarness({
      eventFailure: true,
      projection: { ...projection, pnl: "103.40" },
    });

    const response = await service.resolveLiveReconciliationCandidate(
      resolutionInput({ action: "publish_separate", manualTradeId: null }),
    );

    expect(response.candidate.status).toBe("published");
    expect(events.publish).toHaveBeenCalledTimes(2);
    expect(queries.filter((entry) => entry.sql.includes("INSERT INTO ctrader_live_reconciliation_resolutions"))).toHaveLength(1);
    expect(queries.some((entry) => entry.sql === "COMMIT")).toBe(true);
  });
});
