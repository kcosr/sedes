import type Database from "better-sqlite3";
import type { AntigravityConnectionDefaults } from "../../../shared/protocol/antigravity-configuration.js";
import type { BackendThreadPersistenceAdapter } from "../../conversations/conversation-lifecycle-service.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { AgentConnectionProfile, BackendCatalog } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { parseAntigravityBinding, serializeAntigravityBinding, type AntigravityBinding } from "./binding.js";
import { antigravityAvailableModels, antigravityCatalogAllowsSelection, antigravitySettingsForDefaults } from "./model-selection.js";
import { AntigravityThreadRepository, type AntigravityDesiredSettings } from "./thread-repository.js";

export class AntigravityThreadPersistence implements BackendThreadPersistenceAdapter {
  readonly database: Database.Database;

  constructor(readonly input: {
    readonly settings: AntigravityThreadRepository;
    readonly scope: RequestScope;
    readonly backendInstanceId: string;
    readonly nativeNamespaceKey: string;
    readonly modelPolicy: CompiledBackendModelPolicy;
    readonly defaultsForConnection: (connectionId: string) => AntigravityConnectionDefaults | undefined;
    readonly now?: () => number;
  }) {
    this.database = input.settings.database;
  }

  assertConnection(scope: RequestScope, connection: AgentConnectionProfile): void {
    this.#assertScope(scope);
    if (connection.kind !== "antigravity_acp" || connection.tenantId !== scope.tenantId ||
        connection.ownerPrincipalId !== scope.principalId || connection.backendInstanceId !== this.input.backendInstanceId) {
      throw targetMismatch();
    }
  }

  initializeThread(scope: RequestScope, applicationThreadId: string, connection: AgentConnectionProfile): void {
    // Native history or setup is authoritative for an imported conversation.
    this.initializeResolvedNewThread(scope, applicationThreadId, connection, {
      modelId: null, thinkingLevel: null, modeId: null,
    });
  }

  initializeNewThread(scope: RequestScope, applicationThreadId: string, connection: AgentConnectionProfile, catalog: BackendCatalog): void {
    this.assertConnection(scope, connection);
    const defaults = this.input.defaultsForConnection(connection.id);
    if (!defaults) throw targetMismatch();
    const models = antigravityAvailableModels(catalog, connection.id, this.input.modelPolicy);
    this.initializeResolvedNewThread(scope, applicationThreadId, connection, antigravitySettingsForDefaults(models, defaults));
  }

  initializeResolvedNewThread(scope: RequestScope, applicationThreadId: string, connection: AgentConnectionProfile, desired: AntigravityDesiredSettings): void {
    this.assertConnection(scope, connection);
    this.input.settings.initialize(scope, applicationThreadId, connection, desired, this.input.now?.() ?? Date.now());
  }

  initializeForkThread(): never {
    throw unsupportedFork();
  }

  readForkSettings(): never {
    throw unsupportedFork();
  }

  validateInitialization(scope: RequestScope, applicationThreadId: string, catalog: BackendCatalog): void {
    this.#assertThread(scope, applicationThreadId);
    const settings = this.input.settings.get(scope, applicationThreadId);
    const models = antigravityAvailableModels(catalog, settings.connectionProfileId, this.input.modelPolicy);
    if (!antigravityCatalogAllowsSelection(models, settings)) {
      throw new DomainError("invalid_transition", "Choose an available Antigravity model and reasoning effort before starting this thread.");
    }
  }

  initializationActions(scope: RequestScope, applicationThreadId: string) {
    this.#assertThread(scope, applicationThreadId);
    return [];
  }

  recordSubmissionIntent(scope: RequestScope, applicationThreadId: string, attemptId: string, input: {
    readonly applicationOperationId: string;
    readonly mutationId: string;
    readonly reconciliationToken: string;
  }): void {
    this.#assertThread(scope, applicationThreadId);
    // The caller records the intent in the same transaction in the shared
    // creation attempt. The ACP driver owns actual dispatch evidence.
    if (!attemptId || !input.applicationOperationId || !input.mutationId || !input.reconciliationToken) {
      throw new DomainError("conflict", "The Antigravity submission intent is incomplete.");
    }
  }

