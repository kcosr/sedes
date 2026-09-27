import type { NormalizedAgentConfigurationOverrides } from "../../../shared/protocol/saved-agents.js";
import { normalizedAgentConfigurationOverridesSchema } from "../../../shared/protocol/saved-agents.js";
import { DomainError } from "../../domain/errors.js";
import type { AgentConnectionProfile, BackendCatalog } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { OpenCodeConnectionDefaults } from "./opencode-backend-configuration.js";
import { assertOpenCodeCatalogPolicy, decodeOpenCodeModelId, resolveOpenCodeSelection, type OpenCodeSelection } from "./opencode-model-selection.js";

export interface OpenCodeSavedAgentField {
  readonly id: "model" | "reasoning_effort"; readonly label: string; readonly description: string;
  readonly defaultValue: string | null; readonly resolvedValue: string | null;
  readonly options: readonly { readonly value: string; readonly label: string; readonly available: boolean; readonly unavailableReason?: string }[];
}
export class OpenCodeSavedAgentConfiguration {
  constructor(readonly input: { readonly modelPolicy: CompiledBackendModelPolicy;
    readonly resolveConnectionDefaults: (connection: AgentConnectionProfile) => OpenCodeConnectionDefaults | undefined }) {
    assertOpenCodeCatalogPolicy(input.modelPolicy);
  }
  validateOverrides(overrides: NormalizedAgentConfigurationOverrides): NormalizedAgentConfigurationOverrides {
    const canonical = normalizedAgentConfigurationOverridesSchema.parse(overrides).map(override => {
      if (override.id === "model") decodeOpenCodeModelId(override.value);
      else if (override.id !== "reasoning_effort" || override.value.length > 120 || /\p{Cc}/u.test(override.value)) throw unavailable();
      return { ...override };
    });
    return canonical.sort((a, b) => a.id.localeCompare(b.id));
  }
  describe(input: { readonly connection: AgentConnectionProfile; readonly catalog: BackendCatalog;
    readonly defaults: OpenCodeConnectionDefaults; readonly overrides: NormalizedAgentConfigurationOverrides }): readonly OpenCodeSavedAgentField[] {
    if (input.connection.kind !== "opencode_http") throw unavailable();
    const overrides = new Map(this.validateOverrides(input.overrides).map(override => [override.id, override.value]));
    const models = input.catalog.models.filter(model => model.provider === input.connection.id);
    const defaultId = input.defaults.model.type === "fixed" ? input.defaults.model.modelId : models.find(model => model.isDefault)?.id ?? null;
    const selectedId = overrides.get("model") ?? defaultId;
    const selected = models.find(model => model.id === selectedId);
    const defaultEffort = input.defaults.variant.type === "fixed" ? input.defaults.variant.variantId : "default";
    const effort = overrides.get("reasoning_effort") ?? defaultEffort;
    return [
      { id: "model", label: "Model", description: "The OpenCode model used for new work.", defaultValue: defaultId, resolvedValue: selectedId,
        options: withUnavailable(models.map(model => ({ value: model.id, label: model.label, available: true })), selectedId) },
      { id: "reasoning_effort", label: "Effort", description: "Default preserves the model's native settings without a variant overlay.",
        defaultValue: defaultEffort, resolvedValue: effort,
        options: withUnavailable((selected?.supportedReasoningEfforts ?? []).map(value => ({ value, label: value === "default" ? "Default" : value, available: true })), effort) },
    ];
  }
  resolve(input: { readonly connection: AgentConnectionProfile; readonly catalog: BackendCatalog;
    readonly defaults: OpenCodeConnectionDefaults; readonly overrides: NormalizedAgentConfigurationOverrides }): {
      readonly selection: OpenCodeSelection; readonly fields: readonly OpenCodeSavedAgentField[];
    } {
    const fields = this.describe(input);
    const modelId = fields.find(field => field.id === "model")!.resolvedValue;
    const variant = fields.find(field => field.id === "reasoning_effort")!.resolvedValue;
    if (!modelId || !variant) throw unavailable();
    return { selection: resolveOpenCodeSelection({ connection: input.connection, catalog: input.catalog, modelId, variant, modelPolicy: this.input.modelPolicy }), fields };
  }
}
function withUnavailable(options: readonly OpenCodeSavedAgentField["options"][number][], value: string | null): OpenCodeSavedAgentField["options"] {
  return value && !options.some(option => option.value === value)
    ? [...options, { value, label: `${value} (unavailable)`, available: false, unavailableReason: "This OpenCode selection is unavailable in the current catalog." }] : options;
}
function unavailable(): DomainError { return new DomainError("invalid_transition", "The OpenCode Saved Agent settings are unavailable."); }
