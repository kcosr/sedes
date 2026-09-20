import { DomainError } from "../../domain/errors.js";
import type {
  AgentConnectionProfile,
  BackendCatalog,
  BackendModelDescriptor,
} from "../contracts.js";
import type { CodexConnectionModuleConfiguration } from "./codex-backend-configuration.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_APPROVAL_REVIEWERS,
  CODEX_NETWORK_ACCESS_VALUES,
  CODEX_SANDBOX_MODES,
  isCodexExecutionPolicyAllowed,
  type CodexExecutionPolicyAllowlist,
} from "./codex-execution-policy.js";
import type {
  CodexExecutionSettingsTuple,
  CodexServiceTierSelection,
} from "./codex-thread-execution-settings-repository.js";

export const CODEX_SAVED_AGENT_OVERRIDE_IDS = [
  "model",
  "reasoning_effort",
  "service_tier",
  "sandbox_mode",
  "network_access",
  "approval_policy",
  "approval_reviewer",
] as const;

export type CodexSavedAgentOverrideId =
  (typeof CODEX_SAVED_AGENT_OVERRIDE_IDS)[number];

export interface CodexSavedAgentOverride {
  readonly id: string;
  readonly value: string;
}

export interface CodexSavedAgentOption {
  readonly value: string;
  readonly label: string;
  readonly available: boolean;
  readonly reason?: string;
}

export interface CodexSavedAgentFieldDescriptor {
  readonly id: CodexSavedAgentOverrideId;
  readonly label: string;
  readonly description: string;
  readonly defaultValue: string;
  readonly resolvedValue: string;
  readonly options: readonly CodexSavedAgentOption[];
}

export interface ResolvedCodexSavedAgentConfiguration {
  /** Complete provider-private tuple copied into the new thread. */
  readonly settings: CodexExecutionSettingsTuple;
  /** Normalized provider identity rebound to this concrete target. */
  readonly model: {
    readonly provider: string;
    readonly id: string;
  };
  readonly fields: readonly CodexSavedAgentFieldDescriptor[];
}

type CodexConnectionDefaults = CodexConnectionModuleConfiguration["defaults"];

const fieldMetadata: Readonly<
  Record<
    CodexSavedAgentOverrideId,
    { readonly label: string; readonly description: string }
  >
> = {
  model: {
    label: "Model",
    description: "The Codex model used for new work.",
  },
  reasoning_effort: {
    label: "Reasoning",
    description: "The reasoning effort supported by the selected model.",
  },
  service_tier: {
    label: "Service tier",
    description: "The standard or Fast service tier for the selected model.",
  },
  sandbox_mode: {
    label: "Sandbox",
    description: "The filesystem sandbox applied to Codex execution.",
  },
  network_access: {
    label: "Network",
    description: "Whether Codex may use network access.",
  },
  approval_policy: {
    label: "Approvals",
    description: "When Codex requests approval before an operation.",
  },
  approval_reviewer: {
    label: "Approval reviewer",
    description: "Who reviews approval requests.",
  },
};

/**
 * Pure Codex-owned SavedAgent configuration logic. It consumes only an
 * already-materialized connection, catalog, and compiled configuration.
 */
