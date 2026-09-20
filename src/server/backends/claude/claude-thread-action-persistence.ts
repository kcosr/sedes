import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ThreadApplicationOperation } from "../../../shared/protocol/api.js";
import type { ProviderFeatureRef } from "../../../shared/protocol/provider-feature.js";
import type {
  BackendActionSettingsGuard,
  ProviderFeatureMutationActor,
  ThreadActionPersistenceProvider,
} from "../../conversations/thread-mutation-gateway.js";
import { DomainError } from "../../domain/errors.js";
import { ProviderFeatureMutationRepository } from "../../db/repositories/provider-feature-mutation-repository.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { compiledProviderFeatureRegistry } from "../../provider-features/compiled-provider-feature-registry.js";
import {
  QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY,
  type ProviderFeatureConcurrency,
} from "../../provider-features/contracts.js";
import type { RegisteredBackendActionInput } from "../contracts.js";
import type { ClaudeModelEffortCatalog } from "./claude-model-effort-catalog.js";
import {
  isClaudePermissionModeAllowed,
  type ClaudePermissionPolicy,
} from "./claude-permission-policy.js";
import {
  CLAUDE_PERMISSIONS_FEATURE_REF,
  claudePermissionModeForAction,
} from "./claude-permissions-feature.js";
import type { ClaudeThreadRepository } from "./claude-thread-repository.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";

type PerformOperation = Extract<
  ThreadApplicationOperation,
  { readonly kind: "perform" }
>["operation"];

export class ClaudeThreadActionPersistence implements ThreadActionPersistenceProvider {
  async afterInterruptAccepted(
    _actor: ProviderFeatureMutationActor,
  ): Promise<boolean> {
    return false;
  }

  readonly #featureMutations: ProviderFeatureMutationRepository;

  constructor(
    readonly database: Database.Database,
    readonly scope: RequestScope,
    readonly backendInstanceId: string,
    readonly settings: ClaudeThreadRepository,
    readonly modelEfforts: ClaudeModelEffortCatalog,
    readonly permissionPolicy: ClaudePermissionPolicy,
    readonly modelPolicy: CompiledBackendModelPolicy,
  ) {
    if (
      settings.database !== database ||
      !scope.tenantId ||
      !scope.principalId ||
      !backendInstanceId
    ) {
      throw new Error("claude_action_persistence_scope_invalid");
    }
    this.#featureMutations = new ProviderFeatureMutationRepository(database);
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
          `
            UPDATE application_threads
            SET title = ?, revision = revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backend_instance_id = ? AND backing_state = 'bound'
              AND revision = ?
          `,
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
    // Model and effort are durable next-turn settings. The next attached
    // query applies them; no second provider mutation occurs here.
  }

  providerFeatureConcurrency(
    feature: ProviderFeatureRef,
    actionId: string,
  ): ProviderFeatureConcurrency {
    try {
      const module = compiledProviderFeatureRegistry.module(
        feature,
        "claude_agent_sdk",
      );
      if (
        !module.operations.some((operation) => operation.actionId === actionId)
      ) {
        return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY;
      }
    } catch {
      return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY;
    }
    return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY;
  }

