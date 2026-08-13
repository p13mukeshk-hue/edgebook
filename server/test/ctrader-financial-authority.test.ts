import type { PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  lockAndValidateMappedAccountCurrency,
  mergeOfficialProjectionAuthority,
} from "../src/ctrader/sync.js";

const userId = "00000000-0000-4000-8000-000000000002";
const accountId = "00000000-0000-4000-8000-000000000093";

function result(rows: unknown[] = []): QueryResult {
  return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult;
}

describe("cTrader financial authority boundaries", () => {
  it("validates the exact tenant-owned mapped account currency under a row lock", async () => {
    const query = vi.fn(async () => result([{
      id: accountId,
      legacy_account_id: "legacy-account",
      currency_code: "USD",
    }]));
    const client = { query } as unknown as PoolClient;

    await lockAndValidateMappedAccountCurrency(client, {
      userId,
      mappedAccountId: accountId,
      legacyMappedAccountId: "legacy-account",
      providerCurrency: "USD",
    });

    expect(query).toHaveBeenCalledWith(expect.stringMatching(/FROM accounts[\s\S]*user_id=\$1[\s\S]*FOR SHARE/), [
      userId, accountId, "legacy-account",
    ]);
  });

  it("fails closed when provider and mapped account currencies differ", async () => {
    const client = {
      query: vi.fn(async () => result([{
        id: accountId,
        legacy_account_id: "legacy-account",
        currency_code: "EUR",
      }])),
    } as unknown as PoolClient;

    await expect(lockAndValidateMappedAccountCurrency(client, {
      userId,
      mappedAccountId: accountId,
      legacyMappedAccountId: "legacy-account",
      providerCurrency: "USD",
    })).rejects.toMatchObject({ code: "CTRADER_ACCOUNT_CURRENCY_MISMATCH", retryable: false });
  });

  it("preserves reconciled manual P&L and audit data until official exact net becomes available", () => {
    const existing = {
      pnl: "25",
      brokerData: {
        calculatedGrossPnl: "24.75",
        calculatedGrossMethod: "fill_price_base_units_identity_conversion_v1",
        journalMergeAudit: { version: 1 },
      },
      reconciledManualTrade: true,
    };
    const unavailable = mergeOfficialProjectionAuthority({
      existing,
      providerPnl: null,
      providerBrokerData: { pnlMethod: "partial_provider_close_detail_unavailable", accountCurrency: "USD" },
    });
    expect(unavailable).toEqual({
      pnl: "25",
      brokerData: expect.objectContaining({
        calculatedGrossPnl: "24.75",
        journalMergeAudit: { version: 1 },
        pnlMethod: "partial_provider_close_detail_unavailable",
        accountCurrency: "USD",
        pnlAuthority: "preserved_reconciled_manual",
        reconciledManualPnlPreserved: true,
      }),
    });

    const exact = mergeOfficialProjectionAuthority({
      existing,
      providerPnl: "23.456789012345678",
      providerBrokerData: {
        pnlMethod: "provider_close_detail_money_digits",
        grossProfit: "24",
        accountCurrency: "USD",
      },
    });
    expect(exact).toEqual({
      pnl: "23.456789012345678",
      brokerData: expect.objectContaining({
        calculatedGrossPnl: "24.75",
        journalMergeAudit: { version: 1 },
        pnlMethod: "provider_close_detail_money_digits",
        grossProfit: "24",
        pnlAuthority: "provider",
        reconciledManualPnlPreserved: false,
      }),
    });

    const laterIncomplete = mergeOfficialProjectionAuthority({
      existing: {
        pnl: exact.pnl,
        brokerData: exact.brokerData,
        reconciledManualTrade: true,
      },
      providerPnl: null,
      providerBrokerData: {
        pnlMethod: "partial_provider_close_detail_unavailable",
        accountCurrency: "USD",
      },
    });
    expect(laterIncomplete).toEqual({
      pnl: null,
      brokerData: expect.objectContaining({
        journalMergeAudit: { version: 1 },
        pnlMethod: "partial_provider_close_detail_unavailable",
        pnlAuthority: "provider_unavailable",
        reconciledManualPnlPreserved: false,
      }),
    });
  });
});
