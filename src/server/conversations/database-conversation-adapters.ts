import type Database from "better-sqlite3";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
  ConversationBinding,
  ConversationBackendDriver,
} from "../backends/contracts.js";
import type { AgentBackendRegistry } from "../backends/registry.js";
import type { ConversationBindingRepository } from "../db/repositories/conversation-binding-repository.js";
import type { ConversationCreationRepository } from "../db/repositories/conversation-creation-repository.js";
import type { ConversationOperationRepository } from "../db/repositories/conversation-operation-repository.js";
import type { QueuedInputRepository } from "../db/repositories/queued-input-repository.js";
import { InventoryRepository } from "../db/repositories/inventory-repository.js";
import { DomainError } from "../domain/errors.js";
import type {
  ExecutionEnvironmentProvider,
  ValidatedWorkspace,
} from "../execution/contracts.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { environmentAdmitsForegroundOperation } from "../domain/environment-operational-state.js";
import { boundDisplayText, DEFAULT_PAYLOAD_LIMITS } from "./payload-policy.js";
import { projectQueuedInputSummaries } from "./queued-input-projection.js";
import type { AcquireConversationActorInput } from "./conversation-actor-manager.js";
import type {
  ConversationLifecycleTargetResolver,
  ResolvedLifecycleTarget,
} from "./conversation-lifecycle-service.js";
import type { QueuedInputActorTargetResolver } from "./queued-input-conversation-gateway.js";
import type {
  ThreadApplicationActorTargetResolver,
  ThreadApplicationQueueReader,
  ThreadApplicationRecoveryReader,
} from "./thread-application-service.js";
import type { WorkspaceApplicationPublication } from "../application/workspace-application-service.js";

const RECOVERY_PROMPT_PREVIEW_LIMITS = {
  ...DEFAULT_PAYLOAD_LIMITS,
  maximumDisplayTextBytes: 240,
};

type ThreadTargetRow = {
  readonly title: string;
  readonly workspaceId: string;
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly executionEnvironmentId: string;
  readonly backingState: "unbound" | "creating" | "bound" | "creation_unknown";
};

type WorkspaceRow = {
  readonly id: string;
  readonly environmentId: string;
  readonly canonicalPath: string;
  readonly displayName: string;
  readonly availability: "available" | "unavailable";
  readonly trustState: "trusted" | "untrusted";
  readonly revision: number;
  readonly authorityRevision: number;
  readonly environmentConfigurationRevision: number;
};

export interface BackendBindingDetailReader {
  getBindingDetail(
    scope: RequestScope,
    applicationThreadId: string,
  ): string | undefined;
}

export interface DatabasePresentationTarget {
  readonly backend: AgentBackendInstance;
  readonly connection: AgentConnectionProfile;
  readonly workspace?: ValidatedWorkspace;
  readonly driver?: ConversationBackendDriver;
}

function backendInstance(
  database: Database.Database,
  scope: RequestScope,
  backendInstanceId: string,
): AgentBackendInstance {
  const row = database
    .prepare(
      `
        SELECT id, tenant_id AS tenantId, kind, label, enabled,
          configuration_revision AS configurationRevision,
          protocol_release AS protocolRelease
        FROM agent_backend_instances
        WHERE tenant_id = ? AND id = ?
      `,
    )
    .get(scope.tenantId, backendInstanceId) as
    | (Omit<AgentBackendInstance, "enabled"> & { readonly enabled: 0 | 1 })
    | undefined;
  if (!row) {
    throw new DomainError("not_found", "The backend instance was not found.");
  }
  return { ...row, enabled: row.enabled === 1 };
}

function connectionProfile(
  database: Database.Database,
  scope: RequestScope,
  connectionProfileId: string,
): AgentConnectionProfile {
  const row = database
    .prepare(
      `
        SELECT id, tenant_id AS tenantId,
          owner_principal_id AS ownerPrincipalId, template_id AS templateId,
          kind, backend_instance_id AS backendInstanceId,
          execution_environment_id AS executionEnvironmentId, label, enabled,
          configuration_revision AS configurationRevision
        FROM agent_connection_profiles
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
      `,
    )
    .get(scope.tenantId, scope.principalId, connectionProfileId) as
    | (Omit<AgentConnectionProfile, "enabled"> & { readonly enabled: 0 | 1 })
    | undefined;
  if (!row) {
    throw new DomainError(
      "not_found",
      "The backend connection profile was not found.",
    );
  }
  return { ...row, enabled: row.enabled === 1 };
}

