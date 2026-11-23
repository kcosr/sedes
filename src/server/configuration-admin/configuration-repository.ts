import type { InstalledExecutionPolicy } from "../../internal/sidecar-protocol/execution-policy.js";
import { validateConfigurationDocument } from "./configuration-validation.js";
import { changedConfigurationEffects, configurationEffectsPending, observeProviderLaunch } from "./configuration-effects.js";
import { hostExecutionPolicy } from "./configuration-execution-policy.js";
import { antigravityOwners, assertSingleAntigravityOwner, restoreMigratedTargets } from "./configuration-ownership.js";
import { assertOutboundPairingReferences } from "./configuration-outbound-pairing.js";
import type Database from "better-sqlite3";
import {
  configurationDocumentSchema, configurationLifecycleRequestSchema, configurationLifecycleResultSchema,
  configurationRuntimeStateSchema, configurationSnapshotSchema,
  type ConfigurationDocument, type ConfigurationEffect, type ConfigurationLifecycleRequest,
  type ConfigurationLifecycleResult, type ConfigurationRuntimeState,
  type ConfigurationSnapshot, type SaveConfigurationRequest,
} from "../../shared/protocol/configuration-admin.js";
import { configurationFingerprint } from "../config/configuration-fingerprint.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { configurationIdentities } from "./configuration-identities.js";

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
      assertSingleAntigravityOwner(document);
      const incumbents = antigravityOwners(previous.configuration);
      for (const [environment, ids] of antigravityOwners(document)) {
        if (incumbents.get(environment)?.[0] !== ids[0]) this.assertNativeOwner(scope, environment, "antigravity", ids[0]!);
      }
      if (restoreMigratedTargets(this.database, scope, document)) validateConfigurationDocument(document);
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
      assertSingleAntigravityOwner(validated);
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
      const effects = current.effects?.map(effect => {
        if (effect.component !== "provider_launch" || effect.providerLaunch?.owner === "host") return effect;
        if (observation.connectionState === "stopped" && effect.providerLaunch) {
          return { ...effect, state: "next_launch" as const, effectiveRevision: null,
            providerLaunch: {...effect.providerLaunch, confirmedDigest: null} };
        }
        if (observation.startupEnvironmentPending) return { ...effect, state: "restart_backend" as const };
        if (observation.applyState === "applied" && observation.connectionState === "connected") {
          return { ...effect, state: "applied" as const, effectiveRevision: effect.desiredRevision,
            ...(effect.providerLaunch && { providerLaunch: {...effect.providerLaunch, confirmedDigest: effect.providerLaunch.desiredDigest} }) };
        }
        return effect;
      });
      const pending = configurationEffectsPending(effects ?? []);
      const observed = { ...observation, ...(effects ? { effects } : {}),
        ...(pending && observation.applyState === "applied" ? { applyState: "pending" as const, effectiveRevision: current.effectiveRevision === current.desiredRevision ? null : current.effectiveRevision } : {}) };
      this.#putRuntime(scope, observed);
      return observed;
    })();
  }

  /** Publish only evidence for the still-current complete snapshot. Background observations may arrive out of order. */
  observeHostPolicy(scope: RequestScope, environmentId: string, installed: InstalledExecutionPolicy,
    readiness: ReadonlyMap<string, "ready" | "unsupported" | "failed" | "preparing">,
    confirmation?: {incarnation: string; epoch: number; launchDigests?: ReadonlyMap<string,string | null>}): void {
    this.database.transaction(() => {
      const desired = hostExecutionPolicy(this.database, scope, environmentId);
      if (!desired || desired.revision !== installed.revision || desired.digest !== installed.digest) return;
      const stamp = confirmation && {revision: installed.revision, digest: installed.digest, incarnation: confirmation.incarnation, epoch: confirmation.epoch};
      // The immutable profile binding survives removal so an installed withdrawal also settles
      // its retained runtime row before someone re-adds the same backend in a later generation.
      const hostRuntimes = this.database.prepare(`SELECT state_json AS state FROM execution_configuration_runtime_state
        WHERE tenant_id = ? AND owner_principal_id = ?
          AND ((resource_kind = 'environment' AND resource_id = ?) OR (resource_kind = 'backend' AND resource_id IN (
            SELECT backend_instance_id FROM agent_connection_profiles
              WHERE tenant_id = ? AND owner_principal_id = ? AND execution_environment_id = ?
          )))`).all(scope.tenantId, scope.principalId, environmentId, scope.tenantId, scope.principalId, environmentId) as {state: string}[];
      for (const row of hostRuntimes) {
        const runtime = configurationRuntimeStateSchema.parse(JSON.parse(row.state));
        const effects = (runtime.effects ?? []).map(effect => {
          if (effect.component !== "host_policy") return effect;
          const [kind, id] = effect.subjectId.split(":", 2);
          const target = kind === "target" ? installed.snapshot.backends.find(b => b.targets.some(t => t.id === id)) : undefined;
          const subject = target ? `backend:${target.id}` : effect.subjectId;
          // A complete installation proves withdrawals, including an intermediate removal skipped while offline.
          const granted = kind === "target" ? Boolean(target)
            : kind === "backend" || kind === "managed_tui" ? installed.snapshot.backends.some(b => b.id === id && (kind !== "managed_tui" || b.managedTuiDigest))
            : kind === "route" ? installed.snapshot.backends.some(b => b.id === id) && installed.snapshot.capabilities.some(c => c.id === "agent_tools_cli")
            : kind === "root" ? installed.snapshot.roots.some(r => r.id === id)
            : kind === "capability" && installed.snapshot.capabilities.some(c => c.id === id);
          const state = granted ? readiness.get(subject) : "ready";
          const outcome: ConfigurationEffect["state"] = state === "ready"
            ? granted && kind === "managed_tui" ? "next_launch" : "applied"
            : state === "unsupported" || state === "failed" ? state : "awaiting_host";
          return { ...effect, state: outcome, effectiveRevision: state === "ready" ? effect.desiredRevision : effect.effectiveRevision === effect.desiredRevision ? null : effect.effectiveRevision,
            ...(stamp ? { lastHostConfirmation: stamp } : {}) };
        });
        const grant = runtime.resourceKind === "backend" && installed.snapshot.backends.find(b => b.id === runtime.resourceId);
        if (grant && grant.kind !== "pi" && stamp) {
          observeProviderLaunch(runtime, effects, grant.launchDigest, confirmation?.launchDigests?.get(grant.id), stamp);
        }
        if (JSON.stringify(runtime.effects) === JSON.stringify(effects)) continue;
        this.#putRuntime(scope, { ...runtime, effects, ...(configurationEffectsPending(effects) && runtime.applyState === "applied" ? {
          applyState: "pending", effectiveRevision: runtime.effectiveRevision === runtime.desiredRevision ? null : runtime.effectiveRevision,
        } : {}) });
      }
    })();
  }

  /** Migration candidates remain addressable after their disabled definitions and targets are removed. */
  unresolvedAntigravityCandidates(scope: RequestScope, environmentId: string): string[] {
    return (this.database.prepare(`SELECT c.backend_id AS id FROM execution_configuration_ownership_conflicts c
      WHERE c.tenant_id = ? AND c.owner_principal_id = ? AND c.environment_id = ? AND c.retirement_confirmed = 0
        AND NOT EXISTS (SELECT 1 FROM execution_configuration_native_owners o WHERE o.tenant_id = c.tenant_id
          AND o.owner_principal_id = c.owner_principal_id AND o.environment_id = c.environment_id AND o.namespace = 'antigravity')
      ORDER BY c.backend_id`).all(scope.tenantId, scope.principalId, environmentId) as { id: string }[]).map(row => row.id);
  }

  retainedAntigravityOwner(scope: RequestScope, environmentId: string): string | undefined {
    const row = this.database.prepare(`SELECT backend_id AS id FROM execution_configuration_native_owners WHERE tenant_id = ?
      AND owner_principal_id = ? AND environment_id = ? AND namespace = 'antigravity'`)
      .get(scope.tenantId, scope.principalId, environmentId) as { id: string | null } | undefined;
    return row?.id ?? undefined;
  }

  confirmLocalAntigravityRetirement(scope: RequestScope, environmentId: string, backendId: string): void {
    // This attestation is available only for an unclaimed, disabled local migration candidate.
    // A positive retained owner must be stopped using its actual runtime identity.
    this.database.transaction(() => {
      const { configuration } = this.get(scope);
      if (!configuration.executionEnvironments.some(e => e.id === environmentId && e.kind === "local") ||
          !configuration.backends.some(b => b.id === backendId && b.kind === "antigravity" && !b.enabled) ||
          !configuration.targets.some(t => t.backendInstanceId === backendId && t.executionEnvironmentId === environmentId) ||
          !this.unresolvedAntigravityCandidates(scope, environmentId).includes(backendId)) {
        throw new DomainError("conflict", "This local legacy retirement is no longer awaiting confirmation.");
      }
      this.confirmNativeOwner(scope, environmentId, "antigravity", null, backendId);
      const current = this.runtime(scope, "backend", backendId);
      const effects = current.effects?.map(effect => effect.component === "ownership" ? {
        ...effect, state: "applied" as const, effectiveRevision: effect.desiredRevision,
        detail: "The operator confirmed retirement of this previous local runtime.",
      } : effect);
      this.#putRuntime(scope, { ...current, effects });
    })();
  }

  assertNativeOwner(scope: RequestScope, environmentId: string, namespace: string, backendId: string): void {
    const row = this.database.prepare(`SELECT backend_id AS backendId FROM execution_configuration_native_owners
      WHERE tenant_id = ? AND owner_principal_id = ? AND environment_id = ? AND namespace = ?`)
      .get(scope.tenantId, scope.principalId, environmentId, namespace) as {backendId: string | null} | undefined;
    if (!row && namespace === "antigravity" && this.database.prepare(`SELECT 1 FROM execution_configuration_ownership_conflicts
      WHERE tenant_id = ? AND owner_principal_id = ? AND environment_id = ? LIMIT 1`).get(scope.tenantId, scope.principalId, environmentId)) {
      throw new DomainError("conflict", "Inspect the retained Antigravity runtime or confirm its retirement before enabling any owner.");
    }
    if (row?.backendId && row.backendId !== backendId) {
      throw new DomainError("conflict", "Confirm retirement of the retained Antigravity backend before enabling another owner.");
    }
  }

  /** Trusted exact live inventory or confirmed retirement is the only source of namespace ownership evidence. */
  confirmNativeOwner(scope: RequestScope, environmentId: string, namespace: string, owner: string | null, expectedOwner?: string): void {
    this.assertPrincipal(scope);
    this.database.transaction(() => {
      const host = [scope.tenantId, scope.principalId, environmentId];
      if (namespace === "antigravity" && owner === null && expectedOwner && !this.database.prepare(`SELECT 1
        FROM execution_configuration_native_owners WHERE tenant_id = ? AND owner_principal_id = ? AND environment_id = ? AND namespace = ?`)
        .get(...host, namespace)) {
        // Inspecting one missing backend says nothing about a different candidate on this host.
        this.database.prepare(`UPDATE execution_configuration_ownership_conflicts SET retirement_confirmed = 1
          WHERE tenant_id = ? AND owner_principal_id = ? AND environment_id = ? AND backend_id = ?`).run(...host, expectedOwner);
        if (this.database.prepare(`SELECT 1 FROM execution_configuration_ownership_conflicts
          WHERE tenant_id = ? AND owner_principal_id = ? AND environment_id = ? AND retirement_confirmed = 0 LIMIT 1`).get(...host)) return;
      }
      const result = this.database.prepare(`INSERT INTO execution_configuration_native_owners
        (tenant_id, owner_principal_id, environment_id, namespace, backend_id) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, owner_principal_id, environment_id, namespace) DO UPDATE SET backend_id = excluded.backend_id
        WHERE (excluded.backend_id IS NOT NULL AND (backend_id IS NULL OR backend_id = excluded.backend_id))
           OR (excluded.backend_id IS NULL AND (? IS NULL OR backend_id IS NULL OR backend_id = ?))`)
        .run(scope.tenantId, scope.principalId, environmentId, namespace, owner, expectedOwner ?? null, expectedOwner ?? null);
      if (!result.changes) throw new DomainError("conflict", "The reported native runtime ownership conflicts with the confirmed incumbent.");
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
      const preference = request.action === "confirm_retirement" ? runtime.preference
        : request.action === "disconnect" ? "disconnected" : request.action === "stop" ? "stopped" : "automatic";
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
      if (current.desiredRevision === result.runtime.desiredRevision && current.preference === result.runtime.preference) {
        result.runtime = this.observe(scope, result.runtime);
      }
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
      const effects = changedConfigurationEffects(scope, previous, next, resource.kind, resource.id, revision, current);
      if (!effects) continue;
      const applied = current?.applyState === "applied" && !configurationEffectsPending(effects);
      this.#putRuntime(scope, current ? { ...current, desiredRevision: revision, effects,
        effectiveRevision: applied ? revision : current.effectiveRevision, applyState: applied ? "applied" : "pending", lastError: null } : {
        resourceKind: resource.kind, resourceId: resource.id, desiredRevision: revision, effectiveRevision: null, effects,
        applyState: "pending", preference: "automatic", connectionState: "unknown", incarnation: null,
        softwareVersion: null, upgradeState: "unknown", activeResources: 0, supportedActions: [], lastError: null,
      });
    }
  }

  #putRuntime(scope: RequestScope, runtime: ConfigurationRuntimeState): void {
    // Receipt state is projected at read time; observations cannot persist it.
    const { lifecycleOperation: _operation, ...observation } = configurationRuntimeStateSchema.parse(runtime);
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
