import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import type { Database } from "./db/database.js";
import type { EventBus } from "./events/event-bus.js";
import type { ScreenshotStorage } from "./uploads/storage.js";

export type AuthUser = {
  id: string;
  legacyFirebaseUid: string | null;
  email: string;
  displayName: string | null;
  avatarUrl: string | null;
};

export type AuthContext = {
  sessionId: string;
  csrfHash: Buffer;
  user: AuthUser;
};

export type RouteGuard = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    config: AppConfig;
    db: Database;
    events: EventBus;
    screenshotStorage: ScreenshotStorage;
    authenticate: RouteGuard;
    requireCsrf: RouteGuard;
  }

  interface FastifyRequest {
    auth: AuthContext | null;
  }
}
