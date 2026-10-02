-- Read-only cTrader Open API integration. Tokens are always application-layer
-- AES-256-GCM envelopes; this migration never creates a plaintext-token path.

ALTER TABLE broker_connections
  ADD COLUMN provider_environment text,
  ADD COLUMN oauth_scope text,
  ADD COLUMN legacy_mapped_account_id text,
  ADD COLUMN token_generation bigint NOT NULL DEFAULT 0,
  ADD COLUMN token_refreshed_at timestamptz,
  ADD COLUMN disconnected_at timestamptz,
  ADD COLUMN disconnect_reason text,
  ADD CONSTRAINT broker_connections_environment_check
    CHECK (provider_environment IS NULL OR provider_environment IN ('live', 'demo'));

DROP INDEX broker_connections_external_unique_idx;
CREATE UNIQUE INDEX broker_connections_external_unique_idx
  ON broker_connections (user_id, provider, provider_environment, external_account_id)
  WHERE external_account_id IS NOT NULL;

CREATE TABLE ctrader_oauth_grants (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  access_token_ciphertext text NOT NULL,
  refresh_token_ciphertext text NOT NULL,
  encryption_key_version integer NOT NULL,
  token_expires_at timestamptz NOT NULL,
  authorized_accounts jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (jsonb_typeof(authorized_accounts) = 'array'),
  CHECK (expires_at <= created_at + interval '30 minutes')
);

CREATE INDEX ctrader_oauth_grants_session_idx
  ON ctrader_oauth_grants (session_id, expires_at DESC)
  WHERE consumed_at IS NULL;

ALTER TABLE trade_executions
  ADD COLUMN external_order_id text,
  ADD COLUMN external_symbol_id text,
  ADD COLUMN deal_status smallint,
  ADD COLUMN filled_volume_cents bigint,
  ADD COLUMN closed_volume_cents bigint,
  ADD COLUMN money_digits integer,
  ADD COLUMN close_position_detail jsonb,
  ADD COLUMN provider_updated_at timestamptz,
  ADD CONSTRAINT trade_executions_ctrader_status_check
    CHECK (deal_status IS NULL OR deal_status IN (2, 3)),
  ADD CONSTRAINT trade_executions_volume_cents_check
    CHECK (filled_volume_cents IS NULL OR filled_volume_cents > 0),
  ADD CONSTRAINT trade_executions_closed_volume_cents_check
    CHECK (closed_volume_cents IS NULL OR closed_volume_cents > 0),
  ADD CONSTRAINT trade_executions_money_digits_check
    CHECK (money_digits IS NULL OR money_digits BETWEEN 0 AND 18);

CREATE INDEX trade_executions_symbol_idx
  ON trade_executions (broker_connection_id, external_symbol_id);

ALTER TABLE sync_runs
  ADD COLUMN requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN claimed_at timestamptz,
  ADD COLUMN heartbeat_at timestamptz,
  ADD COLUMN not_before timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT sync_runs_attempt_count_check CHECK (attempt_count >= 0);

CREATE INDEX sync_runs_connection_started_idx
  ON sync_runs (broker_connection_id, started_at DESC);

CREATE INDEX sync_runs_queue_idx
  ON sync_runs (status, not_before ASC, started_at ASC)
  WHERE status IN ('queued', 'running');

-- A cTrader projection that a user permanently purges must not be recreated by
-- the next broker sync.  The tombstone intentionally survives the projected
-- trade row and the broker connection row; it is removed only with the user.
CREATE TABLE ctrader_trade_tombstones (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_connection_id uuid NOT NULL,
  external_trade_key text NOT NULL,
  external_position_id text,
  purged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, broker_connection_id, external_trade_key)
);

CREATE OR REPLACE FUNCTION preserve_ctrader_trade_tombstone()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.source_system = 'ctrader'
     AND OLD.broker_connection_id IS NOT NULL
     AND OLD.external_trade_key IS NOT NULL THEN
    INSERT INTO ctrader_trade_tombstones (
      user_id, broker_connection_id, external_trade_key, external_position_id
    ) VALUES (
      OLD.user_id, OLD.broker_connection_id, OLD.external_trade_key, OLD.broker_trade_id
    )
    ON CONFLICT (user_id, broker_connection_id, external_trade_key) DO UPDATE SET
      external_position_id = EXCLUDED.external_position_id,
      purged_at = now();
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER trades_preserve_ctrader_tombstone
  BEFORE DELETE ON trades
  FOR EACH ROW EXECUTE FUNCTION preserve_ctrader_trade_tombstone();

CREATE INDEX symbol_specs_expiry_idx
  ON symbol_specs (provider, provider_environment, external_account_id, expires_at);
