import { configurationFingerprint } from "../config/configuration-fingerprint.js";
import type Database from "better-sqlite3";
import {
  effectiveEnvironmentVariables, environmentVariableOverridesSchema,
  environmentVariablesSnapshotSchema, environmentVariablesPreviewResultSchema,
  type EnvironmentVariableOverrides, type EnvironmentVariablesSnapshot,
  type EnvironmentVariablesRevision, type EnvironmentVariablesPreviewResult,
} from "../../shared/protocol/environment-variables.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { ConfigurationRepository } from "../configuration-admin/configuration-repository.js";
import { DomainError } from "../domain/errors.js";

export interface PreparedThreadEnvironmentVariables {
  readonly snapshot: EnvironmentVariablesSnapshot;
  assertCurrent(): void;
}

/** Principal-owned definitions and immutable thread snapshots; never resolves secrets. */
export class EnvironmentVariablesService {
  constructor(readonly database: Database.Database, readonly configuration: ConfigurationRepository) {}

  environmentDefaults(scope: RequestScope, environmentId: string): EnvironmentVariableOverrides {
    const environment = this.configuration.get(scope).configuration.executionEnvironments.find(item => item.id === environmentId);
    if (!environment) throw new DomainError("not_found", "The execution environment was not found.");
    return environmentVariableOverridesSchema.parse(environment.environmentVariables?.execution ?? {});
  }