  hasSubmissionIntent(scope: RequestScope, applicationThreadId: string, attemptId: string, applicationOperationId: string): boolean {
    this.#assertThread(scope, applicationThreadId);
    return this.database.prepare(`
      SELECT 1 FROM conversation_creation_attempts
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
        AND attempt_id = ? AND mutation_id = ? AND force_reset_at IS NULL
        AND (phase IN ('first_submission_started', 'accepted_unpersisted', 'bound')
             OR (phase = 'recovery_required' AND retry_anchor IS NOT NULL))
    `).get(scope.tenantId, scope.principalId, applicationThreadId, attemptId, applicationOperationId) !== undefined;
  }

  saveBoundBindingDetail(scope: RequestScope, applicationThreadId: string, opaqueBindingDetail: string): void {
    this.database.transaction(() => {
      const binding = this.#requireBinding(scope, applicationThreadId, opaqueBindingDetail);
      const canonical = serializeAntigravityBinding(binding);
      const existing = this.getBindingDetail(scope, applicationThreadId);
      if (existing === canonical) return;
      if (existing !== undefined) {
        throw new DomainError("conflict", "The Antigravity session binding already has different details.");
      }
      this.database.prepare(`
        INSERT INTO antigravity_binding_details(
          tenant_id, owner_principal_id, application_thread_id, backend_instance_id,
          connection_profile_id, execution_environment_id, opaque_binding_detail
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(scope.tenantId, scope.principalId, applicationThreadId, binding.backendInstanceId,
        binding.connectionProfileId, binding.executionEnvironmentId, canonical);
    })();
  }

  getBindingDetail(scope: RequestScope, applicationThreadId: string): string | undefined {
    this.#assertThread(scope, applicationThreadId);
    const row = this.database.prepare(`
      SELECT opaque_binding_detail AS detail FROM antigravity_binding_details
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
    `).get(scope.tenantId, scope.principalId, applicationThreadId) as { detail: string } | undefined;
    return row ? serializeAntigravityBinding(this.#requireBinding(scope, applicationThreadId, row.detail)) : undefined;
  }

  preservesLocalTitle(scope: RequestScope, applicationThreadId: string): boolean {
    this.#assertThread(scope, applicationThreadId);
    return this.input.settings.hasLocalTitleOverride(scope, applicationThreadId);
  }

  #requireBinding(scope: RequestScope, applicationThreadId: string, detail: string): AntigravityBinding {
    const target = this.#assertThread(scope, applicationThreadId);
    const row = this.database.prepare(`
      SELECT backend_conversation_id AS sessionId FROM conversation_bindings
      WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?
    `).get(scope.tenantId, scope.principalId, applicationThreadId) as { sessionId: string } | undefined;
    const binding = parseAntigravityBinding(detail);
    if (!row || row.sessionId !== binding.sessionId || binding.tenantId !== scope.tenantId ||
        binding.principalId !== scope.principalId || binding.backendInstanceId !== target.backendInstanceId ||
        binding.connectionProfileId !== target.connectionProfileId ||
        binding.executionEnvironmentId !== target.executionEnvironmentId ||
        binding.nativeNamespaceKey !== this.input.nativeNamespaceKey ||
        binding.canonicalWorkspacePath !== target.canonicalWorkspacePath) {
      throw targetMismatch();
    }
    return binding;
  }

  #assertThread(scope: RequestScope, applicationThreadId: string) {
    this.#assertScope(scope);
    const target = this.input.settings.target(scope, applicationThreadId);
    if (target.backendInstanceId !== this.input.backendInstanceId) throw targetMismatch();
    return target;
  }

  #assertScope(scope: RequestScope): void {
    if (scope.tenantId !== this.input.scope.tenantId || scope.principalId !== this.input.scope.principalId) throw targetMismatch();
  }
}

function targetMismatch(): DomainError {
  return new DomainError("conflict", "The Antigravity binding does not match the thread target.");
}

function unsupportedFork(): DomainError {
  return new DomainError("invalid_transition", "Antigravity conversation branching is unsupported.");
}
