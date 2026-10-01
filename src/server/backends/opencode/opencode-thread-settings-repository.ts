import type Database from "better-sqlite3";
import { z } from "zod";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { openCodeObservationSchema, openCodeSelectionSchema, type OpenCodeObservation, type OpenCodeSelection } from "./opencode-model-selection.js";

export interface OpenCodeThreadTarget {
  readonly backendInstanceId: string; readonly connectionProfileId: string; readonly executionEnvironmentId: string;
}
export interface OpenCodeThreadSettingsRecord extends OpenCodeThreadTarget {
  readonly tenantId: string; readonly ownerPrincipalId: string; readonly applicationThreadId: string;
  readonly desired: OpenCodeSelection | null; readonly observed: OpenCodeObservation | null;
  readonly observationState: "unknown" | "confirmed"; readonly observationGeneration: string | null;
  readonly revision: number; readonly createdAt: number; readonly updatedAt: number;
}
export interface OpenCodeOperationSettingsSnapshot {
  readonly applicationThreadId: string; readonly applicationOperationId: string;
  readonly operationKind: "create" | "submit" | "steer"; readonly settingsRevision: number;
  readonly selection: OpenCodeSelection; readonly createdAt: number;
}
type SettingsRow = Omit<OpenCodeThreadSettingsRecord, "desired" | "observed"> & { desiredJson: string | null; observedJson: string | null };
const identity = z.string().min(1).max(1_024).refine(value => Buffer.from(value, "utf8").toString("utf8") === value && !/\p{Cc}/u.test(value));
const integer = z.number().int().nonnegative().safe();
const operationKind = z.enum(["create", "submit", "steer"]);
const columns = `tenant_id AS tenantId, owner_principal_id AS ownerPrincipalId, application_thread_id AS applicationThreadId,
  backend_instance_id AS backendInstanceId, connection_profile_id AS connectionProfileId, execution_environment_id AS executionEnvironmentId,
  desired_selection_json AS desiredJson, observed_selection_json AS observedJson, observation_state AS observationState,
  observation_generation AS observationGeneration, revision, created_at AS createdAt, updated_at AS updatedAt`;

