import { describe, expect, it, vi } from "vitest";
import type { CTraderConfig } from "../src/config.js";
import { OfficialCTraderOAuthClient } from "../src/ctrader/oauth.js";

const config: CTraderConfig = {
  enabled: true,
  available: true,
  mcpEnabled: false,
  storageEnabled: true,
  clientId: "client-id",
  clientSecret: "client-secret",
  redirectUri: "https://edgebook.test/api/auth/ctrader/callback",
  encryptionKeysJson: JSON.stringify({ 1: Buffer.alloc(32).toString("base64url") }),
  activeKeyVersion: 1,
  oauthStateTtlSeconds: 300,
  grantTtlSeconds: 600,
  requestTimeoutMs: 15_000,
  syncIntervalSeconds: 300,
  staleAfterSeconds: 900,
  syncOverlapSeconds: 300,
  historyStartTimestamp: null,
  refreshSkewSeconds: 300,
  maxDealsPerRequest: 1_000,
  symbolCacheSeconds: 86_400,
  tradingTimeZone: "Asia/Kolkata",
  schedulerEnabled: false,
};

describe("official cTrader OAuth client", () => {
  it("always requests the read-only accounts scope", () => {
    const client = new OfficialCTraderOAuthClient(config, vi.fn() as never);
    const url = new URL(client.authorizationUrl("opaque-state"));
    expect(url.protocol).toBe("https:");
    expect(url.searchParams.get("scope")).toBe("accounts");
    expect(url.searchParams.get("product")).toBe("web");
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
  });

  it("accepts and returns the provider's rotated refresh token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      accessToken: "next-access",
      refreshToken: "next-refresh",
      tokenType: "bearer",
      expiresIn: 2_628_000,
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const client = new OfficialCTraderOAuthClient(config, fetchMock as typeof fetch);
    await expect(client.refresh("old-refresh")).resolves.toMatchObject({
      accessToken: "next-access",
      refreshToken: "next-refresh",
    });
    const requested = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requested.searchParams.get("grant_type")).toBe("refresh_token");
    expect(requested.searchParams.get("refresh_token")).toBe("old-refresh");
  });
});
