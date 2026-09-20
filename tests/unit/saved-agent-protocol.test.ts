import { describe, expect, it } from "vitest";
import {
  SAVED_AGENT_SEDES_TOOLS_MAX_BYTES,
  SAVED_AGENT_OVERRIDES_MAX_BYTES,
  agentToolBootstrapPolicySchema,
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

  it("enforces the Sedes tool policy aggregate serialized bound", () => {
    const oversized = agentToolBootstrapPolicySchema.safeParse({
      enabled: true,
      enabledToolIds: Array.from(
        { length: 512 },
        (_, index) =>
          `tool${index}${"x".repeat(
            Math.ceil(SAVED_AGENT_SEDES_TOOLS_MAX_BYTES / 512),
          )}`,
      ),
      presentation: { surface: "cli", mode: "progressive" },
      accessBoundary: "environment",
    });
    expect(oversized.success).toBe(false);
    if (!oversized.success) {
      expect(oversized.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message:
              "Saved Agent Sedes tool policy exceeds the serialized byte limit.",
          }),
        ]),
      );
    }
  });

  it("requires one closed cross-environment rule on explicit tool policies", () => {
    const base = {
      enabled: false,
      enabledToolIds: [],
      presentation: { surface: "cli" as const, mode: "progressive" as const },
    };
    expect(agentToolBootstrapPolicySchema.safeParse(base).success).toBe(false);
    expect(
      agentToolBootstrapPolicySchema.parse({
        ...base,
        accessBoundary: "environment",
      }),
    ).toMatchObject({
      accessBoundary: "environment",
    });
    expect(
      agentToolBootstrapPolicySchema.parse({
        ...base,
        accessBoundary: "unrestricted",
      }),
    ).toMatchObject({
      accessBoundary: "unrestricted",
    });
    expect(agentToolBootstrapPolicySchema.parse({
      ...base,
      accessBoundary: "thread",
    }).accessBoundary).toBe("thread");
    expect(
      agentToolBootstrapPolicySchema.safeParse({
        ...base,
        accessBoundary: "deny",
      }).success,
    ).toBe(false);
    expect(
      agentToolBootstrapPolicySchema.safeParse({
        ...base,
        accessBoundary: {
          accessBoundary: "environment",
          environmentIds: ["environment-a"],
        },
      }).success,
    ).toBe(false);
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
        sedesTools: {
          enabled: false,
          enabledToolIds: [],
          accessBoundary: "environment",
        },
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
