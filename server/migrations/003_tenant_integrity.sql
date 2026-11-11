-- Cross-tenant UUID references must be impossible even if an application
-- validation is accidentally bypassed. PostgreSQL 16 supports a column list
-- for SET NULL, preserving the child row's non-null user_id.

ALTER TABLE accounts
  ADD CONSTRAINT accounts_user_id_id_unique UNIQUE (user_id, id);

ALTER TABLE broker_connections
  ADD CONSTRAINT broker_connections_user_id_id_unique UNIQUE (user_id, id),
  DROP CONSTRAINT broker_connections_mapped_account_id_fkey,
  ADD CONSTRAINT broker_connections_mapped_account_owner_fkey
    FOREIGN KEY (user_id, mapped_account_id)
    REFERENCES accounts (user_id, id)
    ON DELETE SET NULL (mapped_account_id);

ALTER TABLE trades
  ADD CONSTRAINT trades_user_id_id_unique UNIQUE (user_id, id),
  DROP CONSTRAINT trades_account_id_fkey,
  DROP CONSTRAINT trades_broker_connection_id_fkey,
  ADD CONSTRAINT trades_account_owner_fkey
    FOREIGN KEY (user_id, account_id)
    REFERENCES accounts (user_id, id)
    ON DELETE SET NULL (account_id),
  ADD CONSTRAINT trades_broker_connection_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id)
    REFERENCES broker_connections (user_id, id)
    ON DELETE SET NULL (broker_connection_id);

ALTER TABLE trade_executions
  DROP CONSTRAINT trade_executions_trade_id_fkey,
  DROP CONSTRAINT trade_executions_broker_connection_id_fkey,
  ADD CONSTRAINT trade_executions_trade_owner_fkey
    FOREIGN KEY (user_id, trade_id)
    REFERENCES trades (user_id, id)
    ON DELETE SET NULL (trade_id),
  ADD CONSTRAINT trade_executions_broker_connection_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id)
    REFERENCES broker_connections (user_id, id)
    ON DELETE CASCADE;

ALTER TABLE broker_orders
  DROP CONSTRAINT broker_orders_broker_connection_id_fkey,
  ADD CONSTRAINT broker_orders_broker_connection_owner_fkey
    FOREIGN KEY (user_id, broker_connection_id)
    REFERENCES broker_connections (user_id, id)
    ON DELETE SET NULL (broker_connection_id);

ALTER TABLE pending_duplicates
  DROP CONSTRAINT pending_duplicates_existing_trade_id_fkey,
  ADD CONSTRAINT pending_duplicates_existing_trade_owner_fkey
    FOREIGN KEY (user_id, existing_trade_id)
    REFERENCES trades (user_id, id)
    ON DELETE SET NULL (existing_trade_id);

ALTER TABLE file_objects
  DROP CONSTRAINT file_objects_trade_id_fkey,
  ADD CONSTRAINT file_objects_trade_owner_fkey
    FOREIGN KEY (user_id, trade_id)
    REFERENCES trades (user_id, id)
    ON DELETE CASCADE;

CREATE TABLE api_idempotency_keys (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash bytea NOT NULL,
  resource_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, scope, idempotency_key),
  CHECK (length(scope) BETWEEN 1 AND 64),
  CHECK (length(idempotency_key) BETWEEN 8 AND 200),
  CHECK (octet_length(request_hash) = 32)
);

-- Collapse any transition-era duplicate jobs before enforcing one writer per
-- connection at the queue level. The worker advisory locks remain the second
-- line of defence across processes and disconnect/reconnect operations.
WITH ranked_active_runs AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY broker_connection_id
           ORDER BY CASE WHEN status='running' THEN 0 ELSE 1 END,
                    started_at ASC,
                    id ASC
         ) AS position
  FROM sync_runs
  WHERE status IN ('queued','running')
)
UPDATE sync_runs SET
  status='cancelled',
  finished_at=now(),
  error_code='DUPLICATE_ACTIVE_RUN',
  error_message='Duplicate active run was cancelled while enabling the single-writer queue'
WHERE id IN (SELECT id FROM ranked_active_runs WHERE position > 1);

CREATE UNIQUE INDEX sync_runs_one_active_connection_idx
  ON sync_runs (broker_connection_id)
  WHERE status IN ('queued','running');
