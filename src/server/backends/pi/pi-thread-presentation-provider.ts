import { createHash } from "node:crypto";
import type {
  ComposerCommandDescriptor,
  ComposerSkillDescriptor,
  SettingDescriptor,
} from "../../../shared/protocol/conversation.js";
import type { PiConversationRepository } from "./pi-conversation-repository.js";
import type { ThreadBackendPresentationProvider } from "../../conversations/database-thread-application-readers.js";
import type { ThreadApplicationPresentation } from "../../conversations/thread-application-service.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { BACKEND_BRANDS } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";

/** Canonical Pi thinking levels in provider order. */
export const piThinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

const thinkingLevelLabels: Readonly<
  Record<(typeof piThinkingLevels)[number], string>
> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Maximum",
};

export function requirePiThinkingLevel(value: string): string {
  if (!(piThinkingLevels as readonly string[]).includes(value)) {
    throw new Error("pi_thinking_level_invalid");
  }
  return value;
}

export function encodePiModelSetting(
  provider: string,
  modelId: string,
): string {
  const encoded = `pi-model:${Buffer.from(
    JSON.stringify([provider, modelId]),
    "utf8",
  ).toString("base64url")}`;
  if (encoded.length > 240) throw new Error("pi_model_setting_too_long");
  return encoded;
}

export function decodePiModelSetting(value: string): {
  readonly provider: string;
  readonly modelId: string;
} {
  if (!value.startsWith("pi-model:")) {
    throw new Error("pi_model_setting_invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      Buffer.from(value.slice("pi-model:".length), "base64url").toString(
        "utf8",
      ),
    );
  } catch {
    throw new Error("pi_model_setting_invalid");
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== 2 ||
    decoded.some((part) => typeof part !== "string" || part.length === 0)
  ) {
    throw new Error("pi_model_setting_invalid");
  }
  return { provider: decoded[0] as string, modelId: decoded[1] as string };
}

export class PiThreadPresentationProvider implements ThreadBackendPresentationProvider {
  constructor(
    readonly persistence: PiConversationRepository,
    readonly modelPolicy: CompiledBackendModelPolicy,
  ) {}

