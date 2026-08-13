import { describe, expect, it } from "vitest";
import { CTraderPayload, parseAuthorizedAccounts, parseCashFlows, parseDeals, parseLightSymbols } from "../src/ctrader/protocol.js";

describe("cTrader proto3 JSON defaults", () => {
  it("uses Spotware's official cash-flow payload identifiers", () => {
    expect(CTraderPayload.CASH_FLOW_HISTORY_LIST_REQ).toBe(2143);
    expect(CTraderPayload.CASH_FLOW_HISTORY_LIST_RES).toBe(2144);
  });

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

  it("parses exact signed account cash flows and preserves future operation names", () => {
    const parsed = parseCashFlows({
      depositWithdraw: [
        {
          operationType: "BALANCE_WITHDRAW_GSL_CHARGE",
          balanceHistoryId: "9007199254740991",
          balance: "123456789012345678",
          delta: "-1250000",
          changeBalanceTimestamp: "1770000000000",
          balanceVersion: "44",
          equity: "123456789012345679",
          moneyDigits: 6,
          externalNote: "not persisted by the account-ledger projection",
        },
        {
          operationType: "BALANCE_FUTURE_BROKER_ADJUSTMENT",
          balanceHistoryId: "2",
          balance: "10",
          delta: "1",
          changeBalanceTimestamp: "1770000000001",
        },
        {
          operationType: "2147483647",
          balanceHistoryId: "3",
          balance: "10",
          delta: "1",
          changeBalanceTimestamp: "1770000000002",
        },
      ],
    });
    expect(parsed[0]).toMatchObject({
      operationType: 17,
      operationName: "BALANCE_WITHDRAW_GSL_CHARGE",
      balanceHistoryId: "9007199254740991",
      balance: 123456789012345678n,
      delta: -1250000n,
      moneyDigits: 6,
    });
    expect(parsed[1]).toMatchObject({
      operationType: null,
      operationName: "BALANCE_FUTURE_BROKER_ADJUSTMENT",
    });
    expect(parsed[0]).not.toHaveProperty("externalNote");
    expect(parsed[2]).toMatchObject({
      operationType: 2147483647,
      operationName: "BALANCE_UNKNOWN_2147483647",
    });
  });
});
