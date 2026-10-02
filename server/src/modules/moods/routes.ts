import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { conflict, notFound } from "../../lib/errors.js";
import { assertJsonSize } from "../../lib/json.js";
import { calendarDateSchema } from "../../lib/date.js";
import { publishBestEffort } from "../../events/publish.js";

const moodSchema = z
  .object({
    id: z.union([z.string().min(1).max(512), z.number().finite()]).optional(),
    legacyId: z.string().min(1).max(512).optional(),
    type: z.string().trim().min(1).max(64),
    emotion: z.string().trim().min(1).max(256),
    confidence: z.number().int().min(1).max(10).nullable().optional(),
    notes: z.string().max(10_000).nullable().optional(),
    occurredAt: z.string().datetime({ offset: true }).nullable().optional(),
    date: calendarDateSchema,
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/).nullable().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const moodPatchSchema = moodSchema.partial();

type MoodRow = {
  id: string;
  legacy_id: string | null;
  kind: string;
  emotion: string;
  confidence: number | null;
  notes: string | null;
  occurred_at: Date | string | null;
  local_date: string;
  local_time: string | null;
  metadata: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
};

const columns = "id, legacy_id, kind, emotion, confidence, notes, occurred_at, local_date, local_time, metadata, created_at, updated_at";

function unwrap(body: unknown): unknown {
  if (body && typeof body === "object" && "mood" in body) return (body as { mood: unknown }).mood;
  return body;
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function mapMood(row: MoodRow): Record<string, unknown> {
  return {
    id: row.legacy_id ?? row.id,
    recordId: row.id,
    legacyId: row.legacy_id,
    type: row.kind,
    emotion: row.emotion,
    confidence: row.confidence,
    notes: row.notes,
    occurredAt: iso(row.occurred_at),
    date: row.local_date,
    time: row.local_time?.slice(0, 5) ?? null,
    metadata: row.metadata,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function isExactMoodReplay(row: MoodRow, parsed: z.infer<typeof moodSchema>): boolean {
  return row.kind === parsed.type
    && row.emotion === parsed.emotion
    && row.confidence === (parsed.confidence ?? null)
    && row.notes === (parsed.notes ?? null)
    && iso(row.occurred_at) === (parsed.occurredAt ?? null)
    && String(row.local_date).slice(0, 10) === parsed.date
    && (row.local_time?.slice(0, 5) ?? null) === (parsed.time?.slice(0, 5) ?? null)
    && stableJson(row.metadata ?? {}) === stableJson(parsed.metadata ?? {});
}

async function findMood(app: FastifyInstance, userId: string, id: string): Promise<MoodRow | null> {
  const result = await app.db.query<MoodRow>(
    `SELECT ${columns} FROM mood_checkins
     WHERE user_id=$1 AND (id::text=$2 OR legacy_id=$2) LIMIT 1`,
    [userId, id],
  );
  return result.rows[0] ?? null;
}

export async function registerMoodRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: [app.authenticate] };
  const write = { preHandler: [app.authenticate, app.requireCsrf] };

  app.get("/api/moods", read, async (request) => {
    const query = z
      .object({
        from: calendarDateSchema.optional(),
        to: calendarDateSchema.optional(),
        limit: z.coerce.number().int().min(1).max(1_000).default(500),
      })
      .parse(request.query);
    const params: unknown[] = [request.auth!.user.id];
    const filters = ["user_id=$1"];
    if (query.from) {
      params.push(query.from);
      filters.push(`local_date >= $${params.length}::date`);
    }
    if (query.to) {
      params.push(query.to);
      filters.push(`local_date <= $${params.length}::date`);
    }
    params.push(query.limit);
    const result = await app.db.query<MoodRow>(
      `SELECT ${columns} FROM mood_checkins
       WHERE ${filters.join(" AND ")}
       ORDER BY local_date DESC, local_time DESC NULLS LAST, created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return { moods: result.rows.map(mapMood) };
  });

  app.post("/api/moods", write, async (request) => {
    const auth = request.auth!;
    const parsed = moodSchema.parse(unwrap(request.body));
    assertJsonSize(parsed, 128 * 1024);
    const suppliedId = parsed.legacyId ?? parsed.id;
    const legacyId = suppliedId === undefined ? null : String(suppliedId);
    const result = await app.db.query<MoodRow>(
      `INSERT INTO mood_checkins
         (id, user_id, legacy_id, kind, emotion, confidence, notes, occurred_at, local_date, local_time, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
       ON CONFLICT (user_id, legacy_id) DO NOTHING
       RETURNING ${columns}`,
      [
        randomUUID(),
        auth.user.id,
        legacyId,
        parsed.type,
        parsed.emotion,
        parsed.confidence ?? null,
        parsed.notes ?? null,
        parsed.occurredAt ?? null,
        parsed.date,
        parsed.time ?? null,
        JSON.stringify(parsed.metadata ?? {}),
      ],
    );
    let row = result.rows[0];
    let replayed = false;
    if (!row && legacyId) {
      const existing = await findMood(app, auth.user.id, legacyId);
      if (existing && isExactMoodReplay(existing, parsed)) {
        row = existing;
        replayed = true;
      } else if (existing) {
        throw conflict("This mood entry changed elsewhere; reload before retrying");
      }
    }
    if (!row) throw new Error("Failed to persist mood check-in");
    const response = mapMood(row);
    if (!replayed) await publishBestEffort(app, auth.user.id, "mood.upserted", response);
    return { mood: response };
  });

  app.patch<{ Params: { id: string } }>("/api/moods/:id", write, async (request) => {
    const auth = request.auth!;
    const existing = await findMood(app, auth.user.id, request.params.id);
    if (!existing) throw notFound("Mood check-in");
    const patch = moodPatchSchema.parse(unwrap(request.body));
    const current = mapMood(existing);
    const parsed = moodSchema.parse({ ...current, ...patch, id: existing.legacy_id ?? undefined });
    assertJsonSize(parsed, 128 * 1024);
    const result = await app.db.query<MoodRow>(
      `UPDATE mood_checkins SET
         legacy_id=$3, kind=$4, emotion=$5, confidence=$6, notes=$7,
         occurred_at=$8, local_date=$9, local_time=$10, metadata=$11::jsonb
       WHERE id=$1 AND user_id=$2
       RETURNING ${columns}`,
      [
        existing.id,
        auth.user.id,
        existing.legacy_id,
        parsed.type,
        parsed.emotion,
        parsed.confidence ?? null,
        parsed.notes ?? null,
        parsed.occurredAt ?? null,
        parsed.date,
        parsed.time ?? null,
        JSON.stringify(parsed.metadata ?? {}),
      ],
    );
    const row = result.rows[0];
    if (!row) throw notFound("Mood check-in");
    const response = mapMood(row);
    await publishBestEffort(app, auth.user.id, "mood.updated", response);
    return { mood: response };
  });

  app.delete<{ Params: { id: string } }>("/api/moods/:id", write, async (request, reply) => {
    const auth = request.auth!;
    const result = await app.db.query<{ id: string; legacy_id: string | null }>(
      `DELETE FROM mood_checkins
       WHERE user_id=$1 AND (id::text=$2 OR legacy_id=$2)
       RETURNING id, legacy_id`,
      [auth.user.id, request.params.id],
    );
    const row = result.rows[0];
    if (!row) throw notFound("Mood check-in");
    await publishBestEffort(app, auth.user.id, "mood.deleted", { id: row.legacy_id ?? row.id, recordId: row.id });
    return reply.code(204).send();
  });
}
