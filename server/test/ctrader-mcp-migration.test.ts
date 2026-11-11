import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("cTrader MCP migration invariants", () => {
  it("backfills official rows before enforcing a non-null, closed mode set", async () => {
    const sql = await readFile(new URL("../migrations/004_ctrader_mcp_read.sql", import.meta.url), "utf8");
    const backfill = sql.indexOf("SET connection_mode='official'");
    const constraint = sql.indexOf("ADD CONSTRAINT broker_connections_ctrader_mode_check");
    expect(backfill).toBeGreaterThan(-1);
    expect(constraint).toBeGreaterThan(backfill);
    expect(sql).toMatch(/provider='ctrader'\s+AND connection_mode IS NOT NULL\s+AND connection_mode IN \('official', 'mcp_read'\)/);
    expect(sql).toMatch(/provider<>'ctrader'\s+AND connection_mode IS NULL/);
  });

  it("keeps one cross-mode account identity and nullable identities unique on PostgreSQL 16", async () => {
    const sql = await readFile(new URL("../migrations/004_ctrader_mcp_read.sql", import.meta.url), "utf8");
    const index = sql.match(/CREATE UNIQUE INDEX broker_connections_external_unique_idx[\s\S]*?WHERE external_account_id IS NOT NULL;/)?.[0] ?? "";
    expect(index).toContain("user_id, provider, provider_environment, external_account_id");
    expect(index).not.toContain("connection_mode");
    expect(index).toContain("NULLS NOT DISTINCT");
  });
});
