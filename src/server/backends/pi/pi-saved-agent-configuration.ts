import type { ConnectionSettingPreferenceRepository } from "../../db/repositories/connection-setting-preference-repository.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  AgentConnectionProfile,
  BackendCatalog,
  BackendModelDescriptor,
} from "../contracts.js";
import {
  decodePiModelSetting,
  encodePiModelSetting,
  piThinkingLevels,
  requirePiThinkingLevel,
} from "./pi-thread-presentation-provider.js";
import {
  isPiToolAccessMode,
  PI_TOOL_ACCESS_MODES,
  type PiToolAccessMode,
} from "./pi-tool-access.js";

export const PI_SAVED_AGENT_OVERRIDE_IDS = [
  "model",
  "thinking_level",
  "tool_access",
] as const;

export type PiSavedAgentOverrideId =
  (typeof PI_SAVED_AGENT_OVERRIDE_IDS)[number];

export interface PiSavedAgentOverride {
  readonly id: string;
  readonly value: string;
}

export interface PiSavedAgentResolutionContext {
  readonly modelPreference: PiSavedAgentPreferenceSnapshot;
  readonly thinkingLevelPreference: PiSavedAgentPreferenceSnapshot;
}

export type PiSavedAgentPreferenceSnapshot =
  | { readonly value: string; readonly revision: number }
  | null;

export interface PiSavedAgentPreferenceFence {
  readonly model?: PiSavedAgentPreferenceSnapshot;
  readonly thinkingLevel?: PiSavedAgentPreferenceSnapshot;
}

export interface PiSavedAgentOption {
  readonly value: string;
  readonly label: string;
  readonly available: boolean;
  readonly reason?: string;
}

export interface PiSavedAgentFieldDescriptor {
  readonly id: PiSavedAgentOverrideId;
  readonly label: string;
  readonly description: string;
  readonly defaultValue: string | null;
  readonly resolvedValue: string | null;
  readonly options: readonly PiSavedAgentOption[];
}

export interface ProjectedPiSavedAgentConfiguration {
  readonly model?: {
    readonly provider: string;
    readonly id: string;
  };
  readonly thinkingLevel?: string;
  readonly toolAccess: PiToolAccessMode;
  readonly preferenceFence: PiSavedAgentPreferenceFence;
  readonly fields: readonly PiSavedAgentFieldDescriptor[];
}

export interface ResolvedPiSavedAgentConfiguration
  extends ProjectedPiSavedAgentConfiguration {
  readonly model: {
    readonly provider: string;
    readonly id: string;
  };
  readonly thinkingLevel: string;
}

const metadata: Readonly<
  Record<
    PiSavedAgentOverrideId,
    { readonly label: string; readonly description: string }
  >
> = {
  model: {
    label: "Model",
    description: "The Pi provider and model used for new work.",
  },
  thinking_level: {
    label: "Thinking",
    description: "The reasoning level supported by the selected model.",
  },
  tool_access: {
    label: "Tool access",
    description: "The provider tool-access policy for the Pi session.",
  },
};

/**
 * Pi-owned SavedAgent configuration logic. Preference reads happen only in
 * `prepare`; validation and resolution are pure over its returned snapshot.
 */
export class PiSavedAgentConfiguration {
  readonly #preferences: ConnectionSettingPreferenceRepository;

  constructor(preferences: ConnectionSettingPreferenceRepository) {
    this.#preferences = preferences;
  }

