import type { DatabaseMigration } from "../migrate.js";

/**
 * Retires prepared questionnaire responses created by the removed Sedes
 * auto-resolution timer and removes the obsolete explicit-resolution marker
 * from user-authored responses that still require recovery.
 */
export const removeInteractionTimersMigration: DatabaseMigration = {
  version: 41,
  name: "remove-interaction-timers",
  sql: `
UPDATE mutation_receipts
SET result_code = 'accepted',
    replayable = 1,
    result_json = json_object(
      'version', 1,
      'applicationOperationId',
        json_extract(result_json, '$.applicationOperationId'),
      'interactionId', json_extract(result_json, '$.interactionId')
    )
WHERE operation_kind = 'conversation_interaction_response'
  AND result_code IN ('prepared', 'uncertain')
  AND json_extract(result_json, '$.backendResponse.kind') = 'questionnaire'
  AND json_extract(result_json, '$.backendResponse.resolution') = 'auto';

UPDATE mutation_receipts
SET result_json = json_remove(result_json, '$.backendResponse.resolution')
WHERE operation_kind = 'conversation_interaction_response'
  AND result_code IN ('prepared', 'uncertain')
  AND json_extract(result_json, '$.backendResponse.kind') = 'questionnaire'
  AND json_extract(result_json, '$.backendResponse.resolution') = 'explicit';
`,
};
