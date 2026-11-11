import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migrationUrl = new URL(
  "../migrations/005_ctrader_historical_reconciliation.sql",
  import.meta.url,
);

async function migrationSql(): Promise<string> {
  return readFile(migrationUrl, "utf8");
}

describe("cTrader historical reconciliation migration invariants", () => {
  it("is mandatory before the server reports ready", async () => {
    const routes = await readFile(
      new URL("../src/modules/system/routes.ts", import.meta.url),
      "utf8",
    );
    expect(routes).toContain('"005_ctrader_historical_reconciliation.sql"');
  });

  it("records a purpose-limited, immutable and server-timestamped flat-account attestation", async () => {
    const sql = await migrationSql();
    expect(sql).toMatch(/no_open_positions_attested boolean NOT NULL/);
    expect(sql).toMatch(/CHECK \(no_open_positions_attested = true\)/);
    expect(sql).toMatch(/attestation_version smallint NOT NULL DEFAULT 1/);
    expect(sql).toMatch(/attestation_purpose text NOT NULL DEFAULT 'historical_preview_reconciliation'/);
    expect(sql).toMatch(/NEW\.acknowledged_at := actual_now;/);
    expect(sql).not.toMatch(/NEW\.through_at := actual_now/);
    expect(sql).toMatch(/CHECK \(boundary_at < through_at\)/);
    expect(sql).toMatch(/CHECK \(through_at = normal_history_floor_at_request\)/);
    expect(sql).toMatch(/CHECK \(through_at <= acknowledged_at\)/);
    expect(sql).toMatch(/normal_history_floor_kind_at_request = 'connection_time_empty_attested'/);
    expect(sql).toContain("cTrader historical import identity and attestation are immutable");
  });

  it("binds the attestation to the exact tenant, connection, account, environment and unambiguous instant", async () => {
    const sql = await migrationSql();
    expect(sql).toMatch(/connection\.user_id = NEW\.user_id[\s\S]*?connection\.id = NEW\.broker_connection_id/);
    expect(sql).toMatch(/connection\.external_account_id = NEW\.external_account_id/);
    expect(sql).toMatch(/connection\.provider_environment = NEW\.provider_environment/);
    expect(sql).toMatch(/historyFloorTimestamp'[\s\S]*?NEW\.normal_history_floor_at_request/);
    expect(sql).toMatch(/historyFloorKind' = NEW\.normal_history_floor_kind_at_request/);
    expect(sql).toMatch(/historyReadValidated' = 'true'/);
    expect(sql).toMatch(/noOpenPositionsAttestation,userId}[\s\S]*?NEW\.user_id::text/);
    expect(sql).toMatch(/FROM pg_timezone_names WHERE name = NEW\.time_zone/);
    expect(sql).toMatch(/boundary_at AT TIME ZONE NEW\.time_zone/);
    expect(sql).toMatch(/generate_series\([\s\S]*?interval '30 hours'[\s\S]*?interval '1 minute'/);
    expect(sql).toMatch(/IF local_match_count <> 1 THEN[\s\S]*?ambiguous or nonexistent/);
  });

  it("uses composite tenant, connection and import ownership for every staged child", async () => {
    const sql = await migrationSql();
    expect(sql).toMatch(/UNIQUE \(user_id, broker_connection_id, id\)/);
    expect(sql).toMatch(/sync_runs_historical_import_owner_fkey[\s\S]*?FOREIGN KEY \(historical_import_user_id, broker_connection_id, historical_import_id\)[\s\S]*?REFERENCES ctrader_historical_imports \(user_id, broker_connection_id, id\)/);
    expect(sql).toMatch(/ctrader_historical_execution_import_owner_fkey[\s\S]*?FOREIGN KEY \(user_id, broker_connection_id, import_id\)/);
    expect(sql).toMatch(/ctrader_historical_execution_owner_fkey[\s\S]*?REFERENCES trade_executions \(user_id, broker_connection_id, id\)/);
    expect(sql).toMatch(/ctrader_reconciliation_import_owner_fkey[\s\S]*?REFERENCES ctrader_historical_imports \(user_id, broker_connection_id, id\)/);
    expect(sql).toMatch(/ctrader_resolution_candidate_owner_fkey[\s\S]*?FOREIGN KEY \(user_id, broker_connection_id, import_id, candidate_id\)/);
    expect(sql).toMatch(/ctrader_trade_links_import_owner_fkey[\s\S]*?FOREIGN KEY \(user_id, broker_connection_id, import_id\)/);
  });

  it("keeps request UUIDs idempotent and candidate state internally coherent", async () => {
    const sql = await migrationSql();
    expect(sql.match(/client_request_id uuid NOT NULL/g)).toHaveLength(2);
    expect(sql.match(/UNIQUE \(user_id, client_request_id\)/g)).toHaveLength(2);
    expect(sql).toMatch(/external_trade_key = 'position:' \|\| external_position_id/);
    expect(sql).toMatch(/jsonb_typeof\(reasons\) = 'array'/);
    expect(sql).toMatch(/jsonb_typeof\(differences\) = 'object'/);
    expect(sql).toMatch(/status = 'pending' AND resolution_action IS NULL AND resolved_trade_id IS NULL AND resolved_at IS NULL/);
    expect(sql).toMatch(/status = 'linked' AND resolution_action = 'link_manual' AND resolved_at IS NOT NULL/);
    expect(sql).toMatch(/status = 'suppressed' AND resolution_action = 'suppress_deleted' AND resolved_trade_id IS NULL/);
  });

  it("keeps private resolution evidence immutable without blocking a user erasure cascade", async () => {
    const sql = await migrationSql();
    expect(sql).toMatch(/PRIVATE rollback evidence; never serialize through the public API/);
    expect(sql).toMatch(/REVOKE ALL ON ctrader_reconciliation_resolutions FROM PUBLIC/);
    expect(sql).toMatch(/ctrader_resolution_candidate_owner_fkey[\s\S]*?ON DELETE CASCADE/);
    expect(sql).toMatch(/ctrader_resolution_trade_owner_fkey[\s\S]*?ON DELETE CASCADE/);
    const immutableTrigger = sql.match(/CREATE TRIGGER ctrader_reconciliation_resolutions_immutable[\s\S]*?;/)?.[0] ?? "";
    expect(immutableTrigger).toContain("BEFORE UPDATE ON");
    expect(immutableTrigger).not.toContain("DELETE");
  });

  it("creates a tombstone before a linked manual trade cascade but skips parent erasure cascades", async () => {
    const sql = await migrationSql();
    const functionSql = sql.match(/CREATE OR REPLACE FUNCTION preserve_ctrader_link_tombstone\(\)[\s\S]*?\$\$;/)?.[0] ?? "";
    expect(functionSql).toMatch(/EXISTS \(SELECT 1 FROM users WHERE id = OLD\.user_id\)/);
    expect(functionSql).toMatch(/EXISTS \([\s\S]*?FROM broker_connections[\s\S]*?id = OLD\.broker_connection_id/);
    expect(functionSql).toMatch(/NOT EXISTS \([\s\S]*?FROM trades[\s\S]*?id = OLD\.trade_id/);
    expect(functionSql).toMatch(/INSERT INTO ctrader_trade_tombstones/);
    expect(sql).toMatch(/CREATE TRIGGER ctrader_trade_links_preserve_tombstone\s+BEFORE DELETE ON ctrader_trade_links/);
    expect(sql).toMatch(/ctrader_trade_links_trade_owner_fkey[\s\S]*?ON DELETE CASCADE/);
  });
});
