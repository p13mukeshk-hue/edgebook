import type { FastifyReply } from "fastify";
import type { AppConfig } from "../config.js";

export type AuthCookieNames = { session: string; csrf: string };

export function authCookieNames(config: AppConfig): AuthCookieNames {
  return config.cookieSecure
    ? { session: "__Host-edgebook_session", csrf: "__Host-edgebook_csrf" }
    : { session: "edgebook_session", csrf: "edgebook_csrf" };
}

export function setAuthCookies(
  reply: FastifyReply,
  config: AppConfig,
  sessionToken: string,
  csrfToken: string,
): void {
  const names = authCookieNames(config);
  const maxAge = config.sessionTtlDays * 24 * 60 * 60;
  reply.setCookie(names.session, sessionToken, {
    path: "/",
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    maxAge,
  });
  reply.setCookie(names.csrf, csrfToken, {
    path: "/",
    httpOnly: false,
    secure: config.cookieSecure,
    sameSite: "strict",
    maxAge,
  });
}

export function clearAuthCookies(reply: FastifyReply, config: AppConfig): void {
  const names = authCookieNames(config);
  const options = { path: "/", secure: config.cookieSecure };
  reply.clearCookie(names.session, options);
  reply.clearCookie(names.csrf, options);
}
