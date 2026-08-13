import { describe, expect, it, vi } from "vitest";
import {
  fetchCompleteCashFlowHistory,
  fetchCompleteDealHistory,
  mergeOfficialDealFacts,
  mergeStoredCashFlowFacts,
  mergeStoredExecutionWithOfficial,
  resolveCashFlowMoneyScale,
  CTraderSyncError,
} from "../src/ctrader/sync.js";
import type { CTraderCashFlow, CTraderDeal } from "../src/ctrader/protocol.js";

function stubDeal(id: string, timestamp: number): CTraderDeal {
  return {
    dealId: id,
    orderId: null,
    positionId: id,
    volumeCents: 100n,
    filledVolumeCents: 100n,
    symbolId: "1",
    createTimestamp: timestamp,
    executionTimestamp: timestamp,
    providerUpdatedTimestamp: null,
    executionPrice: 10,
    tradeSide: "BUY",
    dealStatus: 2,
    moneyDigits: 2,
    commission: null,
    closePositionDetail: null,
    raw: { dealId: id },
  };
}

function stubCashFlow(id: string, timestamp: number): CTraderCashFlow {
  return {
    balanceHistoryId: id,
    operationType: 17,
    operationName: "BALANCE_WITHDRAW_GSL_CHARGE",
    balance: 10_000n,
    delta: -100n,
    changeBalanceTimestamp: timestamp,
    balanceVersion: null,
    equity: null,
    moneyDigits: 2,
  };
}

