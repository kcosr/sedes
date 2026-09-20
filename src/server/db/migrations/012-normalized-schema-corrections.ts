export const normalizedSchemaCorrectionsMigration = {
  version: 12,
  name: "normalized_schema_corrections",
  sql: `
CREATE TABLE mutation_receipts_v12 (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 80),
  request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
  result_code TEXT NOT NULL CHECK (length(result_code) BETWEEN 1 AND 80),
  result_json TEXT NOT NULL CHECK (
    json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 2097152
  ),
  replayable INTEGER NOT NULL CHECK (replayable IN (0, 1)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(
      tenant_id, principal_id, thread_id
    ) ON DELETE RESTRICT
) STRICT;

INSERT INTO mutation_receipts_v12(
  tenant_id, principal_id, thread_id, mutation_id, operation_kind,
  request_fingerprint, result_code, result_json, replayable, created_at
)
SELECT
  tenant_id, principal_id, thread_id, mutation_id, operation_kind,
  request_fingerprint, result_code, result_json, replayable, created_at
FROM mutation_receipts;

DROP TABLE mutation_receipts;
ALTER TABLE mutation_receipts_v12 RENAME TO mutation_receipts;

CREATE INDEX mutation_receipts_created
  ON mutation_receipts(tenant_id, principal_id, created_at);

CREATE UNIQUE INDEX automation_runs_occurrence_key_unique
  ON automation_runs(
    tenant_id, owner_principal_id, automation_id, occurrence_key
  );
`,
} as const;
