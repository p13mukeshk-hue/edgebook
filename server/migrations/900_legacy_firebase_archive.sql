-- Immutable, redacted source envelopes retained after the Firebase cutover.
-- Application features do not read this table; it exists so reconciliation can
-- prove that every exported Firestore document reached PostgreSQL, including
-- uncommon/legacy collections that do not have a first-class Edgebook table.

CREATE TABLE legacy_firebase_documents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_path text NOT NULL,
  payload jsonb NOT NULL,
  payload_sha256 char(64) NOT NULL,
  source_create_time timestamptz,
  source_update_time timestamptz,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_path),
  CHECK (source_path ~ '^users/[^/]+(?:/.*)?$'),
  CHECK (payload_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX legacy_firebase_documents_user_idx
  ON legacy_firebase_documents (user_id, source_path);
