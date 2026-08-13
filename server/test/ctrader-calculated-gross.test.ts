import { describe, expect, it } from "vitest";
import {
  calculateCTraderGrossFallback,
  CTraderCalculatedGrossError,
} from "../src/ctrader/calculated-gross.js";

const currency = {
  accountCurrency: "USD",
  depositAssetId: "15",
  accountMoneyDigits: 2,
  assetNames: new Map([["15", "USD"], ["16", "EUR"], ["17", "XAU"]]),
};
const symbol = {
  id: "41",
  name: "XAUUSD",
  baseAssetId: "17",
  quoteAssetId: "15",
  lotSize: 100,
  lotSizeSource: "verified_account_symbol_override",
  providerLotSizeScale: null,
  verifiedOverride: {
    symbolId: "41", symbolName: "XAUUSD", baseUnitsPerLot: 100, measurementUnit: "Oz",
  },
};
const deal = (input: Partial<{
  dealId: string; side: "BUY" | "SELL"; role: "OPEN" | "CLOSE" | null;
  filledVolumeCents: bigint; executionPrice: number; executionTimestamp: number;
}> = {}) => ({
  dealId: input.dealId ?? "1",
  side: input.side ?? "BUY",
  role: input.role ?? "OPEN",
  filledVolumeCents: input.filledVolumeCents ?? 200n,
  filledVolumeSourceKey: "filledVolume",
  filledVolumeScale: "unit_cents",
  executionPrice: input.executionPrice ?? 4_400,
  executionTimestamp: input.executionTimestamp ?? Date.parse("2026-08-12T04:49:17.842Z"),
});

