import type { DatabaseMigration } from "../migrate.js";

/** Partial replies have independent delivery; keep them off until selected. */
export const partialNotificationDeliveryMigration: DatabaseMigration = {
  version: 139,
  name: "partial_notification_delivery",
  sql: `UPDATE principal_notification_settings SET
    config_json = json_set(config_json, '$.delivery."turn.partial"', json('{"script":false,"voice":"none"}')),
    revision = revision + 1,
    dispatch_generation = dispatch_generation + 1;`,
};
