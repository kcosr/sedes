import { assertOutboundPairingReferences } from "./configuration-outbound-pairing.js";
import type Database from "better-sqlite3";
import {
  configurationDocumentSchema, configurationLifecycleRequestSchema, configurationLifecycleResultSchema,
  configurationRuntimeStateSchema, configurationSnapshotSchema,
  type ConfigurationDocument, type ConfigurationLifecycleRequest,
  type ConfigurationLifecycleResult, type ConfigurationRuntimeState,
  type ConfigurationSnapshot, type SaveConfigurationRequest,
} from "../../shared/protocol/configuration-admin.js";
import { configurationFingerprint } from "../config/configuration-fingerprint.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { configurationIdentities, runtimeConfigurationFingerprint } from "./configuration-identities.js";

export const EMPTY_EXECUTION_CONFIGURATION: ConfigurationDocument = {
  executionEnvironments: [], backends: [], targets: [], defaultTargetId: null, webSearch: null,
};
const MAXIMUM_RECEIPTS = 10_000;
type ResourceKind = ConfigurationRuntimeState["resourceKind"];
type Receipt = { operation: "save" | "lifecycle"; fingerprint: string; result: string };

/** All mutable desired state, receipts, and runtime observations share scope. */
export class ConfigurationRepository {
  constructor(readonly database: Database.Database, readonly now: () => number = Date.now) {}

  get(scope: RequestScope): ConfigurationSnapshot {
    this.assertPrincipal(scope);
    const row = this.database.prepare(`SELECT revision, configuration_json AS configuration
      FROM principal_execution_configuration WHERE tenant_id = ? AND owner_principal_id = ?`)
      .get(scope.tenantId, scope.principalId) as { revision: number; configuration: string } | undefined;
    const configuration = configurationDocumentSchema.parse(row ? JSON.parse(row.configuration) : EMPTY_EXECUTION_CONFIGURATION);
    const resources = new Set([
      ...configuration.executionEnvironments.map(item => `environment:${item.id}`),
      ...configuration.backends.map(item => `backend:${item.id}`),
    ]);
    const runtimes = this.database.prepare(`SELECT resource_kind AS kind, resource_id AS id, state_json AS state FROM execution_configuration_runtime_state
      WHERE tenant_id = ? AND owner_principal_id = ? ORDER BY resource_kind, resource_id`)
      .all(scope.tenantId, scope.principalId) as { kind: string; id: string; state: string }[];
    const outstanding = new Map<string, NonNullable<ConfigurationRuntimeState["lifecycleOperation"]>>();
    const outstandingRevision = new Map<string, number>();
    for (const { request, result } of this.pendingLifecycle(scope)) {
      if (result.state !== "pending" && result.state !== "unknown") continue;
      const key = `${request.resourceKind}:${request.resourceId}`;
      if ((outstandingRevision.get(key) ?? -1) > request.expectedRevision) continue;
      outstandingRevision.set(key, request.expectedRevision);
      outstanding.set(key, {
        mutationId: request.mutationId, action: request.action, state: result.state,
      });
    }
    return configurationSnapshotSchema.parse({
      revision: row?.revision ?? 0,
      configuration,
      runtimes: runtimes.filter(item => resources.has(`${item.kind}:${item.id}`)).map(item => {
        const lifecycleOperation = outstanding.get(`${item.kind}:${item.id}`);
        return { ...JSON.parse(item.state), ...(lifecycleOperation ? { lifecycleOperation } : {}) };
      }),
    });
  }

  isInitialized(scope: RequestScope): boolean {
    this.assertPrincipal(scope);
    return Boolean(this.database.prepare(`SELECT 1 FROM principal_execution_configuration WHERE tenant_id = ? AND owner_principal_id = ?`).get(scope.tenantId, scope.principalId));
  }

  assertPrincipal(scope: RequestScope): void {
    if (!this.database.prepare(`SELECT 1 FROM principals WHERE tenant_id = ? AND id = ?`).get(scope.tenantId, scope.principalId)) {
      throw new DomainError("not_found", "Configuration ownership was not found.");
    }
  }

  replaySave(scope: RequestScope, request: SaveConfigurationRequest): ConfigurationSnapshot | undefined {
    const receipt = this.#receipt(scope, request.mutationId, "save", request);
    return receipt ? configurationSnapshotSchema.parse(JSON.parse(receipt.result)) : undefined;
  }

