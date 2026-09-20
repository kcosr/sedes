import type { ConnectionSettingPreferenceRepository } from "../../db/repositories/connection-setting-preference-repository.js";
import { DomainError } from "../../domain/errors.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import {
  savedAgentBackendTypeIdSchema,
  type AgentConfigurationOverride,
  type NormalizedAgentConfigurationDescriptor,
} from "../../../shared/protocol/saved-agents.js";
import type {
  CanonicalSavedAgentBackendOverrides,
  CapturedThreadBackendConfiguration,
  PreparedSavedAgentBackendContext,
  ResolvedSavedAgentBackendConfiguration,
  SavedAgentBackendAdapter,
  SavedAgentBackendContextInput,
} from "../saved-agent-adapter.js";
import { BACKEND_BRANDS } from "../contracts.js";
import type { PiBackendThreadPersistenceAdapter } from "./pi-backend-thread-persistence-adapter.js";
import {
  PiSavedAgentConfiguration,
  type PiSavedAgentPreferenceFence,
  type PiSavedAgentPreferenceSnapshot,
  type ProjectedPiSavedAgentConfiguration,
  type PiSavedAgentResolutionContext,
  type ResolvedPiSavedAgentConfiguration,
} from "./pi-saved-agent-configuration.js";
import { isPiToolAccessMode } from "./pi-tool-access.js";
import { encodePiModelSetting } from "./pi-thread-presentation-provider.js";

const PI_SAVED_AGENT_TYPE_ID = savedAgentBackendTypeIdSchema.parse("pi");
const PI_SAVED_AGENT_OVERRIDE_SCHEMA_VERSION = 1;

type PiResolvedValue = {
  readonly model: { readonly provider: string; readonly id: string };
  readonly thinkingLevel?: string;
  readonly toolAccess: "read_only" | "ask" | "full";
  readonly preferenceFence: PiSavedAgentPreferenceFence;
};

/** Pi's complete compiled SavedAgent contribution. */
export class PiSavedAgentAdapter implements SavedAgentBackendAdapter {
  readonly typeId = PI_SAVED_AGENT_TYPE_ID;
  readonly backendKind = "pi" as const;
  readonly presentation = Object.freeze({
    typeId: PI_SAVED_AGENT_TYPE_ID,
    label: boundDisplayText("Pi SDK"),
    brand: BACKEND_BRANDS.pi,
  });
  readonly overrideSchemaVersion = PI_SAVED_AGENT_OVERRIDE_SCHEMA_VERSION;
  readonly #configuration: PiSavedAgentConfiguration;
  readonly #persistence: PiBackendThreadPersistenceAdapter;
  readonly #preferences: ConnectionSettingPreferenceRepository;

  constructor(input: {
    readonly preferences: ConnectionSettingPreferenceRepository;
    readonly persistence: PiBackendThreadPersistenceAdapter;
  }) {
    if (input.preferences.database !== input.persistence.database) {
      throw new Error("pi_saved_agent_database_mismatch");
    }
    this.#configuration = new PiSavedAgentConfiguration(input.preferences);
    this.#persistence = input.persistence;
    this.#preferences = input.preferences;
  }