  async read(
    input: Parameters<ThreadBackendPresentationProvider["read"]>[0],
  ): Promise<ThreadApplicationPresentation> {
    if (
      input.connection.kind !== "pi_sdk" ||
      input.backend.kind !== "pi" ||
      (input.catalog !== undefined && input.workspace === undefined)
    ) {
      throw new Error("pi_thread_presentation_target_invalid");
    }
    const settings = this.persistence.getSettings(
      input.scope,
      input.applicationThreadId,
    );
    const backingState = this.persistence.database
      .prepare(
        `
          SELECT backing_state AS backingState
          FROM application_threads
          WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?
        `,
      )
      .get(
        input.scope.tenantId,
        input.scope.principalId,
        input.applicationThreadId,
      ) as { readonly backingState: string } | undefined;
    if (!backingState) throw new Error("pi_thread_presentation_missing");
    const draft = backingState.backingState === "unbound";
    const catalog = input.catalog ?? {
      models: [],
      commands: [],
      skills: [],
      notices: [],
    };
    const catalogKnown = input.catalog !== undefined;
    const modelValues = new Set<string>();
    const models = [...catalog.models]
      .sort(
        (left, right) =>
          left.label.localeCompare(right.label) ||
          left.provider.localeCompare(right.provider) ||
          left.id.localeCompare(right.id),
      )
      .flatMap((model) => {
        const supportedReasoningEfforts = this.modelPolicy.filterReasoningEfforts(
          { providerId: model.provider, modelId: model.id },
          model.supportedReasoningEfforts ?? piThinkingLevels,
        );
        if (supportedReasoningEfforts.length === 0) return [];
        let value: string;
        try {
          value = encodePiModelSetting(model.provider, model.id);
        } catch {
          return [];
        }
        if (modelValues.has(value)) return [];
        modelValues.add(value);
        return [{ ...model, supportedReasoningEfforts, value }];
      })
      .slice(0, 512);
    const effectiveModel = input.effectiveSettings?.model;
    const presentedProvider =
      settings.modelProvider ?? effectiveModel?.provider;
    const presentedModelId = settings.modelId ?? effectiveModel?.id;
    const presentedThinkingLevel =
      settings.modelProvider && settings.modelId
        ? settings.thinkingLevel
        : (input.effectiveSettings?.thinkingLevel ?? settings.thinkingLevel);
    const effectiveProvider = effectiveModel?.provider ?? presentedProvider;
    const effectiveModelId = effectiveModel?.id ?? presentedModelId;
    const effectiveThinkingLevel =
      input.effectiveSettings?.thinkingLevel ?? settings.thinkingLevel;
    const selectedModel = models.find(
      ({ provider, id }) =>
        provider === presentedProvider && id === presentedModelId,
    );
    const modelValue = (() => {
      if (!presentedProvider || !presentedModelId) return null;
      try {
        return encodePiModelSetting(presentedProvider, presentedModelId);
      } catch {
        return null;
      }
    })();
    const effectiveModelValue = (() => {
      if (draft || !effectiveProvider || !effectiveModelId) return null;
      try {
        return encodePiModelSetting(effectiveProvider, effectiveModelId);
      } catch {
        return null;
      }
    })();
    const selectedTupleDeniedByPolicy =
      presentedProvider !== null &&
      presentedProvider !== undefined &&
      presentedModelId !== null &&
      presentedModelId !== undefined &&
      presentedThinkingLevel !== null &&
      !this.modelPolicy.isSelectionAllowed({
        providerId: presentedProvider,
        modelId: presentedModelId,
        reasoningEffort: presentedThinkingLevel,
      });
    const modelOptions = models.map((model) => ({
      value: model.value,
      label: boundDisplayText(model.label),
      available: true,
    }));
    if (
      modelValue &&
      !modelOptions.some(({ value }) => value === modelValue)
    ) {
      modelOptions.push({
        value: modelValue,
        label: boundDisplayText(
          catalogKnown
            ? selectedTupleDeniedByPolicy
              ? `${presentedProvider}/${presentedModelId} (not allowed by backend policy)`
              : `${presentedProvider}/${presentedModelId} (unavailable)`
            : `${presentedProvider}/${presentedModelId}`,
        ),
        available: !catalogKnown,
      });
    }
    const settingDescriptors: SettingDescriptor[] = [
      {
        id: "model",
        label: boundDisplayText("Model"),
        requiredForFirstSubmission: true,
        available: models.length > 0,
        ...(models.length === 0
          ? {
              unavailableReason: boundDisplayText(
                catalogKnown
                  ? "No Pi models are currently available."
                  : "Refreshing the Pi model catalog.",
              ),
            }
          : {}),
        options: modelOptions,
      },
      {
        id: "thinking_level",
        label: boundDisplayText("Thinking"),
        requiredForFirstSubmission: true,
        available:
          !catalogKnown ||
          (selectedModel !== undefined &&
            (selectedModel.supportedReasoningEfforts?.length ?? 1) > 0),
        // Gate levels by the selected model's provider-advertised support so
        // the browser cannot request a value Pi would silently clamp. Without
        // a known selected model no support claim exists, so every canonical
        // level stays available.
        options: piThinkingLevels.map((value) => ({
          value,
          label: boundDisplayText(
            value === presentedThinkingLevel && selectedTupleDeniedByPolicy
              ? `${thinkingLevelLabels[value]} (not allowed by backend policy)`
              : thinkingLevelLabels[value],
          ),
          available:
            selectedModel?.supportedReasoningEfforts?.includes(value) ?? true,
        })),
      },
      {
        id: "tool_access",
        label: boundDisplayText("Tool access"),
        requiredForFirstSubmission: false,
        available: true,
        options: [
          {
            value: "read_only",
            label: boundDisplayText("Read only"),
            available: true,
          },
          {
            value: "ask",
            label: boundDisplayText("Ask before changes"),
            available: true,
          },
          {
            value: "full",
            label: boundDisplayText("Full access"),
            available: true,
          },
        ],
      },
    ];
    const commandInvocations = new Set<string>();
    const composerCommands: ComposerCommandDescriptor[] = catalog.commands
      .flatMap((command) => {
        if (
          !command.invocation.startsWith("/") ||
          command.invocation.length < 2 ||
          command.invocation.length > 240 ||
          commandInvocations.has(command.invocation)
        ) {
          return [];
        }
        commandInvocations.add(command.invocation);
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
    const skillIds = new Set<string>();
    const skills: ComposerSkillDescriptor[] = catalog.skills
      .flatMap((skill) => {
        if (
          skill.id.length < 1 ||
          skill.id.length > 160 ||
          skill.name.length < 1 ||
          skill.reference.length < 1 ||
          skill.reference.length > 240 ||
          skillIds.has(skill.id)
        ) {
          return [];
        }
        skillIds.add(skill.id);
        return [{
          id: skill.id,
          name: boundDisplayText(skill.name),
          ...(skill.displayName
            ? { displayName: boundDisplayText(skill.displayName) }
            : {}),
          reference: skill.reference,
          ...(skill.description
            ? { description: boundDisplayText(skill.description) }
            : {}),
        }];
      })
      .slice(0, 512);
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          backendRevision: input.backend.configurationRevision,
          connectionRevision: input.connection.configurationRevision,
          settingsRevision: settings.revision,
          models,
          commands: catalog.commands,
          skills: catalog.skills,
        }),
      )
      .digest("base64url")
      .slice(0, 40);
    return {
      revision: `pi_${revision}`,
      backend: {
        label: boundDisplayText(input.backend.label),
        brand: BACKEND_BRANDS[input.backend.kind],
        ...(selectedModel
          ? { modelLabel: boundDisplayText(selectedModel.label) }
          : {}),
      },
      interactionMode: "interactive",
      settings: {
        revision: settings.revision,
        values: [
          {
            id: "model" as const,
            desiredValue: modelValue,
            effectiveValue: effectiveModelValue,
            applicationState: draft
              ? "draft" as const
              : modelValue === effectiveModelValue
                ? "effective" as const
                : "pending_next_turn" as const,
          },
          {
            id: "thinking_level" as const,
            desiredValue: presentedThinkingLevel,
            effectiveValue: draft ? null : effectiveThinkingLevel,
            applicationState: draft
              ? "draft" as const
              : presentedThinkingLevel === effectiveThinkingLevel
                ? "effective" as const
                : "pending_next_turn" as const,
          },
          {
            id: "tool_access" as const,
            desiredValue:
              input.effectiveSettings?.toolAccess ?? settings.toolMode,
            effectiveValue: draft
              ? null
              : (input.effectiveSettings?.toolAccess ?? settings.toolMode),
            applicationState: draft ? "draft" as const : "effective" as const,
          },
        ],
      },
      settingDescriptors,
      automationAllowed:
        settings.modelProvider !== null &&
        settings.modelId !== null &&
        settings.thinkingLevel !== null &&
        this.modelPolicy.isSelectionAllowed({
          providerId: settings.modelProvider,
          modelId: settings.modelId,
          reasoningEffort: settings.thinkingLevel,
        }) &&
        (!catalogKnown ||
          models.some(
            (model) =>
              model.provider === settings.modelProvider &&
              model.id === settings.modelId &&
              model.supportedReasoningEfforts?.includes(
                settings.thinkingLevel!,
              ) === true,
          )),
      providerFeatureCapabilities: [],
      providerFeatureStates: [],
      composerCommands,
      skills,
    };
  }
}
