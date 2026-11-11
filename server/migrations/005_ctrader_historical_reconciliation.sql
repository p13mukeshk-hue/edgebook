-- Reviewed cTrader historical imports.  A historical import is deliberately
-- separate from broker_connections.sync_cursor and from the connection-time
-- opening-lineage proof: it is a preview/reconciliation workflow, not a cursor
-- rewind.

CREATE TABLE ctrader_historical_imports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_connection_id uuid NOT NULL,
  external_account_id text NOT NULL,
  provider_environment text NOT NULL,
  boundary_at timestamptz NOT NULL,
  boundary_local text NOT NULL,
  time_zone text NOT NULL,
  -- Historical role-less executions may be projected only from a boundary at
  -- which this exact account was flat. This is a new, purpose-limited
  -- statement; it never rewrites the connection-time lineage proof.
  no_open_positions_attested boolean NOT NULL,
  attestation_version smallint NOT NULL DEFAULT 1,
  attestation_purpose text NOT NULL DEFAULT 'historical_preview_reconciliation',
  acknowledged_at timestamptz NOT NULL,
  -- The upper bound is the already-approved normal history floor. Historical
  -- preview and automatic sync therefore own disjoint [from, through) and
  -- [through, now] windows.
  through_at timestamptz NOT NULL,
  normal_history_floor_at_request timestamptz NOT NULL,
  normal_history_floor_kind_at_request text NOT NULL,
  client_request_id uuid NOT NULL,
  request_hash bytea NOT NULL,
  status text NOT NULL DEFAULT 'queued',
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text,
  error_message text,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  CONSTRAINT ctrader_historical_import_connection_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id)
    REFERENCES broker_connections (user_id, id) ON DELETE CASCADE,
  CONSTRAINT ctrader_historical_import_owner_connection_id_unique
    UNIQUE (user_id, broker_connection_id, id),
  UNIQUE (user_id, client_request_id),
  CHECK (provider_environment IN ('live','demo')),
  CHECK (no_open_positions_attested = true),
  CHECK (attestation_version = 1),
  CHECK (attestation_purpose = 'historical_preview_reconciliation'),
  CHECK (length(external_account_id) BETWEEN 1 AND 200),
  CHECK (boundary_local ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$'),
  CHECK (length(time_zone) BETWEEN 1 AND 80),
  CHECK (boundary_at < through_at),
  CHECK (through_at = normal_history_floor_at_request),
  CHECK (normal_history_floor_kind_at_request = 'connection_time_empty_attested'),
  CHECK (through_at <= acknowledged_at),
  CHECK (status IN ('queued','running','review','completed','failed','cancelled')),
  CHECK (row_version >= 1),
  CHECK (jsonb_typeof(counters) = 'object'),
  CHECK (octet_length(request_hash) = 32)
);

CREATE OR REPLACE FUNCTION enforce_ctrader_historical_import_attestation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  actual_now timestamptz;
  local_match_count integer;
