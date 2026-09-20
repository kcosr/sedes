import { createHash } from "node:crypto";
import type {
  SettingDescriptor,
  ThreadSettingsSnapshot,
} from "../../../shared/protocol/conversation.js";
import type { ThreadBackendPresentationProvider } from "../../conversations/database-thread-application-readers.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { BACKEND_BRANDS } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { GrokModelEffortCatalog } from "./grok-model-effort-catalog.js";
import { encodeGrokModelSetting } from "./grok-setting-values.js";
import type { GrokThreadRepository } from "./grok-thread-repository.js";

export class GrokThreadPresentationProvider implements ThreadBackendPresentationProvider {
  constructor(
    readonly settings: GrokThreadRepository,
    readonly modelEfforts: GrokModelEffortCatalog,
    readonly modelPolicy: CompiledBackendModelPolicy,
  ) {}

  async read(input: Parameters<ThreadBackendPresentationProvider["read"]>[0]) {
    if (
      input.backend.kind !== "grok_build" ||
      input.connection.kind !== "grok_acp" ||
      (input.catalog !== undefined && input.workspace === undefined)
    ) {
      throw new Error("grok_thread_presentation_target_invalid");
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
    if (!thread) throw new Error("grok_thread_presentation_missing");

    const catalogKnown = input.catalog !== undefined;
    const models = (input.catalog?.models ?? [])
      .filter(({ provider }) => provider === input.connection.id)
      .flatMap((model) => {
        const supportedReasoningEfforts =
          this.modelPolicy.filterReasoningEfforts(
            { modelId: model.id },
            model.supportedReasoningEfforts ?? [],
          );
        return supportedReasoningEfforts.length > 0
          ? [{ ...model, supportedReasoningEfforts }]
          : [];
      })
      .slice(0, 512);
    if (catalogKnown) {
      this.modelEfforts.replace(
        input.applicationThreadId,
        input.connection.id,
        models,
      );
    }
    const desiredModel = models.find(({ id }) => id === settings.model);
    const effectiveModel = models.find(
      ({ id }) =>
        settings.effectiveState === "confirmed" &&
        id === settings.effectiveModel,
    );
    const modelOptions = models.flatMap((model) =>
      (model.supportedReasoningEfforts ?? []).flatMap((effort) => {
        try {
          return [
            {
              value: encodeGrokModelSetting(model.id, effort),
              label: boundDisplayText(
                model.supportedReasoningEfforts?.length === 1
                  ? model.label
                  : `${model.label} (${effortLabel(effort)})`,
              ),
              available: true,
            },
          ];
        } catch {
          return [];
        }
      }),
    );
    const desiredModelValue = safeModelValue(settings.model, settings.effort);
    if (
      desiredModelValue &&
      !modelOptions.some(({ value }) => value === desiredModelValue)
    ) {
      modelOptions.push({
        value: desiredModelValue,
        label: boundDisplayText(
          catalogKnown
            ? `${settings.model} (unavailable)`
            : (settings.model ?? "Grok model"),
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
    const unbound = thread.backingState === "unbound";
    const mutable = unbound && models.length > 0;
    const boundReason = boundDisplayText(
      "Grok model and effort are fixed when the native conversation is created. Create a new thread to use another selection.",
    );
    const settingDescriptors: SettingDescriptor[] = [
      {
        id: "model",
        label: boundDisplayText("Model"),
        requiredForFirstSubmission: true,
        available: mutable,
        ...(!mutable
          ? {
              unavailableReason: unbound
                ? boundDisplayText(
                    catalogKnown
                      ? "No models allowed by this backend policy are currently available."
                      : "Refreshing the Grok model catalog.",
                  )
                : boundReason,
            }
          : {}),
        options: modelOptions,
      },
      {
        id: "thinking_level",
        label: boundDisplayText("Effort"),
        requiredForFirstSubmission: true,
        available: unbound && efforts.length > 0,
        ...(!(unbound && efforts.length > 0)
          ? {
              unavailableReason: unbound
                ? boundDisplayText(
                    desiredModel
                      ? "The selected Grok model does not advertise effort levels."
                      : "Choose an available Grok model first.",
                  )
                : boundReason,
            }
          : {}),
        options: effortOptions,
      },
    ];
    const effectiveModelValue =
      settings.effectiveState === "confirmed"
        ? safeModelValue(settings.effectiveModel, settings.effectiveEffort)
        : null;
    const normalizedSettings: ThreadSettingsSnapshot = {
      revision: settings.revision,
      values: [
        {
          id: "model",
          desiredValue: desiredModelValue,
          effectiveValue: effectiveModelValue,
          applicationState: unbound
            ? "draft"
            : desiredModelValue !== null &&
                desiredModelValue === effectiveModelValue
              ? "effective"
              : "pending_next_turn",
        },
        {
          id: "thinking_level",
          desiredValue: settings.effort,
          effectiveValue:
            settings.effectiveState === "confirmed"
              ? settings.effectiveEffort
              : null,
          applicationState: unbound
            ? "draft"
            : settings.effort !== null &&
                settings.effort === settings.effectiveEffort
              ? "effective"
              : "pending_next_turn",
        },
      ],
    };
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          backendRevision: input.backend.configurationRevision,
          connectionRevision: input.connection.configurationRevision,
          settings,
          models,
          modelPolicy: this.modelPolicy.policy,
          backingState: thread.backingState,
        }),
      )
      .digest("base64url")
      .slice(0, 40);
    return {
      revision: `grok_${revision}`,
      backend: {
        label: boundDisplayText(input.backend.label),
        brand: BACKEND_BRANDS.grok_build,
        ...(effectiveModel || desiredModel
          ? {
              modelLabel: boundDisplayText(
                (effectiveModel ?? desiredModel)!.label,
              ),
            }
          : {}),
      },
      interactionMode: "interactive" as const,
      settings: normalizedSettings,
      settingDescriptors,
      nextTurnSettingIds: [],
      automationAllowed: false,
      providerFeatureCapabilities: [],
      providerFeatureStates: [],
      composerCommands: [],
      skills: [],
    };
  }
}

function safeModelValue(
  model: string | null | undefined,
  effort: string | null | undefined,
): string | null {
  if (!model || !effort) return null;
  try {
    return encodeGrokModelSetting(model, effort);
  } catch {
    return null;
  }
}

function effortLabel(value: string): string {
  if (value === "xhigh") return "Extra High";
  if (value === "max") return "Maximum";
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
