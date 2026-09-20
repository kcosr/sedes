import { DomainError } from "../../domain/errors.js";
import type {
  AgentConnectionProfile,
  BackendCatalog,
  BackendModelDescriptor,
} from "../contracts.js";
import type { ClaudeConnectionDefaults } from "./claude-backend-thread-persistence-adapter.js";
import {
  CLAUDE_PERMISSION_MODES,
  isClaudePermissionMode,
  isClaudePermissionModeAllowed,
  type ClaudePermissionMode,
  type ClaudePermissionPolicy,
} from "./claude-permission-policy.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";

export const CLAUDE_SAVED_AGENT_OVERRIDE_IDS = [
  "model",
  "reasoning_effort",
  "permission_mode",
] as const;

export type ClaudeSavedAgentOverrideId =
  (typeof CLAUDE_SAVED_AGENT_OVERRIDE_IDS)[number];

export interface ClaudeSavedAgentField {
  readonly id: ClaudeSavedAgentOverrideId;
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

export interface ResolvedClaudeSavedAgentConfiguration {
  readonly settings: {
    readonly model: string;
    readonly effort: string | null;
    readonly permissionMode: ClaudePermissionMode;
  };
  readonly fields: readonly ClaudeSavedAgentField[];
}

export class ClaudeSavedAgentConfiguration {
  readonly #permissionPolicy: ClaudePermissionPolicy;
  readonly #modelPolicy: CompiledBackendModelPolicy;

  constructor(input: {
    readonly permissionPolicy: ClaudePermissionPolicy;
    readonly modelPolicy: CompiledBackendModelPolicy;
  }) {
    this.#permissionPolicy = input.permissionPolicy;
    this.#modelPolicy = input.modelPolicy;
  }

