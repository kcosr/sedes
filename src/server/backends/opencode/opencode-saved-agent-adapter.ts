import { normalizedAgentConfigurationDescriptorSchema, savedAgentBackendTypeIdSchema } from "../../../shared/protocol/saved-agents.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { DomainError } from "../../domain/errors.js";
import type { SavedAgentBackendAdapter, SavedAgentBackendContextInput } from "../saved-agent-adapter.js";
import type { AgentConnectionProfile } from "../contracts.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import type { OpenCodeBackendThreadPersistenceAdapter } from "./opencode-backend-thread-persistence-adapter.js";
import { opencodeConnectionDefaultsSchema, type OpenCodeConnectionDefaults } from "./opencode-backend-configuration.js";
import { openCodeSelectionSchema, qualifiedOpenCodeModelId } from "./opencode-model-selection.js";
import { OpenCodeSavedAgentConfiguration } from "./opencode-saved-agent-configuration.js";
import type { OpenCodeThreadSettingsRepository } from "./opencode-thread-settings-repository.js";

export const OPENCODE_SAVED_AGENT_PRESENTATION = Object.freeze({ typeId: savedAgentBackendTypeIdSchema.parse("opencode"),
  label: boundDisplayText("OpenCode"), brand: "opencode" as const });
export class OpenCodeSavedAgentBackendAdapter implements SavedAgentBackendAdapter {
  readonly typeId = savedAgentBackendTypeIdSchema.parse("opencode");
  readonly backendKind = "opencode" as const;
  readonly presentation = OPENCODE_SAVED_AGENT_PRESENTATION;
  readonly overrideSchemaVersion = 1;
  readonly #configuration;
  constructor(readonly input: { readonly persistence: OpenCodeBackendThreadPersistenceAdapter; readonly settings: OpenCodeThreadSettingsRepository;
    readonly modelPolicy: CompiledBackendModelPolicy; readonly resolveConnectionDefaults: (connection: AgentConnectionProfile) => OpenCodeConnectionDefaults | undefined }) {
    if (input.persistence.settings !== input.settings) throw unavailable();
    this.#configuration = new OpenCodeSavedAgentConfiguration(input);
  }
  validateOverrides(input: Parameters<SavedAgentBackendAdapter["validateOverrides"]>[0]) {
    return { backendTypeId: this.typeId, schemaVersion: this.overrideSchemaVersion, overrides: this.#configuration.validateOverrides(input.overrides) };
  }
  prepareResolutionContext(input: SavedAgentBackendContextInput) {
    this.#assertContext(input);
    const defaults = this.input.resolveConnectionDefaults(input.connection);
    if (!defaults) throw unavailable();
    return { backendTypeId: this.typeId, schemaVersion: this.overrideSchemaVersion, value: opencodeConnectionDefaultsSchema.parse(defaults) };
  }
  describeEditor(input: Parameters<SavedAgentBackendAdapter["describeEditor"]>[0]) {
    const prepared = this.#prepared(input);
    const fields = this.#configuration.describe(prepared);
    return normalizedAgentConfigurationDescriptorSchema.parse({ backendTypeId: this.typeId,
      fields: fields.map(field => ({ id: field.id, label: boundDisplayText(field.label), description: boundDisplayText(field.description),
        currentDefaultValue: field.defaultValue, resolvedValue: field.resolvedValue,
        options: field.options.map(option => ({ ...option, label: boundDisplayText(option.label),
          ...(option.unavailableReason ? { unavailableReason: boundDisplayText(option.unavailableReason) } : {}) })) })),
      canonicalOverrides: prepared.overrides });
  }
  resolve(input: Parameters<SavedAgentBackendAdapter["resolve"]>[0]) {
    const resolved = this.#configuration.resolve(this.#prepared(input));
    return { backendTypeId: this.typeId, schemaVersion: this.overrideSchemaVersion,
      normalizedValues: [{ id: "model", value: qualifiedOpenCodeModelId(resolved.selection) },
        { id: "reasoning_effort", value: resolved.selection.variant ?? "default" }], value: resolved.selection };
  }
  captureThreadConfiguration(input: Parameters<SavedAgentBackendAdapter["captureThreadConfiguration"]>[0]) {
    this.#assertContext(input);
    const settings = this.input.persistence.readDesiredSettings(input.scope, input.applicationThreadId, input.connection);
    if (!settings.desired) throw new DomainError("invalid_transition", "Choose complete OpenCode settings before copying this thread configuration.");
    const canonical = this.validateOverrides({ overrides: [{ id: "model", value: qualifiedOpenCodeModelId(settings.desired) },
      { id: "reasoning_effort", value: settings.desired.variant ?? "default" }] });
    return { ...canonical, settingsRevision: settings.revision };
  }
  assertThreadConfigurationCapture(input: Parameters<SavedAgentBackendAdapter["assertThreadConfigurationCapture"]>[0]): void {
    this.#transaction(input.transaction); this.#envelope(input.capture);
    const current = this.captureThreadConfiguration(input);
    if (current.settingsRevision !== input.capture.settingsRevision || JSON.stringify(current.overrides) !== JSON.stringify(input.capture.overrides)) throw new DomainError("conflict", "The source OpenCode settings changed while the new thread was created.");
  }
  initializeNewThread(input: Parameters<SavedAgentBackendAdapter["initializeNewThread"]>[0]): void {
    this.#transaction(input.transaction); this.#assertContext(input); this.#envelope(input.resolved);
    this.input.persistence.initializeResolvedNewThread(input.scope, input.applicationThreadId, input.connection, openCodeSelectionSchema.parse(input.resolved.value));
  }
  #prepared(input: Parameters<SavedAgentBackendAdapter["resolve"]>[0]) {
    this.#assertContext(input); this.#envelope(input.prepared); this.#envelope(input.overrides);
    return { connection: input.connection, catalog: input.catalog, defaults: opencodeConnectionDefaultsSchema.parse(input.prepared.value),
      overrides: this.#configuration.validateOverrides(input.overrides.overrides) };
  }
  #transaction(transaction: Parameters<SavedAgentBackendAdapter["initializeNewThread"]>[0]["transaction"]): void {
    transaction.assertActive(); if (transaction.database !== this.input.persistence.database) throw unavailable();
  }
  #envelope(input: { readonly backendTypeId: unknown; readonly schemaVersion: unknown }): void {
    if (input.backendTypeId !== this.typeId || input.schemaVersion !== this.overrideSchemaVersion) throw unavailable();
  }
  #assertContext(input: { readonly scope: SavedAgentBackendContextInput["scope"]; readonly connection: AgentConnectionProfile }): void {
    this.input.settings.assertScope(input.scope);
    if (input.connection.kind !== "opencode_http" || input.connection.backendInstanceId !== this.input.settings.backendInstanceId ||
      input.connection.tenantId !== input.scope.tenantId || input.connection.ownerPrincipalId !== input.scope.principalId) throw unavailable();
  }
}
function unavailable(): DomainError { return new DomainError("invalid_transition", "The OpenCode Saved Agent configuration is unavailable."); }
