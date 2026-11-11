import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "../../lib/errors.js";
import { assertJsonSize } from "../../lib/json.js";
import { publishBestEffort } from "../../events/publish.js";

const notificationSchema = z
  .object({
    id: z.string().min(1).max(512).optional(),
    legacyFirebaseDocId: z.string().min(1).max(512).optional(),
    type: z.string().trim().min(1).max(64),
    title: z.string().trim().min(1).max(500),
    message: z.string().max(10_000),
    category: z.string().max(128).nullable().optional(),
    actionLabel: z.string().max(256).nullable().optional(),
    actionTarget: z.string().max(1_024).nullable().optional(),
    read: z.boolean().optional(),
    dedupeKey: z.string().max(512).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const notificationPatchSchema = notificationSchema.partial();

type NotificationRow = {
  id: string;
  legacy_firebase_doc_id: string | null;
  type: string;
  title: string;
  message: string;
  category: string | null;
  action_label: string | null;
  action_target: string | null;
  is_read: boolean;
  dedupe_key: string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
};

const columns = "id, legacy_firebase_doc_id, type, title, message, category, action_label, action_target, is_read, dedupe_key, metadata, created_at, updated_at";

function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && "notification" in body) return (body as { notification: unknown }).notification;
  return body;
}

function mapNotification(row: NotificationRow): Record<string, unknown> {
  return {
    id: row.legacy_firebase_doc_id ?? row.id,
    recordId: row.id,
    legacyFirebaseDocId: row.legacy_firebase_doc_id,
    type: row.type,
    title: row.title,
    message: row.message,
    category: row.category,
    actionLabel: row.action_label,
    actionTarget: row.action_target,
    read: row.is_read,
    dedupeKey: row.dedupe_key,
    metadata: row.metadata,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

async function findNotification(app: FastifyInstance, userId: string, id: string): Promise<NotificationRow | null> {
  const result = await app.db.query<NotificationRow>(
    `SELECT ${columns} FROM notifications
     WHERE user_id=$1 AND (id::text=$2 OR legacy_firebase_doc_id=$2) LIMIT 1`,
    [userId, id],
  );
  return result.rows[0] ?? null;
}

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: [app.authenticate] };
  const write = { preHandler: [app.authenticate, app.requireCsrf] };

  app.get("/api/notifications", read, async (request) => {
    const query = z
      .object({
        unread: z.enum(["true", "false"]).optional(),
        category: z.string().max(128).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .parse(request.query);
    const params: unknown[] = [request.auth!.user.id];
    const filters = ["user_id=$1"];
    if (query.unread) { params.push(query.unread === "true"); filters.push(`is_read <> $${params.length}`); }
    if (query.category) { params.push(query.category); filters.push(`category=$${params.length}`); }
    params.push(query.limit);
    const result = await app.db.query<NotificationRow>(
      `SELECT ${columns} FROM notifications WHERE ${filters.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return { notifications: result.rows.map(mapNotification) };
  });

  app.post("/api/notifications", write, async (request) => {
    const auth = request.auth!;
    const parsed = notificationSchema.parse(unwrap(request.body));
    assertJsonSize(parsed, 128 * 1024);
    const legacyId = parsed.legacyFirebaseDocId ?? parsed.id ?? null;
    const conflictClause = parsed.dedupeKey
      ? `ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
           type=EXCLUDED.type,title=EXCLUDED.title,message=EXCLUDED.message,
           category=EXCLUDED.category,action_label=EXCLUDED.action_label,
           action_target=EXCLUDED.action_target,is_read=EXCLUDED.is_read,
           metadata=notifications.metadata || EXCLUDED.metadata`
      : `ON CONFLICT (user_id, legacy_firebase_doc_id) DO UPDATE SET
           type=EXCLUDED.type,title=EXCLUDED.title,message=EXCLUDED.message,
           category=EXCLUDED.category,action_label=EXCLUDED.action_label,
           action_target=EXCLUDED.action_target,is_read=EXCLUDED.is_read,
           dedupe_key=EXCLUDED.dedupe_key,metadata=notifications.metadata || EXCLUDED.metadata`;
    const result = await app.db.query<NotificationRow>(
      `INSERT INTO notifications
         (id,user_id,legacy_firebase_doc_id,type,title,message,category,action_label,action_target,is_read,dedupe_key,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)
       ${conflictClause}
       RETURNING ${columns}`,
      [randomUUID(),auth.user.id,legacyId,parsed.type,parsed.title,parsed.message,parsed.category ?? null,
        parsed.actionLabel ?? null,parsed.actionTarget ?? null,parsed.read ?? false,parsed.dedupeKey ?? null,
        JSON.stringify(parsed.metadata ?? {})],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Failed to persist notification");
    const response = mapNotification(row);
    await publishBestEffort(app, auth.user.id, "notification.upserted", response);
    return { notification: response };
  });

  app.patch<{ Params: { id: string } }>("/api/notifications/:id", write, async (request) => {
    const auth = request.auth!;
    const existing = await findNotification(app, auth.user.id, request.params.id);
    if (!existing) throw notFound("Notification");
    const patch = notificationPatchSchema.parse(unwrap(request.body));
    const current = mapNotification(existing);
    const parsed = notificationSchema.parse({ ...current, ...patch, id: existing.legacy_firebase_doc_id ?? undefined });
    const result = await app.db.query<NotificationRow>(
      `UPDATE notifications SET type=$3,title=$4,message=$5,category=$6,action_label=$7,
         action_target=$8,is_read=$9,dedupe_key=$10,metadata=$11::jsonb
       WHERE id=$1 AND user_id=$2 RETURNING ${columns}`,
      [existing.id,auth.user.id,parsed.type,parsed.title,parsed.message,parsed.category ?? null,
        parsed.actionLabel ?? null,parsed.actionTarget ?? null,parsed.read ?? false,parsed.dedupeKey ?? null,
        JSON.stringify(parsed.metadata ?? {})],
    );
    const row = result.rows[0];
    if (!row) throw notFound("Notification");
    const response = mapNotification(row);
    await publishBestEffort(app, auth.user.id, "notification.updated", response);
    return { notification: response };
  });

  app.post("/api/notifications/read-all", write, async (request) => {
    const auth = request.auth!;
    const result = await app.db.query("UPDATE notifications SET is_read=true WHERE user_id=$1 AND is_read=false", [auth.user.id]);
    await publishBestEffort(app, auth.user.id, "notifications.read_all", { count: result.rowCount ?? 0 });
    return { updated: result.rowCount ?? 0 };
  });

  app.delete<{ Params: { id: string } }>("/api/notifications/:id", write, async (request, reply) => {
    const auth = request.auth!;
    const result = await app.db.query<{ id: string; legacy_firebase_doc_id: string | null }>(
      `DELETE FROM notifications WHERE user_id=$1 AND (id::text=$2 OR legacy_firebase_doc_id=$2)
       RETURNING id,legacy_firebase_doc_id`,
      [auth.user.id,request.params.id],
    );
    const row = result.rows[0];
    if (!row) throw notFound("Notification");
    await publishBestEffort(app, auth.user.id, "notification.deleted", { id: row.legacy_firebase_doc_id ?? row.id, recordId: row.id });
    return reply.code(204).send();
  });
}
