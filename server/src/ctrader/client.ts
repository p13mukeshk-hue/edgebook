import { randomUUID } from "node:crypto";
import JSONbigFactory from "json-bigint";
import WebSocket, { type RawData } from "ws";
import type { CTraderConfig } from "../config.js";
import {
  CTRADER_ENDPOINTS,
  CTraderPayload,
  CTraderProtocolError,
  parseAuthorizedAccounts,
  parseAssetClasses,
  parseAssets,
  parseDeals,
  parseEnvelope,
  parseLightSymbols,
  parseSymbolSpecs,
  parseSymbolCategories,
  parseTraderMetadata,
  type CTraderAsset,
  type CTraderAssetClass,
  type CTraderAuthorizedAccount,
  type CTraderDeal,
  type CTraderEnvironment,
  type CTraderEnvelope,
  type CTraderLightSymbol,
  type CTraderSymbolSpec,
  type CTraderSymbolCategory,
  type CTraderTraderMetadata,
  type JsonObject,
} from "./protocol.js";

const losslessJson = JSONbigFactory({ storeAsString: true, strict: true });

export class CTraderApiError extends Error {
  readonly code: string;
  readonly retryAfterSeconds: number | null;

  constructor(code: string, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "CTraderApiError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface CTraderAccountSession {
  getTraderMetadata(): Promise<CTraderTraderMetadata>;
  listAssets(): Promise<CTraderAsset[]>;
  listAssetClasses(): Promise<CTraderAssetClass[]>;
  listSymbolCategories(): Promise<CTraderSymbolCategory[]>;
  listSymbols(): Promise<CTraderLightSymbol[]>;
  getSymbolDetails(symbolIds: readonly string[], names: ReadonlyMap<string, string>): Promise<CTraderSymbolSpec[]>;
  listDeals(fromTimestamp: number, toTimestamp: number, maxRows: number): Promise<{ deals: CTraderDeal[]; hasMore: boolean }>;
  close(): Promise<void>;
}

export interface CTraderGateway {
  discoverAccounts(accessToken: string): Promise<CTraderAuthorizedAccount[]>;
  openAccount(environment: CTraderEnvironment, ctidTraderAccountId: string, accessToken: string): Promise<CTraderAccountSession>;
}

type PendingRequest = {
  expectedPayloadType: number;
  resolve: (payload: JsonObject) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type WebSocketFactory = (url: string) => WebSocket;

class CTraderJsonSession {
  readonly #environment: CTraderEnvironment;
  readonly #config: CTraderConfig;
  readonly #socketFactory: WebSocketFactory;
  readonly #pending = new Map<string, PendingRequest>();
  #socket: WebSocket | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #closed = false;
  #lastHistoricalRequestAt = 0;

  constructor(environment: CTraderEnvironment, config: CTraderConfig, socketFactory: WebSocketFactory) {
    this.#environment = environment;
    this.#config = config;
    this.#socketFactory = socketFactory;
  }

  async connect(): Promise<void> {
    if (this.#socket !== null) throw new Error("cTrader session is already connected");
    const socket = this.#socketFactory(CTRADER_ENDPOINTS[this.#environment]);
    this.#socket = socket;
    socket.on("message", (data) => this.#onMessage(data));
    socket.on("close", () => this.#onClosed(new CTraderApiError("CONNECTION_CLOSED", "The cTrader connection closed")));
    socket.on("error", (error) => this.#onClosed(new CTraderApiError("CONNECTION_ERROR", error.message)));
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new CTraderApiError("CONNECTION_TIMEOUT", "The cTrader connection timed out"));
      }, this.#config.requestTimeoutMs);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(new CTraderApiError("CONNECTION_ERROR", error.message));
      });
    });
    this.#heartbeat = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ clientMsgId: randomUUID(), payloadType: CTraderPayload.HEARTBEAT_EVENT, payload: {} }));
      }
    }, 10_000);
    this.#heartbeat.unref();
  }

  request(payloadType: number, expectedPayloadType: number, payload: JsonObject): Promise<JsonObject> {
    if (this.#closed || this.#socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new CTraderApiError("CONNECTION_CLOSED", "The cTrader connection is not open"));
    }
    const socket = this.#socket;
    const clientMsgId = randomUUID();
    return new Promise<JsonObject>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(clientMsgId);
        reject(new CTraderApiError("REQUEST_TIMEOUT", `cTrader request ${payloadType} timed out`));
      }, this.#config.requestTimeoutMs);
      this.#pending.set(clientMsgId, { expectedPayloadType, resolve, reject, timeout });
      socket.send(JSON.stringify({ clientMsgId, payloadType, payload }), (error) => {
        if (!error) return;
        const pending = this.#pending.get(clientMsgId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(clientMsgId);
        pending.reject(new CTraderApiError("SEND_FAILED", "The cTrader request could not be sent"));
      });
    });
  }

  async historicalRequest(payloadType: number, expectedPayloadType: number, payload: JsonObject): Promise<JsonObject> {
    // Official historical-data limit is five requests/second per connection.
    const delay = Math.max(0, 205 - (Date.now() - this.#lastHistoricalRequestAt));
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    this.#lastHistoricalRequestAt = Date.now();
    return this.request(payloadType, expectedPayloadType, payload);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    const socket = this.#socket;
    this.#socket = null;
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 1_000);
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.close(1000);
    });
  }

  #onMessage(data: RawData): void {
    let envelope: CTraderEnvelope;
    try {
      envelope = parseEnvelope(losslessJson.parse(data.toString()) as unknown);
    } catch (error) {
      this.#onClosed(error instanceof Error ? error : new CTraderProtocolError("Invalid cTrader JSON response"));
      this.#socket?.terminate();
      return;
    }
    if (envelope.payloadType === CTraderPayload.HEARTBEAT_EVENT) return;
    if (
      envelope.payloadType === CTraderPayload.CLIENT_DISCONNECT_EVENT
      || envelope.payloadType === CTraderPayload.ACCOUNT_DISCONNECT_EVENT
      || envelope.payloadType === CTraderPayload.ACCOUNTS_TOKEN_INVALIDATED_EVENT
    ) {
      const reason = typeof envelope.payload.reason === "string" ? envelope.payload.reason : "cTrader invalidated the session";
      this.#onClosed(new CTraderApiError("SESSION_INVALIDATED", reason));
      return;
    }
    if (!envelope.clientMsgId) return;
    const pending = this.#pending.get(envelope.clientMsgId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(envelope.clientMsgId);
    if (envelope.payloadType === CTraderPayload.ERROR_RES || envelope.payloadType === 50) {
      const code = typeof envelope.payload.errorCode === "string" ? envelope.payload.errorCode : "CTRADER_ERROR";
      const description = typeof envelope.payload.description === "string" ? envelope.payload.description : "cTrader rejected the request";
      const retry = typeof envelope.payload.retryAfter === "number" && Number.isFinite(envelope.payload.retryAfter)
        ? envelope.payload.retryAfter
        : null;
      pending.reject(new CTraderApiError(code, description, retry));
      return;
    }
    if (envelope.payloadType !== pending.expectedPayloadType) {
      pending.reject(new CTraderApiError(
        "UNEXPECTED_RESPONSE",
        `Expected cTrader payload ${pending.expectedPayloadType}, received ${envelope.payloadType}`,
      ));
      return;
    }
    pending.resolve(envelope.payload);
  }

  #onClosed(error: Error): void {
    this.#closed = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.#pending.clear();
    const socket = this.#socket;
    this.#socket = null;
    if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }
}

