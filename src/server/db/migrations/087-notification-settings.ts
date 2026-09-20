export const notificationSettingsMigration = {
  version: 87,
  name: "notification_settings",
  sql: `
CREATE TABLE principal_notification_settings (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json)),
  silenced INTEGER NOT NULL CHECK (silenced IN (0, 1)),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  dispatch_generation INTEGER NOT NULL CHECK (dispatch_generation >= 0),
  event_start_at INTEGER NOT NULL CHECK (event_start_at >= 0),
  dedup_before INTEGER NOT NULL DEFAULT 0 CHECK (dedup_before >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principals(tenant_id, id) ON DELETE RESTRICT
) STRICT;

-- Consumption markers prevent replay. They contain no payload, result or delivery state.
CREATE TABLE notification_event_consumption (
  tenant_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  PRIMARY KEY (tenant_id, owner_principal_id, event_key),
  FOREIGN KEY (tenant_id, owner_principal_id)
    REFERENCES principal_notification_settings(tenant_id, owner_principal_id)
    ON DELETE CASCADE
) STRICT;
CREATE INDEX notification_event_consumption_retention
  ON notification_event_consumption(tenant_id, owner_principal_id, occurred_at);
`,
} as const;
