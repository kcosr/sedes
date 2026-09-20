import type { DatabaseMigration } from "../migrate.js";

export const claudeSkillInvocationsMigration: DatabaseMigration = {
  version: 72,
  name: "claude_skill_invocations",
  verifyDatabaseIntegrity: true,
  sql: `CREATE TABLE claude_skill_invocations (
    tenant_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    application_thread_id TEXT NOT NULL,
    native_user_message_uuid TEXT NOT NULL CHECK (
      length(native_user_message_uuid) BETWEEN 1 AND 128
    ),
    skill_name TEXT NOT NULL CHECK (
      length(skill_name) BETWEEN 1 AND 160
      AND substr(skill_name, 1, 1) GLOB '[A-Za-z]'
      AND skill_name NOT GLOB '*[^A-Za-z0-9_-]*'
    ),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (
      tenant_id, owner_principal_id, application_thread_id,
      native_user_message_uuid
    ),
    FOREIGN KEY (tenant_id, owner_principal_id, application_thread_id)
      REFERENCES claude_thread_settings(
        tenant_id, owner_principal_id, application_thread_id
      ) ON DELETE CASCADE
  ) STRICT;

  CREATE TRIGGER claude_skill_invocations_immutable_update
  BEFORE UPDATE ON claude_skill_invocations
  BEGIN
    SELECT RAISE(ABORT, 'Claude skill invocations are immutable');
  END;

  CREATE TRIGGER claude_skill_invocations_immutable_delete
  BEFORE DELETE ON claude_skill_invocations
  BEGIN
    SELECT RAISE(ABORT, 'Claude skill invocations are immutable');
  END;`,
};
