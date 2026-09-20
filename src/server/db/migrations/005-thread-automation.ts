import type { DatabaseMigration } from "../migrate.js";

export const threadAutomationMigration: DatabaseMigration = {
  version: 5,
  name: "thread-automation",
  sql: `
    CREATE TEMP TABLE thread_automation_duplicate_guard (
      duplicate_count INTEGER NOT NULL CHECK (duplicate_count = 0)
    ) STRICT;

    INSERT INTO thread_automation_duplicate_guard(duplicate_count)
    SELECT count(*)
    FROM (
      SELECT tenant_id, owner_principal_id, anchor_thread_id
      FROM automation_definitions
      WHERE deleted_at IS NULL
      GROUP BY tenant_id, owner_principal_id, anchor_thread_id
      HAVING count(*) > 1
    );

    DROP TABLE thread_automation_duplicate_guard;

    CREATE UNIQUE INDEX automation_definitions_one_per_thread
      ON automation_definitions(
        tenant_id, owner_principal_id, anchor_thread_id
      )
      WHERE deleted_at IS NULL;
  `,
};
