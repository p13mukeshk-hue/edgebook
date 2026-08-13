import type {
  CTraderAssetClass,
  CTraderDeal,
  CTraderLightSymbol,
  CTraderSymbolCategory,
  CTraderSymbolSpec,
} from "./protocol.js";

export class CTraderProjectionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CTraderProjectionError";
    this.code = code;
  }
}

export type EdgebookAssetCode = "eq" | "cx" | "fx" | "cm" | "ix";

const providerAssetNames = new Map<string, EdgebookAssetCode>([
  ["forex", "fx"],
  ["fx", "fx"],
  ["cryptocurrencies", "cx"],
  ["cryptocurrency", "cx"],
  ["crypto", "cx"],
  ["equities", "eq"],
  ["equity", "eq"],
  ["stocks", "eq"],
  ["shares", "eq"],
  ["commodities", "cm"],
  ["commodity", "cm"],
  ["metals", "cm"],
  ["energies", "cm"],
  ["indices", "ix"],
  ["index", "ix"],
]);

function normalizedProviderName(value: string): string {
  return value.trim().toLocaleLowerCase("en-US").replace(/[\s_-]+/g, " ");
}

export function mapCTraderAssetCode(assetClassName: string | null, categoryName: string | null): EdgebookAssetCode | null {
  for (const candidate of [assetClassName, categoryName]) {
    if (!candidate) continue;
    const mapped = providerAssetNames.get(normalizedProviderName(candidate));
    if (mapped) return mapped;
  }
  return null;
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function decimalFromScaledInteger(value: bigint, digits: number): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  if (digits === 0) return `${negative ? "-" : ""}${absolute}`;
  const padded = absolute.toString().padStart(digits + 1, "0");
  const integer = padded.slice(0, -digits);
  const fraction = padded.slice(-digits).replace(/0+$/, "");
  return `${negative ? "-" : ""}${integer}${fraction.length > 0 ? `.${fraction}` : ""}`;
}

function decimalRatio(numerator: bigint, denominator: bigint, scale = 10): string {
  if (denominator <= 0n) throw new CTraderProjectionError("LOT_SIZE_INVALID", "The cTrader symbol lotSize must be positive");
  const multiplier = powerOfTen(scale);
  const quotient = numerator * multiplier / denominator;
  const remainder = numerator * multiplier % denominator;
  const rounded = remainder * 2n >= denominator ? quotient + 1n : quotient;
  return decimalFromScaledInteger(rounded, scale);
}

export function volumeCentsToUnits(volumeCents: bigint): string {
  return decimalFromScaledInteger(volumeCents, 2);
}

type MoneyValue = { units: bigint; digits: number };

function sumMoney(values: readonly MoneyValue[]): string {
  const digits = Math.max(...values.map((value) => value.digits), 0);
  const units = values.reduce(
    (sum, value) => sum + value.units * powerOfTen(digits - value.digits),
    0n,
  );
  return decimalFromScaledInteger(units, digits);
}

function localDateTime(timestamp: number, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(timestamp));
  const value = (type: Intl.DateTimeFormatPartTypes): string => {
    const part = parts.find((candidate) => candidate.type === type)?.value;
    if (!part) throw new CTraderProjectionError("TIME_ZONE_FORMAT_FAILED", `Could not format ${type} in ${timeZone}`);
    return part;
  };
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    time: `${value("hour")}:${value("minute")}:${value("second")}`,
  };
}

function weightedPrice(deals: readonly { price: number; volume: bigint }[]): number {
  const total = deals.reduce((sum, deal) => sum + deal.volume, 0n);
  if (total <= 0n) throw new CTraderProjectionError("VOLUME_INVALID", "The position has no positive execution volume");
  const numericTotal = Number(total);
  return deals.reduce((sum, deal) => sum + deal.price * (Number(deal.volume) / numericTotal), 0);
}