export class CodexSavedAgentConfiguration {
  readonly #executionPolicy: CodexExecutionPolicyAllowlist;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #resolveConnectionDefaults: (
    connection: AgentConnectionProfile,
  ) => CodexConnectionDefaults | undefined;

  constructor(input: {
    readonly executionPolicy: CodexExecutionPolicyAllowlist;
    readonly modelPolicy: CompiledBackendModelPolicy;
    readonly resolveConnectionDefaults: (
      connection: AgentConnectionProfile,
    ) => CodexConnectionDefaults | undefined;
  }) {
    this.#executionPolicy = input.executionPolicy;
    this.#modelPolicy = input.modelPolicy;
    this.#resolveConnectionDefaults = input.resolveConnectionDefaults;
  }

  validateOverrides(
    overrides: readonly CodexSavedAgentOverride[],
  ): readonly CodexSavedAgentOverride[] {
    const seen = new Set<string>();
    const canonical = overrides.map((override) => {
      if (
        !CODEX_SAVED_AGENT_OVERRIDE_IDS.includes(
          override.id as CodexSavedAgentOverrideId,
        ) ||
        override.value.length === 0 ||
        override.value.length > 120 ||
        seen.has(override.id)
      ) {
        throw new DomainError(
          "conflict",
          "The Codex agent overrides are invalid.",
        );
      }
      if (
        (override.id === "service_tier" &&
          override.value !== "standard" &&
          override.value !== "fast") ||
        (override.id === "sandbox_mode" &&
          !CODEX_SANDBOX_MODES.includes(
            override.value as (typeof CODEX_SANDBOX_MODES)[number],
          )) ||
        (override.id === "network_access" &&
          !CODEX_NETWORK_ACCESS_VALUES.includes(
            override.value as (typeof CODEX_NETWORK_ACCESS_VALUES)[number],
          )) ||
        (override.id === "approval_policy" &&
          !CODEX_APPROVAL_POLICIES.includes(
            override.value as (typeof CODEX_APPROVAL_POLICIES)[number],
          )) ||
        (override.id === "approval_reviewer" &&
          !CODEX_APPROVAL_REVIEWERS.includes(
            override.value as (typeof CODEX_APPROVAL_REVIEWERS)[number],
          ))
      ) {
        throw new DomainError(
          "conflict",
          "The Codex agent overrides are invalid.",
        );
      }
      seen.add(override.id);
      return Object.freeze({ id: override.id, value: override.value });
    });
    canonical.sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    return Object.freeze(canonical);
  }

  resolve(input: {
    readonly connection: AgentConnectionProfile;
    readonly catalog: BackendCatalog;
    readonly overrides: readonly CodexSavedAgentOverride[];
  }): ResolvedCodexSavedAgentConfiguration {
    this.#assertConnection(input.connection);
    const defaults = this.#resolveConnectionDefaults(input.connection);
    if (!defaults) throw targetUnavailable();
    const overrides = new Map(
      this.validateOverrides(input.overrides).map((override) => [
        override.id as CodexSavedAgentOverrideId,
        override.value,
      ]),
    );

    const explicitModel = overrides.has("model");
    const selectedModel = explicitModel
      ? resolveModel(
          input.connection,
          input.catalog,
          overrides.get("model")!,
          this.#modelPolicy,
        )
      : resolveConfiguredDefaultModel(
          input.connection,
          defaults.model,
          input.catalog,
          this.#modelPolicy,
        );
    const defaultModel = explicitModel
      ? (() => {
          try {
            return resolveConfiguredDefaultModel(
              input.connection,
              defaults.model,
              input.catalog,
              this.#modelPolicy,
            );
          } catch {
            return selectedModel;
          }
        })()
      : selectedModel;
    const defaultReasoningEffort =
      selectedModel.defaultReasoningEffort ??
      (overrides.has("reasoning_effort")
        ? overrides.get("reasoning_effort")!
        : requireDefaultReasoning(selectedModel));
    const reasoningEffort =
      overrides.get("reasoning_effort") ?? defaultReasoningEffort;
    if (!selectedModel.supportedReasoningEfforts?.includes(reasoningEffort)) {
      throw targetUnavailable(
        "The selected Codex reasoning effort is unavailable for this model.",
      );
    }
    if (
      !this.#modelPolicy.isSelectionAllowed({
        modelId: selectedModel.id,
        reasoningEffort,
      })
    ) {
      throw targetUnavailable(
        "This model or reasoning effort is not allowed by the backend policy.",
      );
    }

    const defaultServiceTier =
      selectedModel.fastMode?.defaultSelection ?? "standard";
    const serviceTier = (overrides.get("service_tier") ??
      defaultServiceTier) as CodexServiceTierSelection;
    if (
      (serviceTier !== "standard" && serviceTier !== "fast") ||
      (serviceTier === "fast" && !selectedModel.fastMode)
    ) {
      throw targetUnavailable(
        "The selected Codex service tier is unavailable for this model.",
      );
    }

    const settings: CodexExecutionSettingsTuple = {
      model: selectedModel.id,
      reasoningEffort,
      serviceTier,
      sandboxMode: enumOverride(
        overrides.get("sandbox_mode"),
        defaults.sandboxMode,
        CODEX_SANDBOX_MODES,
      ),
      networkAccess: enumOverride(
        overrides.get("network_access"),
        defaults.networkAccess,
        CODEX_NETWORK_ACCESS_VALUES,
      ),
      approvalPolicy: enumOverride(
        overrides.get("approval_policy"),
        defaults.approvalPolicy,
        CODEX_APPROVAL_POLICIES,
      ),
      approvalReviewer: enumOverride(
        overrides.get("approval_reviewer"),
        defaults.approvalReviewer,
        CODEX_APPROVAL_REVIEWERS,
      ),
    };
    if (!isCodexExecutionPolicyAllowed(settings, this.#executionPolicy)) {
      throw targetUnavailable(
        "The selected Codex execution policy is unavailable on this target.",
      );
    }

    return Object.freeze({
      settings: Object.freeze(settings),
      model: Object.freeze({
        provider: input.connection.id,
        id: selectedModel.id,
      }),
      fields: Object.freeze(
        this.#fields({
          catalog: input.catalog,
          selectedModel,
          defaults,
          defaultModel,
          settings,
        }),
      ),
    });
  }

  #fields(input: {
    readonly catalog: BackendCatalog;
    readonly selectedModel: BackendModelDescriptor;
    readonly defaults: CodexConnectionDefaults;
    readonly defaultModel: BackendModelDescriptor;
    readonly settings: CodexExecutionSettingsTuple;
  }): readonly CodexSavedAgentFieldDescriptor[] {
    const allowedModels = input.catalog.models.filter(
      (model) =>
        model.provider === input.selectedModel.provider &&
        modelHasAllowedEffort(model, this.#modelPolicy),
    );
    return [
      field(
        "model",
        input.defaultModel.id,
        input.settings.model,
        allowedModels.map((model) => option(model.id, model.label)),
      ),
      field(
        "reasoning_effort",
        input.selectedModel.defaultReasoningEffort ?? input.settings.reasoningEffort,
        input.settings.reasoningEffort,
        (input.selectedModel.supportedReasoningEfforts ?? []).map((value) =>
          option(value, humanize(value)),
        ),
      ),
      field(
        "service_tier",
        input.selectedModel.fastMode?.defaultSelection ?? "standard",
        input.settings.serviceTier,
        [
          option("standard", "Standard"),
          ...(input.selectedModel.fastMode ? [option("fast", "Fast")] : []),
        ],
      ),
      field(
        "sandbox_mode",
        input.defaults.sandboxMode,
        input.settings.sandboxMode,
        this.#executionPolicy.allowedSandboxModes.map((value) =>
          option(value, humanize(value)),
        ),
      ),
      field(
        "network_access",
        input.defaults.networkAccess,
        input.settings.networkAccess,
        this.#executionPolicy.allowedNetworkAccess.map((value) =>
          option(value, humanize(value)),
        ),
      ),
      field(
        "approval_policy",
        input.defaults.approvalPolicy,
        input.settings.approvalPolicy,
        this.#executionPolicy.allowedApprovalPolicies.map((value) =>
          option(value, humanize(value)),
        ),
      ),
      field(
        "approval_reviewer",
        input.defaults.approvalReviewer,
        input.settings.approvalReviewer,
        this.#executionPolicy.allowedApprovalReviewers.map((value) =>
          option(value, humanize(value)),
        ),
      ),
    ];
  }

  #assertConnection(connection: AgentConnectionProfile): void {
    if (connection.kind !== "codex_app_server" || !connection.enabled) {
      throw targetUnavailable();
    }
  }
}