BEGIN
  IF TG_OP = 'UPDATE' AND (
    NEW.user_id IS DISTINCT FROM OLD.user_id OR
    NEW.broker_connection_id IS DISTINCT FROM OLD.broker_connection_id OR
    NEW.external_account_id IS DISTINCT FROM OLD.external_account_id OR
    NEW.provider_environment IS DISTINCT FROM OLD.provider_environment OR
    NEW.boundary_at IS DISTINCT FROM OLD.boundary_at OR
    NEW.boundary_local IS DISTINCT FROM OLD.boundary_local OR
    NEW.time_zone IS DISTINCT FROM OLD.time_zone OR
    NEW.no_open_positions_attested IS DISTINCT FROM OLD.no_open_positions_attested OR
    NEW.attestation_version IS DISTINCT FROM OLD.attestation_version OR
    NEW.attestation_purpose IS DISTINCT FROM OLD.attestation_purpose OR
    NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at OR
    NEW.through_at IS DISTINCT FROM OLD.through_at OR
    NEW.normal_history_floor_at_request IS DISTINCT FROM OLD.normal_history_floor_at_request OR
    NEW.normal_history_floor_kind_at_request IS DISTINCT FROM OLD.normal_history_floor_kind_at_request OR
    NEW.client_request_id IS DISTINCT FROM OLD.client_request_id OR
    NEW.request_hash IS DISTINCT FROM OLD.request_hash
  ) THEN
    RAISE EXCEPTION 'cTrader historical import identity and attestation are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    actual_now := clock_timestamp();
    NEW.acknowledged_at := actual_now;

    PERFORM 1
    FROM broker_connections connection
    WHERE connection.user_id = NEW.user_id
      AND connection.id = NEW.broker_connection_id
      AND connection.provider = 'ctrader'
      AND connection.external_account_id = NEW.external_account_id
      AND connection.provider_environment = NEW.provider_environment
      AND round(extract(epoch FROM NEW.normal_history_floor_at_request) * 1000)::bigint =
        CASE
          WHEN (connection.provider_metadata->>'historyFloorTimestamp') ~ '^\d+$'
          THEN (connection.provider_metadata->>'historyFloorTimestamp')::bigint
          ELSE NULL
        END
      AND connection.provider_metadata->>'historyFloorKind' = NEW.normal_history_floor_kind_at_request
      AND connection.provider_metadata->>'historyReadValidated' = 'true'
      AND NEW.through_at = NEW.normal_history_floor_at_request
      AND connection.provider_metadata #>> '{noOpenPositionsAttestation,version}' = '1'
      AND connection.provider_metadata #>> '{noOpenPositionsAttestation,userId}' = NEW.user_id::text
      AND connection.provider_metadata #>> '{noOpenPositionsAttestation,connectionId}' = NEW.broker_connection_id::text
      AND connection.provider_metadata #>> '{noOpenPositionsAttestation,accountId}' = NEW.external_account_id
      AND connection.provider_metadata #>> '{noOpenPositionsAttestation,environment}' = NEW.provider_environment
      AND connection.provider_metadata #>> '{noOpenPositionsAttestation,boundaryTimestamp}' =
        connection.provider_metadata->>'historyFloorTimestamp';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'historical import account identity does not match its cTrader connection'
        USING ERRCODE = '23514';
    END IF;

    PERFORM 1 FROM pg_timezone_names WHERE name = NEW.time_zone;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'historical import timezone is not a known IANA timezone'
        USING ERRCODE = '22023';
    END IF;
    IF date_trunc('minute', NEW.boundary_at) <> NEW.boundary_at
       OR to_char(NEW.boundary_at AT TIME ZONE NEW.time_zone, 'YYYY-MM-DD"T"HH24:MI') <> NEW.boundary_local THEN
      RAISE EXCEPTION 'historical UTC boundary does not match the supplied local time and timezone'
        USING ERRCODE = '22023';
    END IF;
    -- A fall-back clock transition maps two UTC instants to the same wall-clock
    -- minute. Refuse both rather than allowing the client to choose one offset.
    -- The wider window also covers the largest modern IANA offset jumps.
    SELECT count(*)::integer INTO local_match_count
    FROM generate_series(
      NEW.boundary_at - interval '30 hours',
      NEW.boundary_at + interval '30 hours',
      interval '1 minute'
    ) AS series(instant)
    WHERE to_char(instant AT TIME ZONE NEW.time_zone, 'YYYY-MM-DD"T"HH24:MI') = NEW.boundary_local;
    IF local_match_count <> 1 THEN
      RAISE EXCEPTION 'historical local boundary is ambiguous or nonexistent in this timezone'
        USING ERRCODE = '22023';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ctrader_historical_imports_enforce_attestation
  BEFORE INSERT OR UPDATE ON ctrader_historical_imports
  FOR EACH ROW EXECUTE FUNCTION enforce_ctrader_historical_import_attestation();

CREATE UNIQUE INDEX ctrader_historical_import_one_active_idx
  ON ctrader_historical_imports (broker_connection_id)
  WHERE status IN ('queued','running','review');

CREATE TRIGGER ctrader_historical_imports_set_updated_at
  BEFORE UPDATE ON ctrader_historical_imports
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE trade_executions
  ADD CONSTRAINT trade_executions_owner_connection_id_unique
    UNIQUE (user_id, broker_connection_id, id);

ALTER TABLE sync_runs
  ADD COLUMN historical_import_user_id uuid,
  ADD COLUMN historical_import_id uuid,
  ADD CONSTRAINT sync_runs_historical_import_pair_check CHECK (
    (historical_import_user_id IS NULL AND historical_import_id IS NULL)
    OR (historical_import_user_id IS NOT NULL AND historical_import_id IS NOT NULL)
  ),
  ADD CONSTRAINT sync_runs_historical_import_owner_fkey
    FOREIGN KEY (historical_import_user_id, broker_connection_id, historical_import_id)
    REFERENCES ctrader_historical_imports (user_id, broker_connection_id, id)
    ON DELETE CASCADE;

