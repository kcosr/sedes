import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { ThreadApplicationOperation } from "../../../shared/protocol/api.js";
import type {
  BackendActionSettingsGuard,
  ProviderFeatureMutationActor,
  ThreadActionPersistenceProvider,
} from "../../conversations/thread-mutation-gateway.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { RegisteredBackendActionInput } from "../contracts.js";
import {
  assertCodexExecutionPolicySelection,
  type CodexExecutionPolicyAllowlist,
  type CodexExecutionPolicySelection,
} from "./codex-execution-policy.js";
import { CODEX_EXECUTION_FEATURE_REF } from "./codex-execution-feature.js";
import { CODEX_FAST_MODE_FEATURE_REF } from "./codex-fast-mode-feature.js";
import {
  CODEX_GOAL_FEATURE_REF,
  boundedCodexGoalReceiptResult,
  desiredPostconditionForCodexGoalAction,
  type CodexGoalActionId,
  type CodexGoalStateV1,
} from "./codex-goal-feature.js";
import type { CodexGoalSessionRegistry } from "./codex-goal-session.js";
import { decodeCodexModelSetting } from "./codex-setting-values.js";
import type {
  CodexExecutionSettingsTuple,
  CodexThreadExecutionSettingsRepository,
} from "./codex-thread-execution-settings-repository.js";
import type { ProviderFeatureMutationRepository } from "../../db/repositories/provider-feature-mutation-repository.js";
import { compiledProviderFeatureRegistry } from "../../provider-features/compiled-provider-feature-registry.js";
import {
  CODEX_TUI_FEATURE_REF,
  type CodexTuiActionId,
  type CodexTuiStateV1,
} from "./codex-tui-feature.js";
import type { CodexManagedTuiController } from "./codex-managed-tui-controller.js";
import type { ProviderFeatureRef } from "../../../shared/protocol/provider-feature.js";
import {
  CONCURRENT_PROVIDER_FEATURE_CONCURRENCY,
  QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY,
  type ProviderFeatureConcurrency,
} from "../../provider-features/contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";

type PerformOperation = Extract<
  ThreadApplicationOperation,
  { readonly kind: "perform" }
>["operation"];

type ThreadTarget = {
  readonly backendInstanceId: string;
  readonly connectionProfileId: string;
  readonly backingState: "unbound" | "creating" | "bound" | "creation_unknown";
  readonly revision: number;
};

/**
 * Provider-owned persistence for Codex actions and desired execution settings.
 *
 * The mutation gateway owns durable operation receipts and calls this boundary
 * after driver acceptance for provider actions. Desired model, reasoning, and
 * permission changes are local durable next-turn mutations and never use the
 * driver's direct provider-action path.
 */
export class CodexThreadActionPersistence implements ThreadActionPersistenceProvider {
  readonly database: Database.Database;
  readonly #scope: RequestScope;
  readonly #backendInstanceId: string;
  readonly #settings: CodexThreadExecutionSettingsRepository;
  readonly #featureMutations: ProviderFeatureMutationRepository;
  readonly #executionPolicy: CodexExecutionPolicyAllowlist;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #defaultExecutionPolicyByConnectionId: ReadonlyMap<
    string,
    CodexExecutionPolicySelection
  >;
  readonly #goalSessions: CodexGoalSessionRegistry | undefined;
  readonly #managedTui: CodexManagedTuiController | undefined;
  readonly #fastModeRuntime:
    | {
        syncServiceTier(
          scope: RequestScope,
          applicationThreadId: string,
          serviceTier: "standard" | "fast",
        ): Promise<void>;
      }
    | undefined;

  async afterInterruptAccepted(
    actor: ProviderFeatureMutationActor,
  ): Promise<boolean> {
    if (!actor.mutateProviderFeature) return false;
    try {
      const result = await actor.mutateProviderFeature({
        ...CODEX_GOAL_FEATURE_REF,
        actionId: "pause",
        arguments: {},
      });
      return result.outcome === "accepted";
    } catch {
      return false;
    }
  }

