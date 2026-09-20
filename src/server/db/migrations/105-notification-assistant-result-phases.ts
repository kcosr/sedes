import type { DatabaseMigration } from "../migrate.js";

export const notificationAssistantResultPhasesMigration: DatabaseMigration = {
  version: 105,
  name: "notification_assistant_result_phases",
  sql: `UPDATE principal_notification_settings
    SET config_json = json_set(config_json, '$.assistantResultPhases', json('["final"]'));`,
};