/** Desired revision and native observation authority are intentionally independent. */
export class OpenCodeThreadSettingsRepository {
  readonly database: Database.Database;
  readonly scope: RequestScope;
  readonly backendInstanceId: string;
  constructor(input: { readonly database: Database.Database; readonly scope: RequestScope; readonly backendInstanceId: string }) {
    this.database = input.database; this.scope = Object.freeze({ tenantId: identity.parse(input.scope.tenantId), principalId: identity.parse(input.scope.principalId) });
    this.backendInstanceId = identity.parse(input.backendInstanceId);
  }
  initialize(scope: RequestScope, applicationThreadId: string, target: OpenCodeThreadTarget, desired: OpenCodeSelection | null, now: number): OpenCodeThreadSettingsRecord {
    this.assertTarget(scope, applicationThreadId, target); integer.parse(now);
    const desiredJson = desired === null ? null : encodedSelection(desired);
    this.database.prepare(`INSERT INTO opencode_thread_settings (tenant_id,owner_principal_id,application_thread_id,
      backend_instance_id,connection_profile_id,execution_environment_id,desired_selection_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,owner_principal_id,application_thread_id) DO NOTHING`)
      .run(scope.tenantId, scope.principalId, applicationThreadId, target.backendInstanceId, target.connectionProfileId,
        target.executionEnvironmentId, desiredJson, now, now);
    return this.get(scope, applicationThreadId);
  }
  find(scope: RequestScope, applicationThreadId: string): OpenCodeThreadSettingsRecord | undefined {
    this.assertScope(scope); identity.parse(applicationThreadId);
    const row = this.database.prepare(`SELECT ${columns} FROM opencode_thread_settings
      WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=?`).get(scope.tenantId, scope.principalId, applicationThreadId) as SettingsRow | undefined;
    if (!row) return undefined;
    this.assertTarget(scope, applicationThreadId, row);
    const { desiredJson, observedJson, ...rest } = row;
    return Object.freeze({ ...rest, desired: desiredJson === null ? null : Object.freeze(openCodeSelectionSchema.parse(JSON.parse(desiredJson))),
      observed: observedJson === null ? null : Object.freeze(openCodeObservationSchema.parse(JSON.parse(observedJson))) });
  }
  get(scope: RequestScope, applicationThreadId: string): OpenCodeThreadSettingsRecord {
    const current = this.find(scope, applicationThreadId);
    if (!current) throw new DomainError("not_found", "The OpenCode thread settings were not found.");
    return current;
  }
  updateDesired(scope: RequestScope, applicationThreadId: string, input: { readonly expectedRevision: number; readonly desired: OpenCodeSelection; readonly now: number }): OpenCodeThreadSettingsRecord {
    this.get(scope, applicationThreadId); integer.parse(input.expectedRevision); integer.parse(input.now);
    const changed = this.database.prepare(`UPDATE opencode_thread_settings SET desired_selection_json=?, revision=revision+1, updated_at=max(updated_at,?)
      WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=? AND revision=?`)
      .run(encodedSelection(input.desired), input.now, scope.tenantId, scope.principalId, applicationThreadId, input.expectedRevision);
    if (changed.changes !== 1) throw changedSettings();
    return this.get(scope, applicationThreadId);
  }
  beginObservation(scope: RequestScope, applicationThreadId: string, input: { readonly expectedRevision: number; readonly generation: string; readonly now: number }): boolean {
    this.get(scope, applicationThreadId); validateObservationWrite(input);
    return this.database.prepare(`UPDATE opencode_thread_settings SET observation_state='unknown', observation_generation=?, updated_at=max(updated_at,?)
      WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=? AND revision=?`)
      .run(input.generation, input.now, scope.tenantId, scope.principalId, applicationThreadId, input.expectedRevision).changes === 1;
  }
  recordObserved(scope: RequestScope, applicationThreadId: string, input: {
    readonly expectedRevision: number; readonly generation: string; readonly observed: OpenCodeObservation; readonly now: number;
  }): boolean {
    this.get(scope, applicationThreadId); validateObservationWrite(input);
    const observed = JSON.stringify(openCodeObservationSchema.parse(input.observed));
    if (Buffer.byteLength(observed) > 8_192) throw changedSettings();
    return this.database.prepare(`UPDATE opencode_thread_settings SET observed_selection_json=?, observation_state='confirmed', updated_at=max(updated_at,?)
      WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=? AND revision=? AND observation_generation=?`)
      .run(observed, input.now, scope.tenantId, scope.principalId, applicationThreadId, input.expectedRevision, input.generation).changes === 1;
  }
  markUnknown(scope: RequestScope, applicationThreadId: string, input: { readonly expectedRevision: number; readonly generation: string; readonly now: number }): boolean {
    this.get(scope, applicationThreadId); validateObservationWrite(input);
    return this.database.prepare(`UPDATE opencode_thread_settings SET observation_state='unknown', updated_at=max(updated_at,?)
      WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=? AND revision=? AND observation_generation=?`)
      .run(input.now, scope.tenantId, scope.principalId, applicationThreadId, input.expectedRevision, input.generation).changes === 1;
  }
  captureOperation(scope: RequestScope, input: { readonly applicationThreadId: string; readonly applicationOperationId: string;
    readonly operationKind: OpenCodeOperationSettingsSnapshot["operationKind"]; readonly expectedRevision?: number; readonly now: number;
  }): OpenCodeOperationSettingsSnapshot {
    identity.parse(input.applicationOperationId); operationKind.parse(input.operationKind); integer.parse(input.now);
    return this.database.transaction(() => {
      const prior = this.readOperation(scope, input.applicationThreadId, input.applicationOperationId, input.operationKind);
      if (prior) {
        if (input.expectedRevision !== undefined && prior.settingsRevision !== input.expectedRevision) throw changedSettings();
        return prior;
      }
      const settings = this.get(scope, input.applicationThreadId);
      if (!settings.desired || (input.expectedRevision !== undefined && settings.revision !== input.expectedRevision)) throw changedSettings();
      this.database.prepare(`INSERT INTO opencode_operation_settings_snapshots
        (tenant_id,owner_principal_id,application_thread_id,application_operation_id,operation_kind,settings_revision,selection_json,created_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(scope.tenantId, scope.principalId, input.applicationThreadId, input.applicationOperationId,
          input.operationKind, settings.revision, encodedSelection(settings.desired), input.now);
      return this.readOperation(scope, input.applicationThreadId, input.applicationOperationId, input.operationKind)!;
    })();
  }
  readOperation(scope: RequestScope, applicationThreadId: string, applicationOperationId: string,
    kind: OpenCodeOperationSettingsSnapshot["operationKind"]): OpenCodeOperationSettingsSnapshot | undefined {
    this.get(scope, applicationThreadId); identity.parse(applicationOperationId); operationKind.parse(kind);
    const row = this.database.prepare(`SELECT application_thread_id AS applicationThreadId, application_operation_id AS applicationOperationId,
      operation_kind AS operationKind, settings_revision AS settingsRevision, selection_json AS selectionJson, created_at AS createdAt
      FROM opencode_operation_settings_snapshots WHERE tenant_id=? AND owner_principal_id=? AND application_operation_id=? AND operation_kind=?`)
      .get(scope.tenantId, scope.principalId, applicationOperationId, kind) as (Omit<OpenCodeOperationSettingsSnapshot, "selection"> & { selectionJson: string }) | undefined;
    if (!row) return undefined;
    if (row.applicationThreadId !== applicationThreadId) throw changedSettings();
    const { selectionJson, ...rest } = row;
    return Object.freeze({ ...rest, selection: Object.freeze(openCodeSelectionSchema.parse(JSON.parse(selectionJson))) });
  }
  assertScope(scope: RequestScope): void {
    if (scope.tenantId !== this.scope.tenantId || scope.principalId !== this.scope.principalId) throw changedSettings();
  }
  assertTarget(scope: RequestScope, applicationThreadId: string, target: OpenCodeThreadTarget): void {
    this.assertScope(scope); identity.parse(applicationThreadId);
    const row = this.database.prepare(`SELECT thread.backend_instance_id AS backendInstanceId, thread.connection_profile_id AS connectionProfileId,
      thread.environment_id AS executionEnvironmentId, backend.kind AS backendKind, profile.kind AS connectionKind
      FROM application_threads AS thread JOIN agent_backend_instances AS backend ON backend.tenant_id=thread.tenant_id AND backend.id=thread.backend_instance_id
      JOIN agent_connection_profiles AS profile ON profile.tenant_id=thread.tenant_id AND profile.owner_principal_id=thread.owner_principal_id AND profile.id=thread.connection_profile_id
      WHERE thread.tenant_id=? AND thread.owner_principal_id=? AND thread.id=?`).get(scope.tenantId, scope.principalId, applicationThreadId) as
        (OpenCodeThreadTarget & { backendKind: string; connectionKind: string }) | undefined;
    if (!row || row.backendKind !== "opencode" || row.connectionKind !== "opencode_http" || row.backendInstanceId !== this.backendInstanceId ||
      row.backendInstanceId !== target.backendInstanceId || row.connectionProfileId !== target.connectionProfileId || row.executionEnvironmentId !== target.executionEnvironmentId) throw changedSettings();
  }
}
function encodedSelection(value: OpenCodeSelection): string {
  const encoded = JSON.stringify(openCodeSelectionSchema.parse(value));
  if (Buffer.byteLength(encoded) > 4_096) throw changedSettings();
  return encoded;
}
function validateObservationWrite(input: { expectedRevision: number; generation: string; now: number }): void {
  integer.parse(input.expectedRevision); integer.parse(input.now); identity.parse(input.generation);
}
function changedSettings(): DomainError { return new DomainError("conflict", "The OpenCode settings or thread target changed."); }
