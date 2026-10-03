import { describe, expect, it } from "vitest";
import {
  codexFastModeStateV2Schema,
  codexSpeedSelectionForAction,
  CODEX_FAST_MODE_FEATURE_REF,
} from "../../src/server/backends/codex/codex-fast-mode-feature.js";
import { compiledProviderFeatureRegistry } from "../../src/server/provider-features/compiled-provider-feature-registry.js";
import { ProviderFeatureRegistryError } from "../../src/server/provider-features/provider-feature-registry.js";

describe("codex.fast_mode@2 feature contract", () => {
  it("registers only for Codex as a quiet composer action contract", () => {
    expect(CODEX_FAST_MODE_FEATURE_REF).toEqual({
      featureId: "codex.fast_mode",
      schemaVersion: 2,
    });
    const capability = compiledProviderFeatureRegistry.capability(
      CODEX_FAST_MODE_FEATURE_REF,
      "codex_app_server",
      { revision: 4, availability: "available" },
    );

    expect(capability.label).toEqual({ text: "Speed" });
    expect(capability.presentationSlots).toEqual(["composer_action"]);
    expect(capability.operations.map(({ actionId }) => actionId)).toEqual([
      "set_standard",
      "set_fast",
      "set_ultrafast",
    ]);
    for (const operation of capability.operations) {
      expect(operation).toMatchObject({
        confirmation: "none",
        execution: "inline",
        effects: { application: "write", modelUsage: "none", external: "none" },
      });
    }
    expect(
      compiledProviderFeatureRegistry
        .refs("pi")
        .some(({ featureId }) => featureId === "codex.fast_mode"),
    ).toBe(false);
    expect(() =>
      compiledProviderFeatureRegistry.capability(
        { featureId: "codex.fast_mode", schemaVersion: 1 },
        "codex_app_server",
        { revision: 4, availability: "available" },
      ),
    ).toThrow(ProviderFeatureRegistryError);
  });

  it("maps each action to exactly one speed", () => {
    expect(codexSpeedSelectionForAction("set_standard")).toBe("standard");
    expect(codexSpeedSelectionForAction("set_fast")).toBe("fast");
    expect(codexSpeedSelectionForAction("set_ultrafast")).toBe("ultrafast");
    expect(codexSpeedSelectionForAction("enable")).toBeUndefined();
    expect(codexSpeedSelectionForAction("disable")).toBeUndefined();
  });

  it("accepts only null arguments and the closed state shape", () => {
    expect(
      compiledProviderFeatureRegistry.validateAction({
        ref: CODEX_FAST_MODE_FEATURE_REF,
        backendKind: "codex_app_server",
        actionId: "set_ultrafast",
        arguments: null,
      }).arguments,
    ).toBeNull();
    expect(() =>
      compiledProviderFeatureRegistry.validateAction({
        ref: CODEX_FAST_MODE_FEATURE_REF,
        backendKind: "codex_app_server",
        actionId: "set_fast",
        arguments: { kind: "object", entries: [] },
      }),
    ).toThrow(ProviderFeatureRegistryError);
    expect(() =>
      compiledProviderFeatureRegistry.validateAction({
        ref: CODEX_FAST_MODE_FEATURE_REF,
        backendKind: "codex_app_server",
        actionId: "enable",
        arguments: null,
      }),
    ).toThrow(ProviderFeatureRegistryError);

    const state = {
      desired: "ultrafast",
      effective: "fast",
      applicationState: "pending",
      offered: [
        { selection: "fast", description: "1.5x speed, increased usage" },
        { selection: "ultrafast" },
      ],
    };
    expect(codexFastModeStateV2Schema.parse(state)).toEqual(state);
    for (const invalid of [
      { ...state, desired: "priority" },
      { ...state, effective: "default" },
      { ...state, offered: [] },
      { ...state, offered: [{ selection: "standard" }] },
      {
        ...state,
        offered: [{ selection: "ultrafast" }, { selection: "fast" }],
      },
      { ...state, offered: [{ selection: "fast" }, { selection: "fast" }] },
      { ...state, offered: [{ selection: "fast", description: "" }] },
      {
        ...state,
        offered: [{ selection: "fast", description: "d".repeat(241) }],
      },
      { desired: "fast", effective: "fast", applicationState: "applied" },
    ]) {
      expect(() => codexFastModeStateV2Schema.parse(invalid)).toThrow();
    }
  });
});