  validateOverrides(input: {
    readonly overrides: readonly AgentConfigurationOverride[];
  }): CanonicalSavedAgentBackendOverrides {
    return Object.freeze({
      backendTypeId: this.typeId,
      schemaVersion: this.overrideSchemaVersion,
      overrides: [...this.#configuration.validateOverrides(input.overrides)],
    });
  }

  prepareResolutionContext(
    input: SavedAgentBackendContextInput,
  ): PreparedSavedAgentBackendContext {
    this.#assertContext(input);
    return Object.freeze({
      backendTypeId: this.typeId,
      schemaVersion: this.overrideSchemaVersion,
      value: this.#configuration.prepare(input.scope, input.connection),
    });
  }

  describeEditor(
    input: SavedAgentBackendContextInput & {
      readonly prepared: PreparedSavedAgentBackendContext;
      readonly overrides: CanonicalSavedAgentBackendOverrides;
    },
  ): NormalizedAgentConfigurationDescriptor {
    const resolved = this.#describePi(input);
    return Object.freeze({
      backendTypeId: this.typeId,
      fields: resolved.fields.map((field) => ({
        id: field.id,
        label: boundDisplayText(field.label),
        description: boundDisplayText(field.description),
        currentDefaultValue: field.defaultValue,
        resolvedValue: field.resolvedValue,
        options: field.options.map((option) => ({
          value: option.value,
          label: boundDisplayText(option.label),
          available: option.available,
          ...(option.reason
            ? { unavailableReason: boundDisplayText(option.reason) }
            : {}),
        })),
      })),
      canonicalOverrides: this.validateOverrides({
        overrides: input.overrides.overrides,
      }).overrides,
    });
  }

  resolve(
    input: SavedAgentBackendContextInput & {
      readonly prepared: PreparedSavedAgentBackendContext;
      readonly overrides: CanonicalSavedAgentBackendOverrides;
    },
  ): ResolvedSavedAgentBackendConfiguration {
    const resolved = this.#resolvePi(input);
    const normalizedValues: AgentConfigurationOverride[] = [
      {
        id: "model",
        value: resolved.fields.find(({ id }) => id === "model")!.resolvedValue!,
      },
      ...(resolved.thinkingLevel
        ? [{ id: "thinking_level", value: resolved.thinkingLevel }]
        : []),
      { id: "tool_access", value: resolved.toolAccess },
    ];
    return Object.freeze({
      backendTypeId: this.typeId,
      schemaVersion: this.overrideSchemaVersion,
      normalizedValues,
      value: Object.freeze({
        model: resolved.model,
        ...(resolved.thinkingLevel
          ? { thinkingLevel: resolved.thinkingLevel }
          : {}),
        toolAccess: resolved.toolAccess,
        preferenceFence: resolved.preferenceFence,
      }),
    });
  }

  captureThreadConfiguration(input: {
    readonly scope: SavedAgentBackendContextInput["scope"];
    readonly applicationThreadId: string;
    readonly connection: SavedAgentBackendContextInput["connection"];
  }): CapturedThreadBackendConfiguration {
    const settings = this.#persistence.readDesiredSettings(
      input.scope,
      input.applicationThreadId,
      input.connection,
    );
    if (
      !settings.modelProvider ||
      !settings.modelId ||
      !settings.thinkingLevel ||
      !isPiToolAccessMode(settings.toolMode)
    ) {
      throw new DomainError(
        "invalid_transition",
        "Choose complete Pi settings before copying this thread configuration.",
      );
    }
    const canonical = this.validateOverrides({
      overrides: [
        {
          id: "model",
          value: encodePiModelSetting(
            settings.modelProvider,
            settings.modelId,
          ),
        },
        { id: "thinking_level", value: settings.thinkingLevel },
        { id: "tool_access", value: settings.toolMode },
      ],
    });
    return Object.freeze({
      backendTypeId: this.typeId,
      schemaVersion: this.overrideSchemaVersion,
      settingsRevision: settings.revision,
      overrides: canonical.overrides,
    });
  }

  assertThreadConfigurationCapture(input: {
    readonly transaction: Parameters<
      SavedAgentBackendAdapter["initializeNewThread"]
    >[0]["transaction"];
    readonly scope: SavedAgentBackendContextInput["scope"];
    readonly applicationThreadId: string;
    readonly connection: SavedAgentBackendContextInput["connection"];
    readonly capture: CapturedThreadBackendConfiguration;
  }): void {
    input.transaction.assertActive();
    if (input.transaction.database !== this.#persistence.database) {
      throw new Error("pi_thread_configuration_capture_database_mismatch");
    }
    this.#assertEnvelope(input.capture);
    const current = this.#persistence.readDesiredSettings(
      input.scope,
      input.applicationThreadId,
      input.connection,
    );
    if (current.revision !== input.capture.settingsRevision) {
      throw new DomainError(
        "conflict",
        "The source Pi settings changed while the new thread was created.",
      );
    }
  }

  initializeNewThread(
    input: Parameters<SavedAgentBackendAdapter["initializeNewThread"]>[0],
  ): void {
    input.transaction.assertActive();
    if (input.transaction.database !== this.#persistence.database) {
      throw new Error("pi_saved_agent_transaction_database_mismatch");
    }
    this.#assertEnvelope(input.resolved);
    const resolved = requireResolvedValue(input.resolved.value);
    this.#assertPreferenceFence(
      input.scope,
      input.connection.id,
      resolved.preferenceFence,
    );
    this.#persistence.initializeResolvedNewThread(
      input.scope,
      input.applicationThreadId,
      input.connection,
      {
        modelProvider: resolved.model.provider,
        modelId: resolved.model.id,
        ...(resolved.thinkingLevel
          ? { thinkingLevel: resolved.thinkingLevel }
          : {}),
        toolAccess: resolved.toolAccess,
      },
    );
  }

  #resolvePi(
    input: SavedAgentBackendContextInput & {
      readonly prepared: PreparedSavedAgentBackendContext;
      readonly overrides: CanonicalSavedAgentBackendOverrides;
    },
  ): ResolvedPiSavedAgentConfiguration {
    const prepared = this.#prepareConfigurationInput(input);
    return this.#configuration.resolve(prepared);
  }

  #describePi(
    input: SavedAgentBackendContextInput & {
      readonly prepared: PreparedSavedAgentBackendContext;
      readonly overrides: CanonicalSavedAgentBackendOverrides;
    },
  ): ProjectedPiSavedAgentConfiguration {
    const prepared = this.#prepareConfigurationInput(input);
    return this.#configuration.describe(prepared);
  }

  #prepareConfigurationInput(
    input: SavedAgentBackendContextInput & {
      readonly prepared: PreparedSavedAgentBackendContext;
      readonly overrides: CanonicalSavedAgentBackendOverrides;
    },
  ): Parameters<PiSavedAgentConfiguration["resolve"]>[0] {
    this.#assertContext(input);
    this.#assertEnvelope(input.prepared);
    this.#assertEnvelope(input.overrides);
    const prepared = requirePreparedValue(input.prepared.value);
    const canonical = this.validateOverrides({
      overrides: input.overrides.overrides,
    });
    return {
      scope: input.scope,
      connection: input.connection,
      catalog: input.catalog,
      context: prepared,
      overrides: canonical.overrides,
    };
  }

  #assertEnvelope(input: {
    readonly backendTypeId: unknown;
    readonly schemaVersion: unknown;
  }): void {
    if (
      input.backendTypeId !== this.typeId ||
      input.schemaVersion !== this.overrideSchemaVersion
    ) {
      throw new DomainError(
        "conflict",
        "The Pi agent configuration version is invalid.",
      );
    }
  }

  #assertContext(input: SavedAgentBackendContextInput): void {
    if (
      input.connection.kind !== "pi_sdk" ||
      !input.connection.enabled ||
      input.connection.tenantId !== input.scope.tenantId ||
      input.connection.ownerPrincipalId !== input.scope.principalId ||
      input.workspace.summary.environmentId !==
        input.connection.executionEnvironmentId
    ) {
      throw new DomainError(
        "runtime_unavailable",
        "The Pi target is unavailable for this agent.",
      );
    }
  }

  #assertPreferenceFence(
    scope: SavedAgentBackendContextInput["scope"],
    connectionProfileId: string,
    fence: PiSavedAgentPreferenceFence,
  ): void {
    const matches = (
      settingId: "model" | "thinking_level",
      expected: PiSavedAgentPreferenceSnapshot,
    ) => {
      const current = this.#preferences.find(
        scope,
        connectionProfileId,
        settingId,
      );
      return expected === null
        ? current === undefined
        : current?.value === expected.value &&
            current.revision === expected.revision;
    };
    if (
      ("model" in fence && !matches("model", fence.model ?? null)) ||
      ("thinkingLevel" in fence &&
        !matches("thinking_level", fence.thinkingLevel ?? null))
    ) {
      throw new DomainError(
        "conflict",
        "The Pi target defaults changed while the thread was created.",
      );
    }
  }
}

