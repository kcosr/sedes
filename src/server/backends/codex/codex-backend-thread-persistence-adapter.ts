import type Database from "better-sqlite3";
import type { BackendBindingDetailReader } from "../../conversations/database-conversation-adapters.js";
import type { DiscoveredBackendThreadPersistence } from "../../conversations/backend-discovery-service.js";
import type { BackendThreadPersistenceAdapter } from "../../conversations/conversation-lifecycle-service.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  AgentConnectionProfile,
  BackendCatalog,
  BackendModelDescriptor,
  RegisteredBackendActionInput,
} from "../contracts.js";
import type { BackendEffectiveSettings } from "../../../shared/protocol/backend.js";
import {
  parseCodexBindingDetail,
  serializeCodexBindingDetail,
} from "./codex-binding-codec.js";
import type { CodexConnectionModuleConfiguration } from "./codex-backend-configuration.js";
import { CodexThreadExecutionSettingsRepository } from "./codex-thread-execution-settings-repository.js";
import { codexForkSettingsEligibility } from "./codex-fork-settings-eligibility.js";
import {
  isCodexExecutionPolicyAllowed,
  type CodexExecutionPolicyAllowlist,
} from "./codex-execution-policy.js";
import type {
  CodexExecutionSettingsTuple,
  CodexThreadExecutionSettingsRecord,
} from "./codex-thread-execution-settings-repository.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";

type ThreadTargetRow = {
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly workspaceId: string;
  readonly title: string;
};

type BoundTargetRow = ThreadTargetRow & {
  readonly backendConversationId: string;
  readonly backendKind: string;
  readonly connectionKind: string;
};

export interface CodexBindingDetailRecord {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly applicationThreadId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly backendConversationId: string;
  readonly opaqueBindingDetail: string;
}

function resolveDefaultModel(
  connection: AgentConnectionProfile,
  selection: CodexConnectionModuleConfiguration["defaults"]["model"],
  catalog: BackendCatalog,
): (BackendModelDescriptor & {
  readonly defaultReasoningEffort: string;
}) | null {
  const candidates =
    selection.type === "fixed"
      ? catalog.models.filter(({ id }) => id === selection.modelId)
      : catalog.models.filter(({ isDefault }) => isDefault === true);
  if (candidates.length !== 1) {
    return null;
  }
  const model = candidates[0]!;
  const efforts = model.supportedReasoningEfforts;
  if (
    model.provider !== connection.id ||
    model.id.length < 1 ||
    model.id.length > 120 ||
    !efforts ||
    efforts.length === 0 ||
    new Set(efforts).size !== efforts.length ||
    efforts.some((effort) => effort.length < 1 || effort.length > 120) ||
    (model.defaultReasoningEffort !== undefined &&
      !efforts.includes(model.defaultReasoningEffort))
  ) {
    throw new DomainError(
      "conflict",
      "The Codex model reasoning defaults are invalid.",
    );
  }
  if (!model.defaultReasoningEffort) return null;
  return model as BackendModelDescriptor & {
    readonly defaultReasoningEffort: string;
  };
}

/**
 * Codex native identity remains in the common binding. This adapter also owns
 * the atomic initialization boundary for provider-specific execution settings:
 * drafts receive validated defaults while imported threads remain unresolved
 * until an authoritative native observation is available.
 */
