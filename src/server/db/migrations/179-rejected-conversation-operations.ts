import type { DatabaseMigration } from "../migrate.js";

export const rejectedConversationOperationsMigration: DatabaseMigration = {
  version: 179,
  name: "rejected_conversation_operations",
  sql: `
CREATE TABLE rejected_conversation_operations (
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  result_code TEXT NOT NULL CHECK (result_code IN ('prepared', 'uncertain')),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, principal_id, thread_id, mutation_id),
  FOREIGN KEY (tenant_id, principal_id, thread_id)
    REFERENCES thread_principal_state(tenant_id, principal_id, thread_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
`,
};
