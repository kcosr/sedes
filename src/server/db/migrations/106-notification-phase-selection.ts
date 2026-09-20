import type { DatabaseMigration } from "../migrate.js";

export const notificationPhaseSelectionMigration: DatabaseMigration = {
  version: 106,
  name: "notification_phase_selection",
  sql: `UPDATE principal_notification_settings
    SET config_json = json_remove(
      json_set(config_json, '$.assistantResultPhases', json(
        CASE WHEN json_extract(config_json, '$.includeAssistantResult') = 1
          THEN json_extract(config_json, '$.assistantResultPhases')
          ELSE '[]'
        END
      )),
      '$.includeAssistantResult'
    );`,
};
