import type { ThreadApplicationOperation } from "../../../shared/protocol/api.js";
import { createHash } from "node:crypto";
import type { ThreadActionPersistenceProvider } from "../../conversations/thread-mutation-gateway.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY } from "../../provider-features/contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { antigravityModelIsAllowed, decodeAntigravityModelSetting } from "./model-selection.js";
import type { AntigravityDesiredSettings, AntigravityThreadRepository } from "./thread-repository.js";
import { ProviderFeatureMutationRepository } from "../../db/repositories/provider-feature-mutation-repository.js";
import { compiledProviderFeatureRegistry } from "../../provider-features/compiled-provider-feature-registry.js";
import { ANTIGRAVITY_MODE_FEATURE_REF, antigravityModeForAction } from "./mode-feature.js";
import { AntigravityModeCatalog } from "./mode-catalog.js";

type Operation = Extract<ThreadApplicationOperation, { kind: "perform" }>["operation"];
type ModeMutation = {
  readonly mutationId: string;
  readonly expectedThreadRevision: number;
  readonly operation: Extract<Operation, { action: "perform_provider_feature" }>;
};

export class AntigravityActionPersistence implements ThreadActionPersistenceProvider {
  constructor(
    readonly settings: AntigravityThreadRepository,
    readonly scope: RequestScope,
    readonly backendInstanceId: string,
    readonly modelPolicy: CompiledBackendModelPolicy,
    readonly modes: AntigravityModeCatalog = new AntigravityModeCatalog(),
  ) {}

  async afterInterruptAccepted(): Promise<boolean> { return false; }
  async afterPersistAccepted(): Promise<void> {}
  providerFeatureConcurrency() { return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY; }

  isLocalOperation(operation: Operation): boolean {
    return operation.action === "set_setting" && (operation.settingId === "model" || operation.settingId === "thinking_level");
  }

  driverAction(): never { throw unsupportedAction(); }

  replayProviderFeature(scope: RequestScope, applicationThreadId: string, input: ModeMutation) {
    this.#assertScope(scope);
    const receipt = new ProviderFeatureMutationRepository(this.settings.database).find(scope, input.mutationId);
    if (!receipt) return undefined;
    if (receipt.applicationThreadId !== applicationThreadId || receipt.featureId !== input.operation.feature.featureId ||
        receipt.schemaVersion !== input.operation.feature.schemaVersion || receipt.actionId !== input.operation.actionId ||
        receipt.requestFingerprint !== fingerprint(applicationThreadId, input) || receipt.state !== "accepted") throw changed();
    // Scope alone is insufficient if the caller addresses another backend's
    // accepted receipt. The owning thread must still belong to this module.
    if (this.settings.target(scope, applicationThreadId).backendInstanceId !== this.backendInstanceId) throw changed();
    return { applicationOperationId: receipt.mutationId };
  }

