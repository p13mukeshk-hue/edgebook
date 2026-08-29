import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { OAuth2Client, type TokenPayload } from "google-auth-library";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import type { AuthContext, AuthUser } from "../types.js";
import { authCookieNames, clearAuthCookies, setAuthCookies } from "./cookies.js";
import { createOpaqueToken, hashToken, safeBufferEqual } from "./tokens.js";

const loginSchema = z.object({ credential: z.string().min(100).max(16_384) }).strict();

export interface GoogleTokenVerifier {
  verify(credential: string, audience: string): Promise<TokenPayload>;
}

export class GoogleIdentityVerifier implements GoogleTokenVerifier {
  readonly #client = new OAuth2Client();

  public async verify(credential: string, audience: string): Promise<TokenPayload> {
    const ticket = await this.#client.verifyIdToken({ idToken: credential, audience });
    const payload = ticket.getPayload();
    if (!payload) throw new AppError(401, "GOOGLE_TOKEN_INVALID", "Google did not return a valid identity");
    return payload;
  }
}

type UserRow = {
  id: string;
  legacy_firebase_uid: string | null;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
  disabled_at: Date | string | null;
};

function mapUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    legacyFirebaseUid: row.legacy_firebase_uid,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
  };
}

async function ensureCsrf(app: FastifyInstance, auth: AuthContext, cookieToken: string | undefined): Promise<string> {
  if (cookieToken) {
    const cookieHash = hashToken(cookieToken, app.config.sessionPepper);
    if (safeBufferEqual(cookieHash, auth.csrfHash)) return cookieToken;
  }
  const csrfToken = createOpaqueToken();
  const csrfHash = hashToken(csrfToken, app.config.sessionPepper);
  await app.db.query("UPDATE sessions SET csrf_hash = $2 WHERE id = $1", [auth.sessionId, csrfHash]);
  auth.csrfHash = csrfHash;
  return csrfToken;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  verifier: GoogleTokenVerifier = new GoogleIdentityVerifier(),
): Promise<void> {
  app.get("/api/auth/session", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const names = authCookieNames(app.config);
    const sessionToken = request.cookies[names.session];
    if (!sessionToken) return { user: null };
    const auth = await app.loadOptionalSession(sessionToken);
    if (!auth) {
      clearAuthCookies(reply, app.config);
      return { user: null };
    }
    const csrfToken = await ensureCsrf(app, auth, request.cookies[names.csrf]);
    setAuthCookies(reply, app.config, sessionToken, csrfToken);
    return { user: auth.user, csrfToken };
  });

  app.post(
    "/api/auth/google",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const { credential } = loginSchema.parse(request.body);
      let payload: TokenPayload;
      try {
        payload = await verifier.verify(credential, app.config.googleClientId);
      } catch {
        // google-auth-library parse errors can include the submitted JWT.
        // Never attach the verifier exception to logs; the fixed audit message
        // is sufficient and contains no credential or token claims.
        request.log.info("Rejected Google credential");
        throw new AppError(401, "GOOGLE_TOKEN_INVALID", "The Google identity token is invalid or expired");
      }
      if (!payload.sub || !payload.email || payload.email_verified !== true) {
        throw new AppError(403, "GOOGLE_ACCOUNT_UNVERIFIED", "A verified Google email address is required");
      }

      const newUserId = randomUUID();
      const userResult = await app.db.query<UserRow>(
        `INSERT INTO users (id, google_sub, email, email_verified, display_name, avatar_url)
         VALUES ($1, $2, $3, true, $4, $5)
         ON CONFLICT (google_sub) DO UPDATE SET
           email = EXCLUDED.email,
           email_verified = true,
           display_name = EXCLUDED.display_name,
           avatar_url = EXCLUDED.avatar_url
         RETURNING id, legacy_firebase_uid, email, display_name, avatar_url, disabled_at`,
        [newUserId, payload.sub, payload.email, payload.name ?? null, payload.picture ?? null],
      );
      const row = userResult.rows[0];
      if (!row) throw new Error("Failed to persist Google user");
      if (row.disabled_at != null) {
        throw new AppError(403, "ACCOUNT_DISABLED", "This Edgebook account is disabled");
      }

      const sessionId = randomUUID();
      const sessionToken = createOpaqueToken();
      const csrfToken = createOpaqueToken();
      const tokenHash = hashToken(sessionToken, app.config.sessionPepper);
      const csrfHash = hashToken(csrfToken, app.config.sessionPepper);
      const userAgent = request.headers["user-agent"]?.slice(0, 1_024) ?? null;

      await app.db.query(
        `INSERT INTO sessions
          (id, user_id, token_hash, csrf_hash, user_agent, ip_address, idle_expires_at, expires_at)
         VALUES
          ($1, $2, $3, $4, $5, $6::inet,
           LEAST(now() + ($7::int * interval '1 minute'), now() + ($8::int * interval '1 day')),
           now() + ($8::int * interval '1 day'))`,
        [
          sessionId,
          row.id,
          tokenHash,
          csrfHash,
          userAgent,
          request.ip,
          app.config.sessionIdleMinutes,
          app.config.sessionTtlDays,
        ],
      );
      await app.db.query(
        `UPDATE sessions SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL AND id NOT IN (
           SELECT id FROM sessions WHERE user_id = $1 AND revoked_at IS NULL
           ORDER BY created_at DESC LIMIT 10
         )`,
        [row.id],
      );
      await app.db.query(
        `INSERT INTO audit_events (user_id, session_id, event_type, ip_address, user_agent)
         VALUES ($1, $2, 'auth.login', $3::inet, $4)`,
        [row.id, sessionId, request.ip, userAgent],
      );

      setAuthCookies(reply, app.config, sessionToken, csrfToken);
      return reply.code(200).send({ user: mapUser(row), csrfToken });
    },
  );

  app.post(
    "/api/auth/logout",
    { preHandler: [app.authenticate, app.requireCsrf] },
    async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new AppError(401, "UNAUTHENTICATED", "Authentication is required");
      await app.db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1", [auth.sessionId]);
      await app.db.query(
        `INSERT INTO audit_events (user_id, session_id, event_type, ip_address, user_agent)
         VALUES ($1, $2, 'auth.logout', $3::inet, $4)`,
        [auth.user.id, auth.sessionId, request.ip, request.headers["user-agent"]?.slice(0, 1_024) ?? null],
      );
      clearAuthCookies(reply, app.config);
      return reply.code(204).send();
    },
  );
}
