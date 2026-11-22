import { createHash } from "node:crypto";
import type { SettingDescriptor, ThreadSettingsSnapshot } from "../../../shared/protocol/conversation.js";
import type { ThreadBackendPresentationProvider } from "../../conversations/database-thread-application-readers.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import type { ThreadApplicationPresentation } from "../../conversations/thread-application-service.js";
import { BACKEND_BRANDS } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import {
  antigravityAvailableModels, antigravityCatalogAllowsSelection, antigravityModelIsAllowed, encodeAntigravityModelSetting,
} from "./model-selection.js";
import type { AntigravityThreadRepository } from "./thread-repository.js";
import { AntigravityModeCatalog } from "./mode-catalog.js";
import { compiledProviderFeatureRegistry } from "../../provider-features/compiled-provider-feature-registry.js";
import { ANTIGRAVITY_KEEP_MODE_ACTION, ANTIGRAVITY_MODE_ACTIONS, ANTIGRAVITY_MODE_FEATURE_REF } from "./mode-feature.js";

export class AntigravityThreadPresentation implements ThreadBackendPresentationProvider {
  constructor(readonly settings: AntigravityThreadRepository, readonly modelPolicy: CompiledBackendModelPolicy,
    readonly modes: AntigravityModeCatalog = new AntigravityModeCatalog()) {}

  async read(input: Parameters<ThreadBackendPresentationProvider["read"]>[0]): Promise<ThreadApplicationPresentation> {
    const target = this.settings.assertConnection(input.scope, input.applicationThreadId, input.connection);
    if (input.backend.kind !== "antigravity" || input.backend.id !== target.backendInstanceId) {
      throw new Error("antigravity_presentation_target_invalid");
    }
    const desired = this.settings.get(input.scope, input.applicationThreadId);
    const unbound = target.backingState === "unbound";
    const editable = unbound || target.backingState === "bound";
    const modelOptions: SettingDescriptor["options"] = [];
    const effortOptions: SettingDescriptor["options"] = [];
    const models = antigravityAvailableModels(input.catalog, input.connection.id, this.modelPolicy);
    const desiredModel = models.find(model => model.id === desired.modelId);
    const effective = input.effectiveSettings?.model?.provider === input.connection.id ? input.effectiveSettings : undefined;
    const effectiveModel = input.catalog?.models.find(model => model.provider === input.connection.id && model.id === effective?.model?.id);
    const desiredModelValue = desired.modelId ? encodeAntigravityModelSetting(input.connection.id, desired.modelId, desired.thinkingLevel) : null;
    const effectiveModelValue = effective?.model ? encodeAntigravityModelSetting(input.connection.id, effective.model.id, effective.thinkingLevel ?? null) : null;
    for (const model of models.slice(0, 511)) {
      const effort = model.id === desired.modelId && antigravityCatalogAllowsSelection(models, desired)
        ? desired.thinkingLevel : model.defaultReasoningEffort ?? null;
      modelOptions.push({
        value: encodeAntigravityModelSetting(input.connection.id, model.id, effort),
        label: boundDisplayText(model.label),
        available: true,
      });
    }
    for (const effort of (desiredModel?.supportedReasoningEfforts ?? []).slice(0, 511)) {
      effortOptions.push({ value: effort, label: boundDisplayText(effort), available: true });
    }
    appendStoredOption(modelOptions, desiredModelValue, desiredModel?.label ?? desired.modelId);
    appendStoredOption(effortOptions, desired.thinkingLevel, desired.thinkingLevel);
    const selections: ThreadSettingsSnapshot["values"] = [
      settingValue("model", desiredModelValue, effectiveModelValue, unbound, effective !== undefined),
    ];
    const descriptors: SettingDescriptor[] = [
      descriptor("model", "Model", unbound, editable && models.length > 0, modelOptions,
        input.catalog ? "No Antigravity models allowed by this backend policy are available." : "The Antigravity model catalog is unavailable."),
    ];
    if (effortOptions.length > 0 || effective?.thinkingLevel !== undefined) {
      descriptors.push(descriptor("thinking_level", "Effort", unbound && (desiredModel?.supportedReasoningEfforts?.length ?? 0) > 0,
        editable && effortOptions.some(option => option.available), effortOptions, "Choose an Antigravity model with available effort levels."));
      selections.push(settingValue("thinking_level", desired.thinkingLevel, effective?.thinkingLevel ?? null, unbound, effective !== undefined));
    }
    const revision = createHash("sha256").update(JSON.stringify({
      backend: input.backend.configurationRevision, connection: input.connection.configurationRevision,
      backing: target.backingState, desired, selections, descriptors, modes: this.modes.modes, policy: this.modelPolicy.policy,
    })).digest("base64url");
    const modelLabel = effectiveModel?.label ?? effective?.model?.id ?? desiredModel?.label ?? desired.modelId;
    return {
      revision: `antigravity_${revision}`,
      backend: { label: boundDisplayText(input.backend.label), brand: BACKEND_BRANDS.antigravity,
        ...(modelLabel ? { modelLabel: boundDisplayText(modelLabel) } : {}) },
      interactionMode: "interactive",
      settings: { revision: desired.revision, values: selections },
      settingDescriptors: descriptors,
      nextTurnSettingIds: ["model", "thinking_level"],
      automationAllowed: (input.catalog === undefined || antigravityCatalogAllowsSelection(models, desired)) &&
        antigravityModelIsAllowed(this.modelPolicy, desired),
      automationForkDraftOnly: true,
      providerFeatureCapabilities: [compiledProviderFeatureRegistry.capability(ANTIGRAVITY_MODE_FEATURE_REF, "antigravity", {
        revision: desired.revision + this.modes.revision, mutationRevision: desired.revision,
        availability: editable ? "available" : "unavailable",
        ...(!editable ? { unavailableReason: boundDisplayText("Wait for the Antigravity thread to finish attaching.") } : {}),
        allowedOperationIds: [ANTIGRAVITY_KEEP_MODE_ACTION, ...this.modes.modes.map(mode => ANTIGRAVITY_MODE_ACTIONS[mode])],
      })],
      providerFeatureStates: [compiledProviderFeatureRegistry.stateEnvelope({ ref: ANTIGRAVITY_MODE_FEATURE_REF, backendKind: "antigravity",
        revision: desired.revision + this.modes.revision, providerState: { desiredMode: desired.modeId, application: "next_turn" } })],
      composerCommands: [],
      skills: [],
    };
  }
}

function settingValue(
  id: SettingDescriptor["id"], desiredValue: string | null, effectiveValue: string | null,
  unbound: boolean, observed: boolean,
): ThreadSettingsSnapshot["values"][number] {
  return { id, desiredValue, effectiveValue,
    applicationState: unbound ? "draft" : observed && (desiredValue === effectiveValue || desiredValue === null)
      ? "effective" : desiredValue !== null ? "pending_next_turn" : "confirmation_unknown" };
}

function appendStoredOption(options: SettingDescriptor["options"], value: string | null, label: string | null): void {
  if (value && label && !options.some(option => option.value === value)) {
    options.push({ value, label: boundDisplayText(label), available: false });
  }
}

function descriptor(
  id: SettingDescriptor["id"], label: string, requiredForFirstSubmission: boolean, available: boolean,
  options: SettingDescriptor["options"], unavailableReason: string,
): SettingDescriptor {
  return { id, label: boundDisplayText(label), requiredForFirstSubmission, available, options,
    ...(!available ? { unavailableReason: boundDisplayText(unavailableReason) } : {}) };
}
