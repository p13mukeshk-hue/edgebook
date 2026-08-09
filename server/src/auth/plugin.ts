import fp from "fastify-plugin";
import { AppError } from "../lib/errors.js";
import type { AuthContext } from "../types.js";
import { authCookieNames, clearAuthCookies } from "./cookies.js";
import { hashToken, safeBufferEqual, safeEqual } from "./tokens.js";

type SessionRow = {
  session_id: string;
  csrf_hash: Buffer;
  user_id: string;
  legacy_firebase_uid: string | null;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
};

export const authPlugin = fp(async (app) => {
  app.decorateRequest("auth", null);

  async function loadAuthContext(sessionToken: string): Promise<AuthContext | null> {
    const tokenHash = hashToken(sessionToken, app.config.sessionPepper);
    const result = await app.db.query<SessionRow>(
      `SELECT s.id AS session_id, s.csrf_hash,
              u.id AS user_id, u.legacy_firebase_uid, u.email, u.display_name, u.avatar_url
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.idle_expires_at > now()
         AND u.disabled_at IS NULL
       LIMIT 1`,
      [tokenHash],
    );
    const row = result.rows[0];
    if (!row) return null;

    void app.db
      .query(
        `UPDATE sessions
         SET last_seen_at = now(),
             idle_expires_at = LEAST(expires_at, now() + ($2::int * interval '1 minute'))
         WHERE id = $1 AND last_seen_at < now() - interval '5 minutes'`,
        [row.session_id, app.config.sessionIdleMinutes],
      )
      .catch((error: unknown) => app.log.warn(
        { errorName: error instanceof Error ? error.name : "UnknownError", sessionId: row.session_id },
        "Failed to refresh session activity",
      ));

    return {
      sessionId: row.session_id,
      csrfHash: row.csrf_hash,
      user: {
        id: row.user_id,
        legacyFirebaseUid: row.legacy_firebase_uid,
        email: row.email,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
      },
    };
  }

  app.decorate("authenticate", async (request, reply) => {
    const names = authCookieNames(app.config);
    const token = request.cookies[names.session];
    if (!token) throw new AppError(401, "UNAUTHENTICATED", "Authentication is required");
    const auth = await loadAuthContext(token);
    if (!auth) {
      clearAuthCookies(reply, app.config);
      throw new AppError(401, "SESSION_EXPIRED", "The session is invalid or expired");
    }
    request.auth = auth;
  });

  app.decorate("requireCsrf", async (request) => {
    if (!request.auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication is required");
    const names = authCookieNames(app.config);
    const cookieToken = request.cookies[names.csrf];
    const headerValue = request.headers["x-csrf-token"];
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    if (!cookieToken || !headerToken || !safeEqual(cookieToken, headerToken)) {
      throw new AppError(403, "CSRF_INVALID", "The CSRF token is missing or invalid");
    }
    const submittedHash = hashToken(headerToken, app.config.sessionPepper);
    if (!safeBufferEqual(submittedHash, request.auth.csrfHash)) {
      throw new AppError(403, "CSRF_INVALID", "The CSRF token is missing or invalid");
    }
  });

  app.decorate("loadOptionalSession", loadAuthContext);
  app.decorate("isSessionActive", async (sessionId: string, userId: string) => {
    const result = await app.db.query(
      `SELECT 1
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.user_id = $2
         AND s.revoked_at IS NULL
         AND s.expires_at > now()
         AND s.idle_expires_at > now()
         AND u.disabled_at IS NULL
       LIMIT 1`,
      [sessionId, userId],
    );
    return Boolean(result.rows[0]);
  });
});

declare module "fastify" {
  interface FastifyInstance {
    loadOptionalSession(sessionToken: string): Promise<AuthContext | null>;
    isSessionActive(sessionId: string, userId: string): Promise<boolean>;
  }
}
