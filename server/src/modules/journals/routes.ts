import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { assertJsonSize } from "../../lib/json.js";
import { AppError, conflict, notFound } from "../../lib/errors.js";
import { calendarDateSchema } from "../../lib/date.js";
import { publishBestEffort } from "../../events/publish.js";

const journalBodySchema = z
  .object({
    entry: z.record(z.string(), z.unknown()),
    version: z.number().int().min(0).optional(),
  })
  .strict();

type JournalRow = {
  id: string;
  journal_date: string;
  entry: Record<string, unknown>;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

function mapJournal(row: JournalRow): Record<string, unknown> {
  return {
    id: row.journal_date,
    recordId: row.id,
    date: row.journal_date,
    entry: row.entry,
    version: row.version,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function registerJournalRoutes(app: FastifyInstance): Promise<void> {
  const read = { preHandler: [app.authenticate] };
  const write = { preHandler: [app.authenticate, app.requireCsrf] };

  app.get("/api/journals", read, async (request) => {
    const query = z
      .object({ from: calendarDateSchema.optional(), to: calendarDateSchema.optional(), limit: z.coerce.number().int().min(1).max(2_000).default(1_000) })
      .parse(request.query);
    const params: unknown[] = [request.auth!.user.id];
    const filters = ["user_id=$1"];
    if (query.from) { params.push(query.from); filters.push(`journal_date >= $${params.length}::date`); }
    if (query.to) { params.push(query.to); filters.push(`journal_date <= $${params.length}::date`); }
    params.push(query.limit);
    const result = await app.db.query<JournalRow>(
      `SELECT id, journal_date, entry, version, created_at, updated_at
       FROM daily_journal_entries WHERE ${filters.join(" AND ")}
       ORDER BY journal_date DESC LIMIT $${params.length}`,
      params,
    );
    return { entries: result.rows.map(mapJournal) };
  });

  app.get<{ Params: { date: string } }>("/api/journals/:date", read, async (request) => {
    const date = calendarDateSchema.parse(request.params.date);
    const result = await app.db.query<JournalRow>(
      `SELECT id, journal_date, entry, version, created_at, updated_at
       FROM daily_journal_entries WHERE user_id=$1 AND journal_date=$2::date`,
      [request.auth!.user.id, date],
    );
    const row = result.rows[0];
    return { journal: row ? mapJournal(row) : null };
  });

  app.put<{ Params: { date: string } }>("/api/journals/:date", write, async (request) => {
    const auth = request.auth!;
    const date = calendarDateSchema.parse(request.params.date);
    const body = journalBodySchema.parse(request.body);
    if (body.version === undefined) {
      throw new AppError(428, "VERSION_REQUIRED", "Reload this journal entry and retry with its current version");
    }
    assertJsonSize(body.entry, 256 * 1024);
    const result = await app.db.query<JournalRow>(
      `INSERT INTO daily_journal_entries (id, user_id, journal_date, entry)
       VALUES ($1,$2,$3::date,$4::jsonb)
       ON CONFLICT (user_id, journal_date) DO UPDATE SET
         entry=EXCLUDED.entry, version=daily_journal_entries.version+1
       WHERE daily_journal_entries.version=$5
       RETURNING id, journal_date, entry, version, created_at, updated_at`,
      [randomUUID(), auth.user.id, date, JSON.stringify(body.entry), body.version],
    );
    const row = result.rows[0];
    if (!row) throw conflict("Journal changed in another session; reload and retry");
    const response = mapJournal(row);
    await publishBestEffort(app, auth.user.id, "journal.updated", response);
    return { journal: response };
  });

  app.delete<{ Params: { date: string } }>("/api/journals/:date", write, async (request, reply) => {
    const auth = request.auth!;
    const date = calendarDateSchema.parse(request.params.date);
    const result = await app.db.query<{ id: string }>(
      "DELETE FROM daily_journal_entries WHERE user_id=$1 AND journal_date=$2::date RETURNING id",
      [auth.user.id, date],
    );
    if (!result.rows[0]) throw notFound("Journal entry");
    await publishBestEffort(app, auth.user.id, "journal.deleted", { id: date, date });
    return reply.code(204).send();
  });
}
