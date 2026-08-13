import { describe, expect, it } from "vitest";
import { projectPosition } from "../src/ctrader/projection.js";
import type {
  CTraderDeal,
  CTraderLightSymbol,
  CTraderSymbolSpec,
} from "../src/ctrader/protocol.js";

function deal(input: {
  id: string;
  side: "BUY" | "SELL";
  time: string;
  volume: bigint;
  close?: boolean;
}): CTraderDeal {
  const timestamp = new Date(input.time).getTime();
  return {
    dealId: input.id,
    orderId: `9${input.id}`,
    positionId: "7001",
    volumeCents: input.volume,
    filledVolumeCents: input.volume,
    symbolId: "101",
    createTimestamp: timestamp,
    executionTimestamp: timestamp,
    providerUpdatedTimestamp: timestamp,
    executionPrice: input.close ? 1.25 : 1.2,
    tradeSide: input.side,
    dealStatus: 2,
    moneyDigits: null,
    commission: null,
    closePositionDetail: input.close
      ? {
          entryPrice: 1.2,
          grossProfit: 12_345n,
          swap: -100n,
          commission: -50n,
          balance: 1_000_000n,
          closedVolumeCents: input.volume,
          moneyDigits: null,
          pnlConversionFee: 25n,
          raw: {},
        }
      : null,
    raw: {},
  };
}

const light: CTraderLightSymbol = {
  symbolId: "101",
  symbolName: "EURUSD",
  baseAssetId: "1",
  quoteAssetId: "2",
  symbolCategoryId: "10",
  raw: {},
};

const spec: CTraderSymbolSpec = {
  symbolId: "101",
  symbolName: "EURUSD",
  lotSizeCents: 10_000_000n,
  digits: 5,
  pipPosition: 4,
  raw: {},
};

