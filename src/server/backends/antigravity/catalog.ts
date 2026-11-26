import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { createHash } from "node:crypto";
import type { BackendCapabilityDocument } from "../../../shared/protocol/backend.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import type { BackendCatalog, BackendModelDescriptor } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { AntigravitySetup } from "./port.js";
import { antigravityAvailableModels } from "./model-selection.js";

export function antigravitySelectOptions(option: SessionConfigOption | undefined): readonly { value: string; name: string }[] {
  if (option?.type !== "select") return [];
  return option.options.flatMap(value => "options" in value ? value.options : [value]);
}
export function antigravityConfigOption(setup: AntigravitySetup | undefined, category: string): SessionConfigOption | undefined {
  const options = setup?.session.configOptions?.filter(value => value.category === category) ?? [];
  if (options.length > 1) throw new Error("antigravity_config_category_ambiguous");
  return options[0];
}
export function antigravityConfigValue(setup: AntigravitySetup | undefined, category: string): string | undefined {
  const option = antigravityConfigOption(setup, category);
  return option?.type === "select" ? option.currentValue : undefined;
}
export function antigravityCatalog(setup: AntigravitySetup, connectionId: string, policy: CompiledBackendModelPolicy): BackendCatalog {
  const option = antigravityConfigOption(setup, "model");
  if (antigravitySelectOptions(option).length === 0) throw new Error("antigravity_model_catalog_unavailable");
  const current = antigravityConfigValue(setup, "model");
  const models: BackendModelDescriptor[] = antigravitySelectOptions(option).map(model => {
    const effort = setup.modelOptions?.find(value => value.modelId === model.value);
    return { provider: connectionId, id: model.value, label: model.name,
      inputModalities: setup.initialize.agentCapabilities?.promptCapabilities?.image ? ["text", "image"] : ["text"],
      ...(model.value === current ? { isDefault: true as const } : {}),
      ...(effort?.thinkingLevels.length ? { supportedReasoningEfforts: [...effort.thinkingLevels],
        ...(effort.defaultThinkingLevel ? { defaultReasoningEffort: effort.defaultThinkingLevel } : {}) } : {}) };
  });
  return { models: [...antigravityAvailableModels({ models, commands: [], skills: [], notices: [] }, connectionId, policy)],
    commands: [], skills: [], notices: [] };
}
export function antigravityCapabilities(setup: AntigravitySetup | undefined, connectionId: string): BackendCapabilityDocument {
  const model = antigravityConfigValue(setup, "model");
  const thinking = antigravityConfigValue(setup, "thought_level");
  const options = setup?.session.configOptions ?? [];
  return {
    revision: createHash("sha256").update(JSON.stringify(options)).digest("hex"),
    actions: [...(model ? ["set_model" as const] : []), ...(thinking ? ["set_thinking_level" as const] : [])],
    deliveryModes: setup ? ["submit", "steer"] : [], steerTarget: setup ? "conversation" : null,
    composerAttachments: { fileStaging: !!setup, nativeImage: !!setup?.initialize.agentCapabilities?.promptCapabilities?.image },
    nonblockingQuestions: false, providerOutputArtifacts: { nativeImage: false }, supportsHistory: true,
    branching: { availability: "unavailable", reason: boundDisplayText("Antigravity does not offer a qualified exact conversation fork.") },
    interactionKinds: setup ? ["decision", "choice"] : [], usageAccounting: "supported", turnThroughput: "unsupported", liveFinalAnswer: "unsupported", usageSections: setup ? ["context", "counters"] : ["counters"],
    effectiveSettings: { ...(model ? { model: { provider: connectionId, id: model } } : {}), ...(thinking ? { thinkingLevel: thinking } : {}),
    },
  };
}
