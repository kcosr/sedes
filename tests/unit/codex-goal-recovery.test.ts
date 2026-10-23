import { describe, expect, it } from "vitest";
import { CodexGoalRecoveryTracker } from "../../src/server/backends/codex/codex-goal-recovery.js";
import type { CodexNativeThreadGoal } from "../../src/server/backends/codex/codex-goal-protocol.js";

function goal(overrides: Partial<CodexNativeThreadGoal> = {}): CodexNativeThreadGoal {
  return {
    threadId: "native-thread", objective: "Complete the migration", status: "active",
    tokenBudget: 10_000, tokensUsed: 50, timeUsedSeconds: 2, createdAt: 10, updatedAt: 11,
    ...overrides,
  };
}

function tracker(initial: CodexNativeThreadGoal | null = goal()): CodexGoalRecoveryTracker {
  const result = new CodexGoalRecoveryTracker();
  result.establish(1, initial);
  return result;
}

function failed(result: CodexGoalRecoveryTracker, turnId = "turn-1") {
  result.started({ generation: 1, turnId });
  result.observeGoal({ generation: 1, turnId, goal: goal({ status: "blocked", tokensUsed: 80 }) });
  result.completed({ generation: 1, turnId, outcome: "failed" });
  return result.recovery(1, turnId)!;
}

