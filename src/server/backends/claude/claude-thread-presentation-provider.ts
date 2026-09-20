import { createHash } from "node:crypto";
import type {
  ComposerCommandDescriptor,
  ComposerSkillDescriptor,
  SettingDescriptor,
  ThreadSettingsSnapshot,
} from "../../../shared/protocol/conversation.js";
import type { ThreadBackendPresentationProvider } from "../../conversations/database-thread-application-readers.js";
import type { ThreadApplicationPresentation } from "../../conversations/thread-application-service.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { BACKEND_BRANDS } from "../contracts.js";
import { compiledProviderFeatureRegistry } from "../../provider-features/compiled-provider-feature-registry.js";
import type { ClaudePermissionPolicy } from "./claude-permission-policy.js";
import {
  CLAUDE_PERMISSIONS_FEATURE_REF,
  claudePermissionActionIds,
  type ClaudePermissionsStateV1,
} from "./claude-permissions-feature.js";
import type { ClaudeModelEffortCatalog } from "./claude-model-effort-catalog.js";
import type { ClaudeThreadRepository } from "./claude-thread-repository.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";

export class ClaudeThreadPresentationProvider implements ThreadBackendPresentationProvider {
  constructor(
    readonly settings: ClaudeThreadRepository,
    readonly modelEfforts: ClaudeModelEffortCatalog,
    readonly permissionPolicy: ClaudePermissionPolicy,
    readonly modelPolicy: CompiledBackendModelPolicy,
  ) {}

