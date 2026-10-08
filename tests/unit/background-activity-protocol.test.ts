import { describe, expect, it } from "vitest";
import { normalizedApplicationThreadSummarySchema, SEDES_CLIENT_PROTOCOL_VERSION } from "../../src/shared/protocol/application.js";
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


describe("sidebar background-work contract", () => {
  const schema = normalizedApplicationThreadSummarySchema.shape.backgroundWork;
  it("exposes only bounded normalized counts on the current protocol", () => {
    expect(SEDES_CLIENT_PROTOCOL_VERSION).toBe(144);
    expect(schema.parse(undefined)).toBeUndefined();
    expect(schema.parse({ agents: 2, commands: 1, other: 0 })).toEqual({ agents: 2, commands: 1, other: 0 });
  });
  it.each([
    { agents: -1 }, { commands: 0.5 }, { other: 1_000_001 },
    { state: "unknown" }, { description: { text: "private" } }, { task_id: "native-id" },
  ])("rejects invalid or non-summary fields %j", (invalid) => {
    expect(schema.safeParse({ agents: 0, commands: 0, other: 0, ...invalid }).success).toBe(false);
  });
});
