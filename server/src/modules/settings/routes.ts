import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { withTransaction } from "../../db/database.js";
import { assertJsonSize } from "../../lib/json.js";
import { AppError, conflict } from "../../lib/errors.js";
import { syncAccountsFromSettings } from "../accounts/sync.js";
import { publishBestEffort } from "../../events/publish.js";

const settingsBodySchema = z
  .object({
    settings: z.record(z.string(), z.unknown()),
    version: z.number().int().min(0).optional(),
  })
  .strict();

type SettingsRow = {
  settings: Record<string, unknown>;
  version: number;
  updated_at: Date | string;
};

export async function registerSettingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/settings", { preHandler: [app.authenticate] }, async (request) => {
    const result = await app.db.query<SettingsRow>(
      "SELECT settings, version, updated_at FROM user_settings WHERE user_id=$1",
      [request.auth!.user.id],
    );
    const row = result.rows[0];
    return row
      ? { settings: row.settings, version: row.version, updatedAt: new Date(row.updated_at).toISOString() }
      : { settings: {}, version: 0, updatedAt: null };
  });

  app.put(
    "/api/settings",
    { preHandler: [app.authenticate, app.requireCsrf] },
    async (request) => {
      const auth = request.auth!;
      const body = settingsBodySchema.parse(request.body);
      if (body.version === undefined) {
        throw new AppError(428, "VERSION_REQUIRED", "Reload settings and retry with their current version");
      }
      assertJsonSize(body.settings, 768 * 1024);
      const row = await withTransaction(app.db, async (client) => {
        const result = await client.query<SettingsRow>(
          `INSERT INTO user_settings (user_id, settings, version)
           VALUES ($1, $2::jsonb, 1)
           ON CONFLICT (user_id) DO UPDATE SET
             settings = EXCLUDED.settings,
             version = user_settings.version + 1
           WHERE user_settings.version = $3
           RETURNING settings, version, updated_at`,
          [auth.user.id, JSON.stringify(body.settings), body.version],
        );
        const updated = result.rows[0];
        if (!updated) throw conflict("Settings changed in another session; reload and retry");
        await syncAccountsFromSettings(client, auth.user.id, updated.settings);
        return updated;
      });
      await publishBestEffort(app, auth.user.id, "settings.updated", { version: row.version });
      return { settings: row.settings, version: row.version, updatedAt: new Date(row.updated_at).toISOString() };
    },
  );
}