describe("CodexGoalRecoveryTracker", () => {
  it("recovers only an actual failed live turn with an observed active goal", () => {
    const result = tracker();
    result.started({ generation: 1, turnId: "turn-1" });
    expect(result.isGoalTurn(1, "turn-1")).toBe(true);
    expect(result.recovery(1, "turn-1")).toBeUndefined();
    result.observeGoal({ generation: 1, turnId: "turn-1", goal: goal({ status: "blocked" }) });
    expect(result.recovery(1, "turn-1")).toBeUndefined();
    result.completed({ generation: 1, turnId: "turn-1", outcome: "failed" });
    const evidence = result.recovery(1, "turn-1")!;
    expect(result.canResume(evidence, goal({ status: "blocked", tokensUsed: 90, updatedAt: 20 }))).toBe(true);
    expect(result.canResume(evidence, goal())).toBe(false);
  });

  it.each(["paused", "blocked", "complete", "usageLimited", "budgetLimited"] as const)(
    "never infers active-goal evidence from an existing %s goal", (status) => {
      const result = tracker(goal({ status }));
      result.started({ generation: 1, turnId: "turn-1" });
      result.completed({ generation: 1, turnId: "turn-1", outcome: "failed" });
      expect(result.isGoalTurn(1, "turn-1")).toBe(false);
      expect(result.recovery(1, "turn-1")).toBeUndefined();
      result.observeGoal({ generation: 1, turnId: "turn-1", goal: goal({ status: "blocked" }) });
      expect(result.recovery(1, "turn-1")).toBeUndefined();
    },
  );

  it("does not manufacture a live failure from an attached blocked snapshot", () => {
    const result = tracker(goal({ status: "blocked" }));
    result.completed({ generation: 1, turnId: "old-turn", outcome: "failed" });
    expect(result.recovery(1, "old-turn")).toBeUndefined();
  });

  it.each(["completed", "interrupted"] as const)("does not retry a %s goal turn", (outcome) => {
    const result = tracker();
    result.started({ generation: 1, turnId: "turn-1" });
    result.completed({ generation: 1, turnId: "turn-1", outcome });
    expect(result.isGoalTurn(1, "turn-1")).toBe(true);
    expect(result.recovery(1, "turn-1")).toBeUndefined();
  });

  it("preserves matching active and blocked notifications that precede turn start", () => {
    const result = tracker(null);
    result.observeGoal({ generation: 1, turnId: "turn-1", goal: goal() });
    result.observeGoal({ generation: 1, turnId: "turn-1", goal: goal({ status: "blocked" }) });
    result.started({ generation: 1, turnId: "turn-1" });
    result.completed({ generation: 1, turnId: "turn-1", outcome: "failed" });
    const evidence = result.recovery(1, "turn-1")!;
    expect(result.canResume(evidence, goal({ status: "blocked" }))).toBe(true);
  });

  it("uses the active baseline when a matching blocked notification precedes turn start", () => {
    const result = tracker();
    result.observeGoal({ generation: 1, turnId: "turn-1", goal: goal({ status: "blocked" }) });
    result.started({ generation: 1, turnId: "turn-1" });
    result.completed({ generation: 1, turnId: "turn-1", outcome: "failed" });
    expect(result.canResume(result.recovery(1, "turn-1")!, goal({ status: "blocked" }))).toBe(true);
  });

  it("accepts matching blocked evidence that follows the live terminal event", () => {
    const result = tracker();
    result.started({ generation: 1, turnId: "turn-1" });
    result.completed({ generation: 1, turnId: "turn-1", outcome: "failed" });
    const evidence = result.recovery(1, "turn-1")!;
    result.observeGoal({ generation: 1, turnId: "turn-1", goal: goal({ status: "blocked" }) });
    expect(result.canResume(evidence, goal({ status: "blocked" }))).toBe(true);
  });

  it.each(["paused", "complete", "usageLimited", "budgetLimited"] as const)(
    "cancels pending recovery when the goal becomes %s", (status) => {
      const result = tracker();
      const evidence = failed(result);
      result.observeGoal({ generation: 1, turnId: "turn-1", goal: goal({ status }) });
      expect(result.recovery(1, "turn-1")).toBeUndefined();
      expect(result.canResume(evidence, goal({ status: "blocked" }))).toBe(false);
    },
  );

  it("never resumes an intentionally paused goal during the retry delay, even after it is resumed externally", () => {
    const result = tracker();
    const evidence = failed(result);
    result.observeGoal({ generation: 1, turnId: null, goal: goal({ status: "paused" }) });
    result.observeGoal({ generation: 1, turnId: null, goal: goal() });
    expect(result.canResume(evidence, goal({ status: "blocked" }))).toBe(false);
  });

  it.each(["complete", "paused", "usageLimited", "budgetLimited"] as const)(
    "preserves live Goal participation after %s so terminal success can reset the allowance", (status) => {
      const result = tracker();
      result.started({ generation: 1, turnId: "turn-1" });
      result.observeGoal({ generation: 1, turnId: "turn-1", goal: goal({ status }) });
      result.completed({ generation: 1, turnId: "turn-1", outcome: "completed" });
      expect(result.isGoalTurn(1, "turn-1")).toBe(true);
      expect(result.recovery(1, "turn-1")).toBeUndefined();
    },
  );

  it.each(["paused", "complete", "usageLimited", "budgetLimited"] as const)(
    "preserves the Goal marker after %s so a later failure cannot fall back to text", (status) => {
      const result = tracker();
      result.started({ generation: 1, turnId: "turn-1" });
      result.observeGoal({ generation: 1, turnId: null, goal: goal({ status }) });
      result.completed({ generation: 1, turnId: "turn-1", outcome: "failed" });
      expect(result.isGoalTurn(1, "turn-1")).toBe(true);
      expect(result.recovery(1, "turn-1")).toBeUndefined();
    },
  );

  it("retains a live Goal turn after cancellation without allowing recovery", () => {
    const result = tracker();
    result.started({ generation: 1, turnId: "turn-1" });
    result.cancelRecovery();
    result.completed({ generation: 1, turnId: "turn-1", outcome: "failed" });
    expect(result.isGoalTurn(1, "turn-1")).toBe(true);
    expect(result.recovery(1, "turn-1")).toBeUndefined();
  });

  it.each([
    { objective: "A new objective" },
    { createdAt: 12 },
    { tokenBudget: 20_000 },
    { threadId: "other-thread" },
  ])("rejects a changed native goal identity: %j", (change) => {
    const result = tracker();
    const evidence = failed(result);
    expect(result.canResume(evidence, goal({ status: "blocked", ...change }))).toBe(false);
    result.observeGoal({ generation: 1, turnId: "turn-1", goal: goal({ status: "active", ...change }) });
    expect(result.canResume(evidence, goal({ status: "blocked" }))).toBe(false);
  });

  it("invalidates on explicit clear and does not revive evidence after recreation", () => {
    const result = tracker();
    const evidence = failed(result);
    result.observeGoal({ generation: 1, turnId: null, goal: null });
    result.observeGoal({ generation: 1, turnId: null, goal: goal() });
    expect(result.canResume(evidence, goal({ status: "blocked" }))).toBe(false);
  });

  it("keeps only one recovery candidate while retaining completed Goal participation", () => {
    const result = tracker();
    const evidence = failed(result);
    result.observeGoal({ generation: 1, turnId: null, goal: goal() });
    result.started({ generation: 1, turnId: "turn-2" });
    expect(result.isGoalTurn(1, "turn-1")).toBe(true);
    expect(result.canResume(evidence, goal({ status: "blocked" }))).toBe(false);
    expect(result.isGoalTurn(1, "turn-2")).toBe(true);
  });

  it("retains completed Goal participation when the next turn starts before completion observers run", () => {
    const result = tracker();
    result.started({ generation: 1, turnId: "turn-1" });
    result.completed({ generation: 1, turnId: "turn-1", outcome: "completed" });
    result.started({ generation: 1, turnId: "turn-2" });
    result.completed({ generation: 1, turnId: "turn-2", outcome: "completed" });
    result.started({ generation: 1, turnId: "turn-3" });
    expect(result.isGoalTurn(1, "turn-1")).toBe(true);
    expect(result.isGoalTurn(1, "turn-2")).toBe(true);
    expect(result.recovery(1, "turn-1")).toBeUndefined();
    expect(result.recovery(1, "turn-2")).toBeUndefined();
  });

  it("bounds retained participation to 512 completed turns without retaining old recovery candidates", () => {
    const result = tracker();
    for (let index = 0; index <= 512; index += 1) {
      const turnId = `turn-${index}`;
      result.started({ generation: 1, turnId });
      result.completed({ generation: 1, turnId, outcome: "completed" });
    }
    expect(result.isGoalTurn(1, "turn-0")).toBe(false);
    expect(result.isGoalTurn(1, "turn-1")).toBe(true);
    expect(result.isGoalTurn(1, "turn-512")).toBe(true);
    expect(result.recovery(1, "turn-1")).toBeUndefined();
  });

  it("clears all retained participation when the owner generation changes", () => {
    const result = tracker();
    result.started({ generation: 1, turnId: "turn-1" });
    result.completed({ generation: 1, turnId: "turn-1", outcome: "completed" });
    result.started({ generation: 1, turnId: "turn-2" });
    expect(result.isGoalTurn(1, "turn-1")).toBe(true);
    result.establish(2, goal());
    expect(result.isGoalTurn(1, "turn-1")).toBe(false);
    expect(result.isGoalTurn(2, "turn-1")).toBe(false);
    expect(result.isGoalTurn(2, "turn-2")).toBe(false);
  });

  it("rejects stale generations and resets evidence on owner replacement", () => {
    const result = tracker();
    const evidence = failed(result);
    result.establish(2, goal());
    result.started({ generation: 1, turnId: "old-turn" });
    result.observeGoal({ generation: 1, turnId: "old-turn", goal: goal({ status: "blocked" }) });
    result.completed({ generation: 1, turnId: "old-turn", outcome: "failed" });
    expect(result.isGoalTurn(1, "old-turn")).toBe(false);
    expect(result.canResume(evidence, goal({ status: "blocked" }))).toBe(false);
    result.started({ generation: 2, turnId: "new-turn" });
    expect(result.isGoalTurn(2, "new-turn")).toBe(true);
  });

  it("does not attribute a mismatched goal notification to the current live turn", () => {
    const result = tracker();
    result.started({ generation: 1, turnId: "turn-1" });
    result.observeGoal({ generation: 1, turnId: "other-turn", goal: goal({ status: "blocked" }) });
    result.completed({ generation: 1, turnId: "turn-1", outcome: "failed" });
    expect(result.recovery(1, "turn-1")).toBeUndefined();
    expect(result.recovery(1, "other-turn")).toBeUndefined();
  });

  it("invalidates an in-flight retry on Stop or lost continuity", () => {
    const result = tracker();
    const evidence = failed(result);
    result.invalidate();
    expect(result.canResume(evidence, goal({ status: "blocked" }))).toBe(false);
    result.started({ generation: 1, turnId: "turn-2" });
    expect(result.isGoalTurn(1, "turn-2")).toBe(false);
  });
});
