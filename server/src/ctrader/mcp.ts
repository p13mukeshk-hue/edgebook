export const CTRADER_MCP_ENDPOINT = "https://mcp.ctrader.com/trading/mcp";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SUPPORTED_PROTOCOL_VERSIONS = new Set([MCP_PROTOCOL_VERSION, "2025-03-26", "2025-06-18"]);
const MAX_CONFIGURATION_BYTES = 32 * 1024;
const MIN_TOKEN_LENGTH = 16;
const MAX_TOKEN_LENGTH = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_SESSION_ID_LENGTH = 256;

type JsonRecord = Record<string, unknown>;
type FetchLike = typeof fetch;

export type CTraderMcpReadTool =
  | "get_balance"
  | "get_symbols"
  | "get_deals"
  | "get_position_details"
  | "get_account"
  | "get_accountinfo"
  | "get_account_info";

const ALLOWED_TOOLS = new Set<CTraderMcpReadTool>([
  "get_balance", "get_symbols", "get_deals", "get_position_details",
  "get_account", "get_accountinfo", "get_account_info",
]);

export type CTraderMcpErrorCode =
  | "CONFIG_INVALID"
  | "ENDPOINT_REJECTED"
  | "TOKEN_INVALID"
  | "CLIENT_OPTIONS_INVALID"
  | "CLIENT_CLOSED"
  | "REQUEST_TIMEOUT"
  | "AUTH_REJECTED"
  | "REMOTE_RATE_LIMITED"
  | "REMOTE_UNAVAILABLE"
  | "REMOTE_REJECTED"
  | "REDIRECT_REJECTED"
  | "RESPONSE_TOO_LARGE"
  | "RESPONSE_INVALID"
  | "SESSION_INVALID"
  | "RPC_REJECTED"
  | "TOOL_UNAVAILABLE"
  | "TOOL_RESULT_INVALID"
  | "DEAL_RANGE_INVALID";

export class CTraderMcpError extends Error {
  readonly code: CTraderMcpErrorCode;

  constructor(code: CTraderMcpErrorCode, message: string) {
    super(message);
    this.name = "CTraderMcpError";
    this.code = code;
  }
}

export interface ParsedCTraderMcpConfiguration { bearerToken: string }

export interface CTraderMcpClientOptions {
  fetchImplementation?: FetchLike;
  requestTimeoutMs?: number;
  maxResponseBytes?: number;
}

export interface CTraderMcpDealsRequest {
  fromTimestamp: string;
  toTimestamp: string;
}

export interface CTraderMcpValidationResult {
  bearerToken: string;
  balance: unknown;
  symbols: unknown;
  historyProbe: unknown;
  accountInfo: unknown | null;
}

