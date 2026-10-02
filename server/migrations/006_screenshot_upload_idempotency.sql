-- Screenshot uploads use the existing tenant-scoped idempotency ledger. The
-- API resolves replays by joining file_objects on both user_id and resource_id
-- so an idempotency key never becomes a cross-tenant object lookup.
CREATE INDEX api_idempotency_screenshot_resource_idx
  ON api_idempotency_keys (user_id, resource_id)
  WHERE scope = 'screenshots.upload';
