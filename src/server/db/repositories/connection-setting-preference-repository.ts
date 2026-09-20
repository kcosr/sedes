import type Database from "better-sqlite3";
import type { RequestScope } from "../../identity/identity-provider.js";

export type ConnectionSettingId =
  | "model"
  | "thinking_level"
  | "tool_access";

export type ConnectionSettingPreferenceRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly connectionProfileId: string;
  readonly settingId: ConnectionSettingId;
  readonly value: string;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  connection_profile_id AS connectionProfileId,
  setting_id AS settingId,
  value,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export class ConnectionSettingPreferenceRepository {
  constructor(readonly database: Database.Database) {}

  find(
    scope: RequestScope,
    connectionProfileId: string,
    settingId: ConnectionSettingId,
  ): ConnectionSettingPreferenceRecord | undefined {
    return this.database
      .prepare(
        `
          SELECT ${columns}
          FROM agent_connection_setting_preferences
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND connection_profile_id = ? AND setting_id = ?
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        connectionProfileId,
        settingId,
      ) as ConnectionSettingPreferenceRecord | undefined;
  }

  save(
    scope: RequestScope,
    connectionProfileId: string,
    settingId: ConnectionSettingId,
    value: string,
    now: number,
  ): ConnectionSettingPreferenceRecord {
    this.database
      .prepare(
        `
          INSERT INTO agent_connection_setting_preferences(
            tenant_id, owner_principal_id, connection_profile_id,
            setting_id, value, revision, created_at, updated_at
          )
          VALUES (?, ?, ?, ?, ?, 0, ?, ?)
          ON CONFLICT(
            tenant_id, owner_principal_id, connection_profile_id, setting_id
          ) DO UPDATE SET
            value = excluded.value,
            revision = revision + 1,
            updated_at = max(updated_at, excluded.updated_at)
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        connectionProfileId,
        settingId,
        value,
        now,
        now,
      );
    return this.find(scope, connectionProfileId, settingId)!;
  }

  remove(
    scope: RequestScope,
    connectionProfileId: string,
    settingId: ConnectionSettingId,
  ): boolean {
    return (
      this.database
        .prepare(
          `
            DELETE FROM agent_connection_setting_preferences
            WHERE tenant_id = ? AND owner_principal_id = ?
              AND connection_profile_id = ? AND setting_id = ?
          `,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          connectionProfileId,
          settingId,
        ).changes === 1
    );
  }
}