CREATE UNIQUE INDEX sync_runs_historical_import_unique_idx
  ON sync_runs (historical_import_id)
  WHERE historical_import_id IS NOT NULL;

CREATE TABLE ctrader_historical_import_executions (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_connection_id uuid NOT NULL,
  import_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, import_id, execution_id),
  CONSTRAINT ctrader_historical_execution_import_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id, import_id)
    REFERENCES ctrader_historical_imports (user_id, broker_connection_id, id)
    ON DELETE CASCADE,
  CONSTRAINT ctrader_historical_execution_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id, execution_id)
    REFERENCES trade_executions (user_id, broker_connection_id, id)
    ON DELETE CASCADE
);

CREATE TABLE ctrader_reconciliation_candidates (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_connection_id uuid NOT NULL,
  import_id uuid NOT NULL,
  external_position_id text NOT NULL,
  external_trade_key text NOT NULL,
  manual_trade_id uuid,
  manual_row_version integer,
  classification text NOT NULL,
  confidence integer NOT NULL DEFAULT 0,
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  differences jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidate_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  projected_trade jsonb,
  status text NOT NULL DEFAULT 'pending',
  resolution_action text,
  resolved_trade_id uuid,
  row_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CONSTRAINT ctrader_reconciliation_connection_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id)
    REFERENCES broker_connections (user_id, id) ON DELETE CASCADE,
  CONSTRAINT ctrader_reconciliation_import_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id, import_id)
    REFERENCES ctrader_historical_imports (user_id, broker_connection_id, id)
    ON DELETE CASCADE,
  CONSTRAINT ctrader_reconciliation_manual_owner_fkey
    FOREIGN KEY (user_id, manual_trade_id)
    REFERENCES trades (user_id, id) ON DELETE SET NULL (manual_trade_id),
  CONSTRAINT ctrader_reconciliation_resolved_owner_fkey
    FOREIGN KEY (user_id, resolved_trade_id)
    REFERENCES trades (user_id, id) ON DELETE SET NULL (resolved_trade_id),
  CONSTRAINT ctrader_reconciliation_owner_import_id_unique
    UNIQUE (user_id, broker_connection_id, import_id, id),
  CONSTRAINT ctrader_reconciliation_import_position_unique
    UNIQUE (user_id, broker_connection_id, import_id, external_position_id),
  CHECK (classification IN ('high_confidence','ambiguous','deleted_manual','unmatched','execution_only')),
  CHECK (confidence BETWEEN 0 AND 100),
  CHECK (status IN ('pending','linked','published','suppressed','rejected')),
  CHECK (row_version >= 1),
  CHECK (manual_row_version IS NULL OR manual_row_version >= 1),
  CHECK (length(external_position_id) BETWEEN 1 AND 200),
  CHECK (external_trade_key = 'position:' || external_position_id),
  CHECK (jsonb_typeof(reasons) = 'array'),
  CHECK (jsonb_typeof(differences) = 'object'),
  CHECK (jsonb_typeof(candidate_data) = 'object'),
  CHECK (projected_trade IS NULL OR jsonb_typeof(projected_trade) = 'object'),
  CHECK (
    (status = 'pending' AND resolution_action IS NULL AND resolved_trade_id IS NULL AND resolved_at IS NULL)
    OR (status = 'linked' AND resolution_action = 'link_manual' AND resolved_at IS NOT NULL)
    OR (status = 'published' AND resolution_action = 'publish_separate' AND resolved_at IS NOT NULL)
    OR (status = 'suppressed' AND resolution_action = 'suppress_deleted' AND resolved_trade_id IS NULL AND resolved_at IS NOT NULL)
    OR (status = 'rejected' AND resolution_action = 'reject' AND resolved_trade_id IS NULL AND resolved_at IS NOT NULL)
  )
);

CREATE INDEX ctrader_reconciliation_review_idx
  ON ctrader_reconciliation_candidates (user_id, import_id, status, created_at);

CREATE TRIGGER ctrader_reconciliation_candidates_set_updated_at
  BEFORE UPDATE ON ctrader_reconciliation_candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The link is the durable identity bridge.  It lets later normal syncs enrich
