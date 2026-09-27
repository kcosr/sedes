import type { BackendThreadPersistenceAdapter } from "../../conversations/conversation-lifecycle-service.js";
import type { BackendBindingDetailReader } from "../../conversations/database-conversation-adapters.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AgentConnectionProfile, BackendCatalog } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { parseOpenCodeBindingDetail } from "./opencode-binding-detail.js";
import type { OpenCodeConnectionDefaults } from "./opencode-backend-configuration.js";
import { assertOpenCodeCatalogPolicy, qualifiedOpenCodeModelId, resolveOpenCodeDefaults, resolveOpenCodeSelection, sameOpenCodeSelection, type OpenCodeSelection } from "./opencode-model-selection.js";
import { OpenCodeThreadRepository } from "./opencode-thread-repository.js";
import { OpenCodeThreadSettingsRepository, type OpenCodeThreadTarget } from "./opencode-thread-settings-repository.js";

/** Persistence only: native configuration and delivery effects remain with the driver. */
export class OpenCodeBackendThreadPersistenceAdapter implements BackendThreadPersistenceAdapter, BackendBindingDetailReader {
  readonly database;
  readonly settings;
  readonly repository;
  readonly #now;
  constructor(readonly input: {
    readonly repository: OpenCodeThreadRepository; readonly settings: OpenCodeThreadSettingsRepository;
    readonly scope: RequestScope; readonly backendInstanceId: string; readonly modelPolicy: CompiledBackendModelPolicy;
    readonly resolveConnectionDefaults: (connection: AgentConnectionProfile) => OpenCodeConnectionDefaults | undefined;
    readonly now?: () => number;
  }) {
    this.repository = input.repository; this.database = input.repository.database; this.settings = input.settings;
    if (this.settings.database !== this.database || this.settings.backendInstanceId !== input.backendInstanceId) throw unavailable();
    this.settings.assertScope(input.scope); assertOpenCodeCatalogPolicy(input.modelPolicy); this.#now = input.now ?? Date.now;
  }
  initializeThread(scope: RequestScope, applicationThreadId: string, connection: AgentConnectionProfile): void {
    const target = this.#target(scope, applicationThreadId, connection);
    this.settings.initialize(scope, applicationThreadId, target, null, this.#now());
  }
  initializeForkThread(..._input: Parameters<BackendThreadPersistenceAdapter["initializeForkThread"]>): never { throw unsupportedFork(); }
  readForkSettings(..._input: Parameters<BackendThreadPersistenceAdapter["readForkSettings"]>): never { throw unsupportedFork(); }
  initializeNewThread(scope: RequestScope, applicationThreadId: string, connection: AgentConnectionProfile, catalog: BackendCatalog): void {
    const defaults = this.input.resolveConnectionDefaults(connection);
    if (!defaults) throw unavailable();
    this.initializeResolvedNewThread(scope, applicationThreadId, connection,
      resolveOpenCodeDefaults({ connection, catalog, defaults, modelPolicy: this.input.modelPolicy }));
  }
  initializeResolvedNewThread(scope: RequestScope, applicationThreadId: string, connection: AgentConnectionProfile, desired: OpenCodeSelection): void {
    const target = this.#target(scope, applicationThreadId, connection);
    const current = this.settings.initialize(scope, applicationThreadId, target, desired, this.#now());
    if (current.desired === null) this.settings.updateDesired(scope, applicationThreadId, { expectedRevision: current.revision, desired, now: this.#now() });
    else if (!sameOpenCodeSelection(current.desired, desired)) throw unavailable();
  }
  readDesiredSettings(scope: RequestScope, applicationThreadId: string, connection: AgentConnectionProfile) {
    this.#target(scope, applicationThreadId, connection); return this.settings.get(scope, applicationThreadId);
  }
  validateInitialization(scope: RequestScope, applicationThreadId: string, catalog: BackendCatalog): void {
    const settings = this.settings.get(scope, applicationThreadId);
    if (!settings.desired) throw unavailable();
    const connection = this.database.prepare(`SELECT id, tenant_id AS tenantId, owner_principal_id AS ownerPrincipalId,
      backend_instance_id AS backendInstanceId, execution_environment_id AS executionEnvironmentId, kind
      FROM agent_connection_profiles WHERE tenant_id=? AND owner_principal_id=? AND id=?`)
      .get(scope.tenantId, scope.principalId, settings.connectionProfileId) as AgentConnectionProfile | undefined;
    if (!connection) throw unavailable();
    resolveOpenCodeSelection({ connection, catalog, modelId: qualifiedOpenCodeModelId(settings.desired),
      variant: settings.desired.variant, modelPolicy: this.input.modelPolicy });
  }
  initializationActions(scope: RequestScope, applicationThreadId: string, _attemptId: string): [] {
    this.settings.get(scope, applicationThreadId); return [];
  }
  recordSubmissionIntent(scope: RequestScope, applicationThreadId: string, attemptId: string, input: {
    readonly applicationOperationId: string; readonly mutationId: string; readonly reconciliationToken: string;
  }): void {
    if (!attemptId || !input.mutationId || !input.reconciliationToken || !input.applicationOperationId) throw unavailable();
    this.settings.captureOperation(scope, { applicationThreadId, applicationOperationId: input.applicationOperationId,
      operationKind: "submit", now: this.#now() });
  }
  hasSubmissionIntent(scope: RequestScope, applicationThreadId: string, attemptId: string, applicationOperationId: string): boolean {
    this.settings.get(scope, applicationThreadId);
    const attempt = this.database.prepare(`SELECT mutation_id AS mutationId, phase, retry_anchor AS retryAnchor
      FROM conversation_creation_attempts WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=?
      AND attempt_id=? AND force_reset_at IS NULL`).get(scope.tenantId, scope.principalId, applicationThreadId, attemptId) as
      { mutationId: string; phase: string; retryAnchor: string | null } | undefined;
    return attempt !== undefined && attempt.mutationId === applicationOperationId &&
      ["first_submission_started", "accepted_unpersisted", "bound", ...(attempt.retryAnchor !== null ? ["recovery_required"] : [])].includes(attempt.phase) &&
      this.settings.readOperation(scope, applicationThreadId, applicationOperationId, "submit") !== undefined;
  }
  saveBoundBindingDetail(scope: RequestScope, applicationThreadId: string, value: string): void {
    this.repository.saveBinding(scope, applicationThreadId, parseOpenCodeBindingDetail(value));
  }
  getBindingDetail(scope: RequestScope, applicationThreadId: string): string | undefined {
    return this.repository.getBinding(scope, applicationThreadId);
  }
  #target(scope: RequestScope, applicationThreadId: string, connection: AgentConnectionProfile): OpenCodeThreadTarget {
    if (connection.kind !== "opencode_http" || connection.tenantId !== scope.tenantId || connection.ownerPrincipalId !== scope.principalId ||
      connection.backendInstanceId !== this.input.backendInstanceId) throw unavailable();
    const target = { backendInstanceId: connection.backendInstanceId, connectionProfileId: connection.id, executionEnvironmentId: connection.executionEnvironmentId };
    this.settings.assertTarget(scope, applicationThreadId, target); return target;
  }
}
function unavailable(): DomainError { return new DomainError("conflict", "The OpenCode settings or thread target are unavailable."); }
function unsupportedFork(): DomainError { return new DomainError("invalid_transition", "OpenCode conversation forks are unavailable."); }
