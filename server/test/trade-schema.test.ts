import { describe, expect, it } from "vitest";
import { normalizeTrade } from "../src/modules/trades/schema.js";
import { mapTrade } from "../src/modules/trades/routes.js";

describe("trade contract", () => {
  it("preserves frontend and account legacy identifiers", () => {
    const trade = normalizeTrade({
      id: 1_723_456_789,
      accountId: "acct_1",
      source: "zerodha",
      ingestionMethod: "csv",
      symbol: "NIFTY",
      direction: "Long",
      entry: 24_000.25,
      size: 2,
      date: "2026-08-08",
    });
    expect(trade.legacyId).toBe("1723456789");
    expect(trade.accountId).toBe("acct_1");
    expect(trade.internalAccountId).toBeNull();
    expect(trade.sourceSystem).toBe("zerodha");
    expect(trade.ingestionMethod).toBe("csv");
  });

  it("rejects negative position sizes", () => {
    expect(() => normalizeTrade({
      symbol: "AAPL",
      direction: "Long",
      entry: 100,
      size: -1,
      date: "2026-08-08",
    })).toThrow();
  });

  it("retains unknown legacy app fields while canonical values win", () => {
    const mapped = mapTrade({
      id: "11111111-1111-4111-8111-111111111111",
      legacy_firebase_doc_id: "legacy-trade-1",
      account_id: null,
      legacy_account_id: "acct_1",
      broker_connection_id: null,
      source_system: "zerodha",
      ingestion_method: "migration",
      external_trade_key: null,
      broker_trade_id: "order-1",
      symbol: "NIFTY",
      asset: "eq",
      instrument: null,
      option_type: null,
      strike: null,
      expiry: null,
      exchange: null,
      product: null,
      direction: "Long",
      entry_price: "24000.25",
      exit_price: null,
      quantity: "1",
      pnl: null,
      stop_loss: null,
      take_profit: null,
      is_open: true,
      trade_date: "2026-08-08",
      entry_at: null,
      exit_at: null,
      legacy_entry_time: null,
      legacy_exit_time: null,
      strategy: null,
      emotion: null,
      notes: null,
      tags: [],
      psychology: {},
      custom_fields: {},
      broker_data: {},
      legacy_document: {
        symbol: "WRONG",
        groupingMode: "fifo",
        needsReview: true,
        syncedAt: { seconds: 123 },
        screenshots: [
          { id: "file-1", src: "/api/files/file-1", name: "already-promoted.jpg" },
          { src: "https://legacy.example/image.jpg", name: "legacy.jpg" },
        ],
      },
      file_screenshots: [{ id: "file-1", src: "/api/files/file-1", name: "new.jpg" }],
      calculation_version: 1,
      row_version: 2,
      created_at: "2026-08-08T00:00:00.000Z",
      updated_at: "2026-08-08T00:00:00.000Z",
      deleted_at: null,
    });
    expect(mapped.symbol).toBe("NIFTY");
    expect(mapped.groupingMode).toBe("fifo");
    expect(mapped.needsReview).toBe(true);
    expect(mapped.screenshots).toEqual([
      { id: "file-1", src: "/api/files/file-1", name: "new.jpg" },
      { src: "https://legacy.example/image.jpg", name: "legacy.jpg" },
    ]);
  });
});