  constructor(input: {
    readonly database: Database.Database;
    readonly scope: RequestScope;
    readonly backendInstanceId: string;
    readonly settings: CodexThreadExecutionSettingsRepository;
    readonly featureMutations: ProviderFeatureMutationRepository;
    readonly executionPolicy: CodexExecutionPolicyAllowlist;
    readonly modelPolicy: CompiledBackendModelPolicy;
    readonly defaultExecutionPolicyByConnectionId: ReadonlyMap<
      string,
      CodexExecutionPolicySelection
    >;
    readonly goalSessions?: CodexGoalSessionRegistry;
    readonly managedTui?: CodexManagedTuiController;
    readonly fastModeRuntime?: {
      syncServiceTier(
        scope: RequestScope,
        applicationThreadId: string,
        serviceTier: "standard" | "fast",
      ): Promise<void>;
    };
  }) {
    if (
      !input.scope.tenantId ||
      !input.scope.principalId ||
      !input.backendInstanceId ||
      input.settings.database !== input.database ||
      input.featureMutations.database !== input.database
    ) {
      throw new Error("codex_action_persistence_scope_invalid");
    }
    this.database = input.database;
    this.#scope = Object.freeze({ ...input.scope });
    this.#backendInstanceId = input.backendInstanceId;
    this.#settings = input.settings;
    this.#featureMutations = input.featureMutations;
    this.#executionPolicy = input.executionPolicy;
    this.#modelPolicy = input.modelPolicy;
    this.#defaultExecutionPolicyByConnectionId =
      input.defaultExecutionPolicyByConnectionId;
    this.#goalSessions = input.goalSessions;
    this.#managedTui = input.managedTui;
    this.#fastModeRuntime = input.fastModeRuntime;
  }

  async afterPersistAccepted(
    scope: RequestScope,
    applicationThreadId: string,
    operation: PerformOperation,
  ): Promise<void> {
    if (operation.action !== "set_setting") return;
    const desired = this.#settings.find(scope, applicationThreadId)?.desired;
    if (!desired) return;
    await this.#syncDesired(scope, applicationThreadId, desired);
  }

  providerFeatureConcurrency(
    feature: ProviderFeatureRef,
    actionId: string,
  ): ProviderFeatureConcurrency {
    let module;
    try {
      module = compiledProviderFeatureRegistry.module(
        feature,
        "codex_app_server",
      );
    } catch {
      return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY;
    }
    if (!module.operations.some((operation) => operation.actionId === actionId)) {
      return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY;
    }
    if (
      (module.ref.featureId === CODEX_GOAL_FEATURE_REF.featureId &&
        module.ref.schemaVersion === CODEX_GOAL_FEATURE_REF.schemaVersion) ||
      (module.ref.featureId === CODEX_TUI_FEATURE_REF.featureId &&
        module.ref.schemaVersion === CODEX_TUI_FEATURE_REF.schemaVersion)
    ) {
      return CONCURRENT_PROVIDER_FEATURE_CONCURRENCY;
    }
    return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY;
  }

  requiresRuntimeProviderFeature(
    operation: Extract<
      PerformOperation,
      { readonly action: "perform_provider_feature" }
    >,
  ): boolean {
    return (
      (operation.feature.featureId === CODEX_GOAL_FEATURE_REF.featureId &&
        operation.feature.schemaVersion ===
          CODEX_GOAL_FEATURE_REF.schemaVersion) ||
      (operation.feature.featureId === CODEX_TUI_FEATURE_REF.featureId &&
        operation.feature.schemaVersion === CODEX_TUI_FEATURE_REF.schemaVersion)
    );
  }

  isLocalOperation(operation: PerformOperation): boolean {
    return operation.action === "set_setting";
  }

