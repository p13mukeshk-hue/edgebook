import Fastify, {
  LogController,
  type FastifyInstance,
  type FastifyServerOptions,
} from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { createDatabase, type Database } from "./db/database.js";
import { PostgresEventBus, type EventBus } from "./events/event-bus.js";
import { AppError } from "./lib/errors.js";
import { authPlugin } from "./auth/plugin.js";
import { registerAuthRoutes, type GoogleTokenVerifier } from "./auth/routes.js";
import { registerEventRoutes } from "./modules/events/routes.js";
import { registerFileRoutes } from "./modules/files/routes.js";
import { registerJournalRoutes } from "./modules/journals/routes.js";
import { registerMoodRoutes } from "./modules/moods/routes.js";
import { registerNotificationRoutes } from "./modules/notifications/routes.js";
import { registerSettingsRoutes } from "./modules/settings/routes.js";
import { registerSystemRoutes } from "./modules/system/routes.js";
import { registerTradeRoutes } from "./modules/trades/routes.js";
import { LocalScreenshotStorage, type ScreenshotStorage } from "./uploads/storage.js";
import { OfficialCTraderGateway } from "./ctrader/client.js";
import { AesGcmTokenCipher } from "./ctrader/crypto.js";
import { OfficialCTraderOAuthClient } from "./ctrader/oauth.js";
import { registerCTraderRoutes } from "./ctrader/routes.js";
import {
  PostgresCTraderService,
  type CTraderBrokerService,
  type CTraderMcpConnector,
} from "./ctrader/service.js";
import { validateCTraderMcpConfiguration } from "./ctrader/mcp.js";

export type AppDependencies = {
  database?: Database;
  events?: EventBus;
  screenshotStorage?: ScreenshotStorage;
  googleVerifier?: GoogleTokenVerifier;
  ctraderService?: CTraderBrokerService | null;
  ctraderMcpConnector?: CTraderMcpConnector | null;
  loggerStream?: { write(message: string): void };
};

