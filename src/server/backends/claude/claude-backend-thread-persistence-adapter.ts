import type Database from "better-sqlite3";
import type { BackendEffectiveSettings } from "../../../shared/protocol/backend.js";
import type { BackendThreadPersistenceAdapter } from "../../conversations/conversation-lifecycle-service.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { DomainError } from "../../domain/errors.js";
import type {
  AgentConnectionProfile,
  BackendCatalog,
  RegisteredBackendActionInput,
} from "../contracts.js";
import {
  parseClaudeBindingDetail,
  serializeClaudeBindingDetail,
} from "./claude-binding-codec.js";
import {
  ClaudeThreadRepository,
  type ClaudeDesiredSettings,
  type ClaudeThreadSettingsRecord,
  type ClaudeThreadTarget,
} from "./claude-thread-repository.js";
import type { ClaudePermissionMode } from "./claude-permission-policy.js";

export interface ClaudeConnectionDefaults {
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: ClaudePermissionMode;
}

type ThreadTargetRow = ClaudeThreadTarget & {
  readonly title: string;
  readonly backingState: string;
};

type BoundTargetRow = ThreadTargetRow & {
  readonly backendConversationId: string;
  readonly backendKind: string;
  readonly connectionKind: string;
};

export class ClaudeBackendThreadPersistenceAdapter implements BackendThreadPersistenceAdapter {
  readonly database: Database.Database;
  readonly settings: ClaudeThreadRepository;
  readonly #scope: RequestScope;
  readonly #backendInstanceId: string;
  readonly #resolveDefaults: (
    connection: AgentConnectionProfile,
  ) => ClaudeConnectionDefaults | undefined;
  readonly #now: () => number;

  constructor(input: {
    readonly database: Database.Database;
    readonly scope: RequestScope;
    readonly backendInstanceId: string;
    readonly settings?: ClaudeThreadRepository;
    readonly resolveConnectionDefaults: (
      connection: AgentConnectionProfile,
    ) => ClaudeConnectionDefaults | undefined;
    readonly now?: () => number;
  }) {
    this.database = input.database;
    this.settings =
      input.settings ?? new ClaudeThreadRepository(input.database);
    this.#scope = Object.freeze({ ...input.scope });
    this.#backendInstanceId = input.backendInstanceId;
    this.#resolveDefaults = input.resolveConnectionDefaults;
    this.#now = input.now ?? Date.now;
    if (
      !this.#scope.tenantId ||
      !this.#scope.principalId ||
      !this.#backendInstanceId ||
      this.settings.database !== this.database
    ) {
      throw new Error("claude_persistence_scope_invalid");
    }
  }

  initializeThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): void {
    const target = this.#assertThreadConnection(
      scope,
      applicationThreadId,
      connection,
    );
    this.settings.initialize(
      scope,
      applicationThreadId,
      target,
      { model: null, effort: null, permissionMode: null },
      this.#now(),
    );
  }

  initializeForkThread(
    scope: RequestScope,
    sourceApplicationThreadId: string,
    childApplicationThreadId: string,
    connection: AgentConnectionProfile,
    effectiveSettings: BackendEffectiveSettings,
  ): void {
    this.#assertThreadConnection(scope, sourceApplicationThreadId, connection);
    const childTarget = this.#assertThreadConnection(
      scope,
      childApplicationThreadId,
      connection,
    );
    const source = this.settings.get(scope, sourceApplicationThreadId);
    if (
      !source.model ||
      !source.permissionMode ||
      source.effectiveModelState !== "confirmed" ||
      source.effectiveModel !== source.model ||
      source.effectiveEffortState !== "confirmed" ||
      source.effectiveEffort !== source.effort ||
      source.effectivePermissionState !== "confirmed" ||
      source.effectivePermissionMode !== source.permissionMode ||
      source.effectiveModelGeneration === null ||
      source.effectiveModelGeneration !== source.effectiveEffortGeneration ||
      source.effectiveModelGeneration !==
        source.effectivePermissionGeneration ||
      effectiveSettings.model?.provider !== connection.id ||
      effectiveSettings.model.id !== source.model ||
      (effectiveSettings.thinkingLevel ?? null) !== source.effort
    ) {
      throw new DomainError(
        "conflict",
        "The source Claude effective settings are not authoritatively confirmed.",
      );
    }
    const child = this.settings.initialize(
      scope,
      childApplicationThreadId,
      childTarget,
      {
        model: source.model,
        effort: source.effort,
        permissionMode: source.permissionMode,
      },
      this.#now(),
    );
    if (
      child.model !== source.model ||
      child.effort !== source.effort ||
      child.permissionMode !== source.permissionMode
    ) {
      throw new DomainError(
        "conflict",
        "The Claude fork settings do not match the source snapshot.",
      );
    }
  }

  readForkSettings(
    scope: RequestScope,
    childApplicationThreadId: string,
  ): BackendEffectiveSettings {
    this.#assertScope(scope);
    const target = this.#threadTarget(scope, childApplicationThreadId);
    if (target.backendInstanceId !== this.#backendInstanceId) {
      throw targetMismatch();
    }
    const settings = this.settings.get(scope, childApplicationThreadId);
    if (!settings.model) {
      throw new DomainError(
        "conflict",
        "The Claude fork settings are not resolved.",
      );
    }
    return {
      model: { provider: target.connectionProfileId, id: settings.model },
      ...(settings.effort ? { thinkingLevel: settings.effort } : {}),
    };
  }

  readDesiredSettings(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): ClaudeThreadSettingsRecord {
    this.#assertThreadConnection(scope, applicationThreadId, connection);
    return this.settings.get(scope, applicationThreadId);
  }

  initializeNewThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
    catalog: BackendCatalog,
  ): void {
    const target = this.#assertThreadConnection(
      scope,
      applicationThreadId,
      connection,
    );
    const desired = resolveDesiredSettings(
      connection,
      catalog,
      this.#resolveDefaults(connection),
    );
    const current = this.settings.initialize(
      scope,
      applicationThreadId,
      target,
      desired,
      this.#now(),
    );
    if (
      current.model === null &&
      current.effort === null &&
      current.permissionMode !== desired.permissionMode
    ) {
      this.settings.updateDesired(scope, applicationThreadId, {
        expectedRevision: current.revision,
        desired,
        now: this.#now(),
      });
    } else if (
      current.model !== desired.model ||
      current.effort !== desired.effort ||
      current.permissionMode !== desired.permissionMode
    ) {
      throw new DomainError(
        "conflict",
        "The Claude thread settings were already initialized differently.",
      );
    }
  }

  initializeResolvedNewThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
    desired: ClaudeDesiredSettings,
  ): void {
    if (!desired.model || !desired.permissionMode) {
      throw unavailableSettings();
    }
    const target = this.#assertThreadConnection(
      scope,
      applicationThreadId,
      connection,
    );
    const current = this.settings.initialize(
      scope,
      applicationThreadId,
      target,
      desired,
      this.#now(),
    );
    if (current.model === null && current.effort === null) {
      this.settings.updateDesired(scope, applicationThreadId, {
        expectedRevision: current.revision,
        desired,
        now: this.#now(),
      });
    } else if (
      current.model !== desired.model ||
      current.effort !== desired.effort ||
      current.permissionMode !== desired.permissionMode
    ) {
      throw new DomainError(
        "conflict",
        "The Claude thread settings were already initialized differently.",
      );
    }
  }

  validateInitialization(
    scope: RequestScope,
    applicationThreadId: string,
    catalog: BackendCatalog,
  ): void {
    this.#assertScope(scope);
    const record = this.settings.get(scope, applicationThreadId);
    const model = catalog.models.find(
      ({ provider, id }) =>
        provider === record.connectionProfileId && id === record.model,
    );
    if (
      !model ||
      !record.permissionMode ||
      (record.effort === null
        ? (model.supportedReasoningEfforts?.length ?? 0) !== 0
        : !model.supportedReasoningEfforts?.includes(record.effort))
    ) {
      throw unavailableSettings();
    }
  }

  initializationActions(
    scope: RequestScope,
    applicationThreadId: string,
    _attemptId: string,
  ): readonly RegisteredBackendActionInput[] {
    this.#assertScope(scope);
    this.settings.get(scope, applicationThreadId);
    return [];
  }

  recordSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    input: {
      readonly applicationOperationId: string;
      readonly mutationId: string;
      readonly reconciliationToken: string;
    },
  ): void {
    this.#assertScope(scope);
    this.settings.get(scope, applicationThreadId);
    if (
      !attemptId ||
      !input.applicationOperationId ||
      !input.mutationId ||
      !input.reconciliationToken
    ) {
      throw new DomainError(
        "conflict",
        "Claude submission identities must not be empty.",
      );
    }
    this.settings.freezeOperationSnapshot(scope, {
      applicationThreadId,
      applicationOperationId: input.applicationOperationId,
      now: this.#now(),
    });
  }

  hasSubmissionIntent(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
    applicationOperationId: string,
  ): boolean {
    this.#assertScope(scope);
    const attempt = this.database
      .prepare(
        `
          SELECT mutation_id AS mutationId, phase,
            retry_anchor AS retryAnchor
          FROM conversation_creation_attempts
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ? AND attempt_id = ?
            AND force_reset_at IS NULL
        `,
      )
      .get(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        attemptId,
      ) as
      | {
          readonly mutationId: string;
          readonly phase: string;
          readonly retryAnchor: string | null;
        }
      | undefined;
    return (
      attempt !== undefined &&
      attempt.mutationId === applicationOperationId &&
      (attempt.phase === "first_submission_started" ||
        attempt.phase === "accepted_unpersisted" ||
        attempt.phase === "bound" ||
        (attempt.phase === "recovery_required" && attempt.retryAnchor !== null))
    );
  }

  saveBoundBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
    opaqueBindingDetail: string,
  ): void {
    this.#assertScope(scope);
    const parsed = parseClaudeBindingDetail(opaqueBindingDetail);
    const binding = this.#boundTarget(scope, applicationThreadId);
    if (
      binding.backendKind !== "claude_agent_sdk" ||
      binding.connectionKind !== "claude_agent_sdk" ||
      binding.backendInstanceId !== this.#backendInstanceId ||
      parsed.sessionId !== binding.backendConversationId
    ) {
      throw targetMismatch();
    }
    const canonical = serializeClaudeBindingDetail(parsed);
    const existing = this.database
      .prepare(
        `SELECT opaque_binding_detail AS opaqueBindingDetail
         FROM claude_binding_details
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      { readonly opaqueBindingDetail: string } | undefined;
    if (
      existing &&
      parseClaudeBindingDetail(existing.opaqueBindingDetail).sessionId !==
        parsed.sessionId
    ) {
      throw new DomainError(
        "conflict",
        "The Claude native session identity changed.",
      );
    }
    this.database
      .prepare(
        `
          INSERT INTO claude_binding_details(
            tenant_id, owner_principal_id, application_thread_id,
            backend_instance_id, connection_profile_id,
            execution_environment_id, opaque_binding_detail
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(tenant_id, owner_principal_id, application_thread_id)
          DO UPDATE SET opaque_binding_detail = excluded.opaque_binding_detail
        `,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        binding.backendInstanceId,
        binding.connectionProfileId,
        binding.executionEnvironmentId,
        canonical,
      );
  }

  getBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
  ): string | undefined {
    this.#assertScope(scope);
    const binding = this.#findBoundTarget(scope, applicationThreadId);
    if (!binding) return undefined;
    const row = this.database
      .prepare(
        `SELECT opaque_binding_detail AS opaqueBindingDetail
         FROM claude_binding_details
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      { readonly opaqueBindingDetail: string } | undefined;
    if (!row) throw targetMismatch();
    const detail = parseClaudeBindingDetail(row.opaqueBindingDetail);
    if (detail.sessionId !== binding.backendConversationId) {
      throw targetMismatch();
    }
    return serializeClaudeBindingDetail(detail);
  }

  #assertThreadConnection(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): ThreadTargetRow {
    this.#assertScope(scope);
    if (
      connection.kind !== "claude_agent_sdk" ||
      connection.tenantId !== scope.tenantId ||
      connection.ownerPrincipalId !== scope.principalId ||
      connection.backendInstanceId !== this.#backendInstanceId
    ) {
      throw targetMismatch();
    }
    const target = this.#threadTarget(scope, applicationThreadId);
    if (
      target.backendInstanceId !== connection.backendInstanceId ||
      target.connectionProfileId !== connection.id ||
      target.executionEnvironmentId !== connection.executionEnvironmentId
    ) {
      throw targetMismatch();
    }
    return target;
  }

  #threadTarget(
    scope: RequestScope,
    applicationThreadId: string,
  ): ThreadTargetRow {
    const row = this.database
      .prepare(
        `
          SELECT backend_instance_id AS backendInstanceId,
            connection_profile_id AS connectionProfileId,
            environment_id AS executionEnvironmentId, title,
            backing_state AS backingState
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      ThreadTargetRow | undefined;
    if (!row) throw new DomainError("not_found", "The thread was not found.");
    return row;
  }

  #findBoundTarget(
    scope: RequestScope,
    applicationThreadId: string,
  ): BoundTargetRow | undefined {
    return this.database
      .prepare(
        `
          SELECT binding.backend_instance_id AS backendInstanceId,
            binding.connection_profile_id AS connectionProfileId,
            binding.execution_environment_id AS executionEnvironmentId,
            binding.backend_conversation_id AS backendConversationId,
            thread.title, thread.backing_state AS backingState,
            backend.kind AS backendKind, profile.kind AS connectionKind
          FROM conversation_bindings AS binding
          JOIN application_threads AS thread
            ON thread.tenant_id = binding.tenant_id
            AND thread.owner_principal_id = binding.owner_principal_id
            AND thread.id = binding.application_thread_id
          JOIN agent_backend_instances AS backend
            ON backend.tenant_id = binding.tenant_id
            AND backend.id = binding.backend_instance_id
          JOIN agent_connection_profiles AS profile
            ON profile.tenant_id = binding.tenant_id
            AND profile.owner_principal_id = binding.owner_principal_id
            AND profile.id = binding.connection_profile_id
          WHERE binding.tenant_id = ? AND binding.owner_principal_id = ?
            AND binding.application_thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      BoundTargetRow | undefined;
  }

  #boundTarget(
    scope: RequestScope,
    applicationThreadId: string,
  ): BoundTargetRow {
    const row = this.#findBoundTarget(scope, applicationThreadId);
    if (!row) throw targetMismatch();
    return row;
  }

  #assertScope(scope: RequestScope): void {
    if (
      scope.tenantId !== this.#scope.tenantId ||
      scope.principalId !== this.#scope.principalId
    ) {
      throw targetMismatch();
    }
  }
}

