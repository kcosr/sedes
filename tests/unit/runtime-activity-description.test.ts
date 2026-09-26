import { describe, expect, it } from "vitest";
import { describeBackgroundActivity, describeRuntimeActivity } from "../../src/server/configuration-admin/runtime-activity-description.js";

describe("interruption preview activity", () => {
  it("names each kind of background work a loaded conversation reports", () => {
    expect(describeBackgroundActivity(undefined)).toBeUndefined();
    expect(describeBackgroundActivity({ state: "known", agents: 0, commands: 0, other: 0 })).toBeUndefined();
    expect(describeBackgroundActivity({ state: "known", agents: 2, commands: 1, other: 0 })).toBe("2 background agents, 1 background command");
    expect(describeBackgroundActivity({ state: "unknown", agents: 0, commands: 0, other: 0 })).toBe("background work unknown");
  });

  it("summarizes provider-reported work across conversations, omitting what is absent", () => {
    expect(describeRuntimeActivity(undefined)).toBeUndefined();
    const idle = { runningTurns: 0, pendingInteractions: 0, unacknowledgedConversations: 0,
      background: { agents: 0, commands: 0, other: 0, unknownConversations: 0 } };
    expect(describeRuntimeActivity(idle)).toBeUndefined();
    expect(describeRuntimeActivity({ runningTurns: 1, pendingInteractions: 1, unacknowledgedConversations: 2,
      background: { agents: 3, commands: 0, other: 1, unknownConversations: 1 } })).toBe(
      "1 running turn, 3 background agents, 1 other background task, 1 conversation with unknown background work, 1 pending approval, 2 conversations with undelivered output");
  });
});
