import { describe, expect, it } from "vitest";
import { backgroundActivitySchema } from "../../src/shared/protocol/background-activity.js";

describe("background activity boundary", () => {
  it.each([
    { agents: -1 }, { commands: 0.5 }, { other: 1_000_001 }, { state: "finished" },
    { task_id: "native-id" }, { description: { text: "x".repeat(4097) } },
  ])("rejects invalid or provider-private activity fields %j", (invalid) => {
    expect(backgroundActivitySchema.safeParse({
      state: "known", agents: 0, commands: 0, other: 0, ...invalid,
    }).success).toBe(false);
  });
});
