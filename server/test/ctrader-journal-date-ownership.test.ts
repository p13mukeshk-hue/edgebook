import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const source = async (path: string): Promise<string> => readFile(new URL(path, import.meta.url), "utf8");

describe("cTrader journal-date ownership", () => {
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
