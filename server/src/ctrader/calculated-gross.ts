import { createHash } from "node:crypto";

export const CTRADER_CALCULATED_GROSS_METHOD = "fill_price_base_units_identity_conversion_v1";

const VERIFIED_SYMBOL_OVERRIDE_SOURCE = "verified_account_symbol_override";
const PROVIDER_BASE_UNITS_PER_LOT_SCALE = "base_units_per_lot_v1";
const MONEY_ROUNDING_RULE = "half_away_from_zero_at_account_money_digits";
const EVENT_RESIDUAL_ALLOCATION_RULE = "largest_rounding_error_then_execution_order_v1";
const EXACT_VOLUME_SOURCE_KEYS = new Set(["filledVolume", "filledVolumeCents"]);

export class CTraderCalculatedGrossError extends Error {
  readonly code: "POSITION_VOLUME_INVALID" | "NUMERIC_OVERFLOW";

  constructor(code: CTraderCalculatedGrossError["code"], message: string) {
    super(message);
    this.name = "CTraderCalculatedGrossError";
    this.code = code;
  }
}

export type CalculatedGrossDeal = {
  dealId: string;
  side: "BUY" | "SELL";
  role: "OPEN" | "CLOSE" | null;
  filledVolumeCents: bigint;
  filledVolumeSourceKey: string | null;
  filledVolumeScale: string;
  executionPrice: number;
  executionTimestamp: number;
};

export type CalculatedGrossSymbol = {
  id: string;
  name: string;
  baseAssetId: string | null;
  quoteAssetId: string | null;
  lotSize: number | null;
  lotSizeSource: string;
  providerLotSizeScale: string | null;
  verifiedOverride: {
    symbolId: string;
    symbolName: string;
    baseUnitsPerLot: number;
    measurementUnit: string;
  } | null;
};

export type CalculatedGrossCurrencyContext = {
  accountCurrency: string | null;
  depositAssetId: string | null;
  accountMoneyDigits: number | null;
  assetNames: ReadonlyMap<string, string>;
};

export type CalculatedGrossResult = {
  calculatedGrossPnl: string;
  calculatedGrossCurrency: string;
  calculatedGrossMethod: typeof CTRADER_CALCULATED_GROSS_METHOD;
  calculatedGrossEvents: Array<{
    executionId: string;
    executedAt: string;
    direction: "Long" | "Short";
    entryBasisPrice: string;
    closePrice: string;
    closedVolumeCents: string;
    closedBaseUnits: string;
    quoteToAccountConversionRate: "1";
    grossPnl: string;
    currency: string;
  }>;
  calculatedGrossProvenance: {
    version: 1;
    inputFingerprintSha256: string;
    valueKind: "calculated_gross_price_movement";
    analyticsTreatment: "excluded_from_net_pnl";
    providerExactNetPriority: true;
    feesIncluded: false;
    excludedComponents: ["commission", "swap", "pnlConversionFee", "otherBrokerFees"];
    formula: "direction_x_close_minus_entry_basis_x_closed_base_units_x_conversion_rate";
    roundingRule: typeof MONEY_ROUNDING_RULE;
    eventResidualAllocationRule: typeof EVENT_RESIDUAL_ALLOCATION_RULE;
    accountMoneyDigits: number;
    baseAssetId: string;
    baseAssetName: string;
    quoteAssetId: string;
    depositAssetId: string;
    quoteCurrency: string;
    accountCurrency: string;
    currencySource: "provider_quote_and_deposit_asset_identity";
    conversionRate: "1";
    conversionRateSource: "identical_provider_asset_id";
    volumeScale: "unit_cents";
    volumeSourceKeys: string[];
    symbolSpec: {
      symbolId: string;
      symbolName: string;
      baseUnitsPerLot: number;
      lotSizeSource: string;
      providerLotSizeScale: string | null;
      measurementUnit: string | null;
    };
  };
};

