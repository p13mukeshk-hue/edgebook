import { describe, expect, it } from "vitest";
import { parseAuthorizedAccounts, parseDeals, parseLightSymbols } from "../src/ctrader/protocol.js";

describe("cTrader proto3 JSON defaults", () => {
  it("treats an omitted isLive scalar as demo", () => {
    expect(parseAuthorizedAccounts({ ctidTraderAccount: [{ ctidTraderAccountId: "12" }] })[0]?.environment).toBe("demo");
  });

  it("retains explicit zero money scalars without inferring P&L", () => {
    const parsed = parseDeals({
      deal: [{
        dealId: "1",
        positionId: "2",
        volume: "100",
        filledVolume: "100",
        symbolId: "3",
        createTimestamp: "1000",
        executionTimestamp: "1000",
        executionPrice: 1,
        tradeSide: "BUY",
        dealStatus: "FILLED",
        closePositionDetail: { entryPrice: 1, grossProfit: 0, swap: 0, commission: 0, balance: 0 },
      }],
      hasMore: false,
    });
    expect(parsed.hasMore).toBe(false);
    expect(parsed.deals[0]?.closePositionDetail).toMatchObject({
      grossProfit: 0n,
      swap: 0n,
      commission: 0n,
      pnlConversionFee: 0n,
    });
  });

  it("retains archived symbol IDs and names for complete history projection", () => {
    const symbols = parseLightSymbols({
      symbol: [{ symbolId: "1", symbolName: "EURUSD", symbolCategoryId: "7" }],
      archivedSymbol: [{ symbolId: "2", name: "OLD.CFD" }],
    });
    expect(symbols).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbolId: "1", symbolName: "EURUSD", symbolCategoryId: "7" }),
      expect.objectContaining({ symbolId: "2", symbolName: "OLD.CFD", symbolCategoryId: null }),
    ]));
  });
});