  driverAction(
    operation: PerformOperation,
    applicationOperationId: string,
  ): RegisteredBackendActionInput {
    if (operation.action === "rename" || operation.action === "compact") {
      return { ...operation, applicationOperationId };
    }
    throw settingsUnavailable();
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
    if (operation.action === "perform_provider_feature") {
      throw new Error("codex_provider_feature_uses_dedicated_boundary");
    }
    if (operation.action === "set_setting") {
      this.#persistSetting(scope, applicationThreadId, {
        expectedThreadRevision: input.expectedThreadRevision,
        settingsGuard: input.settingsGuard,
        operation,
        now: input.now,
      });
      return;
    }
    this.database.transaction(() => {
      const target = this.#threadTarget(scope, applicationThreadId);
      if (
        target.backendInstanceId !== this.#backendInstanceId ||
        target.backingState !== "bound"
      ) {
        throw targetMismatch();
      }
      if (operation.action === "compact") {
        if (target.revision !== input.expectedThreadRevision) {
          throw new DomainError(
            "conflict",
            "The Codex thread changed while compaction was accepted.",
          );
        }
        return;
      }
      if (operation.action !== "rename") throw settingsUnavailable();
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
          this.#backendInstanceId,
          input.expectedThreadRevision,
        );
      if (changed.changes !== 1) {
        throw new DomainError(
          "conflict",
          "The Codex thread changed while its rename was accepted.",
        );
      }
      const generation = this.database
        .prepare(
          `
            UPDATE principal_generations
            SET inventory_generation = inventory_generation + 1
            WHERE tenant_id = ? AND principal_id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId);
      if (generation.changes !== 1) {
        throw new Error("codex_action_inventory_generation_missing");
      }
    })();
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
      readonly mutateExternal?: (input: {
        readonly featureId: string;
        readonly schemaVersion: number;
        readonly actionId: string;
        readonly arguments: unknown;
      }) => Promise<{
        readonly outcome: "accepted" | "uncertain" | "rejected";
        readonly projectedState?: unknown;
        readonly safeMessage?: string;
      }>;
    },
  ): Promise<
    | { readonly applicationOperationId: string }
    | { readonly status: "recovery_required"; readonly retryable: boolean }
  > {
    this.#assertScope(scope);
    const replay = this.replayProviderFeature(
      scope,
      applicationThreadId,
      input,
    );
    if (replay) return replay;
    const registered = compiledProviderFeatureRegistry.validateAction({
      ref: input.operation.feature,
      backendKind: "codex_app_server",
      actionId: input.operation.actionId,
      arguments: input.operation.arguments,
    });
    if (
      registered.module.ref.featureId === CODEX_GOAL_FEATURE_REF.featureId &&
      registered.module.ref.schemaVersion ===
        CODEX_GOAL_FEATURE_REF.schemaVersion
    ) {
      return this.#performGoalFeature(scope, applicationThreadId, input);
    }
    if (
      registered.module.ref.featureId === CODEX_TUI_FEATURE_REF.featureId &&
      registered.module.ref.schemaVersion ===
        CODEX_TUI_FEATURE_REF.schemaVersion
    ) {
      return await this.#performTuiFeature(scope, applicationThreadId, input);
    }
    if (
      registered.module.ref.featureId === CODEX_FAST_MODE_FEATURE_REF.featureId &&
      registered.module.ref.schemaVersion ===
        CODEX_FAST_MODE_FEATURE_REF.schemaVersion
    ) {
      return await this.#performFastModeFeature(
        scope,
        applicationThreadId,
        input,
      );
    }
    if (
      registered.module.ref.featureId !==
        CODEX_EXECUTION_FEATURE_REF.featureId ||
      registered.module.ref.schemaVersion !==
        CODEX_EXECUTION_FEATURE_REF.schemaVersion
    ) {
      throw new DomainError(
        "invalid_transition",
        "The Codex execution-setting action is unavailable.",
      );
    }
    this.#assertNoEnabledAutomation(scope, applicationThreadId);
    const requestFingerprint = fingerprint([
      applicationThreadId,
      input.expectedThreadRevision,
      input.operation,
    ]);
    let desiredChanged = false;
    const result = this.database.transaction(() => {
      const target = this.#threadTarget(scope, applicationThreadId);
      const current = this.#settings.find(scope, applicationThreadId);
      if (
        target.backendInstanceId !== this.#backendInstanceId ||
        target.revision !== input.expectedThreadRevision ||
        !current?.desired ||
        current.revision !== input.operation.expectedFeatureRevision
      ) {
        throw new DomainError(
          "conflict",
          "The Codex thread or execution settings changed in another client.",
        );
      }
      const executionPolicy = applyExecutionPolicyAction(
        current.desired,
        input.operation.actionId,
        this.#executionPolicy,
      );
      const receipt = this.#featureMutations.prepare(scope, {
        applicationThreadId,
        mutationId: input.mutationId,
        featureId: input.operation.feature.featureId,
        schemaVersion: input.operation.feature.schemaVersion,
        actionId: input.operation.actionId,
        requestFingerprint,
        expectedThreadRevision: input.expectedThreadRevision,
        expectedFeatureRevision: input.operation.expectedFeatureRevision,
        desiredPostcondition: { executionPolicy },
        now: input.now,
      });
      if (receipt.state === "accepted") {
        return { applicationOperationId: receipt.mutationId };
      }
      if (receipt.state !== "prepared") {
        throw new DomainError(
          "conflict",
          "The provider feature mutation requires recovery.",
        );
      }
      this.#settings.updateDesired(scope, applicationThreadId, {
        expectedRevision: current.revision,
        desired: { ...current.desired, ...executionPolicy },
        now: input.now,
      });
      desiredChanged = true;
      this.#advanceThread(scope, applicationThreadId, {
        expectedRevision: input.expectedThreadRevision,
        now: input.now,
      });
      this.#featureMutations.accept(scope, input.mutationId, {
        requestFingerprint,
        result: { executionPolicy },
        now: input.now,
      });
      return { applicationOperationId: input.mutationId };
    })();
    if (desiredChanged) {
      const desired = this.#settings.find(scope, applicationThreadId)?.desired;
      if (desired) {
        await this.#syncDesired(scope, applicationThreadId, desired);
      }
    }
    return result;
  }

  async #performFastModeFeature(
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
    if (
      (input.operation.actionId !== "enable" &&
        input.operation.actionId !== "disable") ||
      input.operation.arguments !== null
    ) {
      throw new DomainError(
        "invalid_transition",
        "The Codex Fast mode action is invalid.",
      );
    }
    this.#assertNoEnabledAutomation(scope, applicationThreadId);
    const desiredServiceTier =
      input.operation.actionId === "enable" ? "fast" : "standard";
    const requestFingerprint = fingerprint([
      applicationThreadId,
      input.expectedThreadRevision,
      input.operation,
    ]);
    let shouldSyncDesired = false;
    const result = this.database.transaction(() => {
      const target = this.#threadTarget(scope, applicationThreadId);
      const current = this.#settings.find(scope, applicationThreadId);
      if (
        target.backendInstanceId !== this.#backendInstanceId ||
        target.revision !== input.expectedThreadRevision ||
        !current?.desired ||
        current.revision !== input.operation.expectedFeatureRevision
      ) {
        throw new DomainError(
          "conflict",
          "The Codex thread or Fast mode selection changed in another client.",
        );
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
        desiredPostcondition: { serviceTier: desiredServiceTier },
        now: input.now,
      });
      if (receipt.state === "accepted") {
        return { applicationOperationId: receipt.mutationId };
      }
      if (receipt.state !== "prepared") {
        throw new DomainError(
          "conflict",
          "The Fast mode mutation requires recovery.",
        );
      }
      this.#settings.updateDesired(scope, applicationThreadId, {
        expectedRevision: current.revision,
        desired: { ...current.desired, serviceTier: desiredServiceTier },
        now: input.now,
      });
      shouldSyncDesired =
        target.backingState === "bound" &&
        current.desired.serviceTier !== desiredServiceTier;
      this.#advanceThread(scope, applicationThreadId, {
        expectedRevision: input.expectedThreadRevision,
        now: input.now,
      });
      this.#featureMutations.accept(scope, input.mutationId, {
        requestFingerprint,
        result: { serviceTier: desiredServiceTier },
        now: input.now,
      });
      return { applicationOperationId: input.mutationId };
    })();
    if (shouldSyncDesired) {
      const desired = this.#settings.find(scope, applicationThreadId)?.desired;
      if (desired) {
        // The durable desired selection and accepted receipt are authoritative.
        // A raced daemon/TUI boundary leaves presentation pending and is
        // retried on the next attach; it must not turn an accepted local
        // mutation into an apparent rejection.
        await this.#syncDesired(scope, applicationThreadId, desired).catch(
          () => undefined,
        );
      }
    }
    return result;
  }

  async #syncDesired(
    scope: RequestScope,
    applicationThreadId: string,
    desired: CodexExecutionSettingsTuple,
  ): Promise<void> {
    const updates: Promise<unknown>[] = [];
    if (this.#fastModeRuntime) {
      updates.push(
        this.#fastModeRuntime.syncServiceTier(
          scope,
          applicationThreadId,
          desired.serviceTier,
        ).catch(() => undefined),
      );
    }
    if (this.#managedTui) {
      updates.push(
        this.#managedTui.syncSettings(scope, applicationThreadId, desired),
      );
    }
    await Promise.all(updates);
  }

  async #performTuiFeature(
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
      readonly mutateExternal?: (input: {
        readonly featureId: string;
        readonly schemaVersion: number;
        readonly actionId: string;
        readonly arguments: unknown;
      }) => Promise<{
        readonly outcome: "accepted" | "uncertain" | "rejected";
        readonly projectedState?: unknown;
        readonly safeMessage?: string;
      }>;
    },
  ): Promise<
    | { readonly applicationOperationId: string }
    | { readonly status: "recovery_required"; readonly retryable: boolean }
  > {
    if (!input.mutateExternal) {
      throw new DomainError(
        "invalid_transition",
        "The managed Codex TUI runtime is unavailable.",
      );
    }
    const actionId = input.operation.actionId as CodexTuiActionId;
    if (
      (actionId !== "start" && actionId !== "stop") ||
      input.operation.arguments !== null
    ) {
      throw new DomainError(
        "invalid_transition",
        "The managed Codex TUI action is invalid.",
      );
    }
    const target = this.#threadTarget(scope, applicationThreadId);
    if (
      target.backendInstanceId !== this.#backendInstanceId ||
      target.backingState !== "bound" ||
      target.revision !== input.expectedThreadRevision
    ) {
      throw new DomainError(
        "conflict",
        "The Codex thread changed in another client.",
      );
    }
    const requestFingerprint = fingerprint([
      applicationThreadId,
      input.expectedThreadRevision,
      input.operation,
    ]);
    const receipt = this.#featureMutations.prepare(scope, {
      applicationThreadId,
      mutationId: input.mutationId,
      featureId: input.operation.feature.featureId,
      schemaVersion: input.operation.feature.schemaVersion,
      actionId,
      requestFingerprint,
      expectedThreadRevision: input.expectedThreadRevision,
      expectedFeatureRevision: input.operation.expectedFeatureRevision,
      desiredPostcondition: {
        lifecycle: actionId === "start" ? "running" : "stopped",
      },
      now: input.now,
    });
    if (receipt.state === "accepted") {
      // Receipt replay is historical control-plane evidence only. Never call
      // mutateExternal here: a replay after restart must not respawn a TUI.
      return { applicationOperationId: receipt.mutationId };
    }
    if (receipt.state !== "prepared") {
      return { status: "recovery_required", retryable: false };
    }
    const priorResourceGeneration = this.#managedTui?.presentation(
      scope,
      applicationThreadId,
    ).state.resourceGeneration;
    const outcome = await input.mutateExternal({
      featureId: input.operation.feature.featureId,
      schemaVersion: input.operation.feature.schemaVersion,
      actionId,
      arguments: null,
    });
    if (outcome.outcome === "uncertain") {
      this.#featureMutations.markUncertain(scope, input.mutationId, {
        requestFingerprint,
        result: { diagnostic: "managed_tui_outcome_unknown" },
        now: input.now,
      });
      return { status: "recovery_required", retryable: false };
    }
    if (outcome.outcome !== "accepted") {
      throw new DomainError(
        "invalid_transition",
        outcome.safeMessage ?? "The managed Codex TUI action was rejected.",
      );
    }
    const projected = outcome.projectedState as CodexTuiStateV1 | undefined;
    const resourceGeneration =
      projected?.resourceGeneration ?? priorResourceGeneration;
    this.#featureMutations.accept(scope, input.mutationId, {
      requestFingerprint,
      result: {
        lifecycle:
          projected?.lifecycle ??
          (actionId === "start" ? "running" : "stopped"),
        ...(resourceGeneration === undefined || resourceGeneration === null
          ? {}
          : { resourceGeneration }),
      },
      now: input.now,
    });
    return { applicationOperationId: input.mutationId };
  }

  async #performGoalFeature(
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
      readonly mutateExternal?: (input: {
        readonly featureId: string;
        readonly schemaVersion: number;
        readonly actionId: string;
        readonly arguments: unknown;
      }) => Promise<{
        readonly outcome: "accepted" | "uncertain" | "rejected";
        readonly projectedState?: unknown;
        readonly safeMessage?: string;
      }>;
    },
  ): Promise<
    | { readonly applicationOperationId: string }
    | { readonly status: "recovery_required"; readonly retryable: boolean }
  > {
    if (!this.#goalSessions || !input.mutateExternal) {
      throw new DomainError(
        "invalid_transition",
        "The Codex Goal mutation path is unavailable.",
      );
    }
    const actionId = input.operation.actionId as CodexGoalActionId;
    if (
      actionId !== "create" &&
      actionId !== "pause" &&
      actionId !== "resume" &&
      actionId !== "clear"
    ) {
      throw new DomainError(
        "invalid_transition",
        "The Codex Goal action is not registered.",
      );
    }
    const target = this.#threadTarget(scope, applicationThreadId);
    const projection = this.#goalSessions.projection(
      scope,
      applicationThreadId,
    );
    if (
      target.backendInstanceId !== this.#backendInstanceId ||
      target.backingState !== "bound" ||
      target.revision !== input.expectedThreadRevision ||
      !projection ||
      projection.availability !== "available" ||
      projection.revision !== input.operation.expectedFeatureRevision
    ) {
      throw new DomainError(
        "conflict",
        "The Codex thread or Goal state changed in another client.",
      );
    }
    let desired;
    try {
      desired = desiredPostconditionForCodexGoalAction({
        actionId,
        arguments: input.operation.arguments,
        currentState: projection.state,
      });
    } catch {
      throw new DomainError(
        "invalid_transition",
        "The Goal action arguments are invalid.",
      );
    }
    const requestFingerprint = fingerprint([
      applicationThreadId,
      input.expectedThreadRevision,
      input.operation,
    ]);
    const receipt = this.#featureMutations.prepare(scope, {
      applicationThreadId,
      mutationId: input.mutationId,
      featureId: input.operation.feature.featureId,
      schemaVersion: input.operation.feature.schemaVersion,
      actionId: input.operation.actionId,
      requestFingerprint,
      expectedThreadRevision: input.expectedThreadRevision,
      expectedFeatureRevision: input.operation.expectedFeatureRevision,
      desiredPostcondition: desired as unknown as Record<string, unknown>,
      now: input.now,
    });
    if (receipt.state === "accepted") {
      return { applicationOperationId: receipt.mutationId };
    }
    if (receipt.state !== "prepared") {
      throw new DomainError(
        "conflict",
        "The provider feature mutation requires recovery.",
      );
    }

    const outcome = await input.mutateExternal({
      featureId: input.operation.feature.featureId,
      schemaVersion: input.operation.feature.schemaVersion,
      actionId: input.operation.actionId,
      arguments: input.operation.arguments,
    });

    if (outcome.outcome === "accepted") {
      const projected = (outcome.projectedState ?? {
        state: "unset",
      }) as CodexGoalStateV1;
      this.database.transaction(() => {
        this.#advanceThread(scope, applicationThreadId, {
          expectedRevision: input.expectedThreadRevision,
          now: input.now,
        });
        this.#featureMutations.accept(scope, input.mutationId, {
          requestFingerprint,
          // Never persist full objective text — receipts are capped at 8 KiB.
          result: boundedCodexGoalReceiptResult(projected),
          now: input.now,
        });
      })();
      return { applicationOperationId: input.mutationId };
    }

    if (outcome.outcome === "uncertain") {
      const projected = outcome.projectedState as CodexGoalStateV1 | undefined;
      this.#featureMutations.markUncertain(scope, input.mutationId, {
        requestFingerprint,
        result: {
          reason: outcome.safeMessage ?? "goal_mutation_uncertain",
          ...(projected
            ? { projection: boundedCodexGoalReceiptResult(projected) }
            : {}),
        },
        now: input.now,
      });
      return { status: "recovery_required", retryable: true };
    }

    // Pre-boundary rejection — leave prepared receipt for potential replay
    // with the same fingerprint only after a successful path; reject by
    // leaving it prepared is unsafe. Mark uncertain only after boundary.
    // Proven pre-boundary failures do not consume the mutation id as
    // accepted; throw so the client can retry with a fresh request.
    throw new DomainError(
      "invalid_transition",
      outcome.safeMessage ?? "The Goal action was rejected.",
    );
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
      throw new DomainError(
        "conflict",
        "The provider feature mutation ID is already used by another request.",
      );
    }
    if (existing.state !== "accepted") {
      throw new DomainError(
        "conflict",
        "The provider feature mutation requires recovery.",
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
      readonly operation: Extract<
        PerformOperation,
        { readonly action: "set_setting" }
      >;
      readonly now: number;
    },
  ): void {
    // Codex desired settings are local next-turn mutations that never cross
    // the driver action boundary, so only a staged fence is truthful here.
    if (
      input.settingsGuard.kind !== "staged" ||
      input.operation.value === null ||
      input.operation.settingId === "tool_access"
    ) {
      throw new DomainError(
        "invalid_transition",
        "The Codex setting mutation is invalid.",
      );
    }
    const expectedSettingsRevision = input.settingsGuard.expectedRevision;
    const settingValue = input.operation.value;
    this.#assertNoEnabledAutomation(scope, applicationThreadId);
    this.database.transaction(() => {
      const target = this.#threadTarget(scope, applicationThreadId);
      const current = this.#settings.find(scope, applicationThreadId);
      if (
        target.backendInstanceId !== this.#backendInstanceId ||
        target.revision !== input.expectedThreadRevision ||
        !current ||
        current.revision !== expectedSettingsRevision
      ) {
        throw new DomainError(
          "conflict",
          "The Codex thread or settings changed in another client.",
        );
      }
      if (!current.desired && input.operation.settingId !== "model") {
        throw new DomainError(
          "invalid_transition",
          "Choose an available Codex model to resolve the imported settings.",
        );
      }
      const desired =
        input.operation.settingId === "model"
          ? (() => {
              const model = decodeCodexModelSetting(settingValue);
              return {
                ...(current.desired ?? {
                  ...this.#defaultExecutionPolicy(target),
                }),
                model: model.modelId,
                reasoningEffort: model.defaultReasoningEffort,
                serviceTier:
                  current.desired?.serviceTier === "fast" &&
                  model.supportsFastMode
                    ? "fast"
                    : current.desired
                      ? "standard"
                      : model.defaultServiceTier,
              };
            })()
          : { ...current.desired!, reasoningEffort: settingValue };
      if (
        !this.#modelPolicy.isSelectionAllowed({
          modelId: desired.model,
          reasoningEffort: desired.reasoningEffort,
        })
      ) {
        throw new DomainError(
          "invalid_transition",
          "This model or reasoning effort is not allowed by the backend policy.",
        );
      }
      this.#settings.updateDesired(scope, applicationThreadId, {
        expectedRevision: current.revision,
        desired,
        now: input.now,
      });
      this.#advanceThread(scope, applicationThreadId, {
        expectedRevision: input.expectedThreadRevision,
        now: input.now,
      });
    })();
  }

  #advanceThread(
    scope: RequestScope,
    applicationThreadId: string,
    input: { readonly expectedRevision: number; readonly now: number },
  ): void {
    const changed = this.database
      .prepare(
        `
      UPDATE application_threads
      SET revision = revision + 1, updated_at = max(updated_at, ?)
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        AND backend_instance_id = ? AND revision = ?
        AND backing_state IN ('unbound', 'bound')
    `,
      )
      .run(
        input.now,
        scope.tenantId,
        scope.principalId,
        applicationThreadId,
        this.#backendInstanceId,
        input.expectedRevision,
      );
    if (changed.changes !== 1) {
      throw new DomainError("conflict", "The Codex thread changed.");
    }
    const generation = this.database
      .prepare(
        `
      UPDATE principal_generations
      SET inventory_generation = inventory_generation + 1
      WHERE tenant_id = ? AND principal_id = ?
    `,
      )
      .run(scope.tenantId, scope.principalId);
    if (generation.changes !== 1) {
      throw new Error("codex_action_inventory_generation_missing");
    }
  }

  #assertNoEnabledAutomation(
    scope: RequestScope,
    applicationThreadId: string,
  ): void {
    const attached = this.database
      .prepare(
        `
      SELECT 1 AS present
      FROM automation_definitions
      WHERE tenant_id = ? AND owner_principal_id = ?
        AND anchor_thread_id = ? AND enabled = 1 AND deleted_at IS NULL
      LIMIT 1
    `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId);
    if (attached) {
      throw new DomainError(
        "invalid_transition",
        "Codex execution settings cannot change while an automation is enabled.",
      );
    }
  }

  #threadTarget(
    scope: RequestScope,
    applicationThreadId: string,
  ): ThreadTarget {
    const target = this.database
      .prepare(
        `
          SELECT backend_instance_id AS backendInstanceId,
            connection_profile_id AS connectionProfileId,
            backing_state AS backingState, revision
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, applicationThreadId) as
      ThreadTarget | undefined;
    if (!target) {
      throw new DomainError("not_found", "The Codex thread was not found.");
    }
    return target;
  }

  #defaultExecutionPolicy(target: ThreadTarget): CodexExecutionPolicySelection {
    const policy = this.#defaultExecutionPolicyByConnectionId.get(
      target.connectionProfileId,
    );
    if (!policy) {
      throw new DomainError(
        "invalid_transition",
        "The Codex connection has no allowed execution-policy default.",
      );
    }
    return policy;
  }

  #assertScope(scope: RequestScope): void {
    if (
      scope.tenantId !== this.#scope.tenantId ||
      scope.principalId !== this.#scope.principalId
    ) {
      throw targetMismatch();
    }
  }
}

