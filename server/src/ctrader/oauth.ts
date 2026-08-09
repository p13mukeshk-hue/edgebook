import type { CTraderConfig } from "../config.js";

const AUTHORIZE_ENDPOINT = "https://id.ctrader.com/my/settings/openapi/grantingaccess/";
const TOKEN_ENDPOINT = "https://openapi.ctrader.com/apps/token";

export type CTraderTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
};

export interface CTraderOAuthClient {
  authorizationUrl(state: string): string;
  exchangeAuthorizationCode(code: string): Promise<CTraderTokenSet>;
  refresh(refreshToken: string): Promise<CTraderTokenSet>;
}

type FetchLike = typeof fetch;

export class CTraderOAuthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CTraderOAuthError";
    this.code = code;
  }
}

export class OfficialCTraderOAuthClient implements CTraderOAuthClient {
  readonly #config: CTraderConfig;
  readonly #fetch: FetchLike;

  constructor(config: CTraderConfig, fetchImplementation: FetchLike = fetch) {
    if (!config.enabled || config.clientId === null || config.clientSecret === null || config.redirectUri === null) {
      throw new Error("cTrader OAuth is not configured");
    }
    this.#config = config;
    this.#fetch = fetchImplementation;
  }

  authorizationUrl(state: string): string {
    const url = new URL(AUTHORIZE_ENDPOINT);
    url.searchParams.set("client_id", this.#required("clientId"));
    url.searchParams.set("redirect_uri", this.#required("redirectUri"));
    url.searchParams.set("scope", "accounts");
    url.searchParams.set("product", "web");
    url.searchParams.set("state", state);
    return url.toString();
  }

  exchangeAuthorizationCode(code: string): Promise<CTraderTokenSet> {
    if (code.length === 0) throw new CTraderOAuthError("AUTH_CODE_INVALID", "The authorization code is empty");
    return this.#requestToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.#required("redirectUri"),
    });
  }

  refresh(refreshToken: string): Promise<CTraderTokenSet> {
    if (refreshToken.length === 0) throw new CTraderOAuthError("REFRESH_TOKEN_INVALID", "The refresh token is empty");
    return this.#requestToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  }

  async #requestToken(parameters: Readonly<Record<string, string>>): Promise<CTraderTokenSet> {
    const url = new URL(TOKEN_ENDPOINT);
    url.searchParams.set("client_id", this.#required("clientId"));
    url.searchParams.set("client_secret", this.#required("clientSecret"));
    for (const [key, value] of Object.entries(parameters)) url.searchParams.set(key, value);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
      });
    } catch (error) {
      throw new CTraderOAuthError(
        "TOKEN_ENDPOINT_UNAVAILABLE",
        error instanceof Error && error.name === "TimeoutError"
          ? "The cTrader token endpoint timed out"
          : "The cTrader token endpoint is unavailable",
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new CTraderOAuthError("TOKEN_RESPONSE_INVALID", "The cTrader token endpoint returned invalid JSON");
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new CTraderOAuthError("TOKEN_RESPONSE_INVALID", "The cTrader token endpoint returned an invalid response");
    }
    const payload = body as Record<string, unknown>;
    if (!response.ok || typeof payload.errorCode === "string") {
      throw new CTraderOAuthError(
        typeof payload.errorCode === "string" ? payload.errorCode : "TOKEN_EXCHANGE_REJECTED",
        typeof payload.description === "string" ? payload.description : "cTrader rejected the token request",
      );
    }
    if (
      typeof payload.accessToken !== "string"
      || payload.accessToken.length === 0
      || typeof payload.refreshToken !== "string"
      || payload.refreshToken.length === 0
      || typeof payload.tokenType !== "string"
    ) {
      throw new CTraderOAuthError("TOKEN_RESPONSE_INVALID", "The cTrader token response is incomplete");
    }
    const expiresIn = typeof payload.expiresIn === "number"
      ? payload.expiresIn
      : typeof payload.expiresIn === "string"
        ? Number(payload.expiresIn)
        : Number.NaN;
    if (!Number.isInteger(expiresIn) || expiresIn <= 0 || expiresIn > 31_536_000) {
      throw new CTraderOAuthError("TOKEN_RESPONSE_INVALID", "The cTrader token expiry is invalid");
    }
    return {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      tokenType: payload.tokenType,
      expiresIn,
    };
  }

  #required(key: "clientId" | "clientSecret" | "redirectUri"): string {
    const value = this.#config[key];
    if (value === null) throw new Error(`cTrader ${key} is not configured`);
    return value;
  }
}