class OfficialAccountSession implements CTraderAccountSession {
  readonly #session: CTraderJsonSession;
  readonly #accountId: string;

  constructor(session: CTraderJsonSession, accountId: string) {
    this.#session = session;
    this.#accountId = accountId;
  }

  async getTraderMetadata(): Promise<CTraderTraderMetadata> {
    const payload = await this.#session.request(
      CTraderPayload.TRADER_REQ,
      CTraderPayload.TRADER_RES,
      { ctidTraderAccountId: this.#accountId },
    );
    return parseTraderMetadata(payload);
  }

  async listAssets(): Promise<CTraderAsset[]> {
    const payload = await this.#session.request(
      CTraderPayload.ASSET_LIST_REQ,
      CTraderPayload.ASSET_LIST_RES,
      { ctidTraderAccountId: this.#accountId },
    );
    return parseAssets(payload);
  }

  async listAssetClasses(): Promise<CTraderAssetClass[]> {
    const payload = await this.#session.request(
      CTraderPayload.ASSET_CLASS_LIST_REQ,
      CTraderPayload.ASSET_CLASS_LIST_RES,
      { ctidTraderAccountId: this.#accountId },
    );
    return parseAssetClasses(payload);
  }

  async listSymbolCategories(): Promise<CTraderSymbolCategory[]> {
    const payload = await this.#session.request(
      CTraderPayload.SYMBOL_CATEGORY_LIST_REQ,
      CTraderPayload.SYMBOL_CATEGORY_LIST_RES,
      { ctidTraderAccountId: this.#accountId },
    );
    return parseSymbolCategories(payload);
  }

