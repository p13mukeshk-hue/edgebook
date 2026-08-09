import { describe, expect, it, vi } from "vitest";
import { fetchCompleteDealHistory, CTraderSyncError } from "../src/ctrader/sync.js";
import type { CTraderDeal } from "../src/ctrader/protocol.js";

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
});
