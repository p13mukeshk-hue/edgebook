export const CTRADER_ENDPOINTS = {
  live: "wss://live.ctraderapi.com:5036",
  demo: "wss://demo.ctraderapi.com:5036",
} as const;

export type CTraderEnvironment = keyof typeof CTRADER_ENDPOINTS;

// Spotware OpenApiCommonModelMessages.proto and OpenApiModelMessages.proto.
// Only read-only messages are deliberately represented here; this server has
// no order-placement or position-modification primitive.
export const CTraderPayload = {
  HEARTBEAT_EVENT: 51,
  APPLICATION_AUTH_REQ: 2100,
  APPLICATION_AUTH_RES: 2101,
  ACCOUNT_AUTH_REQ: 2102,
  ACCOUNT_AUTH_RES: 2103,
  ASSET_LIST_REQ: 2112,
  ASSET_LIST_RES: 2113,
  SYMBOLS_LIST_REQ: 2114,
  SYMBOLS_LIST_RES: 2115,
  SYMBOL_BY_ID_REQ: 2116,
  SYMBOL_BY_ID_RES: 2117,
  TRADER_REQ: 2121,
  TRADER_RES: 2122,
  DEAL_LIST_REQ: 2133,
  DEAL_LIST_RES: 2134,
  ERROR_RES: 2142,
  CASH_FLOW_HISTORY_LIST_REQ: 2143,
  CASH_FLOW_HISTORY_LIST_RES: 2144,
  ACCOUNTS_TOKEN_INVALIDATED_EVENT: 2147,
  CLIENT_DISCONNECT_EVENT: 2148,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_REQ: 2149,
  GET_ACCOUNTS_BY_ACCESS_TOKEN_RES: 2150,
  ASSET_CLASS_LIST_REQ: 2153,
  ASSET_CLASS_LIST_RES: 2154,
  SYMBOL_CATEGORY_LIST_REQ: 2160,
  SYMBOL_CATEGORY_LIST_RES: 2161,
  ACCOUNT_DISCONNECT_EVENT: 2164,
} as const;

export type JsonObject = Record<string, unknown>;

export type CTraderEnvelope = {
  clientMsgId?: string;
  payloadType: number;
  payload: JsonObject;
};

export type CTraderAuthorizedAccount = {
  ctidTraderAccountId: string;
  environment: CTraderEnvironment;
  traderLogin: string | null;
  brokerTitleShort: string | null;
  lastClosingDealTimestamp: number | null;
  lastBalanceUpdateTimestamp: number | null;
};

export type CTraderLightSymbol = {
  symbolId: string;
  symbolName: string;
  baseAssetId: string | null;
  quoteAssetId: string | null;
  symbolCategoryId: string | null;
  raw: JsonObject;
};

export type CTraderTraderMetadata = {
  registrationTimestamp: number | null;
  depositAssetId: string;
  moneyDigits: number | null;
  /** Current account balance in the provider's lossless money units. */
  balance: bigint;
  /** Monotonic provider balance revision, when supplied. */
  balanceVersion: bigint | null;
  raw: JsonObject;
};

export type CTraderAsset = {
  assetId: string;
  name: string;
  displayName: string | null;
  digits: number | null;
  raw: JsonObject;
};

export type CTraderAssetClass = {
  id: string;
  name: string;
  raw: JsonObject;
};

export type CTraderSymbolCategory = {
  id: string;
  assetClassId: string;
  name: string;
  raw: JsonObject;
};

export type CTraderSymbolSpec = {
  symbolId: string;
  symbolName: string;
  lotSizeCents: bigint;
  digits: number;
  pipPosition: number;
  raw: JsonObject;
};

export type CTraderClosePositionDetail = {
  entryPrice: number;
  grossProfit: bigint;
  swap: bigint;
  commission: bigint;
  balance: bigint;
  closedVolumeCents: bigint | null;
  moneyDigits: number | null;
  pnlConversionFee: bigint;
  raw: JsonObject;
};

