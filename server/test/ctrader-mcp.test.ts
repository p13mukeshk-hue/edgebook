import { describe, expect, it, vi } from "vitest";
import {
  CTRADER_MCP_ENDPOINT,
  CTraderMcpError,
  CTraderMcpReadClient,
  parseCTraderMcpConfiguration,
  validateCTraderMcpConfiguration,
} from "../src/ctrader/mcp.js";

const TOKEN = "eyJwbGFudCI6InRoZTVlcnMiLCJ0b2tlbiI6ImZpeGVkIn0=";

function response(
  body: string | null,
  options: { status?: number; contentType?: string; sessionId?: string; url?: string; redirected?: boolean } = {},
): Response {
  const headers = new Headers();
  if (options.contentType !== undefined) headers.set("content-type", options.contentType);
  if (options.sessionId !== undefined) headers.set("mcp-session-id", options.sessionId);
  const result = new Response(body, { status: options.status ?? 200, headers });
  if (options.url !== undefined) Object.defineProperty(result, "url", { value: options.url });
  if (options.redirected !== undefined) Object.defineProperty(result, "redirected", { value: options.redirected });
  return result;
}

function rpc(id: number, result: unknown, sessionId?: string): Response {
  return response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    contentType: "application/json",
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

function initialized(session = "safe-session-id"): Response {
  return rpc(1, {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "cTrader", version: "1" },
  }, session);
}

function tool(id: number, value: unknown): Response {
  return rpc(id, { content: [{ type: "text", text: JSON.stringify(value) }] });
}

function queuedFetch(queue: Response[]): { fetchImplementation: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImplementation: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), ...(init === undefined ? {} : { init }) });
    const next = queue.shift();
    if (next === undefined) throw new Error("Unexpected fetch");
    return next;
  };
  return { fetchImplementation, calls };
}

