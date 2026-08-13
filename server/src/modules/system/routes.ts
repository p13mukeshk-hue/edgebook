import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { FastifyInstance } from "fastify";

const requiredMigrations = [
  "001_initial.sql",
  "002_ctrader.sql",
  "003_tenant_integrity.sql",
  "004_ctrader_mcp_read.sql",
  "005_ctrader_historical_reconciliation.sql",
  "006_screenshot_upload_idempotency.sql",
  "007_ctrader_live_reconciliation.sql",
  "008_ctrader_account_cash_flows.sql",
  "900_legacy_firebase_archive.sql",
] as const;

export async function registerSystemRoutes(app: FastifyInstance): Promise<void> {
  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      const [migrationResult] = await Promise.all([
        app.db.query<{ applied: number }>(
          `SELECT count(*)::int AS applied
           FROM schema_migrations
           WHERE name = ANY($1::text[])`,
          [[...requiredMigrations]],
        ),
        access(app.config.uploadRoot, constants.R_OK | constants.W_OK),
      ]);
      if (migrationResult.rows[0]?.applied !== requiredMigrations.length) {
        throw new Error("Required database migrations are not applied");
      }
      return { status: "ready" };
    } catch (error) {
      app.log.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError" },
        "Readiness check failed",
      );
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.get("/api/config", async (_request, reply) => {
    reply.header("Cache-Control", "public, max-age=300");
    return {
      googleClientId: app.config.googleClientId,
      authMode: "google",
      dataApiReady: true,
      ctraderEnabled: app.config.cTrader.available,
      ctraderOAuthEnabled: app.config.cTrader.enabled,
      ctraderMcpEnabled: app.config.cTrader.mcpEnabled,
    };
  });
}