export type CTraderDeal = {
  dealId: string;
  orderId: string | null;
  positionId: string;
  volumeCents: bigint;
  filledVolumeCents: bigint;
  symbolId: string;
  createTimestamp: number;
  executionTimestamp: number;
  providerUpdatedTimestamp: number | null;
  executionPrice: number;
  tradeSide: "BUY" | "SELL";
  dealStatus: 2 | 3;
  moneyDigits: number | null;
  commission: bigint | null;
  closePositionDetail: CTraderClosePositionDetail | null;
  raw: JsonObject;
};

// ProtoOAChangeBalanceType values from Spotware's official model schema. Keep
// the provider enum name as well as the numeric value: the JSON gateway emits
// names, and retaining an unknown future name lets sync preserve a new charge
// instead of silently dropping it until Edgebook is upgraded.
export const CTRADER_CHANGE_BALANCE_TYPES = {
  BALANCE_DEPOSIT: 0,
  BALANCE_WITHDRAW: 1,
  BALANCE_DEPOSIT_STRATEGY_COMMISSION_INNER: 3,
  BALANCE_WITHDRAW_STRATEGY_COMMISSION_INNER: 4,
  BALANCE_DEPOSIT_IB_COMMISSIONS: 5,
  BALANCE_WITHDRAW_IB_SHARED_PERCENTAGE: 6,
  BALANCE_DEPOSIT_IB_SHARED_PERCENTAGE_FROM_SUB_IB: 7,
  BALANCE_DEPOSIT_IB_SHARED_PERCENTAGE_FROM_BROKER: 8,
  BALANCE_DEPOSIT_REBATE: 9,
  BALANCE_WITHDRAW_REBATE: 10,
  BALANCE_DEPOSIT_STRATEGY_COMMISSION_OUTER: 11,
  BALANCE_WITHDRAW_STRATEGY_COMMISSION_OUTER: 12,
  BALANCE_WITHDRAW_BONUS_COMPENSATION: 13,
  BALANCE_WITHDRAW_IB_SHARED_PERCENTAGE_TO_BROKER: 14,
  BALANCE_DEPOSIT_DIVIDENDS: 15,
  BALANCE_WITHDRAW_DIVIDENDS: 16,
  BALANCE_WITHDRAW_GSL_CHARGE: 17,
  BALANCE_WITHDRAW_ROLLOVER: 18,
  BALANCE_DEPOSIT_NONWITHDRAWABLE_BONUS: 19,
  BALANCE_WITHDRAW_NONWITHDRAWABLE_BONUS: 20,
  BALANCE_DEPOSIT_SWAP: 21,
  BALANCE_WITHDRAW_SWAP: 22,
  BALANCE_DEPOSIT_MANAGEMENT_FEE: 27,
  BALANCE_WITHDRAW_MANAGEMENT_FEE: 28,
  BALANCE_DEPOSIT_PERFORMANCE_FEE: 29,
  BALANCE_WITHDRAW_FOR_SUBACCOUNT: 30,
  BALANCE_DEPOSIT_TO_SUBACCOUNT: 31,
  BALANCE_WITHDRAW_FROM_SUBACCOUNT: 32,
  BALANCE_DEPOSIT_FROM_SUBACCOUNT: 33,
  BALANCE_WITHDRAW_COPY_FEE: 34,
  BALANCE_WITHDRAW_INACTIVITY_FEE: 35,
  BALANCE_DEPOSIT_TRANSFER: 36,
  BALANCE_WITHDRAW_TRANSFER: 37,
  BALANCE_DEPOSIT_CONVERTED_BONUS: 38,
  BALANCE_DEPOSIT_NEGATIVE_BALANCE_PROTECTION: 39,
} as const;

export type CTraderCashFlow = {
  balanceHistoryId: string;
  operationType: number | null;
  operationName: string;
  balance: bigint;
  delta: bigint;
  changeBalanceTimestamp: number;
  balanceVersion: bigint | null;
  equity: bigint | null;
  moneyDigits: number | null;
};

export class CTraderProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CTraderProtocolError";
  }
}

export function requireObject(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CTraderProtocolError(`${label} must be an object`);
  }
  return value as JsonObject;
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CTraderProtocolError(`${label} must be an array`);
  return value;
}