describe("cTrader position projection", () => {
  it("uses protocol cents exactly once, authoritative P&L, and the journal timezone", () => {
    const projection = projectPosition({
      deals: [
        deal({ id: "1", side: "BUY", time: "2026-01-01T18:31:00.000Z", volume: 10_000_000n }),
        deal({ id: "2", side: "SELL", time: "2026-01-02T03:00:00.000Z", volume: 5_000_000n, close: true }),
      ],
      lightSymbol: light,
      symbolSpec: spec,
      symbolCategories: new Map([["10", { id: "10", assetClassId: "20", name: "Majors", raw: {} }]]),
      assetClasses: new Map([["20", { id: "20", name: "Forex", raw: {} }]]),
      accountMoneyDigits: 2,
      timeZone: "Asia/Kolkata",
    });

    expect(projection.quantityLots).toBe("1");
    expect(projection.openedVolumeCents).toBe("10000000");
    expect(projection.closedVolumeCents).toBe("5000000");
    expect(projection.openVolumeCents).toBe("5000000");
    expect(projection.isOpen).toBe(true);
    expect(projection.pnl).toBe("121.7");
    expect(projection.grossProfit).toBe("123.45");
    expect(projection.swap).toBe("-1");
    expect(projection.commission).toBe("-0.5");
    expect(projection.pnlConversionFee).toBe("0.25");
    expect(projection.asset).toBe("fx");
    expect(projection.tradeDate).toBe("2026-01-02");
    expect(projection.entryTime).toBe("00:01:00");
    expect(projection.entryAt).toBe("2026-01-01T18:31:00.000Z");
    expect(projection.realizedEvents).toEqual([
      expect.objectContaining({
        executionId: "2",
        executedAt: "2026-01-02T03:00:00.000Z",
        date: "2026-01-02",
        time: "08:30:00",
        closedVolumeCents: "5000000",
        pnl: "121.7",
        grossProfit: "123.45",
        swap: "-1",
        commission: "-0.5",
        pnlConversionFee: "0.25",
      }),
    ]);
  });

  it("keeps partial closes as an actual-date realized ledger across months", () => {
    const projection = projectPosition({
      deals: [
        deal({ id: "1", side: "BUY", time: "2026-01-15T09:00:00.000Z", volume: 10_000_000n }),
        deal({ id: "2", side: "SELL", time: "2026-02-01T18:31:00.000Z", volume: 2_000_000n, close: true }),
        deal({ id: "3", side: "SELL", time: "2026-02-03T03:00:00.000Z", volume: 3_000_000n, close: true }),
      ],
      lightSymbol: light,
      symbolSpec: spec,
      symbolCategories: new Map([["10", { id: "10", assetClassId: "20", name: "Majors", raw: {} }]]),
      assetClasses: new Map([["20", { id: "20", name: "Forex", raw: {} }]]),
      accountMoneyDigits: 2,
      timeZone: "Asia/Kolkata",
    });

    expect(projection.tradeDate).toBe("2026-01-15");
    expect(projection.isOpen).toBe(true);
    expect(projection.pnl).toBe("243.4");
    expect(projection.realizedEvents.map((event) => ({ id: event.executionId, date: event.date, pnl: event.pnl }))).toEqual([
      { id: "2", date: "2026-02-02", pnl: "121.7" },
      { id: "3", date: "2026-02-03", pnl: "121.7" },
    ]);
  });

  it("retains all eighteen provider monetary digits in exact net and components", () => {
    const opening = deal({ id: "1", side: "BUY", time: "2026-01-01T00:00:00.000Z", volume: 10_000_000n });
    const closing = deal({ id: "2", side: "SELL", time: "2026-01-02T00:00:00.000Z", volume: 10_000_000n, close: true });
    closing.closePositionDetail = {
      ...closing.closePositionDetail!,
      grossProfit: 123_456_789_012_345_678n,
      swap: -1_000_000_000_000_000n,
      commission: -500_000_000_000_000n,
      pnlConversionFee: 250_000_000_000_000n,
      moneyDigits: 18,
    };
    const projection = projectPosition({
      deals: [opening, closing],
      lightSymbol: light,
      symbolSpec: spec,
      symbolCategories: new Map(),
      assetClasses: new Map(),
      accountMoneyDigits: null,
      timeZone: "UTC",
    });
    expect(projection).toMatchObject({
      pnl: "0.121706789012345678",
      grossProfit: "0.123456789012345678",
      swap: "-0.001",
      commission: "-0.0005",
      pnlConversionFee: "0.00025",
    });
  });

  it("does not present a partial close-money aggregate as the position total", () => {
    const opening = deal({ id: "1", side: "BUY", time: "2026-01-01T00:00:00.000Z", volume: 10_000_000n });
    const exactClose = deal({ id: "2", side: "SELL", time: "2026-01-02T00:00:00.000Z", volume: 4_000_000n, close: true });
    const missingCloseMoney = deal({ id: "3", side: "SELL", time: "2026-01-03T00:00:00.000Z", volume: 6_000_000n });
    const projection = projectPosition({
      deals: [opening, exactClose, missingCloseMoney],
      lightSymbol: light,
      symbolSpec: spec,
      symbolCategories: new Map(),
      assetClasses: new Map(),
      accountMoneyDigits: 2,
      timeZone: "UTC",
    });
    expect(projection).toMatchObject({
      closedVolumeCents: "10000000",
      openVolumeCents: "0",
      isOpen: false,
      realizedPnlComplete: false,
      pnl: null,
      grossProfit: null,
      commission: null,
      swap: null,
      pnlConversionFee: null,
    });
    expect(projection.realizedEvents.map(event => event.executionId)).toEqual(["2"]);
  });

  it("does not guess an asset class from the symbol name", () => {
    const projection = projectPosition({
      deals: [deal({ id: "1", side: "BUY", time: "2026-01-01T00:00:00.000Z", volume: 10_000_000n })],
      lightSymbol: { ...light, symbolCategoryId: null },
      symbolSpec: spec,
      symbolCategories: new Map(),
      assetClasses: new Map(),
      accountMoneyDigits: 2,
      timeZone: "Asia/Kolkata",
    });
    expect(projection.asset).toBeNull();
    expect(projection.classification.reviewNeeded).toBe(true);
  });
});
