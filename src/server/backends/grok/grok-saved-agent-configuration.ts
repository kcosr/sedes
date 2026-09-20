import { DomainError } from "../../domain/errors.js";
import type { AgentConnectionProfile, BackendCatalog } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { GrokConnectionModuleConfiguration } from "./grok-backend-configuration.js";

export const GROK_SAVED_AGENT_OVERRIDE_IDS = [
  "model",
  "reasoning_effort",
] as const;

interface GrokSavedAgentField {
  readonly id: (typeof GROK_SAVED_AGENT_OVERRIDE_IDS)[number];
  readonly label: string;
  readonly description: string;
  readonly defaultValue: string | null;
  readonly resolvedValue: string | null;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
    readonly available: boolean;
    readonly unavailableReason?: string;
  }[];
}

export class GrokSavedAgentConfiguration {
  constructor(readonly modelPolicy: CompiledBackendModelPolicy) {}

  validateOverrides(
    overrides: readonly { readonly id: string; readonly value: string }[],
  ): readonly { readonly id: string; readonly value: string }[] {
    const seen = new Set<string>();
    const canonical = overrides.map((override) => {
      if (
        !GROK_SAVED_AGENT_OVERRIDE_IDS.includes(
          override.id as (typeof GROK_SAVED_AGENT_OVERRIDE_IDS)[number],
        ) ||
        !override.value ||
        override.value.length > 240 ||
        seen.has(override.id)
      ) {
        throw invalidOverrides();
      }
      seen.add(override.id);
      return Object.freeze({ ...override });
    });
    canonical.sort((left, right) => left.id.localeCompare(right.id));
    return Object.freeze(canonical);
  }

  describe(input: {
    readonly connection: AgentConnectionProfile;
    readonly catalog: BackendCatalog;
    readonly defaults: GrokConnectionModuleConfiguration["defaults"];
    readonly overrides: readonly {
      readonly id: string;
      readonly value: string;
    }[];
  }): readonly GrokSavedAgentField[] {
    const resolved = this.#selection(input, false);
    return Object.freeze([
      Object.freeze({
        id: "model" as const,
        label: "Model",
        description:
          "The Grok model used when the native conversation is created.",
        defaultValue: resolved.defaultModel?.id ?? null,
        resolvedValue: resolved.modelId,
        options: withUnavailable(
          resolved.models.map(({ id, label }) => ({
            value: id,
            label,
            available: true,
          })),
          resolved.modelId,
        ),
      }),
      Object.freeze({
        id: "reasoning_effort" as const,
        label: "Effort",
        description:
          "The reasoning effort supported by the selected Grok model.",
        defaultValue: resolved.defaultEffort,
        resolvedValue: resolved.effort,
        options: withUnavailable(
          resolved.efforts.map((value) => ({
            value,
            label: effortLabel(value),
            available: true,
          })),
          resolved.effort,
        ),
      }),
    ]);
  }

  resolve(input: {
    readonly connection: AgentConnectionProfile;
    readonly catalog: BackendCatalog;
    readonly defaults: GrokConnectionModuleConfiguration["defaults"];
    readonly overrides: readonly {
      readonly id: string;
      readonly value: string;
    }[];
  }) {
    const selection = this.#selection(input, true);
    if (!selection.model || !selection.effort) throw unavailable();
    return Object.freeze({
      settings: Object.freeze({
        model: selection.model.id,
        effort: selection.effort,
      }),
      fields: this.describe(input),
    });
  }

  #selection(
    input: {
      readonly connection: AgentConnectionProfile;
      readonly catalog: BackendCatalog;
      readonly defaults: GrokConnectionModuleConfiguration["defaults"];
      readonly overrides: readonly {
        readonly id: string;
        readonly value: string;
      }[];
    },
    strict: boolean,
  ) {
    if (input.connection.kind !== "grok_acp") throw unavailable();
    const overrides = new Map(
      this.validateOverrides(input.overrides).map(({ id, value }) => [
        id,
        value,
      ]),
    );
    const models = input.catalog.models
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
      });
    const defaultModelSetting = input.defaults.model;
    const defaultModel =
      defaultModelSetting.type === "fixed"
        ? models.find(({ id }) => id === defaultModelSetting.modelId)
        : models.find(({ isDefault }) => isDefault === true);
    const modelId = overrides.get("model") ?? defaultModel?.id ?? null;
    const model = models.find(({ id }) => id === modelId);
    const efforts = model?.supportedReasoningEfforts ?? [];
    const defaultEffort =
      input.defaults.reasoningEffort.type === "fixed"
        ? input.defaults.reasoningEffort.effortId
        : (model?.defaultReasoningEffort ?? null);
    const effort = overrides.get("reasoning_effort") ?? defaultEffort;
    if (
      strict &&
      (!model ||
        !effort ||
        !efforts.includes(effort) ||
        !this.modelPolicy.isSelectionAllowed({
          modelId: model.id,
          reasoningEffort: effort,
        }))
    ) {
      throw unavailable();
    }
    return {
      models,
      defaultModel,
      modelId,
      model,
      efforts,
      defaultEffort,
      effort,
    };
  }
}

function withUnavailable(
  options: readonly {
    readonly value: string;
    readonly label: string;
    readonly available: boolean;
  }[],
  selection: string | null,
): readonly GrokSavedAgentField["options"][number][] {
  const result = options.map((option) => Object.freeze({ ...option }));
  if (selection && !result.some(({ value }) => value === selection)) {
    result.push(
      Object.freeze({
        value: selection,
        label: `${selection} (unavailable)`,
        available: false,
        unavailableReason:
          "This selection is unavailable or disallowed by backend policy.",
      }),
    );
  }
  return Object.freeze(result);
}

function effortLabel(value: string): string {
  if (value === "xhigh") return "Extra High";
  if (value === "max") return "Maximum";
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function invalidOverrides(): DomainError {
  return new DomainError("conflict", "The Grok agent overrides are invalid.");
}

function unavailable(): DomainError {
  return new DomainError(
    "conflict",
    "The Grok agent configuration is unavailable.",
  );
}
