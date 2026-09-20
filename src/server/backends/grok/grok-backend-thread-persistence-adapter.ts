import type Database from "better-sqlite3";
import type { BackendEffectiveSettings } from "../../../shared/protocol/backend.js";
import type { BackendThreadPersistenceAdapter } from "../../conversations/conversation-lifecycle-service.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  AgentConnectionProfile,
  BackendCatalog,
  RegisteredBackendActionInput,
} from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { GrokConnectionModuleConfiguration } from "./grok-backend-configuration.js";
import {
  GrokThreadRepository,
  type GrokDesiredSettings,
  type GrokThreadSettingsRecord,
} from "./grok-thread-repository.js";
import {
  parseGrokConversationBindingDetail,
  serializeGrokConversationBindingDetail,
} from "./grok-conversation-binding.js";

interface ThreadTarget {
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly canonicalWorkspacePath: string;
  readonly title: string;
}

interface BoundTarget extends ThreadTarget {
  readonly backendConversationId: string;
  readonly backendKind: string;
  readonly connectionKind: string;
}

export class GrokBackendThreadPersistenceAdapter implements BackendThreadPersistenceAdapter {
  readonly database: Database.Database;
  readonly settings: GrokThreadRepository;
  readonly #scope: RequestScope;
  readonly #backendInstanceId: string;
  readonly #nativeNamespaceKey: string;
  readonly #resolveDefaults: (
    connection: AgentConnectionProfile,
  ) => GrokConnectionModuleConfiguration["defaults"] | undefined;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #now: () => number;

  constructor(input: {
    readonly database: Database.Database;
    readonly scope: RequestScope;
    readonly backendInstanceId: string;
    readonly nativeNamespaceKey: string;
    readonly resolveConnectionDefaults: (
      connection: AgentConnectionProfile,
    ) => GrokConnectionModuleConfiguration["defaults"] | undefined;
    readonly modelPolicy: CompiledBackendModelPolicy;
    readonly settings?: GrokThreadRepository;
    readonly now?: () => number;
  }) {
    this.database = input.database;
    this.settings = input.settings ?? new GrokThreadRepository(input.database);
    this.#scope = Object.freeze({ ...input.scope });
    this.#backendInstanceId = input.backendInstanceId;
    this.#nativeNamespaceKey = input.nativeNamespaceKey;
    this.#resolveDefaults = input.resolveConnectionDefaults;
    this.#modelPolicy = input.modelPolicy;
    this.#now = input.now ?? Date.now;
    if (
      !this.#scope.tenantId ||
      !this.#scope.principalId ||
      !this.#backendInstanceId ||
      !this.#nativeNamespaceKey ||
      this.settings.database !== this.database
    ) {
      throw new Error("grok_persistence_scope_invalid");
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
      { model: null, effort: null },
      this.#now(),
    );
  }

  initializeForkThread(
    _scope: RequestScope,
    _sourceApplicationThreadId: string,
    _childApplicationThreadId: string,
    _connection: AgentConnectionProfile,
    _effectiveSettings: BackendEffectiveSettings,
  ): never {
    throw unsupportedFork();
  }

  readForkSettings(
    _scope: RequestScope,
    _childApplicationThreadId: string,
  ): never {
    throw unsupportedFork();
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
      this.#modelPolicy,
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
      current.effort !== desired.effort
    ) {
      throw new DomainError(
        "conflict",
        "The Grok thread settings were already initialized differently.",
      );
    }
  }

  initializeResolvedNewThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
    desired: GrokDesiredSettings,
  ): void {
    if (!desired.model || !desired.effort) throw unavailableSettings();
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
      current.effort !== desired.effort
    ) {
      throw new DomainError(
        "conflict",
        "The Grok thread settings were already initialized differently.",
      );
    }
  }

  readDesiredSettings(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): GrokThreadSettingsRecord {
    this.#assertThreadConnection(scope, applicationThreadId, connection);
    return this.settings.get(scope, applicationThreadId);
  }

  validateInitialization(
    scope: RequestScope,
    applicationThreadId: string,
    catalog: BackendCatalog,
  ): void {
    const target = this.#threadTarget(scope, applicationThreadId);
    const connection = this.#connection(scope, target.connectionProfileId);
    const settings = this.settings.get(scope, applicationThreadId);
    const model = catalog.models.find(
      ({ provider, id }) => provider === connection.id && id === settings.model,
    );
    if (
      !model ||
      !settings.effort ||
      !model.supportedReasoningEfforts?.includes(settings.effort) ||
      !this.#modelPolicy.isSelectionAllowed({
        modelId: model.id,
        reasoningEffort: settings.effort,
      })
    ) {
      throw unavailableSettings();
    }
  }

  initializationActions(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
  ): readonly RegisteredBackendActionInput[] {
    this.#assertScope(scope);
    const target = this.#threadTarget(scope, applicationThreadId);
    return Object.freeze([
      Object.freeze({
        applicationOperationId: `${attemptId}:initial-title`,
        action: "rename" as const,
        title: target.title,
      }),
    ]);
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
    this.#threadTarget(scope, applicationThreadId);
    if (
      !attemptId ||
      !input.applicationOperationId ||
      !input.mutationId ||
      !input.reconciliationToken
    ) {
      throw new DomainError(
        "conflict",
        "Grok submission identities must not be empty.",
      );
    }
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
        `SELECT mutation_id AS mutationId, phase, retry_anchor AS retryAnchor
         FROM conversation_creation_attempts
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ? AND attempt_id = ?
           AND force_reset_at IS NULL`,
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
    const detail = parseGrokConversationBindingDetail(opaqueBindingDetail);
    const binding = this.#boundTarget(scope, applicationThreadId);
    if (
      binding.backendKind !== "grok_build" ||
      binding.connectionKind !== "grok_acp" ||
      binding.backendInstanceId !== this.#backendInstanceId ||
      detail.sessionId !== binding.backendConversationId ||
      detail.tenantId !== scope.tenantId ||
      detail.principalId !== scope.principalId ||
      detail.backendInstanceId !== binding.backendInstanceId ||
      detail.connectionProfileId !== binding.connectionProfileId ||
      detail.executionEnvironmentId !== binding.executionEnvironmentId ||
      detail.canonicalWorkspacePath !== binding.canonicalWorkspacePath ||
      detail.nativeNamespaceKey !== this.#nativeNamespaceKey
    ) {
      throw targetMismatch();
    }
    const canonical = serializeGrokConversationBindingDetail(detail);
    const existing = this.getBindingDetail(scope, applicationThreadId);
    if (existing !== undefined && existing !== canonical) {
      throw new DomainError(
        "conflict",
        "The Grok native session binding changed.",
      );
    }
    this.database
      .prepare(
        `INSERT INTO grok_binding_details(
           tenant_id, owner_principal_id, application_thread_id,
           backend_instance_id, connection_profile_id,
           execution_environment_id, opaque_binding_detail
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(tenant_id, owner_principal_id, application_thread_id)
         DO UPDATE SET opaque_binding_detail = excluded.opaque_binding_detail`,
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
         FROM grok_binding_details
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND application_thread_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      { readonly opaqueBindingDetail: string } | undefined;
    if (!row) return undefined;
    const detail = parseGrokConversationBindingDetail(row.opaqueBindingDetail);
    if (
      detail.sessionId !== binding.backendConversationId ||
      detail.tenantId !== scope.tenantId ||
      detail.principalId !== scope.principalId ||
      detail.backendInstanceId !== binding.backendInstanceId ||
      detail.connectionProfileId !== binding.connectionProfileId ||
      detail.executionEnvironmentId !== binding.executionEnvironmentId ||
      detail.canonicalWorkspacePath !== binding.canonicalWorkspacePath ||
      detail.nativeNamespaceKey !== this.#nativeNamespaceKey
    ) {
      throw targetMismatch();
    }
    return serializeGrokConversationBindingDetail(detail);
  }

  #connection(
    scope: RequestScope,
    connectionProfileId: string,
  ): AgentConnectionProfile {
    const row = this.database
      .prepare(
        `SELECT id, tenant_id AS tenantId,
           owner_principal_id AS ownerPrincipalId,
           template_id AS templateId, kind,
           backend_instance_id AS backendInstanceId,
           execution_environment_id AS executionEnvironmentId,
           label, enabled, configuration_revision AS configurationRevision
         FROM agent_connection_profiles
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(scope.tenantId, scope.principalId, connectionProfileId) as
      | (Omit<AgentConnectionProfile, "enabled"> & { readonly enabled: 0 | 1 })
      | undefined;
    if (!row) throw targetMismatch();
    return { ...row, enabled: row.enabled === 1 };
  }

  #assertThreadConnection(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): ThreadTarget {
    this.#assertScope(scope);
    if (
      connection.kind !== "grok_acp" ||
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
  ): ThreadTarget {
    this.#assertScope(scope);
    const row = this.database
      .prepare(
        `SELECT thread.backend_instance_id AS backendInstanceId,
           thread.connection_profile_id AS connectionProfileId,
           thread.environment_id AS executionEnvironmentId,
           workspace.canonical_path AS canonicalWorkspacePath,
           thread.title AS title
         FROM application_threads AS thread
         JOIN workspaces AS workspace
           ON workspace.tenant_id = thread.tenant_id
           AND workspace.owner_principal_id = thread.owner_principal_id
           AND workspace.id = thread.workspace_id
         WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
           AND thread.id = ?`,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      ThreadTarget | undefined;
    if (!row) throw new DomainError("not_found", "The thread was not found.");
    return row;
  }

  #findBoundTarget(
    scope: RequestScope,
    applicationThreadId: string,
  ): BoundTarget | undefined {
    return this.database
      .prepare(
        `SELECT binding.backend_instance_id AS backendInstanceId,
           binding.connection_profile_id AS connectionProfileId,
           binding.execution_environment_id AS executionEnvironmentId,
           binding.backend_conversation_id AS backendConversationId,
           backend.kind AS backendKind, profile.kind AS connectionKind,
           workspace.canonical_path AS canonicalWorkspacePath
         FROM conversation_bindings AS binding
         JOIN application_threads AS thread
           ON thread.tenant_id = binding.tenant_id
           AND thread.owner_principal_id = binding.owner_principal_id
           AND thread.id = binding.application_thread_id
         JOIN workspaces AS workspace
           ON workspace.tenant_id = thread.tenant_id
           AND workspace.owner_principal_id = thread.owner_principal_id
           AND workspace.id = thread.workspace_id
         JOIN agent_backend_instances AS backend
           ON backend.tenant_id = binding.tenant_id
           AND backend.id = binding.backend_instance_id
         JOIN agent_connection_profiles AS profile
           ON profile.tenant_id = binding.tenant_id
           AND profile.owner_principal_id = binding.owner_principal_id
           AND profile.id = binding.connection_profile_id
         WHERE binding.tenant_id = ? AND binding.owner_principal_id = ?
           AND binding.application_thread_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      BoundTarget | undefined;
  }

  #boundTarget(scope: RequestScope, applicationThreadId: string): BoundTarget {
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

export function assertGrokConnectionDefaultsAvailable(
  connection: AgentConnectionProfile,
  catalog: BackendCatalog,
  defaults: GrokConnectionModuleConfiguration["defaults"] | undefined,
  modelPolicy: CompiledBackendModelPolicy,
): void {
  resolveDesiredSettings(connection, catalog, defaults, modelPolicy);
}

export function resolveGrokDesiredSettings(
  connection: AgentConnectionProfile,
  catalog: BackendCatalog,
  defaults: GrokConnectionModuleConfiguration["defaults"] | undefined,
  modelPolicy: CompiledBackendModelPolicy,
): GrokDesiredSettings {
  return resolveDesiredSettings(connection, catalog, defaults, modelPolicy);
}

function resolveDesiredSettings(
  connection: AgentConnectionProfile,
  catalog: BackendCatalog,
  defaults: GrokConnectionModuleConfiguration["defaults"] | undefined,
  modelPolicy: CompiledBackendModelPolicy,
): GrokDesiredSettings {
  if (!defaults) throw unavailableSettings();
  const models = catalog.models.filter(
    ({ provider }) => provider === connection.id,
  );
  const fixedModelId =
    defaults.model.type === "fixed" ? defaults.model.modelId : undefined;
  const model = fixedModelId
    ? models.find(({ id }) => id === fixedModelId)
    : models.find(({ isDefault }) => isDefault === true);
  if (!model) throw unavailableSettings();
  const efforts = model.supportedReasoningEfforts ?? [];
  const effort =
    defaults.reasoningEffort.type === "fixed"
      ? defaults.reasoningEffort.effortId
      : model.defaultReasoningEffort;
  if (efforts.length > 0 && (!effort || !efforts.includes(effort))) {
    throw unavailableSettings();
  }
  if (efforts.length === 0 && defaults.reasoningEffort.type === "fixed") {
    throw unavailableSettings();
  }
  if (!effort) throw unavailableSettings();
  if (
    !modelPolicy.isSelectionAllowed({
      modelId: model.id,
      reasoningEffort: effort,
    })
  ) {
    throw unavailableSettings();
  }
  return Object.freeze({ model: model.id, effort });
}

function targetMismatch(): DomainError {
  return new DomainError(
    "conflict",
    "The Grok connection does not match the thread target.",
  );
}

function unavailableSettings(): DomainError {
  return new DomainError(
    "invalid_transition",
    "Choose an available Grok model and effort before starting this thread.",
  );
}

function unsupportedFork(): DomainError {
  return new DomainError(
    "invalid_transition",
    "Grok conversation branching is not supported.",
  );
}
