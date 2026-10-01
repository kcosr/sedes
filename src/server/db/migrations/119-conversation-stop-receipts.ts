import type { DatabaseMigration } from "../migrate.js";

/** Old turn-targeted Stop retries must never become a fresh session-wide Stop. */
export const conversationStopReceiptsMigration: DatabaseMigration = {
  version: 119,
  name: "conversation_stop_receipts",
  sql: `
DELETE FROM mutation_receipts
WHERE operation_kind = 'conversation_interrupt' AND result_code = 'prepared';

UPDATE mutation_receipts
SET result_json = json_object(
    'version', 2,
    'applicationOperationId', json_extract(result_json, '$.applicationOperationId'),
    'deadlineAt', created_at + 30000
  )
WHERE operation_kind = 'conversation_interrupt' AND result_code = 'accepted';

UPDATE mutation_receipts
SET result_code = 'failed_unknown', replayable = 1,
  result_json = json_object(
    'version', 2,
    'applicationOperationId', json_extract(result_json, '$.applicationOperationId'),
    'deadlineAt', created_at + 30000,
    'failureDiagnostic', 'The previous Stop has an unknown outcome after upgrade. You may issue a new Stop.'
  )
WHERE operation_kind = 'conversation_interrupt' AND result_code = 'uncertain';
`,
};
