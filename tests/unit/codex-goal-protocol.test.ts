import { describe, expect, it } from "vitest";
import {
  codexThreadGoalClearMethod,
  codexThreadGoalGetMethod,
  codexThreadGoalSetMethod,
  decodeCodexThreadGoalClearedNotification,
  decodeCodexThreadGoalUpdatedNotification,
  encodeCodexGoalSetParams,
  projectCodexGoalGetResponse,
  projectCodexNativeGoal,
  projectNativeGoalStatus,
} from "../../src/server/backends/codex/codex-goal-protocol.js";

const validNativeGoal = {
  threadId: "thr_123",
  objective: "Finish the migration and keep tests green",
  status: "active" as const,
  tokenBudget: 200_000,
  tokensUsed: 1_000,
  timeUsedSeconds: 60,
  createdAt: 1_776_272_400,
  updatedAt: 1_776_272_460,
};

function decodeNativeGoal(value: unknown) {
  return codexThreadGoalSetMethod.decodeResult({ goal: value }).goal;
}

describe("codex goal native protocol", () => {
  it("validates complete native goals including omitted browser metrics", () => {
    const goal = decodeNativeGoal(validNativeGoal);
    expect(goal.tokenBudget).toBe(200_000);
    expect(goal.tokensUsed).toBe(1_000);
  });

  it("maps camelCase native statuses only inside the Codex module", () => {
    expect(projectNativeGoalStatus("usageLimited")).toBe("usage_limited");
    expect(projectNativeGoalStatus("budgetLimited")).toBe("budget_limited");
    expect(
      projectCodexNativeGoal({
        nativeGoal: decodeNativeGoal({
          ...validNativeGoal,
          status: "budgetLimited",
        }),
        expectedThreadId: "thr_123",
      }),
    ).toEqual({
      state: "set",
      objective: validNativeGoal.objective,
      status: "budget_limited",
    });
  });

  it("projects get responses and omits native ids/metrics from browser state", () => {
    expect(
      projectCodexGoalGetResponse({
        response: codexThreadGoalGetMethod.decodeResult({ goal: null }),
        expectedThreadId: "thr_123",
      }),
    ).toEqual({ state: "unset" });

    const projected = projectCodexGoalGetResponse({
      response: codexThreadGoalGetMethod.decodeResult({
        goal: validNativeGoal,
      }),
      expectedThreadId: "thr_123",
    });
    expect(projected).toEqual({
      state: "set",
      objective: validNativeGoal.objective,
      status: "active",
    });
    expect(projected).not.toHaveProperty("threadId");
    expect(projected).not.toHaveProperty("tokenBudget");
    expect(projected).not.toHaveProperty("tokensUsed");
  });

  it("fails closed on binding mismatch, unknown status, and malformed metrics", () => {
    expect(() =>
      projectCodexNativeGoal({
        nativeGoal: decodeNativeGoal(validNativeGoal),
        expectedThreadId: "thr_other",
      }),
    ).toThrow("codex_goal_thread_binding_mismatch");

    expect(() =>
      decodeNativeGoal({
        ...validNativeGoal,
        status: "running",
      }),
    ).toThrow();

    expect(() =>
      decodeNativeGoal({
        ...validNativeGoal,
        tokensUsed: 1.5,
      }),
    ).toThrow();

    for (const malformed of [
      { threadId: "" },
      { tokenBudget: -1 },
      { tokensUsed: Number.MAX_SAFE_INTEGER + 1 },
      { timeUsedSeconds: -1 },
      { createdAt: -1 },
      { updatedAt: 1.5 },
    ]) {
      expect(() =>
        decodeNativeGoal({
          ...validNativeGoal,
          ...malformed,
        }),
      ).toThrow();
    }

    expect(() =>
      decodeNativeGoal({
        ...validNativeGoal,
        objective: "",
      }),
    ).toThrow();

    expect(() =>
      decodeNativeGoal({
        ...validNativeGoal,
        extra: true,
      }),
    ).toThrow();
  });

  it("encodes set/clear params without tokenBudget and with browser-safe status", () => {
    expect(
      encodeCodexGoalSetParams({
        threadId: "thr_123",
        objective: "Ship goal",
        status: "active",
      }),
    ).toEqual({
      threadId: "thr_123",
      objective: "Ship goal",
      status: "active",
    });

    expect(
      encodeCodexGoalSetParams({
        threadId: "thr_123",
        status: "paused",
      }),
    ).toEqual({
      threadId: "thr_123",
      status: "paused",
    });

    expect(
      codexThreadGoalSetMethod.encodeParams({
        threadId: "thr_123",
        status: "paused",
      }),
    ).toEqual({ threadId: "thr_123", status: "paused" });

    expect(() =>
      codexThreadGoalSetMethod.encodeParams({
        threadId: "thr_123",
        tokenBudget: 20,
      } as never),
    ).toThrow();
    for (const status of [
      "active",
      "paused",
      "blocked",
      "usageLimited",
      "budgetLimited",
      "complete",
    ] as const) {
      expect(
        codexThreadGoalSetMethod.encodeParams({
          threadId: "thr_123",
          status,
        }),
      ).toEqual({ threadId: "thr_123", status });
    }
    expect(
      codexThreadGoalSetMethod.encodeParams({
        threadId: "thr_123",
        objective: null,
        status: null,
      }),
    ).toEqual({ threadId: "thr_123", objective: null, status: null });

    expect(
      codexThreadGoalGetMethod.encodeParams({ threadId: "thr_123" }),
    ).toEqual({ threadId: "thr_123" });
    expect(
      codexThreadGoalClearMethod.encodeParams({ threadId: "thr_123" }),
    ).toEqual({ threadId: "thr_123" });

    expect(
      codexThreadGoalSetMethod.decodeResult({ goal: validNativeGoal }),
    ).toEqual({ goal: validNativeGoal });
    expect(codexThreadGoalClearMethod.decodeResult({ cleared: true })).toEqual({
      cleared: true,
    });

    expect(() =>
      codexThreadGoalGetMethod.encodeParams({
        threadId: "thr_123",
        extra: true,
      } as never),
    ).toThrow();
    expect(() =>
      codexThreadGoalSetMethod.encodeParams({
        threadId: "thr_123",
        status: "active",
        extra: true,
      } as never),
    ).toThrow();
    expect(() =>
      codexThreadGoalClearMethod.encodeParams({
        threadId: "thr_123",
        extra: true,
      } as never),
    ).toThrow();
    expect(() =>
      codexThreadGoalGetMethod.decodeResult({ goal: null, extra: true }),
    ).toThrow();
    expect(() =>
      codexThreadGoalSetMethod.decodeResult({
        goal: validNativeGoal,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      codexThreadGoalClearMethod.decodeResult({ cleared: true, extra: true }),
    ).toThrow();
  });

  it("retains bounded notification identities after official decoding", () => {
    expect(() =>
      decodeCodexThreadGoalUpdatedNotification({
        threadId: "thr_123",
        turnId: "",
        goal: validNativeGoal,
      }),
    ).toThrow();
    expect(() =>
      decodeCodexThreadGoalUpdatedNotification({
        threadId: "thr_123",
        turnId: "turn_123",
        goal: { ...validNativeGoal, threadId: "" },
      }),
    ).toThrow();
    expect(() =>
      decodeCodexThreadGoalUpdatedNotification({
        threadId: "thr_123",
        turnId: null,
        goal: validNativeGoal,
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      decodeCodexThreadGoalClearedNotification({
        threadId: "thr_123",
        extra: true,
      }),
    ).toThrow();
  });

  it("accepts externally supplied budgetLimited goals for read-only status", () => {
    const projected = projectCodexNativeGoal({
      nativeGoal: decodeNativeGoal({
        ...validNativeGoal,
        status: "budgetLimited",
        tokenBudget: 40,
        tokensUsed: 41,
      }),
      expectedThreadId: "thr_123",
    });
    expect(projected).toEqual({
      state: "set",
      objective: validNativeGoal.objective,
      status: "budget_limited",
    });
  });
});