  save(scope: RequestScope, request: SaveConfigurationRequest,
    project?: (document: ConfigurationDocument) => void): ConfigurationSnapshot {
    return this.database.transaction(() => {
      const replayed = this.replaySave(scope, request);
      if (replayed) return replayed;
      const previous = this.get(scope);
      this.#assertRevision(previous, request.expectedRevision);
      this.#assertCapacity(scope);
      const document = configurationDocumentSchema.parse(request.configuration);
      assertOutboundPairingReferences(this.database, scope, document, previous.configuration);
      this.#reserveIdentities(scope, document);
      const revision = previous.revision + 1;
      this.#writeDocument(scope, revision, document);
      this.#reconcileRuntimeDesires(scope, previous.configuration, document, revision);
      project?.(document);
      const result = this.get(scope);
      this.#insertReceipt(scope, request.mutationId, "save", request, result);
      return result;
    })();
  }

  /** Called only by the explicit import/empty-initialization boundary. */
  initialize(scope: RequestScope, document: ConfigurationDocument,
    provenance: { sourceFingerprint: string; sourceLabel: string },
    convertOwnershipAndProject: () => void): ConfigurationSnapshot {
    return this.database.transaction(() => {
      this.assertPrincipal(scope);
      const existing = this.database.prepare(`SELECT source_fingerprint AS fingerprint FROM execution_configuration_imports
        WHERE tenant_id = ? AND owner_principal_id = ?`).get(scope.tenantId, scope.principalId) as { fingerprint: string } | undefined;
      if (existing) {
        if (existing.fingerprint !== provenance.sourceFingerprint) throw new DomainError("conflict", "Configuration was already imported from a different source.");
        return this.get(scope);
      }
      if (this.isInitialized(scope)) throw new DomainError("conflict", "Database configuration already exists; import cannot overwrite it.");
      const validated = configurationDocumentSchema.parse(document);
      this.#assertCompleteImport(scope, validated);
      assertOutboundPairingReferences(this.database, scope, validated);
      this.#reserveIdentities(scope, validated);
      convertOwnershipAndProject();
      this.#writeDocument(scope, 0, validated);
      this.#reconcileRuntimeDesires(scope, EMPTY_EXECUTION_CONFIGURATION, validated, 0);
      this.database.prepare(`INSERT INTO execution_configuration_imports
        (tenant_id, owner_principal_id, source_fingerprint, source_label, imported_at) VALUES (?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.principalId, provenance.sourceFingerprint, provenance.sourceLabel, this.now());
      return this.get(scope);
    })();
  }

  runtime(scope: RequestScope, kind: ResourceKind, id: string): ConfigurationRuntimeState {
    this.assertPrincipal(scope);
    const row = this.database.prepare(`SELECT state_json AS state FROM execution_configuration_runtime_state
      WHERE tenant_id = ? AND owner_principal_id = ? AND resource_kind = ? AND resource_id = ?`)
      .get(scope.tenantId, scope.principalId, kind, id) as { state: string } | undefined;
    if (!row) throw new DomainError("not_found", "The configuration runtime was not found.");
    return configurationRuntimeStateSchema.parse(JSON.parse(row.state));
  }

  /** Observation cannot overwrite a newer desired revision or lifecycle choice. */
  observe(scope: RequestScope, value: ConfigurationRuntimeState): ConfigurationRuntimeState {
    return this.database.transaction(() => {
      const observation = configurationRuntimeStateSchema.parse(value);
      const current = this.runtime(scope, observation.resourceKind, observation.resourceId);
      if (current.desiredRevision !== observation.desiredRevision || current.preference !== observation.preference) {
        throw new DomainError("conflict", "Runtime observation refers to stale desired configuration.");
      }
      if (observation.effectiveRevision !== null && observation.effectiveRevision > observation.desiredRevision) {
        throw new DomainError("conflict", "Runtime observation has an invalid applied revision.");
      }
      if (observation.applyState === "applied" && observation.effectiveRevision !== observation.desiredRevision) {
        throw new DomainError("conflict", "Applied status requires the exact desired revision.");
      }
      this.#putRuntime(scope, observation);
      return observation;
    })();
  }

  replayLifecycle(scope: RequestScope, request: ConfigurationLifecycleRequest): ConfigurationLifecycleResult | undefined {
    const receipt = this.#receipt(scope, request.mutationId, "lifecycle", request);
    return receipt ? configurationLifecycleResultSchema.parse(JSON.parse(receipt.result)) : undefined;
  }

  lifecycleReceipt(scope: RequestScope, mutationId: string): ConfigurationLifecycleResult {
    this.assertPrincipal(scope);
    const row = this.database.prepare(`SELECT result_json AS result FROM execution_configuration_receipts
      WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ? AND operation = 'lifecycle'`)
      .get(scope.tenantId, scope.principalId, mutationId) as { result: string } | undefined;
    if (!row) throw new DomainError("not_found", "The lifecycle receipt was not found.");
    return configurationLifecycleResultSchema.parse(JSON.parse(row.result));
  }

  /** Recovery queries status using these identities; it must never replay execute. */
  pendingLifecycle(scope: RequestScope): { request: ConfigurationLifecycleRequest; result: ConfigurationLifecycleResult }[] {
    this.assertPrincipal(scope);
    const rows = this.database.prepare(`SELECT request_json AS request, result_json AS result FROM execution_configuration_receipts
      WHERE tenant_id = ? AND owner_principal_id = ? AND operation = 'lifecycle'
        AND json_extract(result_json, '$.state') IN ('pending', 'unknown') ORDER BY created_at, mutation_id`)
      .all(scope.tenantId, scope.principalId) as { request: string; result: string }[];
    return rows.map(row => ({ request: configurationLifecycleRequestSchema.parse(JSON.parse(row.request)), result: configurationLifecycleResultSchema.parse(JSON.parse(row.result)) }));
  }

  /** Reserve before external effects. A replay never executes the command again. */
  beginLifecycle(scope: RequestScope, request: ConfigurationLifecycleRequest): { result: ConfigurationLifecycleResult; fresh: boolean } {
    return this.database.transaction(() => {
      const replayed = this.replayLifecycle(scope, request);
      if (replayed) return { result: replayed, fresh: false };
      const snapshot = this.get(scope);
      this.#assertRevision(snapshot, request.expectedRevision);
      if (!snapshot.runtimes.some(runtime => runtime.resourceKind === request.resourceKind && runtime.resourceId === request.resourceId)) {
        throw new DomainError("not_found", "The configuration resource was removed.");
      }
      this.#assertCapacity(scope);
      const runtime = this.runtime(scope, request.resourceKind, request.resourceId);
      if (runtime.incarnation !== request.expectedIncarnation) throw new DomainError("conflict", "The runtime incarnation changed.");
      const preference = request.action === "disconnect" ? "disconnected" : request.action === "stop" ? "stopped" : "automatic";
      const next: ConfigurationRuntimeState = {
        ...runtime, preference, desiredRevision: snapshot.revision + 1, applyState: "pending", lastError: null,
      };
      this.#writeDocument(scope, snapshot.revision + 1, snapshot.configuration);
      this.#putRuntime(scope, next);
      const result: ConfigurationLifecycleResult = { mutationId: request.mutationId, state: "pending", runtime: next };
      this.#insertReceipt(scope, request.mutationId, "lifecycle", request, result);
      return { result, fresh: true };
    })();
  }

  completeLifecycle(scope: RequestScope, request: ConfigurationLifecycleRequest, value: ConfigurationLifecycleResult): ConfigurationLifecycleResult {
    return this.database.transaction(() => {
      const existing = this.replayLifecycle(scope, request);
      if (!existing) throw new DomainError("not_found", "The lifecycle command was not admitted.");
      if (existing.state !== "pending" && existing.state !== "unknown") return existing;
      const result = configurationLifecycleResultSchema.parse(value);
      if (result.mutationId !== request.mutationId || result.runtime.resourceKind !== request.resourceKind || result.runtime.resourceId !== request.resourceId ||
        result.runtime.desiredRevision !== existing.runtime.desiredRevision || result.runtime.preference !== existing.runtime.preference) {
        throw new DomainError("conflict", "The lifecycle result does not match the admitted command.");
      }
      const current = this.runtime(scope, request.resourceKind, request.resourceId);
      // A settled old receipt remains queryable, but cannot replace a newer
      // configuration/runtime projection.
      if (current.desiredRevision === result.runtime.desiredRevision && current.preference === result.runtime.preference) this.observe(scope, result.runtime);
      this.database.prepare(`UPDATE execution_configuration_receipts SET result_json = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ? AND operation = 'lifecycle'`)
        .run(JSON.stringify(result), scope.tenantId, scope.principalId, request.mutationId);
      return result;
    })();
  }

  hasApprovedSecret(scope: RequestScope, environmentId: string, reference: unknown): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM execution_configuration_approved_secrets
      WHERE tenant_id = ? AND owner_principal_id = ? AND environment_id = ? AND reference_fingerprint = ?`)
      .get(scope.tenantId, scope.principalId, environmentId, configurationFingerprint(reference)));
  }

  approveSecret(scope: RequestScope, environmentId: string, reference: unknown): void {
    this.assertPrincipal(scope);
    this.database.prepare(`INSERT OR IGNORE INTO execution_configuration_approved_secrets
      (tenant_id, owner_principal_id, environment_id, reference_fingerprint) VALUES (?, ?, ?, ?)`)
      .run(scope.tenantId, scope.principalId, environmentId, configurationFingerprint(reference));
  }

  #writeDocument(scope: RequestScope, revision: number, configuration: ConfigurationDocument): void {
    this.database.prepare(`INSERT INTO principal_execution_configuration
      (tenant_id, owner_principal_id, revision, configuration_json, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, owner_principal_id) DO UPDATE SET revision = excluded.revision,
        configuration_json = excluded.configuration_json, updated_at = excluded.updated_at`)
      .run(scope.tenantId, scope.principalId, revision, JSON.stringify(configuration), this.now());
  }

