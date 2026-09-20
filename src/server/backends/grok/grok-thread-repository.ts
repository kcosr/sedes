import type Database from "better-sqlite3";
import type { RequestScope } from "../../identity/identity-provider.js";

export interface GrokDesiredSettings {
  readonly model: string | null;
  readonly effort: string | null;
}

export interface GrokThreadTarget {
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
}

export interface GrokThreadSettingsRecord extends GrokDesiredSettings {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly effectiveModel: string | null;
  readonly effectiveEffort: string | null;
  readonly effectiveState: "unknown" | "confirmed";
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface GrokThreadSettingsStore {
  get(
    scope: RequestScope,
    applicationThreadId: string,
  ): GrokThreadSettingsRecord;
  confirmEffective(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly model: string;
      readonly effort: string;
      readonly now: number;
    },
  ): GrokThreadSettingsRecord;
}

const columns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  application_thread_id AS applicationThreadId,
  backend_instance_id AS backendInstanceId,
  connection_profile_id AS connectionProfileId,
  execution_environment_id AS executionEnvironmentId,
  desired_model AS model,
  desired_effort AS effort,
  effective_model AS effectiveModel,
  effective_effort AS effectiveEffort,
  effective_state AS effectiveState,
  revision,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

export class GrokThreadRepository implements GrokThreadSettingsStore {
  constructor(readonly database: Database.Database) {}

  initialize(
    scope: RequestScope,
    applicationThreadId: string,
    target: GrokThreadTarget,
    desired: GrokDesiredSettings,
    now: number,
  ): GrokThreadSettingsRecord {
    requireDesired(desired);
    requireTimestamp(now);
    this.database
      .prepare(
        `INSERT INTO grok_thread_settings(
           tenant_id, owner_principal_id, application_thread_id,
           backend_instance_id, connection_profile_id,
           execution_environment_id, desired_model, desired_effort,
           revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(tenant_id, owner_principal_id, application_thread_id)
         DO NOTHING`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        target.backendInstanceId,
        target.connectionProfileId,
        target.executionEnvironmentId,
        desired.model,
        desired.effort,
        now,
        now,
      );
    const record = this.get(scope, applicationThreadId);
    if (
      record.backendInstanceId !== target.backendInstanceId ||
      record.connectionProfileId !== target.connectionProfileId ||
      record.executionEnvironmentId !== target.executionEnvironmentId
    ) {
      throw new Error("grok_thread_settings_target_changed");
    }
    return record;
  }

  find(
    scope: RequestScope,
    applicationThreadId: string,
  ): GrokThreadSettingsRecord | undefined {
    return this.database
      .prepare(
        `SELECT ${columns}
         FROM grok_thread_settings
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      GrokThreadSettingsRecord | undefined;
  }

  get(
    scope: RequestScope,
    applicationThreadId: string,
  ): GrokThreadSettingsRecord {
    const record = this.find(scope, applicationThreadId);
    if (!record) throw new Error("grok_thread_settings_missing");
    return record;
  }

  updateDesired(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedRevision: number;
      readonly desired: GrokDesiredSettings;
      readonly now: number;
    },
  ): GrokThreadSettingsRecord {
    requireDesired(input.desired);
    requireRevision(input.expectedRevision);
    requireTimestamp(input.now);
    const changed = this.database
      .prepare(
        `UPDATE grok_thread_settings
         SET desired_model = ?, desired_effort = ?,
             effective_model = NULL, effective_effort = NULL,
             effective_state = 'unknown', revision = revision + 1,
             updated_at = ?
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ? AND revision = ?`,
      )
      .run(
        input.desired.model,
        input.desired.effort,
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        input.expectedRevision,
      );
    if (changed.changes !== 1) {
      throw new Error("grok_thread_settings_revision_changed");
    }
    return this.get(scope, applicationThreadId);
  }

  confirmEffective(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly model: string;
      readonly effort: string;
      readonly now: number;
    },
  ): GrokThreadSettingsRecord {
    requireSetting(input.model, 240, "model");
    requireSetting(input.effort, 120, "effort");
    requireTimestamp(input.now);
    return this.database.transaction(() => {
      const current = this.get(scope, applicationThreadId);
      const importing = current.model === null && current.effort === null;
      if (
        !importing &&
        (current.model !== input.model || current.effort !== input.effort)
      ) {
        throw new Error("grok_effective_settings_mismatch");
      }
      if (
        current.effectiveState === "confirmed" &&
        current.effectiveModel === input.model &&
        current.effectiveEffort === input.effort
      ) {
        return current;
      }
      const changed = this.database
        .prepare(
          `UPDATE grok_thread_settings
           SET desired_model = ?, desired_effort = ?,
               effective_model = ?, effective_effort = ?,
               effective_state = 'confirmed',
               revision = revision + 1, updated_at = max(updated_at, ?)
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND application_thread_id = ? AND revision = ?`,
        )
        .run(
          input.model,
          input.effort,
          input.model,
          input.effort,
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          current.revision,
        );
      if (changed.changes !== 1) {
        throw new Error("grok_thread_settings_revision_changed");
      }
      return this.get(scope, applicationThreadId);
    })();
  }
}

function requireDesired(desired: GrokDesiredSettings): void {
  if ((desired.model === null) !== (desired.effort === null)) {
    throw new Error("grok_desired_settings_incomplete");
  }
  if (desired.model !== null) requireSetting(desired.model, 240, "model");
  if (desired.effort !== null) requireSetting(desired.effort, 120, "effort");
}

function requireSetting(value: string, maximum: number, field: string): void {
  if (
    !value ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`grok_thread_settings_${field}_invalid`);
  }
}

function requireRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("grok_thread_settings_revision_invalid");
  }
}

function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("grok_thread_settings_timestamp_invalid");
  }
}
