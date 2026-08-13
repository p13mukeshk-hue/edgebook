-- Official cTrader cash-flow history is an account ledger, not a trade
-- component. ProtoOADepositWithdraw exposes an immutable balanceHistoryId but
-- no position/deal identifier, so this schema deliberately has no trade_id.
-- cTrader moneyDigits permits up to 18 fractional digits. Preserve all of
-- them in canonical P&L columns instead of allowing PostgreSQL to round the
-- provider value to the original ten-decimal journal scale.
--
-- The migration runner executes each file in its own transaction. Keep the
-- ACCESS EXCLUSIVE lock wait and the possible numeric typmod rewrite bounded;
-- SET LOCAL guarantees both limits disappear on commit or rollback.
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

ALTER TABLE trades
  ALTER COLUMN pnl TYPE numeric(38, 18);

ALTER TABLE trade_executions
  ALTER COLUMN pnl TYPE numeric(38, 18),
  ALTER COLUMN commission TYPE numeric(38, 18),
  ALTER COLUMN swap TYPE numeric(38, 18);

CREATE TABLE ctrader_account_cash_flows (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_connection_id uuid NOT NULL,
  external_cash_flow_id text NOT NULL,
  operation_type integer,
  operation_name text NOT NULL,
  amount numeric(38, 18),
  balance numeric(38, 18),
  equity numeric(38, 18),
  raw_delta numeric(20, 0) NOT NULL,
  raw_balance numeric(20, 0) NOT NULL,
  raw_equity numeric(20, 0),
  currency_code text NOT NULL,
  money_digits integer,
  money_digits_source text NOT NULL,
  balance_version numeric(30, 0),
  occurred_at timestamptz NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ctrader_account_cash_flows_connection_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id)
    REFERENCES broker_connections (user_id, id) ON DELETE CASCADE,
  UNIQUE (user_id, broker_connection_id, id),
  UNIQUE (broker_connection_id, external_cash_flow_id),
  CHECK (length(external_cash_flow_id) BETWEEN 1 AND 100),
  CHECK (operation_type IS NULL OR operation_type BETWEEN 0 AND 2147483647),
  CHECK (operation_name ~ '^BALANCE_[A-Z0-9_]{1,100}$'),
  CHECK (length(currency_code) BETWEEN 1 AND 100),
  CHECK (money_digits IS NULL OR money_digits BETWEEN 0 AND 18),
  CHECK (money_digits_source IN ('cash_flow', 'account', 'unavailable')),
  CHECK (
    (money_digits IS NULL AND money_digits_source = 'unavailable')
    OR (money_digits IS NOT NULL AND money_digits_source IN ('cash_flow', 'account'))
  ),
  CHECK (
    (money_digits IS NULL AND amount IS NULL AND balance IS NULL AND equity IS NULL)
    OR (money_digits IS NOT NULL AND amount IS NOT NULL AND balance IS NOT NULL)
  ),
  CHECK (
    (money_digits IS NULL AND equity IS NULL)
    OR (money_digits IS NOT NULL AND (raw_equity IS NULL) = (equity IS NULL))
  )
);

-- PostgreSQL grants no table access to PUBLIC by default, but state that
-- security boundary explicitly so a future cluster-level default privilege
-- cannot expose the provider account ledger.
REVOKE ALL ON TABLE ctrader_account_cash_flows FROM PUBLIC;

CREATE INDEX ctrader_account_cash_flows_feed_idx
  ON ctrader_account_cash_flows (user_id, broker_connection_id, occurred_at DESC, external_cash_flow_id DESC);

COMMENT ON TABLE ctrader_account_cash_flows IS
  'Provider-exact cTrader account cash-flow ledger. Entries are not attributed to positions because ProtoOADepositWithdraw supplies no position/deal linkage.';
COMMENT ON COLUMN ctrader_account_cash_flows.amount IS
  'Exact ProtoOADepositWithdraw.delta scaled by its moneyDigits (or the account moneyDigits when omitted).';
COMMENT ON COLUMN ctrader_account_cash_flows.raw_delta IS
  'Lossless signed int64 ProtoOADepositWithdraw.delta retained even when neither the row nor account supplies moneyDigits; never present raw units as account currency.';
COMMENT ON COLUMN ctrader_account_cash_flows.external_cash_flow_id IS
  'Immutable cTrader ProtoOADepositWithdraw.balanceHistoryId within the connected account.';