  async listSymbols(): Promise<CTraderLightSymbol[]> {
    const payload = await this.#session.request(
      CTraderPayload.SYMBOLS_LIST_REQ,
      CTraderPayload.SYMBOLS_LIST_RES,
      // Full-history imports can contain instruments that the broker has since
      // archived. Omitting them would make otherwise valid positions
      // impossible to project without guessing a symbol name or lot size.
      { ctidTraderAccountId: this.#accountId, includeArchivedSymbols: true },
    );
    return parseLightSymbols(payload);
  }

  async getSymbolDetails(symbolIds: readonly string[], names: ReadonlyMap<string, string>): Promise<CTraderSymbolSpec[]> {
    if (symbolIds.length === 0) return [];
    const output: CTraderSymbolSpec[] = [];
    for (let offset = 0; offset < symbolIds.length; offset += 100) {
      const chunk = symbolIds.slice(offset, offset + 100);
      const payload = await this.#session.request(
        CTraderPayload.SYMBOL_BY_ID_REQ,
        CTraderPayload.SYMBOL_BY_ID_RES,
        { ctidTraderAccountId: this.#accountId, symbolId: chunk },
      );
      output.push(...parseSymbolSpecs(payload, names));
    }
    return output;
  }

  async listDeals(fromTimestamp: number, toTimestamp: number, maxRows: number): Promise<{ deals: CTraderDeal[]; hasMore: boolean }> {
    const payload = await this.#session.historicalRequest(
      CTraderPayload.DEAL_LIST_REQ,
      CTraderPayload.DEAL_LIST_RES,
      { ctidTraderAccountId: this.#accountId, fromTimestamp, toTimestamp, maxRows },
    );
    return parseDeals(payload);
  }

  close(): Promise<void> {
    return this.#session.close();
  }
}

export class OfficialCTraderGateway implements CTraderGateway {
  readonly #config: CTraderConfig;
  readonly #socketFactory: WebSocketFactory;

  constructor(config: CTraderConfig, socketFactory: WebSocketFactory = (url) => new WebSocket(url)) {
    if (!config.enabled || config.clientId === null || config.clientSecret === null) {
      throw new Error("cTrader Open API is not configured");
    }
    this.#config = config;
    this.#socketFactory = socketFactory;
  }

  async discoverAccounts(accessToken: string): Promise<CTraderAuthorizedAccount[]> {
    const session = new CTraderJsonSession("live", this.#config, this.#socketFactory);
    try {
      await session.connect();
      await this.#applicationAuth(session);
      const payload = await session.request(
        CTraderPayload.GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ,
        CTraderPayload.GET_ACCOUNTS_BY_ACCESS_TOKEN_RES,
        { accessToken },
      );
      const accounts = parseAuthorizedAccounts(payload);
      const seen = new Set<string>();
      return accounts.filter((account) => {
        const key = `${account.environment}:${account.ctidTraderAccountId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    } finally {
      await session.close();
    }
  }

  async openAccount(
    environment: CTraderEnvironment,
    ctidTraderAccountId: string,
    accessToken: string,
  ): Promise<CTraderAccountSession> {
    const session = new CTraderJsonSession(environment, this.#config, this.#socketFactory);
    try {
      await session.connect();
      await this.#applicationAuth(session);
      await session.request(
        CTraderPayload.ACCOUNT_AUTH_REQ,
        CTraderPayload.ACCOUNT_AUTH_RES,
        { ctidTraderAccountId, accessToken },
      );
      return new OfficialAccountSession(session, ctidTraderAccountId);
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  #applicationAuth(session: CTraderJsonSession): Promise<JsonObject> {
    const clientId = this.#config.clientId;
    const clientSecret = this.#config.clientSecret;
    if (clientId === null || clientSecret === null) throw new Error("cTrader application credentials are missing");
    return session.request(
      CTraderPayload.APPLICATION_AUTH_REQ,
      CTraderPayload.APPLICATION_AUTH_RES,
      { clientId, clientSecret },
    );
  }
}
