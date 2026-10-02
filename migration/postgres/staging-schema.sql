-- Raw, append-only Firebase landing area. Run this as edgebook_owner using the
-- migration connection, never as the runtime edgebook_app role.

BEGIN;

CREATE SCHEMA IF NOT EXISTS edgebook_migration;
REVOKE ALL ON SCHEMA edgebook_migration FROM PUBLIC;

CREATE TABLE IF NOT EXISTS edgebook_migration.batches (
  batch_id uuid PRIMARY KEY,
  source_project text,
  source_scope jsonb NOT NULL,
  source_manifest jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('loading', 'staged', 'validated', 'promoted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  staged_at timestamptz,
  promoted_at timestamptz,
  notes text
);

CREATE TABLE IF NOT EXISTS edgebook_migration.documents (
  batch_id uuid NOT NULL REFERENCES edgebook_migration.batches(batch_id),
  source_path text NOT NULL,
  payload jsonb NOT NULL,
  source_create_time timestamptz,
  source_update_time timestamptz,
  payload_sha256 char(64) NOT NULL,
  redacted_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (batch_id, source_path)
);

CREATE TABLE IF NOT EXISTS edgebook_migration.auth_identities (
  batch_id uuid NOT NULL REFERENCES edgebook_migration.batches(batch_id),
  firebase_uid text NOT NULL,
  email text,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  PRIMARY KEY (batch_id, firebase_uid)
);

CREATE TABLE IF NOT EXISTS edgebook_migration.objects (
  batch_id uuid NOT NULL REFERENCES edgebook_migration.batches(batch_id),
  source_name text NOT NULL,
  local_path text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 char(64) NOT NULL,
  metadata jsonb NOT NULL,
  PRIMARY KEY (batch_id, source_name)
);

REVOKE ALL ON ALL TABLES IN SCHEMA edgebook_migration FROM PUBLIC;

COMMIT;
