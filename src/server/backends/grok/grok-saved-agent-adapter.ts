import {
  normalizedAgentConfigurationDescriptorSchema,
  normalizedAgentConfigurationOverridesSchema,
  savedAgentBackendTypeIdSchema,
  type NormalizedAgentConfigurationOverrides,
} from "../../../shared/protocol/saved-agents.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { DomainError } from "../../domain/errors.js";
import type {
  CanonicalSavedAgentBackendOverrides,
  CapturedThreadBackendConfiguration,
  PreparedSavedAgentBackendContext,
  ResolvedSavedAgentBackendConfiguration,
  SavedAgentBackendAdapter,
  SavedAgentBackendContextInput,
} from "../saved-agent-adapter.js";
import { BACKEND_BRANDS, type AgentConnectionProfile } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { GrokBackendThreadPersistenceAdapter } from "./grok-backend-thread-persistence-adapter.js";
import type { GrokConnectionModuleConfiguration } from "./grok-backend-configuration.js";
import { GrokSavedAgentConfiguration } from "./grok-saved-agent-configuration.js";

const TYPE_ID = savedAgentBackendTypeIdSchema.parse("grok");
const SCHEMA_VERSION = 2;

export class GrokSavedAgentBackendAdapter implements SavedAgentBackendAdapter {
  readonly typeId = TYPE_ID;
  readonly backendKind = "grok_build" as const;
  readonly presentation = Object.freeze({
    typeId: TYPE_ID,
    label: boundDisplayText("Grok"),
    brand: BACKEND_BRANDS.grok_build,
  });
  readonly overrideSchemaVersion = SCHEMA_VERSION;
  readonly #configuration: GrokSavedAgentConfiguration;
  readonly #persistence: GrokBackendThreadPersistenceAdapter;
  readonly #resolveDefaults: (
    connection: AgentConnectionProfile,
  ) => GrokConnectionModuleConfiguration["defaults"] | undefined;

  constructor(input: {
    readonly persistence: GrokBackendThreadPersistenceAdapter;
    readonly modelPolicy: CompiledBackendModelPolicy;
    readonly resolveConnectionDefaults: (
      connection: AgentConnectionProfile,
    ) => GrokConnectionModuleConfiguration["defaults"] | undefined;
  }) {
    this.#persistence = input.persistence;
    this.#configuration = new GrokSavedAgentConfiguration(input.modelPolicy);
    this.#resolveDefaults = input.resolveConnectionDefaults;
  }

  validateOverrides(input: {
    readonly overrides: NormalizedAgentConfigurationOverrides;
  }): CanonicalSavedAgentBackendOverrides {
    const overrides = normalizedAgentConfigurationOverridesSchema.parse(
      input.overrides,
    );
    return Object.freeze({
      backendTypeId: TYPE_ID,
      schemaVersion: SCHEMA_VERSION,
      overrides: [...this.#configuration.validateOverrides(overrides)],
    });
  }

  prepareResolutionContext(
    input: SavedAgentBackendContextInput,
  ): PreparedSavedAgentBackendContext {
    this.#assertContext(input);
    const defaults = this.#resolveDefaults(input.connection);
    if (!defaults) throw unavailable();
    return Object.freeze({
      backendTypeId: TYPE_ID,
      schemaVersion: SCHEMA_VERSION,
      value: Object.freeze({ ...defaults }),
    });
  }

  describeEditor(
    input: SavedAgentBackendContextInput & {
      readonly prepared: PreparedSavedAgentBackendContext;
      readonly overrides: CanonicalSavedAgentBackendOverrides;
    },
  ) {
    this.#assertContext(input);
    this.#assertEnvelope(input.prepared);
    this.#assertEnvelope(input.overrides);
    const defaults = requireDefaults(input.prepared.value);
    const canonical = this.validateOverrides({
      overrides: input.overrides.overrides,
    });
    const fields = this.#configuration.describe({
      connection: input.connection,
      catalog: input.catalog,
      defaults,
      overrides: canonical.overrides,
    });
    return normalizedAgentConfigurationDescriptorSchema.parse({
      backendTypeId: TYPE_ID,
      fields: fields.map((field) => ({
        id: field.id,
        label: boundDisplayText(field.label),
        description: boundDisplayText(field.description),
        currentDefaultValue: field.defaultValue,
        resolvedValue: field.resolvedValue,
        options: field.options.map((option) => ({
          value: option.value,
          label: boundDisplayText(option.label),
          available: option.available,
          ...(option.unavailableReason
            ? { unavailableReason: boundDisplayText(option.unavailableReason) }
            : {}),
        })),
      })),
      canonicalOverrides: canonical.overrides,
    });
  }

  resolve(
    input: SavedAgentBackendContextInput & {
      readonly prepared: PreparedSavedAgentBackendContext;
      readonly overrides: CanonicalSavedAgentBackendOverrides;
    },
  ): ResolvedSavedAgentBackendConfiguration {
    this.#assertContext(input);
    this.#assertEnvelope(input.prepared);
    this.#assertEnvelope(input.overrides);
    const resolved = this.#configuration.resolve({
      connection: input.connection,
      catalog: input.catalog,
      defaults: requireDefaults(input.prepared.value),
      overrides: input.overrides.overrides,
    });
    return Object.freeze({
      backendTypeId: TYPE_ID,
      schemaVersion: SCHEMA_VERSION,
      normalizedValues: [
        { id: "model", value: resolved.settings.model },
        { id: "reasoning_effort", value: resolved.settings.effort },
      ],
      value: resolved.settings,
    });
  }

  captureThreadConfiguration(input: {
    readonly scope: SavedAgentBackendContextInput["scope"];
    readonly applicationThreadId: string;
    readonly connection: AgentConnectionProfile;
  }): CapturedThreadBackendConfiguration {
    const settings = this.#persistence.readDesiredSettings(
      input.scope,
      input.applicationThreadId,
      input.connection,
    );
    if (!settings.model || !settings.effort) {
      throw new DomainError(
        "invalid_transition",
        "Choose complete Grok settings before copying this thread configuration.",
      );
    }
    const canonical = this.validateOverrides({
      overrides: [
        { id: "model", value: settings.model },
        { id: "reasoning_effort", value: settings.effort },
      ],
    });
    return Object.freeze({
      backendTypeId: TYPE_ID,
      schemaVersion: SCHEMA_VERSION,
      settingsRevision: settings.revision,
      overrides: canonical.overrides,
    });
  }

  assertThreadConfigurationCapture(
    input: Parameters<
      SavedAgentBackendAdapter["assertThreadConfigurationCapture"]
    >[0],
  ): void {
    input.transaction.assertActive();
    if (input.transaction.database !== this.#persistence.database) {
      throw new Error("grok_thread_configuration_capture_database_mismatch");
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
        "The source Grok settings changed while the new thread was created.",
      );
    }
  }

  initializeNewThread(
    input: Parameters<SavedAgentBackendAdapter["initializeNewThread"]>[0],
  ): void {
    input.transaction.assertActive();
    if (input.transaction.database !== this.#persistence.database) {
      throw new Error("grok_saved_agent_transaction_mismatch");
    }
    this.#assertContext(input);
    this.#assertEnvelope(input.resolved);
    const settings = requireResolved(input.resolved.value);
    this.#persistence.initializeResolvedNewThread(
      input.scope,
      input.applicationThreadId,
      input.connection,
      settings,
    );
  }

  #assertContext(input: { readonly connection: AgentConnectionProfile }): void {
    if (input.connection.kind !== "grok_acp") throw unavailable();
  }

  #assertEnvelope(input: {
    readonly backendTypeId: unknown;
    readonly schemaVersion: unknown;
  }): void {
    if (
      input.backendTypeId !== TYPE_ID ||
      input.schemaVersion !== SCHEMA_VERSION
    ) {
      throw unavailable();
    }
  }
}

function requireDefaults(
  value: unknown,
): GrokConnectionModuleConfiguration["defaults"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unavailable();
  }
  const parsed = value as GrokConnectionModuleConfiguration["defaults"];
  if (
    (parsed.model?.type !== "catalogDefault" &&
      parsed.model?.type !== "fixed") ||
    (parsed.reasoningEffort?.type !== "modelDefault" &&
      parsed.reasoningEffort?.type !== "fixed")
  ) {
    throw unavailable();
  }
  return parsed;
}

function requireResolved(value: unknown): {
  readonly model: string;
  readonly effort: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unavailable();
  }
  const record = value as Record<string, unknown>;
  if (typeof record.model !== "string" || typeof record.effort !== "string") {
    throw unavailable();
  }
  return { model: record.model, effort: record.effort };
}

function unavailable(): DomainError {
  return new DomainError(
    "conflict",
    "The Grok agent configuration is unavailable.",
  );
}
