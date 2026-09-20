import { describe, expect, it } from "vitest";
import {
  codexFastModeStateV1Schema,
  CODEX_FAST_MODE_FEATURE_REF,
} from "../../src/server/backends/codex/codex-fast-mode-feature.js";
import { compiledProviderFeatureRegistry } from "../../src/server/provider-features/compiled-provider-feature-registry.js";
import { ProviderFeatureRegistryError } from "../../src/server/provider-features/provider-feature-registry.js";

describe("codex.fast_mode@1 feature contract", () => {
  it("registers only for Codex as a quiet composer action contract", () => {
    const capability = compiledProviderFeatureRegistry.capability(
      CODEX_FAST_MODE_FEATURE_REF,
      "codex_app_server",
      { revision: 4, availability: "available" },
    );

    expect(capability.presentationSlots).toEqual(["composer_action"]);
    expect(capability.operations.map(({ actionId }) => actionId)).toEqual([
      "enable",
      "disable",
    ]);
    expect(capability.operations).toMatchObject([
      {
        confirmation: "none",
        execution: "inline",
        effects: { application: "write", modelUsage: "none", external: "none" },
      },
      {
        confirmation: "none",
        execution: "inline",
        effects: { application: "write", modelUsage: "none", external: "none" },
      },
    ]);
    expect(
      compiledProviderFeatureRegistry
        .refs("pi")
        .some(({ featureId }) => featureId === "codex.fast_mode"),
    ).toBe(false);
  });

  it("accepts only null arguments and the closed state shape", () => {
    expect(
      compiledProviderFeatureRegistry.validateAction({
        ref: CODEX_FAST_MODE_FEATURE_REF,
        backendKind: "codex_app_server",
        actionId: "enable",
        arguments: null,
      }).arguments,
    ).toBeNull();
    expect(() =>
      compiledProviderFeatureRegistry.validateAction({
        ref: CODEX_FAST_MODE_FEATURE_REF,
        backendKind: "codex_app_server",
        actionId: "enable",
        arguments: { kind: "object", entries: [] },
      }),
    ).toThrow(ProviderFeatureRegistryError);

    expect(
      codexFastModeStateV1Schema.parse({
        desired: "fast",
        effective: "standard",
        applicationState: "pending",
      }),
    ).toEqual({
      desired: "fast",
      effective: "standard",
      applicationState: "pending",
    });
    expect(() =>
      codexFastModeStateV1Schema.parse({
        desired: "priority",
        effective: "default",
        applicationState: "applied",
      }),
    ).toThrow();
  });
});
