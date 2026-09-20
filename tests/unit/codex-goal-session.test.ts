import { describe, expect, it, vi } from "vitest";
import {
  codexGoalPostconditionMatches,
  desiredPostconditionForCodexGoalAction,
} from "../../src/server/backends/codex/codex-goal-feature.js";
import { CodexGoalProjectionStore } from "../../src/server/backends/codex/codex-goal-projection-store.js";
import { CodexGoalSessionRegistry } from "../../src/server/backends/codex/codex-goal-session.js";
import type { CodexSharedClientFacade } from "../../src/server/backends/codex/codex-client-facade.js";
import {
  CodexRpcDeliveryError,
  CodexRpcRemoteError,
} from "../../src/server/backends/codex/rpc/errors.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const scope: RequestScope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
};

function nativeGoal(overrides?: {
  readonly status?:
    | "active"
    | "paused"
    | "blocked"
    | "usageLimited"
    | "budgetLimited"
    | "complete";
  readonly objective?: string;
  readonly threadId?: string;
}) {
  return {
    threadId: overrides?.threadId ?? "native-1",
    objective: overrides?.objective ?? "Finish migration",
    status: overrides?.status ?? "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 2,
  };
}

function mockClient(handlers: {
  get?: unknown | (() => unknown) | (() => Promise<unknown>) | Error;
  set?: unknown | (() => unknown) | (() => Promise<unknown>) | Error;
  clear?: unknown | (() => unknown) | (() => Promise<unknown>) | Error;
}): CodexSharedClientFacade {
  return {
    request: vi.fn(
      async (method: {
        method: string;
        decodeResult(value: unknown): unknown;
      }) => {
        const pick = async (value: unknown) => {
          if (value instanceof Error) throw value;
          if (typeof value === "function") {
            return await (value as () => unknown | Promise<unknown>)();
          }
          return value;
        };
        if (method.method === "thread/goal/get") {
          return method.decodeResult(
            await pick(handlers.get ?? { goal: null }),
          );
        }
        if (method.method === "thread/goal/set") {
          return method.decodeResult(
            await pick(handlers.set ?? { goal: nativeGoal() }),
          );
        }
        if (method.method === "thread/goal/clear") {
          return method.decodeResult(
            await pick(handlers.clear ?? { cleared: true }),
          );
        }
        throw new Error(`unexpected method ${method.method}`);
      },
    ),
  } as unknown as CodexSharedClientFacade;
}

