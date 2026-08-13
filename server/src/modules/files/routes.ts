import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { AppError, notFound } from "../../lib/errors.js";
import { publishBestEffort } from "../../events/publish.js";

const SCREENSHOT_IDEMPOTENCY_SCOPE = "screenshots.upload";

type ScreenshotIdempotencyRow = {
  request_hash: Buffer;
  resource_id: string;
};

type FileRow = {
  id: string;
  trade_id: string;
  storage_key: string;
  original_name: string;
  content_type: string;
  byte_size: string;
  width: number | null;
  height: number | null;
  created_at: Date | string;
};

function mapFile(row: FileRow): Record<string, unknown> {
  return {
    id: row.id,
    tradeRecordId: row.trade_id,
    name: row.original_name,
    contentType: row.content_type,
    byteSize: Number(row.byte_size),
    width: row.width,
    height: row.height,
    url: `/api/files/${row.id}`,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function safeDownloadName(value: string): string {
  return value.replace(/[\r\n"\\]/g, "_").slice(0, 255) || "screenshot";
}

function parseScreenshotIdempotencyKey(value: string | string[] | undefined): string {
  const supplied = Array.isArray(value) ? value[0] : value;
  const key = supplied?.trim() ?? "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key)) {
    throw new AppError(
      428,
      "IDEMPOTENCY_KEY_REQUIRED",
      "Screenshot upload requires a stable UUID Idempotency-Key",
    );
  }
  return key.toLowerCase();
}

function screenshotFingerprint(tradeId: string, sha256: Buffer): Buffer {
  return createHash("sha256")
    .update("edgebook:screenshots.upload:v1\0", "utf8")
    .update(tradeId, "utf8")
    .update("\0", "utf8")
    .update(sha256)
    .digest();
}

function sameHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

async function rollbackFile(client: PoolClient, storageKey: string | null, app: FastifyInstance): Promise<void> {
  await client.query("ROLLBACK").catch(() => undefined);
  if (storageKey) await app.screenshotStorage.remove(storageKey).catch(() => undefined);
}

export async function registerFileRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: [app.authenticate] };
  const write = { preHandler: [app.authenticate, app.requireCsrf] };

  app.get<{ Params: { tradeId: string } }>("/api/trades/:tradeId/screenshots", read, async (request) => {
    const auth = request.auth!;
    const result = await app.db.query<FileRow>(
      `SELECT f.id,f.trade_id,f.storage_key,f.original_name,f.content_type,f.byte_size,f.width,f.height,f.created_at
       FROM file_objects f JOIN trades t ON t.id=f.trade_id
       WHERE f.user_id=$1 AND (t.id::text=$2 OR t.legacy_firebase_doc_id=$2) AND f.deleted_at IS NULL
       ORDER BY f.created_at ASC`,
      [auth.user.id, request.params.tradeId],
    );
    return { files: result.rows.map(mapFile) };
  });

  app.post<{ Params: { tradeId: string } }>(
    "/api/trades/:tradeId/screenshots",
    { ...write, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const auth = request.auth!;
      const idempotencyKey = parseScreenshotIdempotencyKey(request.headers["idempotency-key"]);
      const part = await request.file({ limits: { files: 1, fileSize: app.config.maxUploadBytes, fields: 4 } });
      if (!part || part.fieldname !== "file") throw new AppError(400, "FILE_REQUIRED", "Multipart field 'file' is required");
      const input = await part.toBuffer();
      const image = await app.screenshotStorage.process(input);

      const client = await app.db.connect();
      let storageKey: string | null = null;
      let fileId: string | null = null;
      let response: Record<string, unknown> | null = null;
      let commitAttempted = false;
      let clientReleased = false;
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(hashtext('edgebook:storage-quota'))");
        await client.query("SELECT id FROM users WHERE id=$1 FOR UPDATE", [auth.user.id]);
        const tradeResult = await client.query<{ id: string }>(
          `SELECT id FROM trades
           WHERE user_id=$1 AND (id::text=$2 OR legacy_firebase_doc_id=$2) AND deleted_at IS NULL
           FOR UPDATE`,
          [auth.user.id, request.params.tradeId],
        );
        const trade = tradeResult.rows[0];
        if (!trade) throw notFound("Trade");

        const fingerprint = screenshotFingerprint(trade.id, image.sha256);
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`${auth.user.id}:${SCREENSHOT_IDEMPOTENCY_SCOPE}:${idempotencyKey}`],
        );
        const previous = await client.query<ScreenshotIdempotencyRow & FileRow>(
          `SELECT key.request_hash,key.resource_id,
                  file.id,file.trade_id,file.storage_key,file.original_name,
                  file.content_type,file.byte_size,file.width,file.height,file.created_at
           FROM api_idempotency_keys key
           LEFT JOIN file_objects file
             ON file.user_id=key.user_id AND file.id=key.resource_id
                AND file.deleted_at IS NULL
           WHERE key.user_id=$1 AND key.scope=$2 AND key.idempotency_key=$3
           FOR UPDATE OF key`,
          [auth.user.id, SCREENSHOT_IDEMPOTENCY_SCOPE, idempotencyKey],
        );
        const replay = previous.rows[0];
        if (replay) {
          if (!sameHash(replay.request_hash, fingerprint)) {
            throw new AppError(
              409,
              "IDEMPOTENCY_KEY_REUSED",
              "This Idempotency-Key was already used for a different screenshot upload",
            );
          }
          if (!replay.id || replay.trade_id !== trade.id) {
            throw new AppError(
              409,
              "IDEMPOTENCY_RESOURCE_GONE",
              "This screenshot upload completed previously, but the screenshot is no longer available",
            );
          }
          response = mapFile(replay);
          await client.query("COMMIT");
        } else {
          const countResult = await client.query<{ count: string }>(
            "SELECT count(*)::text AS count FROM file_objects WHERE user_id=$1 AND trade_id=$2 AND deleted_at IS NULL",
            [auth.user.id, trade.id],
          );
          if (Number(countResult.rows[0]?.count ?? 0) >= 5) {
            throw new AppError(409, "SCREENSHOT_LIMIT", "A trade can have at most five screenshots");
          }
          const quotaResult = await client.query<{ user_bytes: string; total_bytes: string }>(
            `SELECT
               COALESCE(sum(byte_size) FILTER (WHERE user_id=$1 AND deleted_at IS NULL),0)::text AS user_bytes,
               COALESCE(sum(byte_size) FILTER (WHERE deleted_at IS NULL),0)::text AS total_bytes
             FROM file_objects`,
            [auth.user.id],
          );
          const quota = quotaResult.rows[0];
          if (BigInt(quota?.user_bytes ?? 0) + BigInt(image.bytes.length) > BigInt(app.config.userStorageQuotaBytes)) {
            throw new AppError(413, "USER_STORAGE_QUOTA", "Your screenshot storage quota has been reached");
          }
          if (BigInt(quota?.total_bytes ?? 0) + BigInt(image.bytes.length) > BigInt(app.config.totalStorageQuotaBytes)) {
            throw new AppError(507, "VPS_STORAGE_QUOTA", "VPS screenshot storage quota reached. The screenshot was not saved.");
          }

          // Keep the filesystem free-space check in the same global critical
          // section as the database quota calculation and immediately before
          // writing. Concurrent API processes use this advisory lock too.
          await app.screenshotStorage.assertDiskCapacity(image.bytes.length);
          fileId = randomUUID();
          storageKey = await app.screenshotStorage.save(auth.user.id, trade.id, fileId, image);
          const insert = await client.query<FileRow>(
            `INSERT INTO file_objects
               (id,user_id,trade_id,storage_key,original_name,content_type,byte_size,sha256,width,height)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING id,trade_id,storage_key,original_name,content_type,byte_size,width,height,created_at`,
            [fileId,auth.user.id,trade.id,storageKey,part.filename.slice(0,255),image.contentType,image.bytes.length,image.sha256,image.width,image.height],
          );
          const row = insert.rows[0];
          if (!row) throw new Error("Failed to persist screenshot metadata");
          await client.query(
            `INSERT INTO api_idempotency_keys (
               user_id,scope,idempotency_key,request_hash,resource_id
             ) VALUES ($1,$2,$3,$4,$5)`,
            [auth.user.id, SCREENSHOT_IDEMPOTENCY_SCOPE, idempotencyKey, fingerprint, fileId],
          );
          response = mapFile(row);
          commitAttempted = true;
          await client.query("COMMIT");
        }
      } catch (error) {
        if (!commitAttempted) {
          await rollbackFile(client, storageKey, app);
          throw error;
        }

        // COMMIT can succeed on PostgreSQL while its acknowledgement is lost.
        // Destroy the uncertain connection and reconcile through a fresh pool
        // connection before deciding whether the stored image is an orphan.
        client.release(true);
        clientReleased = true;
        let committedRow: FileRow | undefined;
        try {
          const committed = await app.db.query<FileRow>(
            `SELECT id,trade_id,storage_key,original_name,content_type,byte_size,width,height,created_at
             FROM file_objects
             WHERE id=$1 AND user_id=$2 AND storage_key=$3 AND deleted_at IS NULL`,
            [fileId, auth.user.id, storageKey],
          );
          committedRow = committed.rows[0];
        } catch (reconcileError) {
          // Preserve the file when commit state cannot be proven. An orphan can
          // be reconciled later; deleting a possibly committed screenshot would
          // create irreversible data loss.
          request.log.error(
            { errorName: reconcileError instanceof Error ? reconcileError.name : "UnknownError", fileId },
            "Screenshot commit state could not be reconciled",
          );
          throw error;
        }
        if (!committedRow) {
          if (storageKey) await app.screenshotStorage.remove(storageKey).catch(() => undefined);
          throw error;
        }
        response = mapFile(committedRow);
      } finally {
        if (!clientReleased) client.release();
      }
      if (!response) throw new Error("Failed to build screenshot response");
      await publishBestEffort(app, auth.user.id, "file.created", response);
      return reply.code(201).send({ file: response });
    },
  );

  app.get<{ Params: { id: string } }>("/api/files/:id", read, async (request, reply) => {
    const result = await app.db.query<FileRow>(
      `SELECT id,trade_id,storage_key,original_name,content_type,byte_size,width,height,created_at
       FROM file_objects WHERE id::text=$1 AND user_id=$2 AND deleted_at IS NULL`,
      [request.params.id, request.auth!.user.id],
    );
    const row = result.rows[0];
    if (!row) throw notFound("Screenshot");
    reply.header("Content-Type", row.content_type);
    reply.header("Content-Length", row.byte_size);
    reply.header("Content-Disposition", `inline; filename="${safeDownloadName(row.original_name)}"`);
    reply.header("Cache-Control", "private, no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(app.screenshotStorage.open(row.storage_key));
  });

  app.delete<{ Params: { id: string } }>("/api/files/:id", write, async (request, reply) => {
    const auth = request.auth!;
    const result = await app.db.query<FileRow>(
      `DELETE FROM file_objects WHERE id::text=$1 AND user_id=$2
       RETURNING id,trade_id,storage_key,original_name,content_type,byte_size,width,height,created_at`,
      [request.params.id, auth.user.id],
    );
    const row = result.rows[0];
    if (!row) throw notFound("Screenshot");
    try {
      await app.screenshotStorage.remove(row.storage_key);
      await app.db.query("UPDATE file_deletion_queue SET completed_at=now(),last_error=NULL WHERE storage_key=$1", [row.storage_key]);
    } catch (error) {
      request.log.error({ error, fileId: row.id }, "Screenshot deletion queued for retry");
      await publishBestEffort(app, auth.user.id, "file.deleted", { id: row.id, tradeRecordId: row.trade_id, cleanupQueued: true });
      return reply.code(202).send({ deleted: true, cleanupQueued: true });
    }
    await publishBestEffort(app, auth.user.id, "file.deleted", { id: row.id, tradeRecordId: row.trade_id });
    return reply.code(204).send();
  });
}