  async performProviderFeature(scope: RequestScope, applicationThreadId: string, input: ModeMutation & { readonly now: number }) {
    this.#assertScope(scope);
    const replay = this.replayProviderFeature(scope, applicationThreadId, input);
    if (replay) return replay;
    const registered = compiledProviderFeatureRegistry.validateAction({ ref: input.operation.feature, backendKind: "antigravity",
      actionId: input.operation.actionId, arguments: input.operation.arguments });
    if (registered.module.ref.featureId !== ANTIGRAVITY_MODE_FEATURE_REF.featureId ||
        registered.module.ref.schemaVersion !== ANTIGRAVITY_MODE_FEATURE_REF.schemaVersion) throw unsupportedAction();
    const modeId = antigravityModeForAction(input.operation.actionId);
    if (modeId === undefined || modeId !== null && !this.modes.allows(modeId)) throw unsupportedAction();
    const requestFingerprint = fingerprint(applicationThreadId, input);
    return this.settings.database.transaction(() => {
      const target = this.settings.target(scope, applicationThreadId);
      const current = this.settings.get(scope, applicationThreadId);
      if (target.backendInstanceId !== this.backendInstanceId || target.revision !== input.expectedThreadRevision ||
          current.backendInstanceId !== this.backendInstanceId || current.revision !== input.operation.expectedMutationRevision ||
          (target.backingState !== "bound" && target.backingState !== "unbound")) throw changed();
      const receipts = new ProviderFeatureMutationRepository(this.settings.database);
      const receipt = receipts.prepare(scope, { applicationThreadId, mutationId: input.mutationId,
        featureId: input.operation.feature.featureId, schemaVersion: input.operation.feature.schemaVersion, actionId: input.operation.actionId,
        expectedThreadRevision: input.expectedThreadRevision, expectedMutationRevision: input.operation.expectedMutationRevision,
        requestFingerprint, desiredPostcondition: { modeId }, now: input.now });
      if (receipt.state !== "prepared") throw changed();
      this.settings.updateDesired(scope, applicationThreadId, { expectedRevision: current.revision,
        desired: { modelId: current.modelId, thinkingLevel: current.thinkingLevel, modeId }, now: input.now });
      const updated = this.settings.database.prepare(`UPDATE application_threads SET revision = revision + 1, updated_at = max(updated_at, ?)
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ? AND backend_instance_id = ? AND revision = ?`)
        .run(input.now, scope.tenantId, scope.principalId, applicationThreadId, this.backendInstanceId, input.expectedThreadRevision);
      if (updated.changes !== 1) throw changed();
      const generation = this.settings.database.prepare(`UPDATE principal_generations SET inventory_generation = inventory_generation + 1
        WHERE tenant_id = ? AND principal_id = ?`).run(scope.tenantId, scope.principalId);
      if (generation.changes !== 1) throw new Error("antigravity_inventory_generation_missing");
      receipts.accept(scope, input.mutationId, { requestFingerprint, result: { modeId }, now: input.now });
      return { applicationOperationId: input.mutationId };
    })();
  }

  #assertScope(scope: RequestScope): void {
    if (scope.tenantId !== this.scope.tenantId || scope.principalId !== this.scope.principalId) throw changed();
  }

  persistAccepted(scope: RequestScope, applicationThreadId: string, input: Parameters<ThreadActionPersistenceProvider["persistAccepted"]>[2]): void {
    if (scope.tenantId !== this.scope.tenantId || scope.principalId !== this.scope.principalId) throw changed();
    const { operation, expectedThreadRevision, settingsGuard, now } = input;
    if (operation.action !== "set_setting" || !this.isLocalOperation(operation) || !operation.value || settingsGuard.kind !== "staged") {
      throw unsupportedAction();
    }
    const value = operation.value;
    this.settings.database.transaction(() => {
      const target = this.settings.target(scope, applicationThreadId);
      if (target.backendInstanceId !== this.backendInstanceId || target.revision !== expectedThreadRevision ||
          (target.backingState !== "unbound" && target.backingState !== "bound")) throw changed();
      const current = this.settings.get(scope, applicationThreadId);
      let desired: AntigravityDesiredSettings;
      if (operation.settingId === "model") {
        let selection;
        try { selection = decodeAntigravityModelSetting(value); } catch { throw unsupportedAction(); }
        const [connectionId, modelId, thinkingLevel] = selection;
        if (connectionId !== target.connectionProfileId) throw unsupportedAction();
        desired = { modelId, thinkingLevel, modeId: current.modeId };
      } else {
        desired = { modelId: current.modelId, thinkingLevel: value, modeId: current.modeId };
      }
      // A model without an admitted default effort can be staged with its
      // effort unresolved. Submission still requires a complete live tuple.
      if ((operation.settingId === "thinking_level" || desired.thinkingLevel !== null) && !antigravityModelIsAllowed(this.modelPolicy, desired)) {
        throw unsupportedAction();
      }
      this.settings.updateDesired(scope, applicationThreadId, { expectedRevision: settingsGuard.expectedRevision, desired, now });
      const updated = this.settings.database.prepare(`
        UPDATE application_threads SET revision = revision + 1, updated_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ? AND backend_instance_id = ? AND revision = ?
      `).run(now, scope.tenantId, scope.principalId, applicationThreadId, this.backendInstanceId, expectedThreadRevision);
      if (updated.changes !== 1) throw changed();
    })();
  }
}

function fingerprint(applicationThreadId: string, input: ModeMutation): string {
  return createHash("sha256").update(JSON.stringify([applicationThreadId, input.expectedThreadRevision, input.operation])).digest("hex");
}

function unsupportedAction(): DomainError {
  return new DomainError("invalid_transition", "The Antigravity action or setting value is unavailable.");
}

function changed(): DomainError {
  return new DomainError("conflict", "The Antigravity thread or settings changed in another client.");
}