function threadTarget(
  database: Database.Database,
  scope: RequestScope,
  applicationThreadId: string,
): ThreadTargetRow {
  const row = database
    .prepare(
      `
        SELECT title, workspace_id AS workspaceId,
          backend_instance_id AS backendInstanceId,
          connection_profile_id AS connectionProfileId,
          environment_id AS executionEnvironmentId,
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

function workspaceRow(
  database: Database.Database,
  scope: RequestScope,
  workspaceId: string,
  environmentId: string,
): WorkspaceRow {
  const row = database
    .prepare(
      `
        SELECT workspace.id, workspace.environment_id AS environmentId,
          workspace.canonical_path AS canonicalPath,
          workspace.display_name AS displayName,
          workspace.availability, workspace.trust_state AS trustState,
          workspace.revision,
          workspace.environment_configuration_revision AS authorityRevision,
          environment.configuration_revision AS environmentConfigurationRevision
        FROM workspaces AS workspace
        JOIN execution_environments AS environment
          ON environment.tenant_id = workspace.tenant_id
          AND environment.owner_principal_id = workspace.owner_principal_id
          AND environment.id = workspace.environment_id
        WHERE workspace.tenant_id = ? AND workspace.owner_principal_id = ?
          AND workspace.environment_id = ? AND workspace.id = ?
      `,
    )
    .get(scope.tenantId, scope.principalId, environmentId, workspaceId) as
    WorkspaceRow | undefined;
  if (!row) {
    throw new DomainError("not_found", "The thread workspace was not found.");
  }
  return row;
}

function bindingRecord(
  repository: ConversationBindingRepository,
  scope: RequestScope,
  applicationThreadId: string,
): ConversationBinding {
  const binding = repository.getBinding(scope, applicationThreadId);
  if (!binding) {
    throw new DomainError(
      "invalid_transition",
      "The thread does not have a backend conversation binding.",
    );
  }
  return {
    ...binding,
    createdAt: new Date(binding.createdAt).toISOString(),
  };
}

/**
 * Shared database-backed target loader. It owns no backend-specific parsing:
 * opaque detail is obtained verbatim from the registered backend persistence
 * boundary and is passed directly to the selected driver.
 */
export class DatabaseConversationTargetStore {
  readonly #database: Database.Database;
  readonly #bindings: ConversationBindingRepository;
  readonly #bindingDetails: ReadonlyMap<string, BackendBindingDetailReader>;
  readonly #registry: AgentBackendRegistry;
  readonly #environments: ExecutionEnvironmentProvider;
  readonly #inventory: InventoryRepository;
  readonly #now: () => number;
  #workspacePublications?: WorkspaceApplicationPublication;

  constructor(input: {
    readonly database: Database.Database;
    readonly bindings: ConversationBindingRepository;
    readonly bindingDetails: ReadonlyMap<string, BackendBindingDetailReader>;
    readonly registry: AgentBackendRegistry;
    readonly environments: ExecutionEnvironmentProvider;
    readonly now?: () => number;
  }) {
    if (input.bindings.database !== input.database) {
      throw new Error("conversation_target_database_mismatch");
    }
    this.#database = input.database;
    this.#bindings = input.bindings;
    this.#bindingDetails = input.bindingDetails;
    this.#registry = input.registry;
    this.#environments = input.environments;
    this.#inventory = new InventoryRepository(input.database);
    this.#now = input.now ?? Date.now;
  }

  bindWorkspacePublications(
    publications: WorkspaceApplicationPublication,
  ): void {
    if (this.#workspacePublications) {
      throw new Error(
        "conversation_target_workspace_publications_already_bound",
      );
    }
    this.#workspacePublications = publications;
  }

  async lifecycle(
    scope: RequestScope,
    input: {
      readonly connectionProfileId: string;
      readonly workspaceId: string;
      readonly title?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<ResolvedLifecycleTarget> {
    this.#inventory.assertWorkspaceActive(scope, input.workspaceId);
    const connection = connectionProfile(
      this.#database,
      scope,
      input.connectionProfileId,
    );
    const backend = backendInstance(
      this.#database,
      scope,
      connection.backendInstanceId,
    );
    if (!backend.enabled || !connection.enabled) {
      throw new DomainError(
        "invalid_transition",
        "The selected backend connection is disabled.",
      );
    }
    const workspace = await this.#revalidateWorkspace(
      scope,
      this.#durableWorkspace(
        scope,
        input.workspaceId,
        connection.executionEnvironmentId,
      ),
      input.signal,
    );
    // Resolve the driver now so missing, stale, or incompatible registry
    // state fails before a lifecycle mutation crosses an external boundary.
    const driver = this.#registry.driver(connection);
    if (
      driver.instance.id !== backend.id ||
      driver.instance.tenantId !== backend.tenantId ||
      driver.instance.kind !== backend.kind ||
      driver.instance.enabled !== backend.enabled ||
      driver.instance.configurationRevision !== backend.configurationRevision ||
      driver.instance.protocolRelease !== backend.protocolRelease
    ) {
      throw new DomainError(
        "conflict",
        "The registered backend instance does not match durable configuration.",
      );
    }
    return {
      connection,
      workspace,
      ...(input.title ? { title: input.title } : {}),
    };
  }

  async discovery(
    scope: RequestScope,
    input: {
      readonly connectionProfileId: string;
      readonly workspaceId: string;
    },
  ): Promise<{
    readonly connection: AgentConnectionProfile;
    readonly workspace: ValidatedWorkspace;
    readonly driver: ConversationBackendDriver;
  }> {
    const resolved = await this.lifecycle(scope, input);
    return {
      connection: resolved.connection,
      workspace: resolved.workspace,
      driver: this.#registry.driver(resolved.connection),
    };
  }

  driverForConnection(
    connection: AgentConnectionProfile,
  ): ConversationBackendDriver {
    return this.#registry.driver(connection);
  }

  assertThreadWorkspaceActive(
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    const target = threadTarget(this.#database, scope, applicationThreadId);
    this.#inventory.assertWorkspaceActive(scope, target.workspaceId);
  }

  async actor(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<AcquireConversationActorInput> {
    const target = threadTarget(this.#database, scope, applicationThreadId);
    if (target.backingState !== "bound") {
      throw new DomainError(
        "invalid_transition",
        "Only a bound thread can acquire a conversation actor.",
      );
    }
    const connection = connectionProfile(
      this.#database,
      scope,
      target.connectionProfileId,
    );
    const backend = backendInstance(
      this.#database,
      scope,
      target.backendInstanceId,
    );
    if (!backend.enabled || !connection.enabled) {
      throw new DomainError(
        "invalid_transition",
        "The selected backend connection is disabled.",
      );
    }
    const workspace = this.#durableWorkspace(
      scope,
      target.workspaceId,
      target.executionEnvironmentId,
    );
    const driver = this.#registry.driver(connection);
    if (
      driver.instance.id !== backend.id ||
      driver.instance.tenantId !== backend.tenantId ||
      driver.instance.kind !== backend.kind ||
      driver.instance.enabled !== backend.enabled ||
      driver.instance.configurationRevision !== backend.configurationRevision ||
      driver.instance.protocolRelease !== backend.protocolRelease
    ) {
      throw new DomainError(
        "conflict",
        "The registered backend instance does not match durable configuration.",
      );
    }
    if (
      connection.backendInstanceId !== target.backendInstanceId ||
      connection.executionEnvironmentId !== target.executionEnvironmentId
    ) {
      throw new DomainError(
        "conflict",
        "The thread target no longer matches its connection profile.",
      );
    }
    const opaqueBindingDetail = this.#bindingDetails
      .get(connection.backendInstanceId)
      ?.getBindingDetail(scope, applicationThreadId);
    if (opaqueBindingDetail === undefined) {
      throw new DomainError(
        "conflict",
        "The bound thread is missing backend binding detail.",
      );
    }
    return {
      scope,
      binding: bindingRecord(this.#bindings, scope, applicationThreadId),
      workspace,
      opaqueBindingDetail,
      driver,
    };
  }

  async lifecycleForThread(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ResolvedLifecycleTarget> {
    const target = threadTarget(this.#database, scope, applicationThreadId);
    return this.lifecycle(scope, {
      connectionProfileId: target.connectionProfileId,
      workspaceId: target.workspaceId,
      title: target.title,
    });
  }

  async presentationForThread(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<DatabasePresentationTarget> {
    const target = threadTarget(this.#database, scope, applicationThreadId);
    const connection = connectionProfile(
      this.#database,
      scope,
      target.connectionProfileId,
    );
    const backend = backendInstance(
      this.#database,
      scope,
      target.backendInstanceId,
    );
    const availability = this.#database
      .prepare(
        `
          SELECT thread.availability AS threadAvailability,
            workspace.availability AS workspaceAvailability,
            environment.availability AS environmentAvailability,
            environment.diagnostic_code AS environmentDiagnosticCode
          FROM application_threads AS thread
          JOIN workspaces AS workspace
            ON workspace.tenant_id = thread.tenant_id
            AND workspace.owner_principal_id = thread.owner_principal_id
            AND workspace.environment_id = thread.environment_id
            AND workspace.id = thread.workspace_id
          JOIN execution_environments AS environment
            ON environment.tenant_id = thread.tenant_id
            AND environment.owner_principal_id = thread.owner_principal_id
            AND environment.id = thread.environment_id
          WHERE thread.tenant_id = ? AND thread.owner_principal_id = ?
            AND thread.id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as {
      readonly threadAvailability: string;
      readonly workspaceAvailability: string;
      readonly environmentAvailability: "available" | "unavailable";
      readonly environmentDiagnosticCode: string | null;
    };
    if (
      !backend.enabled ||
      !connection.enabled ||
      availability.threadAvailability !== "available" ||
      availability.workspaceAvailability !== "available" ||
      !environmentAdmitsForegroundOperation({
        availability: availability.environmentAvailability,
        diagnosticCode: availability.environmentDiagnosticCode,
      })
    ) {
      return { backend, connection };
    }
    try {
      const workspace = this.#durableWorkspace(
        scope,
        target.workspaceId,
        target.executionEnvironmentId,
        true,
      );
      const driver = this.#registry.driver(connection);
      return { backend, connection, workspace, driver };
    } catch {
      return { backend, connection };
    }
  }

  #durableWorkspace(
    scope: RequestScope,
    workspaceId: string,
    environmentId: string,
    requireCurrentAuthority = false,
  ): ValidatedWorkspace {
    const row = workspaceRow(this.#database, scope, workspaceId, environmentId);
    if (
      requireCurrentAuthority &&
      row.authorityRevision !== row.environmentConfigurationRevision
    ) {
      throw new DomainError(
        "conflict",
        "The workspace authority is stale for its execution environment.",
      );
    }
    return {
      canonicalPath: row.canonicalPath,
      authorityRevision: row.authorityRevision,
      summary: {
        id: row.id,
        environmentId: row.environmentId,
        displayName: row.displayName,
        displayPath: row.canonicalPath,
        availability: row.availability,
        trustState: row.trustState,
        revision: row.revision,
      },
    };
  }

  async #revalidateWorkspace(
    scope: RequestScope,
    workspace: ValidatedWorkspace,
    signal?: AbortSignal,
  ): Promise<ValidatedWorkspace> {
    const publications = this.#workspacePublications;
    if (!publications) {
      throw new Error("conversation_target_workspace_publications_unbound");
    }
    signal?.throwIfAborted();
    const revalidated = await this.#environments.revalidateWorkspace(
      scope,
      workspace,
    );
    signal?.throwIfAborted();
    this.#inventory.assertWorkspaceActive(scope, workspace.summary.id);
    if (
      revalidated.summary.id !== workspace.summary.id ||
      revalidated.summary.environmentId !== workspace.summary.environmentId ||
      revalidated.canonicalPath !== workspace.canonicalPath
    ) {
      throw new DomainError(
        "conflict",
        "The validated workspace identity changed.",
      );
    }
    const persisted = this.#inventory.upsertWorkspace(scope, {
      id: revalidated.summary.id,
      environmentId: revalidated.summary.environmentId,
      canonicalPath: revalidated.canonicalPath,
      displayName: revalidated.summary.displayName,
      available: revalidated.summary.availability === "available",
      trustState: revalidated.summary.trustState,
      environmentConfigurationRevision: revalidated.authorityRevision,
      now: this.#now(),
    });
    if (persisted.revision !== workspace.summary.revision) {
      publications.handoffAuthoritativeReplacement(scope);
    }
    return {
      canonicalPath: persisted.canonicalPath,
      authorityRevision: persisted.environmentConfigurationRevision,
      summary: {
        id: persisted.id,
        environmentId: persisted.environmentId,
        displayName: persisted.displayName,
        displayPath: persisted.canonicalPath,
        availability: persisted.availability,
        trustState: persisted.trustState,
        revision: persisted.revision,
      },
    };
  }
}

