import { describe, expect, it } from "vitest";
import {
  decodeCodexModelSetting,
  encodeCodexModelSetting,
} from "../../src/server/backends/codex/codex-setting-values.js";
import { threadApplicationOperationSchema } from "../../src/shared/protocol/api.js";
import {
  settingOptionSchema,
  threadSettingsSnapshotSchema,
} from "../../src/shared/protocol/conversation.js";

describe("tuple-valued backend model settings", () => {
  it("round-trips the longest Codex model and reasoning identities", () => {
    const modelId = "m".repeat(120);
    const reasoningEffort = "e".repeat(120);
    const encoded = encodeCodexModelSetting(
      modelId,
      reasoningEffort,
      true,
      "fast",
    );

    expect(encoded.length).toBeGreaterThan(240);
    expect(decodeCodexModelSetting(encoded)).toEqual({
      modelId,
      defaultReasoningEffort: reasoningEffort,
      supportsFastMode: true,
      defaultServiceTier: "fast",
    });
  });

  it("carries bounded composite tuples through presentation and mutation", () => {
    const value = "v".repeat(1_024);
    expect(
      settingOptionSchema.parse({
        value,
        label: { text: "Composite tuple" },
        available: true,
      }).value,
    ).toBe(value);
    expect(
      threadSettingsSnapshotSchema.parse({
        revision: 1,
        values: [
          {
            id: "model",
            desiredValue: value,
            effectiveValue: value,
            applicationState: "effective",
          },
        ],
      }).values[0],
    ).toMatchObject({ desiredValue: value, effectiveValue: value });
    const parsed = threadApplicationOperationSchema.parse({
      kind: "perform",
      mutationId: "01900000-0000-7000-8000-000000000001",
      expectedThreadRevision: 0,
      expectedSettingsRevision: 0,
      operation: {
        action: "set_setting",
        settingId: "model",
        value,
      },
    });
    expect(parsed.kind).toBe("perform");
    if (parsed.kind !== "perform")
      throw new Error("expected perform operation");
    expect(parsed.operation).toMatchObject({ value });
    expect(() =>
      settingOptionSchema.parse({
        value: "v".repeat(1_025),
        label: { text: "Oversized tuple" },
        available: true,
      }),
    ).toThrow();
    expect(() =>
      threadSettingsSnapshotSchema.parse({
        revision: 1,
        values: [
          {
            id: "model",
            desiredValue: "v".repeat(1_025),
            effectiveValue: null,
            applicationState: "pending_next_turn",
          },
        ],
      }),
    ).toThrow();
  });
});
