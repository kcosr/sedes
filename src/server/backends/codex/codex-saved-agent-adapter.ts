import {
  normalizedAgentConfigurationDescriptorSchema,
  savedAgentBackendTypeIdSchema,
  type AgentConfigurationFieldDescriptor,
  type NormalizedAgentConfigurationOverrides,
} from "../../../shared/protocol/saved-agents.js";
import { DomainError } from "../../domain/errors.js";
import { boundDisplayText } from "../../conversations/payload-policy.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type {
  CanonicalSavedAgentBackendOverrides,
  CapturedThreadBackendConfiguration,
  PreparedSavedAgentBackendContext,
  ResolvedSavedAgentBackendConfiguration,
  SavedAgentBackendAdapter,
  SavedAgentBackendContextInput,
} from "../saved-agent-adapter.js";
import { BACKEND_BRANDS, type AgentConnectionProfile } from "../contracts.js";
import type { CodexConnectionModuleConfiguration } from "./codex-backend-configuration.js";
import type { CompiledBackendModelPolicy } from "../model-policy.js";
import { CodexBackendThreadPersistenceAdapter } from "./codex-backend-thread-persistence-adapter.js";
import {
  CodexSavedAgentConfiguration,
  type ResolvedCodexSavedAgentConfiguration,
} from "./codex-saved-agent-configuration.js";
import {
  isCodexApprovalPolicy,
  isCodexApprovalReviewer,
  isCodexNetworkAccess,
  isCodexSandboxMode,
  type CodexExecutionPolicyAllowlist,
} from "./codex-execution-policy.js";
import { codexServiceTierSelectionSchema } from "./codex-service-tier.js";
import type { CodexExecutionSettingsTuple } from "./codex-thread-execution-settings-repository.js";

export const CODEX_SAVED_AGENT_BACKEND_TYPE_ID =
  savedAgentBackendTypeIdSchema.parse("codex");
export const CODEX_SAVED_AGENT_OVERRIDE_SCHEMA_VERSION = 1;

type PreparedCodexSavedAgentContext = {
  readonly defaults: CodexConnectionModuleConfiguration["defaults"];
};

