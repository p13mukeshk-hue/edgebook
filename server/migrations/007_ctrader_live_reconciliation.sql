-- Normal cTrader sync may discover a broker position after the trader has
-- already journalled it manually. Stage that identity decision instead of
-- publishing a duplicate. Historical reconciliation remains immutable and
-- separate; this table owns only the ongoing-sync workflow.
CREATE TABLE ctrader_live_reconciliation_candidates (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_connection_id uuid NOT NULL,
  external_position_id text NOT NULL,
  external_trade_key text NOT NULL,
  manual_trade_id uuid,
  manual_row_version integer,
  broker_trade_id uuid,
  broker_row_version integer,
  classification text NOT NULL,
  confidence integer NOT NULL DEFAULT 0,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  differences jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidate_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  projected_trade jsonb NOT NULL,
  projection_fingerprint bytea NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  resolution_action text,
  resolved_trade_id uuid,
  merged_broker_snapshot jsonb,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT ctrader_live_reconciliation_connection_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id)
    REFERENCES broker_connections (user_id, id) ON DELETE CASCADE,
  CONSTRAINT ctrader_live_reconciliation_manual_owner_fkey
    FOREIGN KEY (user_id, manual_trade_id)
    REFERENCES trades (user_id, id) ON DELETE SET NULL (manual_trade_id),
  CONSTRAINT ctrader_live_reconciliation_broker_owner_fkey
    FOREIGN KEY (user_id, broker_trade_id)
    REFERENCES trades (user_id, id) ON DELETE SET NULL (broker_trade_id),
  CONSTRAINT ctrader_live_reconciliation_resolved_owner_fkey
    FOREIGN KEY (user_id, resolved_trade_id)
    REFERENCES trades (user_id, id) ON DELETE CASCADE,
  UNIQUE (user_id, broker_connection_id, id),
  UNIQUE (user_id, broker_connection_id, external_position_id),
  UNIQUE (user_id, broker_connection_id, external_trade_key),
  CHECK (classification IN ('high_confidence','ambiguous','deleted_manual','existing_pair')),
  CHECK (confidence BETWEEN 0 AND 100),
  CHECK (status IN ('pending','linked','published','suppressed','rejected')),
  CHECK (row_version >= 1),
  CHECK (manual_row_version IS NULL OR manual_row_version >= 1),
  CHECK (broker_row_version IS NULL OR broker_row_version >= 1),
  CHECK (length(external_position_id) BETWEEN 1 AND 200),
  CHECK (external_trade_key = 'position:' || external_position_id),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (jsonb_typeof(differences) = 'object'),
  CHECK (jsonb_typeof(candidate_data) = 'object'),
  CHECK (jsonb_typeof(projected_trade) = 'object'),
  CHECK (octet_length(projection_fingerprint) = 32),
  CHECK (merged_broker_snapshot IS NULL OR jsonb_typeof(merged_broker_snapshot) = 'object'),
  CHECK (
    (status = 'pending' AND resolution_action IS NULL AND resolved_trade_id IS NULL AND resolved_at IS NULL)
    OR (status = 'linked' AND resolution_action = 'link_manual' AND resolved_trade_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status = 'published' AND resolution_action = 'publish_separate' AND resolved_trade_id IS NOT NULL AND resolved_at IS NOT NULL)
    OR (status = 'suppressed' AND resolution_action = 'suppress_deleted' AND resolved_trade_id IS NULL AND resolved_at IS NOT NULL)
    OR (status = 'rejected' AND resolution_action = 'reject' AND resolved_trade_id IS NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX ctrader_live_reconciliation_review_idx
  ON ctrader_live_reconciliation_candidates (user_id, broker_connection_id, status, created_at);

CREATE TRIGGER ctrader_live_reconciliation_candidates_set_updated_at
  BEFORE UPDATE ON ctrader_live_reconciliation_candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ctrader_live_reconciliation_resolutions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_connection_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  client_request_id uuid NOT NULL,
  request_hash bytea NOT NULL,
  action text NOT NULL,
  selected_manual_trade_id uuid,
  before_manual jsonb,
  before_broker jsonb,
  staged_projection jsonb NOT NULL,
  resolved_trade_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ctrader_live_resolution_candidate_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id, candidate_id)
    REFERENCES ctrader_live_reconciliation_candidates
      (user_id, broker_connection_id, id)
    ON DELETE CASCADE,
  CONSTRAINT ctrader_live_resolution_trade_owner_fkey
    FOREIGN KEY (user_id, resolved_trade_id)
    REFERENCES trades (user_id, id) ON DELETE CASCADE,
  UNIQUE (user_id, client_request_id),
  UNIQUE (candidate_id),
  CHECK (action IN ('link_manual','publish_separate','suppress_deleted','reject')),
  CHECK (octet_length(request_hash) = 32),
  CHECK (before_manual IS NULL OR jsonb_typeof(before_manual) = 'object'),
  CHECK (before_broker IS NULL OR jsonb_typeof(before_broker) = 'object'),
  CHECK (jsonb_typeof(staged_projection) = 'object'),
  CHECK (
    (action IN ('link_manual','publish_separate') AND resolved_trade_id IS NOT NULL)
    OR (action IN ('suppress_deleted','reject') AND resolved_trade_id IS NULL)
  )
);

COMMENT ON COLUMN ctrader_live_reconciliation_resolutions.before_manual IS
  'PRIVATE rollback evidence; never serialize through the public API';
COMMENT ON COLUMN ctrader_live_reconciliation_resolutions.selected_manual_trade_id IS
  'Immutable tenant-validated audit snapshot. Deliberately has no trade FK so purge cannot erase idempotency evidence.';
COMMENT ON COLUMN ctrader_live_reconciliation_resolutions.before_broker IS
  'PRIVATE rollback evidence; never serialize through the public API';
COMMENT ON COLUMN ctrader_live_reconciliation_resolutions.staged_projection IS
  'PRIVATE rollback evidence; never serialize through the public API';
REVOKE ALL ON ctrader_live_reconciliation_resolutions FROM PUBLIC;

CREATE TRIGGER ctrader_live_reconciliation_resolutions_immutable
  BEFORE UPDATE ON ctrader_live_reconciliation_resolutions
  FOR EACH ROW EXECUTE FUNCTION reject_ctrader_resolution_mutation();