function requirePreparedValue(value: unknown): PiSavedAgentResolutionContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError(
      "conflict",
      "The prepared Pi agent defaults are invalid.",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 2 ||
    !validPreferenceSnapshot(record.modelPreference) ||
    !validPreferenceSnapshot(record.thinkingLevelPreference)
  ) {
    throw new DomainError(
      "conflict",
      "The prepared Pi agent defaults are invalid.",
    );
  }
  return Object.freeze({
    modelPreference: record.modelPreference as PiSavedAgentPreferenceSnapshot,
    thinkingLevelPreference:
      record.thinkingLevelPreference as PiSavedAgentPreferenceSnapshot,
  });
}

function requireResolvedValue(value: unknown): PiResolvedValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new DomainError("conflict", "The resolved Pi agent is invalid.");
  }
  const record = value as Record<string, unknown>;
  const model = record.model as Record<string, unknown> | undefined;
  if (
    Object.keys(record).some(
      (key) =>
        key !== "model" &&
        key !== "thinkingLevel" &&
        key !== "toolAccess" &&
        key !== "preferenceFence",
    ) ||
    !model ||
    Object.keys(model).some((key) => key !== "provider" && key !== "id") ||
    typeof model.provider !== "string" ||
    model.provider.length === 0 ||
    typeof model.id !== "string" ||
    model.id.length === 0 ||
    (record.thinkingLevel !== undefined &&
      typeof record.thinkingLevel !== "string") ||
    !isPiToolAccessMode(record.toolAccess) ||
    !validPreferenceFence(record.preferenceFence)
  ) {
    throw new DomainError("conflict", "The resolved Pi agent is invalid.");
  }
  return value as PiResolvedValue;
}

function validPreferenceSnapshot(
  value: unknown,
): value is PiSavedAgentPreferenceSnapshot {
  if (value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    typeof record.value === "string" &&
    Number.isSafeInteger(record.revision) &&
    (record.revision as number) >= 0
  );
}

function validPreferenceFence(
  value: unknown,
): value is PiSavedAgentPreferenceFence {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).every(
      (key) => key === "model" || key === "thinkingLevel",
    ) &&
    (record.model === undefined || validPreferenceSnapshot(record.model)) &&
    (record.thinkingLevel === undefined ||
      validPreferenceSnapshot(record.thinkingLevel))
  );
}
