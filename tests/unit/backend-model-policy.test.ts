import { describe, expect, it } from "vitest";
import {
  BackendModelPolicyConfigurationError,
  backendModelPolicySchema,
  compileBackendModelPolicy,
} from "../../src/server/backends/model-policy.js";

describe("backend model policy", () => {
  it("always admits catalog selections", () => {
    const policy = compileBackendModelPolicy(
      { type: "catalog" },
      "provider_model_effort",
    );

    expect(policy.isSelectionAllowed({ modelId: "any-model" })).toBe(true);
  });

  it("matches list values with OR, dimensions with AND, and matchers with OR", () => {
    const policy = compileBackendModelPolicy(
      {
        type: "allowlist",
        allowed: [
          { providerIds: ["anthropic"] },
          {
            providerIds: ["xai"],
            modelIds: ["grok-4.5", "grok-future"],
            reasoningEfforts: ["low", "medium"],
          },
        ],
      },
      "provider_model_effort",
    );

    expect(
      policy.isSelectionAllowed({
        providerId: "anthropic",
        modelId: "claude-opus",
        reasoningEffort: "future-effort",
      }),
    ).toBe(true);
    expect(
      policy.isSelectionAllowed({
        providerId: "xai",
        modelId: "grok-future",
        reasoningEffort: "medium",
      }),
    ).toBe(true);
    expect(
      policy.isSelectionAllowed({
        providerId: "xai",
        modelId: "grok-4.5",
        reasoningEffort: "high",
      }),
    ).toBe(false);
    expect(
      policy.isSelectionAllowed({
        providerId: "XAI",
        modelId: "grok-4.5",
        reasoningEffort: "low",
      }),
    ).toBe(false);
  });

  it("subtracts denylist matches and filters efforts without Cartesian expansion", () => {
    const policy = compileBackendModelPolicy(
      {
        type: "denylist",
        denied: [
          { modelIds: ["legacy"] },
          {
            modelIds: ["current"],
            reasoningEfforts: ["high", "max"],
          },
        ],
      },
      "model_effort",
    );

    expect(
      policy.filterReasoningEfforts({ modelId: "current" }, [
        "off",
        "low",
        "high",
        "max",
      ]),
    ).toEqual(["off", "low"]);
    expect(
      policy.isModelWithoutReasoningEffortAllowed({ modelId: "legacy" }),
    ).toBe(false);
    expect(
      policy.isModelWithoutReasoningEffortAllowed({ modelId: "current" }),
    ).toBe(true);
  });

  it("does not let effort-specific matchers match a model without an effort axis", () => {
    const allowlist = compileBackendModelPolicy(
      {
        type: "allowlist",
        allowed: [{ modelIds: ["plain"], reasoningEfforts: ["low"] }],
      },
      "model_effort",
    );
    const denylist = compileBackendModelPolicy(
      {
        type: "denylist",
        denied: [{ modelIds: ["plain"], reasoningEfforts: ["low"] }],
      },
      "model_effort",
    );

    expect(
      allowlist.isModelWithoutReasoningEffortAllowed({ modelId: "plain" }),
    ).toBe(false);
    expect(
      denylist.isModelWithoutReasoningEffortAllowed({ modelId: "plain" }),
    ).toBe(true);
  });

  it("rejects provider matchers for backends without native provider identity", () => {
    expect(() =>
      compileBackendModelPolicy(
        { type: "denylist", denied: [{ providerIds: ["connection-name"] }] },
        "model_effort",
      ),
    ).toThrow(BackendModelPolicyConfigurationError);
  });

  it("validates closed shapes, nonempty bounds, unique lists, and set-equal matcher duplicates", () => {
    expect(() =>
      backendModelPolicySchema.parse({ type: "catalog", extra: 1 }),
    ).toThrow();
    expect(() =>
      backendModelPolicySchema.parse({ type: "allowlist", allowed: [] }),
    ).toThrow();
    expect(() =>
      backendModelPolicySchema.parse({ type: "denylist", denied: [{}] }),
    ).toThrow();
    expect(() =>
      backendModelPolicySchema.parse({
        type: "allowlist",
        allowed: [{ modelIds: ["same", "same"] }],
      }),
    ).toThrow(/duplicate value/i);
    expect(() =>
      backendModelPolicySchema.parse({
        type: "denylist",
        denied: [
          { providerIds: ["b", "a"], modelIds: ["two", "one"] },
          { modelIds: ["one", "two"], providerIds: ["a", "b"] },
        ],
      }),
    ).toThrow(/duplicate matcher/i);
    expect(() =>
      backendModelPolicySchema.parse({
        type: "allowlist",
        allowed: [{ modelIds: ["bad\u0000id"] }],
      }),
    ).toThrow(/control/i);
  });
});
