import { toolPolicyDefinitionSchema, toolPolicySelectionSchema } from "../../src/shared/protocol/tool-policies.js";
import { describe, expect, it } from "vitest";
import {
  SAVED_AGENT_OVERRIDES_MAX_BYTES,
  normalizedAgentConfigurationOverridesSchema,
  resolveSavedAgentResultSchema,
  savedAgentListQuerySchema,
  savedAgentOptionsRequestSchema,
} from "../../src/shared/protocol/saved-agents.js";

const workspaceId = "019196f7-a0a8-7bc4-a89b-8cf013978405";

describe("Saved Agent protocol bounds", () => {
  it("accepts an exact Target filter without accepting two backend selectors", () => {
    expect(
      savedAgentListQuerySchema.safeParse({
        targetId: "target-codex-local",
        pageSize: 25,
      }).success,
    ).toBe(true);
    expect(
      savedAgentListQuerySchema.safeParse({
        targetId: "target-codex-local",
        backendTypeId: "codex",
        pageSize: 25,
      }).success,
    ).toBe(false);
  });

  it("enforces override count and aggregate serialized bounds", () => {
    const tooMany = normalizedAgentConfigurationOverridesSchema.safeParse(
      Array.from({ length: 33 }, (_, index) => ({
        id: `field${index}`,
        value: "value",
      })),
    );
    expect(tooMany.success).toBe(false);
    if (!tooMany.success) {
      expect(tooMany.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "too_big", maximum: 32 }),
        ]),
      );
    }

    const oversized = normalizedAgentConfigurationOverridesSchema.safeParse([
      {
        id: "model",
        value: "x".repeat(SAVED_AGENT_OVERRIDES_MAX_BYTES),
      },
    ]);
    expect(oversized.success).toBe(false);
    if (!oversized.success) {
      expect(oversized.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "Saved Agent overrides exceed the serialized byte limit.",
          }),
        ]),
      );
    }
  });

  it("bounds policy tool lists and rejects duplicate IDs", () => {
    const base = { name: "Everyday", resourceScope: { allowOtherEnvironments: false, allowOtherProjects: false } };
    expect(toolPolicyDefinitionSchema.safeParse({ ...base, enabledToolIds: Array.from({length:513}, (_,index) => `tool${index}`) }).success).toBe(false);
    expect(toolPolicyDefinitionSchema.safeParse({ ...base, enabledToolIds: ["x".repeat(129)] }).success).toBe(false);
    expect(toolPolicyDefinitionSchema.safeParse({ ...base, enabledToolIds: ["thread.list", "thread.list"] }).success).toBe(false);
  });

  it("requires both closed resource-scope switches on policy sets", () => {
    const base = { name: "Everyday", enabledToolIds: [] };
    expect(toolPolicyDefinitionSchema.safeParse(base).success).toBe(false);
    for (const allowOtherEnvironments of [false,true]) for (const allowOtherProjects of [false,true]) {
      const resourceScope = {allowOtherEnvironments,allowOtherProjects};
      expect(toolPolicyDefinitionSchema.parse({...base,resourceScope})).toEqual({...base,resourceScope});
    }
    expect(toolPolicyDefinitionSchema.safeParse({...base,resourceScope:{allowOtherEnvironments:"ask",allowOtherProjects:false}}).success).toBe(false);
    expect(toolPolicyDefinitionSchema.safeParse({...base,resourceScope:{allowOtherEnvironments:false,allowOtherProjects:false,environmentIds:["environment-a"]}}).success).toBe(false);
    expect(toolPolicySelectionSchema.parse({kind:"inherit"})).toEqual({kind:"inherit"});
    expect(toolPolicySelectionSchema.parse({kind:"disabled"})).toEqual({kind:"disabled"});
    expect(toolPolicySelectionSchema.safeParse({kind:"policy_set",policySetId:"not-an-id"}).success).toBe(false);
  });

  it("requires a selected target before accepting target-specific inputs", () => {
    expect(
      savedAgentOptionsRequestSchema.safeParse({
        workspaceId,
        overrides: [{ id: "model", value: "grok" }],
      }).success,
    ).toBe(false);
    expect(
      savedAgentOptionsRequestSchema.safeParse({
        workspaceId,
        toolPolicySelection: { kind: "disabled" },
      }).success,
    ).toBe(false);
    expect(
      savedAgentOptionsRequestSchema.safeParse({ workspaceId }).success,
    ).toBe(true);
  });

  it("rejects an aggregate resolution result above the browser entity bound", () => {
    const target = {
      id: "local-primary",
      label: { text: "Local Pi" },
      backend: {
        typeId: "pi",
        label: { text: "Pi" },
        brand: "pi" as const,
      },
    };
    expect(
      resolveSavedAgentResultSchema.safeParse({
        candidates: [],
        failures: Array.from({ length: 130 }, () => ({
          target,
          reason: { text: "x".repeat(4_096) },
        })),
      }).success,
    ).toBe(false);
  });
});
