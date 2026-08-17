import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationPath = new URL("../migrations/008_ctrader_account_cash_flows.sql", import.meta.url);

describe("cTrader account cash-flow migration invariants", () => {
  it("uses tenant-bound connection ownership and immutable provider identity", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(/FOREIGN KEY \(user_id, broker_connection_id\)[\s\S]*REFERENCES broker_connections \(user_id, id\) ON DELETE CASCADE/);
    expect(sql).toMatch(/UNIQUE \(broker_connection_id, external_cash_flow_id\)/);
    expect(sql).toMatch(/external_cash_flow_id[\s\S]*balanceHistoryId/i);
    expect(sql).toMatch(/REVOKE ALL ON TABLE ctrader_account_cash_flows FROM PUBLIC/);
    expect(sql).not.toMatch(/GRANT\s+[^;]+\s+TO\s+PUBLIC/i);
  });

  it("cannot falsely attribute an account operation to a trade", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).not.toMatch(/\btrade_id\s+uuid/i);
    expect(sql).toMatch(/no position\/deal identifier/i);
    expect(sql).toMatch(/money_digits BETWEEN 0 AND 18/);
    expect(sql).toMatch(/money_digits_source IN \('cash_flow', 'unavailable'\)/);
    expect(sql).not.toMatch(/money_digits_source IN \([^)]*'account'/);
    expect(sql).toMatch(/operation_type BETWEEN 0 AND 2147483647/);
  });

  it("widens canonical P&L storage to the provider's full moneyDigits precision", async () => {
    const sql = await readFile(migrationPath, "utf8");
    expect(sql).toMatch(/ALTER TABLE trades[\s\S]*ALTER COLUMN pnl TYPE numeric\(38, 18\)/);
    expect(sql).toMatch(/ALTER TABLE trade_executions[\s\S]*ALTER COLUMN pnl TYPE numeric\(38, 18\)[\s\S]*ALTER COLUMN commission TYPE numeric\(38, 18\)[\s\S]*ALTER COLUMN swap TYPE numeric\(38, 18\)/);
  });

  it("bounds lock acquisition and execution before taking either table lock", async () => {
    const sql = await readFile(migrationPath, "utf8");
    const lockTimeout = sql.indexOf("SET LOCAL lock_timeout = '30s';");
    const statementTimeout = sql.indexOf("SET LOCAL statement_timeout = '15min';");
    const firstAlter = sql.indexOf("ALTER TABLE trades");

    expect(lockTimeout).toBeGreaterThanOrEqual(0);
    expect(statementTimeout).toBeGreaterThan(lockTimeout);
    expect(firstAlter).toBeGreaterThan(statementTimeout);
    expect(sql).not.toMatch(/(?:^|\n)\s*SET\s+(?!LOCAL\b)(?:lock_timeout|statement_timeout)\b/i);
  });
});
