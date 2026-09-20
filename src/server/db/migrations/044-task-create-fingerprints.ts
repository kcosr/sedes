import type { DatabaseMigration } from "../migrate.js";

/**
 * Task creation now accepts every useful initial field. Rewrite the internal
 * receipts from their former title/scope fingerprint to the normalized full
 * semantic tuple so a replay remains valid after upgrade without a runtime
 * dual-fingerprint path.
 */
export const taskCreateFingerprintsMigration: DatabaseMigration = {
  version: 44,
  name: "task-create-fingerprints",
  sql: `
UPDATE task_mutation_receipts
SET request_fingerprint = harness_task_create_receipt_fingerprint(result_json)
WHERE operation_kind = 'create_task';
`,
} as const;