export type CTraderTradeProjection = {
  positionId: string;
  symbolId: string;
  symbol: string;
  asset: EdgebookAssetCode | null;
  direction: "Long" | "Short";
  entryPrice: string;
  exitPrice: string | null;
  quantityLots: string;
  openedVolumeCents: string;
  closedVolumeCents: string;
  openVolumeCents: string;
  pnl: string | null;
  grossProfit: string | null;
  commission: string | null;
  swap: string | null;
  pnlConversionFee: string | null;
  /** True only when every realized closing execution has exact provider money. */
  realizedPnlComplete: boolean;
  /**
   * Immutable, execution-level realized-P&L ledger. A position is one journal
   * trade, but each partial close remains independently dated so calendar and
   * drawdown views do not move February P&L back to a January entry date.
   */
  realizedEvents: Array<{
    executionId: string;
    executedAt: string;
    date: string;
    time: string;
    closedVolumeCents: string;
    price: string;
    pnl: string;
    grossProfit: string;
    commission: string;
    swap: string;
    pnlConversionFee: string;
  }>;
  isOpen: boolean;
  tradeDate: string;
  entryAt: string;
  exitAt: string | null;
  entryTime: string;
  exitTime: string | null;
  classification: {
    symbolCategoryId: string | null;
    symbolCategoryName: string | null;
    assetClassId: string | null;
    assetClassName: string | null;
    reviewNeeded: boolean;
  };
};