export async function buildApp(config: AppConfig, dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  type LoggerOptions = Exclude<FastifyServerOptions["logger"], boolean | undefined>;
  const logger: false | LoggerOptions = config.nodeEnv === "test"
    ? false
    : {
        level: config.logLevel,
        redact: {
          paths: [
            "req.headers.authorization",
            "req.headers.cookie",
            "res.headers.set-cookie",
            "body.credential",
            "body.accessToken",
            "body.refreshToken",
            "body.token",
            "body.configuration",
          ],
          censor: "[REDACTED]",
        },
        ...(dependencies.loggerStream ? { stream: dependencies.loggerStream } : {}),
      };
  const app = Fastify({
    logger,
    trustProxy: config.trustProxy,
    bodyLimit: 1024 * 1024,
    requestIdHeader: "x-request-id",
    // OAuth providers return the short-lived authorization code and state in
    // the query string. Never persist that callback URL in application logs.
    logController: new LogController({
      disableRequestLogging: (request) => request.url.startsWith("/api/auth/ctrader/callback"),
    }),
  });

  const database = dependencies.database ?? createDatabase(config);
  const events = dependencies.events ?? new PostgresEventBus(database);
  const screenshotStorage = dependencies.screenshotStorage ?? new LocalScreenshotStorage(config);
  const ctraderService = dependencies.ctraderService !== undefined
    ? dependencies.ctraderService
    : config.cTrader.available
      ? new PostgresCTraderService(
          database,
          config,
          config.cTrader.enabled ? new OfficialCTraderOAuthClient(config.cTrader) : null,
          config.cTrader.enabled ? new OfficialCTraderGateway(config.cTrader) : null,
          AesGcmTokenCipher.fromConfig(config.cTrader),
          events,
          dependencies.ctraderMcpConnector !== undefined
            ? dependencies.ctraderMcpConnector
            : config.cTrader.mcpEnabled
              ? {
                  validateConfiguration: (configuration) => validateCTraderMcpConfiguration(configuration, {
                    requestTimeoutMs: config.cTrader.requestTimeoutMs,
                  }),
                }
              : null,
        )
      : null;
  app.decorate("config", config);
  app.decorate("db", database);
  app.decorate("events", events);
  app.decorate("screenshotStorage", screenshotStorage);

  await app.register(cookie);
  await app.register(helmet, {
    global: true,
    crossOriginResourcePolicy: { policy: "same-origin" },
    contentSecurityPolicy: false,
  });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });
  await app.register(multipart, {
    attachFieldsToBody: false,
    limits: { files: 1, fileSize: config.maxUploadBytes, fields: 4, parts: 5 },
  });

  app.addHook("onRequest", async (request, reply) => {
    // Every API response can contain user-specific state or error details and
    // authentication is cookie-based. Apply this before routing so successful,
    // unauthenticated, validation, and not-found responses all fail closed for
    // browser/proxy caches and can never bleed across login sessions.
    if (request.url === "/api" || request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "private, no-store");
    }
    const safeMethod = request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS";
    if (safeMethod) return;
    const origin = request.headers.origin;
    if (config.nodeEnv === "production" && origin !== config.publicOrigin) {
      throw new AppError(403, "ORIGIN_INVALID", "The request origin is not allowed");
    }
    if (origin && origin !== config.publicOrigin) {
      throw new AppError(403, "ORIGIN_INVALID", "The request origin is not allowed");
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url === "/api" || request.url.startsWith("/api/")) {
      reply.header(
        "Cache-Control",
        request.url.startsWith("/api/events")
          ? "private, no-store, no-transform"
          : "private, no-store",
      );
    }
    return payload;
  });

  await app.register(authPlugin);
  await registerAuthRoutes(app, dependencies.googleVerifier);
  await registerTradeRoutes(app);
  await registerSettingsRoutes(app);
  await registerMoodRoutes(app);
  await registerJournalRoutes(app);
  await registerNotificationRoutes(app);
  await registerFileRoutes(app);
  await registerEventRoutes(app);
  await registerCTraderRoutes(app, ctraderService);
  // Register capability discovery last so dataApiReady=true is only exposed
  // after every advertised data route has registered successfully.
  await registerSystemRoutes(app);

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({
      error: { code: "ROUTE_NOT_FOUND", message: "Route not found", requestId: request.id },
    });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      void reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "The request payload is invalid",
          requestId: request.id,
          details: error.issues,
        },
      });
      return;
    }
    if (error instanceof AppError) {
      void reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message, requestId: request.id, details: error.details },
      });
      return;
    }
    const fastifyError = error as Error & { code?: string; statusCode?: number };
    if (fastifyError.code === "53100" || fastifyError.code === "ENOSPC") {
      request.log.error({ errorCode: fastifyError.code }, "VPS storage limit prevented a save");
      void reply.code(507).send({
        error: {
          code: "VPS_STORAGE_LIMIT",
          message: "VPS storage limit reached. Your changes were not saved; please retry after server storage is cleared.",
          requestId: request.id,
        },
      });
      return;
    }
    if (fastifyError.code === "23505") {
      void reply.code(409).send({ error: { code: "CONFLICT", message: "The record already exists", requestId: request.id } });
      return;
    }
    if (fastifyError.code === "FST_REQ_FILE_TOO_LARGE" || fastifyError.statusCode === 413) {
      void reply.code(413).send({ error: { code: "FILE_TOO_LARGE", message: "The upload is too large", requestId: request.id } });
      return;
    }
    request.log.error({ error }, "Unhandled request error");
    void reply.code(500).send({
      error: { code: "INTERNAL_ERROR", message: "An unexpected server error occurred", requestId: request.id },
    });
  });

  app.addHook("onReady", async () => {
    await screenshotStorage.ensureRoot();
    await events.start();
  });
  app.addHook("onClose", async () => {
    await events.stop();
    await database.end();
  });

  return app;
}
