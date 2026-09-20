import type { DatabaseMigration } from "../migrate.js";

export const notificationAssistantResultMigration: DatabaseMigration = {
  version: 103,
  name: "notification_assistant_result",
  sql: `UPDATE principal_notification_settings
    SET config_json = json_set(config_json, '$.includeAssistantResult', json('false'));`,
};
