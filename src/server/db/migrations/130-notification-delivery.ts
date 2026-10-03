import type { DatabaseMigration } from "../migrate.js";

// Keep this historical list local: future event additions must not alter its checksum.
const events = ["turn.progress", "turn.completed", "turn.failed", "turn.interrupted",
  "thread.woke", "automation.started", "automation.failed", "approval.requested",
  "input.requested", "question.requested"];
export const notificationDeliveryMigration: DatabaseMigration = {
  version: 130,
  name: "notification_delivery",
  sql: `UPDATE principal_notification_settings SET
    config_json = json_set(json_remove(config_json, '$.events'), '$.delivery', json_object(
      ${events.map((event) => `'${event}', json_object('script', json(CASE WHEN EXISTS (
        SELECT 1 FROM json_each(config_json, '$.events') WHERE value = '${event}'
      ) THEN 'true' ELSE 'false' END), 'voice', '${event === "turn.completed" ? "speakThenListen" : "speak"}')`).join(",\n")}
    )), revision = revision + 1, dispatch_generation = dispatch_generation + 1;`,
};
