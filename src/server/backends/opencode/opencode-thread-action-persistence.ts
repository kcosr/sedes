import type Database from "better-sqlite3";
import type { ThreadActionPersistenceProvider } from "../../conversations/thread-mutation-gateway.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY } from "../../provider-features/contracts.js";
import type { RegisteredBackendActionInput } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { assertOpenCodeCatalogPolicy, decodeOpenCodeModelId, decodeOpenCodeModelSetting, openCodeSelectionSchema } from "./opencode-model-selection.js";
import type { OpenCodeThreadSettingsRepository } from "./opencode-thread-settings-repository.js";

export class OpenCodeThreadActionPersistence implements ThreadActionPersistenceProvider {
  constructor(readonly input: { readonly database: Database.Database; readonly scope: RequestScope; readonly backendInstanceId: string;
    readonly settings: OpenCodeThreadSettingsRepository; readonly modelPolicy: CompiledBackendModelPolicy }) {
    if (input.settings.database !== input.database || input.settings.backendInstanceId !== input.backendInstanceId) throw unavailable();
    input.settings.assertScope(input.scope); assertOpenCodeCatalogPolicy(input.modelPolicy);
  }
  async afterInterruptAccepted(): Promise<boolean> { return false; }
  driverAction(operation: Parameters<ThreadActionPersistenceProvider["driverAction"]>[0], applicationOperationId: string): RegisteredBackendActionInput {
    if (operation.action === "rename" && operation.title.trim()) return { ...operation, applicationOperationId };
    if (operation.action !== "set_setting" || operation.value === null) throw unavailable();
    if (operation.settingId === "model") {
      const selection = decodeOpenCodeModelSetting(operation.value);
      return { action: "set_model", applicationOperationId, provider: selection.connectionId, modelId: selection.modelId };
    }
    if (operation.settingId === "thinking_level" && validEffort(operation.value)) return { action: "set_thinking_level", applicationOperationId, level: operation.value };
    throw unavailable();
  }
  persistAccepted(scope: RequestScope, applicationThreadId: string, input: Parameters<ThreadActionPersistenceProvider["persistAccepted"]>[2]): void {
    this.input.settings.assertScope(scope);
    const operation = input.operation;
    this.input.database.transaction(() => {
      const current = this.input.settings.get(scope, applicationThreadId);
      if (operation.action === "set_setting" && operation.value !== null) {
        let desired;
        if (operation.settingId === "model") {
          const selected = decodeOpenCodeModelSetting(operation.value);
          if (selected.connectionId !== current.connectionProfileId) throw unavailable();
          desired = decodeOpenCodeModelId(selected.modelId);
        } else if (operation.settingId === "thinking_level" && current.desired && validEffort(operation.value)) {
          desired = openCodeSelectionSchema.parse({ ...current.desired, variant: operation.value });
        } else throw unavailable();
        this.input.settings.updateDesired(scope, applicationThreadId, { desired, now: input.now,
          expectedRevision: input.settingsGuard.kind === "staged" ? input.settingsGuard.expectedRevision : current.revision });
      } else if (operation.action !== "rename" || !operation.title.trim()) throw unavailable();
      const changed = this.input.database.prepare(`UPDATE application_threads SET
        ${operation.action === "rename" ? "title=?," : ""} revision=revision+1, updated_at=max(updated_at,?)
        WHERE tenant_id=? AND owner_principal_id=? AND id=? AND backend_instance_id=? AND revision=?`)
        .run(...(operation.action === "rename" ? [operation.title] : []), input.now, scope.tenantId, scope.principalId,
          applicationThreadId, this.input.backendInstanceId, input.expectedThreadRevision);
      if (changed.changes !== 1) throw unavailable();
      if (operation.action === "rename") {
        const generation = this.input.database.prepare(`UPDATE principal_generations SET inventory_generation=inventory_generation+1 WHERE tenant_id=? AND principal_id=?`)
          .run(scope.tenantId, scope.principalId);
        if (generation.changes !== 1) throw unavailable();
      }
    })();
  }
  async afterPersistAccepted(): Promise<void> { /* The driver already proved the exact native readback. */ }
  providerFeatureConcurrency() { return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY; }
}
function validEffort(value: string): boolean { return value.length > 0 && value.length <= 120 && !/\p{Cc}/u.test(value); }
function unavailable(): DomainError { return new DomainError("invalid_transition", "The OpenCode action or settings are unavailable."); }