function settingsUnavailable(): DomainError {
  return new DomainError(
    "invalid_transition",
    "Codex settings must be staged through the local thread settings boundary.",
  );
}

function applyExecutionPolicyAction(
  current: CodexExecutionPolicySelection,
  actionId: string,
  allowed: CodexExecutionPolicyAllowlist,
): CodexExecutionPolicySelection {
  let next: CodexExecutionPolicySelection;
  let selectedAllowed: boolean;
  switch (actionId) {
    case "set_sandbox_read_only":
      next = { ...current, sandboxMode: "read-only" };
      selectedAllowed = allowed.allowedSandboxModes.includes("read-only");
      break;
    case "set_sandbox_workspace":
      next = { ...current, sandboxMode: "workspace-write" };
      selectedAllowed = allowed.allowedSandboxModes.includes("workspace-write");
      break;
    case "set_sandbox_unrestricted":
      next = {
        ...current,
        sandboxMode: "danger-full-access",
        networkAccess: "enabled",
      };
      selectedAllowed =
        allowed.allowedSandboxModes.includes("danger-full-access") &&
        allowed.allowedNetworkAccess.includes("enabled");
      break;
    case "set_network_disabled":
      next = { ...current, networkAccess: "disabled" };
      selectedAllowed = allowed.allowedNetworkAccess.includes("disabled");
      break;
    case "set_network_enabled":
      next = { ...current, networkAccess: "enabled" };
      selectedAllowed = allowed.allowedNetworkAccess.includes("enabled");
      break;
    case "set_approval_untrusted":
      next = { ...current, approvalPolicy: "untrusted" };
      selectedAllowed = allowed.allowedApprovalPolicies.includes("untrusted");
      break;
    case "set_approval_on_request":
      next = { ...current, approvalPolicy: "on-request" };
      selectedAllowed = allowed.allowedApprovalPolicies.includes("on-request");
      break;
    case "set_approval_never":
      next = { ...current, approvalPolicy: "never" };
      selectedAllowed = allowed.allowedApprovalPolicies.includes("never");
      break;
    case "set_reviewer_user":
      next = { ...current, approvalReviewer: "user" };
      selectedAllowed = allowed.allowedApprovalReviewers.includes("user");
      break;
    case "set_reviewer_auto_review":
      next = { ...current, approvalReviewer: "auto_review" };
      selectedAllowed =
        allowed.allowedApprovalReviewers.includes("auto_review");
      break;
    default:
      throw new DomainError(
        "invalid_transition",
        "The Codex execution-setting action is not registered.",
      );
  }
  if (!selectedAllowed) {
    throw new DomainError(
      "invalid_transition",
      "The selected Codex execution setting is not allowed by deployment policy.",
    );
  }
  try {
    assertCodexExecutionPolicySelection(next);
  } catch {
    throw new DomainError(
      "invalid_transition",
      "The selected Codex execution-setting combination is invalid.",
    );
  }
  return next;
}

function fingerprint(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function targetMismatch(): DomainError {
  return new DomainError(
    "not_found",
    "The Codex thread action target was not found.",
  );
}