export function protocolIntegerString(value: unknown, label: string): string {
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) return value;
  if (typeof value === "bigint" && value >= 0n) return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value.toString();
  throw new CTraderProtocolError(`${label} must be a lossless non-negative integer`);
}

export function protocolBigInt(value: unknown, label: string, positive = false): bigint {
  const parsed = BigInt(protocolIntegerString(value, label));
  if (positive && parsed <= 0n) throw new CTraderProtocolError(`${label} must be greater than zero`);
  if (parsed > 9_223_372_036_854_775_807n) {
    throw new CTraderProtocolError(`${label} exceeds the signed 64-bit storage range`);
  }
  return parsed;
}

function protocolSignedBigInt(value: unknown, label: string): bigint {
  const parsed = typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)
    ? BigInt(value)
    : typeof value === "bigint"
      ? value
      : typeof value === "number" && Number.isSafeInteger(value)
        ? BigInt(value)
        : null;
  if (parsed === null) throw new CTraderProtocolError(`${label} must be a lossless integer`);
  if (parsed < -9_223_372_036_854_775_808n || parsed > 9_223_372_036_854_775_807n) {
    throw new CTraderProtocolError(`${label} exceeds the signed 64-bit protocol range`);
  }
  return parsed;
}

function protocolNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) throw new CTraderProtocolError(`${label} must be a finite number`);
  return parsed;
}

function protocolTimestamp(value: unknown, label: string): number {
  const parsed = protocolBigInt(value, label);
  if (parsed > 2_147_483_646_000n) throw new CTraderProtocolError(`${label} is outside cTrader's supported range`);
  return Number(parsed);
}

function optionalTimestamp(value: unknown, label: string): number | null {
  return value === undefined || value === null ? null : protocolTimestamp(value, label);
}

function optionalText(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new CTraderProtocolError(`${label} must be a string`);
  return value;
}

function protocolMoneyDigits(value: unknown, label: string): number | null {
  if (value === undefined || value === null) return null;
  const parsed = protocolNumber(value, label);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 18) {
    throw new CTraderProtocolError(`${label} must be an integer from 0 through 18`);
  }
  return parsed;
}

function protocolDealStatus(value: unknown): 2 | 3 | null {
  if (value === 2 || value === "2" || value === "FILLED") return 2;
  if (value === 3 || value === "3" || value === "PARTIALLY_FILLED") return 3;
  return null;
}

function protocolChangeBalanceType(value: unknown, label: string): { code: number | null; name: string } {
  const names = CTRADER_CHANGE_BALANCE_TYPES as Record<string, number>;
  if (typeof value === "string" && Object.hasOwn(names, value)) {
    return { code: names[value] ?? null, name: value };
  }
  if (typeof value === "string" && /^BALANCE_[A-Z0-9_]{1,100}$/.test(value)) {
    return { code: null, name: value };
  }
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 2_147_483_647) {
    throw new CTraderProtocolError(`${label} must be a cTrader balance operation`);
  }
  const entry = Object.entries(names).find(([, code]) => code === parsed);
  return { code: parsed, name: entry?.[0] ?? `BALANCE_UNKNOWN_${parsed}` };
}

function protocolTradeSide(value: unknown): "BUY" | "SELL" {
  if (value === 1 || value === "1" || value === "BUY") return "BUY";
  if (value === 2 || value === "2" || value === "SELL") return "SELL";
  throw new CTraderProtocolError("deal.tradeSide must be BUY or SELL");
}

export function parseEnvelope(value: unknown): CTraderEnvelope {
  const object = requireObject(value, "message");
  const payloadType = protocolNumber(object.payloadType, "message.payloadType");
  if (!Number.isInteger(payloadType)) throw new CTraderProtocolError("message.payloadType must be an integer");
  const payload = requireObject(object.payload ?? {}, "message.payload");
  const clientMsgId = optionalText(object.clientMsgId, "message.clientMsgId");
  return clientMsgId === null ? { payloadType, payload } : { clientMsgId, payloadType, payload };
}