-- the same manual row rather than creating a second row.
CREATE TABLE ctrader_trade_links (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_connection_id uuid NOT NULL,
  external_position_id text NOT NULL,
  external_trade_key text NOT NULL,
  trade_id uuid NOT NULL,
  import_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, broker_connection_id, external_position_id),
  CONSTRAINT ctrader_trade_links_connection_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id)
    REFERENCES broker_connections (user_id, id) ON DELETE CASCADE,
  CONSTRAINT ctrader_trade_links_trade_owner_fkey
    FOREIGN KEY (user_id, trade_id)
    REFERENCES trades (user_id, id) ON DELETE CASCADE,
  CONSTRAINT ctrader_trade_links_import_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id, import_id)
    REFERENCES ctrader_historical_imports (user_id, broker_connection_id, id)
    ON DELETE SET NULL (import_id),
  UNIQUE (user_id, trade_id),
  UNIQUE (user_id, broker_connection_id, external_trade_key),
  CHECK (length(external_position_id) BETWEEN 1 AND 200),
  CHECK (external_trade_key = 'position:' || external_position_id)
);

-- A linked manual row has no cTrader source fields on the trade itself, so the
-- older trades_preserve_ctrader_tombstone trigger cannot see its provider
-- identity. Preserve that identity from the link before a permanent trade
-- purge cascades here. Skip user/connection erasure cascades: those parent rows
-- are already absent, and user deletion must never be held up by a new child.
CREATE OR REPLACE FUNCTION preserve_ctrader_link_tombstone()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)
     AND EXISTS (
       SELECT 1 FROM broker_connections
       WHERE user_id = OLD.user_id AND id = OLD.broker_connection_id
     )
     AND NOT EXISTS (
       SELECT 1 FROM trades
       WHERE user_id = OLD.user_id AND id = OLD.trade_id
     ) THEN
    INSERT INTO ctrader_trade_tombstones (
      user_id, broker_connection_id, external_trade_key,
      external_position_id, purged_at
    ) VALUES (
      OLD.user_id, OLD.broker_connection_id, OLD.external_trade_key,
      OLD.external_position_id, now()
    )
    ON CONFLICT (user_id, broker_connection_id, external_trade_key) DO UPDATE SET
      external_position_id = EXCLUDED.external_position_id,
      purged_at = EXCLUDED.purged_at;
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER ctrader_trade_links_preserve_tombstone
  BEFORE DELETE ON ctrader_trade_links
  FOR EACH ROW EXECUTE FUNCTION preserve_ctrader_link_tombstone();

-- Full before/staged snapshots provide database-level rollback evidence. They
-- are intentionally not copied into audit_events or API responses.
CREATE TABLE ctrader_reconciliation_resolutions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  broker_connection_id uuid NOT NULL,
  import_id uuid NOT NULL,
  candidate_id uuid NOT NULL,
  client_request_id uuid NOT NULL,
  request_hash bytea NOT NULL,
  action text NOT NULL,
  before_manual jsonb,
  staged_projection jsonb,
  resolved_trade_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ctrader_resolution_candidate_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id, import_id, candidate_id)
    REFERENCES ctrader_reconciliation_candidates
      (user_id, broker_connection_id, import_id, id)
    ON DELETE CASCADE,
  CONSTRAINT ctrader_resolution_trade_owner_fkey
    FOREIGN KEY (user_id, resolved_trade_id)
    REFERENCES trades (user_id, id) ON DELETE CASCADE,
  UNIQUE (user_id, client_request_id),
  UNIQUE (candidate_id),
  CHECK (action IN ('link_manual','publish_separate','suppress_deleted','reject')),
  CHECK (octet_length(request_hash) = 32),
  CHECK (before_manual IS NULL OR jsonb_typeof(before_manual) = 'object'),
  CHECK (staged_projection IS NULL OR jsonb_typeof(staged_projection) = 'object'),
  CHECK (
    (action IN ('link_manual','publish_separate') AND resolved_trade_id IS NOT NULL)
    OR (action IN ('suppress_deleted','reject') AND resolved_trade_id IS NULL)
  )
);

COMMENT ON COLUMN ctrader_reconciliation_resolutions.before_manual IS
  'PRIVATE rollback evidence; never serialize through the public API';
COMMENT ON COLUMN ctrader_reconciliation_resolutions.staged_projection IS
  'PRIVATE rollback evidence; never serialize through the public API';
REVOKE ALL ON ctrader_reconciliation_resolutions FROM PUBLIC;

CREATE OR REPLACE FUNCTION reject_ctrader_resolution_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'cTrader reconciliation resolution records are immutable';
END;
$$;

CREATE TRIGGER ctrader_reconciliation_resolutions_immutable
  BEFORE UPDATE ON ctrader_reconciliation_resolutions
  FOR EACH ROW EXECUTE FUNCTION reject_ctrader_resolution_mutation();
