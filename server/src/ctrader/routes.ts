import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { authCookieNames } from "../auth/cookies.js";
import { AppError } from "../lib/errors.js";
import type { AuthContext } from "../types.js";
import { CTraderApiError } from "./client.js";
import { CTraderOAuthError } from "./oauth.js";
import type { CTraderBrokerService } from "./service.js";

const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{40,200}$/);
const authCodeSchema = z.string().min(1).max(4_096);
const connectionIdSchema = z.string().uuid();
const historicalImportIdSchema = z.string().uuid();
const reconciliationCandidateIdSchema = z.string().uuid();
const clientRequestIdSchema = z.string().uuid();
const idempotencyKeySchema = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9:_-]+$/);
const historicalImportSchema = z.object({
  boundaryLocal: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  timeZone: z.string().trim().min(1).max(100),
  boundaryAt: z.string().datetime({ offset: true }),
  acknowledgeNoOpenPositionsAtBoundary: z.literal(true),
  clientRequestId: clientRequestIdSchema,
}).strict();
const reconciliationQuerySchema = z.object({ importId: historicalImportIdSchema }).strict();
const accountCashFlowQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  cursor: z.string().min(1).max(2_048).optional(),
}).strict();
const resolveCandidateSchema = z.object({
  action: z.enum(["link_manual", "publish_separate", "suppress_deleted", "reject"]),
  version: z.number().int().min(1),
  importId: historicalImportIdSchema,
  clientRequestId: clientRequestIdSchema,
}).strict();
const resolveLiveCandidateSchema = z.object({
  action: z.enum(["link_manual", "publish_separate", "suppress_deleted", "reject"]),
  version: z.number().int().min(1),
  clientRequestId: clientRequestIdSchema,
  manualTradeId: z.string().uuid().nullable().optional(),
}).strict();
const createConnectionSchema = z.object({
  grantId: z.string().uuid(),
  ctidTraderAccountId: z.string().regex(/^(?:0|[1-9]\d{0,19})$/),
  mappedLegacyAccountId: z.string().trim().min(1).max(255).nullable().optional(),
  label: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();
const connectMcpSchema = z.object({
  configuration: z.string().trim().min(20).max(32_768),
  environment: z.enum(["live", "demo"]),
  accountId: z.string().trim().regex(/^(?:0|[1-9]\d{0,19})$/).nullable().optional(),
  mappedLegacyAccountId: z.string().trim().min(1).max(255).nullable().optional(),
  label: z.string().trim().min(1).max(200).nullable().optional(),
  acknowledgeTradingCredentialRisk: z.literal(true),
  acknowledgeNoOpenPositionsAtConnect: z.boolean().optional(),
}).strict();

function fixedAppRedirect(app: FastifyInstance, state: "select" | "error", code?: string): string {
  const target = new URL("/app.html", app.config.publicOrigin);
  target.searchParams.set("ctrader", state);
  if (state === "error" && code) target.searchParams.set("code", code);
  return target.toString();
}

function sendCallbackRedirect(reply: FastifyReply, location: string): FastifyReply {
  reply.header("Cache-Control", "no-store");
  reply.header("Pragma", "no-cache");
  reply.header("Referrer-Policy", "no-referrer");
  return reply.redirect(location, 303);
}

async function callbackAuth(app: FastifyInstance, request: FastifyRequest): Promise<AuthContext | null> {
  const name = authCookieNames(app.config).session;
  const sessionToken = request.cookies[name];
  return sessionToken ? app.loadOptionalSession(sessionToken) : null;
}

function callbackErrorCode(error: unknown): string {
  if (error instanceof AppError && error.code === "CTRADER_STATE_INVALID") return "state_invalid";
  if (error instanceof AppError && error.code === "CTRADER_NO_ACCOUNTS") return "account_discovery_failed";
  if (error instanceof CTraderOAuthError) {
    return error.code === "TOKEN_ENDPOINT_UNAVAILABLE" ? "unavailable" : "token_exchange_failed";
  }
  if (error instanceof CTraderApiError) return "account_discovery_failed";
  return "exchange_failed";
}

export async function registerCTraderRoutes(
  app: FastifyInstance,
  service: CTraderBrokerService | null,
): Promise<void> {
  const enabledService = (): CTraderBrokerService => {
    if (!service) throw new AppError(503, "CTRADER_NOT_CONFIGURED", "cTrader OAuth is not configured on this server");
    return service;
  };
  const protectedRead = { preHandler: [app.authenticate] };
  const protectedWrite = { preHandler: [app.authenticate, app.requireCsrf] };

  app.post("/api/ctrader/oauth/start", protectedWrite, async (request, reply) => {
    if (request.body !== undefined && (typeof request.body !== "object" || request.body === null || Array.isArray(request.body))) {
      throw new AppError(400, "VALIDATION_ERROR", "The request payload must be an object");
    }
    reply.header("Cache-Control", "no-store");
    return enabledService().startOAuth(request.auth!);
  });

  // This endpoint is intentionally outside the CSRF hook: the provider sends a
  // top-level GET redirect. The opaque, one-use state is HMACed in PostgreSQL
  // and is additionally bound to the same authenticated browser session.
  app.get<{
    Querystring: { state?: string; code?: string; error?: string; errorCode?: string };
  }>("/api/auth/ctrader/callback", async (request, reply) => {
    const fallback = (code: string) => sendCallbackRedirect(reply, fixedAppRedirect(app, "error", code));
    const currentService = service;
    if (!currentService) return fallback("configuration_error");
    const auth = await callbackAuth(app, request);
    if (!auth) return fallback("state_invalid");
    const stateResult = stateSchema.safeParse(request.query.state);
    if (!stateResult.success) return fallback("state_invalid");

    const providerError = request.query.error ?? request.query.errorCode;
    if (providerError) {
      try {
        await currentService.rejectOAuth(stateResult.data, auth);
      } catch (error) {
        request.log.warn({ error }, "Rejected cTrader callback had invalid state");
        return fallback("state_invalid");
      }
      return fallback(providerError === "access_denied" ? "access_denied" : "oauth_denied");
    }

    const codeResult = authCodeSchema.safeParse(request.query.code);
    if (!codeResult.success) {
      await currentService.rejectOAuth(stateResult.data, auth).catch(() => undefined);
      return fallback("exchange_failed");
    }
    try {
      await currentService.completeOAuth(stateResult.data, codeResult.data, auth);
      return sendCallbackRedirect(reply, fixedAppRedirect(app, "select"));
    } catch (error) {
      // Never include the provider's message, token, code, state, or a dynamic
      // return URL in the browser redirect.
      request.log.warn({ errorName: error instanceof Error ? error.name : "unknown" }, "cTrader OAuth callback failed");
      return fallback(callbackErrorCode(error));
    }
  });

  app.get("/api/ctrader/oauth/pending", protectedRead, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return enabledService().pendingOAuth(request.auth!);
  });

  app.post(
    "/api/ctrader/mcp/connect",
    {
      ...protectedWrite,
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      if (!app.config.cTrader.mcpEnabled) {
        throw new AppError(503, "CTRADER_MCP_NOT_CONFIGURED", "cTrader MCP compatibility is not enabled on this server");
      }
      const body = connectMcpSchema.parse(request.body);
      const connection = await enabledService().connectMcp({
        auth: request.auth!,
        configuration: body.configuration,
        environment: body.environment,
        accountId: body.accountId ?? null,
        mappedLegacyAccountId: body.mappedLegacyAccountId ?? null,
        label: body.label ?? null,
        acknowledgeNoOpenPositionsAtConnect: body.acknowledgeNoOpenPositionsAtConnect === true,
      });
      return reply.code(200).send({ connection });
    },
  );

  app.get("/api/ctrader/connections", protectedRead, async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    return { connections: await enabledService().listConnections(request.auth!.user.id) };
  });

  app.post("/api/ctrader/connections", protectedWrite, async (request, reply) => {
    const body = createConnectionSchema.parse(request.body);
    const connection = await enabledService().createConnection({
      auth: request.auth!,
      grantId: body.grantId,
      ctidTraderAccountId: body.ctidTraderAccountId,
      mappedLegacyAccountId: body.mappedLegacyAccountId ?? null,
      label: body.label ?? null,
    });
    return reply.code(200).send({ connection });
  });

  app.get<{ Params: { id: string } }>(
    "/api/ctrader/connections/:id/status",
    protectedRead,
    async (request, reply) => {
      const id = connectionIdSchema.parse(request.params.id);
      reply.header("Cache-Control", "no-store");
      return enabledService().connectionStatus(request.auth!.user.id, id);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: string; cursor?: string } }>(
    "/api/ctrader/connections/:id/cash-flows",
    protectedRead,
    async (request, reply) => {
      const connectionId = connectionIdSchema.parse(request.params.id);
      const query = accountCashFlowQuerySchema.parse(request.query);
      reply.header("Cache-Control", "no-store");
      return enabledService().listAccountCashFlows({
        userId: request.auth!.user.id,
        connectionId,
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
    },
  );

  app.get<{ Params: { id: string; candidateId: string } }>(
    "/api/ctrader/connections/:id/live-reconciliation/:candidateId",
    protectedRead,
    async (request, reply) => {
      const connectionId = connectionIdSchema.parse(request.params.id);
      const candidateId = reconciliationCandidateIdSchema.parse(request.params.candidateId);
      reply.header("Cache-Control", "no-store");
      return enabledService().getLiveReconciliationCandidate(
        request.auth!.user.id,
        connectionId,
        candidateId,
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/ctrader/connections/:id/sync",
    protectedWrite,
    async (request, reply) => {
      const id = connectionIdSchema.parse(request.params.id);
      const queued = await enabledService().queueManualSync(request.auth!.user.id, id);
      return reply.code(202).send(queued);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/ctrader/connections/:id/historical-imports",
    {
      ...protectedWrite,
      config: { rateLimit: { max: 3, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const connectionId = connectionIdSchema.parse(request.params.id);
      const body = historicalImportSchema.parse(request.body);
      const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
      if (idempotencyKey !== body.clientRequestId) {
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key must match clientRequestId");
      }
      const historicalImport = await enabledService().startHistoricalImport({
        auth: request.auth!,
        connectionId,
        boundaryLocal: body.boundaryLocal,
        timeZone: body.timeZone,
        boundaryAt: body.boundaryAt,
        acknowledgeNoOpenPositionsAtBoundary: true,
        clientRequestId: body.clientRequestId,
        idempotencyKey,
      });
      return reply.code(historicalImport.replayed ? 200 : 202).send({ historicalImport });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/ctrader/connections/:id/historical-imports/current",
    protectedRead,
    async (request, reply) => {
      const connectionId = connectionIdSchema.parse(request.params.id);
      reply.header("Cache-Control", "no-store");
      return { historicalImport: await enabledService().currentHistoricalImport(request.auth!.user.id, connectionId) };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { importId?: string } }>(
    "/api/ctrader/connections/:id/reconciliation",
    protectedRead,
    async (request, reply) => {
      const connectionId = connectionIdSchema.parse(request.params.id);
      const query = reconciliationQuerySchema.parse(request.query);
      reply.header("Cache-Control", "no-store");
      return enabledService().listReconciliationCandidates(
        request.auth!.user.id,
        connectionId,
        query.importId,
      );
    },
  );

  app.post<{ Params: { id: string; candidateId: string } }>(
    "/api/ctrader/connections/:id/reconciliation/:candidateId/resolve",
    protectedWrite,
    async (request) => {
      const connectionId = connectionIdSchema.parse(request.params.id);
      const candidateId = reconciliationCandidateIdSchema.parse(request.params.candidateId);
      const body = resolveCandidateSchema.parse(request.body);
      const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
      if (idempotencyKey !== body.clientRequestId) {
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key must match clientRequestId");
      }
      const ifMatch = request.headers["if-match"];
      if (ifMatch === undefined) {
        throw new AppError(428, "PRECONDITION_REQUIRED", "If-Match is required to resolve a candidate");
      }
      if (ifMatch !== `\"${body.version}\"` && ifMatch !== String(body.version)) {
        throw new AppError(409, "VERSION_CONFLICT", "The reconciliation candidate changed; reload before deciding");
      }
      return enabledService().resolveReconciliationCandidate({
        auth: request.auth!,
        connectionId,
        candidateId,
        importId: body.importId,
        action: body.action,
        expectedVersion: body.version,
        clientRequestId: body.clientRequestId,
        idempotencyKey,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/ctrader/connections/:id/live-reconciliation",
    protectedRead,
    async (request, reply) => {
      const connectionId = connectionIdSchema.parse(request.params.id);
      reply.header("Cache-Control", "no-store");
      return enabledService().listLiveReconciliationCandidates(request.auth!.user.id, connectionId);
    },
  );

  app.post<{ Params: { id: string; candidateId: string } }>(
    "/api/ctrader/connections/:id/live-reconciliation/:candidateId/resolve",
    protectedWrite,
    async (request) => {
      const connectionId = connectionIdSchema.parse(request.params.id);
      const candidateId = reconciliationCandidateIdSchema.parse(request.params.candidateId);
      const body = resolveLiveCandidateSchema.parse(request.body);
      const idempotencyKey = idempotencyKeySchema.parse(request.headers["idempotency-key"]);
      if (idempotencyKey !== body.clientRequestId) {
        throw new AppError(409, "IDEMPOTENCY_CONFLICT", "Idempotency-Key must match clientRequestId");
      }
      const ifMatch = request.headers["if-match"];
      if (ifMatch === undefined) {
        throw new AppError(428, "PRECONDITION_REQUIRED", "If-Match is required to resolve a candidate");
      }
      if (ifMatch !== `\"${body.version}\"` && ifMatch !== String(body.version)) {
        throw new AppError(409, "VERSION_CONFLICT", "The reconciliation candidate changed; reload before deciding");
      }
      return enabledService().resolveLiveReconciliationCandidate({
        auth: request.auth!,
        connectionId,
        candidateId,
        action: body.action,
        manualTradeId: body.manualTradeId ?? null,
        expectedVersion: body.version,
        clientRequestId: body.clientRequestId,
        idempotencyKey,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/ctrader/connections/:id/disconnect",
    protectedWrite,
    async (request, reply) => {
      const id = connectionIdSchema.parse(request.params.id);
      await enabledService().disconnect(request.auth!.user.id, id);
      return reply.code(204).send();
    },
  );
}