export function parseAuthorizedAccounts(payload: JsonObject): CTraderAuthorizedAccount[] {
  const permission = payload.permissionScope;
  if (!(permission === undefined || permission === 0 || permission === "0" || permission === "SCOPE_VIEW")) {
    throw new CTraderProtocolError("The cTrader grant is not the required view-only accounts scope");
  }
  return optionalArray(payload.ctidTraderAccount, "ctidTraderAccount").map((entry, index) => {
    const account = requireObject(entry, `ctidTraderAccount[${index}]`);
    if (account.isLive !== undefined && typeof account.isLive !== "boolean") {
      throw new CTraderProtocolError(`ctidTraderAccount[${index}].isLive must be boolean`);
    }
    return {
      ctidTraderAccountId: protocolIntegerString(account.ctidTraderAccountId, `ctidTraderAccount[${index}].ctidTraderAccountId`),
      // Protobuf JSON may omit the optional false value; false/omitted is demo.
      environment: account.isLive === true ? "live" : "demo",
      traderLogin: account.traderLogin === undefined ? null : protocolIntegerString(account.traderLogin, `ctidTraderAccount[${index}].traderLogin`),
      brokerTitleShort: optionalText(account.brokerTitleShort, `ctidTraderAccount[${index}].brokerTitleShort`),
      lastClosingDealTimestamp: optionalTimestamp(account.lastClosingDealTimestamp, `ctidTraderAccount[${index}].lastClosingDealTimestamp`),
      lastBalanceUpdateTimestamp: optionalTimestamp(account.lastBalanceUpdateTimestamp, `ctidTraderAccount[${index}].lastBalanceUpdateTimestamp`),
    };
  });
}

export function parseLightSymbols(payload: JsonObject): CTraderLightSymbol[] {
  const active = optionalArray(payload.symbol, "symbol").map((entry, index) => {
    const symbol = requireObject(entry, `symbol[${index}]`);
    const name = optionalText(symbol.symbolName, `symbol[${index}].symbolName`);
    if (!name) throw new CTraderProtocolError(`symbol[${index}].symbolName is required for journal projection`);
    return {
      symbolId: protocolIntegerString(symbol.symbolId, `symbol[${index}].symbolId`),
      symbolName: name,
      baseAssetId: symbol.baseAssetId === undefined ? null : protocolIntegerString(symbol.baseAssetId, `symbol[${index}].baseAssetId`),
      quoteAssetId: symbol.quoteAssetId === undefined ? null : protocolIntegerString(symbol.quoteAssetId, `symbol[${index}].quoteAssetId`),
      symbolCategoryId: symbol.symbolCategoryId === undefined
        ? null
        : protocolIntegerString(symbol.symbolCategoryId, `symbol[${index}].symbolCategoryId`),
      raw: symbol,
    };
  });
  const archived = optionalArray(payload.archivedSymbol, "archivedSymbol").map((entry, index) => {
    const symbol = requireObject(entry, `archivedSymbol[${index}]`);
    const name = optionalText(symbol.name, `archivedSymbol[${index}].name`);
    if (!name) throw new CTraderProtocolError(`archivedSymbol[${index}].name is required for journal projection`);
    return {
      symbolId: protocolIntegerString(symbol.symbolId, `archivedSymbol[${index}].symbolId`),
      symbolName: name,
      baseAssetId: null,
      quoteAssetId: null,
      symbolCategoryId: null,
      raw: symbol,
    };
  });
  const byId = new Map<string, CTraderLightSymbol>();
  for (const symbol of [...archived, ...active]) byId.set(symbol.symbolId, symbol);
  return [...byId.values()];
}

export function parseSymbolSpecs(payload: JsonObject, names: ReadonlyMap<string, string>): CTraderSymbolSpec[] {
  return optionalArray(payload.symbol, "symbol").map((entry, index) => {
    const symbol = requireObject(entry, `symbol[${index}]`);
    const symbolId = protocolIntegerString(symbol.symbolId, `symbol[${index}].symbolId`);
    const symbolName = names.get(symbolId);
    if (!symbolName) throw new CTraderProtocolError(`No authoritative name was returned for symbol ${symbolId}`);
    const digits = protocolNumber(symbol.digits, `symbol[${index}].digits`);
    const pipPosition = protocolNumber(symbol.pipPosition, `symbol[${index}].pipPosition`);
    if (!Number.isInteger(digits) || !Number.isInteger(pipPosition)) {
      throw new CTraderProtocolError(`Symbol ${symbolId} precision fields must be integers`);
    }
    return {
      symbolId,
      symbolName,
      lotSizeCents: protocolBigInt(symbol.lotSize, `symbol[${index}].lotSize`, true),
      digits,
      pipPosition,
      raw: symbol,
    };
  });
}

