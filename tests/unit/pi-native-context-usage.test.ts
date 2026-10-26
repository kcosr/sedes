import { describe, expect, it } from "vitest";
import { piNativeContextUsage } from "../../src/server/backends/pi/native/driver/context-usage.js";
import { piManagedContextUsageSchema, piManagedStateSchema } from "../../src/server/backends/pi/native/rpc/pi-managed-protocol.js";
import { usageSnapshotSchema } from "../../src/shared/protocol/conversation.js";

describe("native Pi context occupancy", () => {
  it.each([
    [{ tokens: 0, contextWindow: 4_096, percent: 0 }, { usedTokens: 0, windowTokens: 4_096, percent: 0 }],
    [{ tokens: 1_024, contextWindow: 4_096, percent: 25 }, { usedTokens: 1_024, windowTokens: 4_096, percent: 25 }],
    [{ tokens: 5_120, contextWindow: 4_096, percent: 125 }, { usedTokens: 5_120, windowTokens: 4_096, percent: 125 }],
    [{ tokens: null, contextWindow: 4_096, percent: null }, { windowTokens: 4_096 }],
  ])("normalizes provider occupancy without capping or filling unknown values: %j", (native, context) => {
    const usage = { context: piNativeContextUsage(piManagedContextUsageSchema.parse(native)) };
    expect(usage).toEqual({ context });
    expect(usageSnapshotSchema.parse(usage)).toEqual(usage);
  });

  it("permits an absent live estimate without synthesizing occupancy", () => {
    expect(piNativeContextUsage(undefined)).toBeUndefined();
    const state = { sessionId: "session", entries: [], leafId: null, operations: [], toolCalls: [], toolResults: [], tools: [], activeTools: [], isIdle: true };
    expect(piManagedStateSchema.parse(state)).toEqual(state);
    expect(piManagedStateSchema.parse({ ...state, contextUsage: { tokens: null, contextWindow: 4_096, percent: null } }).contextUsage).toEqual({ tokens: null, contextWindow: 4_096, percent: null });
  });

  it.each([
    { tokens: -1, contextWindow: 4_096, percent: 0 },
    { tokens: 1.5, contextWindow: 4_096, percent: 0 },
    { tokens: Number.MAX_SAFE_INTEGER + 1, contextWindow: 4_096, percent: 0 },
    { tokens: 1, contextWindow: 0, percent: 0 },
    { tokens: 1, contextWindow: 4_096.5, percent: 0 },
    { tokens: 1, contextWindow: 4_096, percent: Infinity },
    { tokens: 1, contextWindow: 4_096, percent: -1 },
    { tokens: null, contextWindow: 4_096, percent: 0 },
    { tokens: 0, contextWindow: 4_096, percent: null },
    { tokens: 0, contextWindow: 4_096, percent: 0, extra: true },
  ])("rejects invalid native occupancy: %j", value => {
    expect(piManagedContextUsageSchema.safeParse(value).success).toBe(false);
  });
});