export class DatabaseLifecycleTargetResolver implements ConversationLifecycleTargetResolver {
  constructor(readonly targets: DatabaseConversationTargetStore) {}

  resolveNew(
    scope: RequestScope,
    input: {
      readonly connectionProfileId: string;
      readonly workspaceId: string;
    },
    signal?: AbortSignal,
  ): Promise<ResolvedLifecycleTarget> {
    return this.targets.lifecycle(scope, { ...input, signal });
  }

  resolve(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<ResolvedLifecycleTarget> {
    return this.targets.lifecycleForThread(scope, applicationThreadId);
  }
}

export class DatabaseActorTargetResolver
  implements
    QueuedInputActorTargetResolver,
    ThreadApplicationActorTargetResolver
{
  constructor(readonly targets: DatabaseConversationTargetStore) {}

  resolve(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<AcquireConversationActorInput> {
    return this.targets.actor(scope, applicationThreadId);
  }
}

export class DatabaseThreadApplicationQueueReader implements ThreadApplicationQueueReader {
  constructor(readonly queue: QueuedInputRepository) {}

  async list(scope: RequestScope, applicationThreadId: string) {
    return projectQueuedInputSummaries(
      this.queue.list(scope, applicationThreadId),
    );
  }
}

export class DatabaseThreadApplicationRecoveryReader implements ThreadApplicationRecoveryReader {
  readonly creation: ConversationCreationRepository;
  readonly operations: ConversationOperationRepository;
  readonly targets: ConversationLifecycleTargetResolver;
  readonly registry: AgentBackendRegistry;
  readonly forks: {
    readRecovery(
      scope: RequestScope,
      childThreadId: string,
    ): Promise<{ readonly recoverable: boolean }>;
  };

  constructor(input: {
    readonly creation: ConversationCreationRepository;
    readonly operations: ConversationOperationRepository;
    readonly targets: ConversationLifecycleTargetResolver;
    readonly registry: AgentBackendRegistry;
    readonly forks: {
      readRecovery(
        scope: RequestScope,
        childThreadId: string,
      ): Promise<{ readonly recoverable: boolean }>;
    };
  }) {
    if (input.creation.database !== input.operations.database) {
      throw new Error("thread_recovery_database_mismatch");
    }
    this.creation = input.creation;
    this.operations = input.operations;
    this.targets = input.targets;
    this.registry = input.registry;
    this.forks = input.forks;
  }

  async read(scope: RequestScope, applicationThreadId: string) {
    const attempt = this.creation.findActiveForThread(
      scope,
      applicationThreadId,
    );
    if (attempt && attempt.phase !== "bound") {
      if (attempt.creationKind === "fork") {
        const { recoverable } = await this.forks.readRecovery(
          scope,
          applicationThreadId,
        );
        return {
          kind: "conversation_creation" as const,
          creationType: "fork" as const,
          phase: attempt.phase,
          diagnostic: boundDisplayText(
            attempt.diagnostic ?? "Fork creation is awaiting recovery.",
          ),
          submissionMayHaveBeenAccepted:
            attempt.forkUncertaintyKind === "fork_unknown",
          forkUncertainty: attempt.forkUncertaintyKind,
          possibleProviderOrphan:
            attempt.forkUncertaintyKind === "fork_unknown"
              ? ("full_native_copy" as const)
              : null,
          recoverable,
        };
      }
      const possibleAcceptance =
        attempt.phase === "first_submission_started" ||
        attempt.phase === "accepted_unpersisted" ||
        (attempt.phase === "recovery_required" &&
          (attempt.retryAnchor !== null ||
            attempt.backendCorrelation !== null ||
            attempt.acceptedAt !== null));
      const createOutcomeUnknown =
        attempt.provisionalBackendConversationId === null &&
        (attempt.phase === "external_call_started" ||
          attempt.phase === "recovery_required");
      const recoverable = createOutcomeUnknown
        ? this.registry.creationIdentity(
            (await this.targets.resolve(scope, applicationThreadId)).connection,
          ).createReplay === "idempotent"
        : true;
      return {
        kind: "conversation_creation" as const,
        creationType: "first_input" as const,
        phase: attempt.phase,
        diagnostic: boundDisplayText(
          attempt.diagnostic ??
            (possibleAcceptance
              ? "Submission recovery requires confirmation."
              : "Conversation creation is in progress."),
        ),
        ...(attempt.initialInputText
          ? {
              promptPreview: boundDisplayText(
                attempt.initialInputText,
                RECOVERY_PROMPT_PREVIEW_LIMITS,
              ),
            }
          : {}),
        submissionMayHaveBeenAccepted: possibleAcceptance,
        forkUncertainty: null,
        possibleProviderOrphan: null,
        recoverable,
      };
    }
    const operation = this.operations.findUncertainThreadOperation(
      scope,
      applicationThreadId,
    );
    if (!operation) return undefined;
    return {
      kind: "operation_uncertain" as const,
      operationCategory: operation.category,
      diagnostic: boundDisplayText(operation.diagnostic),
      submissionMayHaveBeenAccepted: operation.submissionMayHaveBeenAccepted,
      recoverable: true,
    };
  }

  async hasPendingDelivery(
    scope: RequestScope,
    applicationThreadId: string,
  ): Promise<boolean> {
    return this.operations.hasPendingMaterializationSteer(
      scope,
      applicationThreadId,
    );
  }
}
