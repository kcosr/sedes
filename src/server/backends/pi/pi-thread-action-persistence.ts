import type { ThreadApplicationOperation } from "../../../shared/protocol/api.js";
import type {
  BackendActionSettingsGuard,
  ProviderFeatureMutationActor,
  ThreadActionPersistenceProvider,
} from "../../conversations/thread-mutation-gateway.js";
import type { PiConversationRepository } from "./pi-conversation-repository.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { ConnectionSettingPreferenceRepository } from "../../db/repositories/connection-setting-preference-repository.js";
import type { RegisteredBackendActionInput } from "../contracts.js";
import {
  decodePiModelSetting,
  requirePiThinkingLevel,
} from "./pi-thread-presentation-provider.js";
import {
  QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY,
  type ProviderFeatureConcurrency,
} from "../../provider-features/contracts.js";
import type { ProviderFeatureRef } from "../../../shared/protocol/provider-feature.js";

type PerformOperation = Extract<
  ThreadApplicationOperation,
  { readonly kind: "perform" }
>;

export class PiThreadActionPersistence implements ThreadActionPersistenceProvider {
  async afterInterruptAccepted(
    _actor: ProviderFeatureMutationActor,
  ): Promise<boolean> {
    return false;
  }

  providerFeatureConcurrency(
    _feature: ProviderFeatureRef,
    _actionId: string,
  ): ProviderFeatureConcurrency {
    return QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY;
  }

  async afterPersistAccepted(): Promise<void> {
    // Pi settings are already applied through the provider action itself; it
    // has no separate managed-terminal settings synchronization path.
  }

  constructor(
    readonly pi: PiConversationRepository,
    readonly preferences: ConnectionSettingPreferenceRepository,
  ) {
    if (pi.database !== preferences.database) {
      throw new Error("pi_action_preference_database_mismatch");
    }
  }

  driverAction(
    operation: PerformOperation["operation"],
    applicationOperationId: string,
  ): RegisteredBackendActionInput {
    if (operation.action === "rename" || operation.action === "compact") {
      return { ...operation, applicationOperationId };
    }
    if (operation.action !== "set_setting") {
      throw new Error("pi_provider_feature_operation_invalid");
    }
    if (operation.value === null) {
      throw new Error("pi_setting_value_required");
    }
    if (operation.settingId === "model") {
      const model = decodePiModelSetting(operation.value);
      return {
        applicationOperationId,
        action: "set_model",
        provider: model.provider,
        modelId: model.modelId,
      };
    }
    if (operation.settingId === "thinking_level") {
      return {
        applicationOperationId,
        action: "set_thinking_level",
        level: requirePiThinkingLevel(operation.value),
      };
    }
    if (
      operation.value !== "read_only" &&
      operation.value !== "ask" &&
      operation.value !== "full"
    ) {
      throw new Error("pi_tool_mode_invalid");
    }
    return {
      applicationOperationId,
      action: "set_tool_access",
      mode: operation.value,
    };
  }

  persistAccepted(
    scope: RequestScope,
    applicationThreadId: string,
    input: {
      readonly mutationId: string;
      readonly expectedThreadRevision: number;
      readonly settingsGuard: BackendActionSettingsGuard;
      readonly operation: PerformOperation["operation"];
      readonly now: number;
    },
  ): void {
    if (input.operation.action === "rename") {
      const changed = this.pi.database
        .prepare(
          `
            UPDATE application_threads
            SET title = ?, revision = revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ?
          `,
        )
        .run(
          input.operation.title,
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.expectedThreadRevision,
        );
      if (changed.changes !== 1) {
        throw new Error("pi_action_thread_revision_changed");
      }
      const generation = this.pi.database
        .prepare(
          `
            UPDATE principal_generations
            SET inventory_generation = inventory_generation + 1
            WHERE tenant_id = ? AND principal_id = ?
          `,
        )
        .run(scope.tenantId, scope.principalId);
      if (generation.changes !== 1) {
        throw new Error("pi_action_inventory_generation_missing");
      }
      return;
    }
    if (input.operation.action === "compact") return;
    this.pi.database.transaction(() => {
      const current = this.pi.getSettings(scope, applicationThreadId);
      // A staged accept fences a not-yet-applied change against interleaved
      // durable writes. After proven application the current row is the only
      // truthful fence: the attached session's observed-settings adoption
      // may have advanced the revision while the action was in flight.
      const expectedSettingsRevision =
        input.settingsGuard.kind === "staged"
          ? input.settingsGuard.expectedRevision
          : current.revision;
      let modelProvider = current.modelProvider;
      let modelId = current.modelId;
      let thinkingLevel = current.thinkingLevel;
      let toolMode = current.toolMode;
      if (input.operation.action !== "set_setting") {
        throw new Error("pi_setting_operation_required");
      }
      if (input.operation.value === null) {
        throw new Error("pi_setting_value_required");
      }
      if (input.operation.settingId === "model") {
        const model = decodePiModelSetting(input.operation.value);
        modelProvider = model.provider;
        modelId = model.modelId;
        // Pi clamps thinking when its model changes. The application cannot
        // safely predict that model-specific result while staging or
        // recovering the action, so do not retain a potentially incompatible
        // overlay/default. A subsequent explicit thinking choice establishes
        // the new preference.
        thinkingLevel = null;
      } else if (input.operation.settingId === "thinking_level") {
        thinkingLevel = requirePiThinkingLevel(input.operation.value);
      } else {
        if (
          input.operation.value !== "read_only" &&
          input.operation.value !== "ask" &&
          input.operation.value !== "full"
        ) {
          throw new Error("pi_tool_mode_invalid");
        }
        toolMode = input.operation.value;
      }
      this.pi.updateSettings(scope, applicationThreadId, {
        expectedRevision: expectedSettingsRevision,
        modelProvider,
        modelId,
        thinkingLevel,
        toolMode,
      });
      const changed = this.pi.database
        .prepare(
          `
            UPDATE application_threads
            SET revision = revision + 1, updated_at = ?
            WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
              AND revision = ?
          `,
        )
        .run(
          input.now,
          scope.tenantId,
          scope.principalId,
          applicationThreadId,
          input.expectedThreadRevision,
        );
      if (changed.changes !== 1) {
        throw new Error("pi_action_thread_revision_changed");
      }
      if (
        input.operation.settingId === "model" ||
        input.operation.settingId === "thinking_level"
      ) {
        const target = this.pi.database
          .prepare(
            `
              SELECT connection_profile_id AS connectionProfileId
              FROM application_threads
              WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
            `,
          )
          .get(scope.tenantId, scope.principalId, applicationThreadId) as
          { readonly connectionProfileId: string } | undefined;
        if (!target) throw new Error("pi_action_thread_target_missing");
        this.preferences.save(
          scope,
          target.connectionProfileId,
          input.operation.settingId,
          input.operation.value,
          input.now,
        );
        if (input.operation.settingId === "model") {
          this.preferences.remove(
            scope,
            target.connectionProfileId,
            "thinking_level",
          );
        }
      }
    })();
  }
}
