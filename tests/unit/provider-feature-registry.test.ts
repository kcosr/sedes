import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  COMPOSER_ATTACHMENT_POLICY,
  providerFeatureCapabilitySchema,
  providerFeatureStateEnvelopeSchema,
  normalizedThreadEventSchema,
  threadApplicationOperationSchema,
} from "../../src/shared/index.js";
import type { ProviderFeatureModule } from "../../src/server/provider-features/contracts.js";
import {
  ProviderFeatureRegistry,
  ProviderFeatureRegistryError,
} from "../../src/server/provider-features/provider-feature-registry.js";

const ref = {
  featureId: "test.preference",
  schemaVersion: 1,
} as const;

function module(): ProviderFeatureModule<{
  desiredProfile: "read_only" | "workspace";
}> {
  return {
    kind: "stateful",
    ref,
    backendKind: "codex_app_server",
    label: { text: "Permissions" },
    description: { text: "Codex execution permissions" },
    presentationSlots: ["thread_details"],
    operations: [
      {
        actionId: "use_read_only",
        label: { text: "Read only" },
        argumentsSchema: z.null(),
        effects: {
          application: "write",
          modelUsage: "none",
          external: "none",
        },
        confirmation: "none",
        execution: "durable",
      },
    ],
    stateSchema: z.strictObject({
      desiredProfile: z.enum(["read_only", "workspace"]),
    }),
    projectState: (state) => ({
      kind: "object",
      entries: [
        {
          key: { text: "desiredProfile" },
          value: { text: state.desiredProfile },
        },
      ],
    }),
  };
}

function registryErrorCode(operation: () => unknown): string | undefined {
  try {
    operation();
  } catch (error) {
    if (error instanceof ProviderFeatureRegistryError) return error.code;
    throw error;
  }
  return undefined;
}

describe("ProviderFeatureRegistry", () => {
  it("accepts Claude as a compiled backend kind without inventing a feature", () => {
    const claudeModule: ProviderFeatureModule<{
      desiredProfile: "read_only" | "workspace";
    }> = {
      ...module(),
      ref: { featureId: "test.claude.preference", schemaVersion: 1 },
      backendKind: "claude_agent_sdk",
      label: { text: "Claude preference" },
      description: { text: "A test-only Claude provider feature." },
    };
    const registry = new ProviderFeatureRegistry([claudeModule]);

    expect(registry.refs("claude_agent_sdk")).toEqual([claudeModule.ref]);
    expect(registry.refs("pi")).toEqual([]);
  });

  it("registers an exact backend/version and projects bounded capabilities and state", () => {
    const registry = new ProviderFeatureRegistry([module()]);

    expect(
      providerFeatureCapabilitySchema.parse(
        registry.capability(ref, "codex_app_server", {
          revision: 4,
          availability: "available",
        }),
      ),
    ).toMatchObject({ ref, revision: 4, availability: "available" });
    expect(
      providerFeatureStateEnvelopeSchema.parse(
        registry.stateEnvelope({
          ref,
          backendKind: "codex_app_server",
          revision: 7,
          providerState: { desiredProfile: "workspace" },
        }),
      ),
    ).toMatchObject({ ref, revision: 7 });
  });

  it("validates bounded arguments with the registered action schema", () => {
    const registry = new ProviderFeatureRegistry([module()]);
    expect(
      registry.validateAction({
        ref,
        backendKind: "codex_app_server",
        actionId: "use_read_only",
        arguments: null,
      }).arguments,
    ).toBeNull();
    expect(
      registryErrorCode(() =>
        registry.validateAction({
          ref,
          backendKind: "codex_app_server",
          actionId: "use_read_only",
          arguments: { text: "unexpected" },
        }),
      ),
    ).toBe("arguments_invalid");
  });

  it("fails closed for missing features, versions, backends, actions, and invalid state", () => {
    const registry = new ProviderFeatureRegistry([module()]);
    expect(
      registryErrorCode(() =>
        registry.module(
          { featureId: "codex.goal", schemaVersion: 1 },
          "codex_app_server",
        ),
      ),
    ).toBe("feature_not_registered");
    expect(
      registryErrorCode(() =>
        registry.module(
          { featureId: "test.preference", schemaVersion: 2 },
          "codex_app_server",
        ),
      ),
    ).toBe("feature_version_unsupported");
    expect(registryErrorCode(() => registry.module(ref, "pi"))).toBe(
      "backend_mismatch",
    );
    expect(
      registryErrorCode(() =>
        registry.validateAction({
          ref,
          backendKind: "codex_app_server",
          actionId: "arbitrary_provider_method",
          arguments: null,
        }),
      ),
    ).toBe("action_not_registered");
    expect(
      registryErrorCode(() =>
        registry.stateEnvelope({
          ref,
          backendKind: "codex_app_server",
          revision: 1,
          providerState: { desiredProfile: "unrestricted" },
        }),
      ),
    ).toBe("state_invalid");

    const unsafeProjection = module();
    if (unsafeProjection.kind !== "stateful") {
      throw new Error("expected_stateful_fixture");
    }
    const unsafeRegistry = new ProviderFeatureRegistry([
      {
        ...unsafeProjection,
        projectState: () =>
          ({ rawProviderPayload: { secret: "do not expose" } }) as never,
      },
    ]);
    expect(
      registryErrorCode(() =>
        unsafeRegistry.stateEnvelope({
          ref,
          backendKind: "codex_app_server",
          revision: 1,
          providerState: { desiredProfile: "workspace" },
        }),
      ),
    ).toBe("state_invalid");
  });

  it("rejects duplicate feature identities and actions at registration", () => {
    const registry = new ProviderFeatureRegistry([module()]);
    expect(() => registry.register(module())).toThrow(/feature_duplicate/);

    const duplicateActions = module();
    expect(
      () =>
        new ProviderFeatureRegistry([
          {
            ...duplicateActions,
            operations: [
              duplicateActions.operations[0]!,
              duplicateActions.operations[0]!,
            ],
          },
        ]),
    ).toThrow(/action_duplicate/);
  });
});