  #assertRevision(snapshot: ConfigurationSnapshot, expected: number): void {
    if (snapshot.revision !== expected || expected >= Number.MAX_SAFE_INTEGER) throw new DomainError("conflict", "Configuration changed. Reload before saving.");
  }

  #reserveIdentities(scope: RequestScope, document: ConfigurationDocument): void {
    for (const identity of configurationIdentities(document)) {
      const current = this.database.prepare(`SELECT identity_fingerprint AS fingerprint FROM execution_configuration_identities
        WHERE tenant_id = ? AND owner_principal_id = ? AND resource_kind = ? AND resource_id = ?`)
        .get(scope.tenantId, scope.principalId, identity.kind, identity.id) as { fingerprint: string } | undefined;
      if (current && current.fingerprint !== identity.fingerprint) throw new DomainError("conflict", `The ${identity.kind} execution identity is immutable. Create a replacement definition with a new ID.`);
      this.database.prepare(`INSERT OR IGNORE INTO execution_configuration_identities
        (tenant_id, owner_principal_id, resource_kind, resource_id, identity_fingerprint) VALUES (?, ?, ?, ?, ?)`)
        .run(scope.tenantId, scope.principalId, identity.kind, identity.id, identity.fingerprint);
    }
  }

  #assertCompleteImport(scope: RequestScope, document: ConfigurationDocument): void {
    // Legacy rows cannot recover native store definitions from their hashes.
    // Require the complete source before assigning ownership or reserving IDs.
    const backends = this.database.prepare(`SELECT id FROM agent_backend_instances
      WHERE tenant_id = ? AND (owner_principal_id IS NULL OR owner_principal_id = ?)`)
      .all(scope.tenantId, scope.principalId) as { id: string }[];
    const environments = this.database.prepare(`SELECT id FROM execution_environments
      WHERE tenant_id = ? AND owner_principal_id = ?`).all(scope.tenantId, scope.principalId) as { id: string }[];
    const targets = this.database.prepare(`SELECT template_id AS id FROM agent_connection_profiles
      WHERE tenant_id = ? AND owner_principal_id = ?`).all(scope.tenantId, scope.principalId) as { id: string }[];
    if (backends.some(row => !document.backends.some(item => item.id === row.id)) ||
      environments.some(row => !document.executionEnvironments.some(item => item.id === row.id)) ||
      targets.some(row => !document.targets.some(item => item.id === row.id))) {
      throw new DomainError("conflict", "Legacy import must include every retained backend, environment, and target definition. Restore omitted definitions in the import file; they may be disabled.");
    }
  }

  #reconcileRuntimeDesires(scope: RequestScope, previous: ConfigurationDocument, next: ConfigurationDocument, revision: number): void {
    const resources = [
      ...previous.executionEnvironments.map(item => ({ kind: "environment" as const, id: item.id })),
      ...next.executionEnvironments.map(item => ({ kind: "environment" as const, id: item.id })),
      ...previous.backends.map(item => ({ kind: "backend" as const, id: item.id })),
      ...next.backends.map(item => ({ kind: "backend" as const, id: item.id })),
    ];
    const seen = new Set<string>();
    for (const resource of resources) {
      const key = `${resource.kind}:${resource.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const existing = this.database.prepare(`SELECT state_json AS state FROM execution_configuration_runtime_state
        WHERE tenant_id = ? AND owner_principal_id = ? AND resource_kind = ? AND resource_id = ?`)
        .get(scope.tenantId, scope.principalId, resource.kind, resource.id) as { state: string } | undefined;
      const current = existing ? configurationRuntimeStateSchema.parse(JSON.parse(existing.state)) : undefined;
      if (current && runtimeConfigurationFingerprint(previous, resource.kind, resource.id) === runtimeConfigurationFingerprint(next, resource.kind, resource.id)) continue;
      this.#putRuntime(scope, current ? { ...current, desiredRevision: revision, applyState: "pending", lastError: null } : {
        resourceKind: resource.kind, resourceId: resource.id, desiredRevision: revision, effectiveRevision: null,
        applyState: "pending", preference: "automatic", connectionState: "unknown", incarnation: null,
        softwareVersion: null, upgradeState: "unknown", activeResources: 0, supportedActions: [], lastError: null,
      });
    }
  }

  #putRuntime(scope: RequestScope, runtime: ConfigurationRuntimeState): void {
    // Receipt state is projected at read time; observations cannot persist it.
    const { lifecycleOperation: _operation, ...observation } = runtime;
    this.database.prepare(`INSERT INTO execution_configuration_runtime_state
      (tenant_id, owner_principal_id, resource_kind, resource_id, state_json) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, owner_principal_id, resource_kind, resource_id) DO UPDATE SET state_json = excluded.state_json`)
      .run(scope.tenantId, scope.principalId, runtime.resourceKind, runtime.resourceId, JSON.stringify(observation));
  }

  #receipt(scope: RequestScope, mutationId: string, operation: Receipt["operation"], request: unknown): Receipt | undefined {
    this.assertPrincipal(scope);
    const row = this.database.prepare(`SELECT operation, request_fingerprint AS fingerprint, result_json AS result
      FROM execution_configuration_receipts WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id = ?`)
      .get(scope.tenantId, scope.principalId, mutationId) as Receipt | undefined;
    if (row && (row.operation !== operation || row.fingerprint !== configurationFingerprint(request))) throw new DomainError("conflict", "The mutation ID was already used with different contents.");
    return row;
  }

  #assertCapacity(scope: RequestScope): void {
    const row = this.database.prepare(`SELECT COUNT(*) AS count FROM execution_configuration_receipts
      WHERE tenant_id = ? AND owner_principal_id = ?`).get(scope.tenantId, scope.principalId) as { count: number };
    if (row.count < MAXIMUM_RECEIPTS) return;
    // Admission advances the scoped revision atomically. An exact old request
    // remains fenced by expectedRevision after its settled result expires.
    // Pending/unknown operations retain all recovery evidence without expiry.
    this.database.prepare(`DELETE FROM execution_configuration_receipts
      WHERE tenant_id = ? AND owner_principal_id = ? AND mutation_id IN (
        SELECT mutation_id FROM execution_configuration_receipts
        WHERE tenant_id = ? AND owner_principal_id = ? AND (operation = 'save' OR
          (operation = 'lifecycle' AND json_extract(result_json, '$.state') IN ('applied', 'rejected', 'unavailable')))
        ORDER BY created_at, mutation_id LIMIT ?
      )`).run(scope.tenantId, scope.principalId, scope.tenantId, scope.principalId, row.count - MAXIMUM_RECEIPTS + 1);
    const remaining = this.database.prepare(`SELECT COUNT(*) AS count FROM execution_configuration_receipts
      WHERE tenant_id = ? AND owner_principal_id = ?`).get(scope.tenantId, scope.principalId) as { count: number };
    if (remaining.count >= MAXIMUM_RECEIPTS) throw new DomainError("conflict", "Configuration receipt capacity is exhausted by unsettled outcomes; recover pending lifecycle commands first.");
  }

  #insertReceipt(scope: RequestScope, mutationId: string, operation: Receipt["operation"], request: unknown, result: unknown): void {
    this.database.prepare(`INSERT INTO execution_configuration_receipts
      (tenant_id, owner_principal_id, mutation_id, operation, request_fingerprint, request_json, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(scope.tenantId, scope.principalId, mutationId, operation, configurationFingerprint(request), JSON.stringify(request), JSON.stringify(result), this.now());
  }
}
