import { z } from "zod";
import type { AntigravityConnectionDefaults } from "../../../shared/protocol/antigravity-configuration.js";
import type { BackendCatalog, BackendModelDescriptor } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { AntigravityDesiredSettings } from "./thread-repository.js";

export function antigravityAvailableModels(
  catalog: BackendCatalog | undefined,
  connectionId: string,
  policy: CompiledBackendModelPolicy,
): readonly BackendModelDescriptor[] {
  return (catalog?.models ?? []).flatMap(model => {
    if (model.provider !== connectionId) return [];
    const efforts = model.supportedReasoningEfforts ?? [];
    if (efforts.length === 0) return policy.isModelWithoutReasoningEffortAllowed({ modelId: model.id }) ? [model] : [];
    const supportedReasoningEfforts = policy.filterReasoningEfforts({ modelId: model.id }, efforts);
    if (supportedReasoningEfforts.length === 0) return [];
    const { defaultReasoningEffort, ...rest } = model;
    return [{
      ...rest,
      supportedReasoningEfforts,
      ...(defaultReasoningEffort && supportedReasoningEfforts.includes(defaultReasoningEffort) ? { defaultReasoningEffort } : {}),
    }];
  });
}

export function antigravitySettingsForDefaults(
  models: readonly BackendModelDescriptor[],
  defaults: AntigravityConnectionDefaults,
): AntigravityDesiredSettings {
  const model = defaults.modelId === undefined
    ? models.find(item => item.isDefault)
    : models.find(item => item.id === defaults.modelId);
  return {
    modelId: defaults.modelId ?? model?.id ?? null,
    thinkingLevel: defaults.thinkingLevel ?? model?.defaultReasoningEffort ?? null,
    modeId: defaults.modeId ?? null,
  };
}

export function antigravityModelIsAllowed(
  policy: CompiledBackendModelPolicy,
  settings: Pick<AntigravityDesiredSettings, "modelId" | "thinkingLevel">,
): boolean {
  const { modelId, thinkingLevel } = settings;
  return modelId !== null && (thinkingLevel === null
    ? policy.isModelWithoutReasoningEffortAllowed({ modelId })
    : policy.isSelectionAllowed({ modelId, reasoningEffort: thinkingLevel }));
}

export function antigravityCatalogAllowsSelection(
  models: readonly BackendModelDescriptor[],
  settings: Pick<AntigravityDesiredSettings, "modelId" | "thinkingLevel">,
): boolean {
  const model = models.find(item => item.id === settings.modelId);
  if (!model) return false;
  const efforts = model.supportedReasoningEfforts ?? [];
  return settings.thinkingLevel === null ? efforts.length === 0 : efforts.includes(settings.thinkingLevel);
}

const settingTuple = z.tuple([z.string().min(1).max(128), z.string().min(1).max(240), z.string().min(1).max(120).nullable()]);
type ModelSetting = z.infer<typeof settingTuple>;

export function encodeAntigravityModelSetting(
  connectionId: string,
  modelId: string,
  thinkingLevel: string | null,
): string {
  return JSON.stringify(settingTuple.parse([connectionId, modelId, thinkingLevel]));
}

export function decodeAntigravityModelSetting(value: string): ModelSetting {
  return settingTuple.parse(JSON.parse(value));
}