export function projectPosition(input: {
  deals: readonly CTraderDeal[];
  lightSymbol: CTraderLightSymbol;
  symbolSpec: CTraderSymbolSpec;
  symbolCategories: ReadonlyMap<string, CTraderSymbolCategory>;
  assetClasses: ReadonlyMap<string, CTraderAssetClass>;
  accountMoneyDigits: number | null;
  timeZone: string;
}): CTraderTradeProjection {
  if (input.deals.length === 0) throw new CTraderProjectionError("POSITION_EMPTY", "No deals were supplied for the position");
  const deals = [...input.deals].sort((left, right) => {
    const byTime = left.executionTimestamp - right.executionTimestamp;
    return byTime !== 0 ? byTime : BigInt(left.dealId) < BigInt(right.dealId) ? -1 : 1;
  });
  const positionId = deals[0]?.positionId;
  if (!positionId) throw new CTraderProjectionError("POSITION_ID_MISSING", "Position ID is missing");
  if (deals.some((deal) => deal.positionId !== positionId)) {
    throw new CTraderProjectionError("POSITIONS_MIXED", "Deals from multiple cTrader positions cannot be projected together");
  }
  if (deals.some((deal) => deal.symbolId !== input.symbolSpec.symbolId)) {
    throw new CTraderProjectionError("SYMBOL_MISMATCH", `Position ${positionId} contains inconsistent symbols`);
  }

  const firstOpening = deals.find((deal) => deal.closePositionDetail === null);
  if (!firstOpening) {
    throw new CTraderProjectionError(
      "OPENING_DEAL_MISSING",
      `Position ${positionId} starts before the imported history bound; extend the authoritative full-history bound`,
    );
  }
  // An overlapping official replay can omit closePositionDetail. The immutable
  // opposite-side execution is still a realized close for volume/completeness;
  // it must not be reclassified as a new opening execution.
  const openingDeals = deals.filter((deal) =>
    deal.closePositionDetail === null && deal.tradeSide === firstOpening.tradeSide);
  const closingDeals = deals.filter((deal) =>
    deal.closePositionDetail !== null || deal.tradeSide !== firstOpening.tradeSide);
  if (closingDeals.some((deal) => deal.tradeSide === firstOpening.tradeSide)) {
    throw new CTraderProjectionError("CLOSE_SIDE_MISMATCH", `Position ${positionId} has a closing deal on the opening side`);
  }

  const openedVolume = openingDeals.reduce((sum, deal) => sum + deal.filledVolumeCents, 0n);
  const closedVolume = closingDeals.reduce(
    (sum, deal) => sum + (deal.closePositionDetail?.closedVolumeCents ?? deal.filledVolumeCents),
    0n,
  );
  if (closedVolume > openedVolume) {
    throw new CTraderProjectionError("CLOSED_VOLUME_EXCEEDS_OPEN", `Position ${positionId} closes more volume than it opened`);
  }
  const openVolume = openedVolume - closedVolume;
  const entryPrice = weightedPrice(openingDeals.map((deal) => ({ price: deal.executionPrice, volume: deal.filledVolumeCents })));
  const exitPrice = closingDeals.length === 0
    ? null
    : weightedPrice(closingDeals.map((deal) => ({
        price: deal.executionPrice,
        volume: deal.closePositionDetail?.closedVolumeCents ?? deal.filledVolumeCents,
      })));

  const gross: MoneyValue[] = [];
  const swaps: MoneyValue[] = [];
  const commissions: MoneyValue[] = [];
  const conversionFees: MoneyValue[] = [];
  const net: MoneyValue[] = [];
  const realizedEvents: CTraderTradeProjection["realizedEvents"] = [];
  let realizedPnlComplete = closingDeals.length > 0;
  for (const deal of closingDeals) {
    const close = deal.closePositionDetail;
    if (!close) {
      realizedPnlComplete = false;
      continue;
    }
    const digits = close.moneyDigits ?? deal.moneyDigits ?? input.accountMoneyDigits;
    if (digits === null) {
      throw new CTraderProjectionError("MONEY_DIGITS_MISSING", `Closing deal ${deal.dealId} has no authoritative moneyDigits`);
    }
    gross.push({ units: close.grossProfit, digits });
    swaps.push({ units: close.swap, digits });
    commissions.push({ units: close.commission, digits });
    conversionFees.push({ units: close.pnlConversionFee, digits });
    // Spotware documents pnlConversionFee as a fee charged to the account. The
    // gross/swap/commission values retain their provider signs; the fee is
    // therefore subtracted explicitly.
    const eventNet = close.grossProfit + close.swap + close.commission - close.pnlConversionFee;
    net.push({ units: eventNet, digits });
    const local = localDateTime(deal.executionTimestamp, input.timeZone);
    realizedEvents.push({
      executionId: deal.dealId,
      executedAt: new Date(deal.executionTimestamp).toISOString(),
      date: local.date,
      time: local.time,
      closedVolumeCents: (close.closedVolumeCents ?? deal.filledVolumeCents).toString(),
      price: String(deal.executionPrice),
      pnl: decimalFromScaledInteger(eventNet, digits),
      grossProfit: decimalFromScaledInteger(close.grossProfit, digits),
      commission: decimalFromScaledInteger(close.commission, digits),
      swap: decimalFromScaledInteger(close.swap, digits),
      pnlConversionFee: decimalFromScaledInteger(close.pnlConversionFee, digits),
    });
  }

  const category = input.lightSymbol.symbolCategoryId === null
    ? null
    : input.symbolCategories.get(input.lightSymbol.symbolCategoryId) ?? null;
  const assetClass = category === null ? null : input.assetClasses.get(category.assetClassId) ?? null;
  const asset = mapCTraderAssetCode(assetClass?.name ?? null, category?.name ?? null);
  const entryLocal = localDateTime(firstOpening.executionTimestamp, input.timeZone);
  const lastClose = closingDeals.at(-1) ?? null;
  const exitLocal = lastClose === null ? null : localDateTime(lastClose.executionTimestamp, input.timeZone);

  return {
    positionId,
    symbolId: input.symbolSpec.symbolId,
    symbol: input.symbolSpec.symbolName,
    asset,
    direction: firstOpening.tradeSide === "BUY" ? "Long" : "Short",
    entryPrice: String(entryPrice),
    exitPrice: exitPrice === null ? null : String(exitPrice),
    // Both values are protocol cents; they cancel. There is intentionally no
    // extra /100 here (10,000,000 / 10,000,000 is exactly one lot).
    quantityLots: decimalRatio(openedVolume, input.symbolSpec.lotSizeCents),
    openedVolumeCents: openedVolume.toString(),
    closedVolumeCents: closedVolume.toString(),
    openVolumeCents: openVolume.toString(),
    pnl: realizedPnlComplete ? sumMoney(net) : null,
    grossProfit: realizedPnlComplete ? sumMoney(gross) : null,
    commission: realizedPnlComplete ? sumMoney(commissions) : null,
    swap: realizedPnlComplete ? sumMoney(swaps) : null,
    pnlConversionFee: realizedPnlComplete ? sumMoney(conversionFees) : null,
    realizedPnlComplete,
    realizedEvents,
    isOpen: openVolume > 0n,
    tradeDate: entryLocal.date,
    entryAt: new Date(firstOpening.executionTimestamp).toISOString(),
    exitAt: lastClose === null ? null : new Date(lastClose.executionTimestamp).toISOString(),
    entryTime: entryLocal.time,
    exitTime: exitLocal?.time ?? null,
    classification: {
      symbolCategoryId: category?.id ?? input.lightSymbol.symbolCategoryId,
      symbolCategoryName: category?.name ?? null,
      assetClassId: assetClass?.id ?? category?.assetClassId ?? null,
      assetClassName: assetClass?.name ?? null,
      reviewNeeded: asset === null,
    },
  };
}
