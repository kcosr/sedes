import { describe, expect, it, vi } from "vitest";
import { BackendError } from "../../src/server/backends/contracts.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { AutomationRunRecord } from "../../src/server/domain/automation-models.js";
import {
  AutomationDispatcher,
  type AutomationDispatcherDependencies,
} from "../../src/server/runtime/automation-dispatcher.js";

function run(
  runMode: AutomationRunRecord["runMode"] = "same_thread",
): AutomationRunRecord {
  return {
    tenantId: "tenant-1",
    ownerPrincipalId: "principal-1",
    automationId: "automation-1",
    id: "run-1",
    occurrenceKind: "manual",
    scheduledFor: 1_000,
    occurrenceKey: "manual:run-1",
    definitionRevision: 0,
    coalescedCount: 0,
    runMode,
    state: "claimed",
    claimToken: "claim-1",
    leaseExpiresAt: 10_000,
    claimAttemptCount: 1,
    promptSnapshot: "Review the current work",
    precheckCommandSnapshot: null,
    precheckTimeoutSeconds: null,
    precheckIncludeStdout: null,
    precheckStatus: "not_configured",
    precheckStartedAt: null,
    precheckFinishedAt: null,
    precheckExitCode: null,
    precheckDurationMs: null,
    precheckStdoutBytes: null,
    precheckStdoutIncluded: null,
    dispatchMutationId: "dispatch-1",
    anchorThreadId: "thread-anchor",
    childThreadId: null,
    errorCode: null,
    errorDiagnostic: null,
    claimedAt: 1_000,
    startedAt: null,
    acceptedAt: null,
    finishedAt: null,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function fixture(
  initial: AutomationRunRecord,
  dispatch: AutomationDispatcherDependencies["gateway"]["dispatch"],
) {
  let current = initial;
  const repository = {
    getRun: vi.fn(() => current),
    getDefinition: vi.fn(() => ({
      schedule: { kind: "interval" as const },
    })),
    updateRunState: vi.fn(
      (
        _scope: unknown,
        _automationId: string,
        _runId: string,
        input: {
          state: AutomationRunRecord["state"];
          now: number;
          errorCode?: string;
          errorDiagnostic?: string;
        },
      ) => {
        current = {
          ...current,
          state: input.state,
          claimToken: input.state === "dispatching" ? current.claimToken : null,
          leaseExpiresAt:
            input.state === "dispatching" ? current.leaseExpiresAt : null,
          promptSnapshot:
            input.state === "dispatching" ||
            input.state === "queued" ||
            input.state === "running"
              ? current.promptSnapshot
              : null,
          startedAt:
            input.state === "claimed" ? null : (current.startedAt ?? input.now),
          acceptedAt:
            input.state === "queued" ||
            input.state === "running" ||
            input.state === "completed"
              ? (current.acceptedAt ?? input.now)
              : current.acceptedAt,
          finishedAt: ["completed", "failed", "skipped"].includes(input.state)
            ? input.now
            : null,
          errorCode: input.errorCode ?? null,
          errorDiagnostic: input.errorDiagnostic ?? null,
          updatedAt: input.now,
        };
        return current;
      },
    ),
    markRunUncertainAndPause: vi.fn(
      (
        _scope: unknown,
        _automationId: string,
        _runId: string,
        input: { errorCode: string; errorDiagnostic: string; now: number },
      ) => {
        current = {
          ...current,
          state: "uncertain",
          claimToken: null,
          leaseExpiresAt: null,
          errorCode: input.errorCode,
          errorDiagnostic: input.errorDiagnostic,
          updatedAt: input.now,
        };
        return current;
      },
    ),
    beginPrecheck: vi.fn(),
    finishPrecheckWithoutDispatch: vi.fn(),
    passPrecheck: vi.fn(),
  };
  const gateway = {
    dispatch: vi.fn(async (...input: Parameters<typeof dispatch>) => {
      const result = await dispatch(...input);
      // The shared fork service durably binds the automation child before the
      // gateway submits or reports acceptance.
      if (current.runMode === "clone" && result.status === "accepted") {
        current = { ...current, childThreadId: result.targetThreadId };
      }
      return result;
    }),
  };
  const service = {
    publishRun: vi.fn(),
    dispatchCapacityChanged: vi.fn(),
  };
  const dispatcher = new AutomationDispatcher({
    repository:
      repository as unknown as AutomationDispatcherDependencies["repository"],
    gateway,
    inventory: {
      getThread: vi.fn(() => ({
        inventory: { inventoryState: "active", snoozedUntil: null },
      })) as never,
    },
    service,
    prechecks: { execute: vi.fn() as never },
    now: () => 2_000,
  });
  return { dispatcher, gateway, repository, service, current: () => current };
}

describe("AutomationDispatcher v10 backend-neutral dispatch", () => {
  it("dispatches same-thread work with application IDs and completes accepted work", async () => {
    const setup = fixture(run(), async () => ({
      status: "accepted",
      targetThreadId: "thread-anchor",
    }));
    const result = await setup.dispatcher.dispatch(run());

    expect(setup.gateway.dispatch).toHaveBeenCalledWith({
      scope: { tenantId: "tenant-1", principalId: "principal-1" },
      automationId: "automation-1",
      automationRunId: "run-1",
      anchorThreadId: "thread-anchor",
      runMode: "same_thread",
      prompt: "Review the current work",
      dispatchMutationId: "dispatch-1",
    });
    expect(result.state).toBe("completed");
    expect(JSON.stringify(setup.gateway.dispatch.mock.calls)).not.toMatch(
      /native|piUser|sessionPath/i,
    );
  });

  it("uses the child application ID already committed by the shared fork service", async () => {
    const clone = run("clone");
    const setup = fixture(clone, async () => ({
      status: "accepted",
      targetThreadId: "thread-child",
    }));
    const result = await setup.dispatcher.dispatch(clone);

    expect(result).toMatchObject({
      state: "completed",
      childThreadId: "thread-child",
    });
  });

  it("replays a dispatching clone through the idempotent fork gateway", async () => {
    const clone = { ...run("clone"), state: "dispatching" as const };
    const setup = fixture(clone, async () => ({
      status: "accepted",
      targetThreadId: "thread-child",
    }));

    const result = await setup.dispatcher.dispatch(clone);

    expect(setup.gateway.dispatch).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      state: "completed",
      childThreadId: "thread-child",
    });
  });

  it.each(["queued", "running"] as const)(
    "keeps %s replays pending until the queue observer proves acceptance",
    async (status) => {
      const setup = fixture(run(), async () => ({
        status,
        targetThreadId: "thread-anchor",
      }));
      const queued = await setup.dispatcher.dispatch(run());
      expect(queued.state).toBe(status);

      const replayed = await setup.dispatcher.dispatch(queued);
      expect(replayed.state).toBe(status);
      expect(setup.gateway.dispatch).toHaveBeenCalledOnce();
    },
  );

  it("pauses an uncertain run when a backend error crossed the submission boundary", async () => {
    const setup = fixture(run(), async () => {
      throw new BackendError({
        category: "submission_unknown",
        retryable: false,
        crossedSubmissionBoundary: true,
        safeMessage: "Submission acceptance is unknown.",
      });
    });
    const result = await setup.dispatcher.dispatch(run());

    expect(result).toMatchObject({
      state: "uncertain",
      errorCode: "automation_dispatch_uncertain",
    });
    expect(setup.repository.markRunUncertainAndPause).toHaveBeenCalledOnce();
  });

  it("pauses recurring clone automation when fork binding is uncertain", async () => {
    const clone = run("clone");
    const setup = fixture(clone, async () => ({
      status: "uncertain",
      targetThreadId: "thread-reserved-unknown",
      diagnostic:
        "Codex may have created a full native fork copy; no child prompt was queued.",
    }));

    const result = await setup.dispatcher.dispatch(clone);

    expect(result).toMatchObject({
      state: "uncertain",
      errorCode: "automation_dispatch_uncertain",
    });
    expect(setup.repository.markRunUncertainAndPause).toHaveBeenCalledOnce();
  });

  it("records capability-loss rejection as a stable failed clone run", async () => {
    const clone = run("clone");
    const setup = fixture(clone, async () => {
      throw new DomainError(
        "invalid_transition",
        "Clone-mode automation is no longer available for this thread.",
      );
    });

    const result = await setup.dispatcher.dispatch(clone);

    expect(result).toMatchObject({
      state: "failed",
      errorCode: "automation_dispatch_rejected",
      errorDiagnostic:
        "Clone-mode automation is no longer available for this thread.",
    });
    expect(setup.service.publishRun).toHaveBeenCalledWith(
      { tenantId: "tenant-1", principalId: "principal-1" },
      expect.objectContaining({ state: "failed" }),
    );
  });

  it("caps concurrent backend dispatches and starts queued runs as capacity returns", async () => {
    const runs = Array.from({ length: 6 }, (_, index) => ({
      ...run(),
      automationId: `automation-${index}`,
      id: `run-${index}`,
      anchorThreadId: `thread-${index}`,
      dispatchMutationId: `dispatch-${index}`,
    }));
    const stored = new Map(
      runs.map((item) => [`${item.automationId}\0${item.id}`, item]),
    );
    let active = 0;
    let maximumActive = 0;
    let release: () => void = () => {
      throw new Error("dispatch_release_not_initialized");
    };
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gateway = {
      dispatch: vi.fn(async (input: { anchorThreadId: string }) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await blocked;
        active -= 1;
        return {
          status: "accepted" as const,
          targetThreadId: input.anchorThreadId,
        };
      }),
    };
    const repository = {
      getDefinition: vi.fn(() => ({
        schedule: { kind: "interval" as const },
      })),
      getRun: vi.fn((_scope: unknown, automationId: string, runId: string) =>
        stored.get(`${automationId}\0${runId}`)!,
      ),
      updateRunState: vi.fn(
        (
          _scope: unknown,
          automationId: string,
          runId: string,
          input: {
            state: AutomationRunRecord["state"];
            now: number;
            errorCode?: string;
            errorDiagnostic?: string;
          },
        ) => {
          const key = `${automationId}\0${runId}`;
          const current = stored.get(key)!;
          const updated = {
            ...current,
            state: input.state,
            claimToken:
              input.state === "dispatching" ? current.claimToken : null,
            leaseExpiresAt:
              input.state === "dispatching" ? current.leaseExpiresAt : null,
            promptSnapshot:
              input.state === "dispatching" ? current.promptSnapshot : null,
            startedAt: current.startedAt ?? input.now,
            acceptedAt:
              input.state === "completed" ? input.now : current.acceptedAt,
            finishedAt:
              input.state === "completed" ? input.now : current.finishedAt,
            errorCode: input.errorCode ?? null,
            errorDiagnostic: input.errorDiagnostic ?? null,
            updatedAt: input.now,
          };
          stored.set(key, updated);
          return updated;
        },
      ),
      markRunUncertainAndPause: vi.fn(),
      beginPrecheck: vi.fn(),
      finishPrecheckWithoutDispatch: vi.fn(),
      passPrecheck: vi.fn(),
    };
    const dispatcher = new AutomationDispatcher({
      repository: repository as never,
      gateway,
      inventory: {
        getThread: vi.fn(() => ({
          inventory: { inventoryState: "active", snoozedUntil: null },
        })) as never,
      },
      service: {
        publishRun: vi.fn(),
        dispatchCapacityChanged: vi.fn(),
      },
      prechecks: { execute: vi.fn() as never },
      now: () => 2_000,
    });

    const dispatched = runs.map((item) => dispatcher.dispatch(item));
    await vi.waitFor(() => expect(gateway.dispatch).toHaveBeenCalledTimes(4));
    expect(dispatcher.availableCapacity()).toBe(0);
    expect(active).toBe(4);

    release();
    const completed = await Promise.all(dispatched);

    expect(completed.every(({ state }) => state === "completed")).toBe(true);
    expect(gateway.dispatch).toHaveBeenCalledTimes(6);
    expect(maximumActive).toBe(4);
    expect(active).toBe(0);
    expect(dispatcher.availableCapacity()).toBe(4);
  });
});