  validateOverrides(
    overrides: readonly { readonly id: string; readonly value: string }[],
  ): readonly { readonly id: string; readonly value: string }[] {
    const seen = new Set<string>();
    const canonical = overrides.map((override) => {
      if (
        !CLAUDE_SAVED_AGENT_OVERRIDE_IDS.includes(
          override.id as ClaudeSavedAgentOverrideId,
        ) ||
        override.value.length < 1 ||
        override.value.length > 240 ||
        (override.id === "permission_mode" &&
          !isClaudePermissionMode(override.value)) ||
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
    readonly defaults: ClaudeConnectionDefaults;
    readonly overrides: readonly {
      readonly id: string;
      readonly value: string;
    }[];
  }): readonly ClaudeSavedAgentField[] {
    if (input.connection.kind !== "claude_agent_sdk") throw unavailable();
    const overrides = new Map(
      this.validateOverrides(input.overrides).map(({ id, value }) => [
        id,
        value,
      ]),
    );
    const models = input.catalog.models.filter(
      ({ provider }) => provider === input.connection.id,
    );
    const defaultModel = input.defaults.model
      ? models.find(({ id }) => id === input.defaults.model)
      : models.find(({ isDefault }) => isDefault === true);
    const modelId = overrides.get("model") ?? defaultModel?.id ?? null;
    const model = models.find(({ id }) => id === modelId);
    const efforts = model?.supportedReasoningEfforts ?? [];
    const defaultEffort = model
      ? resolveDefaultEffort(model, input.defaults.effort)
      : null;
    const effort = overrides.get("reasoning_effort") ?? defaultEffort;
    const defaultPermissionMode = input.defaults.permissionMode ?? null;
    const permissionMode =
      overrides.get("permission_mode") ?? defaultPermissionMode;
    return Object.freeze([
      Object.freeze({
        id: "model" as const,
        label: "Model",
        description: "The Claude model used for new work.",
        defaultValue: defaultModel?.id ?? null,
        resolvedValue: modelId,
        options: withUnavailableSelection(
          models.map(({ id, label }) => ({
            value: id,
            label,
            available: true,
          })),
          modelId,
        ),
      }),
      Object.freeze({
        id: "reasoning_effort" as const,
        label: "Effort",
        description: "The reasoning effort supported by the selected model.",
        defaultValue: defaultEffort,
        resolvedValue: effort,
        options: withUnavailableSelection(
          efforts.map((value) => ({
            value,
            label: effortLabel(value),
            available: true,
          })),
          effort,
        ),
      }),
      Object.freeze({
        id: "permission_mode" as const,
        label: "Permissions",
        description: "How Claude handles tool permission checks for new work.",
        defaultValue: defaultPermissionMode,
        resolvedValue: permissionMode,
        options: Object.freeze(
          CLAUDE_PERMISSION_MODES.map((value) =>
            Object.freeze({
              value,
              label: permissionModeLabel(value),
              available: isClaudePermissionModeAllowed(
                value,
                this.#permissionPolicy,
              ),
              ...(!isClaudePermissionModeAllowed(value, this.#permissionPolicy)
                ? {
                    unavailableReason:
                      "This permission mode is not allowed by deployment policy.",
                  }
                : {}),
            }),
          ),
        ),
      }),
    ]);
  }

  resolve(input: {
    readonly connection: AgentConnectionProfile;
    readonly catalog: BackendCatalog;
    readonly defaults: ClaudeConnectionDefaults;
    readonly overrides: readonly {
      readonly id: string;
      readonly value: string;
    }[];
  }): ResolvedClaudeSavedAgentConfiguration {
    if (input.connection.kind !== "claude_agent_sdk") throw unavailable();
    const overrides = new Map(
      this.validateOverrides(input.overrides).map(({ id, value }) => [
        id,
        value,
      ]),
    );
    const models = input.catalog.models.filter(
      ({ provider }) => provider === input.connection.id,
    );
    const defaultModel = input.defaults.model
      ? models.find(({ id }) => id === input.defaults.model)
      : models.find(({ isDefault }) => isDefault === true);
    const selectedModelId = overrides.get("model") ?? defaultModel?.id;
    const model = resolveModel(
      models,
      selectedModelId,
      "The selected Claude model is unavailable.",
    );
    const efforts = model.supportedReasoningEfforts ?? [];
    const defaultEffort = resolveDefaultEffort(model, input.defaults.effort);
    const effort = overrides.get("reasoning_effort") ?? defaultEffort;
    if (
      efforts.length === 0
        ? effort !== null ||
          !this.#modelPolicy.isModelWithoutReasoningEffortAllowed({
            modelId: model.id,
          })
        : !effort ||
          !efforts.includes(effort) ||
          !this.#modelPolicy.isSelectionAllowed({
            modelId: model.id,
            reasoningEffort: effort,
          })
    ) {
      throw unavailable("The selected Claude effort is unavailable.");
    }
    const defaultPermissionMode = input.defaults.permissionMode;
    if (
      !isClaudePermissionMode(defaultPermissionMode) ||
      !isClaudePermissionModeAllowed(
        defaultPermissionMode,
        this.#permissionPolicy,
      )
    ) {
      throw unavailable(
        "The configured default Claude permission mode is unavailable.",
      );
    }
    const permissionMode =
      overrides.get("permission_mode") ?? defaultPermissionMode;
    if (
      !isClaudePermissionMode(permissionMode) ||
      !isClaudePermissionModeAllowed(permissionMode, this.#permissionPolicy)
    ) {
      throw unavailable("The selected Claude permission mode is unavailable.");
    }
    return Object.freeze({
      settings: Object.freeze({
        model: model.id,
        effort,
        permissionMode,
      }),
      fields: Object.freeze([
        Object.freeze({
          id: "model" as const,
          label: "Model",
          description: "The Claude model used for new work.",
          defaultValue: defaultModel?.id ?? null,
          resolvedValue: model.id,
          options: Object.freeze(
            models.map(({ id, label }) =>
              Object.freeze({ value: id, label, available: true }),
            ),
          ),
        }),
        Object.freeze({
          id: "reasoning_effort" as const,
          label: "Effort",
          description: "The reasoning effort supported by the selected model.",
          defaultValue: defaultEffort ?? null,
          resolvedValue: effort,
          options: Object.freeze(
            efforts.map((value) =>
              Object.freeze({
                value,
                label: effortLabel(value),
                available: true,
              }),
            ),
          ),
        }),
        Object.freeze({
          id: "permission_mode" as const,
          label: "Permissions",
          description:
            "How Claude handles tool permission checks for new work.",
          defaultValue: defaultPermissionMode,
          resolvedValue: permissionMode,
          options: Object.freeze(
            CLAUDE_PERMISSION_MODES.map((value) =>
              Object.freeze({
                value,
                label: permissionModeLabel(value),
                available: isClaudePermissionModeAllowed(
                  value,
                  this.#permissionPolicy,
                ),
              }),
            ),
          ),
        }),
      ]),
    });
  }
}

function resolveModel(
  models: readonly BackendModelDescriptor[],
  selection: string | undefined,
  message: string,
): BackendModelDescriptor {
  const model = selection
    ? models.find(({ id }) => id === selection)
    : models.find(({ isDefault }) => isDefault === true);
  if (!model) throw unavailable(message);
  return model;
}

function resolveDefaultEffort(
  model: BackendModelDescriptor,
  configured: string | undefined,
): string | null {
  const efforts = model.supportedReasoningEfforts ?? [];
  if (efforts.length === 0) return null;
  return configured && efforts.includes(configured)
    ? configured
    : (model.defaultReasoningEffort ?? null);
}

function effortLabel(value: string): string {
  return value === "xhigh"
    ? "Extra High"
    : value === "max"
      ? "Maximum"
      : `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function permissionModeLabel(value: ClaudePermissionMode): string {
  switch (value) {
    case "default":
      return "Default";
    case "acceptEdits":
      return "Accept edits";
    case "dontAsk":
      return "Don't ask";
    case "auto":
      return "Auto";
    case "bypassPermissions":
      return "Bypass permissions";
  }
}

function withUnavailableSelection(
  options: readonly {
    readonly value: string;
    readonly label: string;
    readonly available: boolean;
  }[],
  selection: string | null,
): readonly ClaudeSavedAgentField["options"][number][] {
  const projected = options.map((option) => Object.freeze({ ...option }));
  if (selection && !projected.some(({ value }) => value === selection)) {
    projected.push(
      Object.freeze({
        value: selection,
        label: `${selection} (unavailable)`,
        available: false,
        unavailableReason:
          "This model or reasoning effort is not allowed by the backend policy.",
      }),
    );
  }
  return Object.freeze(projected);
}

function invalidOverrides(): DomainError {
  return new DomainError("conflict", "The Claude agent overrides are invalid.");
}

function unavailable(
  message = "The Claude agent configuration is unavailable.",
): DomainError {
  return new DomainError("conflict", message);
}
