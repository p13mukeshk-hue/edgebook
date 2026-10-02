import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = new URL("../migrations/007_ctrader_live_reconciliation.sql", import.meta.url);

describe("cTrader live reconciliation migration invariants", () => {
  it("keeps tenant identity, decisions and private evidence durable", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toContain("CREATE TABLE ctrader_live_reconciliation_candidates");
    expect(sql).toContain("FOREIGN KEY (user_id, broker_connection_id)");
    expect(sql).toContain("UNIQUE (user_id, broker_connection_id, external_position_id)");
    expect(sql).toContain("CREATE TABLE ctrader_live_reconciliation_resolutions");
    expect(sql).toContain("UNIQUE (user_id, broker_connection_id, id)");
    expect(sql).toMatch(/ctrader_live_reconciliation_resolved_owner_fkey[\s\S]*?REFERENCES trades \(user_id, id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/ctrader_live_resolution_trade_owner_fkey[\s\S]*?REFERENCES trades \(user_id, id\) ON DELETE CASCADE/);
    expect(sql).not.toContain("ctrader_live_resolution_manual_owner_fkey");
    expect(sql).toContain("Immutable tenant-validated audit snapshot");
    expect(sql).toContain("UNIQUE (user_id, client_request_id)");
    expect(sql).toContain("UNIQUE (candidate_id)");
    expect(sql).toContain("before_manual jsonb");
    expect(sql).toContain("before_broker jsonb");
    expect(sql).toContain("REVOKE ALL ON ctrader_live_reconciliation_resolutions FROM PUBLIC");
    expect(sql).toContain("EXECUTE FUNCTION reject_ctrader_resolution_mutation()");
  });
});