export function parseDeals(payload: JsonObject): { deals: CTraderDeal[]; hasMore: boolean } {
  const deals: CTraderDeal[] = [];
  optionalArray(payload.deal, "deal").forEach((entry, index) => {
    const raw = requireObject(entry, `deal[${index}]`);
    const status = protocolDealStatus(raw.dealStatus);
    // Rejected/error/missed deals are intentionally ignored, never projected.
    if (status === null) return;
    const closeRaw = raw.closePositionDetail === undefined || raw.closePositionDetail === null
      ? null
      : requireObject(raw.closePositionDetail, `deal[${index}].closePositionDetail`);
    const close = closeRaw === null
      ? null
      : {
          entryPrice: protocolNumber(closeRaw.entryPrice, `deal[${index}].closePositionDetail.entryPrice`),
          grossProfit: protocolSignedBigInt(closeRaw.grossProfit, `deal[${index}].closePositionDetail.grossProfit`),
          swap: protocolSignedBigInt(closeRaw.swap, `deal[${index}].closePositionDetail.swap`),
          commission: protocolSignedBigInt(closeRaw.commission, `deal[${index}].closePositionDetail.commission`),
          balance: protocolSignedBigInt(closeRaw.balance, `deal[${index}].closePositionDetail.balance`),
          closedVolumeCents: closeRaw.closedVolume === undefined
            ? null
            : protocolBigInt(closeRaw.closedVolume, `deal[${index}].closePositionDetail.closedVolume`, true),
          moneyDigits: protocolMoneyDigits(closeRaw.moneyDigits, `deal[${index}].closePositionDetail.moneyDigits`),
          pnlConversionFee: closeRaw.pnlConversionFee === undefined
            ? 0n
            : protocolSignedBigInt(closeRaw.pnlConversionFee, `deal[${index}].closePositionDetail.pnlConversionFee`),
          raw: closeRaw,
        };
    const filled = protocolBigInt(raw.filledVolume, `deal[${index}].filledVolume`, true);
    deals.push({
      dealId: protocolIntegerString(raw.dealId, `deal[${index}].dealId`),
      orderId: raw.orderId === undefined ? null : protocolIntegerString(raw.orderId, `deal[${index}].orderId`),
      positionId: protocolIntegerString(raw.positionId, `deal[${index}].positionId`),
      volumeCents: protocolBigInt(raw.volume, `deal[${index}].volume`, true),
      filledVolumeCents: filled,
      symbolId: protocolIntegerString(raw.symbolId, `deal[${index}].symbolId`),
      createTimestamp: protocolTimestamp(raw.createTimestamp, `deal[${index}].createTimestamp`),
      executionTimestamp: protocolTimestamp(raw.executionTimestamp, `deal[${index}].executionTimestamp`),
      providerUpdatedTimestamp: optionalTimestamp(raw.utcLastUpdateTimestamp, `deal[${index}].utcLastUpdateTimestamp`),
      executionPrice: protocolNumber(raw.executionPrice, `deal[${index}].executionPrice`),
      tradeSide: protocolTradeSide(raw.tradeSide),
      dealStatus: status,
      moneyDigits: protocolMoneyDigits(raw.moneyDigits, `deal[${index}].moneyDigits`),
      commission: raw.commission === undefined ? null : protocolSignedBigInt(raw.commission, `deal[${index}].commission`),
      closePositionDetail: close,
      raw,
    });
  });
  if (typeof payload.hasMore !== "boolean") throw new CTraderProtocolError("deal response hasMore must be boolean");
  return { deals, hasMore: payload.hasMore };
}

