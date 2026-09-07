-- LOCAL/SYNTHETIC ONLY. Not a production migration; no runtime binding exists.
-- Apply once to an empty in-memory SQLite database through local-harness.mjs.
CREATE TABLE automation_pilot_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1)
);
INSERT INTO automation_pilot_meta VALUES (1, 1);

CREATE TABLE automation_configs_pilot (
  id TEXT PRIMARY KEY NOT NULL
    CHECK (length(id) = 20 AND id NOT GLOB '*[^A-Za-z0-9]*'),
  owner_uid TEXT NOT NULL CHECK (length(owner_uid) BETWEEN 1 AND 128),
  client_id TEXT NOT NULL CHECK (length(client_id) BETWEEN 1 AND 64),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  next_run_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 9007199254740991),
  deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1)),
  record_json TEXT,
  last_patch_json TEXT,
  CHECK (COALESCE((deleted = 1 AND record_json IS NULL AND last_patch_json IS NULL
          AND enabled = 0 AND next_run_at = '')
      OR (deleted = 0 AND record_json IS NOT NULL AND json_valid(record_json)
          AND json_type(record_json, '$.id') = 'text'
          AND json_extract(record_json, '$.id') = id
          AND json_type(record_json, '$.ownerUid') = 'text'
          AND json_extract(record_json, '$.ownerUid') = owner_uid
          AND json_type(record_json, '$.clientId') = 'text'
          AND json_extract(record_json, '$.clientId') = client_id
          AND json_type(record_json, '$.enabled') IN ('true', 'false')
          AND json_extract(record_json, '$.enabled') = enabled
          AND json_extract(record_json, '$.nextRunAt') = next_run_at
          AND json_extract(record_json, '$.createdAt') = created_at), 0))
);
CREATE INDEX automation_pilot_owner_id ON automation_configs_pilot(owner_uid, deleted, id);
CREATE INDEX automation_pilot_client_id ON automation_configs_pilot(owner_uid, client_id, deleted, id);
CREATE INDEX automation_pilot_due ON automation_configs_pilot(owner_uid, deleted, enabled, next_run_at, id);
