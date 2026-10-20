import type { DatabaseMigration } from "../migrate.js";

/**
 * Per-thread recovery checks read a thread's unresolved receipts by result
 * code: uncertain-operation and draft-Steer lookups, Stop expiry, blocking
 * Steers, thread input activity and bulk-archive blockers. Without a
 * thread-leading index each of them walked every receipt the principal ever
 * wrote. The index is not partial because SQLite does not use a partial
 * `result_code IN (...)` index for the single-code equality lookups.
 */
export const mutationReceiptThreadIndexMigration: DatabaseMigration = {
  version: 153,
  name: "mutation_receipt_thread_index",
  sql: `
CREATE INDEX mutation_receipts_thread_state
  ON mutation_receipts(tenant_id, principal_id, thread_id, result_code);
`,
};