describe("provider feature protocol", () => {
  it("accepts only the closed provider-feature mutation envelope", () => {
    expect(
      threadApplicationOperationSchema.parse({
        kind: "perform",
        mutationId: "11111111-1111-4111-8111-111111111111",
        expectedThreadRevision: 8,
        operation: {
          action: "perform_provider_feature",
          feature: ref,
          actionId: "use_read_only",
          arguments: null,
          expectedFeatureRevision: 3,
        },
      }),
    ).toMatchObject({ kind: "perform" });
    expect(
      threadApplicationOperationSchema.safeParse({
        kind: "perform",
        mutationId: "11111111-1111-4111-8111-111111111111",
        expectedThreadRevision: 8,
        operation: {
          action: "perform_provider_feature",
          feature: ref,
          actionId: "thread/permissions/set",
          arguments: { rawProviderPayload: true },
          expectedFeatureRevision: 3,
        },
      }).success,
    ).toBe(false);
  });

  it("carries a coherent feature capability and state projection on the thread stream", () => {
    const registry = new ProviderFeatureRegistry([module()]);
    const capability = registry.capability(ref, "codex_app_server", {
      revision: 3,
      availability: "available",
    });
    expect(
      normalizedThreadEventSchema.parse({
        type: "capabilities_changed",
        generation: "generation-4",
        threadRevision: 0,
        capabilities: {
          revision: "capabilities-4",
          backend: { label: { text: "Codex" } },
          interactionMode: "interactive",
          runState: "idle",
          operations: [],
          deliveryModes: [],
          settings: [],
          composerActions: [],
          nonblockingQuestions: false,
          providerOutputArtifacts: { nativeImage: false },
          composerAttachments: {
            fileStaging: {
              availability: "unavailable",
              reason: { text: "Attachment staging is unavailable." },
            },
            nativeImage: {
              availability: "unavailable",
              reason: { text: "Native image input is unavailable." },
            },
            policy: COMPOSER_ATTACHMENT_POLICY,
          },
          interactions: [],
          providerFeatures: [capability],
          history: { available: true, paginated: true },
          automation: {
            available: true,
            canAttach: true,
            canRunNow: true,
            canCloneOnRun: true,
          },
        },
        providerFeatures: [
          {
            ref,
            revision: 3,
            state: null,
          },
        ],
      }),
    ).toMatchObject({
      type: "capabilities_changed",
      generation: "generation-4",
      threadRevision: 0,
      capabilities: { providerFeatures: [{ ref, revision: 3 }] },
      providerFeatures: [{ ref, revision: 3 }],
    });
  });
});