  prepare(
    scope: RequestScope,
    connection: AgentConnectionProfile,
  ): PiSavedAgentResolutionContext {
    assertConnection(scope, connection);
    const modelPreference = preferenceSnapshot(this.#preferences.find(
      scope,
      connection.id,
      "model",
    ));
    const thinkingLevelPreference = preferenceSnapshot(this.#preferences.find(
      scope,
      connection.id,
      "thinking_level",
    ));
    return Object.freeze({
      modelPreference,
      thinkingLevelPreference,
    });
  }

  validateOverrides(
    overrides: readonly PiSavedAgentOverride[],
  ): readonly PiSavedAgentOverride[] {
    const seen = new Set<string>();
    const canonical = overrides.map((override) => {
      if (
        !PI_SAVED_AGENT_OVERRIDE_IDS.includes(
          override.id as PiSavedAgentOverrideId,
        ) ||
        override.value.length === 0 ||
        override.value.length > 240 ||
        seen.has(override.id)
      ) {
        throw invalidOverrides();
      }
      if (override.id === "model") {
        try {
          decodePiModelSetting(override.value);
        } catch {
          throw invalidOverrides();
        }
      } else if (override.id === "thinking_level") {
        try {
          requirePiThinkingLevel(override.value);
        } catch {
          throw invalidOverrides();
        }
      } else if (!isPiToolAccessMode(override.value)) {
        throw invalidOverrides();
      }
      seen.add(override.id);
      return Object.freeze({ id: override.id, value: override.value });
    });
    canonical.sort((left, right) =>
      left.id === right.id ? 0 : left.id < right.id ? -1 : 1,
    );
    return Object.freeze(canonical);
  }

  describe(input: {
    readonly scope: RequestScope;
    readonly connection: AgentConnectionProfile;
    readonly catalog: BackendCatalog;
    readonly context: PiSavedAgentResolutionContext;
    readonly overrides: readonly PiSavedAgentOverride[];
  }): ProjectedPiSavedAgentConfiguration {
    assertConnection(input.scope, input.connection);
    const overrides = new Map(
      this.validateOverrides(input.overrides).map((override) => [
        override.id as PiSavedAgentOverrideId,
        override.value,
      ]),
    );
    const defaultModel = resolvePreferredModel(
      input.context.modelPreference?.value,
      input.catalog,
    );
    const selectedModel = overrides.has("model")
      ? requireCatalogModel(overrides.get("model")!, input.catalog)
      : defaultModel;
    const defaultThinkingLevel = selectedModel
      ? resolvePreferredThinkingLevel(
          input.context.thinkingLevelPreference?.value,
          selectedModel,
        )
      : undefined;
    const thinkingLevel =
      overrides.get("thinking_level") ?? defaultThinkingLevel;
    if (
      selectedModel !== undefined &&
      thinkingLevel !== undefined &&
      !supportsThinkingLevel(selectedModel, thinkingLevel)
    ) {
      throw unavailable(
        "The selected Pi thinking level is unavailable for this model.",
      );
    }
    const toolAccess = overrides.get("tool_access") ?? "full";
    if (!isPiToolAccessMode(toolAccess)) throw invalidOverrides();

    const encodedModel = selectedModel
      ? encodePiModelSetting(selectedModel.provider, selectedModel.id)
      : null;
    const defaultModelValue = defaultModel
      ? encodePiModelSetting(defaultModel.provider, defaultModel.id)
      : null;
    return Object.freeze({
      ...(selectedModel
        ? {
            model: Object.freeze({
              provider: selectedModel.provider,
              id: selectedModel.id,
            }),
          }
        : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      toolAccess,
      preferenceFence: Object.freeze({
        ...(!overrides.has("model")
          ? { model: input.context.modelPreference }
          : {}),
        ...(!overrides.has("thinking_level")
          ? { thinkingLevel: input.context.thinkingLevelPreference }
          : {}),
      }),
      fields: Object.freeze([
        field(
          "model",
          defaultModelValue,
          encodedModel,
          input.catalog.models.flatMap((model) => {
            try {
              return [
                option(
                  encodePiModelSetting(model.provider, model.id),
                  model.label,
                  true,
                ),
              ];
            } catch {
              return [];
            }
          }),
        ),
        field(
          "thinking_level",
          defaultThinkingLevel ?? null,
          thinkingLevel ?? null,
          piThinkingLevels.map((value) =>
            option(
              value,
              thinkingLabel(value),
              selectedModel
                ? supportsThinkingLevel(selectedModel, value)
                : true,
              "This model does not support this thinking level.",
            ),
          ),
        ),
        field(
          "tool_access",
          "full",
          toolAccess,
          PI_TOOL_ACCESS_MODES.map((value) =>
            option(value, toolAccessLabel(value), true),
          ),
        ),
      ]),
    });
  }

  resolve(
    input: Parameters<PiSavedAgentConfiguration["describe"]>[0],
  ): ResolvedPiSavedAgentConfiguration {
    const projected = this.describe(input);
    if (!projected.model) {
      throw unavailable(
        "Choose a Pi model because this target has no available saved model preference.",
      );
    }
    if (!projected.thinkingLevel) {
      throw unavailable(
        "Choose a Pi thinking level for the selected model before starting new work.",
      );
    }
    return projected as ResolvedPiSavedAgentConfiguration;
  }
}