export function parseCashFlows(payload: JsonObject): CTraderCashFlow[] {
  return optionalArray(payload.depositWithdraw, "depositWithdraw").map((entry, index) => {
    const raw = requireObject(entry, `depositWithdraw[${index}]`);
    const operation = protocolChangeBalanceType(raw.operationType, `depositWithdraw[${index}].operationType`);
    return {
      balanceHistoryId: protocolIntegerString(raw.balanceHistoryId, `depositWithdraw[${index}].balanceHistoryId`),
      operationType: operation.code,
      operationName: operation.name,
      balance: protocolSignedBigInt(raw.balance, `depositWithdraw[${index}].balance`),
      delta: protocolSignedBigInt(raw.delta, `depositWithdraw[${index}].delta`),
      changeBalanceTimestamp: protocolTimestamp(
        raw.changeBalanceTimestamp,
        `depositWithdraw[${index}].changeBalanceTimestamp`,
      ),
      balanceVersion: raw.balanceVersion === undefined
        ? null
        : protocolSignedBigInt(raw.balanceVersion, `depositWithdraw[${index}].balanceVersion`),
      equity: raw.equity === undefined
        ? null
        : protocolSignedBigInt(raw.equity, `depositWithdraw[${index}].equity`),
      moneyDigits: protocolMoneyDigits(raw.moneyDigits, `depositWithdraw[${index}].moneyDigits`),
    };
  });
}

export function parseTraderMetadata(payload: JsonObject): CTraderTraderMetadata {
  const trader = requireObject(payload.trader, "trader");
  return {
    registrationTimestamp: optionalTimestamp(trader.registrationTimestamp, "trader.registrationTimestamp"),
    depositAssetId: protocolIntegerString(trader.depositAssetId, "trader.depositAssetId"),
    moneyDigits: protocolMoneyDigits(trader.moneyDigits, "trader.moneyDigits"),
    balance: protocolSignedBigInt(trader.balance, "trader.balance"),
    balanceVersion: trader.balanceVersion === undefined
      ? null
      : protocolSignedBigInt(trader.balanceVersion, "trader.balanceVersion"),
    raw: trader,
  };
}

export function parseAssets(payload: JsonObject): CTraderAsset[] {
  return optionalArray(payload.asset, "asset").map((entry, index) => {
    const raw = requireObject(entry, `asset[${index}]`);
    const name = optionalText(raw.name, `asset[${index}].name`);
    if (!name) throw new CTraderProtocolError(`asset[${index}].name is required`);
    const digits = raw.digits === undefined ? null : protocolNumber(raw.digits, `asset[${index}].digits`);
    if (digits !== null && (!Number.isInteger(digits) || digits < 0 || digits > 18)) {
      throw new CTraderProtocolError(`asset[${index}].digits must be an integer from 0 through 18`);
    }
    return {
      assetId: protocolIntegerString(raw.assetId, `asset[${index}].assetId`),
      name,
      displayName: optionalText(raw.displayName, `asset[${index}].displayName`),
      digits,
      raw,
    };
  });
}

export function parseAssetClasses(payload: JsonObject): CTraderAssetClass[] {
  return optionalArray(payload.assetClass, "assetClass").map((entry, index) => {
    const raw = requireObject(entry, `assetClass[${index}]`);
    const name = optionalText(raw.name, `assetClass[${index}].name`);
    if (!name) throw new CTraderProtocolError(`assetClass[${index}].name is required`);
    return {
      id: protocolIntegerString(raw.id, `assetClass[${index}].id`),
      name,
      raw,
    };
  });
}

export function parseSymbolCategories(payload: JsonObject): CTraderSymbolCategory[] {
  return optionalArray(payload.symbolCategory, "symbolCategory").map((entry, index) => {
    const raw = requireObject(entry, `symbolCategory[${index}]`);
    const name = optionalText(raw.name, `symbolCategory[${index}].name`);
    if (!name) throw new CTraderProtocolError(`symbolCategory[${index}].name is required`);
    return {
      id: protocolIntegerString(raw.id, `symbolCategory[${index}].id`),
      assetClassId: protocolIntegerString(raw.assetClassId, `symbolCategory[${index}].assetClassId`),
      name,
      raw,
    };
  });
}