describe("cTrader calculated gross fallback", () => {
  it.each([
    { position: "4568961", openingSide: "SELL" as const, entry: 4_417.03, exit: 4_428.60, expected: "-23.14" },
    { position: "4557022", openingSide: "BUY" as const, entry: 4_386.36, exit: 4_386.48, expected: "0.24" },
    { position: "4556640", openingSide: "SELL" as const, entry: 4_401.84, exit: 4_391.51, expected: "20.66" },
  ])("matches the audited live XAUUSD gross for position $position", ({ openingSide, entry, exit, expected }) => {
    const closingSide = openingSide === "BUY" ? "SELL" : "BUY";
    const result = calculateCTraderGrossFallback({
      deals: [
        deal({ dealId: "1", side: openingSide, role: "OPEN", executionPrice: entry }),
        deal({ dealId: "2", side: closingSide, role: "CLOSE", executionPrice: exit }),
      ],
      openingSide,
      symbol,
      currency,
    });
    expect(result?.calculatedGrossPnl).toBe(expected);
  });

  it("calculates long and short gross price movement from exact base units", () => {
    const long = calculateCTraderGrossFallback({
      deals: [deal(), deal({ dealId: "2", side: "SELL", role: "CLOSE", executionPrice: 4_410 })],
      openingSide: "BUY", symbol, currency,
    });
    const short = calculateCTraderGrossFallback({
      deals: [deal({ side: "SELL" }), deal({ dealId: "2", side: "BUY", role: "CLOSE", executionPrice: 4_390 })],
      openingSide: "SELL", symbol, currency,
    });
    expect(long?.calculatedGrossPnl).toBe("20");
    expect(short?.calculatedGrossPnl).toBe("20");
    expect(long?.calculatedGrossProvenance).toMatchObject({
      inputFingerprintSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      feesIncluded: false,
      analyticsTreatment: "excluded_from_net_pnl",
      quoteAssetId: "15",
      depositAssetId: "15",
      conversionRate: "1",
      symbolSpec: { baseUnitsPerLot: 100, measurementUnit: "Oz" },
      accountMoneyDigits: 2,
      baseAssetId: "17",
      baseAssetName: "XAU",
      roundingRule: "half_away_from_zero_at_account_money_digits",
      eventResidualAllocationRule: "largest_rounding_error_then_execution_order_v1",
    });
  });

  it("rounds the published amount to authoritative account money digits and fingerprints inputs", () => {
    const result = calculateCTraderGrossFallback({
      deals: [
        deal({ filledVolumeCents: 200n, executionPrice: 4_401.84 }),
        deal({ dealId: "2", side: "SELL", role: "CLOSE", filledVolumeCents: 200n, executionPrice: 4_391.51 }),
      ],
      openingSide: "BUY", symbol, currency,
    });
    expect(result?.calculatedGrossPnl).toBe("-20.66");
    expect(result?.calculatedGrossEvents[0]?.grossPnl).toBe("-20.66");
    expect(result?.calculatedGrossProvenance.inputFingerprintSha256).toMatch(/^[a-f0-9]{64}$/);
    const repeated = calculateCTraderGrossFallback({
      deals: [
        deal({ filledVolumeCents: 200n, executionPrice: 4_401.84 }),
        deal({ dealId: "2", side: "SELL", role: "CLOSE", filledVolumeCents: 200n, executionPrice: 4_391.51 }),
      ],
      openingSide: "BUY", symbol, currency,
    });
    expect(repeated).toEqual(result);
    expect(repeated?.calculatedGrossProvenance.inputFingerprintSha256)
      .toBe(result?.calculatedGrossProvenance.inputFingerprintSha256);
  });

  it("uses running weighted entry basis across scale-ins and partial closes", () => {
    const result = calculateCTraderGrossFallback({
      deals: [
        deal({ dealId: "1", filledVolumeCents: 100n, executionPrice: 4_400 }),
        deal({ dealId: "2", filledVolumeCents: 100n, executionPrice: 4_410 }),
        deal({ dealId: "3", side: "SELL", role: "CLOSE", filledVolumeCents: 50n, executionPrice: 4_425 }),
        deal({ dealId: "4", side: "SELL", role: "CLOSE", filledVolumeCents: 150n, executionPrice: 4_395 }),
      ],
      openingSide: "BUY", symbol, currency,
    });
    expect(result?.calculatedGrossEvents.map((event) => ({
      basis: event.entryBasisPrice, units: event.closedBaseUnits, gross: event.grossPnl,
    }))).toEqual([
      { basis: "4405", units: "0.5", gross: "10" },
      { basis: "4405", units: "1.5", gross: "-15" },
    ]);
    expect(result?.calculatedGrossPnl).toBe("-5");
  });

  it("orders same-millisecond numeric deal IDs numerically", () => {
    const timestamp = Date.parse("2026-08-12T04:49:17.842Z");
    const result = calculateCTraderGrossFallback({
      deals: [
        deal({ dealId: "10", side: "SELL", role: "CLOSE", executionPrice: 4_410, executionTimestamp: timestamp }),
        deal({ dealId: "2", side: "BUY", role: "OPEN", executionPrice: 4_400, executionTimestamp: timestamp }),
      ],
      openingSide: "BUY", symbol, currency,
    });
    expect(result?.calculatedGrossPnl).toBe("20");
    expect(result?.calculatedGrossEvents[0]?.executionId).toBe("10");
  });

  it("requires resolved base-asset identity and an attested or explicitly scaled contract size", () => {
    const deals = [deal(), deal({ dealId: "2", side: "SELL", role: "CLOSE", executionPrice: 4_410 })];
    expect(calculateCTraderGrossFallback({
      deals, openingSide: "BUY", symbol: { ...symbol, baseAssetId: null }, currency,
    })).toBeNull();
    expect(calculateCTraderGrossFallback({
      deals, openingSide: "BUY", symbol,
      currency: { ...currency, assetNames: new Map([["15", "USD"]]) },
    })).toBeNull();
    expect(calculateCTraderGrossFallback({
      deals,
      openingSide: "BUY",
      symbol: {
        ...symbol,
        lotSizeSource: "provider",
        providerLotSizeScale: null,
        verifiedOverride: null,
      },
      currency,
    })).toBeNull();
    const explicitProviderScale = calculateCTraderGrossFallback({
      deals,
      openingSide: "BUY",
      symbol: {
        ...symbol,
        lotSizeSource: "provider",
        providerLotSizeScale: "base_units_per_lot_v1",
        verifiedOverride: null,
      },
      currency,
    });
    expect(explicitProviderScale?.calculatedGrossPnl).toBe("20");
    expect(explicitProviderScale?.calculatedGrossProvenance.symbolSpec).toMatchObject({
      lotSizeSource: "provider",
      providerLotSizeScale: "base_units_per_lot_v1",
    });
  });

  it.each([
    { label: "positive ties", closePrice: 100.5, expectedTotal: "0.01", expectedEvents: ["0", "0.01"] },
    { label: "negative ties", closePrice: 99.5, expectedTotal: "-0.01", expectedEvents: ["0", "-0.01"] },
  ])("reconciles $label exactly at account precision", ({ closePrice, expectedTotal, expectedEvents }) => {
    const timestamp = Date.parse("2026-08-12T04:49:17.842Z");
    const result = calculateCTraderGrossFallback({
      deals: [
        deal({ dealId: "1", filledVolumeCents: 2n, executionPrice: 100, executionTimestamp: timestamp }),
        deal({ dealId: "2", side: "SELL", role: "CLOSE", filledVolumeCents: 1n, executionPrice: closePrice, executionTimestamp: timestamp + 1 }),
        deal({ dealId: "3", side: "SELL", role: "CLOSE", filledVolumeCents: 1n, executionPrice: closePrice, executionTimestamp: timestamp + 2 }),
      ],
      openingSide: "BUY", symbol, currency,
    });
    expect(result?.calculatedGrossPnl).toBe(expectedTotal);
    expect(result?.calculatedGrossEvents.map((event) => event.grossPnl)).toEqual(expectedEvents);
  });

  it("allocates a multi-event rounding residual deterministically", () => {
    const result = calculateCTraderGrossFallback({
      deals: [
        deal({ dealId: "1", filledVolumeCents: 3n, executionPrice: 100 }),
        deal({ dealId: "2", side: "SELL", role: "CLOSE", filledVolumeCents: 1n, executionPrice: 100.4, executionTimestamp: deal().executionTimestamp + 1 }),
        deal({ dealId: "3", side: "SELL", role: "CLOSE", filledVolumeCents: 1n, executionPrice: 100.4, executionTimestamp: deal().executionTimestamp + 2 }),
        deal({ dealId: "4", side: "SELL", role: "CLOSE", filledVolumeCents: 1n, executionPrice: 100.4, executionTimestamp: deal().executionTimestamp + 3 }),
      ],
      openingSide: "BUY", symbol, currency,
    });
    expect(result?.calculatedGrossPnl).toBe("0.01");
    expect(result?.calculatedGrossEvents.map((event) => event.grossPnl)).toEqual(["0.01", "0", "0"]);
  });

  it("refuses account/quote currency mismatch without an immutable close conversion rate", () => {
    expect(calculateCTraderGrossFallback({
      deals: [deal(), deal({ dealId: "2", side: "SELL", role: "CLOSE" })],
      openingSide: "BUY", symbol: { ...symbol, quoteAssetId: "16" }, currency,
    })).toBeNull();
  });

  it("withholds a partially open estimate while retaining correct partial-close arithmetic", () => {
    expect(calculateCTraderGrossFallback({
      deals: [
        deal({ filledVolumeCents: 200n, executionPrice: 4_400 }),
        deal({ dealId: "2", side: "SELL", role: "CLOSE", filledVolumeCents: 100n, executionPrice: 4_410 }),
      ],
      openingSide: "BUY", symbol, currency,
    })).toBeNull();
  });

  it("refuses unknown volume provenance and temporal over-closes", () => {
    expect(calculateCTraderGrossFallback({
      deals: [{ ...deal(), filledVolumeSourceKey: "volume", filledVolumeScale: "unknown" }],
      openingSide: "BUY", symbol, currency,
    })).toBeNull();
    expect(() => calculateCTraderGrossFallback({
      deals: [deal({ side: "SELL", role: "CLOSE" }), deal({ dealId: "2" })],
      openingSide: "BUY", symbol, currency,
    })).toThrowError(CTraderCalculatedGrossError);
  });
});