type Fraction = { numerator: bigint; denominator: bigint };

function absolute(value: bigint): bigint { return value < 0n ? -value : value; }

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = absolute(left);
  let b = absolute(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
}

function fraction(numerator: bigint, denominator = 1n): Fraction {
  if (denominator === 0n) {
    throw new CTraderCalculatedGrossError("NUMERIC_OVERFLOW", "Calculated cTrader gross P&L has an invalid denominator");
  }
  const sign = denominator < 0n ? -1n : 1n;
  const common = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / common * sign, denominator: absolute(denominator) / common };
}

function add(left: Fraction, right: Fraction): Fraction {
  return fraction(
    left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator,
  );
}

function subtract(left: Fraction, right: Fraction): Fraction {
  return add(left, { numerator: -right.numerator, denominator: right.denominator });
}

function multiply(left: Fraction, right: Fraction): Fraction {
  return fraction(left.numerator * right.numerator, left.denominator * right.denominator);
}

function divide(left: Fraction, divisor: bigint): Fraction {
  return fraction(left.numerator, left.denominator * divisor);
}

function numberFraction(value: number): Fraction {
  if (!Number.isFinite(value) || value <= 0 || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
    throw new CTraderCalculatedGrossError("NUMERIC_OVERFLOW", "cTrader execution price exceeds safe numeric bounds");
  }
  const [mantissa, exponentText] = String(value).toLowerCase().split("e");
  const exponent = exponentText === undefined ? 0 : Number(exponentText);
  if (!Number.isSafeInteger(exponent) || mantissa === undefined) {
    throw new CTraderCalculatedGrossError("NUMERIC_OVERFLOW", "cTrader execution price has invalid precision");
  }
  const negative = mantissa.startsWith("-");
  const unsigned = negative ? mantissa.slice(1) : mantissa;
  const [integer = "0", decimals = ""] = unsigned.split(".");
  const digits = `${integer}${decimals}`.replace(/^0+(?=\d)/, "") || "0";
  let numerator = BigInt(digits) * (negative ? -1n : 1n);
  const scale = decimals.length - exponent;
  if (scale < 0) numerator *= 10n ** BigInt(-scale);
  return fraction(numerator, scale > 0 ? 10n ** BigInt(scale) : 1n);
}

function decimal(value: Fraction, digits = 10): string {
  return decimalFromMinorUnits(roundMinorUnits(value, digits), digits);
}

function roundMinorUnits(value: Fraction, digits: number): bigint {
  const safeBound = BigInt(Number.MAX_SAFE_INTEGER) * value.denominator;
  if (absolute(value.numerator) > safeBound) {
    throw new CTraderCalculatedGrossError("NUMERIC_OVERFLOW", "Calculated cTrader gross P&L exceeds safe numeric bounds");
  }
  const multiplier = 10n ** BigInt(digits);
  const scaled = absolute(value.numerator) * multiplier;
  let rounded = scaled / value.denominator;
  if ((scaled % value.denominator) * 2n >= value.denominator) rounded += 1n;
  return value.numerator < 0n ? -rounded : rounded;
}

function decimalFromMinorUnits(value: bigint, digits: number): string {
  const negative = value < 0n;
  const rounded = absolute(value);
  const padded = rounded.toString().padStart(digits + 1, "0");
  const integer = digits === 0 ? padded : padded.slice(0, -digits);
  const decimals = digits === 0 ? "" : padded.slice(-digits).replace(/0+$/, "");
  if (rounded === 0n) return "0";
  return `${negative ? "-" : ""}${integer}${decimals.length > 0 ? `.${decimals}` : ""}`;
}