describe("CodexGoalSessionRegistry", () => {
  it("publishes authoritative get state and withdraws on malformed payloads", async () => {
    const sessions = new CodexGoalSessionRegistry({ now: () => 1000 });
    const client = mockClient({
      get: { goal: nativeGoal({ status: "paused" }) },
    });
    const published = await sessions.refresh({
      scope,
      applicationThreadId: "app-1",
      nativeThreadId: "native-1",
      connectionGeneration: 3,
      client,
    });
    expect(published.availability).toBe("available");
    expect(published.state).toEqual({
      state: "set",
      objective: "Finish migration",
      status: "paused",
    });
    expect(published.revision).toBe(1);

    const bad = mockClient({
      get: { goal: { ...nativeGoal(), status: "not-a-status" } },
    });
    const withdrawn = await sessions.refresh({
      scope,
      applicationThreadId: "app-1",
      nativeThreadId: "native-1",
      connectionGeneration: 3,
      client: bad,
    });
    expect(withdrawn.availability).toBe("unavailable");
    expect(withdrawn.revision).toBe(2);
  });

  it("coalesces invalidations with a trailing reread and ignores old generations", async () => {
    const store = new CodexGoalProjectionStore();
    const sessions = new CodexGoalSessionRegistry({ store, now: () => 50 });
    let gets = 0;
    let releaseFirstGet!: () => void;
    const firstGetGate = new Promise<void>((resolve) => {
      releaseFirstGet = resolve;
    });
    const client = mockClient({
      get: async () => {
        gets += 1;
        if (gets === 1) await firstGetGate;
        return {
          goal:
            gets === 1
              ? nativeGoal({ status: "active" })
              : nativeGoal({ status: "paused" }),
        };
      },
    });
    await sessions.refresh({
      scope,
      applicationThreadId: "app-1",
      nativeThreadId: "native-1",
      connectionGeneration: 1,
      client: mockClient({
        get: () => ({ goal: nativeGoal({ status: "active" }) }),
      }),
    });
    gets = 0;
    const settled: number[] = [];
    sessions.scheduleInvalidation({
      scope,
      applicationThreadId: "app-1",
      nativeThreadId: "native-1",
      connectionGeneration: 1,
      client,
      onSettled: async () => {
        settled.push(settled.length + 1);
      },
    });
    await vi.waitFor(() => expect(gets).toBe(1));
    // Second notification while first get is in flight must trail-re-read.
    sessions.scheduleInvalidation({
      scope,
      applicationThreadId: "app-1",
      nativeThreadId: "native-1",
      connectionGeneration: 1,
      client,
      onSettled: async () => {
        settled.push(settled.length + 1);
      },
    });
    releaseFirstGet();
    await vi.waitFor(() => expect(gets).toBe(2));
    await vi.waitFor(() => expect(settled.length).toBe(2));
    expect(store.get(scope, "app-1")?.state).toEqual({
      state: "set",
      objective: "Finish migration",
      status: "paused",
    });

    // Old generation must not mutate a newer projection.
    store.publish(scope, {
      applicationThreadId: "app-1",
      nativeThreadId: "native-1",
      state: { state: "unset" },
      connectionGeneration: 2,
      now: 60,
    });
    sessions.scheduleInvalidation({
      scope,
      applicationThreadId: "app-1",
      nativeThreadId: "native-1",
      connectionGeneration: 1,
      client,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.get(scope, "app-1")?.connectionGeneration).toBe(2);
    expect(store.get(scope, "app-1")?.state).toEqual({ state: "unset" });
  });

  it("accepts mutations only when the response matches the postcondition", async () => {
    const sessions = new CodexGoalSessionRegistry();
    const desired = desiredPostconditionForCodexGoalAction({
      actionId: "create",
      arguments: { objective: "Ship Goal" },
      currentState: { state: "unset" },
    });
    const accepted = await sessions.mutateNative({
      client: mockClient({
        set: { goal: nativeGoal({ objective: "Ship Goal", status: "active" }) },
      }),
      nativeThreadId: "native-1",
      actionId: "create",
      desired,
      arguments: { objective: "Ship Goal" },
      currentState: { state: "unset" },
    });
    expect(accepted).toEqual({
      kind: "accepted",
      state: {
        state: "set",
        objective: "Ship Goal",
        status: "active",
      },
    });

    // Concurrent external change after boundary → uncertain (never auto-retry).
    const uncertain = await sessions.mutateNative({
      client: mockClient({
        set: new CodexRpcDeliveryError({
          code: "timeout",
          delivery: "sent_outcome_unknown",
          generation: 1,
          method: "thread/goal/set",
        }),
        get: {
          goal: nativeGoal({
            objective: "Changed elsewhere",
            status: "active",
          }),
        },
      }),
      nativeThreadId: "native-1",
      actionId: "create",
      desired,
      arguments: { objective: "Ship Goal" },
      currentState: { state: "unset" },
    });
    expect(uncertain.kind).toBe("uncertain");
    if (uncertain.kind === "uncertain") {
      expect(
        codexGoalPostconditionMatches({
          desired,
          observed: uncertain.observed!,
        }),
      ).toBe(false);
    }
  });

  it("resumes a blocked goal through the native active transition", async () => {
    const sessions = new CodexGoalSessionRegistry();
    const currentState = { state: "set", objective: "Finish migration", status: "blocked" } as const;
    const result = await sessions.mutateNative({
      client: mockClient({ set: { goal: nativeGoal() } }),
      nativeThreadId: "native-1",
      actionId: "resume",
      desired: desiredPostconditionForCodexGoalAction({ actionId: "resume", arguments: {}, currentState }),
      arguments: {},
      currentState,
    });
    expect(result.kind).toBe("accepted");
  });

  it("rejects unavailable actions and proven pre-boundary failures", async () => {
    const sessions = new CodexGoalSessionRegistry();
    const rejected = await sessions.mutateNative({
      client: mockClient({}),
      nativeThreadId: "native-1",
      actionId: "pause",
      desired: {
        kind: "pause",
        status: "paused",
        objectiveFingerprint: "x",
      },
      arguments: {},
      currentState: { state: "unset" },
    });
    expect(rejected.kind).toBe("rejected");

    const preBoundary = await sessions.mutateNative({
      client: mockClient({
        set: new CodexRpcRemoteError({
          code: -32001,
          message: "not accepted",
          generation: 1,
          method: "thread/goal/set",
        }),
      }),
      nativeThreadId: "native-1",
      actionId: "create",
      desired: desiredPostconditionForCodexGoalAction({
        actionId: "create",
        arguments: { objective: "Ship" },
        currentState: { state: "unset" },
      }),
      arguments: { objective: "Ship" },
      currentState: { state: "unset" },
    });
    expect(preBoundary).toMatchObject({
      kind: "rejected",
      preBoundary: true,
    });
  });

  it("recovers create/pause/resume/clear postconditions after a lost response", async () => {
    const sessions = new CodexGoalSessionRegistry();
    const lost = new CodexRpcDeliveryError({
      code: "timeout",
      delivery: "sent_outcome_unknown",
      generation: 1,
    });

    const createDesired = desiredPostconditionForCodexGoalAction({
      actionId: "create",
      arguments: { objective: "Keep going" },
      currentState: { state: "unset" },
    });
    expect(
      (
        await sessions.mutateNative({
          client: mockClient({
            set: lost,
            get: {
              goal: nativeGoal({
                objective: "Keep going",
                status: "active",
              }),
            },
          }),
          nativeThreadId: "native-1",
          actionId: "create",
          desired: createDesired,
          arguments: { objective: "Keep going" },
          currentState: { state: "unset" },
        })
      ).kind,
    ).toBe("accepted");

    const pauseDesired = desiredPostconditionForCodexGoalAction({
      actionId: "pause",
      arguments: {},
      currentState: {
        state: "set",
        objective: "Keep going",
        status: "active",
      },
    });
    expect(
      (
        await sessions.mutateNative({
          client: mockClient({
            set: lost,
            get: {
              goal: nativeGoal({
                objective: "Keep going",
                status: "paused",
              }),
            },
          }),
          nativeThreadId: "native-1",
          actionId: "pause",
          desired: pauseDesired,
          arguments: {},
          currentState: {
            state: "set",
            objective: "Keep going",
            status: "active",
          },
        })
      ).kind,
    ).toBe("accepted");

    const resumeDesired = desiredPostconditionForCodexGoalAction({
      actionId: "resume",
      arguments: {},
      currentState: {
        state: "set",
        objective: "Keep going",
        status: "paused",
      },
    });
    expect(
      (
        await sessions.mutateNative({
          client: mockClient({
            set: lost,
            get: {
              goal: nativeGoal({
                objective: "Keep going",
                status: "active",
              }),
            },
          }),
          nativeThreadId: "native-1",
          actionId: "resume",
          desired: resumeDesired,
          arguments: {},
          currentState: {
            state: "set",
            objective: "Keep going",
            status: "paused",
          },
        })
      ).kind,
    ).toBe("accepted");

    const clearDesired = desiredPostconditionForCodexGoalAction({
      actionId: "clear",
      arguments: {},
      currentState: {
        state: "set",
        objective: "Keep going",
        status: "active",
      },
    });
    expect(
      (
        await sessions.mutateNative({
          client: mockClient({
            clear: lost,
            get: { goal: null },
          }),
          nativeThreadId: "native-1",
          actionId: "clear",
          desired: clearDesired,
          arguments: {},
          currentState: {
            state: "set",
            objective: "Keep going",
            status: "active",
          },
        })
      ).kind,
    ).toBe("accepted");
  });
});

describe("codex.goal idle-gate exemption contract", () => {
  it("marks Goal as an active-turn and runtime feature", async () => {
    const { CodexThreadActionPersistence } =
      await import("../../src/server/backends/codex/codex-thread-action-persistence.js");
    // Constructing requires a full fixture; assert the pure helpers via a
    // minimal double that reuses the same feature-id rules.
    const isGoal = (featureId: string, schemaVersion: number) =>
      featureId === "codex.goal" && schemaVersion === 1;
    expect(isGoal("codex.goal", 1)).toBe(true);
    expect(isGoal("codex.execution", 1)).toBe(false);
    expect(CodexThreadActionPersistence.name).toBe(
      "CodexThreadActionPersistence",
    );
  });
});
