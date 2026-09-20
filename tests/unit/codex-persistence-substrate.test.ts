import type Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type {
  AgentBackendInstance,
  AgentConnectionProfile,
} from "../../src/server/backends/contracts.js";
import {
  parseCodexBindingDetail,
  serializeCodexBindingDetail,
} from "../../src/server/backends/codex/codex-binding-codec.js";
import { CodexThreadActionPersistence } from "../../src/server/backends/codex/codex-thread-action-persistence.js";
import { CodexThreadExecutionSettingsRepository } from "../../src/server/backends/codex/codex-thread-execution-settings-repository.js";
import { ProviderFeatureMutationRepository } from "../../src/server/db/repositories/provider-feature-mutation-repository.js";
import { CodexThreadPresentationProvider } from "../../src/server/backends/codex/codex-thread-presentation-provider.js";
import { encodeCodexModelSetting } from "../../src/server/backends/codex/codex-setting-values.js";
import type {
  CodexExecutionPolicyAllowlist,
  CodexExecutionPolicySelection,
} from "../../src/server/backends/codex/codex-execution-policy.js";
import { boundValue } from "../../src/server/conversations/payload-policy.js";
import { DomainError } from "../../src/server/domain/errors.js";
import {
  compileBackendModelPolicy,
  type CompiledBackendModelPolicy,
} from "../../src/server/backends/model-policy.js";

const scope = Object.freeze({
  tenantId: "tenant-codex",
  principalId: "principal-codex",
});
const catalogModelPolicy = compileBackendModelPolicy(
  { type: "catalog" },
  "model_effort",
);

const backend: AgentBackendInstance = Object.freeze({
  id: "codex-primary",
  tenantId: scope.tenantId,
  kind: "codex_app_server",
  label: "Codex",
  enabled: true,
  configurationRevision: 7,
  protocolRelease: "0.153.0",
});

const connection: AgentConnectionProfile = Object.freeze({
  id: "codex-profile",
  tenantId: scope.tenantId,
  ownerPrincipalId: scope.principalId,
  templateId: "codex-local",
  kind: "codex_app_server",
  backendInstanceId: backend.id,
  executionEnvironmentId: "environment-local",
  label: "Local Codex",
  enabled: true,
  configurationRevision: 9,
});

const executionPolicy = Object.freeze({
  allowedSandboxModes: ["read-only", "workspace-write", "danger-full-access"],
  allowedNetworkAccess: ["disabled", "enabled"],
  allowedApprovalPolicies: ["on-request", "never"],
  allowedApprovalReviewers: ["user", "auto_review"],
} satisfies CodexExecutionPolicyAllowlist);

const defaultExecutionPolicy = Object.freeze({
  sandboxMode: "read-only" as const,
  networkAccess: "disabled" as const,
  approvalPolicy: "never" as const,
  approvalReviewer: "user" as const,
});

describe("Codex binding detail codec", () => {
  it("round-trips one canonical bounded versioned native identity", () => {
    const serialized = serializeCodexBindingDetail({
      threadId: "0198f42e-bb19-7de0-91ac-44e3e77bd533",
      sessionId: "session-native",
      nativeAncestry: {
        forkedFromThreadId: "thread-parent",
        sourceTurnId: "turn-selected",
      },
      correlationAncestorThreadIds: ["thread-parent"],
    });

    expect(serialized).toBe(
      '{"version":2,"threadId":"0198f42e-bb19-7de0-91ac-44e3e77bd533","sessionId":"session-native","correlationAncestorThreadIds":["thread-parent"],"nativeAncestry":{"forkedFromThreadId":"thread-parent","sourceTurnId":"turn-selected"}}',
    );
    expect(parseCodexBindingDetail(serialized)).toEqual({
      version: 2,
      threadId: "0198f42e-bb19-7de0-91ac-44e3e77bd533",
      sessionId: "session-native",
      nativeAncestry: {
        forkedFromThreadId: "thread-parent",
        sourceTurnId: "turn-selected",
      },
      correlationAncestorThreadIds: ["thread-parent"],
    });
  });

  it.each([
    "",
    "not-json",
    "{}",
    '{"version":1,"threadId":"thread"}',
    '{"version":1,"threadId":"thread","path":"/secret"}',
    '{"version":1,"threadId":"bad\\nthread"}',
    `{"version":1,"threadId":"${"x".repeat(129)}"}`,
    " ".repeat(4_097),
  ])("rejects malformed or over-limit detail %#", (value) => {
    expect(() => parseCodexBindingDetail(value)).toThrow(
      "codex_binding_detail_invalid",
    );
  });
});

