import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = new URL("../migrations/009_ctrader_message_local_money_digits.sql", import.meta.url);

describe("cTrader message-local moneyDigits repair migration", () => {
  it("bounds locks and de-authorizes every legacy account-scaled cash-flow row", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(/SET LOCAL lock_timeout = '30s'/);
    expect(sql).toMatch(/SET LOCAL statement_timeout = '15min'/);
    expect(sql).toMatch(/UPDATE ctrader_account_cash_flows[\s\S]*money_digits_source = 'unavailable'[\s\S]*WHERE money_digits_source = 'account'/);
    expect(sql).toMatch(/message_local_scale_check[\s\S]*money_digits_source IN \('cash_flow', 'unavailable'\)/);
    expect(sql).toMatch(/WITH cash_flow_coverage AS[\s\S]*accountCashFlowMonetaryScaleComplete[\s\S]*coverage\.unscaled_rows = 0 AND coverage\.pending_scale_retries = 0/);
    expect(sql).toMatch(/accountCashFlowTotalRows'[\s\S]*coverage\.total_rows[\s\S]*accountCashFlowScaledRows'[\s\S]*coverage\.scaled_rows[\s\S]*accountCashFlowUnscaledRows'[\s\S]*coverage\.unscaled_rows/);
  });

  it("scrubs unsupported close-derived money account-wide and uses the real trade key", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(/UPDATE trades AS trade[\s\S]*trade\.external_trade_key = 'position:' \|\| execution\.external_position_id/);
    expect(sql).not.toMatch(/external_broker_trade_id/);
    expect(sql).toMatch(/UPDATE trade_executions AS execution[\s\S]*closePositionDetail'[\s\S]*moneyDigits/);
    expect(sql).not.toMatch(/LIMIT\s+\d+/i);
  });

  it("preserves explicit linked-manual P&L and sanitizes every stale pending candidate in place", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(/pnlAuthority' = 'preserved_reconciled_manual'[\s\S]*reconciledManualPnlPreserved' = 'true'[\s\S]*THEN trade\.pnl/);
    expect(sql).toMatch(/UPDATE ctrader_live_reconciliation_candidates AS candidate[\s\S]*projected_trade = jsonb_set[\s\S]*candidate\.status = 'pending'/);
    expect(sql).toMatch(/exactMoneyRepairPending'[\s\S]*projection_fingerprint = decode\(repeat\('ff', 32\), 'hex'\)/);
    const candidateRepair = sql.slice(sql.indexOf("UPDATE ctrader_live_reconciliation_candidates"), sql.indexOf("UPDATE trade_executions"));
    expect(candidateRepair).not.toMatch(/LIMIT|ANY\s*\(/i);
  });
});