function compareFractions(left: Fraction, right: Fraction): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function compareDealIds(left: string, right: string): number {
  if (/^\d+$/.test(left) && /^\d+$/.test(right)) {
    const leftNumber = BigInt(left);
    const rightNumber = BigInt(right);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  return left.localeCompare(right);
}

function verifiedSymbolSpecification(symbol: CalculatedGrossSymbol): {
  baseUnitsPerLot: number;
  measurementUnit: string | null;
} | null {
  if (!Number.isSafeInteger(symbol.lotSize) || (symbol.lotSize ?? 0) <= 0) return null;
  if (
    symbol.lotSizeSource === "provider"
    && symbol.providerLotSizeScale === PROVIDER_BASE_UNITS_PER_LOT_SCALE
  ) {
    return { baseUnitsPerLot: symbol.lotSize ?? 0, measurementUnit: null };
  }
  if (symbol.lotSizeSource !== VERIFIED_SYMBOL_OVERRIDE_SOURCE) return null;
  const override = symbol.verifiedOverride;
  if (
    override === null
    || override.symbolId !== symbol.id
    || override.symbolName !== symbol.name
    || override.baseUnitsPerLot !== symbol.lotSize
    || override.measurementUnit.length === 0
  ) return null;
  return { baseUnitsPerLot: override.baseUnitsPerLot, measurementUnit: override.measurementUnit };
}

/**
 * Calculates realized price movement only. It deliberately does not return a
 * net-P&L value: commissions, swap, conversion fees and broker-specific fees
 * remain unknown unless cTrader later supplies authoritative close money.
 */
export function calculateCTraderGrossFallback(input: {
  deals: readonly CalculatedGrossDeal[];
  openingSide: "BUY" | "SELL";
  symbol: CalculatedGrossSymbol;
  currency: CalculatedGrossCurrencyContext;
}): CalculatedGrossResult | null {
  const specification = verifiedSymbolSpecification(input.symbol);
  const baseAssetId = input.symbol.baseAssetId;
  const quoteAssetId = input.symbol.quoteAssetId;
  const depositAssetId = input.currency.depositAssetId;
  if (
    specification === null
    || baseAssetId === null
    || quoteAssetId === null
    || depositAssetId === null
  ) return null;
  // A non-identity conversion needs the provider's immutable per-close rate.
  // The Remote MCP response does not expose that field, so mismatch is a hard
  // no-estimate condition rather than an invitation to use a current FX rate.
  if (quoteAssetId !== depositAssetId) return null;
  const baseAssetName = input.currency.assetNames.get(baseAssetId) ?? null;
  const quoteCurrency = input.currency.assetNames.get(quoteAssetId) ?? null;
  const accountCurrency = input.currency.accountCurrency;
  if (
    baseAssetName === null
    || quoteCurrency === null
    || accountCurrency === null
    || quoteCurrency !== accountCurrency
    || !/^[A-Z]{3}$/.test(accountCurrency)
  ) return null;
  const rawMoneyDigits = input.currency.accountMoneyDigits;
  if (!Number.isSafeInteger(rawMoneyDigits) || (rawMoneyDigits ?? -1) < 0 || (rawMoneyDigits ?? 19) > 18) return null;
  const moneyDigits = rawMoneyDigits as number;
  if (input.deals.some((deal) =>
    deal.filledVolumeScale !== "unit_cents"
    || deal.filledVolumeSourceKey === null
    || !EXACT_VOLUME_SOURCE_KEYS.has(deal.filledVolumeSourceKey)
    || deal.filledVolumeCents <= 0n
    || deal.filledVolumeCents > BigInt(Number.MAX_SAFE_INTEGER)
    || !Number.isFinite(deal.executionPrice)
    || deal.executionPrice <= 0
  )) return null;
  if (
    input.symbol.lotSizeSource === VERIFIED_SYMBOL_OVERRIDE_SOURCE
    && input.deals.some((deal) => deal.filledVolumeSourceKey !== "filledVolume")
  ) return null;

  const direction = input.openingSide === "BUY" ? "Long" : "Short";
  const ordered = [...input.deals].sort((left, right) =>
    left.executionTimestamp - right.executionTimestamp || compareDealIds(left.dealId, right.dealId));
  let openVolumeCents = 0n;
  let averageEntryPrice: Fraction | null = null;
  let sawClose = false;
  let totalGross = fraction(0n);
  const eventDrafts: Array<{
    eventGross: Fraction;
    executionId: string;
    executedAt: string;
    direction: "Long" | "Short";
    entryBasisPrice: string;
    closePrice: string;
    closedVolumeCents: string;
    closedBaseUnits: string;
  }> = [];

  for (const deal of ordered) {
    const isOpening = deal.role === "OPEN" || (deal.role === null && deal.side === input.openingSide);
    const isClosing = deal.role === "CLOSE" || (deal.role === null && deal.side !== input.openingSide);
    if ((isOpening && deal.side !== input.openingSide) || (isClosing && deal.side === input.openingSide)) {
      throw new CTraderCalculatedGrossError("POSITION_VOLUME_INVALID", "cTrader position sides conflict with their execution roles");
    }
    if (isOpening) {
      const nextVolume = openVolumeCents + deal.filledVolumeCents;
      if (nextVolume > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new CTraderCalculatedGrossError("NUMERIC_OVERFLOW", "cTrader position volume exceeds safe numeric bounds");
      }
      const price = numberFraction(deal.executionPrice);
      averageEntryPrice = averageEntryPrice === null
        ? price
        : divide(add(
          multiply(averageEntryPrice, fraction(openVolumeCents)),
          multiply(price, fraction(deal.filledVolumeCents)),
        ), nextVolume);
      openVolumeCents = nextVolume;
      continue;
    }
    if (!isClosing) continue;
    sawClose = true;
    if (averageEntryPrice === null || deal.filledVolumeCents > openVolumeCents) {
      throw new CTraderCalculatedGrossError("POSITION_VOLUME_INVALID", "cTrader closes volume before a matching opening execution");
    }
    const closedBaseUnits = fraction(deal.filledVolumeCents, 100n);
    const closePrice = numberFraction(deal.executionPrice);
    const priceMove = direction === "Long"
      ? subtract(closePrice, averageEntryPrice)
      : subtract(averageEntryPrice, closePrice);
    const eventGross = multiply(priceMove, closedBaseUnits);
    totalGross = add(totalGross, eventGross);
    decimal(totalGross);
    eventDrafts.push({
      eventGross,
      executionId: deal.dealId,
      executedAt: new Date(deal.executionTimestamp).toISOString(),
      direction,
      entryBasisPrice: decimal(averageEntryPrice),
      closePrice: decimal(closePrice),
      closedVolumeCents: deal.filledVolumeCents.toString(),
      closedBaseUnits: decimal(closedBaseUnits),
    });
    openVolumeCents -= deal.filledVolumeCents;
    if (openVolumeCents === 0n) averageEntryPrice = null;
  }
  // A partial-close ledger is calculated correctly above, but it is not
  // published as a fallback until the imported position is fully closed.
  if (!sawClose || eventDrafts.length === 0 || openVolumeCents !== 0n) return null;
  const volumeSourceKeys = [...new Set(input.deals.map((deal) => deal.filledVolumeSourceKey as string))].sort();
  const totalMinorUnits = roundMinorUnits(totalGross, moneyDigits);
  const eventMinorUnits = eventDrafts.map((event) => roundMinorUnits(event.eventGross, moneyDigits));
  let residual = totalMinorUnits - eventMinorUnits.reduce((sum, value) => sum + value, 0n);
  if (residual !== 0n) {
    const errors = eventDrafts.map((event, index) => ({
      index,
      error: subtract(
        event.eventGross,
        fraction(eventMinorUnits[index] ?? 0n, 10n ** BigInt(moneyDigits)),
      ),
    }));
    errors.sort((left, right) => {
      const comparison = compareFractions(left.error, right.error);
      return (residual > 0n ? -comparison : comparison) || left.index - right.index;
    });
    let cursor = 0;
    while (residual !== 0n) {
      const target = errors[cursor % errors.length];
      if (!target) throw new CTraderCalculatedGrossError("NUMERIC_OVERFLOW", "Calculated cTrader gross P&L residual cannot be allocated");
      const adjustment = residual > 0n ? 1n : -1n;
      eventMinorUnits[target.index] = (eventMinorUnits[target.index] ?? 0n) + adjustment;
      residual -= adjustment;
      cursor += 1;
    }
  }
  const events: CalculatedGrossResult["calculatedGrossEvents"] = eventDrafts.map((event, index) => ({
    executionId: event.executionId,
    executedAt: event.executedAt,
    direction: event.direction,
    entryBasisPrice: event.entryBasisPrice,
    closePrice: event.closePrice,
    closedVolumeCents: event.closedVolumeCents,
    closedBaseUnits: event.closedBaseUnits,
    quoteToAccountConversionRate: "1",
    grossPnl: decimalFromMinorUnits(eventMinorUnits[index] ?? 0n, moneyDigits),
    currency: accountCurrency,
  }));
  const fingerprintInput = {
    version: 1,
    method: CTRADER_CALCULATED_GROSS_METHOD,
    symbolId: input.symbol.id,
    symbolName: input.symbol.name,
    baseAssetId,
    baseAssetName,
    quoteAssetId,
    depositAssetId,
    accountCurrency,
    accountMoneyDigits: moneyDigits,
    roundingRule: MONEY_ROUNDING_RULE,
    eventResidualAllocationRule: EVENT_RESIDUAL_ALLOCATION_RULE,
    baseUnitsPerLot: specification.baseUnitsPerLot,
    lotSizeSource: input.symbol.lotSizeSource,
    providerLotSizeScale: input.symbol.providerLotSizeScale,
    deals: ordered.map((deal) => ({
      dealId: deal.dealId,
      side: deal.side,
      role: deal.role,
      filledVolumeCents: deal.filledVolumeCents.toString(),
      filledVolumeSourceKey: deal.filledVolumeSourceKey,
      filledVolumeScale: deal.filledVolumeScale,
      executionPrice: String(deal.executionPrice),
      executionTimestamp: deal.executionTimestamp,
    })),
  };
  return {
    calculatedGrossPnl: decimalFromMinorUnits(totalMinorUnits, moneyDigits),
    calculatedGrossCurrency: accountCurrency,
    calculatedGrossMethod: CTRADER_CALCULATED_GROSS_METHOD,
    calculatedGrossEvents: events,
    calculatedGrossProvenance: {
      version: 1,
      inputFingerprintSha256: createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex"),
      valueKind: "calculated_gross_price_movement",
      analyticsTreatment: "excluded_from_net_pnl",
      providerExactNetPriority: true,
      feesIncluded: false,
      excludedComponents: ["commission", "swap", "pnlConversionFee", "otherBrokerFees"],
      formula: "direction_x_close_minus_entry_basis_x_closed_base_units_x_conversion_rate",
      roundingRule: MONEY_ROUNDING_RULE,
      eventResidualAllocationRule: EVENT_RESIDUAL_ALLOCATION_RULE,
      accountMoneyDigits: moneyDigits,
      baseAssetId,
      baseAssetName,
      quoteAssetId,
      depositAssetId,
      quoteCurrency,
      accountCurrency,
      currencySource: "provider_quote_and_deposit_asset_identity",
      conversionRate: "1",
      conversionRateSource: "identical_provider_asset_id",
      volumeScale: "unit_cents",
      volumeSourceKeys,
      symbolSpec: {
        symbolId: input.symbol.id,
        symbolName: input.symbol.name,
        baseUnitsPerLot: specification.baseUnitsPerLot,
        lotSizeSource: input.symbol.lotSizeSource,
        providerLotSizeScale: input.symbol.providerLotSizeScale,
        measurementUnit: specification.measurementUnit,
      },
    },
  };
}