type RpcRequest = {
  jsonrpc: "2.0";
  id?: number;
  method: string;
  params?: JsonRecord;
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationError(): CTraderMcpError {
  return new CTraderMcpError("CONFIG_INVALID", "The cTrader MCP configuration is invalid");
}

function getKey(record: JsonRecord, expected: string): unknown {
  const key = Object.keys(record).find((candidate) => candidate.toLowerCase() === expected.toLowerCase());
  return key === undefined ? undefined : record[key];
}

function validateJsonShape(value: unknown, depth = 0): void {
  if (depth > 8) throw configurationError();
  if (typeof value === "string") {
    if (value.length > MAX_CONFIGURATION_BYTES) throw configurationError();
    return;
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return;
  if (!isRecord(value)) throw configurationError();
  const entries = Object.entries(value);
  if (entries.length > 128) throw configurationError();
  for (const [key, child] of entries) {
    if (key.length === 0 || key.length > 128) throw configurationError();
    validateJsonShape(child, depth + 1);
  }
}

function collectUrls(value: unknown, output: string[], depth = 0): void {
  if (depth > 8 || !isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === "url" && typeof child === "string") output.push(child);
    else collectUrls(child, output, depth + 1);
  }
}

function readAuthorization(descriptor: JsonRecord): string | null {
  for (const key of ["headers", "http_headers", "httpHeaders"]) {
    const headers = getKey(descriptor, key);
    if (!isRecord(headers)) continue;
    const authorization = getKey(headers, "authorization");
    if (typeof authorization === "string") return authorization;
  }
  const authorization = getKey(descriptor, "authorization");
  if (typeof authorization === "string") return authorization;
  for (const key of ["bearerToken", "token"]) {
    const token = getKey(descriptor, key);
    if (typeof token === "string") return token;
  }
  return null;
}

function descriptors(root: JsonRecord): JsonRecord[] {
  const output: JsonRecord[] = [];
  if (typeof getKey(root, "url") === "string" || readAuthorization(root) !== null) output.push(root);
  for (const containerKey of ["mcpServers", "mcp_servers", "servers"]) {
    const container = getKey(root, containerKey);
    if (!isRecord(container)) continue;
    const entries = Object.entries(container);
    if (entries.length > 16) throw configurationError();
    const named = entries.filter(([name, value]) => /ctrader/i.test(name) && isRecord(value));
    const candidates = named.length > 0 ? named : entries.length === 1 ? entries : [];
    for (const [, value] of candidates) if (isRecord(value)) output.push(value);
  }
  return output;
}

function validateEndpoint(endpoint: string): void {
  if (endpoint !== CTRADER_MCP_ENDPOINT) {
    throw new CTraderMcpError("ENDPOINT_REJECTED", "The cTrader MCP endpoint is not allowed");
  }
}

function normalizeToken(value: string): string {
  let token = value.trim();
  if (/^bearer\s+/i.test(token)) token = token.replace(/^bearer\s+/i, "").trim();
  if (
    token.length < MIN_TOKEN_LENGTH
    || token.length > MAX_TOKEN_LENGTH
    || !/^[A-Za-z0-9\-._~+/]+={0,2}$/.test(token)
  ) {
    throw new CTraderMcpError("TOKEN_INVALID", "The cTrader MCP bearer token is invalid");
  }
  return token;
}

function parseJsonConfiguration(input: string): ParsedCTraderMcpConfiguration {
  let parsed: unknown;
  try { parsed = JSON.parse(input) as unknown; } catch { throw configurationError(); }
  validateJsonShape(parsed);
  if (!isRecord(parsed)) throw configurationError();

  const urls: string[] = [];
  collectUrls(parsed, urls);
  for (const endpoint of urls) validateEndpoint(endpoint);
  if (urls.length > 1) throw configurationError();

  const credentials = descriptors(parsed)
    .map((descriptor) => readAuthorization(descriptor))
    .filter((value): value is string => value !== null);
  const unique = [...new Set(credentials)];
  if (unique.length !== 1) throw configurationError();
  return { bearerToken: normalizeToken(unique[0] ?? "") };
}

function parseTextConfiguration(input: string): ParsedCTraderMcpConfiguration {
  const urls = input.match(/https?:\/\/[^\s"'`,}\]]+/gi) ?? [];
  for (const endpoint of urls) validateEndpoint(endpoint.replace(/[);]+$/g, ""));
  if (urls.length > 1) throw configurationError();

  const tokens: string[] = [];
  const authorization = /(?:^|[\s{,])['"]?authorization['"]?\s*[:=]\s*['"]?bearer\s+([A-Za-z0-9\-._~+/]+={0,2})/gim;
  const namedToken = /(?:^|[\s{,])['"]?(?:bearertoken|token)['"]?\s*[:=]\s*['"]?(?:bearer\s+)?([A-Za-z0-9\-._~+/]+={0,2})/gim;
  for (const pattern of [authorization, namedToken]) {
    for (const match of input.matchAll(pattern)) if (match[1] !== undefined) tokens.push(match[1]);
  }
  const unique = [...new Set(tokens)];
  if (unique.length === 1) return { bearerToken: normalizeToken(unique[0] ?? "") };
  if (unique.length > 1) throw configurationError();
  if (/^bearer\s+\S+$/i.test(input) || /^\S+$/.test(input)) return { bearerToken: normalizeToken(input) };
  throw configurationError();
}

/** Parse cTrader Web's copied Remote MCP configuration or its bare bearer token. */
export function parseCTraderMcpConfiguration(input: string): ParsedCTraderMcpConfiguration {
  if (typeof input !== "string") throw configurationError();
  const trimmed = input.trim();
  if (trimmed.length === 0 || Buffer.byteLength(trimmed, "utf8") > MAX_CONFIGURATION_BYTES) {
    throw configurationError();
  }
  if (trimmed.startsWith("{")) return parseJsonConfiguration(trimmed);
  if (trimmed.startsWith("[") && !/^\[[A-Za-z0-9_.-]+\]\s*(?:\r?\n|$)/.test(trimmed)) {
    return parseJsonConfiguration(trimmed);
  }
  return parseTextConfiguration(trimmed);
}

function integerOption(value: number, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new CTraderMcpError("CLIENT_OPTIONS_INVALID", "The cTrader MCP client options are invalid");
  }
  return value;
}

function sessionId(value: string | null): string {
  if (
    value === null
    || value.length === 0
    || value.length > MAX_SESSION_ID_LENGTH
    || !/^[\x21-\x7e]+$/.test(value)
  ) {
    throw new CTraderMcpError("SESSION_INVALID", "The cTrader MCP session is invalid");
  }
  return value;
}

async function readTextLimited(response: Response, maximumBytes: number): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new CTraderMcpError("RESPONSE_TOO_LARGE", "The cTrader MCP response exceeded the safe size limit");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof CTraderMcpError) throw error;
    throw new CTraderMcpError("RESPONSE_INVALID", "The cTrader MCP response could not be read");
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {
    throw new CTraderMcpError("RESPONSE_INVALID", "The cTrader MCP response encoding is invalid");
  }
}

function json(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch {
    throw new CTraderMcpError("RESPONSE_INVALID", "The cTrader MCP response is invalid");
  }
}

function sse(text: string): unknown[] {
  const output: unknown[] = [];
  let data: string[] = [];
  const dispatch = (): void => {
    if (data.length === 0) return;
    const value = data.join("\n");
    data = [];
    if (value !== "[DONE]") output.push(json(value));
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (line === "") { dispatch(); continue; }
    if (line.startsWith(":")) continue;
    if (line === "data") data.push("");
    else if (line.startsWith("data:")) {
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  dispatch();
  if (output.length === 0) {
    throw new CTraderMcpError("RESPONSE_INVALID", "The cTrader MCP event stream is empty");
  }
  return output;
}

function rpcPayload(text: string, contentType: string, expectedId: number): JsonRecord {
  let candidates: unknown[];
  if (contentType.toLowerCase().includes("text/event-stream")) candidates = sse(text);
  else if (contentType.toLowerCase().includes("application/json")) candidates = [json(text)];
  else throw new CTraderMcpError("RESPONSE_INVALID", "The cTrader MCP response type is invalid");

  const payload = candidates.find((candidate) => isRecord(candidate) && candidate.id === expectedId);
  if (!isRecord(payload) || payload.jsonrpc !== "2.0") {
    throw new CTraderMcpError("RESPONSE_INVALID", "The cTrader MCP response envelope is invalid");
  }
  if (Object.prototype.hasOwnProperty.call(payload, "error")) {
    throw new CTraderMcpError("RPC_REJECTED", "cTrader rejected the read request");
  }
  if (!Object.prototype.hasOwnProperty.call(payload, "result")) {
    throw new CTraderMcpError("RESPONSE_INVALID", "The cTrader MCP response has no result");
  }
  return payload;
}

function utcTimestamp(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || value.length > 40) {
    throw new CTraderMcpError("DEAL_RANGE_INVALID", "The cTrader deal range is invalid");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new CTraderMcpError("DEAL_RANGE_INVALID", "The cTrader deal range is invalid");
  }
  return parsed;
}

function toolResult(result: unknown): unknown {
  if (!isRecord(result)) {
    throw new CTraderMcpError("TOOL_RESULT_INVALID", "The cTrader tool returned an invalid result");
  }
  if (result.isError === true) throw new CTraderMcpError("RPC_REJECTED", "cTrader rejected the read request");
  if (Object.prototype.hasOwnProperty.call(result, "structuredContent")) return result.structuredContent;
  if (!Array.isArray(result.content) || result.content.length === 0 || result.content.length > 64) {
    throw new CTraderMcpError("TOOL_RESULT_INVALID", "The cTrader tool returned an invalid result");
  }
  const block = result.content.find(
    (value) => isRecord(value) && value.type === "text" && typeof value.text === "string",
  );
  if (!isRecord(block) || typeof block.text !== "string" || block.text.length === 0) {
    throw new CTraderMcpError("TOOL_RESULT_INVALID", "The cTrader tool returned an invalid result");
  }
  try { return JSON.parse(block.text) as unknown; } catch { return block.text; }
}

type RpcResponse = { response: Response; payload: JsonRecord };
type HttpResponse = { response: Response; text: string };

export class CTraderMcpReadClient {
  readonly #bearerToken: string;
  readonly #fetch: FetchLike;
  readonly #requestTimeoutMs: number;
  readonly #maxResponseBytes: number;
  #sessionId: string | null = null;
  #protocolVersion = MCP_PROTOCOL_VERSION;
  #nextRequestId = 1;
  #initializePromise: Promise<void> | null = null;
  #toolDiscoveryPromise: Promise<ReadonlySet<CTraderMcpReadTool>> | null = null;
  #availableTools: ReadonlySet<CTraderMcpReadTool> | null = null;
  #accountTool: Extract<CTraderMcpReadTool, "get_account" | "get_accountinfo" | "get_account_info"> | null = null;
  #closed = false;

  constructor(bearerToken: string, options: CTraderMcpClientOptions = {}) {
    this.#bearerToken = normalizeToken(bearerToken);
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#requestTimeoutMs = integerOption(options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS, 100, 60_000);
    this.#maxResponseBytes = integerOption(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 1024, 4 * 1024 * 1024);
  }

  static fromCopiedConfiguration(
    copiedConfiguration: string,
    options: CTraderMcpClientOptions = {},
  ): CTraderMcpReadClient {
    return new CTraderMcpReadClient(parseCTraderMcpConfiguration(copiedConfiguration).bearerToken, options);
  }

  async initialize(): Promise<void> {
    this.#assertOpen();
    if (this.#sessionId !== null) return;
    if (this.#initializePromise !== null) return this.#initializePromise;
    const pending = this.#initialize();
    this.#initializePromise = pending;
    try { await pending; } finally { this.#initializePromise = null; }
  }

  async getBalance(): Promise<unknown> { return this.#callTool("get_balance", {}); }
  async getSymbols(): Promise<unknown> { return this.#callTool("get_symbols", {}); }

  async getDeals(request: CTraderMcpDealsRequest): Promise<unknown> {
    const from = utcTimestamp(request.fromTimestamp);
    const to = utcTimestamp(request.toTimestamp);
    if (to <= from || to - from > 30 * 24 * 60 * 60 * 1000) {
      throw new CTraderMcpError("DEAL_RANGE_INVALID", "The cTrader deal range is invalid");
    }
    return this.#callTool("get_deals", {
      fromTimestamp: request.fromTimestamp,
      toTimestamp: request.toTimestamp,
    });
  }

  /**
   * Fetch the provider's immutable deal lineage for one position. This is a
   * reviewed read-only Remote MCP tool; the client still cannot call any
   * trading-capable tool advertised by the same bearer token.
   */
  async getPositionDetails(positionId: string): Promise<unknown> {
    if (!/^\d+$/.test(positionId) || positionId === "0") {
      throw new CTraderMcpError("DEAL_RANGE_INVALID", "The cTrader position ID is invalid");
    }
    const parsed = Number(positionId);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new CTraderMcpError("DEAL_RANGE_INVALID", "The cTrader position ID is invalid");
    }
    return this.#callTool("get_position_details", { positionId: parsed });
  }

  async getAccountInfo(): Promise<unknown> {
    await this.initialize();
    if (this.#accountTool === null) {
      const available = await this.#tools();
      for (const name of ["get_account", "get_accountinfo", "get_account_info"] as const) {
        if (available.has(name)) { this.#accountTool = name; break; }
      }
      if (this.#accountTool === null) {
        throw new CTraderMcpError("TOOL_UNAVAILABLE", "cTrader account information is unavailable");
      }
    }
    return this.#callTool(this.#accountTool, {});
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const activeSession = this.#sessionId;
    this.#sessionId = null;
    if (activeSession === null) return;
    try { await this.#http("DELETE", undefined, activeSession, true); } catch { /* best-effort termination */ }
  }

  async #initialize(): Promise<void> {
    const id = this.#requestId();
    const initialized = await this.#postRpc({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "edgebook-server", version: "1.0.0" },
      },
    }, id, null);
    const result = initialized.payload.result;
    if (!isRecord(result) || typeof result.protocolVersion !== "string" || !SUPPORTED_PROTOCOL_VERSIONS.has(result.protocolVersion)) {
      throw new CTraderMcpError("RESPONSE_INVALID", "The cTrader MCP protocol version is invalid");
    }
    const activeSession = sessionId(initialized.response.headers.get("mcp-session-id"));
    this.#protocolVersion = result.protocolVersion;
    this.#sessionId = activeSession;
    try {
      const notification: RpcRequest = { jsonrpc: "2.0", method: "notifications/initialized" };
      const notified = await this.#http("POST", JSON.stringify(notification), activeSession);
      if (notified.text.length > 0) {
        const contentType = notified.response.headers.get("content-type") ?? "";
        if (!/application\/json|text\/event-stream/i.test(contentType)) {
          throw new CTraderMcpError("RESPONSE_INVALID", "The cTrader MCP response type is invalid");
        }
      }
    } catch (error) {
      this.#sessionId = null;
      throw error;
    }
  }

  async #discoverTools(): Promise<ReadonlySet<CTraderMcpReadTool>> {
    const id = this.#requestId();
    const response = await this.#postRpc({
      jsonrpc: "2.0", id, method: "tools/list", params: {},
    }, id, this.#requiredSession());
    const result = response.payload.result;
    if (!isRecord(result) || !Array.isArray(result.tools) || result.tools.length > 256) {
      throw new CTraderMcpError("RESPONSE_INVALID", "The cTrader MCP tool list is invalid");
    }
    return new Set(result.tools.flatMap((tool) => {
      if (!isRecord(tool) || typeof tool.name !== "string") return [];
      return ALLOWED_TOOLS.has(tool.name as CTraderMcpReadTool) ? [tool.name as CTraderMcpReadTool] : [];
    }));
  }

  async #tools(): Promise<ReadonlySet<CTraderMcpReadTool>> {
    if (this.#availableTools !== null) return this.#availableTools;
    if (this.#toolDiscoveryPromise !== null) return this.#toolDiscoveryPromise;
    const pending = this.#discoverTools();
    this.#toolDiscoveryPromise = pending;
    try {
      this.#availableTools = await pending;
      return this.#availableTools;
    } finally {
      this.#toolDiscoveryPromise = null;
    }
  }

  async #callTool(tool: CTraderMcpReadTool, argumentsValue: JsonRecord): Promise<unknown> {
    if (!ALLOWED_TOOLS.has(tool)) {
      throw new CTraderMcpError("TOOL_UNAVAILABLE", "The cTrader read tool is unavailable");
    }
    await this.initialize();
    if (!(await this.#tools()).has(tool)) {
      throw new CTraderMcpError("TOOL_UNAVAILABLE", "The cTrader read tool is unavailable");
    }
    const id = this.#requestId();
    const response = await this.#postRpc({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: tool, arguments: argumentsValue },
    }, id, this.#requiredSession());
    return toolResult(response.payload.result);
  }

  async #postRpc(request: RpcRequest, expectedId: number, activeSession: string | null): Promise<RpcResponse> {
    const result = await this.#http("POST", JSON.stringify(request), activeSession);
    return {
      response: result.response,
      payload: rpcPayload(result.text, result.response.headers.get("content-type") ?? "", expectedId),
    };
  }

  async #http(
    method: "POST" | "DELETE",
    body: string | undefined,
    activeSession: string | null,
    allowClosed = false,
  ): Promise<HttpResponse> {
    if (!allowClosed) this.#assertOpen();
    const headers: Record<string, string> = {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${this.#bearerToken}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (activeSession !== null) {
      headers["Mcp-Session-Id"] = sessionId(activeSession);
      headers["MCP-Protocol-Version"] = this.#protocolVersion;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#requestTimeoutMs);
    try {
      const init: RequestInit = { method, headers, redirect: "error", signal: controller.signal };
      if (body !== undefined) init.body = body;
      const response = await this.#fetch(CTRADER_MCP_ENDPOINT, init);

      if (response.redirected || (response.url.length > 0 && response.url !== CTRADER_MCP_ENDPOINT)) {
        await response.body?.cancel().catch(() => undefined);
        throw new CTraderMcpError("REDIRECT_REJECTED", "The cTrader MCP response was redirected");
      }
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new CTraderMcpError("REDIRECT_REJECTED", "The cTrader MCP response was redirected");
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) {
          throw new CTraderMcpError("AUTH_REJECTED", "The cTrader MCP credential was rejected");
        }
        if (response.status === 429) {
          throw new CTraderMcpError("REMOTE_RATE_LIMITED", "The cTrader MCP service is temporarily rate limited");
        }
        if (response.status >= 500) {
          throw new CTraderMcpError("REMOTE_UNAVAILABLE", "The cTrader MCP service is unavailable");
        }
        throw new CTraderMcpError("REMOTE_REJECTED", "The cTrader MCP service rejected the request");
      }
      const returnedSession = response.headers.get("mcp-session-id");
      if (activeSession !== null && returnedSession !== null && sessionId(returnedSession) !== activeSession) {
        throw new CTraderMcpError("SESSION_INVALID", "The cTrader MCP session changed unexpectedly");
      }
      return { response, text: await readTextLimited(response, this.#maxResponseBytes) };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new CTraderMcpError("REQUEST_TIMEOUT", "The cTrader MCP request timed out");
      }
      if (error instanceof CTraderMcpError) throw error;
      throw new CTraderMcpError("REMOTE_UNAVAILABLE", "The cTrader MCP service is unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  #requestId(): number {
    const id = this.#nextRequestId;
    this.#nextRequestId += 1;
    if (!Number.isSafeInteger(this.#nextRequestId)) this.#nextRequestId = 1;
    return id;
  }

  #requiredSession(): string { return sessionId(this.#sessionId); }

  #assertOpen(): void {
    if (this.#closed) throw new CTraderMcpError("CLIENT_CLOSED", "The cTrader MCP client is closed");
  }
}

export async function validateCTraderMcpConfiguration(
  copiedConfiguration: string,
  options: CTraderMcpClientOptions = {},
): Promise<CTraderMcpValidationResult> {
  const parsed = parseCTraderMcpConfiguration(copiedConfiguration);
  const client = new CTraderMcpReadClient(parsed.bearerToken, options);
  try {
    await client.initialize();
    const balance = await client.getBalance();
    const symbols = await client.getSymbols();
    const probeEnd = new Date();
    const probeStart = new Date(probeEnd.getTime() - 24 * 60 * 60 * 1000);
    const historyProbe = await client.getDeals({
      fromTimestamp: probeStart.toISOString(),
      toTimestamp: probeEnd.toISOString(),
    });
    let accountInfo: unknown | null = null;
    try { accountInfo = await client.getAccountInfo(); } catch (error) {
      if (!(error instanceof CTraderMcpError) || error.code !== "TOOL_UNAVAILABLE") throw error;
    }
    return { bearerToken: parsed.bearerToken, balance, symbols, historyProbe, accountInfo };
  } finally {
    await client.close();
  }
}