export function resolveDesiredSettings(
  connection: AgentConnectionProfile,
  catalog: BackendCatalog,
  defaults: ClaudeConnectionDefaults | undefined,
): ClaudeDesiredSettings {
  const models = catalog.models.filter(
    ({ provider }) => provider === connection.id,
  );
  const model = defaults?.model
    ? models.find(({ id }) => id === defaults.model)
    : models.find(({ isDefault }) => isDefault === true);
  if (!defaults?.permissionMode) throw unavailableSettings();
  if (!model) {
    return {
      model: null,
      effort: null,
      permissionMode: defaults.permissionMode,
    };
  }
  const efforts = model.supportedReasoningEfforts ?? [];
  const effort = defaults?.effort ?? model.defaultReasoningEffort;
  if (efforts.length === 0) {
    return {
      model: model.id,
      effort: null,
      permissionMode: defaults.permissionMode,
    };
  }
  if (!effort || !efforts.includes(effort)) {
    return {
      model: null,
      effort: null,
      permissionMode: defaults.permissionMode,
    };
  }
  return { model: model.id, effort, permissionMode: defaults.permissionMode };
}

function targetMismatch(): DomainError {
  return new DomainError(
    "conflict",
    "The Claude connection does not match the thread target.",
  );
}

function unavailableSettings(): DomainError {
  return new DomainError(
    "invalid_transition",
    "Choose an available Claude model and effort before starting this thread.",
  );
}
