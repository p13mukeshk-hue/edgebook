import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient, QueryResultRow } from "pg";
import { z } from "zod";
import { withTransaction } from "../../db/database.js";
import { decodeCursor, encodeCursor } from "../../lib/pagination.js";
import { AppError, conflict, notFound } from "../../lib/errors.js";
import { calendarDateSchema } from "../../lib/date.js";
import { normalizeTrade, tradePatchSchema, unwrapTradeBody, type NormalizedTrade } from "./schema.js";
import { publishBestEffort } from "../../events/publish.js";

export type TradeRow = {
  id: string;
  legacy_firebase_doc_id: string | null;
  account_id: string | null;
  legacy_account_id: string | null;
  broker_connection_id: string | null;
  source_system: string;
  ingestion_method: string;
  external_trade_key: string | null;
  broker_trade_id: string | null;
  symbol: string;
  asset: string | null;
  instrument: string | null;
  option_type: string | null;
  strike: string | null;
  expiry: string | null;
  exchange: string | null;
  product: string | null;
  direction: "Long" | "Short";
  entry_price: string;
  exit_price: string | null;
  quantity: string;
  pnl: string | null;
  stop_loss: string | null;
  take_profit: string | null;
  is_open: boolean | null;
  trade_date: string;
  entry_at: Date | string | null;
  exit_at: Date | string | null;
  legacy_entry_time: string | null;
  legacy_exit_time: string | null;
  strategy: string | null;
  emotion: string | null;
  notes: string | null;
  tags: string[];
  psychology: Record<string, unknown>;
  custom_fields: Record<string, unknown>;
  broker_data: Record<string, unknown>;
  legacy_document: Record<string, unknown>;
  file_screenshots: Array<Record<string, unknown>>;
  calculation_version: number;
  row_version: number;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
};

const baseTradeColumns = `
  id, legacy_firebase_doc_id, account_id, legacy_account_id, broker_connection_id,
  source_system, ingestion_method, external_trade_key, broker_trade_id,
  symbol, asset, instrument, option_type, strike, expiry, exchange, product,
  direction, entry_price, exit_price, quantity, pnl, stop_loss, take_profit,
  is_open, trade_date, entry_at, exit_at, legacy_entry_time, legacy_exit_time,
  strategy, emotion, notes, tags, psychology, custom_fields, broker_data,
  legacy_document, calculation_version, row_version, created_at, updated_at, deleted_at`;

const selectTradeColumns = `${baseTradeColumns},
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', f.id,
      'src', '/api/files/' || f.id::text,
      'name', f.original_name,
      'contentType', f.content_type,
      'byteSize', f.byte_size,
      'width', f.width,
      'height', f.height
    ) ORDER BY f.created_at ASC)
    FROM file_objects f
    WHERE f.trade_id=trades.id AND f.deleted_at IS NULL
  ), '[]'::jsonb) AS file_screenshots`;

function numberOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function toIso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

