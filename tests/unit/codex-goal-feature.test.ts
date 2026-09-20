import { describe, expect, it } from "vitest";
import {
  availableCodexGoalActionIds,
  codexGoalFeatureModule,
  codexGoalObjectiveFingerprint,
  codexGoalPostconditionMatches,
  codexGoalStateV1Schema,
  CODEX_GOAL_FEATURE_REF,
  CODEX_GOAL_OBJECTIVE_MAX_SCALARS,
  desiredPostconditionForCodexGoalAction,
  normalizeCodexGoalObjective,
  validateNormalizedCodexGoalObjective,
} from "../../src/server/backends/codex/codex-goal-feature.js";
import { boundValue } from "../../src/server/conversations/payload-policy.js";
import { compiledProviderFeatureRegistry } from "../../src/server/provider-features/compiled-provider-feature-registry.js";
import {
  ProviderFeatureRegistryError,
} from "../../src/server/provider-features/provider-feature-registry.js";

describe("codex.goal@1 feature contract", () => {
  it("registers exactly once on the codex backend with composer_action", () => {
    const capability = compiledProviderFeatureRegistry.capability(
      CODEX_GOAL_FEATURE_REF,
      "codex_app_server",
      { revision: 1, availability: "available" },
    );
    expect(capability.ref).toEqual(CODEX_GOAL_FEATURE_REF);
    expect(capability.presentationSlots).toEqual(["composer_action"]);
    expect(capability.operations.map(({ actionId }) => actionId)).toEqual([
      "create",
      "pause",
      "resume",
      "clear",
    ]);
    expect(
      compiledProviderFeatureRegistry.refs("pi").some(
        (ref) => ref.featureId === "codex.goal",
      ),
    ).toBe(false);
  });

  it("rejects unsupported versions and backend mismatches", () => {
    expect(() =>
      compiledProviderFeatureRegistry.module(
        { featureId: "codex.goal", schemaVersion: 2 },
        "codex_app_server",
      ),
    ).toThrow(ProviderFeatureRegistryError);
    expect(() =>
      compiledProviderFeatureRegistry.module(CODEX_GOAL_FEATURE_REF, "pi"),
    ).toThrow(ProviderFeatureRegistryError);
  });

  it("normalizes objectives with trim and enforces scalar/byte bounds", () => {
    expect(normalizeCodexGoalObjective("  finish migration  ")).toBe(
      "finish migration",
    );
    expect(validateNormalizedCodexGoalObjective("").ok).toBe(false);
    expect(
      validateNormalizedCodexGoalObjective("a".repeat(CODEX_GOAL_OBJECTIVE_MAX_SCALARS))
        .ok,
    ).toBe(true);
    expect(
      validateNormalizedCodexGoalObjective(
        "a".repeat(CODEX_GOAL_OBJECTIVE_MAX_SCALARS + 1),
      ).ok,
    ).toBe(false);

    // 4-byte scalars at the 4,000-character ceiling stay under the 16 KiB
    // UTF-8 limit (16_000 bytes). The byte bound is defense-in-depth.
    const fourByte = "\u{1F600}";
    const atScalarLimit = fourByte.repeat(CODEX_GOAL_OBJECTIVE_MAX_SCALARS);
    expect(validateNormalizedCodexGoalObjective(atScalarLimit).ok).toBe(true);
    expect(
      new TextEncoder().encode(atScalarLimit).byteLength,
    ).toBeLessThanOrEqual(16 * 1_024);
  });

  it("accepts create arguments only after product normalization", () => {
    const registered = compiledProviderFeatureRegistry.validateAction({
      ref: CODEX_GOAL_FEATURE_REF,
      backendKind: "codex_app_server",
      actionId: "create",
      arguments: boundValue({ objective: "  ship it  " }),
    });
    expect(registered.arguments).toEqual({ objective: "ship it" });

    expect(() =>
      compiledProviderFeatureRegistry.validateAction({
        ref: CODEX_GOAL_FEATURE_REF,
        backendKind: "codex_app_server",
        actionId: "create",
        arguments: boundValue({ objective: "   " }),
      }),
    ).toThrow(ProviderFeatureRegistryError);

    for (const actionId of ["pause", "resume", "clear"] as const) {
      expect(
        compiledProviderFeatureRegistry.validateAction({
          ref: CODEX_GOAL_FEATURE_REF,
          backendKind: "codex_app_server",
          actionId,
          arguments: boundValue({}),
        }).arguments,
      ).toEqual({});
      expect(() =>
        compiledProviderFeatureRegistry.validateAction({
          ref: CODEX_GOAL_FEATURE_REF,
          backendKind: "codex_app_server",
          actionId,
          arguments: null,
        }),
      ).toThrow(ProviderFeatureRegistryError);
    }
  });

  it("projects closed browser state and rejects unknown shape", () => {
    const envelope = compiledProviderFeatureRegistry.stateEnvelope({
      ref: CODEX_GOAL_FEATURE_REF,
      backendKind: "codex_app_server",
      revision: 3,
      providerState: {
        state: "set",
        objective: "Finish the migration and keep tests green",
        status: "active",
      },
    });
    expect(envelope.revision).toBe(3);
    expect(envelope.ref).toEqual(CODEX_GOAL_FEATURE_REF);

    expect(() =>
      compiledProviderFeatureRegistry.stateEnvelope({
        ref: CODEX_GOAL_FEATURE_REF,
        backendKind: "codex_app_server",
        revision: 1,
        providerState: {
          state: "set",
          objective: "x",
          status: "active",
          tokenBudget: 100,
        },
      }),
    ).toThrow(ProviderFeatureRegistryError);

    expect(() =>
      codexGoalStateV1Schema.parse({
        state: "set",
        objective: "x",
        status: "usageLimited",
      }),
    ).toThrow();
  });

  it("restricts action availability by Goal state", () => {
    expect(availableCodexGoalActionIds({ state: "unset" })).toEqual(["create"]);
    expect(
      availableCodexGoalActionIds({
        state: "set",
        objective: "ship",
        status: "active",
      }),
    ).toEqual(["pause", "clear"]);
    expect(
      availableCodexGoalActionIds({
        state: "set",
        objective: "ship",
        status: "paused",
      }),
    ).toEqual(["resume", "clear"]);
    expect(availableCodexGoalActionIds({ state: "set", objective: "ship", status: "blocked" })).toEqual(["resume", "clear"]);
    for (const status of [
      "usage_limited",
      "budget_limited",
      "complete",
    ] as const) {
      expect(
        availableCodexGoalActionIds({
          state: "set",
          objective: "ship",
          status,
        }),
      ).toEqual(["clear"]);
    }
  });

  it("evaluates recovery postconditions with objective fingerprints", () => {
    const objective = "Finish migration";
    const createDesired = desiredPostconditionForCodexGoalAction({
      actionId: "create",
      arguments: { objective },
      currentState: { state: "unset" },
    });
    expect(createDesired).toMatchObject({
      kind: "create",
      status: "active",
      objectiveFingerprint: codexGoalObjectiveFingerprint(objective),
    });
    expect(
      codexGoalPostconditionMatches({
        desired: createDesired,
        observed: { state: "set", objective, status: "active" },
      }),
    ).toBe(true);
    expect(
      codexGoalPostconditionMatches({
        desired: createDesired,
        observed: { state: "set", objective, status: "paused" },
      }),
    ).toBe(false);
    expect(
      codexGoalPostconditionMatches({
        desired: createDesired,
        observed: {
          state: "set",
          objective: "different objective",
          status: "active",
        },
      }),
    ).toBe(false);

    const pauseDesired = desiredPostconditionForCodexGoalAction({
      actionId: "pause",
      arguments: {},
      currentState: { state: "set", objective, status: "active" },
    });
    expect(pauseDesired).toMatchObject({
      kind: "pause",
      objectiveFingerprint: codexGoalObjectiveFingerprint(objective),
    });
    expect(
      codexGoalPostconditionMatches({
        desired: pauseDesired,
        observed: { state: "set", objective, status: "paused" },
      }),
    ).toBe(true);
    expect(
      codexGoalPostconditionMatches({
        desired: pauseDesired,
        observed: {
          state: "set",
          objective: "different objective",
          status: "paused",
        },
      }),
    ).toBe(false);

    expect(
      codexGoalPostconditionMatches({
        desired: { kind: "clear" },
        observed: { state: "unset" },
      }),
    ).toBe(true);
  });

  it("keeps create postconditions under the 8 KiB receipt JSON cap at max objective size", () => {
    const fourByte = "\u{1F600}";
    const objective = fourByte.repeat(CODEX_GOAL_OBJECTIVE_MAX_SCALARS);
    expect(validateNormalizedCodexGoalObjective(objective).ok).toBe(true);
    const desired = desiredPostconditionForCodexGoalAction({
      actionId: "create",
      arguments: { objective },
      currentState: { state: "unset" },
    });
    expect(Buffer.byteLength(JSON.stringify(desired), "utf8")).toBeLessThan(
      8_192,
    );
    expect("objective" in desired).toBe(false);
    expect(desired).toMatchObject({
      kind: "create",
      objectiveFingerprint: codexGoalObjectiveFingerprint(objective),
    });
  });

  it("declares durable external effects and create/resume model usage", () => {
    const byId = new Map(
      codexGoalFeatureModule.operations.map((operation) => [
        operation.actionId,
        operation,
      ]),
    );
    expect(byId.get("create")?.effects).toEqual({
      application: "write",
      modelUsage: "agent_execution",
      external: "durable_side_effect",
    });
    expect(byId.get("resume")?.effects).toEqual({
      application: "write",
      modelUsage: "agent_execution",
      external: "durable_side_effect",
    });
    expect(byId.get("pause")?.effects.modelUsage).toBe("none");
    expect(byId.get("clear")?.effects.external).toBe("durable_side_effect");
  });
});