function preferenceSnapshot(
  record: { readonly value: string; readonly revision: number } | undefined,
): PiSavedAgentPreferenceSnapshot {
  return record
    ? Object.freeze({ value: record.value, revision: record.revision })
    : null;
}

function assertConnection(
  scope: RequestScope,
  connection: AgentConnectionProfile,
): void {
  if (
    connection.kind !== "pi_sdk" ||
    !connection.enabled ||
    connection.tenantId !== scope.tenantId ||
    connection.ownerPrincipalId !== scope.principalId
  ) {
    throw unavailable();
  }
}

function resolvePreferredModel(
  preference: string | undefined,
  catalog: BackendCatalog,
): BackendModelDescriptor | undefined {
  if (!preference) return undefined;
  try {
    return requireCatalogModel(preference, catalog);
  } catch {
    return undefined;
  }
}

function requireCatalogModel(
  value: string,
  catalog: BackendCatalog,
): BackendModelDescriptor {
  const decoded = decodePiModelSetting(value);
  const matches = catalog.models.filter(
    ({ provider, id }) =>
      provider === decoded.provider && id === decoded.modelId,
  );
  if (matches.length !== 1) {
    throw unavailable("The selected Pi model is unavailable on this target.");
  }
  return matches[0]!;
}

function resolvePreferredThinkingLevel(
  preference: string | undefined,
  model: BackendModelDescriptor,
): string | undefined {
  if (!preference) return undefined;
  try {
    const level = requirePiThinkingLevel(preference);
    return supportsThinkingLevel(model, level) ? level : undefined;
  } catch {
    return undefined;
  }
}

function supportsThinkingLevel(
  model: BackendModelDescriptor,
  level: string,
): boolean {
  try {
    requirePiThinkingLevel(level);
  } catch {
    return false;
  }
  return model.supportedReasoningEfforts?.includes(level) ?? true;
}

function field(
  id: PiSavedAgentOverrideId,
  defaultValue: string | null,
  resolvedValue: string | null,
  options: readonly PiSavedAgentOption[],
): PiSavedAgentFieldDescriptor {
  return Object.freeze({
    id,
    ...metadata[id],
    defaultValue,
    resolvedValue,
    options: Object.freeze(options),
  });
}

function option(
  value: string,
  label: string,
  available: boolean,
  reason?: string,
): PiSavedAgentOption {
  return Object.freeze({
    value,
    label,
    available,
    ...(!available && reason ? { reason } : {}),
  });
}

function thinkingLabel(value: string): string {
  return value === "off"
    ? "Off"
    : value === "xhigh"
      ? "Extra High"
      : value === "max"
        ? "Maximum"
        : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function toolAccessLabel(value: PiToolAccessMode): string {
  if (value === "read_only") return "Read only";
  if (value === "ask") return "Ask before changes";
  return "Full access";
}

function invalidOverrides(): DomainError {
  return new DomainError("conflict", "The Pi agent overrides are invalid.");
}

function unavailable(
  message = "The Pi target is unavailable for this agent.",
): DomainError {
  return new DomainError("runtime_unavailable", message);
}
