import { describe, expect, it } from "vitest";
import { TurnThroughputRecorder, MAXIMUM_RETAINED_TURN_THROUGHPUT } from "../../src/server/backends/turn-throughput.js";
import { backendTurnSchema } from "../../src/shared/protocol/backend.js";
import { conversationTurnSchema } from "../../src/shared/protocol/conversation.js";

describe("resident turn throughput", () => {
  it("sums matched requests rather than averaging rates, and keeps a measurement through duplicate completion", () => {
    const recorder = new TurnThroughputRecorder();
    recorder.start("turn");
    recorder.record("turn", { outputTokens: 100, requestDurationMs: 1000 });
    recorder.start("turn"); // Steering stays in the same turn.
    recorder.record("turn", { outputTokens: 100, requestDurationMs: 3000 });
    expect(recorder.get("turn")).toBeUndefined();
    recorder.finish("turn", true);
    recorder.finish("turn", true);
    expect(recorder.get("turn")).toEqual({ outputTokens: 200, requestDurationMs: 4000 });
  });

  it("does not reuse an older measurement when a completed turn resumes without complete evidence", () => {
    const recorder = new TurnThroughputRecorder();
    recorder.start("resumed");
    recorder.record("resumed", { outputTokens: 100, requestDurationMs: 1000 });
    recorder.finish("resumed", true);
    recorder.start("resumed");
    expect(recorder.get("resumed")).toBeUndefined();
    recorder.record("resumed", undefined);
    recorder.finish("resumed", true);
    expect(recorder.get("resumed")).toBeUndefined();
  });

  it.each([
    undefined,
    { outputTokens: -1, requestDurationMs: 1000 },
    { outputTokens: 1.5, requestDurationMs: 1000 },
    { outputTokens: 1, requestDurationMs: 0 },
    { outputTokens: 1, requestDurationMs: Infinity },
    { outputTokens: NaN, requestDurationMs: 1000 },
  ])("omits the entire turn when any request is unmeasured or invalid: %j", (request) => {
    const recorder = new TurnThroughputRecorder();
    recorder.start("turn");
    recorder.record("turn", { outputTokens: 100, requestDurationMs: 1000 });
    recorder.record("turn", request);
    recorder.record("turn", { outputTokens: 100, requestDurationMs: 1000 });
    recorder.finish("turn", true);
    expect(recorder.get("turn")).toBeUndefined();
  });

  it("rejects partial attachments, interrupted turns, gaps, empty output and overflow", () => {
    const recorder = new TurnThroughputRecorder();
    const request = { outputTokens: 10, requestDurationMs: 1000 };
    recorder.record("attached-mid-turn", request);
    recorder.finish("attached-mid-turn", true);
    expect(recorder.get("attached-mid-turn")).toBeUndefined();
    recorder.start("interrupted");
    recorder.record("interrupted", request);
    recorder.finish("interrupted", false);
    expect(recorder.get("interrupted")).toBeUndefined();
    recorder.start("gap");
    recorder.record("gap", request);
    recorder.invalidate();
    recorder.finish("gap", true);
    expect(recorder.get("gap")).toBeUndefined();
    recorder.start("empty");
    recorder.record("empty", { ...request, outputTokens: 0 });
    recorder.finish("empty", true);
    expect(recorder.get("empty")).toBeUndefined();
    recorder.start("overflow");
    recorder.record("overflow", { ...request, outputTokens: Number.MAX_SAFE_INTEGER });
    recorder.record("overflow", request);
    recorder.finish("overflow", true);
    expect(recorder.get("overflow")).toBeUndefined();
  });

  it("bounds resident measurements and clears them on runtime retirement", () => {
    const recorder = new TurnThroughputRecorder();
    for (let index = 0; index <= MAXIMUM_RETAINED_TURN_THROUGHPUT; index++) {
      recorder.start(String(index));
      recorder.record(String(index), { outputTokens: 10, requestDurationMs: 1000 });
      recorder.finish(String(index), true);
    }
    expect(recorder.get("0")).toBeUndefined();
    expect(recorder.get("1")).toBeDefined();
    recorder.clear();
    expect(recorder.get("1")).toBeUndefined();
    expect(recorder.get(String(MAXIMUM_RETAINED_TURN_THROUGHPUT))).toBeUndefined();
  });

  it.each(["backend", "browser"])("admits only complete, positive, bounded terminal evidence in the %s contract", (kind) => {
    const schema = kind === "backend" ? backendTurnSchema : conversationTurnSchema;
    const base = kind === "backend"
      ? { backendTurnId: "turn", orderedBackendItemIds: [] }
      : { id: "turn", revision: 0, orderedItemIds: [] };
    const throughput = { outputTokens: 100, requestDurationMs: 1000.5 };
    expect(schema.safeParse({ ...base, status: "completed", throughput }).success).toBe(true);
    expect(schema.safeParse({ ...base, status: "completed" }).success).toBe(true);
    for (const status of ["in_progress", "interrupted", "failed"]) {
      expect(schema.safeParse({ ...base, status, throughput }).success).toBe(false);
    }
    for (const value of [0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(schema.safeParse({ ...base, status: "completed", throughput: { ...throughput, outputTokens: value } }).success).toBe(false);
      expect(schema.safeParse({ ...base, status: "completed", throughput: { ...throughput, requestDurationMs: value } }).success).toBe(false);
    }
    expect(schema.safeParse({ ...base, status: "completed", throughput: { ...throughput, provider: "private" } }).success).toBe(false);
  });
});
