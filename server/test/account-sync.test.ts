import type { QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import {
  resolveOwnedAccountMapping,
  syncAccountsFromSettings,
  type AccountQuerySource,
} from "../src/modules/accounts/sync.js";

type StoredAccount = {
  id: string;
  userId: string;
  legacyId: string;
  name: string;
  currencyCode: string;
  archived: boolean;
};

class AccountStore implements AccountQuerySource {
  readonly accounts = new Map<string, StoredAccount>();
  readonly connections = new Map<string, { userId: string; mappedAccountId: string | null }>();

  async query<R extends QueryResultRow = QueryResultRow>(sql: string, values: readonly unknown[] = []): Promise<{ rows: R[] }> {
    let rows: QueryResultRow[];
    if (sql.includes("INSERT INTO accounts")) {
      const proposedId = String(values[0]);
      const userId = String(values[1]);
      const legacyId = String(values[2]);
      const key = `${userId}:${legacyId}`;
      const existing = this.accounts.get(key);
      const account: StoredAccount = {
        id: existing?.id ?? proposedId,
        userId,
        legacyId,
        name: String(values[3]),
        currencyCode: String(values[4]),
        archived: false,
      };
      this.accounts.set(key, account);
      rows = [{ id: account.id }];
    } else if (sql.includes("UPDATE accounts SET archived_at")) {
      const userId = String(values[0]);
      const retained = new Set((values[1] as string[]) ?? []);
      const archived: QueryResultRow[] = [];
      for (const account of this.accounts.values()) {
        if (account.userId === userId && !retained.has(account.legacyId)) {
          account.archived = true;
          archived.push({ id: account.id });
        }
      }
      rows = archived;
    } else if (sql.includes("UPDATE broker_connections SET")) {
      const userId = String(values[0]);
      const archivedIds = new Set((values[1] as string[]) ?? []);
      for (const connection of this.connections.values()) {
        if (connection.userId === userId && connection.mappedAccountId && archivedIds.has(connection.mappedAccountId)) {
          connection.mappedAccountId = null;
        }
      }
      rows = [];
    } else if (sql.includes("SELECT id, legacy_account_id FROM accounts")) {
      const userId = String(values[0]);
      const publicId = String(values[1]);
      const account = [...this.accounts.values()].find((candidate) =>
        candidate.userId === userId
        && !candidate.archived
        && (candidate.id === publicId || candidate.legacyId === publicId));
      rows = account ? [{ id: account.id, legacy_account_id: account.legacyId }] : [];
    } else {
      throw new Error(`Unexpected account test query: ${sql}`);
    }
    return { rows: rows as R[] };
  }
}

describe("settings account normalization", () => {
  it("supports create -> cTrader select and keeps the internal UUID stable through edit/revive", async () => {
    const store = new AccountStore();
    const userId = "00000000-0000-4000-8000-000000000001";
    const first = await syncAccountsFromSettings(store, userId, {
      accounts: [{ id: "acct_1", name: "Primary", currency: "₹", size: 100_000 }],
    });
    const internalId = first.get("acct_1");
    expect(internalId).toMatch(/^[0-9a-f-]{36}$/);

    const selected = await resolveOwnedAccountMapping(store, userId, "acct_1");
    expect(selected).toEqual({ internalId, legacyId: "acct_1" });

    const edited = await syncAccountsFromSettings(store, userId, {
      accounts: [{ id: "acct_1", name: "Primary renamed", currency: "INR", size: 125_000 }],
    });
    expect(edited.get("acct_1")).toBe(internalId);
    expect(store.accounts.get(`${userId}:acct_1`)).toMatchObject({
      id: internalId,
      name: "Primary renamed",
      currencyCode: "INR",
      archived: false,
    });

    store.connections.set("ctrader-1", { userId, mappedAccountId: internalId ?? null });
    await syncAccountsFromSettings(store, userId, { accounts: [] });
    expect(store.connections.get("ctrader-1")?.mappedAccountId).toBeNull();
    await expect(resolveOwnedAccountMapping(store, userId, "acct_1")).rejects.toMatchObject({
      code: "ACCOUNT_MAPPING_INVALID",
    });

    const revived = await syncAccountsFromSettings(store, userId, {
      accounts: [{ id: "acct_1", name: "Primary restored", currency: "INR" }],
    });
    expect(revived.get("acct_1")).toBe(internalId);
  });

  it("never resolves another user's account", async () => {
    const store = new AccountStore();
    await syncAccountsFromSettings(store, "00000000-0000-4000-8000-000000000001", {
      accounts: [{ id: "acct_private", name: "Private", currency: "USD" }],
    });
    await expect(resolveOwnedAccountMapping(
      store,
      "00000000-0000-4000-8000-000000000002",
      "acct_private",
    )).rejects.toMatchObject({ code: "ACCOUNT_MAPPING_INVALID" });
  });
});