  async read(
    input: Parameters<ThreadBackendPresentationProvider["read"]>[0],
  ): Promise<ThreadApplicationPresentation> {
    if (
      input.backend.kind !== "claude_agent_sdk" ||
      input.connection.kind !== "claude_agent_sdk" ||
      (input.catalog !== undefined && input.workspace === undefined)
    ) {
      throw new Error("claude_thread_presentation_target_invalid");
    }
    const settings = this.settings.get(input.scope, input.applicationThreadId);
    const thread = this.settings.database
      .prepare(
        `SELECT backing_state AS backingState
         FROM application_threads
         WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(
        input.scope.tenantId,
        input.scope.principalId,
        input.applicationThreadId,
      ) as { readonly backingState: string } | undefined;
    if (!thread) throw new Error("claude_thread_presentation_missing");

    const catalog = input.catalog ?? {
      models: [],
      commands: [],
      skills: [],
      notices: [],
    };
    const catalogKnown = input.catalog !== undefined;
    const catalogModels = catalog.models
      .filter(({ provider }) => provider === input.connection.id)
      .flatMap((model) => {
        const supportedReasoningEfforts =
          this.modelPolicy.filterReasoningEfforts(
            { modelId: model.id },
            model.supportedReasoningEfforts ?? [],
          );
        const advertised = model.supportedReasoningEfforts ?? [];
        return advertised.length > 0
          ? supportedReasoningEfforts.length > 0
            ? [{ ...model, supportedReasoningEfforts }]
            : []
          : this.modelPolicy.isModelWithoutReasoningEffortAllowed({
                modelId: model.id,
              })
            ? [{ ...model, supportedReasoningEfforts: [] }]
            : [];
      })
      .slice(0, 512);
    if (catalogKnown) {
      this.modelEfforts.replace(
        input.applicationThreadId,
        input.connection.id,
        catalogModels,
      );
    }
    const desiredModel = catalogModels.find(({ id }) => id === settings.model);
    const effectiveModelId =
      settings.effectiveModelState === "confirmed"
        ? settings.effectiveModel
        : null;
    const effectiveDescriptor = catalogModels.find(
      ({ provider, id }) =>
        provider === input.connection.id && id === effectiveModelId,
    );
    const modelOptions = catalogModels.map((model) => ({
      value: model.id,
      label: boundDisplayText(model.label),
      available: true,
    }));
    const desiredModelValue = safeModelSettingValue(settings.model);
    if (
      desiredModelValue &&
      !modelOptions.some(({ value }) => value === desiredModelValue)
    ) {
      modelOptions.push({
        value: desiredModelValue,
        label: boundDisplayText(
          catalogKnown ? `${settings.model} (unavailable)` : settings.model,
        ),
        available: !catalogKnown,
      });
    }
    const efforts = desiredModel?.supportedReasoningEfforts ?? [];
    const effortOptions = efforts.map((effort) => ({
      value: effort,
      label: boundDisplayText(effortLabel(effort)),
      available: true,
    }));
    if (
      settings.effort &&
      !effortOptions.some(({ value }) => value === settings.effort)
    ) {
      effortOptions.push({
        value: settings.effort,
        label: boundDisplayText(
          catalogKnown
            ? `${effortLabel(settings.effort)} (unavailable)`
            : effortLabel(settings.effort),
        ),
        available: !catalogKnown,
      });
    }
    const settingDescriptors: SettingDescriptor[] = [
      {
        id: "model",
        label: boundDisplayText("Model"),
        requiredForFirstSubmission: true,
        available: catalogModels.length > 0,
        ...(catalogModels.length === 0
          ? {
              unavailableReason: boundDisplayText(
                catalogKnown
                  ? this.modelPolicy.policy.type === "catalog"
                    ? "No Claude models are currently available."
                    : "No models allowed by this backend policy are currently available."
                  : "Refreshing the Claude model catalog.",
              ),
            }
          : {}),
        options: modelOptions,
      },
      {
        id: "thinking_level",
        label: boundDisplayText("Effort"),
        requiredForFirstSubmission: efforts.length > 0,
        available: efforts.length > 0,
        ...(efforts.length === 0
          ? {
              unavailableReason: boundDisplayText(
                desiredModel
                  ? "The selected Claude model does not advertise effort levels."
                  : "Choose an available Claude model first.",
              ),
            }
          : {}),
        options: effortOptions,
      },
    ];

    const unbound = thread.backingState === "unbound";
    const effectiveModelValue = safeModelSettingValue(effectiveModelId);
    const normalizedSettings: ThreadSettingsSnapshot = {
      revision: settings.revision,
      values: [
        {
          id: "model",
          desiredValue: desiredModelValue,
          effectiveValue: effectiveModelValue,
          applicationState: settingState(
            unbound,
            desiredModelValue,
            effectiveModelValue ?? undefined,
          ),
        },
        {
          id: "thinking_level",
          desiredValue: settings.effort,
          effectiveValue:
            settings.effectiveEffortState === "confirmed"
              ? settings.effectiveEffort
              : null,
          applicationState: settingState(
            unbound,
            settings.effort,
            settings.effectiveEffortState === "confirmed"
              ? settings.effectiveEffort
              : undefined,
          ),
        },
      ],
    };
    const permissionState: ClaudePermissionsStateV1 = {
      desired: settings.permissionMode,
      effective:
        settings.effectivePermissionClassification === "recognized"
          ? settings.effectivePermissionMode
          : null,
      effectiveState: settings.effectivePermissionState,
    };
    const permissionCapability = compiledProviderFeatureRegistry.capability(
      CLAUDE_PERMISSIONS_FEATURE_REF,
      "claude_agent_sdk",
      {
        revision: settings.revision,
        availability: "available",
        allowedOperationIds: claudePermissionActionIds(
          this.permissionPolicy.allowedModes,
        ),
      },
    );
    const permissionStateEnvelope =
      compiledProviderFeatureRegistry.stateEnvelope({
        ref: CLAUDE_PERMISSIONS_FEATURE_REF,
        backendKind: "claude_agent_sdk",
        revision: settings.revision,
        providerState: permissionState,
      });
    const composerCommands = projectCommands(catalog.commands);
    const skills = projectSkills(catalog.skills);
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          backendRevision: input.backend.configurationRevision,
          connectionRevision: input.connection.configurationRevision,
          settings,
          catalogModels,
          commands: catalog.commands,
          skills: catalog.skills,
          permissionPolicy: this.permissionPolicy,
          modelPolicy: this.modelPolicy.policy,
        }),
      )
      .digest("base64url")
      .slice(0, 40);
    return {
      revision: `claude_${revision}`,
      backend: {
        label: boundDisplayText(input.backend.label),
        brand: BACKEND_BRANDS.claude_agent_sdk,
        ...(effectiveDescriptor || desiredModel
          ? {
              modelLabel: boundDisplayText(
                (effectiveDescriptor ?? desiredModel)!.label,
              ),
            }
          : {}),
      },
      interactionMode: "interactive",
      settings: normalizedSettings,
      settingDescriptors,
      nextTurnSettingIds: ["model", "thinking_level"],
      automationAllowed:
        settings.model !== null &&
        isModelEffortAllowed(
          this.modelPolicy,
          settings.model,
          settings.effort,
        ) &&
        (!catalogKnown ||
          catalogModels.some(
            (model) =>
              model.id === settings.model &&
              (settings.effort === null
                ? (model.supportedReasoningEfforts?.length ?? 0) === 0
                : model.supportedReasoningEfforts?.includes(settings.effort) ===
                  true),
          )),
      providerFeatureCapabilities: [permissionCapability],
      providerFeatureStates: [permissionStateEnvelope],
      composerCommands,
      skills,
    };
  }
}

function settingState(
  unbound: boolean,
  desired: string | null,
  effective: string | null | undefined,
): "draft" | "effective" | "pending_next_turn" {
  if (unbound) return "draft";
  return effective !== undefined && desired === effective
    ? "effective"
    : "pending_next_turn";
}

function safeModelSettingValue(
  model: string | null | undefined,
): string | null {
  return model && model.length <= 240 ? model : null;
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

function effortLabel(value: string): string {
  if (value === "xhigh") return "Extra High";
  if (value === "max") return "Maximum";
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function projectCommands(
  commands: Parameters<
    ThreadBackendPresentationProvider["read"]
  >[0] extends never
    ? never
    : readonly import("../contracts.js").BackendComposerCommand[],
): ComposerCommandDescriptor[] {
  const seen = new Set<string>();
  return commands
    .flatMap((command) => {
      if (
        !command.invocation.startsWith("/") ||
        command.invocation.length < 2 ||
        command.invocation.length > 240 ||
        seen.has(command.invocation)
      ) {
        return [];
      }
      seen.add(command.invocation);
      return [
        {
          invocation: command.invocation,
          source: command.source,
          ...(command.description
            ? { description: boundDisplayText(command.description) }
            : {}),
          ...(command.argumentHint
            ? { argumentHint: boundDisplayText(command.argumentHint) }
            : {}),
        },
      ];
    })
    .slice(0, 512);
}

function projectSkills(
  skills: readonly import("../contracts.js").BackendSkillDescriptor[],
): ComposerSkillDescriptor[] {
  const seen = new Set<string>();
  return skills
    .flatMap((skill) => {
      if (
        !skill.id ||
        skill.id.length > 160 ||
        !skill.name ||
        !skill.reference ||
        skill.reference.length > 240 ||
        seen.has(skill.id)
      ) {
        return [];
      }
      seen.add(skill.id);
      return [
        {
          id: skill.id,
          name: boundDisplayText(skill.name),
          ...(skill.displayName
            ? { displayName: boundDisplayText(skill.displayName) }
            : {}),
          reference: skill.reference,
          ...(skill.description
            ? { description: boundDisplayText(skill.description) }
            : {}),
        },
      ];
    })
    .slice(0, 512);
}