function resolveConfiguredDefaultModel(
  connection: AgentConnectionProfile,
  selection: CodexConnectionDefaults["model"],
  catalog: BackendCatalog,
  modelPolicy: CompiledBackendModelPolicy,
): BackendModelDescriptor {
  const candidates =
    selection.type === "fixed"
      ? catalog.models.filter((model) => model.id === selection.modelId)
      : catalog.models.filter((model) => model.isDefault === true);
  const matching = candidates.filter(
    (model) =>
      model.provider === connection.id && modelHasAllowedEffort(model, modelPolicy),
  );
  if (matching.length !== 1) {
    throw targetUnavailable(
      selection.type === "fixed"
        ? "The configured Codex model is unavailable."
        : "The Codex catalog default model is unavailable or ambiguous.",
    );
  }
  return matching[0]!;
}

function resolveModel(
  connection: AgentConnectionProfile,
  catalog: BackendCatalog,
  modelId: string,
  modelPolicy: CompiledBackendModelPolicy,
): BackendModelDescriptor {
  const matching = catalog.models.filter(
    (model) =>
      model.provider === connection.id &&
      model.id === modelId &&
      modelHasAllowedEffort(model, modelPolicy),
  );
  if (matching.length !== 1) {
    throw targetUnavailable("The selected Codex model is unavailable.");
  }
  return matching[0]!;
}

function modelHasAllowedEffort(
  model: BackendModelDescriptor,
  modelPolicy: CompiledBackendModelPolicy,
): boolean {
  return model.id.length > 0 &&
    model.id.length <= 120 &&
    (model.supportedReasoningEfforts ?? []).some((reasoningEffort) =>
      modelPolicy.isSelectionAllowed({ modelId: model.id, reasoningEffort }),
    );
}

function requireDefaultReasoning(model: BackendModelDescriptor): string {
  const efforts = model.supportedReasoningEfforts;
  const defaultEffort = model.defaultReasoningEffort;
  if (
    !efforts ||
    efforts.length === 0 ||
    new Set(efforts).size !== efforts.length ||
    efforts.some((effort) => effort.length === 0 || effort.length > 120) ||
    !defaultEffort ||
    !efforts.includes(defaultEffort)
  ) {
    throw targetUnavailable("The Codex model reasoning defaults are invalid.");
  }
  return defaultEffort;
}

function enumOverride<const Values extends readonly string[]>(
  override: string | undefined,
  fallback: Values[number],
  values: Values,
): Values[number] {
  const value = override ?? fallback;
  if (!values.includes(value as Values[number])) {
    throw targetUnavailable("The selected Codex setting is invalid.");
  }
  return value as Values[number];
}

function field(
  id: CodexSavedAgentOverrideId,
  defaultValue: string,
  resolvedValue: string,
  options: readonly CodexSavedAgentOption[],
): CodexSavedAgentFieldDescriptor {
  return Object.freeze({
    id,
    ...fieldMetadata[id],
    defaultValue,
    resolvedValue,
    options: Object.freeze(options),
  });
}

function option(value: string, label: string): CodexSavedAgentOption {
  return Object.freeze({ value, label, available: true });
}

function humanize(value: string): string {
  return value
    .split(/[-_]/u)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function targetUnavailable(
  message = "The Codex target is unavailable for this Agent.",
): DomainError {
  return new DomainError("conflict", message);
}