  async performProviderFeature(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly operation: Extract<
        PerformOperation,
        { readonly action: "perform_provider_feature" }
      >;
      readonly now: number;
    },
  ): Promise<{ readonly applicationOperationId: string }> {
    this.#assertScope(scope);
    const replay = this.replayProviderFeature(
      scope,
      applicationThreadId,
      input,
    );
    if (replay) return replay;
    const registered = compiledProviderFeatureRegistry.validateAction({
      ref: input.operation.feature,
      backendKind: "claude_agent_sdk",
      actionId: input.operation.actionId,
      arguments: input.operation.arguments,
    });
    if (
      registered.module.ref.featureId !==
        CLAUDE_PERMISSIONS_FEATURE_REF.featureId ||
      registered.module.ref.schemaVersion !==
        CLAUDE_PERMISSIONS_FEATURE_REF.schemaVersion
    ) {
      throw unsupportedAction();
    }
    const permissionMode = claudePermissionModeForAction(
      input.operation.actionId,
    );
    if (
      !permissionMode ||
      !isClaudePermissionModeAllowed(permissionMode, this.permissionPolicy)
    ) {
      throw new DomainError(
        "invalid_transition",
        "The selected Claude permission mode is not allowed by deployment policy.",
      );
    }
    const requestFingerprint = fingerprint([
      applicationThreadId,
      input.expectedThreadRevision,
      input.operation,
    ]);
    return this.database.transaction(() => {
      const current = this.settings.find(scope, applicationThreadId);
      const thread = this.database
        .prepare(
          `SELECT backend_instance_id AS backendInstanceId,
                  revision, backing_state AS backingState
           FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .get(scope.tenantId, scope.principalId, applicationThreadId) as
        | {
            readonly backendInstanceId: string;
            readonly revision: number;
            readonly backingState: string;
          }
        | undefined;
      if (
        !current ||
        !thread ||
        current.backendInstanceId !== this.backendInstanceId ||
        thread.backendInstanceId !== this.backendInstanceId ||
        (thread.backingState !== "bound" &&
          thread.backingState !== "unbound") ||
        thread.revision !== input.expectedThreadRevision ||
        current.revision !== input.operation.expectedFeatureRevision
      ) {
        throw threadChanged();
      }
      const receipt = this.#featureMutations.prepare(scope, {
        applicationThreadId,
        mutationId: input.mutationId,
        featureId: input.operation.feature.featureId,
        schemaVersion: input.operation.feature.schemaVersion,
        actionId: input.operation.actionId,
        requestFingerprint,
        expectedThreadRevision: input.expectedThreadRevision,
        expectedFeatureRevision: input.operation.expectedFeatureRevision,
        desiredPostcondition: { permissionMode },
        now: input.now,
      });
      if (receipt.state === "accepted") {
        return { applicationOperationId: receipt.mutationId };
      }
      if (receipt.state !== "prepared") {
        throw new DomainError(
          "conflict",
          "The Claude permission mutation requires recovery.",
        );
      }
      this.settings.updateDesired(scope, applicationThreadId, {
        expectedRevision: current.revision,
        desired: {
          model: current.model,
          effort: current.effort,
          permissionMode,
        },
        now: input.now,
      });
      const changed = this.database
        .prepare(
          `UPDATE application_threads
           SET revision = revision + 1, updated_at = max(updated_at, ?)
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
             AND backend_instance_id = ? AND revision = ?
             AND backing_state IN ('unbound', 'bound')`,
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
      this.#advanceInventoryGeneration(scope);
      this.#featureMutations.accept(scope, input.mutationId, {
        requestFingerprint,
        result: { permissionMode },
        now: input.now,
      });
      return { applicationOperationId: input.mutationId };
    })();
  }

  replayProviderFeature(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly operation: Extract<
        PerformOperation,
        { readonly action: "perform_provider_feature" }
      >;
    },
  ): { readonly applicationOperationId: string } | undefined {
    this.#assertScope(scope);
    const existing = this.#featureMutations.find(scope, input.mutationId);
    if (!existing) return undefined;
    const requestFingerprint = fingerprint([
      applicationThreadId,
      input.expectedThreadRevision,
      input.operation,
    ]);
    if (
      existing.applicationThreadId !== applicationThreadId ||
      existing.requestFingerprint !== requestFingerprint ||
      existing.featureId !== input.operation.feature.featureId ||
      existing.schemaVersion !== input.operation.feature.schemaVersion ||
      existing.actionId !== input.operation.actionId ||
      existing.expectedThreadRevision !== input.expectedThreadRevision ||
      existing.expectedFeatureRevision !==
        input.operation.expectedFeatureRevision
    ) {
      throw threadChanged();
    }
    if (existing.state !== "accepted") {
      throw new DomainError(
        "conflict",
        "The Claude permission mutation requires recovery.",
      );
    }
    return { applicationOperationId: existing.mutationId };
  }

  #persistSetting(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly expectedThreadRevision: number;
      readonly settingsGuard: BackendActionSettingsGuard;
      readonly operation: Extract<PerformOperation, { action: "set_setting" }>;
      readonly now: number;
    },
  ): void {
    if (
      input.operation.value === null ||
      (input.operation.settingId !== "model" &&
        input.operation.settingId !== "thinking_level")
    ) {
      throw unsupportedAction();
    }
    const value = input.operation.value;
    this.database.transaction(() => {
      const current = this.settings.get(scope, applicationThreadId);
      if (current.backendInstanceId !== this.backendInstanceId) {
        throw threadChanged();
      }
      const expectedSettingsRevision =
        input.settingsGuard.kind === "staged"
          ? input.settingsGuard.expectedRevision
          : current.revision;
      let desired: {
        readonly model: string | null;
        readonly effort: string | null;
        readonly permissionMode: typeof current.permissionMode;
      };
      if (input.operation.settingId === "model") {
        if (value.length < 1 || value.length > 240) {
          throw modelPolicyRejected();
        }
        const effort = this.modelEfforts.resolve(
          applicationThreadId,
          current.connectionProfileId,
          value,
          current.effort,
        );
        if (
          effort === undefined ||
          !isModelEffortAllowed(this.modelPolicy, value, effort)
        ) {
          throw new DomainError(
            "invalid_transition",
            "The selected Claude model has no validated effort level.",
          );
        }
        desired = {
          model: value,
          effort,
          permissionMode: current.permissionMode,
        };
      } else {
        if (
          !current.model ||
          !this.modelEfforts.allows(
            applicationThreadId,
            current.connectionProfileId,
            current.model,
            value,
          ) ||
          !this.modelPolicy.isSelectionAllowed({
            modelId: current.model,
            reasoningEffort: value,
          })
        ) {
          throw new DomainError(
            "invalid_transition",
            "The selected Claude model has no validated effort level.",
          );
        }
        desired = {
          model: current.model,
          effort: value,
          permissionMode: current.permissionMode,
        };
      }
      this.settings.updateDesired(scope, applicationThreadId, {
        expectedRevision: expectedSettingsRevision,
        desired,
        now: input.now,
      });
      const changed = this.database
        .prepare(
          `
            UPDATE application_threads
            SET revision = revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND backend_instance_id = ? AND revision = ?
          `,
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
      throw new Error("claude_action_inventory_generation_missing");
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

function isModelEffortAllowed(
  policy: CompiledBackendModelPolicy,
  modelId: string,
  effort: string | null,
): boolean {
  return effort === null
    ? policy.isModelWithoutReasoningEffortAllowed({ modelId })
    : policy.isSelectionAllowed({ modelId, reasoningEffort: effort });
}

function modelPolicyRejected(): DomainError {
  return new DomainError(
    "invalid_transition",
    "This model or reasoning effort is not allowed by the backend policy.",
  );
}

function fingerprint(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function unsupportedAction(): DomainError {
  return new DomainError(
    "invalid_transition",
    "This Claude action is not supported.",
  );
}

function threadChanged(): DomainError {
  return new DomainError(
    "conflict",
    "The Claude thread or settings changed in another client.",
  );
}
