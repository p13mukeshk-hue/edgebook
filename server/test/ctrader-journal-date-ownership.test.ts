import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  canonicalTradeDate,
  canonicalTradeDurationSeconds,
  cTraderJournalPatchBody,
  tradePatchInputForNormalization,
} from "../src/modules/trades/routes.js";
import { normalizeTrade } from "../src/modules/trades/schema.js";

const source = async (path: string): Promise<string> => readFile(new URL(path, import.meta.url), "utf8");

describe("cTrader journal-date ownership", () => {
  it("serializes a PostgreSQL date for an HTML date input and derives exact closed duration", () => {
    expect(canonicalTradeDate(new Date("2026-08-13T00:00:00.000Z"))).toBe("2026-08-13");
    expect(canonicalTradeDate("2026-08-13")).toBe("2026-08-13");
    expect(canonicalTradeDurationSeconds(
      "2026-08-13T12:42:09.034Z",
      "2026-08-13T13:19:29.975Z",
    )).toBe(2_240);
    expect(canonicalTradeDurationSeconds("2026-08-13T13:00:00.000Z", null)).toBeNull();
    expect(canonicalTradeDurationSeconds("2026-08-13T13:00:01.000Z", "2026-08-13T13:00:00.000Z")).toBeNull();
  });

  it("accepts only journal-owned fields from a canonical cTrader edit", () => {
    expect(cTraderJournalPatchBody({
      version: 3,
      date: "2026-08-13",
      sl: 4390,
      notes: "Waited for confirmation",
      psychology: { review: "Good patience" },
      legacyFirebaseDocId: null,
      brokerData: { provider: "ctrader" },
      entryAt: new Date("2026-08-13T04:36:00.819Z"),
      sourceSystem: "ctrader",
    })).toEqual({
      version: 3,
      date: "2026-08-13",
      sl: 4390,
      notes: "Waited for confirmation",
      psychology: { review: "Good patience" },
    });
  });

  it("normalizes a journal edit when the canonical cTrader row has no legacy Firebase id", () => {
    const existing = {
      legacyFirebaseDocId: null,
      brokerConnectionId: "00000000-0000-4000-8000-000000000090",
      source: "ctrader",
      sourceSystem: "ctrader",
      ingestionMethod: "api",
      symbol: "XAUUSD",
      asset: "cm",
      direction: "Short",
      entry: 4398.04,
      exit: 4406.32,
      size: 0.02,
      pnl: null,
      sl: null,
      tp: null,
      isOpen: false,
      date: "2026-08-13",
      entryAt: "2026-08-13T12:42:09.034Z",
      exitAt: "2026-08-13T13:19:29.975Z",
      entryTime: "18:12",
      exitTime: "18:49",
      strategy: "",
      emotion: "Focused",
      notes: "",
      tags: [],
      psychology: {},
      custom: {},
      brokerData: { providerTradeDate: "2026-08-13" },
      calculationVersion: 1,
    };
    const merged = tradePatchInputForNormalization(existing, {
      version: 3,
      date: "2026-08-13",
      notes: "Dictated review",
      psychology: { review: "Waited for confirmation" },
    }, null);

    expect(() => normalizeTrade(merged)).not.toThrow();
    expect(merged.legacyFirebaseDocId).toBeUndefined();
  });

  it("initializes the official projection date but never overwrites an existing journal date", async () => {
    const sync = await source("../src/ctrader/sync.ts");
    expect(sync).toContain("providerTradeDate: projection.tradeDate");
    expect(sync).toMatch(/INSERT INTO trades \([\s\S]*?is_open, trade_date, entry_at/);
    expect(sync).not.toMatch(/DO UPDATE SET[\s\S]*?trade_date\s*=\s*EXCLUDED\.trade_date/);
    expect(sync).not.toContain("trades.is_open, trades.trade_date, trades.entry_at");
  });

  it("keeps MCP direct and linked projections from resetting the journal date", async () => {
    const sync = await source("../src/ctrader/mcp-sync.ts");
    expect(sync).toContain("providerTradeDate: entryLocal.date");
    expect(sync).toContain("trade_date=COALESCE(trade_date,$11::date)");
    expect(sync).not.toMatch(/DO UPDATE SET[\s\S]*?trade_date\s*=\s*EXCLUDED\.trade_date/);
    expect(sync).not.toContain("OR is_open IS DISTINCT FROM $10 OR trade_date IS DISTINCT FROM $11::date");
  });

  it("preserves a linked manual journal date in both live and historical resolution", async () => {
    const service = await source("../src/ctrader/service.ts");
    expect(service.match(/trade_date=COALESCE\(trade_date,\$12::date\)/g)).toHaveLength(2);
    expect(service).toContain("providerTradeDate: projection.tradeDate");
    expect(service).toContain("'trade_date','stop_loss','take_profit'");
  });
});