/** Compiled Codex contribution to the normalized SavedAgent registry. */
export class CodexSavedAgentBackendAdapter implements SavedAgentBackendAdapter {
  readonly typeId = CODEX_SAVED_AGENT_BACKEND_TYPE_ID;
  readonly backendKind = "codex_app_server" as const;
  readonly presentation = Object.freeze({
    typeId: CODEX_SAVED_AGENT_BACKEND_TYPE_ID,
    label: boundDisplayText("Codex"),
    brand: BACKEND_BRANDS.codex_app_server,
  });
  readonly overrideSchemaVersion = CODEX_SAVED_AGENT_OVERRIDE_SCHEMA_VERSION;
  readonly #executionPolicy: CodexExecutionPolicyAllowlist;
  readonly #modelPolicy: CompiledBackendModelPolicy;
  readonly #backendInstanceId: string;
  readonly #resolveConnectionDefaults: (
    connection: AgentConnectionProfile,
  ) => CodexConnectionModuleConfiguration["defaults"] | undefined;
  readonly #persistence: CodexBackendThreadPersistenceAdapter;

  constructor(input: {
    readonly executionPolicy: CodexExecutionPolicyAllowlist;
    readonly modelPolicy: CompiledBackendModelPolicy;
    readonly backendInstanceId: string;
    readonly resolveConnectionDefaults: (
      connection: AgentConnectionProfile,
    ) => CodexConnectionModuleConfiguration["defaults"] | undefined;
    readonly persistence: CodexBackendThreadPersistenceAdapter;
  }) {
    if (
      !(input.persistence instanceof CodexBackendThreadPersistenceAdapter) ||
      input.backendInstanceId.length === 0
    ) {
      throw new Error("codex_saved_agent_persistence_invalid");
    }
    this.#executionPolicy = input.executionPolicy;
    this.#modelPolicy = input.modelPolicy;
    this.#backendInstanceId = input.backendInstanceId;
    this.#resolveConnectionDefaults = input.resolveConnectionDefaults;
    this.#persistence = input.persistence;
  }

  validateOverrides(input: {
    readonly overrides: NormalizedAgentConfigurationOverrides;
  }): CanonicalSavedAgentBackendOverrides {
    const configuration = this.#configuration(() => undefined);
    return Object.freeze({
      backendTypeId: this.typeId,
      schemaVersion: this.overrideSchemaVersion,
      overrides: [...configuration.validateOverrides(input.overrides)],
    });
  }

  prepareResolutionContext(
    input: SavedAgentBackendContextInput,
  ): PreparedSavedAgentBackendContext {
    this.#assertContext(input);
    const defaults = this.#resolveConnectionDefaults(input.connection);
    if (!defaults) throw unavailable();
    return Object.freeze({
      backendTypeId: this.typeId,
      schemaVersion: this.overrideSchemaVersion,
      value: Object.freeze({ defaults }),
    });
  }

  describeEditor(
    input: SavedAgentBackendContextInput & {
      readonly prepared: PreparedSavedAgentBackendContext;
      readonly overrides: CanonicalSavedAgentBackendOverrides;
    },
  ) {
    const { resolution, canonicalOverrides } = this.#resolve(input);
    return normalizedAgentConfigurationDescriptorSchema.parse({
      backendTypeId: this.typeId,
      fields: resolution.fields.map(
        ({
          defaultValue,
          resolvedValue,
          options,
          label,
          description,
          ...field
        }) =>
          ({
            ...field,
            label: { text: label },
            description: { text: description },
            currentDefaultValue: defaultValue,
            resolvedValue,
            options: options.map(
              ({ reason, label: optionLabel, ...option }) => ({
                ...option,
                label: { text: optionLabel },
                ...(reason ? { unavailableReason: { text: reason } } : {}),
              }),
            ),
          }) satisfies AgentConfigurationFieldDescriptor,
      ),
      canonicalOverrides: [...canonicalOverrides],
    });
  }

  resolve(
    input: SavedAgentBackendContextInput & {
      readonly prepared: PreparedSavedAgentBackendContext;
      readonly overrides: CanonicalSavedAgentBackendOverrides;
    },
  ): ResolvedSavedAgentBackendConfiguration {
    const { resolution } = this.#resolve(input);
    return Object.freeze({
      backendTypeId: this.typeId,
      schemaVersion: this.overrideSchemaVersion,
      normalizedValues: completeNormalizedValues(resolution),
      value: resolution.settings,
    });
  }

  captureThreadConfiguration(input: {
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly connection: AgentConnectionProfile;
  }): CapturedThreadBackendConfiguration {
    const settings = this.#persistence.readDesiredSettings(
      input.scope,
      input.applicationThreadId,
      input.connection,
    );
    if (!settings.desired) {
      throw new DomainError(
        "invalid_transition",
        "Choose complete Codex execution settings before copying this thread configuration.",
      );
    }
    const canonical = this.validateOverrides({
      overrides: normalizedValues(settings.desired),
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
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    readonly connection: AgentConnectionProfile;
    readonly capture: CapturedThreadBackendConfiguration;
  }): void {
    input.transaction.assertActive();
    if (input.transaction.database !== this.#persistence.database) {
      throw new Error("codex_thread_configuration_capture_database_mismatch");
    }
    assertEnvelope(input.capture, this.typeId, this.overrideSchemaVersion);
    const current = this.#persistence.readDesiredSettings(
      input.scope,
      input.applicationThreadId,
      input.connection,
    );
    if (current.revision !== input.capture.settingsRevision) {
      throw new DomainError(
        "conflict",
        "The source Codex settings changed while the new thread was created.",
      );
    }
  }

  initializeNewThread(
    input: Parameters<SavedAgentBackendAdapter["initializeNewThread"]>[0],
  ): void {
    input.transaction.assertActive();
    if (input.transaction.database !== this.#persistence.database) {
      throw new Error("codex_saved_agent_transaction_mismatch");
    }
    this.#assertConnectionScope(input.scope, input.connection);
    if (
      input.resolved.backendTypeId !== this.typeId ||
      input.resolved.schemaVersion !== this.overrideSchemaVersion
    ) {
      throw unavailable();
    }
    this.#persistence.initializeResolvedNewThread(
      input.scope,
      input.applicationThreadId,
      input.connection,
      requireResolvedTuple(input.resolved.value),
    );
  }

  #resolve(
    input: SavedAgentBackendContextInput & {
      readonly prepared: PreparedSavedAgentBackendContext;
      readonly overrides: CanonicalSavedAgentBackendOverrides;
    },
  ): {
    readonly resolution: ResolvedCodexSavedAgentConfiguration;
    readonly canonicalOverrides: NormalizedAgentConfigurationOverrides;
  } {
    this.#assertContext(input);
    assertEnvelope(input.prepared, this.typeId, this.overrideSchemaVersion);
    assertEnvelope(input.overrides, this.typeId, this.overrideSchemaVersion);
    const prepared = requirePrepared(input.prepared.value);
    const configuration = this.#configuration(() => prepared.defaults);
    const canonicalOverrides = configuration.validateOverrides(
      input.overrides.overrides,
    );
    return {
      resolution: configuration.resolve({
        connection: input.connection,
        catalog: input.catalog,
        overrides: canonicalOverrides,
      }),
      canonicalOverrides: [...canonicalOverrides],
    };
  }

  #configuration(
    resolveConnectionDefaults: (
      connection: AgentConnectionProfile,
    ) => CodexConnectionModuleConfiguration["defaults"] | undefined,
  ): CodexSavedAgentConfiguration {
    return new CodexSavedAgentConfiguration({
      executionPolicy: this.#executionPolicy,
      modelPolicy: this.#modelPolicy,
      resolveConnectionDefaults,
    });
  }

  #assertContext(input: SavedAgentBackendContextInput): void {
    this.#assertConnectionScope(input.scope, input.connection);
    if (
      input.workspace.summary.environmentId !==
      input.connection.executionEnvironmentId
    ) {
      throw unavailable();
    }
  }

  #assertConnectionScope(
    scope: RequestScope,
    connection: AgentConnectionProfile,
  ): void {
    if (
      connection.kind !== "codex_app_server" ||
      !connection.enabled ||
      connection.tenantId !== scope.tenantId ||
      connection.ownerPrincipalId !== scope.principalId ||
      connection.backendInstanceId !== this.#backendInstanceId
    ) {
      throw unavailable();
    }
  }
}