  preview(scope: RequestScope, targetId: string, agentId?: string): EnvironmentVariablesPreviewResult {
    const configuration = this.configuration.get(scope);
    const profile = this.database.prepare(`SELECT template_id AS templateId FROM agent_connection_profiles
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ? AND enabled = 1`)
      .get(scope.tenantId, scope.principalId, targetId) as { templateId: string } | undefined;
    if (!profile) throw new DomainError("not_found", "The execution target was not found.");
    const target = configuration.configuration.targets.find(item => item.id === profile.templateId && item.enabled);
    const backend = configuration.configuration.backends.find(item => item.id === target?.backendInstanceId && item.enabled);
    const environment = configuration.configuration.executionEnvironments.find(item => item.id === target?.executionEnvironmentId);
    if (!target || !backend || !environment) throw new DomainError("not_found", "The execution target configuration is unavailable.");
    const agent = agentId ? this.database.prepare(`SELECT environment_variables_json AS variables, revision, backend_type_id AS backendTypeId
      FROM saved_agents WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
      .get(scope.tenantId, scope.principalId, agentId) as { variables: string; revision: number; backendTypeId: string } | undefined : undefined;
    if (agentId && !agent) throw new DomainError("not_found", "The Saved Agent was not found.");
    const agentBackendTypes = { pi: "pi", codex_app_server: "codex", claude_agent_sdk: "claude", grok_build: "grok" } as const;
    if (agent && agent.backendTypeId !== agentBackendTypes[backend.kind]) throw new DomainError("conflict", "The Saved Agent uses a different backend type.");
    const supported = backend.kind !== "pi" && (backend.kind !== "codex_app_server" || backend.moduleConfiguration.connection.ownership === "owned");
    const result = environmentVariablesPreviewResultSchema.parse({
      snapshot: { version: 1, layers: {
        environment: environment.environmentVariables?.execution ?? {}, backend: backend.environmentVariables?.execution ?? {},
        agent: agent ? environmentVariableOverridesSchema.parse(JSON.parse(agent.variables)) : {}, thread: {},
      } },
      revision: { configurationRevision: configuration.revision, ...(agent ? { agentRevision: agent.revision } : {}) },
      startup: supported ? { supported: true } : { supported: false, reason: backend.kind === "pi"
        ? "Pi runs inside Sedes. Provider startup variables cannot be configured per backend."
        : "Sedes connects to an existing provider process. Configure its startup environment where that process is launched." },
    });
    // Each layer has a bound; the effective process environment has the same bound.
    effectiveEnvironmentVariables(result.snapshot);
    return result;
  }

  prepare(scope: RequestScope, targetId: string, input: {
    readonly overrides?: EnvironmentVariableOverrides;
    readonly expectedRevision?: EnvironmentVariablesRevision;
    readonly agentId?: string;
  } = {}): PreparedThreadEnvironmentVariables {
    const preview = this.preview(scope, targetId, input.agentId);
    const expected = input.expectedRevision ?? preview.revision;
    const assertCurrent = () => {
      const current = this.preview(scope, targetId, input.agentId);
      if (expected.configurationRevision !== current.revision.configurationRevision || expected.agentRevision !== current.revision.agentRevision) {
        throw new DomainError("conflict", "Environment variable defaults changed. Review the current values before creating the thread.");
      }
    };
    assertCurrent();
    const snapshot = environmentVariablesSnapshotSchema.parse({ ...preview.snapshot,
      layers: { ...preview.snapshot.layers, thread: input.overrides ?? {} } });
    effectiveEnvironmentVariables(snapshot);
    return { snapshot, assertCurrent };
  }

  get(scope: RequestScope, threadId: string): EnvironmentVariablesSnapshot {
    const row = this.database.prepare(`SELECT environment_variables_json AS snapshot FROM application_threads
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`)
      .get(scope.tenantId, scope.principalId, threadId) as { snapshot: string } | undefined;
    if (!row) throw new DomainError("not_found", "The thread was not found.");
    return environmentVariablesSnapshotSchema.parse(JSON.parse(row.snapshot));
  }

  effective(scope: RequestScope, threadId: string): EnvironmentVariableOverrides {
    return effectiveEnvironmentVariables(this.get(scope, threadId));
  }

  initialize(scope: RequestScope, threadId: string, prepared: PreparedThreadEnvironmentVariables): void {
    if (!this.database.inTransaction) throw new Error("environment_variables_initialization_requires_transaction");
    prepared.assertCurrent();
    const snapshot = environmentVariablesSnapshotSchema.parse(prepared.snapshot);
    effectiveEnvironmentVariables(snapshot);
    const result = this.database.prepare(`UPDATE application_threads SET environment_variables_json = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ? AND backing_state = 'unbound'`)
      .run(JSON.stringify(snapshot), scope.tenantId, scope.principalId, threadId);
    if (result.changes !== 1) throw new DomainError("not_found", "The new thread was not found.");
  }

  forkRequestFingerprint(scope: RequestScope, sourceThreadId: string, overrides?: EnvironmentVariableOverrides): string {
    const source = this.get(scope, sourceThreadId);
    const thread = environmentVariableOverridesSchema.parse(overrides ?? source.layers.thread);
    effectiveEnvironmentVariables({ ...source, layers: { ...source.layers, thread } });
    return configurationFingerprint(thread);
  }

  assertForkRequest(scope: RequestScope, mutationId: string, fingerprint: string): void {
    const recorded = this.database.prepare(`
      SELECT environment_variables_fingerprint AS fingerprint FROM conversation_creation_attempts
      WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?
      UNION ALL
      SELECT environment_variables_fingerprint AS fingerprint FROM aborted_thread_forks
      WHERE tenant_id = ? AND owner_principal_id = ? AND creation_operation_id = ?`)
      .all(scope.tenantId, scope.principalId, mutationId, scope.tenantId, scope.principalId, mutationId) as { fingerprint: string }[];
    if (recorded.some(row => row.fingerprint !== fingerprint)) {
      throw new DomainError("conflict", "This fork mutation was already used with different variable settings.");
    }
  }

  recordForkRequest(scope: RequestScope, mutationId: string, childThreadId: string): void {
    if (!this.database.inTransaction) throw new Error("environment_variables_fork_record_requires_transaction");
    const fingerprint = configurationFingerprint(this.get(scope, childThreadId).layers.thread);
    const result = this.database.prepare(`UPDATE conversation_creation_attempts SET environment_variables_fingerprint = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?
        AND application_thread_id = ? AND creation_kind = 'fork' AND phase = 'prepared'`)
      .run(fingerprint, scope.tenantId, scope.principalId, mutationId, childThreadId);
    if (result.changes !== 1) throw new DomainError("conflict", "The new fork attempt was not found.");
  }

  copy(scope: RequestScope, sourceThreadId: string, childThreadId: string, overrides?: EnvironmentVariableOverrides): void {
    const source = this.get(scope, sourceThreadId);
    const snapshot = overrides === undefined ? source : { ...source, layers: { ...source.layers, thread: overrides } };
    this.initialize(scope, childThreadId, { snapshot, assertCurrent() {} });
  }
}