export class CodexBackendThreadPersistenceAdapter
  implements
    BackendThreadPersistenceAdapter,
    BackendBindingDetailReader,
    DiscoveredBackendThreadPersistence
{
  readonly database: Database.Database;
  readonly #scope: RequestScope;
  readonly #backendInstanceId: string;
  readonly #executionSettings: CodexThreadExecutionSettingsRepository;
  readonly #executionPolicy: CodexExecutionPolicyAllowlist;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #resolveConnectionDefaults: (
    connection: AgentConnectionProfile,
  ) => CodexConnectionModuleConfiguration["defaults"] | undefined;
  readonly #now: () => number;

  constructor(input: {
    readonly database: Database.Database;
    readonly scope: RequestScope;
    readonly backendInstanceId: string;
    readonly executionSettings: CodexThreadExecutionSettingsRepository;
    readonly executionPolicy: CodexExecutionPolicyAllowlist;
    readonly modelPolicy: CompiledBackendModelPolicy;
    readonly resolveConnectionDefaults: (
      connection: AgentConnectionProfile,
    ) => CodexConnectionModuleConfiguration["defaults"] | undefined;
    readonly now?: () => number;
  }) {
    if (
      !input.scope.tenantId ||
      !input.scope.principalId ||
      !input.backendInstanceId ||
      !(
        input.executionSettings instanceof
        CodexThreadExecutionSettingsRepository
      ) ||
      input.executionSettings.database !== input.database ||
      !input.executionPolicy ||
      typeof input.resolveConnectionDefaults !== "function"
    ) {
      throw new Error("codex_persistence_scope_invalid");
    }
    this.database = input.database;
    this.#scope = Object.freeze({ ...input.scope });
    this.#backendInstanceId = input.backendInstanceId;
    this.#executionSettings = input.executionSettings;
    this.#executionPolicy = input.executionPolicy;
    this.#modelPolicy = input.modelPolicy;
    this.#resolveConnectionDefaults = input.resolveConnectionDefaults;
    this.#now = input.now ?? Date.now;
  }

  initializeThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): void {
    this.#assertThreadConnection(scope, applicationThreadId, connection);
    this.#executionSettings.initialize(scope, {
      applicationThreadId,
      desired: null,
      now: this.#now(),
    });
  }

  initializeForkThread(
    scope: RequestScope,
    sourceApplicationThreadId: string,
    childApplicationThreadId: string,
    connection: AgentConnectionProfile,
    effectiveSettings: BackendEffectiveSettings,
  ): void {
    this.#assertThreadConnection(scope, sourceApplicationThreadId, connection);
    this.#assertThreadConnection(scope, childApplicationThreadId, connection);
    const eligibility = codexForkSettingsEligibility(
      this.#executionSettings.find(scope, sourceApplicationThreadId),
      this.#executionPolicy,
    );
    if (
      eligibility.availability !== "available" ||
      (eligibility.availability === "available" &&
        !this.#modelPolicy.isSelectionAllowed({
          modelId: eligibility.settings.model,
          reasoningEffort: eligibility.settings.reasoningEffort,
        })) ||
      effectiveSettings.model?.provider !== connection.id ||
      effectiveSettings.model.id !== eligibility.settings.model ||
      effectiveSettings.thinkingLevel !== eligibility.settings.reasoningEffort
    ) {
      throw new DomainError(
        "conflict",
        "The source Codex effective execution settings are not authoritatively confirmed.",
      );
    }
    const inherited = eligibility.settings;
    const child = this.#executionSettings.initialize(scope, {
      applicationThreadId: childApplicationThreadId,
      desired: inherited,
      now: this.#now(),
    });
    if (
      !child.desired ||
      JSON.stringify(child.desired) !== JSON.stringify(inherited)
    ) {
      throw new DomainError(
        "conflict",
        "The Codex fork settings do not match the source snapshot.",
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
      throw this.#targetMismatch();
    }
    const settings = this.#executionSettings.find(
      scope,
      childApplicationThreadId,
    )?.desired;
    if (!settings) {
      throw new DomainError(
        "conflict",
        "The Codex fork settings are not resolved.",
      );
    }
    return {
      model: {
        provider: target.connectionProfileId,
        id: settings.model,
      },
      thinkingLevel: settings.reasoningEffort,
    };
  }

  readDesiredSettings(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): CodexThreadExecutionSettingsRecord {
    this.#assertThreadConnection(scope, applicationThreadId, connection);
    const settings = this.#executionSettings.find(
      scope,
      applicationThreadId,
    );
    if (!settings) {
      throw new DomainError(
        "not_found",
        "The Codex thread execution settings were not found.",
      );
    }
    return settings;
  }

  #assertThreadConnection(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
  ): void {
    this.#assertScope(scope);
    if (
      connection.kind !== "codex_app_server" ||
      connection.tenantId !== scope.tenantId ||
      connection.ownerPrincipalId !== scope.principalId ||
      connection.backendInstanceId !== this.#backendInstanceId
    ) {
      throw this.#targetMismatch();
    }
    const target = this.#threadTarget(scope, applicationThreadId);
    if (
      target.backendInstanceId !== connection.backendInstanceId ||
      target.connectionProfileId !== connection.id ||
      target.executionEnvironmentId !== connection.executionEnvironmentId
    ) {
      throw this.#targetMismatch();
    }
  }

  initializeNewThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
    catalog: BackendCatalog,
  ): void {
    this.#assertThreadConnection(scope, applicationThreadId, connection);
    const defaults = this.#resolveConnectionDefaults(connection);
    if (!defaults) throw this.#targetMismatch();
    const model = resolveDefaultModel(connection, defaults.model, catalog);
    if (!model) {
      this.#executionSettings.initialize(scope, {
        applicationThreadId,
        desired: null,
        now: this.#now(),
      });
      return;
    }
    this.initializeResolvedNewThread(scope, applicationThreadId, connection, {
      model: model.id,
      reasoningEffort: model.defaultReasoningEffort!,
      serviceTier: model.fastMode?.defaultSelection ?? "standard",
      sandboxMode: defaults.sandboxMode,
      networkAccess: defaults.networkAccess,
      approvalPolicy: defaults.approvalPolicy,
      approvalReviewer: defaults.approvalReviewer,
    });
  }

  /**
   * Persists one already-resolved complete tuple inside the caller-owned
   * creation transaction. This method performs no provider or configuration
   * I/O and never mutates connection defaults.
   */
  initializeResolvedNewThread(
    scope: RequestScope,
    applicationThreadId: string,
    connection: AgentConnectionProfile,
    resolved: CodexExecutionSettingsTuple,
  ): void {
    this.#assertThreadConnection(scope, applicationThreadId, connection);
    if (
      !isCodexExecutionPolicyAllowed(resolved, this.#executionPolicy) ||
      !this.#modelPolicy.isSelectionAllowed({
        modelId: resolved.model,
        reasoningEffort: resolved.reasoningEffort,
      })
    ) {
      throw new DomainError(
        "conflict",
        "The selected Codex execution policy is unavailable on this target.",
      );
    }
    this.#executionSettings.initialize(scope, {
      applicationThreadId,
      desired: resolved,
      now: this.#now(),
    });
  }

  validateInitialization(
    scope: RequestScope,
    applicationThreadId: string,
    _catalog: BackendCatalog,
  ): void {
    this.#assertScope(scope);
    const target = this.#threadTarget(scope, applicationThreadId);
    if (target.backendInstanceId !== this.#backendInstanceId) {
      throw this.#targetMismatch();
    }
    if (!this.#executionSettings.find(scope, applicationThreadId)) {
      throw new DomainError(
        "conflict",
        "The Codex thread execution settings are not initialized.",
      );
    }
  }

  initializationActions(
    scope: RequestScope,
    applicationThreadId: string,
    attemptId: string,
  ): readonly RegisteredBackendActionInput[] {
    this.#assertScope(scope);
    const target = this.#threadTarget(scope, applicationThreadId);
    return [
      {
        applicationOperationId: `${attemptId}:initial-title`,
        action: "rename",
        title: target.title,
      },
    ];
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
      input.applicationOperationId.length === 0 ||
      input.mutationId.length === 0 ||
      input.reconciliationToken.length === 0
    ) {
      throw new DomainError(
        "conflict",
        "Codex submission identities must not be empty.",
      );
    }
    // The common creation transaction moves the attempt to
    // first_submission_started with its retry anchor immediately after this
    // validation. Codex needs no provider shadow row: that phase/anchor pair is
    // the durable evidence that turn/start may have crossed its boundary.
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
          SELECT mutation_id AS mutationId,
            phase, retry_anchor AS retryAnchor
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
  ): CodexBindingDetailRecord {
    this.#assertScope(scope);
    let parsed: ReturnType<typeof parseCodexBindingDetail>;
    try {
      parsed = parseCodexBindingDetail(opaqueBindingDetail);
    } catch (error) {
      throw new DomainError(
        "conflict",
        "The Codex binding detail is invalid.",
        false,
        { cause: error },
      );
    }
    const binding = this.#boundTarget(scope, applicationThreadId);
    this.#assertCodexBinding(binding);
    if (parsed.threadId !== binding.backendConversationId) {
      throw new DomainError(
        "conflict",
        "The Codex binding detail does not match the native thread.",
      );
    }
    if (
      parsed.nativeAncestry !== null &&
      parsed.correlationAncestorThreadIds.length === 1
    ) {
      const parentRow = this.database
        .prepare(
          `
            SELECT detail.opaque_binding_detail AS opaqueBindingDetail
            FROM conversation_bindings AS parent_binding
            JOIN application_threads AS parent_thread
              ON parent_thread.tenant_id = parent_binding.tenant_id
              AND parent_thread.owner_principal_id = parent_binding.owner_principal_id
              AND parent_thread.id = parent_binding.application_thread_id
            JOIN codex_binding_details AS detail
              ON detail.tenant_id = parent_binding.tenant_id
              AND detail.owner_principal_id = parent_binding.owner_principal_id
              AND detail.application_thread_id = parent_binding.application_thread_id
              AND detail.backend_instance_id = parent_binding.backend_instance_id
              AND detail.connection_profile_id = parent_binding.connection_profile_id
              AND detail.execution_environment_id = parent_binding.execution_environment_id
            WHERE parent_binding.tenant_id = ?
              AND parent_binding.owner_principal_id = ?
              AND parent_binding.backend_instance_id = ?
              AND parent_binding.connection_profile_id = ?
              AND parent_binding.execution_environment_id = ?
              AND parent_binding.backend_conversation_id = ?
              AND parent_thread.workspace_id = ?
          `,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          binding.backendInstanceId,
          binding.connectionProfileId,
          binding.executionEnvironmentId,
          parsed.nativeAncestry.forkedFromThreadId,
          binding.workspaceId,
        ) as { readonly opaqueBindingDetail: string } | undefined;
      if (parentRow) {
        const parent = parseCodexBindingDetail(parentRow.opaqueBindingDetail);
        const ancestors = [
          ...parent.correlationAncestorThreadIds,
          parent.threadId,
        ];
        if (
          ancestors.length <= 100 &&
          !ancestors.includes(parsed.threadId) &&
          new Set(ancestors).size === ancestors.length
        ) {
          parsed = {
            ...parsed,
            correlationAncestorThreadIds: ancestors,
          };
        }
      }
    }
    const existingRow = this.database
      .prepare(
        `
          SELECT opaque_binding_detail AS opaqueBindingDetail
          FROM codex_binding_details
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      { readonly opaqueBindingDetail: string } | undefined;
    const existing = existingRow
      ? parseCodexBindingDetail(existingRow.opaqueBindingDetail)
      : undefined;
    const ancestorChainsCompatible = existing
      ? (() => {
          const left = existing.correlationAncestorThreadIds;
          const right = parsed.correlationAncestorThreadIds;
          const [shorter, longer] =
            left.length <= right.length ? [left, right] : [right, left];
          return shorter.every(
            (threadId, index) =>
              threadId === longer[longer.length - shorter.length + index],
          );
        })()
      : true;
    const bindingEvidenceChanged =
      existing !== undefined &&
      (existing.threadId !== parsed.threadId ||
        (existing.sessionId !== null &&
          parsed.sessionId !== null &&
          existing.sessionId !== parsed.sessionId) ||
        !ancestorChainsCompatible ||
        (existing.nativeAncestry !== null &&
          parsed.nativeAncestry !== null &&
          (existing.nativeAncestry.forkedFromThreadId !==
            parsed.nativeAncestry.forkedFromThreadId ||
            (existing.nativeAncestry.sourceTurnId !== null &&
              parsed.nativeAncestry.sourceTurnId !== null &&
              existing.nativeAncestry.sourceTurnId !==
                parsed.nativeAncestry.sourceTurnId))));
    if (bindingEvidenceChanged) {
      throw new DomainError(
        "conflict",
        "The Codex native binding evidence changed.",
      );
    }
    const merged = serializeCodexBindingDetail({
      threadId: parsed.threadId,
      sessionId: existing?.sessionId ?? parsed.sessionId,
      correlationAncestorThreadIds:
        existing &&
        existing.correlationAncestorThreadIds.length >=
          parsed.correlationAncestorThreadIds.length
          ? existing.correlationAncestorThreadIds
          : parsed.correlationAncestorThreadIds,
      nativeAncestry:
        existing?.nativeAncestry && parsed.nativeAncestry
          ? {
              forkedFromThreadId: existing.nativeAncestry.forkedFromThreadId,
              sourceTurnId:
                existing.nativeAncestry.sourceTurnId ??
                parsed.nativeAncestry.sourceTurnId,
            }
          : (existing?.nativeAncestry ?? parsed.nativeAncestry),
    });
    this.database
      .prepare(
        `
          INSERT INTO codex_binding_details(
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
        merged,
      );
    return this.#record(scope, applicationThreadId, binding, merged);
  }

  getBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
  ): string | undefined {
    this.#assertScope(scope);
    const binding = this.#findBoundTarget(scope, applicationThreadId);
    if (!binding) return undefined;
    this.#assertCodexBinding(binding);
    const row = this.database
      .prepare(
        `
          SELECT opaque_binding_detail AS opaqueBindingDetail
          FROM codex_binding_details
          WHERE tenant_id = ? AND owner_principal_id = ?
            AND application_thread_id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      { readonly opaqueBindingDetail: string } | undefined;
    if (!row) {
      throw new DomainError(
        "conflict",
        "The Codex native binding detail is missing.",
      );
    }
    const parsed = parseCodexBindingDetail(row.opaqueBindingDetail);
    if (parsed.threadId !== binding.backendConversationId) {
      throw new DomainError(
        "conflict",
        "The Codex native binding detail does not match the conversation.",
      );
    }
    return row.opaqueBindingDetail;
  }

  #record(
    scope: RequestScope,
    applicationThreadId: string,
    binding: BoundTargetRow,
    opaqueBindingDetail: string,
  ): CodexBindingDetailRecord {
    return Object.freeze({
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      applicationThreadId,
      backendInstanceId: binding.backendInstanceId,
      connectionProfileId: binding.connectionProfileId,
      executionEnvironmentId: binding.executionEnvironmentId,
      backendConversationId: binding.backendConversationId,
      opaqueBindingDetail,
    });
  }

  #threadTarget(
    scope: RequestScope,
    applicationThreadId: string,
  ): ThreadTargetRow {
    const target = this.database
      .prepare(
        `
          SELECT backend_instance_id AS backendInstanceId,
            connection_profile_id AS connectionProfileId,
            environment_id AS executionEnvironmentId,
            workspace_id AS workspaceId,
            title
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      ThreadTargetRow | undefined;
    if (!target) {
      throw new DomainError("not_found", "The thread was not found.");
    }
    return target;
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
            thread.workspace_id AS workspaceId,
            thread.title AS title,
            backend.kind AS backendKind,
            profile.kind AS connectionKind
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
    const binding = this.#findBoundTarget(scope, applicationThreadId);
    if (!binding) {
      throw new DomainError(
        "not_found",
        "The conversation binding was not found.",
      );
    }
    return binding;
  }

  #assertCodexBinding(binding: BoundTargetRow): void {
    if (
      binding.backendInstanceId !== this.#backendInstanceId ||
      binding.backendKind !== "codex_app_server" ||
      binding.connectionKind !== "codex_app_server"
    ) {
      throw this.#targetMismatch();
    }
  }

  #assertScope(scope: RequestScope): void {
    if (
      scope.tenantId !== this.#scope.tenantId ||
      scope.principalId !== this.#scope.principalId
    ) {
      throw new DomainError("not_found", "The Codex thread was not found.");
    }
  }

  #targetMismatch(): DomainError {
    return new DomainError(
      "conflict",
      "The Codex connection does not match the thread target.",
    );
  }
}