export function mapTrade(row: TradeRow): Record<string, unknown> {
  const publicId = row.legacy_firebase_doc_id ?? row.id;
  const legacyScreenshots = Array.isArray(row.legacy_document.screenshots)
    ? row.legacy_document.screenshots.filter((item) => item !== null && item !== undefined)
    : [];
  const privateFileIds = new Set(row.file_screenshots.map((item) => String(item.id ?? "")));
  const pendingLegacyScreenshots = legacyScreenshots.filter((item) => {
    const source = typeof item === "string" ? item : String((item as Record<string, unknown>)?.src ?? "");
    const explicitId = typeof item === "object" && item
      ? String((item as Record<string, unknown>).fileId ?? (item as Record<string, unknown>).id ?? "")
      : "";
    const pathId = source.match(/^\/api\/files\/([A-Za-z0-9_-]+)(?:[/?#]|$)/)?.[1] ?? "";
    return !source.startsWith("/api/files/")
      && !privateFileIds.has(explicitId)
      && !privateFileIds.has(pathId);
  });
  // Private objects are canonical, but keep only genuinely unpromoted legacy
  // references beside them so a partial browser promotion remains visible and
  // retryable. Offline promotion removes resolved refs from this canonical
  // legacy document while retaining them in the immutable raw archive.
  const screenshots = [...row.file_screenshots, ...pendingLegacyScreenshots];
  return {
    ...row.legacy_document,
    id: publicId,
    recordId: row.id,
    legacyFirebaseDocId: row.legacy_firebase_doc_id,
    accountId: row.legacy_account_id ?? row.account_id,
    internalAccountId: row.account_id,
    brokerConnectionId: row.broker_connection_id,
    source: row.source_system,
    sourceSystem: row.source_system,
    ingestionMethod: row.ingestion_method,
    externalTradeKey: row.external_trade_key,
    brokerTradeId: row.broker_trade_id,
    symbol: row.symbol,
    asset: row.asset,
    instrument: row.instrument,
    optionType: row.option_type,
    strike: numberOrNull(row.strike),
    expiry: row.expiry,
    exchange: row.exchange,
    product: row.product,
    direction: row.direction,
    entry: Number(row.entry_price),
    exit: numberOrNull(row.exit_price),
    size: Number(row.quantity),
    pnl: numberOrNull(row.pnl),
    sl: numberOrNull(row.stop_loss),
    tp: numberOrNull(row.take_profit),
    isOpen: row.is_open,
    date: row.trade_date,
    entryAt: toIso(row.entry_at),
    exitAt: toIso(row.exit_at),
    entryTime: row.legacy_entry_time?.slice(0, 5) ?? null,
    exitTime: row.legacy_exit_time?.slice(0, 5) ?? null,
    strategy: row.strategy,
    emotion: row.emotion,
    notes: row.notes,
    tags: row.tags,
    psychology: row.psychology,
    custom: row.custom_fields,
    brokerData: row.broker_data,
    screenshots,
    calculationVersion: row.calculation_version,
    version: row.row_version,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deleted: row.deleted_at !== null,
    deletedAt: toIso(row.deleted_at),
    exact: {
      entry: row.entry_price,
      exit: row.exit_price,
      size: row.quantity,
      pnl: row.pnl,
    },
  };
}

function values(userId: string, id: string, trade: NormalizedTrade): unknown[] {
  return [
    id,
    userId,
    trade.legacyId,
    trade.internalAccountId,
    trade.brokerConnectionId,
    trade.sourceSystem,
    trade.ingestionMethod,
    trade.externalTradeKey,
    trade.brokerTradeId,
    trade.symbol,
    trade.asset,
    trade.instrument,
    trade.optionType,
    trade.strike,
    trade.expiry,
    trade.exchange,
    trade.product,
    trade.direction,
    trade.entry,
    trade.exit,
    trade.size,
    trade.pnl,
    trade.sl,
    trade.tp,
    trade.isOpen,
    trade.date,
    trade.entryAt,
    trade.exitAt,
    trade.entryTime,
    trade.exitTime,
    trade.strategy,
    trade.emotion,
    trade.notes,
    JSON.stringify(trade.tags),
    JSON.stringify(trade.psychology),
    JSON.stringify(trade.custom),
    JSON.stringify(trade.brokerData),
    trade.calculationVersion,
    JSON.stringify(trade.legacyDocument),
    trade.accountId,
  ];
}

async function findTrade(app: FastifyInstance, userId: string, id: string, includeDeleted = true): Promise<TradeRow | null> {
  const result = await app.db.query<TradeRow>(
    `SELECT ${selectTradeColumns}
     FROM trades
     WHERE user_id = $1
       AND (id::text = $2 OR legacy_firebase_doc_id = $2)
       ${includeDeleted ? "" : "AND deleted_at IS NULL AND broker_data #> '{classification,projectionQuarantined}' IS DISTINCT FROM 'true'::jsonb"}
     LIMIT 1`,
    [userId, id],
  );
  return result.rows[0] ?? null;
}

type QuerySource = {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: readonly unknown[]): Promise<{ rows: R[] }>;
};

type IdempotencyRow = QueryResultRow & { request_hash: Buffer; resource_id: string };

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function tradeFingerprint(trade: NormalizedTrade): Buffer {
  return createHash("sha256").update(stableJson(trade), "utf8").digest();
}

export function parseIdempotencyKey(header: string | string[] | undefined, legacyId: string | null): string {
  const supplied = Array.isArray(header) ? header[0] : header;
  const key = supplied?.trim() || (legacyId === null ? "" : `trade:${legacyId}`);
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    throw new AppError(
      428,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Create trade with a stable id or an Idempotency-Key of 8-200 safe characters",
    );
  }
  return key;
}

async function resolveOwnedTradeReferences(
  source: QuerySource,
  userId: string,
  trade: NormalizedTrade,
): Promise<NormalizedTrade> {
  let internalAccountId = trade.internalAccountId;
  let legacyAccountId = trade.accountId;
  if (internalAccountId !== null || legacyAccountId !== null) {
    const accountResult = await source.query<{ id: string; legacy_account_id: string | null }>(
      `SELECT id, legacy_account_id FROM accounts
       WHERE user_id=$1 AND archived_at IS NULL
         AND (
           ($2::uuid IS NOT NULL AND id=$2)
           OR ($2::uuid IS NULL AND legacy_account_id=$3)
         )
       LIMIT 1`,
      [userId, internalAccountId, legacyAccountId],
    );
    const account = accountResult.rows[0];
    if (
      !account
      || (
        internalAccountId !== null
        && legacyAccountId !== null
        && (account.legacy_account_id ?? account.id) !== legacyAccountId
      )
    ) {
      throw new AppError(400, "REFERENCE_INVALID", "The selected account is unavailable");
    }
    internalAccountId = account.id;
    legacyAccountId = account.legacy_account_id ?? legacyAccountId;
  }
  if (trade.brokerConnectionId !== null) {
    const connectionResult = await source.query<{ id: string }>(
      `SELECT id FROM broker_connections
       WHERE id=$2 AND user_id=$1
       LIMIT 1`,
      [userId, trade.brokerConnectionId],
    );
    if (!connectionResult.rows[0]) {
      throw new AppError(400, "REFERENCE_INVALID", "The selected broker connection is unavailable");
    }
  }
  return { ...trade, internalAccountId, accountId: legacyAccountId };
}

async function insertTradeRow(
  client: PoolClient,
  userId: string,
  recordId: string,
  trade: NormalizedTrade,
): Promise<void> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO trades (
       id, user_id, legacy_firebase_doc_id, account_id, broker_connection_id,
       source_system, ingestion_method, external_trade_key, broker_trade_id,
       symbol, asset, instrument, option_type, strike, expiry, exchange, product,
       direction, entry_price, exit_price, quantity, pnl, stop_loss, take_profit,
       is_open, trade_date, entry_at, exit_at, legacy_entry_time, legacy_exit_time,
       strategy, emotion, notes, tags, psychology, custom_fields, broker_data,
       calculation_version, legacy_document, legacy_account_id
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,
       $21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34::jsonb,$35::jsonb,
       $36::jsonb,$37::jsonb,$38,$39::jsonb,$40
     )
     RETURNING id`,
    values(userId, recordId, trade),
  );
  if (!result.rows[0]) throw new Error("Failed to persist trade");
}

export async function createTrade(
  app: FastifyInstance,
  userId: string,
  trade: NormalizedTrade,
  idempotencyKey: string,
): Promise<{ row: TradeRow; replayed: boolean }> {
  const fingerprint = tradeFingerprint(trade);
  const created = await withTransaction(app.db, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`${userId}:trades.create:${idempotencyKey}`],
    );
    const previous = await client.query<IdempotencyRow>(
      `SELECT request_hash, resource_id FROM api_idempotency_keys
       WHERE user_id=$1 AND scope='trades.create' AND idempotency_key=$2
       FOR UPDATE`,
      [userId, idempotencyKey],
    );
    const replay = previous.rows[0];
    if (replay) {
      if (
        replay.request_hash.length !== fingerprint.length
        || !timingSafeEqual(replay.request_hash, fingerprint)
      ) {
        throw conflict("This Idempotency-Key was already used for a different trade payload");
      }
      return { recordId: replay.resource_id, replayed: true };
    }
    const ownedTrade = await resolveOwnedTradeReferences(client, userId, trade);
    const recordId = randomUUID();
    await insertTradeRow(client, userId, recordId, ownedTrade);
    await client.query(
      `INSERT INTO api_idempotency_keys (
         user_id, scope, idempotency_key, request_hash, resource_id
       ) VALUES ($1,'trades.create',$2,$3,$4)`,
      [userId, idempotencyKey, fingerprint, recordId],
    );
    return { recordId, replayed: false };
  });
  const row = await findTrade(app, userId, created.recordId);
  if (!row) {
    throw new AppError(
      409,
      "IDEMPOTENCY_RESOURCE_GONE",
      "This create request was already completed, but that trade was later permanently deleted",
    );
  }
  return { row, replayed: created.replayed };
}

export async function replaceTrade(
  app: FastifyInstance,
  userId: string,
  recordId: string,
  trade: NormalizedTrade,
  expectedVersion: number,
): Promise<TradeRow> {
  const ownedTrade = await resolveOwnedTradeReferences(app.db, userId, trade);
  const params = [...values(userId, recordId, ownedTrade), expectedVersion];
  const result = await app.db.query<{ id: string }>(
    `UPDATE trades SET
       legacy_firebase_doc_id=$3, account_id=$4, broker_connection_id=$5,
       source_system=$6, ingestion_method=$7, external_trade_key=$8, broker_trade_id=$9,
       symbol=$10, asset=$11, instrument=$12, option_type=$13, strike=$14, expiry=$15,
       exchange=$16, product=$17, direction=$18, entry_price=$19, exit_price=$20,
       quantity=$21, pnl=$22, stop_loss=$23, take_profit=$24, is_open=$25,
       trade_date=$26, entry_at=$27, exit_at=$28, legacy_entry_time=$29,
       legacy_exit_time=$30, strategy=$31, emotion=$32, notes=$33, tags=$34::jsonb,
       psychology=$35::jsonb, custom_fields=$36::jsonb, broker_data=$37::jsonb,
       calculation_version=$38, legacy_document=legacy_document || $39::jsonb,
       legacy_account_id=$40,
       row_version=row_version+1
     WHERE id=$1 AND user_id=$2 AND row_version=$41
     RETURNING id`,
    params,
  );
  const updated = result.rows[0];
  if (!updated) throw conflict("Trade changed in another session; reload and retry");
  const row = await findTrade(app, userId, updated.id);
  if (!row) throw new Error("Failed to reload updated trade");
  return row;
}

function rowAsInput(row: TradeRow): Record<string, unknown> {
  return mapTrade(row);
}

const providerOwnedTradeFields = [
  "legacyFirebaseDocId",
  "accountId",
  "internalAccountId",
  "brokerConnectionId",
  "source",
  "sourceSystem",
  "ingestionMethod",
  "externalTradeKey",
  "brokerTradeId",
  "symbol",
  "asset",
  "instrument",
  "optionType",
  "strike",
  "expiry",
  "exchange",
  "product",
  "direction",
  "entry",
  "exit",
  "size",
  "pnl",
  "isOpen",
  "date",
  "entryAt",
  "exitAt",
  "entryTime",
  "exitTime",
  "brokerData",
  "calculationVersion",
] as const;

/** cTrader projection facts are provider-owned; PATCH may edit journal annotations only. */
export function mergeTradePatch(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const merged = { ...existing, ...patch };
  if (
    (existing.sourceSystem === "ctrader" || existing.source === "ctrader")
    && typeof existing.brokerConnectionId === "string"
  ) {
    for (const field of providerOwnedTradeFields) merged[field] = existing[field];
  }
  return merged;
}

export function parseExpectedVersion(header: string | string[] | undefined, fallback?: number): number | null {
  const raw = Array.isArray(header) ? header[0] : header;
  let headerVersion: number | null = null;
  if (raw) {
    const normalized = raw.replace(/^W\//, "").replaceAll('"', "").trim();
    if (!/^\d+$/.test(normalized) || Number(normalized) < 1) {
      throw new AppError(400, "VERSION_INVALID", "If-Match must contain a positive row version");
    }
    headerVersion = Number(normalized);
  }
  if (fallback !== undefined && headerVersion !== null && fallback !== headerVersion) {
    throw new AppError(400, "VERSION_INVALID", "The body version and If-Match version disagree");
  }
  return fallback ?? headerVersion;
}

export function requireExpectedVersion(version: number | null): number {
  if (version === null) {
    throw new AppError(428, "VERSION_REQUIRED", "Reload the trade and retry with its current version");
  }
  return version;
}

export async function registerTradeRoutes(app: FastifyInstance): Promise<void> {
  const protectedRead = { preHandler: [app.authenticate] };
  const protectedWrite = { preHandler: [app.authenticate, app.requireCsrf] };

  app.get("/api/trades", protectedRead, async (request) => {
    const query = z
      .object({
        deleted: z.string().optional(),
        includeDeleted: z.string().optional(),
        source: z.string().max(64).optional(),
        accountId: z.string().min(1).max(512).optional(),
        from: calendarDateSchema.optional(),
        to: calendarDateSchema.optional(),
        cursor: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(500).default(200),
      })
      .parse(request.query);
    const auth = request.auth!;
    const predicates = ["user_id = $1"];
    const parameters: unknown[] = [auth.user.id];
    const deletedMode = query.includeDeleted === "true"
      ? "all"
      : query.deleted === "true"
        ? "deleted"
        : query.deleted === "false"
          ? "active"
          : query.deleted ?? "active";
    if (deletedMode === "active") {
      predicates.push("deleted_at IS NULL");
      predicates.push("broker_data #> '{classification,projectionQuarantined}' IS DISTINCT FROM 'true'::jsonb");
    }
    else if (deletedMode === "deleted") predicates.push("deleted_at IS NOT NULL");
    else if (deletedMode !== "all") throw conflict("deleted must be active, deleted, or all");
    if (query.source) {
      parameters.push(query.source);
      predicates.push(`source_system = $${parameters.length}`);
    }
    if (query.accountId) {
      parameters.push(query.accountId);
      predicates.push(`(legacy_account_id = $${parameters.length} OR account_id::text = $${parameters.length})`);
    }
    if (query.from) {
      parameters.push(query.from);
      predicates.push(`trade_date >= $${parameters.length}::date`);
    }
    if (query.to) {
      parameters.push(query.to);
      predicates.push(`trade_date <= $${parameters.length}::date`);
    }
    const cursor = decodeCursor(query.cursor);
    if (cursor) {
      parameters.push(cursor.at, cursor.id);
      predicates.push(`(updated_at, id) < ($${parameters.length - 1}::timestamptz, $${parameters.length}::uuid)`);
    }
    parameters.push(query.limit + 1);
    const result = await app.db.query<TradeRow>(
      `SELECT ${selectTradeColumns} FROM trades
       WHERE ${predicates.join(" AND ")}
       ORDER BY updated_at DESC, id DESC
       LIMIT $${parameters.length}`,
      parameters,
    );
    const hasMore = result.rows.length > query.limit;
    const rows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
    const last = rows.at(-1);
    return {
      trades: rows.map(mapTrade),
      nextCursor: hasMore && last ? encodeCursor({ at: toIso(last.updated_at)!, id: last.id }) : null,
    };
  });

  app.post("/api/trades", protectedWrite, async (request, reply) => {
    const auth = request.auth!;
    const trade = normalizeTrade(unwrapTradeBody(request.body));
    const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"], trade.legacyId);
    const { row, replayed } = await createTrade(app, auth.user.id, trade, idempotencyKey);
    const response = mapTrade(row);
    if (!replayed) await publishBestEffort(app, auth.user.id, "trade.upserted", response);
    return reply.code(200).send({ trade: response });
  });

  app.get<{ Params: { id: string } }>("/api/trades/:id", protectedRead, async (request) => {
    const row = await findTrade(app, request.auth!.user.id, request.params.id);
    if (!row) throw notFound("Trade");
    return { trade: mapTrade(row) };
  });

  app.patch<{ Params: { id: string } }>("/api/trades/:id", protectedWrite, async (request) => {
    const auth = request.auth!;
    const patchBody = unwrapTradeBody(request.body);
    const patch = tradePatchSchema.parse(patchBody);
    const expectedVersion = requireExpectedVersion(parseExpectedVersion(request.headers["if-match"], patch.version));
    const existing = await findTrade(app, auth.user.id, request.params.id);
    if (!existing) throw notFound("Trade");
    const merged = {
      ...mergeTradePatch(rowAsInput(existing), patch),
      id: existing.legacy_firebase_doc_id ?? undefined,
    };
    const normalized = normalizeTrade(merged);
    const row = await replaceTrade(app, auth.user.id, existing.id, normalized, expectedVersion);
    const response = mapTrade(row);
    await publishBestEffort(app, auth.user.id, "trade.updated", response);
    return { trade: response };
  });

  app.delete<{ Params: { id: string } }>("/api/trades/:id", protectedWrite, async (request) => {
    const auth = request.auth!;
    const expectedVersion = requireExpectedVersion(parseExpectedVersion(request.headers["if-match"]));
    const result = await app.db.query<{ id: string }>(
      `UPDATE trades SET deleted_at=COALESCE(deleted_at, now()), row_version=row_version+1
       WHERE user_id=$1 AND (id::text=$2 OR legacy_firebase_doc_id=$2)
         AND row_version=$3
       RETURNING id`,
      [auth.user.id, request.params.id, expectedVersion],
    );
    const updated = result.rows[0];
    if (!updated) {
      const exists = await findTrade(app, auth.user.id, request.params.id);
      if (exists) throw conflict("Trade changed in another session; reload and retry");
      throw notFound("Trade");
    }
    const row = await findTrade(app, auth.user.id, updated.id);
    if (!row) throw new Error("Failed to reload archived trade");
    const response = mapTrade(row);
    await publishBestEffort(app, auth.user.id, "trade.deleted", response);
    return { trade: response };
  });

  app.post<{ Params: { id: string } }>("/api/trades/:id/restore", protectedWrite, async (request) => {
    const auth = request.auth!;
    const expectedVersion = requireExpectedVersion(parseExpectedVersion(request.headers["if-match"]));
    const restoredId = await withTransaction(app.db, async (client) => {
      const target = await client.query<{ id: string; row_version: number }>(
        `SELECT id, row_version FROM trades
         WHERE user_id=$1 AND (id::text=$2 OR legacy_firebase_doc_id=$2)
         FOR UPDATE`,
        [auth.user.id, request.params.id],
      );
      const trade = target.rows[0];
      if (!trade) throw notFound("Trade");
      if (trade.row_version !== expectedVersion) {
        throw conflict("Trade changed in another session; reload and retry");
      }
      const suppressed = await client.query<{ blocked: boolean }>(
        `SELECT true AS blocked
         FROM ctrader_reconciliation_candidates candidate
         JOIN ctrader_reconciliation_resolutions resolution
           ON resolution.user_id=candidate.user_id
          AND resolution.broker_connection_id=candidate.broker_connection_id
          AND resolution.import_id=candidate.import_id
          AND resolution.candidate_id=candidate.id
         WHERE candidate.user_id=$1 AND candidate.manual_trade_id=$2
           AND candidate.status='suppressed'
           AND candidate.resolution_action='suppress_deleted'
           AND resolution.action='suppress_deleted'
         LIMIT 1`,
        [auth.user.id, trade.id],
      );
      if (suppressed.rows[0]?.blocked) {
        throw new AppError(
          409,
          "CTRADER_SUPPRESSED_TRADE_RESTORE_BLOCKED",
          "This trade suppresses a matched cTrader position and cannot be restored without a reviewed suppression reversal",
        );
      }
      const result = await client.query<{ id: string }>(
        `UPDATE trades SET deleted_at=NULL, row_version=row_version+1
         WHERE id=$1 AND user_id=$2 AND row_version=$3
         RETURNING id`,
        [trade.id, auth.user.id, expectedVersion],
      );
      if (!result.rows[0]) throw conflict("Trade changed in another session; reload and retry");
      return result.rows[0].id;
    });
    const row = await findTrade(app, auth.user.id, restoredId);
    if (!row) throw new Error("Failed to reload restored trade");
    const response = mapTrade(row);
    await publishBestEffort(app, auth.user.id, "trade.restored", response);
    return { trade: response };
  });

  app.delete<{ Params: { id: string } }>("/api/trades/:id/permanent", protectedWrite, async (request, reply) => {
    const auth = request.auth!;
    const expectedVersion = requireExpectedVersion(parseExpectedVersion(request.headers["if-match"]));
    const confirmation = request.headers["x-confirm-permanent-delete"];
    const confirmationValue = Array.isArray(confirmation) ? confirmation[0] : confirmation;
    type PurgeIdentity = QueryResultRow & {
      id: string;
      legacy_firebase_doc_id: string | null;
      row_version: number;
      deleted_at: Date | string | null;
      source_system: string;
      trade_connection_id: string | null;
      trade_external_key: string | null;
      link_connection_id: string | null;
      link_external_key: string | null;
    };
    const purged = await withTransaction(app.db, async (client) => {
      // Resolve the provider lock without first taking a row lock. cTrader sync,
      // reconciliation, and purge all serialize on this exact connection key.
      const discovered = await client.query<PurgeIdentity>(
        `SELECT t.id, t.legacy_firebase_doc_id, t.row_version, t.deleted_at,
                t.source_system,
                t.broker_connection_id AS trade_connection_id,
                t.external_trade_key AS trade_external_key,
                link.broker_connection_id AS link_connection_id,
                link.external_trade_key AS link_external_key
         FROM trades t
         LEFT JOIN ctrader_trade_links link
           ON link.user_id=t.user_id AND link.trade_id=t.id
         WHERE t.user_id=$1
           AND (t.id::text=$2 OR t.legacy_firebase_doc_id=$2)
         LIMIT 1`,
        [auth.user.id, request.params.id],
      );
      const initial = discovered.rows[0];
      if (!initial) throw notFound("Trade");
      if (
        initial.trade_connection_id !== null
        && initial.link_connection_id !== null
        && initial.trade_connection_id !== initial.link_connection_id
      ) {
        throw new AppError(409, "TRADE_BROKER_IDENTITY_CONFLICT", "Trade broker identity changed; reload and retry");
      }
      const connectionId = initial.trade_connection_id ?? initial.link_connection_id;
      if (connectionId !== null) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [connectionId]);
      }

      // Lock and re-read only after the provider lock. If this initially looked
      // manual but reconciliation linked it in between, abort rather than purge
      // without serializing on the newly bound connection.
      const locked = await client.query<PurgeIdentity>(
        `SELECT t.id, t.legacy_firebase_doc_id, t.row_version, t.deleted_at,
                t.source_system,
                t.broker_connection_id AS trade_connection_id,
                t.external_trade_key AS trade_external_key,
                link.broker_connection_id AS link_connection_id,
                link.external_trade_key AS link_external_key
         FROM trades t
         LEFT JOIN ctrader_trade_links link
           ON link.user_id=t.user_id AND link.trade_id=t.id
         WHERE t.user_id=$1 AND t.id=$2
         FOR UPDATE OF t`,
        [auth.user.id, initial.id],
      );
      const trade = locked.rows[0];
      if (!trade) throw notFound("Trade");
      if (
        trade.trade_connection_id !== null
        && trade.link_connection_id !== null
        && trade.trade_connection_id !== trade.link_connection_id
      ) {
        throw new AppError(409, "TRADE_BROKER_IDENTITY_CONFLICT", "Trade broker identity changed; reload and retry");
      }
      const lockedConnectionId = trade.trade_connection_id ?? trade.link_connection_id;
      if (lockedConnectionId !== connectionId) {
        throw new AppError(409, "TRADE_BROKER_IDENTITY_CHANGED", "Trade broker identity changed; reload and retry");
      }
      if (trade.row_version !== expectedVersion) {
        throw conflict("Trade changed in another session; reload and retry");
      }
      const publicId = trade.legacy_firebase_doc_id ?? trade.id;
      if (confirmationValue !== publicId) {
        throw new AppError(400, "DELETE_CONFIRMATION_REQUIRED", "Confirm permanent deletion with the trade ID");
      }
      if (trade.deleted_at === null) {
        throw conflict("Archive the trade before permanently deleting it");
      }
      if (
        trade.trade_external_key !== null
        && trade.link_external_key !== null
        && trade.trade_external_key !== trade.link_external_key
      ) {
        throw new AppError(409, "TRADE_BROKER_IDENTITY_CONFLICT", "Trade broker identity changed; reload and retry");
      }
      const providerExternalKey = trade.link_external_key
        ?? (trade.source_system === "ctrader" ? trade.trade_external_key : null);
      const files = await client.query<{ storage_key: string }>(
        `SELECT storage_key FROM file_objects
         WHERE user_id=$1 AND trade_id=$2
         ORDER BY storage_key
         FOR UPDATE`,
        [auth.user.id, trade.id],
      );
      const deleted = await client.query<{ id: string }>(
        `DELETE FROM trades
         WHERE id=$1 AND user_id=$2 AND deleted_at IS NOT NULL
           AND row_version=$3
         RETURNING id`,
        [trade.id, auth.user.id, expectedVersion],
      );
      if (!deleted.rows[0]) throw conflict("Trade changed in another session; reload and retry");

      // Both protections are trigger-backed and transactional. Refuse to commit
      // a purge if either its future-sync tombstone or durable file cleanup job
      // was not produced by the cascades.
      if (lockedConnectionId !== null && providerExternalKey !== null) {
        const tombstone = await client.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM ctrader_trade_tombstones
             WHERE user_id=$1 AND broker_connection_id=$2 AND external_trade_key=$3
           ) AS exists`,
          [auth.user.id, lockedConnectionId, providerExternalKey],
        );
        if (tombstone.rows[0]?.exists !== true) {
          throw new Error("Permanent trade purge did not preserve its cTrader tombstone");
        }
      }
      const storageKeys = files.rows.map((file) => file.storage_key);
      if (storageKeys.length > 0) {
        const queued = await client.query<{ storage_key: string }>(
          `SELECT storage_key FROM file_deletion_queue
           WHERE storage_key=ANY($1::text[]) AND completed_at IS NULL
           FOR UPDATE`,
          [storageKeys],
        );
        const queuedKeys = new Set(queued.rows.map((row) => row.storage_key));
        if (storageKeys.some((storageKey) => !queuedKeys.has(storageKey))) {
          throw new Error("Permanent trade purge did not enqueue all file deletions");
        }
      }
      return { id: trade.id, publicId, storageKeys };
    });
    const removals = await Promise.allSettled(purged.storageKeys.map(async (storageKey) => {
      await app.screenshotStorage.remove(storageKey);
      await app.db.query("UPDATE file_deletion_queue SET completed_at=now(),last_error=NULL WHERE storage_key=$1", [storageKey]);
    }));
    const failures = removals.filter((result) => result.status === "rejected").length;
    if (failures > 0) request.log.error({ tradeId: purged.id, failures }, "Some screenshot files require orphan cleanup");
    await publishBestEffort(app, auth.user.id, "trade.purged", { id: purged.publicId, recordId: purged.id });
    return reply.code(204).send();
  });
}
