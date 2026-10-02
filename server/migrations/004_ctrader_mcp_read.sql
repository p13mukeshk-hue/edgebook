-- Opt-in, VPS-native compatibility for cTrader's Remote MCP credential.
-- The copied configuration is never stored. Only its extracted bearer token
-- may be persisted, in the existing application-layer AES-256-GCM envelope.

ALTER TABLE broker_connections
  ADD COLUMN connection_mode text;

UPDATE broker_connections
SET connection_mode='official'
WHERE provider='ctrader';

ALTER TABLE broker_connections
  ADD CONSTRAINT broker_connections_ctrader_mode_check CHECK (
    (provider='ctrader' AND connection_mode IS NOT NULL
      AND connection_mode IN ('official', 'mcp_read'))
    OR (provider<>'ctrader' AND connection_mode IS NULL)
  );

DROP INDEX broker_connections_external_unique_idx;
CREATE UNIQUE INDEX broker_connections_external_unique_idx
  ON broker_connections (
    user_id, provider, provider_environment, external_account_id
  )
  NULLS NOT DISTINCT
  WHERE external_account_id IS NOT NULL;
