import { z } from "zod";
import { antigravityConnectionDefaultsSchema } from "../../../shared/protocol/antigravity-configuration.js";
import {
  normalizedAgentConfigurationDescriptorSchema, normalizedAgentConfigurationOverridesSchema,
  type AgentConfigurationFieldDescriptor, type AgentConfigurationOption,
} from "../../../shared/protocol/saved-agents.js";
import { reasoningEffortLabel } from "../../../shared/reasoning-effort-label.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import { DomainError } from "../../domain/errors.js";
import { BACKEND_BRANDS } from "../contracts.js";
import type {
  CanonicalSavedAgentBackendOverrides, PreparedSavedAgentBackendContext, SavedAgentBackendAdapter,
  SavedAgentBackendContextInput,
} from "../saved-agent-adapter.js";
import type { AntigravityModeCatalog } from "./mode-catalog.js";
import { ANTIGRAVITY_MODE_ACTIONS, ANTIGRAVITY_MODES, antigravityModeFeatureModule } from "./mode-feature.js";
import { antigravityAvailableModels, antigravityCatalogAllowsSelection, antigravitySettingsForDefaults } from "./model-selection.js";
import type { AntigravityThreadPersistence } from "./thread-persistence.js";
import type { AntigravityDesiredSettings } from "./thread-repository.js";

const typeId = "antigravity";
const schemaVersion = 1;
const envelope = { backendTypeId: typeId, schemaVersion } as const;
const modeSchema = z.enum(ANTIGRAVITY_MODES);
const overrideSchema = antigravityConnectionDefaultsSchema.extend({ modeId: modeSchema.optional() });
const preparedSchema = z.strictObject({ defaults: antigravityConnectionDefaultsSchema, modes: z.array(modeSchema) });
type ResolveInput = Parameters<SavedAgentBackendAdapter["resolve"]>[0];

export class AntigravitySavedAgentAdapter implements SavedAgentBackendAdapter {
  readonly typeId = typeId;
  readonly backendKind = "antigravity" as const;
  readonly presentation = { typeId, label: boundDisplayText("Antigravity"), brand: BACKEND_BRANDS.antigravity };
  readonly overrideSchemaVersion = schemaVersion;

  constructor(readonly persistence: AntigravityThreadPersistence, readonly modes: AntigravityModeCatalog) {}

  validateOverrides(input: Parameters<SavedAgentBackendAdapter["validateOverrides"]>[0]): CanonicalSavedAgentBackendOverrides {
    // Durable records validate by backend type. Live availability is checked
    // separately when the selected target resolves the configuration.
    const overrides = normalizedAgentConfigurationOverridesSchema.parse(input.overrides);
    const values = parseOverrides(overrides);
    return { ...envelope, overrides: settingsValues(values) };
  }

  prepareResolutionContext(input: SavedAgentBackendContextInput): PreparedSavedAgentBackendContext {
    this.persistence.assertConnection(input.scope, input.connection);
    const defaults = this.persistence.input.defaultsForConnection(input.connection.id);
    if (!defaults) throw unavailable();
    return { ...envelope, value: { defaults, modes: [...this.modes.modes] } };
  }

  describeEditor(input: ResolveInput) {
    const { canonical, defaults, models, modes, settings } = this.#selection(input);
    const model = models.find(item => item.id === settings.modelId);
    // Reserve room for both values when the selected model no longer offers them.
    const effortOptions = (model?.supportedReasoningEfforts ?? []).slice(0, 510)
      .map(effort => option(effort, reasoningEffortLabel(effort)));
    for (const effort of [defaults.thinkingLevel, settings.thinkingLevel]) {
      if (effort !== null && !effortOptions.some(item => item.value === effort)) {
        effortOptions.push({ value: effort, label: boundDisplayText(reasoningEffortLabel(effort)), available: false });
      }
    }
    const modeOptions = modes.map(mode => {
      const action = antigravityModeFeatureModule.operations.find(operation => operation.actionId === ANTIGRAVITY_MODE_ACTIONS[mode]);
      return option(mode, action?.label.text ?? mode);
    });
    for (const mode of new Set([defaults.modeId, settings.modeId])) {
      if (mode !== null && !modeOptions.some(item => item.value === mode)) {
        modeOptions.push({ value: mode, label: boundDisplayText(`${mode} (unavailable)`), available: false });
      }
    }
    const fields: AgentConfigurationFieldDescriptor[] = [
      field("model", "Model", defaults.modelId, settings.modelId,
        models.slice(0, 511).map(item => option(item.id, item.label))),
      field("reasoning_effort", "Reasoning effort", defaults.thinkingLevel, settings.thinkingLevel, effortOptions),
      field("mode", "Mode", defaults.modeId, settings.modeId, modeOptions),
    ];
    return normalizedAgentConfigurationDescriptorSchema.parse({
      backendTypeId: typeId, fields, canonicalOverrides: canonical.overrides,
    });
  }

  resolve(input: ResolveInput) {
    const { models, modes, settings } = this.#selection(input);
    if (!antigravityCatalogAllowsSelection(models, settings)) throw unavailable();
    assertModeAvailable(settings.modeId, modes);
    return { ...envelope, normalizedValues: settingsValues(settings), value: settings };
  }