describe("Codex interactive presentation collaborators", () => {
  it("publishes bounded catalog state with normalized Codex settings", async () => {
    const provider = presentationProvider();
    const presentation = await provider.read({
      scope,
      applicationThreadId: "thread-one",
      backend,
      connection,
      workspace: {
        authorityRevision: 0,
        summary: {
          id: "workspace-one",
          environmentId: connection.executionEnvironmentId,
          displayName: "Workspace",
          displayPath: "/workspace",
          availability: "available",
          trustState: "trusted",
          revision: 0,
        },
        canonicalPath: "/workspace",
      },
      catalog: {
        models: [
          {
            provider: connection.id,
            id: "gpt-5.6-codex",
            label: "GPT-5.6 Codex",
            supportedReasoningEfforts: ["low", "high", "xhigh", "max"],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
          },
        ],
        commands: [
          {
            invocation: "/review",
            source: "prompt",
            description: "Review the current changes",
          },
          {
            invocation: "/review",
            source: "prompt",
            description: "Duplicate",
          },
          {
            invocation: "not-a-command",
            source: "prompt",
          },
        ],
        skills: [],
        notices: [],
      },
      effectiveSettings: {
        model: { provider: connection.id, id: "gpt-5.6-codex" },
        thinkingLevel: "high",
      },
    });

    expect(presentation).toMatchObject({
      revision: expect.stringMatching(/^codex_/),
      backend: {
        label: { text: "Codex" },
        brand: "codex",
        modelLabel: { text: "GPT-5.6 Codex" },
      },
      interactionMode: "interactive",
      automationAllowed: true,
      settings: {
        revision: 0,
        values: expect.arrayContaining([
          expect.objectContaining({
            id: "thinking_level",
            desiredValue: "high",
            effectiveValue: "high",
            applicationState: "effective",
          }),
        ]),
      },
      settingDescriptors: expect.arrayContaining([
        expect.objectContaining({ id: "model", available: true }),
        expect.objectContaining({ id: "thinking_level", available: true }),
      ]),
      providerFeatureCapabilities: [
        expect.objectContaining({
          ref: { featureId: "codex.execution", schemaVersion: 1 },
        }),
      ],
      providerFeatureStates: [
        expect.objectContaining({
          ref: { featureId: "codex.execution", schemaVersion: 1 },
          state: boundValue({
            desired: { ...defaultExecutionPolicy },
            effective: { ...defaultExecutionPolicy },
          }),
        }),
      ],
      composerCommands: [
        {
          invocation: "/review",
          source: "prompt",
          description: { text: "Review the current changes" },
        },
      ],
    });
    const selectedModelValue = encodeCodexModelSetting(
      "gpt-5.6-codex",
      "high",
      false,
      "standard",
    );
    expect(
      presentation.settings.values.find(({ id }) => id === "model"),
    ).toMatchObject({
      desiredValue: selectedModelValue,
      effectiveValue: selectedModelValue,
    });
    expect(
      presentation.settingDescriptors
        .find(({ id }) => id === "model")
        ?.options.filter(({ value }) => value === selectedModelValue),
    ).toEqual([
      {
        value: selectedModelValue,
        label: { text: "GPT-5.6 Codex" },
        available: true,
      },
    ]);
    expect(
      presentation.settingDescriptors
        .find(({ id }) => id === "thinking_level")
        ?.options.filter(({ value }) => value === "xhigh" || value === "max"),
    ).toEqual([
      {
        value: "xhigh",
        label: { text: "Extra High" },
        available: true,
      },
      {
        value: "max",
        label: { text: "Maximum" },
        available: true,
      },
    ]);

    const conservative = await provider.read({
      scope,
      applicationThreadId: "thread-one",
      backend,
      connection,
      workspace: {
        authorityRevision: 0,
        summary: {
          id: "workspace-one",
          environmentId: connection.executionEnvironmentId,
          displayName: "Workspace",
          displayPath: "/workspace",
          availability: "available",
          trustState: "trusted",
          revision: 1,
        },
        canonicalPath: "/workspace",
      },
    });
    expect(conservative).toMatchObject({
      settingDescriptors: expect.arrayContaining([
        expect.objectContaining({ id: "model", available: false }),
        expect.objectContaining({ id: "thinking_level", available: false }),
      ]),
      composerCommands: [],
    });
    expect(conservative.settings).toEqual(presentation.settings);
    expect(
      conservative.settingDescriptors
        .find(({ id }) => id === "model")
        ?.options.find(({ value }) => value === selectedModelValue),
    ).toMatchObject({ available: true });
    expect(
      conservative.settingDescriptors
        .find(({ id }) => id === "thinking_level")
        ?.options.find(({ value }) => value === "high"),
    ).toMatchObject({ available: true });
    expect(
      conservative.settingDescriptors
        .filter(({ requiredForFirstSubmission }) => requiredForFirstSubmission)
        .every((descriptor) => {
          const desiredValue = conservative.settings.values.find(
            ({ id }) => id === descriptor.id,
          )?.desiredValue;
          return descriptor.options.some(
            (option) =>
              option.available === true && option.value === desiredValue,
          );
        }),
    ).toBe(true);
  });

  it("withholds automation controls for a durable tuple denied by policy", async () => {
    const provider = presentationProvider({
      modelPolicy: compileBackendModelPolicy(
        {
          type: "denylist",
          denied: [
            {
              modelIds: ["gpt-5.6-codex"],
              reasoningEfforts: ["high"],
            },
          ],
        },
        "model_effort",
      ),
    });
    const presentation = await provider.read({
      scope,
      applicationThreadId: "thread-one",
      backend,
      connection,
      workspace: {
        authorityRevision: 0,
        summary: {
          id: "workspace-one",
          environmentId: connection.executionEnvironmentId,
          displayName: "Workspace",
          displayPath: "/workspace",
          availability: "available",
          trustState: "trusted",
          revision: 1,
        },
        canonicalPath: "/workspace",
      },
    });

    expect(presentation.automationAllowed).toBe(false);
  });

  it("offers automation for an unrestricted attended manual-turn tuple", async () => {
    const provider = presentationProvider({
      desiredExecutionPolicy: {
        sandboxMode: "danger-full-access",
        networkAccess: "enabled",
        approvalPolicy: "on-request",
        approvalReviewer: "user",
      },
    });
    const presentation = await provider.read({
      scope,
      applicationThreadId: "thread-one",
      backend,
      connection,
      workspace: {
        authorityRevision: 0,
        summary: {
          id: "workspace-one",
          environmentId: connection.executionEnvironmentId,
          displayName: "Workspace",
          displayPath: "/workspace",
          availability: "available",
          trustState: "trusted",
          revision: 1,
        },
        canonicalPath: "/workspace",
      },
    });

    expect(presentation.automationAllowed).toBe(true);
  });

  it("advertises Fast mode only for an enabled loaded thread and supported model", async () => {
    const provider = presentationProvider({
      fastModeRuntime: {
        projection: () => ({
          revision: 1,
          enabled: true,
          availability: "available" as const,
        }),
      },
    });
    const presentation = await provider.read({
      scope,
      applicationThreadId: "thread-one",
      backend,
      connection,
      workspace: {
        authorityRevision: 0,
        summary: {
          id: "workspace-one",
          environmentId: connection.executionEnvironmentId,
          displayName: "Workspace",
          displayPath: "/workspace",
          availability: "available",
          trustState: "trusted",
          revision: 0,
        },
        canonicalPath: "/workspace",
      },
      catalog: {
        models: [
          {
            provider: connection.id,
            id: "gpt-5.6-codex",
            label: "GPT-5.6 Codex",
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
            fastMode: {
              supported: true,
              defaultSelection: "standard",
              description: "About 1.5x faster with higher usage.",
            },
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      },
      effectiveSettings: {
        model: { provider: connection.id, id: "gpt-5.6-codex" },
        thinkingLevel: "high",
      },
    });

    expect(
      presentation.providerFeatureCapabilities.map(({ ref }) => ref.featureId),
    ).toEqual(["codex.execution", "codex.fast_mode"]);
    expect(presentation.providerFeatureCapabilities[1]).toMatchObject({
      revision: 0,
      availability: "available",
      operations: [expect.objectContaining({ actionId: "enable" })],
    });
    expect(presentation.providerFeatureStates[1]).toMatchObject({
      ref: { featureId: "codex.fast_mode", schemaVersion: 1 },
      revision: 0,
      state: boundValue({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
      }),
    });
  });

  it("advertises Fast mode as pending on an eligible unbound draft", async () => {
    const provider = presentationProvider({ backingState: "unbound" });
    const presentation = await provider.read({
      scope,
      applicationThreadId: "thread-one",
      backend,
      connection,
      workspace: {
        authorityRevision: 0,
        summary: {
          id: "workspace-one",
          environmentId: connection.executionEnvironmentId,
          displayName: "Workspace",
          displayPath: "/workspace",
          availability: "available",
          trustState: "trusted",
          revision: 0,
        },
        canonicalPath: "/workspace",
      },
      catalog: {
        models: [
          {
            provider: connection.id,
            id: "gpt-5.6-codex",
            label: "GPT-5.6 Codex",
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
            fastMode: {
              supported: true,
              defaultSelection: "standard",
              description: "About 1.5x faster with higher usage.",
            },
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      },
      effectiveSettings: {
        model: { provider: connection.id, id: "gpt-5.6-codex" },
        thinkingLevel: "high",
      },
    });

    expect(
      presentation.providerFeatureCapabilities.map(({ ref }) => ref.featureId),
    ).toEqual(["codex.execution", "codex.fast_mode"]);
    expect(presentation.providerFeatureCapabilities[1]).toMatchObject({
      revision: 0,
      availability: "available",
      operations: [expect.objectContaining({ actionId: "enable" })],
    });
    expect(presentation.providerFeatureStates[1]).toMatchObject({
      ref: { featureId: "codex.fast_mode", schemaVersion: 1 },
      revision: 0,
      state: boundValue({
        desired: "standard",
        effective: null,
        applicationState: "pending",
      }),
    });
  });

  it("keeps an authoritatively enabled Fast control visible but read-only during provider loss", async () => {
    const provider = presentationProvider({
      fastModeRuntime: {
        projection: () => ({
          revision: 2,
          enabled: true,
          availability: "unavailable" as const,
          unavailableReason: "generation_changed",
        }),
      },
    });
    const presentation = await provider.read({
      scope,
      applicationThreadId: "thread-one",
      backend,
      connection,
      workspace: {
        authorityRevision: 0,
        summary: {
          id: "workspace-one",
          environmentId: connection.executionEnvironmentId,
          displayName: "Workspace",
          displayPath: "/workspace",
          availability: "available",
          trustState: "trusted",
          revision: 0,
        },
        canonicalPath: "/workspace",
      },
      catalog: {
        models: [
          {
            provider: connection.id,
            id: "gpt-5.6-codex",
            label: "GPT-5.6 Codex",
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "low",
            inputModalities: ["text"],
            fastMode: {
              supported: true,
              defaultSelection: "standard",
            },
          },
        ],
        commands: [],
        skills: [],
        notices: [],
      },
      effectiveSettings: {
        model: { provider: connection.id, id: "gpt-5.6-codex" },
        thinkingLevel: "high",
      },
    });

    expect(presentation.providerFeatureCapabilities[1]).toMatchObject({
      ref: { featureId: "codex.fast_mode", schemaVersion: 1 },
      availability: "read_only",
      operations: [],
    });
    expect(presentation.providerFeatureStates[1]).toMatchObject({
      state: boundValue({
        desired: "standard",
        effective: "standard",
        applicationState: "unknown",
      }),
    });
  });

  it("rejects a non-Codex target and unsupported settings", async () => {
    const provider = presentationProvider();
    await expect(
      provider.read({
        scope,
        applicationThreadId: "thread-one",
        backend: { ...backend, kind: "pi" },
        connection,
      }),
    ).rejects.toThrow("codex_thread_presentation_target_invalid");
    await expect(
      provider.read({
        scope,
        applicationThreadId: "thread-one",
        backend,
        connection,
        catalog: { models: [], commands: [], skills: [], notices: [] },
      }),
    ).rejects.toThrow("codex_thread_presentation_target_invalid");

    const database = {} as Database.Database;
    const actions = new CodexThreadActionPersistence({
      database,
      scope,
      backendInstanceId: backend.id,
      settings: new CodexThreadExecutionSettingsRepository(database),
      featureMutations: new ProviderFeatureMutationRepository(database),
      executionPolicy,
      modelPolicy: catalogModelPolicy,
      defaultExecutionPolicyByConnectionId: new Map([
        [connection.id, defaultExecutionPolicy],
      ]),
    });
    expect(
      actions.driverAction(
        { action: "rename", title: "Available" },
        "operation-one",
      ),
    ).toEqual({
      action: "rename",
      title: "Available",
      applicationOperationId: "operation-one",
    });
    expect(() =>
      actions.driverAction(
        {
          action: "set_setting",
          settingId: "model",
          value: "openai/gpt-5.6-codex",
        },
        "operation-settings",
      ),
    ).toThrow(
      expect.objectContaining<Partial<DomainError>>({
        code: "invalid_transition",
      }),
    );
  });
});

function presentationProvider(
  input: {
    readonly fastModeRuntime?: ConstructorParameters<
      typeof CodexThreadPresentationProvider
    >[0]["fastModeRuntime"];
    readonly backingState?: "unbound" | "bound";
    readonly modelPolicy?: CompiledBackendModelPolicy;
    readonly desiredExecutionPolicy?: CodexExecutionPolicySelection;
  } = {},
): CodexThreadPresentationProvider {
  const backingState = input.backingState ?? "bound";
  const database = {
    prepare: () => ({
      get: () => ({ backingState, enabledAutomation: 0 }),
    }),
  } as unknown as Database.Database;
  const settings = {
    database,
    find: () => ({
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      applicationThreadId: "thread-one",
      desired: {
        model: "gpt-5.6-codex",
        reasoningEffort: "high",
        serviceTier: "standard",
        ...(input.desiredExecutionPolicy ?? defaultExecutionPolicy),
      },
      effective:
        backingState === "bound"
          ? {
              model: "gpt-5.6-codex",
              reasoningEffort: "high",
              serviceTier: "standard",
              serviceTierClassification: "recognized",
              sandboxMode: "read-only",
              sandboxClassification: "recognized",
              networkAccess: "disabled",
              networkClassification: "recognized",
              approvalPolicy: "never",
              approvalPolicyClassification: "recognized",
              approvalReviewer: "user",
              approvalReviewerClassification: "recognized",
            }
          : null,
      effectiveDaemonGeneration: backingState === "bound" ? 1 : null,
      effectiveConfirmationState:
        backingState === "bound" ? "confirmed" : "unconfirmed",
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    }),
  } as unknown as CodexThreadExecutionSettingsRepository;
  return new CodexThreadPresentationProvider({
    settings,
    executionPolicy,
    modelPolicy:
      input.modelPolicy ??
      compileBackendModelPolicy({ type: "catalog" }, "model_effort"),
    ...(input.fastModeRuntime
      ? { fastModeRuntime: input.fastModeRuntime }
      : {}),
  });
}
