import { describe, expect, it } from "vitest";
import {
  codexThreadItemsListMethod,
  codexThreadTurnsListMethod,
} from "../../src/server/backends/codex/codex-c1-protocol.js";
import {
  codexTurnStartMethod,
  decodeCodexC2Notification,
} from "../../src/server/backends/codex/codex-c2-protocol.js";
import {
  decodeCodexServerNotificationParams,
} from "../../src/server/provider-protocol/bindings/codex-app-server/codex-app-server-binding.js";

function turn(overrides: Record<string, unknown> = {}) {
  return {
    id: "turn-1", rootTurnId: "root-1", items: [], itemsView: "notLoaded",
    status: "completed", error: null, startedAt: 1, completedAt: 2,
    durationMs: 1_000, ...overrides,
  };
}

function errorNotification(codexErrorInfo: unknown, misalignment: unknown = null) {
  return {
    threadId: "thread-1", turnId: "turn-1", willRetry: false,
    error: { message: "Provider could not continue", additionalDetails: null,
      codexErrorInfo, misalignment },
  };
}

describe("Codex 0.162.1 consumed protocol additions", () => {
  it.each(["root-1", null, undefined])("retains optional root lineage %s across live and paged turns", (rootTurnId) => {
    const nativeTurn: Record<string, unknown> = turn(rootTurnId === undefined ? {} : { rootTurnId });
    if (rootTurnId === undefined) delete nativeTurn.rootTurnId;
    expect(codexTurnStartMethod.decodeResult({ turn: nativeTurn })).toEqual({ turn: nativeTurn });
    for (const method of ["turn/started", "turn/completed"] as const) {
      const params = { threadId: "thread-1", turn: nativeTurn };
      expect(decodeCodexC2Notification(method, params)).toEqual(params);
    }
    expect(codexThreadTurnsListMethod.decodeResult({
      data: [nativeTurn], nextCursor: null, backwardsCursor: null,
    }).data[0]).toEqual(nativeTurn);
  });

  it.each(["", "x".repeat(513), 1])("rejects malformed root lineage", (rootTurnId) => {
    expect(() => codexTurnStartMethod.decodeResult({ turn: turn({ rootTurnId }) })).toThrow();
  });

  it.each(["started", "interacted", "completed", "interrupted"])("accepts resolved and unknown settings for %s subagent activity", (kind) => {
    for (const settings of [
      { model: "gpt-6.1-sol", reasoningEffort: "ultra" },
      { model: "gpt-6.1-sol", reasoningEffort: "future-effort" },
      { model: null, reasoningEffort: null },
      {},
    ]) {
      const item = { type: "subAgentActivity", id: "activity-1", kind,
        agentThreadId: "child-1", agentPath: "/root/reviewer", ...settings };
      const params = { threadId: "thread-1", turnId: "turn-1", item, completedAtMs: 2 };
      expect(decodeCodexC2Notification("item/completed", params)).toEqual(params);
      expect(codexThreadItemsListMethod.decodeResult({
        data: [{ turnId: "turn-1", item, startedAtMs: 1, completedAtMs: 2 }],
        nextCursor: null, backwardsCursor: null,
      }).data[0]?.item).toEqual(item);
    }
  });

  it.each([
    { model: "x".repeat(513), reasoningEffort: "high" },
    { model: "gpt-6.1-sol", reasoningEffort: "x".repeat(513) },
  ])("rejects malformed subagent settings", (settings) => {
    expect(() => decodeCodexC2Notification("item/completed", {
      threadId: "thread-1", turnId: "turn-1", completedAtMs: 2,
      item: { type: "subAgentActivity", id: "activity-1", kind: "started",
        agentThreadId: "child-1", agentPath: "/root/reviewer", ...settings },
    })).toThrow();
  });

  it.each(["opaque-review-target", null, undefined])("preserves optional review targets without requiring a continuation instruction", (reviewTarget) => {
    const misalignment = { errorType: "review", detailedExplanation: "Review blocked.", steer: null,
      ...(reviewTarget === undefined ? {} : { reviewTarget }) };
    const params = errorNotification("misalignmentPolicyViolation", misalignment);
    expect(decodeCodexC2Notification("error", params)).toEqual(params);
    const nativeTurn = turn({ status: "failed", error: params.error });
    expect(codexThreadTurnsListMethod.decodeResult({
      data: [nativeTurn], nextCursor: null, backwardsCursor: null,
    }).data[0]?.error).toEqual(params.error);
  });

  it.each([
    "futureUpstreamCategory",
    { futureUpstreamCategory: { details: [true, null, "opaque"], retry: 2 } },
    { firstUnknown: "opaque", secondUnknown: { value: true } },
    {},
    { httpConnectionFailed: { httpStatusCode: 503 } },
    { activeTurnNotSteerable: { turnKind: "review" } },
  ])("accepts bounded official error records in notifications and history", (codexErrorInfo) => {
    const params = errorNotification(codexErrorInfo);
    expect(decodeCodexC2Notification("error", params)).toEqual(params);
    const nativeTurn = turn({ status: "failed", error: params.error });
    expect(codexThreadTurnsListMethod.decodeResult({
      data: [nativeTurn], nextCursor: null, backwardsCursor: null,
    }).data[0]?.error).toEqual(params.error);
  });

  it.each([
    { httpConnectionFailed: { httpStatusCode: 1.5 } },
    { httpConnectionFailed: { httpStatusCode: 503, unexpected: true } },
    { activeTurnNotSteerable: { turnKind: "invented" } },
    { unknown: Array.from({ length: 10_001 }, () => true) },
  ])("rejects malformed known details and excessive opaque error records", (codexErrorInfo) => {
    const params = errorNotification(codexErrorInfo);
    expect(() => decodeCodexC2Notification("error", params)).toThrow();
    expect(() => codexThreadTurnsListMethod.decodeResult({
      data: [turn({ status: "failed", error: params.error })], nextCursor: null, backwardsCursor: null,
    })).toThrow();
  });

  it("admits partial answer messages without requiring the turn to complete", () => {
    const item = { type: "agentMessage", id: "partial-1", text: "First answer.", phase: "partial_answer",
      memoryCitation: null, delivery: null, questions: null };
    const params = { threadId: "thread-1", turnId: "turn-1", item, completedAtMs: 2 };
    expect(decodeCodexC2Notification("item/completed", params)).toEqual(params);
    expect(codexTurnStartMethod.decodeResult({
      turn: turn({ items: [item], itemsView: "full", status: "inProgress", completedAt: null, durationMs: null }),
    }).turn.status).toBe("inProgress");
  });

  it("recognizes the prediction notification without adding a production request", () => {
    const params = { threadId: "thread-1", sourceTurnId: "turn-1", result: { type: "completed", text: null } };
    expect(decodeCodexServerNotificationParams("thread/prediction/updated", params)).toEqual(params);
  });
});
