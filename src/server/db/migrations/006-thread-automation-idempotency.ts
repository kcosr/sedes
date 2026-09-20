import type { DatabaseMigration } from "../migrate.js";

export const threadAutomationIdempotencyMigration: DatabaseMigration = {
  version: 6,
  name: "thread-automation-idempotency",
  sql: `
    CREATE TEMP TABLE automation_run_id_duplicate_guard (
      duplicate_count INTEGER NOT NULL CHECK (duplicate_count = 0)
    ) STRICT;

    INSERT INTO automation_run_id_duplicate_guard(duplicate_count)
    SELECT count(*)
    FROM (
      SELECT tenant_id, owner_principal_id, id
      FROM automation_runs
      GROUP BY tenant_id, owner_principal_id, id
      HAVING count(*) > 1
    );

    DROP TABLE automation_run_id_duplicate_guard;

    CREATE UNIQUE INDEX automation_runs_scoped_id
      ON automation_runs(tenant_id, owner_principal_id, id);

    ALTER TABLE automation_mutation_receipts
      RENAME TO automation_mutation_receipts_before_thread_identity;

    CREATE TABLE automation_mutation_receipts (
      tenant_id TEXT NOT NULL,
      owner_principal_id TEXT NOT NULL,
      mutation_id TEXT NOT NULL CHECK (length(mutation_id) BETWEEN 1 AND 128),
      automation_id TEXT NOT NULL,
      mutation_kind TEXT NOT NULL
        CHECK (mutation_kind IN ('create', 'update', 'state', 'delete')),
      request_fingerprint TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
      result_revision INTEGER NOT NULL CHECK (result_revision >= 0),
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      PRIMARY KEY (tenant_id, owner_principal_id, mutation_id),
      FOREIGN KEY (tenant_id, owner_principal_id, automation_id)
        REFERENCES automation_definitions(
          tenant_id, owner_principal_id, id
        ) ON DELETE RESTRICT
    ) STRICT;

    INSERT INTO automation_mutation_receipts
    SELECT * FROM automation_mutation_receipts_before_thread_identity;

    DROP TABLE automation_mutation_receipts_before_thread_identity;

    CREATE INDEX automation_mutation_receipts_created
      ON automation_mutation_receipts(
        tenant_id, owner_principal_id, created_at
      );
  `,
};