describe("complete cTrader history retrieval", () => {
  it("bisects saturated ranges and deduplicates overlapping provider rows", async () => {
    const one = stubDeal("1", 10);
    const two = stubDeal("2", 90);
    const listDeals = vi.fn(async (from: number, to: number) => {
      if (from === 0 && to === 100) return { deals: [one, two], hasMore: true };
      if (to <= 50) return { deals: [one], hasMore: false };
      return { deals: [two], hasMore: false };
    });
    const heartbeat = vi.fn(async () => undefined);
    const deals = await fetchCompleteDealHistory({ listDeals }, 0, 100, 2, heartbeat);
    expect(deals.map((deal) => deal.dealId)).toEqual(["1", "2"]);
    expect(listDeals).toHaveBeenCalledTimes(3);
    expect(heartbeat).toHaveBeenCalledTimes(3);
  });

  it("fails explicitly when a single millisecond cannot be proven complete", async () => {
    const listDeals = vi.fn(async () => ({ deals: [stubDeal("1", 50)], hasMore: true }));
    await expect(fetchCompleteDealHistory({ listDeals }, 50, 50, 1)).rejects.toMatchObject<CTraderSyncError>({
      code: "HISTORY_PAGE_SATURATED",
      retryable: false,
    });
  });

  it("preserves exact official close money across a weaker replay and fails closed on a conflicting exact replay", () => {
    const exact = stubDeal("1", 50);
    exact.tradeSide = "SELL";
    exact.closePositionDetail = {
      entryPrice: 10,
      grossProfit: 1_000n,
      swap: -5n,
      commission: -10n,
      balance: 100_000n,
      closedVolumeCents: 100n,
      moneyDigits: 2,
      pnlConversionFee: 2n,
      raw: {
        entryPrice: 10,
        grossProfit: "1000",
        swap: "-5",
        commission: "-10",
        balance: "100000",
        closedVolume: "100",
        moneyDigits: 2,
        pnlConversionFee: "2",
      },
    };
    exact.raw = {
      dealId: "1", positionId: "1", volume: "100", filledVolume: "100", symbolId: "1",
      createTimestamp: "50", executionTimestamp: "50", executionPrice: 10,
      tradeSide: "SELL", dealStatus: "FILLED", closePositionDetail: exact.closePositionDetail.raw,
    };
    const weak = { ...stubDeal("1", 50), tradeSide: "SELL" as const };
    const retained = mergeOfficialDealFacts(exact, weak);
    expect(retained.closePositionDetail).toEqual(exact.closePositionDetail);
    expect(retained.raw.closePositionDetail).toEqual(exact.closePositionDetail.raw);
    const conflicting = {
      ...exact,
      closePositionDetail: { ...exact.closePositionDetail, grossProfit: 1_001n },
    };
    expect(() => mergeOfficialDealFacts(exact, conflicting)).toThrowError(expect.objectContaining({
      code: "CTRADER_OFFICIAL_DEAL_CONFLICT",
    }));
  });

  it("replays exact official close money using the authoritative account exponent when deal digits are omitted", () => {
    const first = stubDeal("1", 50);
    first.tradeSide = "SELL";
    first.moneyDigits = null;
    first.closePositionDetail = {
      entryPrice: 9, grossProfit: 1_000n, swap: -5n, commission: -10n,
      balance: 100_000n, closedVolumeCents: 100n, moneyDigits: null,
      pnlConversionFee: 2n, raw: {
        entryPrice: 9, grossProfit: "1000", swap: "-5", commission: "-10",
        balance: "100000", closedVolume: "100", pnlConversionFee: "2",
      },
    };
    first.raw = { ...first.raw, replay: "first", closePositionDetail: first.closePositionDetail.raw };
    const replay = {
      ...first,
      providerUpdatedTimestamp: 60,
      raw: { ...first.raw, replay: "later" },
      closePositionDetail: {
        ...first.closePositionDetail,
        raw: { ...first.closePositionDetail.raw, replay: "later" },
      },
    };

    const merged = mergeOfficialDealFacts(first, replay, 2);

    expect(merged.closePositionDetail).toEqual(replay.closePositionDetail);
    expect(() => mergeOfficialDealFacts(first, {
      ...replay,
      closePositionDetail: { ...replay.closePositionDetail, grossProfit: 1_001n },
    }, 2)).toThrowError(expect.objectContaining({ code: "CTRADER_OFFICIAL_DEAL_CONFLICT" }));
  });

  it("keeps account-scaled exact money when a saturated first sync sees a weaker overlapping replay", async () => {
    const exact = stubDeal("1", 10);
    exact.tradeSide = "SELL";
    exact.moneyDigits = null;
    exact.providerUpdatedTimestamp = 10;
    exact.closePositionDetail = {
      entryPrice: 9, grossProfit: 1_000n, swap: -5n, commission: -10n,
      balance: 100_000n, closedVolumeCents: 100n, moneyDigits: null,
      pnlConversionFee: 2n, raw: {
        entryPrice: 9, grossProfit: "1000", swap: "-5", commission: "-10",
        balance: "100000", closedVolume: "100", pnlConversionFee: "2",
      },
    };
    exact.raw = { dealId: "1", observation: "exact", closePositionDetail: exact.closePositionDetail.raw };
    const weak = {
      ...exact,
      providerUpdatedTimestamp: 20,
      closePositionDetail: null,
      raw: { dealId: "1", observation: "weak" },
    };
    const other = stubDeal("2", 90);
    const listDeals = vi.fn(async (from: number, to: number) => {
      if (from === 0 && to === 100) return { deals: [exact, other], hasMore: true };
      if (to <= 50) return { deals: [weak], hasMore: false };
      return { deals: [other], hasMore: false };
    });

    const fetched = await fetchCompleteDealHistory({ listDeals }, 0, 100, 2, async () => undefined, 2);

    expect(fetched.find(deal => deal.dealId === "1")?.closePositionDetail).toEqual(exact.closePositionDetail);
  });

  it("safely adopts matching MCP executions into the official account without downgrading exact money", () => {
    const official = stubDeal("1", 50);
    official.positionId = "9";
    official.symbolId = "41";
    official.orderId = "8";
    const canonical = (closePositionDetail: unknown, netPnlCents: number | null = null) => ({
      edgebookMcpDeal: {
        version: 1, dealId: "1", positionId: "9", orderId: "8", symbolId: "41",
        symbolName: "EURUSD", accountId: "5032134", side: "BUY", role: closePositionDetail ? "CLOSE" : "OPEN",
        filledVolumeCents: "100", filledVolumeSourceKey: "filledVolume",
        filledVolumeScale: "unit_cents", executionPrice: 10, executionTimestamp: 50,
        dealStatus: 2, providerUpdatedTimestamp: null, netPnlCents,
        commissionCents: null, swapCents: null, closePositionDetail,
      },
    });
    expect(mergeStoredExecutionWithOfficial("1", canonical(null), official, "5032134")).toBe(official);

    const exactOfficial = { ...official, tradeSide: "SELL" as const };
    exactOfficial.closePositionDetail = {
      entryPrice: 9, grossProfit: 1_000n, swap: -5n, commission: -10n,
      balance: 100_000n, closedVolumeCents: 100n, moneyDigits: 2,
      pnlConversionFee: 2n, raw: {},
    };
    const exactCanonical = canonical({
      grossProfit: "1000", swap: "-5", commission: "-10", pnlConversionFee: "2", moneyDigits: 2,
    });
    (exactCanonical.edgebookMcpDeal as Record<string, unknown>).side = "SELL";
    (exactCanonical.edgebookMcpDeal as Record<string, unknown>).role = "CLOSE";
    expect(mergeStoredExecutionWithOfficial("1", exactCanonical, exactOfficial, "5032134")).toBe(exactOfficial);
    expect(() => mergeStoredExecutionWithOfficial("1", exactCanonical, { ...exactOfficial, closePositionDetail: null }, "5032134"))
      .toThrowError(expect.objectContaining({ code: "CTRADER_OFFICIAL_DEAL_DOWNGRADE" }));
    expect(() => mergeStoredExecutionWithOfficial("1", exactCanonical, {
      ...exactOfficial,
      closePositionDetail: { ...exactOfficial.closePositionDetail!, grossProfit: 1_001n },
    }, "5032134")).toThrowError(expect.objectContaining({ code: "CTRADER_OFFICIAL_DEAL_CONFLICT" }));

    const accountScaledOfficial = {
      ...exactOfficial,
      moneyDigits: null,
      closePositionDetail: {
        ...exactOfficial.closePositionDetail!,
        moneyDigits: null,
        raw: {
          grossProfit: "1000", swap: "-5", commission: "-10",
          pnlConversionFee: "2", balance: "100000", entryPrice: 9,
        },
      },
    };
    expect(mergeStoredExecutionWithOfficial(
      "1", exactCanonical, accountScaledOfficial, "5032134", 2,
    )).toBe(accountScaledOfficial);
  });

  it("walks every official seven-day cash-flow window without overlap gaps", async () => {
    const week = 7 * 24 * 60 * 60 * 1_000;
    const first = stubCashFlow("1", week - 1);
    const second = stubCashFlow("2", week);
    const listCashFlows = vi.fn(async (from: number, to: number) => {
      return [first, second].filter(flow => flow.changeBalanceTimestamp >= from && flow.changeBalanceTimestamp <= to);
    });
    const heartbeat = vi.fn(async () => undefined);
    const cashFlows = await fetchCompleteCashFlowHistory({ listCashFlows }, 0, week + 1, heartbeat);
    expect(listCashFlows.mock.calls).toEqual([[0, week - 1], [week, week + 1]]);
    expect(cashFlows.map(flow => flow.balanceHistoryId)).toEqual(["1", "2"]);
    expect(heartbeat).toHaveBeenCalledTimes(2);
  });

  it("uses one request for an exact inclusive seven-day cash-flow range", async () => {
    const week = 7 * 24 * 60 * 60 * 1_000;
    const listCashFlows = vi.fn(async () => []);
    await fetchCompleteCashFlowHistory({ listCashFlows }, 500, 500 + week - 1);
    expect(listCashFlows.mock.calls).toEqual([[500, 500 + week - 1]]);
  });

  it("rejects a provider cash-flow outside its requested window", async () => {
    const listCashFlows = vi.fn(async () => [stubCashFlow("1", 101)]);
    await expect(fetchCompleteCashFlowHistory({ listCashFlows }, 0, 100)).rejects.toMatchObject<CTraderSyncError>({
      code: "CASH_FLOW_OUT_OF_RANGE",
      retryable: false,
    });
  });

  it("rejects conflicting payloads for one immutable cash-flow identity", async () => {
    const week = 7 * 24 * 60 * 60 * 1_000;
    const listCashFlows = vi.fn(async (from: number) => [
      stubCashFlow("1", from === 0 ? week - 1 : week),
    ].map(flow => from === 0 ? flow : { ...flow, delta: -101n }));
    await expect(fetchCompleteCashFlowHistory({ listCashFlows }, 0, week)).rejects.toMatchObject<CTraderSyncError>({
      code: "CASH_FLOW_ID_CONFLICT",
      retryable: false,
    });
  });

  it("ranks row moneyDigits above account fallback and never silently changes an immutable row exponent", () => {
    expect(resolveCashFlowMoneyScale({ cashFlowMoneyDigits: 3, accountMoneyDigits: 2 })).toEqual({
      moneyDigits: 3,
      source: "cash_flow",
    });
    expect(resolveCashFlowMoneyScale({ cashFlowMoneyDigits: null, accountMoneyDigits: 2 })).toEqual({
      moneyDigits: 2,
      source: "account",
    });
    expect(resolveCashFlowMoneyScale({
      cashFlowMoneyDigits: null,
      accountMoneyDigits: 2,
      stored: { moneyDigits: 3, source: "cash_flow" },
    })).toEqual({ moneyDigits: 3, source: "cash_flow" });
    expect(resolveCashFlowMoneyScale({
      cashFlowMoneyDigits: null,
      accountMoneyDigits: null,
      stored: { moneyDigits: 2, source: "account" },
    })).toEqual({ moneyDigits: 2, source: "account" });
    expect(() => resolveCashFlowMoneyScale({
      cashFlowMoneyDigits: 4,
      accountMoneyDigits: 2,
      stored: { moneyDigits: 3, source: "cash_flow" },
    })).toThrowError(expect.objectContaining({ code: "CASH_FLOW_MONEY_DIGITS_CONFLICT" }));
    expect(() => resolveCashFlowMoneyScale({
      cashFlowMoneyDigits: null,
      accountMoneyDigits: 3,
      stored: { moneyDigits: 2, source: "account" },
    })).toThrowError(expect.objectContaining({ code: "CASH_FLOW_ACCOUNT_MONEY_DIGITS_CONFLICT" }));
  });

  it("preserves optional immutable cash-flow enrichment and rejects cross-sync identity conflicts", () => {
    const incoming = stubCashFlow("7", 500);
    const stored = {
      external_cash_flow_id: "7",
      operation_type: 17,
      operation_name: incoming.operationName,
      raw_delta: incoming.delta.toString(),
      raw_balance: incoming.balance.toString(),
      raw_equity: "9999",
      balance_version: "8",
      occurred_at: new Date(500),
    };
    expect(mergeStoredCashFlowFacts(stored, incoming)).toMatchObject({
      equity: 9_999n,
      balanceVersion: 8n,
      operationType: 17,
    });
    expect(() => mergeStoredCashFlowFacts(stored, { ...incoming, delta: -101n }))
      .toThrowError(expect.objectContaining({ code: "CASH_FLOW_ID_CONFLICT" }));
    expect(() => mergeStoredCashFlowFacts(stored, { ...incoming, equity: 9_998n }))
      .toThrowError(expect.objectContaining({ code: "CASH_FLOW_ID_CONFLICT" }));
  });
});
