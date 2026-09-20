import type Database from "better-sqlite3";
import type { ThreadApplicationOperation } from "../../../shared/protocol/api.js";
import type { ProviderFeatureRef } from "../../../shared/protocol/provider-feature.js";
import type {
  BackendActionSettingsGuard,
  ProviderFeatureMutationActor,
  ThreadActionPersistenceProvider,
} from "../../conversations/thread-mutation-gateway.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY,
  type ProviderFeatureConcurrency,
} from "../../provider-features/contracts.js";
import type { RegisteredBackendActionInput } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { GrokModelEffortCatalog } from "./grok-model-effort-catalog.js";
import { decodeGrokModelSetting } from "./grok-setting-values.js";
import type { GrokThreadRepository } from "./grok-thread-repository.js";

type PerformOperation = Extract<
  ThreadApplicationOperation,
  { readonly kind: "perform" }
>["operation"];

export class GrokThreadActionPersistence implements ThreadActionPersistenceProvider {
  constructor(
    readonly database: Database.Database,
    readonly scope: RequestScope,
    readonly backendInstanceId: string,
    readonly settings: GrokThreadRepository,
    readonly modelEfforts: GrokModelEffortCatalog,
    readonly modelPolicy: CompiledBackendModelPolicy,
  ) {
    if (
      settings.database !== database ||
      !scope.tenantId ||
      !scope.principalId ||
      !backendInstanceId
    ) {
      throw new Error("grok_action_persistence_scope_invalid");
    }
  }

  async afterInterruptAccepted(
    _actor: ProviderFeatureMutationActor,
  ): Promise<boolean> {
    return false;
  }

  isLocalOperation(operation: PerformOperation): boolean {
    return (
      operation.action === "set_setting" &&
      (operation.settingId === "model" ||
        operation.settingId === "thinking_level")
    );
  }

  driverAction(
    operation: PerformOperation,
    applicationOperationId: string,
  ): RegisteredBackendActionInput {
    if (operation.action === "rename") {
      return { ...operation, applicationOperationId };
    }
    throw unsupportedAction();
  }

  persistAccepted(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly settingsGuard: BackendActionSettingsGuard;
      readonly operation: PerformOperation;
      readonly now: number;
    },
  ): void {
    this.#assertScope(scope);
    const operation = input.operation;
    if (operation.action === "set_setting") {
      this.#persistSetting(scope, applicationThreadId, {
        ...input,
        operation,
      });
      return;
    }
    if (operation.action !== "rename") throw unsupportedAction();
    this.database.transaction(() => {
      const changed = this.database
        .prepare(
          `UPDATE application_threads
           SET title = ?, revision = revision + 1, updated_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND backend_instance_id = ? AND backing_state = 'bound'
             AND revision = ?`,
        )
        .run(
          operation.title,
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          this.backendInstanceId,
          input.expectedThreadRevision,
        );
      if (changed.changes !== 1) throw threadChanged();
      this.#advanceInventoryGeneration(scope);
    })();
  }

  async afterPersistAccepted(): Promise<void> {
    // Accepted renames are already persisted. Draft settings are consumed
    // exactly once by the later session/new operation.
  }

  providerFeatureConcurrency(
    _feature: ProviderFeatureRef,
    _actionId: string,
  ): ProviderFeatureConcurrency {
    return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY;
  }

  #persistSetting(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedThreadRevision: number;
      readonly settingsGuard: BackendActionSettingsGuard;
      readonly operation: Extract<
        PerformOperation,
        { readonly action: "set_setting" }
      >;
      readonly now: number;
    },
  ): void {
    const operation = input.operation;
    const value = operation.value;
    if (
      value === null ||
      (operation.settingId !== "model" &&
        operation.settingId !== "thinking_level")
    ) {
      throw unsupportedAction();
    }
    this.database.transaction(() => {
      const current = this.settings.get(scope, applicationThreadId);
      const thread = this.database
        .prepare(
          `SELECT revision, backing_state AS backingState
           FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND backend_instance_id = ?`,
        )
        .get(
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          this.backendInstanceId,
        ) as
        | { readonly revision: number; readonly backingState: string }
        | undefined;
      if (
        !thread ||
        thread.backingState !== "unbound" ||
        thread.revision !== input.expectedThreadRevision ||
        current.backendInstanceId !== this.backendInstanceId
      ) {
        throw threadChanged();
      }
      const expectedSettingsRevision =
        input.settingsGuard.kind === "staged"
          ? input.settingsGuard.expectedRevision
          : current.revision;
      let model: string;
      let effort: string;
      if (operation.settingId === "model") {
        let selection;
        try {
          selection = decodeGrokModelSetting(value);
        } catch {
          throw modelRejected();
        }
        model = selection.modelId;
        effort = selection.reasoningEffort;
      } else {
        if (!current.model) throw modelRejected();
        model = current.model;
        effort = value;
      }
      if (
        !this.modelEfforts.allows(
          applicationThreadId,
          current.connectionProfileId,
          model,
          effort,
        ) ||
        !this.modelPolicy.isSelectionAllowed({
          modelId: model,
          reasoningEffort: effort,
        })
      ) {
        throw modelRejected();
      }
      this.settings.updateDesired(scope, applicationThreadId, {
        expectedRevision: expectedSettingsRevision,
        desired: { model, effort },
        now: input.now,
      });
      const changed = this.database
        .prepare(
          `UPDATE application_threads
           SET revision = revision + 1, updated_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND backend_instance_id = ? AND backing_state = 'unbound'
             AND revision = ?`,
        )
        .run(
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          this.backendInstanceId,
          input.expectedThreadRevision,
        );
      if (changed.changes !== 1) throw threadChanged();
    })();
  }

  #advanceInventoryGeneration(scope: RequestScope): void {
    const changed = this.database
      .prepare(
        `UPDATE principal_generations
         SET inventory_generation = inventory_generation + 1
         WHERE tenant_id = ? AND principal_id = ?`,
      )
      .run(scope.tenantId, scope.principalId);
    if (changed.changes !== 1) {
      throw new Error("grok_action_inventory_generation_missing");
    }
  }

  #assertScope(scope: RequestScope): void {
    if (
      scope.tenantId !== this.scope.tenantId ||
      scope.principalId !== this.scope.principalId
    ) {
      throw threadChanged();
    }
  }
}

function modelRejected(): DomainError {
  return new DomainError(
    "invalid_transition",
    "The selected Grok model or reasoning effort is unavailable.",
  );
}

function unsupportedAction(): DomainError {
  return new DomainError(
    "invalid_transition",
    "This Grok action is not supported.",
  );
}

function threadChanged(): DomainError {
  return new DomainError(
    "conflict",
    "The Grok thread or settings changed in another client.",
  );
}
