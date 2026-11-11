-- cTrader moneyDigits is message-local. Earlier Edgebook builds incorrectly
-- used ProtoOATrader/ProtoOADeal precision as a fallback for close-position
-- and cash-flow messages. De-authorize every derived value before services
-- restart; raw provider units remain lossless for bounded worker refetch.

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '15min';

UPDATE ctrader_account_cash_flows
SET amount = NULL,
    balance = NULL,
    equity = NULL,
    money_digits = NULL,
    money_digits_source = 'unavailable',
    synced_at = now()
WHERE money_digits_source = 'account';

-- Recompute the public scale-completeness facts in the same transaction. A
-- previously deployed build may have persisted `true` plus account-scaled
-- counts; leaving that metadata intact would make the de-authorized rows look
-- exact until this account's next sync.
WITH cash_flow_coverage AS (
  SELECT connection.id AS connection_id,
         count(flow.id)::integer AS total_rows,
         count(flow.id) FILTER (
           WHERE flow.money_digits_source = 'cash_flow' AND flow.money_digits IS NOT NULL
         )::integer AS scaled_rows,
         count(flow.id) FILTER (
           WHERE flow.id IS NOT NULL
             AND (flow.money_digits_source <> 'cash_flow' OR flow.money_digits IS NULL)
         )::integer AS unscaled_rows,
         CASE
           WHEN jsonb_typeof(connection.sync_cursor->'cashFlowMoneyRetries') = 'array'
           THEN jsonb_array_length(connection.sync_cursor->'cashFlowMoneyRetries')
           ELSE 0
         END AS pending_scale_retries
  FROM broker_connections AS connection
  LEFT JOIN ctrader_account_cash_flows AS flow
    ON flow.user_id = connection.user_id
   AND flow.broker_connection_id = connection.id
  WHERE connection.provider = 'ctrader'
    AND connection.connection_mode = 'official'
  GROUP BY connection.id
)
UPDATE broker_connections AS connection
SET provider_metadata = (connection.provider_metadata
      - 'accountCashFlowMonetaryScaleComplete'
      - 'accountCashFlowTotalRows'
      - 'accountCashFlowScaledRows'
      - 'accountCashFlowUnscaledRows'
      - 'accountCashFlowPendingScaleRetries')
    || jsonb_build_object(
      'accountCashFlowMonetaryScaleComplete',
        coverage.unscaled_rows = 0 AND coverage.pending_scale_retries = 0,
      'accountCashFlowTotalRows', coverage.total_rows,
      'accountCashFlowScaledRows', coverage.scaled_rows,
      'accountCashFlowUnscaledRows', coverage.unscaled_rows,
      'accountCashFlowPendingScaleRetries', coverage.pending_scale_retries
    ),
    updated_at = now()
FROM cash_flow_coverage AS coverage
WHERE connection.id = coverage.connection_id;

ALTER TABLE ctrader_account_cash_flows
  ADD CONSTRAINT ctrader_account_cash_flows_message_local_scale_check
  CHECK (money_digits_source IN ('cash_flow', 'unavailable'));

UPDATE trades AS trade
SET pnl = CASE
      WHEN trade.broker_data->>'pnlAuthority' = 'preserved_reconciled_manual'
       AND trade.broker_data->>'reconciledManualPnlPreserved' = 'true'
      THEN trade.pnl
      ELSE NULL
    END,
    broker_data = (trade.broker_data
      - 'grossProfit' - 'commission' - 'swap' - 'pnlConversionFee' - 'realizedEvents'
      - 'pnlMethod' - 'pnlAuthority' - 'pnlComponentsCoverage')
      || jsonb_build_object(
        'pnlMethod', 'partial_provider_close_detail_unavailable',
        'pnlAuthority', CASE
          WHEN trade.broker_data->>'pnlAuthority' = 'preserved_reconciled_manual'
           AND trade.broker_data->>'reconciledManualPnlPreserved' = 'true'
          THEN 'preserved_reconciled_manual'
          ELSE 'provider_unavailable'
        END,
        'reconciledManualPnlPreserved', CASE
          WHEN trade.broker_data->>'pnlAuthority' = 'preserved_reconciled_manual'
           AND trade.broker_data->>'reconciledManualPnlPreserved' = 'true'
          THEN true
          ELSE false
        END,
        'pnlComponentsCoverage', jsonb_build_object(
          'version', 1,
          'source', 'ProtoOAClosePositionDetail',
          'scope', 'realized_closing_deals',
          'tradeLevelExact', false,
          'grossProfit', false,
          'brokerCommission', false,
          'swap', false,
          'pnlConversionFee', false,
          'formula', 'grossProfit + swap + commission - pnlConversionFee',
          'otherAccountCashFlowsIncluded', false,
          'otherAccountCashFlowsAttribution', 'not_provided_by_position'
        )
      ),
    row_version = trade.row_version + 1,
    updated_at = now()
