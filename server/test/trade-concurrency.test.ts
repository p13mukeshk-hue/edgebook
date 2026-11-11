import type { FastifyInstance } from "fastify";
import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import type { Database } from "../src/db/database.js";
import { normalizeTrade } from "../src/modules/trades/schema.js";
import {
  createTrade,
  mergeTradePatch,
  parseExpectedVersion,
  replaceTrade,
  requireExpectedVersion,
  type TradeRow,
} from "../src/modules/trades/routes.js";

const userId = "00000000-0000-4000-8000-000000000001";

class MemoryTradeDatabase {
  row: TradeRow | null = null;
  readonly idempotency = new Map<string, { request_hash: Buffer; resource_id: string }>();
  inserts = 0;

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<{ rows: R[] }> {
    let rows: QueryResultRow[] = [];
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || sql.includes("pg_advisory_xact_lock")) {
      rows = [];
    } else if (sql.includes("SELECT request_hash, resource_id FROM api_idempotency_keys")) {
      const key = `${values[0]}:${values[1]}`;
      const previous = this.idempotency.get(key);
      rows = previous ? [previous] : [];
    } else if (sql.includes("INSERT INTO api_idempotency_keys")) {
      this.idempotency.set(`${values[0]}:${values[1]}`, {
        request_hash: values[2] as Buffer,
        resource_id: String(values[3]),
      });
    } else if (sql.includes("INSERT INTO trades")) {
      this.inserts += 1;
      this.row = {
        id: String(values[0]),
        legacy_firebase_doc_id: values[2] === null ? null : String(values[2]),
        account_id: null,
        legacy_account_id: values[39] === null ? null : String(values[39]),
        broker_connection_id: null,
        source_system: String(values[5]),
        ingestion_method: String(values[6]),
        external_trade_key: null,
        broker_trade_id: null,
        symbol: String(values[9]),
        asset: null,
        instrument: null,
        option_type: null,
        strike: null,
        expiry: null,
        exchange: null,
        product: null,
        direction: values[17] as "Long" | "Short",
        entry_price: String(values[18]),
        exit_price: null,
        quantity: String(values[20]),
        pnl: null,
        stop_loss: null,
        take_profit: null,
        is_open: null,
        trade_date: String(values[25]),
        entry_at: null,
        exit_at: null,
        legacy_entry_time: null,
        legacy_exit_time: null,
        strategy: null,
        emotion: null,
        notes: values[32] === null ? null : String(values[32]),
        tags: [],
        psychology: {},
        custom_fields: {},
        broker_data: {},
        legacy_document: JSON.parse(String(values[38])) as Record<string, unknown>,
        file_screenshots: [],
        calculation_version: Number(values[37]),
        row_version: 1,
        created_at: "2026-08-09T00:00:00.000Z",
        updated_at: "2026-08-09T00:00:00.000Z",
        deleted_at: null,
      };
      rows = [{ id: this.row.id }];
    } else if (sql.includes("UPDATE trades SET") && sql.includes("row_version=row_version+1")) {
      const expectedVersion = Number(values[40]);
      if (this.row && this.row.id === values[0] && this.row.row_version === expectedVersion) {
        this.row.notes = values[32] === null ? null : String(values[32]);
        this.row.row_version += 1;
        rows = [{ id: this.row.id }];
      }
    } else if (sql.includes("FROM trades")) {
      const requested = String(values[1]);
      rows = this.row && (this.row.id === requested || this.row.legacy_firebase_doc_id === requested)
        ? [this.row]
        : [];
    } else {
      throw new Error(`Unexpected trade test query: ${sql}`);
    }
    return { rows: rows as R[] };
  }

  async connect() {
    return {
      query: this.query.bind(this),
      release() {},
    };
  }
}

function appFor(database: MemoryTradeDatabase): FastifyInstance {
  return { db: database as unknown as Database } as unknown as FastifyInstance;
}

function trade(notes: string) {
  return normalizeTrade({
    id: "browser-trade-1",
    symbol: "AAPL",
    direction: "Long",
    entry: 100,
    size: 1,
    date: "2026-08-09",
    notes,
  });
}

describe("trade mutation concurrency", () => {
  it("replays a lost create response without overwriting a later edit", async () => {
    const database = new MemoryTradeDatabase();
    const app = appFor(database);
    const created = await createTrade(app, userId, trade("original"), "trade:browser-trade-1");
    expect(created.replayed).toBe(false);
    expect(database.inserts).toBe(1);

    // Simulate an edit committed after the first response was lost. A retry of
    // the original POST must return the current resource and perform no write.
    database.row!.notes = "later edit";
    database.row!.row_version = 2;
    const replay = await createTrade(app, userId, trade("original"), "trade:browser-trade-1");
    expect(replay.replayed).toBe(true);
    expect(replay.row.notes).toBe("later edit");
    expect(replay.row.row_version).toBe(2);
    expect(database.inserts).toBe(1);

    await expect(createTrade(app, userId, trade("different payload"), "trade:browser-trade-1"))
      .rejects.toMatchObject({ statusCode: 409 });

    database.row = null;
    await expect(createTrade(app, userId, trade("original"), "trade:browser-trade-1"))
      .rejects.toMatchObject({ statusCode: 409, code: "IDEMPOTENCY_RESOURCE_GONE" });
  });

  it("keeps cTrader projection facts immutable while allowing journal annotations", () => {
    const existing = {
      source: "ctrader",
      sourceSystem: "ctrader",
      brokerConnectionId: "00000000-0000-4000-8000-000000000099",
      externalTradeKey: "position:7001",
      symbol: "EURUSD",
      entry: 1.2,
      pnl: 12.5,
      isOpen: true,
      date: "2026-02-02",
      entryAt: "2026-02-02T09:30:00.000Z",
      brokerData: { realizedEvents: [{ executionId: "2", date: "2026-02-02", pnl: "12.5" }] },
      notes: "old note",
      strategy: null,
      sl: null,
    };
    const merged = mergeTradePatch(existing, {
      externalTradeKey: "tampered",
      symbol: "FAKE",
      pnl: 999,
      isOpen: false,
      date: "2026-02-03",
      entryAt: "2026-02-03T10:00:00.000Z",
      brokerData: {},
      notes: "reviewed",
      strategy: "Breakout",
      sl: 1.19,
    });

    expect(merged).toMatchObject({
      externalTradeKey: "position:7001",
      symbol: "EURUSD",
      pnl: 12.5,
      isOpen: true,
      date: "2026-02-03",
      entryAt: "2026-02-02T09:30:00.000Z",
      brokerData: { ...existing.brokerData, providerTradeDate: "2026-02-02" },
      notes: "reviewed",
      strategy: "Breakout",
      sl: 1.19,
    });
  });

  it("requires a version and rejects the losing tab's stale update", async () => {
    expect(() => requireExpectedVersion(parseExpectedVersion(undefined))).toThrowError(
      expect.objectContaining({ statusCode: 428, code: "VERSION_REQUIRED" }),
    );

    const database = new MemoryTradeDatabase();
    const app = appFor(database);
    const created = await createTrade(app, userId, trade("base"), "trade:browser-trade-1");
    const firstTab = await replaceTrade(app, userId, created.row.id, trade("first tab"), 1);
    expect(firstTab.row_version).toBe(2);
    expect(firstTab.notes).toBe("first tab");

    await expect(replaceTrade(app, userId, created.row.id, trade("second tab"), 1))
      .rejects.toMatchObject({ statusCode: 409 });
    expect(database.row?.notes).toBe("first tab");
  });
});