  captureThreadConfiguration(input: Parameters<SavedAgentBackendAdapter["captureThreadConfiguration"]>[0]) {
    this.persistence.assertConnection(input.scope, input.connection);
    this.persistence.input.settings.assertConnection(input.scope, input.applicationThreadId, input.connection);
    const settings = this.persistence.input.settings.get(input.scope, input.applicationThreadId);
    if (settings.modelId === null) throw unavailable();
    return { ...envelope, settingsRevision: settings.revision, overrides: settingsValues(settings) };
  }

  assertThreadConfigurationCapture(input: Parameters<SavedAgentBackendAdapter["assertThreadConfigurationCapture"]>[0]): void {
    this.#assertTransaction(input);
    assertEnvelope(input.capture);
    const current = this.captureThreadConfiguration(input);
    if (input.capture.settingsRevision !== current.settingsRevision ||
        JSON.stringify(input.capture.overrides) !== JSON.stringify(current.overrides)) {
      throw new DomainError("conflict", "The source Antigravity settings changed while the new thread was created.");
    }
  }

  initializeNewThread(input: Parameters<SavedAgentBackendAdapter["initializeNewThread"]>[0]): void {
    this.#assertTransaction(input);
    assertEnvelope(input.resolved);
    const desired = parseOverrides(normalizedAgentConfigurationOverridesSchema.parse(input.resolved.normalizedValues));
    assertModeAvailable(desired.modeId, this.modes.modes);
    this.persistence.initializeResolvedNewThread(input.scope, input.applicationThreadId, input.connection, desired);
  }

  #selection(input: ResolveInput) {
    this.persistence.assertConnection(input.scope, input.connection);
    assertEnvelope(input.prepared);
    assertEnvelope(input.overrides);
    const models = antigravityAvailableModels(input.catalog, input.connection.id, this.persistence.input.modelPolicy);
    const canonical = this.validateOverrides(input.overrides);
    const { defaults, modes } = preparedSchema.parse(input.prepared.value);
    const override = parseOverrides(canonical.overrides);
    const modelId = override.modelId ?? defaults.modelId;
    const thinkingLevel = override.thinkingLevel ?? (override.modelId === null || override.modelId === defaults.modelId ? defaults.thinkingLevel : undefined);
    const settings = antigravitySettingsForDefaults(models, { modelId, thinkingLevel, modeId: override.modeId ?? defaults.modeId });
    return { canonical, defaults: antigravitySettingsForDefaults(models, defaults), models, modes, settings };
  }

  #assertTransaction(input: Pick<Parameters<SavedAgentBackendAdapter["assertThreadConfigurationCapture"]>[0], "transaction">): void {
    input.transaction.assertActive();
    if (input.transaction.database !== this.persistence.database) throw unavailable();
  }
}

function parseOverrides(overrides: CanonicalSavedAgentBackendOverrides["overrides"]): AntigravityDesiredSettings {
  const ids = new Set(["model", "reasoning_effort", "mode"]);
  if (overrides.some(item => !ids.has(item.id))) throw unavailable();
  const values = new Map(overrides.map(({ id, value }) => [id, value]));
  const parsed = overrideSchema.safeParse({
    modelId: values.get("model"), thinkingLevel: values.get("reasoning_effort"), modeId: values.get("mode"),
  });
  if (!parsed.success) throw unavailable();
  return { modelId: parsed.data.modelId ?? null, thinkingLevel: parsed.data.thinkingLevel ?? null, modeId: parsed.data.modeId ?? null };
}

function settingsValues(settings: AntigravityDesiredSettings) {
  // Saved Agent storage requires overrides in field ID order.
  return [
    ...(settings.modeId === null ? [] : [{ id: "mode", value: settings.modeId }]),
    ...(settings.modelId === null ? [] : [{ id: "model", value: settings.modelId }]),
    ...(settings.thinkingLevel === null ? [] : [{ id: "reasoning_effort", value: settings.thinkingLevel }]),
  ];
}

function option(value: string, label: string): AgentConfigurationOption {
  return { value, label: boundDisplayText(label), available: true };
}

function field(id: string, label: string, defaultValue: string | null, resolvedValue: string | null, options: AgentConfigurationOption[]): AgentConfigurationFieldDescriptor {
  if (resolvedValue !== null && !options.some(item => item.value === resolvedValue)) {
    options.push({ value: resolvedValue, label: boundDisplayText(resolvedValue), available: false });
  }
  return { id, label: boundDisplayText(label), currentDefaultValue: defaultValue, resolvedValue, options };
}

function assertEnvelope(value: { readonly backendTypeId: string; readonly schemaVersion: number }): void {
  if (value.backendTypeId !== envelope.backendTypeId || value.schemaVersion !== envelope.schemaVersion) throw unavailable();
}

function assertModeAvailable(mode: string | null, advertised: readonly string[]): void {
  if (mode !== null && !advertised.includes(mode)) {
    throw new DomainError("invalid_transition", "The selected Antigravity mode is unavailable on this target.");
  }
}

function unavailable(): DomainError {
  return new DomainError("invalid_transition", "The Antigravity agent configuration is unavailable.");
}
