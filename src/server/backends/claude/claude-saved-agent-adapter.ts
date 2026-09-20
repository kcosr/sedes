import {
  normalizedAgentConfigurationDescriptorSchema,
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
import type {
  ClaudeBackendThreadPersistenceAdapter,
  ClaudeConnectionDefaults,
} from "./claude-backend-thread-persistence-adapter.js";
import { ClaudeSavedAgentConfiguration } from "./claude-saved-agent-configuration.js";
import {
  isClaudePermissionMode,
  type ClaudePermissionMode,
  type ClaudePermissionPolicy,
} from "./claude-permission-policy.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";

export const CLAUDE_SAVED_AGENT_BACKEND_TYPE_ID =
  savedAgentBackendTypeIdSchema.parse("claude");
export const CLAUDE_SAVED_AGENT_OVERRIDE_SCHEMA_VERSION = 2;

export class ClaudeSavedAgentBackendAdapter implements SavedAgentBackendAdapter {
  readonly typeId = CLAUDE_SAVED_AGENT_BACKEND_TYPE_ID;
  readonly backendKind = "claude_agent_sdk" as const;
  readonly presentation = Object.freeze({
    typeId: CLAUDE_SAVED_AGENT_BACKEND_TYPE_ID,
    label: boundDisplayText("Claude"),
    brand: BACKEND_BRANDS.claude_agent_sdk,
  });
  readonly overrideSchemaVersion = CLAUDE_SAVED_AGENT_OVERRIDE_SCHEMA_VERSION;
  readonly #configuration: ClaudeSavedAgentConfiguration;
  readonly #persistence: ClaudeBackendThreadPersistenceAdapter;
  readonly #resolveDefaults: (
    connection: AgentConnectionProfile,
  ) => ClaudeConnectionDefaults | undefined;

  constructor(input: {
    readonly persistence: ClaudeBackendThreadPersistenceAdapter;
    readonly permissionPolicy: ClaudePermissionPolicy;
    readonly modelPolicy: CompiledBackendModelPolicy;
    readonly resolveConnectionDefaults: (
      connection: AgentConnectionProfile,
    ) => ClaudeConnectionDefaults | undefined;
  }) {
    this.#persistence = input.persistence;
    this.#configuration = new ClaudeSavedAgentConfiguration({
      permissionPolicy: input.permissionPolicy,
      modelPolicy: input.modelPolicy,
    });
    this.#resolveDefaults = input.resolveConnectionDefaults;
  }

  validateOverrides(input: {
    readonly overrides: NormalizedAgentConfigurationOverrides;
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
    const defaults = this.#resolveDefaults(input.connection);
    if (!defaults) throw unavailable();
    return Object.freeze({
      backendTypeId: this.typeId,
      schemaVersion: this.overrideSchemaVersion,
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
      backendTypeId: this.typeId,
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
    const { resolved } = this.#resolve(input);
    return Object.freeze({
      backendTypeId: this.typeId,
      schemaVersion: this.overrideSchemaVersion,
      normalizedValues: [
        { id: "model", value: resolved.settings.model },
        ...(resolved.settings.effort
          ? [{ id: "reasoning_effort", value: resolved.settings.effort }]
          : []),
        { id: "permission_mode", value: resolved.settings.permissionMode },
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
    if (!settings.model || !settings.permissionMode) {
      throw new DomainError(
        "invalid_transition",
        "Choose complete Claude settings before copying this thread configuration.",
      );
    }
    const canonical = this.validateOverrides({
      overrides: [
        { id: "model", value: settings.model },
        ...(settings.effort
          ? [{ id: "reasoning_effort", value: settings.effort }]
          : []),
        { id: "permission_mode", value: settings.permissionMode },
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
    readonly connection: AgentConnectionProfile;
    readonly capture: CapturedThreadBackendConfiguration;
  }): void {
    input.transaction.assertActive();
    if (input.transaction.database !== this.#persistence.database) {
      throw new Error("claude_thread_configuration_capture_database_mismatch");
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
        "The source Claude settings changed while the new thread was created.",
      );
    }
  }

  initializeNewThread(
    input: Parameters<SavedAgentBackendAdapter["initializeNewThread"]>[0],
  ): void {
    input.transaction.assertActive();
    if (input.transaction.database !== this.#persistence.database) {
      throw new Error("claude_saved_agent_transaction_mismatch");
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

  #resolve(
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
    return {
      canonical,
      resolved: this.#configuration.resolve({
        connection: input.connection,
        catalog: input.catalog,
        defaults,
        overrides: canonical.overrides,
      }),
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
      throw unavailable();
    }
  }

  #assertContext(input: { readonly connection: AgentConnectionProfile }): void {
    if (input.connection.kind !== "claude_agent_sdk") throw unavailable();
  }
}

function requireDefaults(value: unknown): ClaudeConnectionDefaults {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unavailable();
  }
  const record = value as Record<string, unknown>;
  if (
    (record.model !== undefined && typeof record.model !== "string") ||
    (record.effort !== undefined && typeof record.effort !== "string") ||
    !isClaudePermissionMode(record.permissionMode)
  ) {
    throw unavailable();
  }
  return {
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.effort === "string" ? { effort: record.effort } : {}),
    permissionMode: record.permissionMode,
  };
}

function requireResolved(value: unknown): {
  readonly model: string;
  readonly effort: string | null;
  readonly permissionMode: ClaudePermissionMode;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw unavailable();
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.model !== "string" ||
    (record.effort !== null && typeof record.effort !== "string") ||
    !isClaudePermissionMode(record.permissionMode)
  ) {
    throw unavailable();
  }
  return {
    model: record.model,
    effort: record.effort as string | null,
    permissionMode: record.permissionMode,
  };
}

function unavailable(): DomainError {
  return new DomainError(
    "conflict",
    "The Claude agent configuration is unavailable.",
  );
}
