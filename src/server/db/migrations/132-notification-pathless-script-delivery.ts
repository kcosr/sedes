import type { DatabaseMigration } from "../migrate.js";

/**
 * Migration 130 carried every old event selection into `script: true`, even
 * for disabled settings that never had a script path. Enabling voice-only
 * delivery then failed script-path validation. A disabled row without a path
 * has never run a script, so its script toggles are cleared. Voice actions,
 * enabled rows, and rows with any configured path keep their selections.
 */
export const notificationPathlessScriptDeliveryMigration: DatabaseMigration = {
  version: 132,
  name: "notification_pathless_script_delivery",
  sql: `UPDATE principal_notification_settings SET
    config_json = json_set(config_json, '$.delivery', json((
      SELECT json_group_object(key, json_set(value, '$.script', json('false')))
      FROM json_each(config_json, '$.delivery')
    ))),
    revision = revision + 1, dispatch_generation = dispatch_generation + 1
  WHERE json_extract(config_json, '$.scriptPath') = ''
    AND json_extract(config_json, '$.enabled') = 0
    AND EXISTS (
      SELECT 1 FROM json_each(config_json, '$.delivery')
      WHERE json_extract(value, '$.script') = 1
    );`,
};