WHERE EXISTS (
  SELECT 1
  FROM trade_executions AS execution
  JOIN broker_connections AS connection
    ON connection.id = execution.broker_connection_id
   AND connection.connection_mode = 'official'
  WHERE execution.user_id = trade.user_id
    AND execution.broker_connection_id = trade.broker_connection_id
    AND trade.external_trade_key = 'position:' || execution.external_position_id
    AND jsonb_typeof(execution.raw_payload->'closePositionDetail') = 'object'
    AND execution.raw_payload->'closePositionDetail'->>'moneyDigits' IS NULL
);

UPDATE ctrader_live_reconciliation_candidates AS candidate
SET projected_trade = jsonb_set(
      jsonb_set(candidate.projected_trade, '{pnl}', 'null'::jsonb, true),
      '{brokerData}',
      (COALESCE(candidate.projected_trade->'brokerData', '{}'::jsonb)
        - 'grossProfit' - 'commission' - 'swap' - 'pnlConversionFee' - 'realizedEvents'
        - 'pnlMethod' - 'pnlAuthority' - 'pnlComponentsCoverage')
        || jsonb_build_object(
          'pnlMethod', 'partial_provider_close_detail_unavailable',
          'pnlAuthority', 'provider_unavailable',
          'reconciledManualPnlPreserved', false,
          'pnlComponentsCoverage', jsonb_build_object(
            'version', 1,
            'source', 'ProtoOAClosePositionDetail',
            'scope', 'realized_closing_deals',
            'tradeLevelExact', false,
            'grossProfit', false,
            'brokerCommission', false,
            'swap', false,
            'pnlConversionFee', false,
            'formula', 'grossProfit + swap + commission - pnlConversionFee',
            'otherAccountCashFlowsIncluded', false,
            'otherAccountCashFlowsAttribution', 'not_provided_by_position'
          )
        ),
      true
    ),
    candidate_data = candidate.candidate_data || jsonb_build_object(
      'exactMoneyRepairPending', true,
      'exactMoneyRepairReason', 'close_position_detail_money_digits_unavailable'
    ),
    projection_fingerprint = decode(repeat('ff', 32), 'hex'),
    row_version = candidate.row_version + 1
FROM trade_executions AS execution, broker_connections AS connection
WHERE connection.id = execution.broker_connection_id
  AND connection.connection_mode = 'official'
  AND candidate.user_id = execution.user_id
  AND candidate.broker_connection_id = execution.broker_connection_id
  AND candidate.external_position_id = execution.external_position_id
  AND candidate.status = 'pending'
  AND jsonb_typeof(execution.raw_payload->'closePositionDetail') = 'object'
  AND execution.raw_payload->'closePositionDetail'->>'moneyDigits' IS NULL;

UPDATE trade_executions AS execution
SET pnl = NULL,
    commission = CASE
      WHEN execution.raw_payload->>'commission' ~ '^-?(0|[1-9][0-9]*)$'
       AND execution.raw_payload->>'moneyDigits' ~ '^([0-9]|1[0-8])$'
      THEN (execution.raw_payload->>'commission')::numeric
        / power(10::numeric, (execution.raw_payload->>'moneyDigits')::int)
      ELSE NULL
    END,
    swap = NULL,
    money_digits = CASE
      WHEN execution.raw_payload->>'commission' ~ '^-?(0|[1-9][0-9]*)$'
       AND execution.raw_payload->>'moneyDigits' ~ '^([0-9]|1[0-8])$'
      THEN (execution.raw_payload->>'moneyDigits')::int
      ELSE NULL
    END,
    imported_at = now()
FROM broker_connections AS connection
WHERE connection.id = execution.broker_connection_id
  AND connection.connection_mode = 'official'
  AND jsonb_typeof(execution.raw_payload->'closePositionDetail') = 'object'
  AND execution.raw_payload->'closePositionDetail'->>'moneyDigits' IS NULL;

COMMENT ON COLUMN ctrader_account_cash_flows.amount IS
  'Exact ProtoOADepositWithdraw.delta scaled only by that row message moneyDigits; NULL when the row exponent is unavailable.';
COMMENT ON COLUMN ctrader_account_cash_flows.raw_delta IS
  'Lossless signed int64 ProtoOADepositWithdraw.delta retained when row moneyDigits is unavailable; never present raw units as account currency.';