function postedJson(call: { init?: RequestInit }): Record<string, unknown> {
  if (typeof call.init?.body !== "string") throw new Error("Expected a JSON body");
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

describe("parseCTraderMcpConfiguration", () => {
  it("accepts the legacy bare token and the copied JSON configuration", () => {
    expect(parseCTraderMcpConfiguration(TOKEN)).toEqual({ bearerToken: TOKEN });
    expect(parseCTraderMcpConfiguration(`Bearer ${TOKEN}`)).toEqual({ bearerToken: TOKEN });
    expect(parseCTraderMcpConfiguration(JSON.stringify({
      mcpServers: {
        cTrader: {
          url: CTRADER_MCP_ENDPOINT,
          headers: { Authorization: `Bearer ${TOKEN}` },
        },
      },
    }))).toEqual({ bearerToken: TOKEN });
  });

  it("accepts a copied TOML-style configuration", () => {
    const copied = `[mcp_servers.ctrader]\nurl = "${CTRADER_MCP_ENDPOINT}"\nhttp_headers = { Authorization = "Bearer ${TOKEN}" }`;
    expect(parseCTraderMcpConfiguration(copied)).toEqual({ bearerToken: TOKEN });
  });

  it("rejects other endpoints, ambiguous credentials, and unsafe tokens", () => {
    const otherEndpoint = JSON.stringify({
      url: "https://attacker.example/mcp",
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(() => parseCTraderMcpConfiguration(otherEndpoint)).toThrowError(
      expect.objectContaining({ code: "ENDPOINT_REJECTED" }),
    );
    expect(() => parseCTraderMcpConfiguration(`token=${TOKEN}\ntoken=another-valid-token-value`)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
    expect(() => parseCTraderMcpConfiguration("short")).toThrowError(
      expect.objectContaining({ code: "TOKEN_INVALID" }),
    );
    expect(() => parseCTraderMcpConfiguration(`${TOKEN}\nsecond-line`)).toThrowError(
      expect.objectContaining({ code: "CONFIG_INVALID" }),
    );
  });
});

describe("CTraderMcpReadClient", () => {
  it("initializes one session and calls only the fixed read methods", async () => {
    const mock = queuedFetch([
      initialized(),
      response(null, { status: 202 }),
      rpc(2, { tools: [
         { name: "place_order" },
         { name: "get_balance" },
         { name: "get_assets" },
         { name: "get_symbols" },
        { name: "get_deals" },
        { name: "get_position_details" },
      ] }),
       tool(3, { balance: 100_000, currency: "USD" }),
       tool(4, { assets: [{ assetId: 15, name: "USD" }] }),
       tool(5, [{ id: 1, name: "EURUSD" }]),
       tool(6, [{ dealId: "77" }]),
       tool(7, { position: { positionId: 77 }, deals: [{ dealId: 77 }] }),
    ]);
    const client = new CTraderMcpReadClient(TOKEN, { fetchImplementation: mock.fetchImplementation });

     await expect(client.getBalance()).resolves.toEqual({ balance: 100_000, currency: "USD" });
     await expect(client.getAssets()).resolves.toEqual({ assets: [{ assetId: 15, name: "USD" }] });
    await expect(client.getSymbols()).resolves.toEqual([{ id: 1, name: "EURUSD" }]);
    await expect(client.getDeals({
      fromTimestamp: "2026-08-01T00:00:00.000Z",
      toTimestamp: "2026-08-11T00:00:00.000Z",
    })).resolves.toEqual([{ dealId: "77" }]);
    await expect(client.getPositionDetails("77")).resolves.toEqual({
      position: { positionId: 77 },
      deals: [{ dealId: 77 }],
    });

     expect(mock.calls).toHaveLength(8);
    expect(mock.calls.every((call) => call.url === CTRADER_MCP_ENDPOINT)).toBe(true);
    expect(mock.calls.every((call) => call.init?.redirect === "error")).toBe(true);
    const initialization = postedJson(mock.calls[0]!);
    expect(initialization.method).toBe("initialize");
    expect(postedJson(mock.calls[2]!).method).toBe("tools/list");
    const toolNames = mock.calls.slice(3).map((call) => {
      const body = postedJson(call);
      return (body.params as Record<string, unknown>).name;
    });
     expect(toolNames).toEqual(["get_balance", "get_assets", "get_symbols", "get_deals", "get_position_details"]);
    const headers = new Headers(mock.calls[3]!.init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(headers.get("mcp-session-id")).toBe("safe-session-id");
    expect("callTool" in client).toBe(false);
  });

  it("parses SSE responses and keeps unreviewed tools out of account discovery", async () => {
    const initSse = response(
      `event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1,"result":{"protocolVersion":"2024-11-05"}}\n\n`,
      { contentType: "text/event-stream; charset=utf-8", sessionId: "sse-session" },
    );
    const accountSse = response(
      `: heartbeat\nevent: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\\"accountId\\":\\"5\\"}"}]}}\n\n`,
      { contentType: "text/event-stream" },
    );
    const mock = queuedFetch([
      initSse,
      response(null, { status: 202 }),
      rpc(2, { tools: [{ name: "place_order" }, { name: "get_account_info" }] }),
      accountSse,
    ]);
    const client = new CTraderMcpReadClient(TOKEN, { fetchImplementation: mock.fetchImplementation });

    await expect(client.getAccountInfo()).resolves.toEqual({ accountId: "5" });
    expect((postedJson(mock.calls[2]!).method)).toBe("tools/list");
    const accountCall = postedJson(mock.calls[3]!);
    expect((accountCall.params as Record<string, unknown>).name).toBe("get_account_info");
    expect(mock.calls.map((call) => call.init?.body).join(" ")).not.toContain("place_order\",\"arguments");
  });

  it("rejects invalid deal windows before sending a request", async () => {
    const mock = queuedFetch([]);
    const client = new CTraderMcpReadClient(TOKEN, { fetchImplementation: mock.fetchImplementation });
    await expect(client.getDeals({
      fromTimestamp: "2026-01-01T00:00:00.000Z",
      toTimestamp: "2026-02-01T00:00:00.001Z",
    })).rejects.toMatchObject({ code: "DEAL_RANGE_INVALID" });
    expect(mock.calls).toHaveLength(0);
  });

  it("rejects unsafe position IDs before calling the read-only detail tool", async () => {
    const mock = queuedFetch([]);
    const client = new CTraderMcpReadClient(TOKEN, { fetchImplementation: mock.fetchImplementation });
    await expect(client.getPositionDetails("1.5")).rejects.toMatchObject({ code: "DEAL_RANGE_INVALID" });
    await expect(client.getPositionDetails("9007199254740992")).rejects.toMatchObject({ code: "DEAL_RANGE_INVALID" });
    expect(mock.calls).toHaveLength(0);
  });

  it("validates that the supplied account exposes a history-capable read tool", async () => {
    const mock = queuedFetch([
      initialized(),
      response(null, { status: 202 }),
      rpc(2, { tools: [{ name: "get_balance" }, { name: "get_symbols" }, { name: "get_deals" }] }),
      tool(3, { balance: 42 }),
      tool(4, [{ name: "XAUUSD" }]),
      tool(5, []),
    ]);
    const result = await validateCTraderMcpConfiguration(TOKEN, { fetchImplementation: mock.fetchImplementation });
    expect(result).toEqual({
      bearerToken: TOKEN,
      balance: { balance: 42 },
      symbols: [{ name: "XAUUSD" }],
      historyProbe: [],
      accountInfo: null,
    });
    const historyCall = postedJson(mock.calls[5]!);
    expect((historyCall.params as Record<string, unknown>).name).toBe("get_deals");
  });

  it("rejects redirects and never includes credentials or remote response text in errors", async () => {
    const secretResponse = `rejected ${TOKEN} private-account-data`;
    const mock = queuedFetch([
      response(secretResponse, {
        status: 401,
        contentType: "text/plain",
        url: "https://attacker.example/harvest",
        redirected: true,
      }),
    ]);
    const client = new CTraderMcpReadClient(TOKEN, { fetchImplementation: mock.fetchImplementation });
    let failure: unknown;
    try { await client.initialize(); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(CTraderMcpError);
    expect(failure).toMatchObject({ code: "REDIRECT_REJECTED" });
    const message = failure instanceof Error ? failure.message : String(failure);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain("private-account-data");
  });

  it.each([
    [401, "AUTH_REJECTED"],
    [403, "AUTH_REJECTED"],
    [429, "REMOTE_RATE_LIMITED"],
    [500, "REMOTE_UNAVAILABLE"],
    [400, "REMOTE_REJECTED"],
  ] as const)("classifies HTTP %s without exposing its response body", async (status, code) => {
    const mock = queuedFetch([response(`private ${TOKEN}`, { status, contentType: "text/plain" })]);
    const client = new CTraderMcpReadClient(TOKEN, { fetchImplementation: mock.fetchImplementation });
    let failure: unknown;
    try { await client.initialize(); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code });
    expect(failure instanceof Error ? failure.message : String(failure)).not.toContain(TOKEN);
  });

  it("enforces response limits and request timeouts with generic errors", async () => {
    const oversized = queuedFetch([
      response("x".repeat(1_100), { contentType: "application/json", sessionId: "session" }),
    ]);
    const limitedClient = new CTraderMcpReadClient(TOKEN, {
      fetchImplementation: oversized.fetchImplementation,
      maxResponseBytes: 1024,
    });
    await expect(limitedClient.initialize()).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });

    vi.useFakeTimers();
    try {
      const hangingFetch: typeof fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("secret transport failure")), { once: true });
      });
      const timeoutClient = new CTraderMcpReadClient(TOKEN, {
        fetchImplementation: hangingFetch,
        requestTimeoutMs: 100,
      });
      const assertion = expect(timeoutClient.initialize()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(101);
      await assertion;

      const slowBodyFetch: typeof fetch = async (_input, init) => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(new Error("secret body error")), { once: true });
          },
        });
        return new Response(stream, {
          headers: { "content-type": "application/json", "mcp-session-id": "slow-session" },
        });
      };
      const slowBodyClient = new CTraderMcpReadClient(TOKEN, {
        fetchImplementation: slowBodyFetch,
        requestTimeoutMs: 100,
      });
      const bodyAssertion = expect(slowBodyClient.initialize()).rejects.toMatchObject({ code: "REQUEST_TIMEOUT" });
      await vi.advanceTimersByTimeAsync(101);
      await bodyAssertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
