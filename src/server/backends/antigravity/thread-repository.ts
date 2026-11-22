import type Database from "better-sqlite3";
import { antigravityConnectionDefaultsSchema } from "../../../shared/protocol/antigravity-configuration.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AgentConnectionProfile } from "../contracts.js";

export interface AntigravityDesiredSettings {
  readonly modelId: string | null;
  readonly thinkingLevel: string | null;
  readonly modeId: string | null;
}

export interface AntigravityThreadSettings extends AntigravityDesiredSettings {
  readonly revision: number;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
}

export interface AntigravityThreadTarget {
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly canonicalWorkspacePath: string;
  readonly backingState: "unbound" | "creating" | "creation_unknown" | "bound";
  readonly revision: number;
}

export class AntigravityThreadRepository {
  constructor(readonly database: Database.Database) {}

  target(scope: RequestScope, applicationThreadId: string): AntigravityThreadTarget {
    const target = this.database.prepare(`
      SELECT t.backend_instance_id AS backendInstanceId, t.connection_profile_id AS connectionProfileId,
        t.environment_id AS executionEnvironmentId, w.canonical_path AS canonicalWorkspacePath,
        t.backing_state AS backingState, t.revision
      FROM application_threads AS t
      JOIN agent_backend_instances AS b ON b.tenant_id = t.tenant_id
        AND b.id = t.backend_instance_id AND b.owner_principal_id = t.owner_principal_id
      JOIN workspaces AS w ON w.tenant_id = t.tenant_id AND w.owner_principal_id = t.owner_principal_id
        AND w.id = t.workspace_id
      WHERE t.tenant_id = ? AND t.owner_principal_id = ? AND t.id = ? AND b.kind = 'antigravity'
    `).get(scope.tenantId, scope.principalId, applicationThreadId) as AntigravityThreadTarget | undefined;
    if (!target) throw missingThread();
    return target;
  }

  assertConnection(scope: RequestScope, applicationThreadId: string, connection: AgentConnectionProfile): AntigravityThreadTarget {
    const target = this.target(scope, applicationThreadId);
    if (connection.kind !== "antigravity_acp" || connection.tenantId !== scope.tenantId ||
      connection.ownerPrincipalId !== scope.principalId || connection.id !== target.connectionProfileId ||
      connection.backendInstanceId !== target.backendInstanceId ||
      connection.executionEnvironmentId !== target.executionEnvironmentId) {
      throw new DomainError("conflict", "The Antigravity connection does not match the thread target.");
    }
    return target;
  }

  initialize(scope: RequestScope, applicationThreadId: string, connection: AgentConnectionProfile, desired: AntigravityDesiredSettings, now: number): AntigravityThreadSettings {
    const target = this.assertConnection(scope, applicationThreadId, connection);
    validateDesired(desired);
    return this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO antigravity_thread_settings(
          tenant_id, owner_principal_id, application_thread_id, backend_instance_id,
          connection_profile_id, execution_environment_id, desired_model_id,
          desired_thinking_level, desired_mode_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, owner_principal_id, application_thread_id) DO NOTHING
      `).run(scope.tenantId, scope.principalId, applicationThreadId, target.backendInstanceId,
        target.connectionProfileId, target.executionEnvironmentId, desired.modelId,
        desired.thinkingLevel, desired.modeId, now, now);
      const current = this.get(scope, applicationThreadId);
      if (current.modelId !== desired.modelId || current.thinkingLevel !== desired.thinkingLevel ||
        current.modeId !== desired.modeId) {
        throw new DomainError("conflict", "The Antigravity thread settings were already initialized differently.");
      }
      return current;
    })();
  }

  get(scope: RequestScope, applicationThreadId: string): AntigravityThreadSettings {
    const settings = this.database.prepare(`
      SELECT backend_instance_id AS backendInstanceId, connection_profile_id AS connectionProfileId,
        execution_environment_id AS executionEnvironmentId, desired_model_id AS modelId,
        desired_thinking_level AS thinkingLevel, desired_mode_id AS modeId, revision
      FROM antigravity_thread_settings
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
    `).get(scope.tenantId, scope.principalId, applicationThreadId) as AntigravityThreadSettings | undefined;
    if (!settings) throw missingThread();
    return settings;
  }

  updateDesired(scope: RequestScope, applicationThreadId: string, input: {
    readonly expectedRevision: number;
    readonly desired: AntigravityDesiredSettings;
    readonly now: number;
  }): AntigravityThreadSettings {
    const { modelId, thinkingLevel, modeId } = input.desired;
    validateDesired(input.desired);
    return this.database.transaction(() => {
      const updated = this.database.prepare(`
        UPDATE antigravity_thread_settings
        SET desired_model_id = ?, desired_thinking_level = ?, desired_mode_id = ?,
          revision = revision + 1, updated_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ? AND revision = ?
      `).run(modelId, thinkingLevel, modeId, input.now, scope.tenantId, scope.principalId,
        applicationThreadId, input.expectedRevision);
      if (updated.changes !== 1) {
        throw new DomainError("conflict", "The Antigravity thread settings changed or were unavailable.");
      }
      return this.get(scope, applicationThreadId);
    })();
  }
}

function validateDesired(input: AntigravityDesiredSettings): void {
  if (!antigravityConnectionDefaultsSchema.safeParse({
    modelId: input.modelId ?? undefined,
    thinkingLevel: input.thinkingLevel ?? undefined,
    modeId: input.modeId ?? undefined,
  }).success) {
    throw new DomainError("invalid_transition", "The Antigravity thread settings contain an invalid identifier.");
  }
}

function missingThread(): DomainError {
  return new DomainError("not_found", "The Antigravity thread was not found.");
}