function assertEnvelope(
  value: { readonly backendTypeId: unknown; readonly schemaVersion: number },
  typeId: typeof CODEX_SAVED_AGENT_BACKEND_TYPE_ID,
  schemaVersion: number,
): void {
  if (value.backendTypeId !== typeId || value.schemaVersion !== schemaVersion) {
    throw unavailable();
  }
}

function requirePrepared(value: unknown): PreparedCodexSavedAgentContext {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => key !== "defaults") ||
    !("defaults" in value) ||
    typeof value.defaults !== "object" ||
    value.defaults === null ||
    Array.isArray(value.defaults)
  ) {
    throw unavailable();
  }
  const defaults = value.defaults as Record<string, unknown>;
  const model = defaults.model as Record<string, unknown> | undefined;
  if (
    Object.keys(defaults).some(
      (key) =>
        key !== "model" &&
        key !== "sandboxMode" &&
        key !== "networkAccess" &&
        key !== "approvalPolicy" &&
        key !== "approvalReviewer",
    ) ||
    !model ||
    Array.isArray(model) ||
    (model.type !== "catalogDefault" && model.type !== "fixed") ||
    Object.keys(model).some((key) => key !== "type" && key !== "modelId") ||
    (model.type === "catalogDefault" && "modelId" in model) ||
    (model.type === "fixed" &&
      (typeof model.modelId !== "string" ||
        model.modelId.length === 0 ||
        model.modelId.length > 120)) ||
    !isCodexSandboxMode(defaults.sandboxMode) ||
    !isCodexNetworkAccess(defaults.networkAccess) ||
    !isCodexApprovalPolicy(defaults.approvalPolicy) ||
    !isCodexApprovalReviewer(defaults.approvalReviewer)
  ) {
    throw unavailable();
  }
  return value as PreparedCodexSavedAgentContext;
}

function requireResolvedTuple(value: unknown): CodexExecutionSettingsTuple {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) =>
        key !== "model" &&
        key !== "reasoningEffort" &&
        key !== "serviceTier" &&
        key !== "sandboxMode" &&
        key !== "networkAccess" &&
        key !== "approvalPolicy" &&
        key !== "approvalReviewer",
    ) ||
    !("model" in value) ||
    typeof value.model !== "string" ||
    value.model.length === 0 ||
    value.model.length > 120 ||
    !("reasoningEffort" in value) ||
    typeof value.reasoningEffort !== "string" ||
    value.reasoningEffort.length === 0 ||
    value.reasoningEffort.length > 120 ||
    !("serviceTier" in value) ||
    !codexServiceTierSelectionSchema.safeParse(value.serviceTier).success ||
    !("sandboxMode" in value) ||
    !isCodexSandboxMode(value.sandboxMode) ||
    !("networkAccess" in value) ||
    !isCodexNetworkAccess(value.networkAccess) ||
    !("approvalPolicy" in value) ||
    !isCodexApprovalPolicy(value.approvalPolicy) ||
    !("approvalReviewer" in value) ||
    !isCodexApprovalReviewer(value.approvalReviewer)
  ) {
    throw unavailable();
  }
  return value as CodexExecutionSettingsTuple;
}

function completeNormalizedValues(
  resolution: ResolvedCodexSavedAgentConfiguration,
): NormalizedAgentConfigurationOverrides {
  return normalizedValues(resolution.settings);
}

function normalizedValues(
  settings: CodexExecutionSettingsTuple,
): NormalizedAgentConfigurationOverrides {
  return [
    { id: "model", value: settings.model },
    { id: "reasoning_effort", value: settings.reasoningEffort },
    { id: "service_tier", value: settings.serviceTier },
    { id: "sandbox_mode", value: settings.sandboxMode },
    { id: "network_access", value: settings.networkAccess },
    { id: "approval_policy", value: settings.approvalPolicy },
    { id: "approval_reviewer", value: settings.approvalReviewer },
  ].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function unavailable(): DomainError {
  return new DomainError(
    "conflict",
    "The Codex target is unavailable for this Agent.",
  );
}
