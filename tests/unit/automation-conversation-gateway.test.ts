import { describe, expect, it, vi } from "vitest";
import type { QueuedInputRecord } from "../../src/server/db/repositories/queued-input-repository.js";
import {
  AutomationQueueRunObserver,
  LifecycleAutomationConversationGateway,
  type AutomationFirstInputLifecycle,
} from "../../src/server/runtime/automation-conversation-gateway.js";
import type { ThreadForkService } from "../../src/server/conversations/thread-fork-service.js";
import { DomainError } from "../../src/server/domain/errors.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const dispatchInput = {
  scope,
  automationId: "automation-1",
  automationRunId: "run-1",
  anchorThreadId: "thread-1",
  runMode: "same_thread" as const,
  prompt: "Run the review",
  dispatchMutationId: "dispatch-1",
};

function queued(state: QueuedInputRecord["state"]): QueuedInputRecord {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    id: "queue-1",
    applicationThreadId: "thread-1",
    sequence: 1,
    mutationId: "dispatch-1",
    text: "Run the review",
    selectedSkillId: null,
    contextExcerpts: [],
    attachments: [],
    taskContexts: [],
    requestedDeliveryMode: null,
    requestedSteerTarget: null,
    steerFallbackAt: null,
    resolvedDeliveryMode: "queue",
    resolvedSteerTarget: null,
    requestedThreadRevision: null,
    requestedDraftRevision: null,
    triggerKind: "automation",
    sourceAutomationId: "automation-1",
    sourceAutomationRunId: "run-1",
    initiatingAgentThreadId: null,
    initiatingToolClientId: null,
    completionCallbackId: null,
    inputOrigin: null,
    state,
    deliveryMode:
      state === "dispatching" || state === "uncertain" ? "submit" : null,
    retryOfId: null,
    createdAt: 1_000,
    dispatchStartedAt: state === "pending" ? null : 1_001,
    acceptedAt: state === "accepted" ? 1_002 : null,
    resolvedAt: state === "accepted" ? 1_002 : null,
    reconciliationToken: state === "uncertain" ? "dispatch-1" : null,
    retryAnchor: state === "uncertain" ? "{}" : null,
    backendCorrelation: null,
    retryCount: 0,
    invalidStateRequeues: 0,
    nextAttemptAt: state === "retry_wait" ? 2_000 : null,
    diagnostic: state === "uncertain" ? "Unknown acceptance" : null,
    failureAcknowledgedAt: null,
    cancellationMutationId: null,
    cancellationRequestFingerprint: null,
  };
}

function gateway(input: {
  backingState: "unbound" | "creating" | "bound" | "creation_unknown";
  queueState?: QueuedInputRecord["state"];
  firstInput?: AutomationFirstInputLifecycle["submit"];
  hasFirstInputMutation?: boolean;
  branch?: ThreadForkService["forkAutomation"];
  readThread?: (applicationThreadId: string) => {
    readonly backingState:
      "unbound" | "creating" | "bound" | "creation_unknown";
    readonly revision: number;
  };
  assertCanAutomate?: () => void;
}) {
  const enqueue = vi.fn(async () => ({
    item: queued(input.queueState ?? "pending"),
    replayed: false,
  }));
  const firstInput = vi.fn(
    input.firstInput ?? (async () => ({ status: "accepted" as const })),
  );
  const branch = vi.fn(
    input.branch ??
      (async () => ({
        status: "created" as const,
        childThreadId: "thread-child",
      })),
  );
  const assertCanAutomate = vi.fn(input.assertCanAutomate ?? (() => undefined));
  const readThread = vi.fn(
    (_scope, applicationThreadId: string) =>
      input.readThread?.(applicationThreadId) ?? {
        backingState: input.backingState,
        revision: 7,
      },
  );
  return {
    instance: new LifecycleAutomationConversationGateway({
      threads: {
        read: readThread,
      },
      queue: { enqueue },
      queueRepository: {
        findByMutationId: () => queued(input.queueState ?? "pending"),
      },
      firstInput: {
        hasMutation: () => input.hasFirstInputMutation ?? false,
        submit: firstInput,
      },
      branches: { forkAutomation: branch },
      executionPolicy: { assertCanAutomate },
      now: () => 1_500,
    }),
    enqueue,
    firstInput,
    branch,
    readThread,
    assertCanAutomate,
  };
}

describe("LifecycleAutomationConversationGateway", () => {
  it("routes a bound thread through the durable actor-backed queue", async () => {
    const setup = gateway({ backingState: "bound", queueState: "accepted" });
    await expect(setup.instance.dispatch(dispatchInput)).resolves.toEqual({
      status: "accepted",
      targetThreadId: "thread-1",
    });
    expect(setup.enqueue).toHaveBeenCalledWith(scope, "thread-1", {
      mutationId: "dispatch-1",
      text: "Run the review",
      contextExcerpts: [],
      attachmentIds: [],
      taskReferences: [],
      source: {
        kind: "automation",
        expectedThreadRevision: 7,
        automationId: "automation-1",
        automationRunId: "run-1",
      },
      now: 1_500,
    });
    expect(setup.firstInput).not.toHaveBeenCalled();
  });

  it("routes an unbound thread through first-input lifecycle recovery", async () => {
    const setup = gateway({
      backingState: "unbound",
      firstInput: async () => ({
        status: "uncertain",
        diagnostic: "Creation acceptance is unknown",
      }),
    });
    await expect(setup.instance.dispatch(dispatchInput)).resolves.toEqual({
      status: "uncertain",
      diagnostic: "Creation acceptance is unknown",
      targetThreadId: "thread-1",
    });
    expect(setup.firstInput).toHaveBeenCalledWith({
      scope,
      applicationThreadId: "thread-1",
      automationId: "automation-1",
      automationRunId: "run-1",
      prompt: "Run the review",
      contextExcerpts: [],
      attachmentIds: [],
      taskReferences: [],
      mutationId: "dispatch-1",
      expectedThreadRevision: 7,
    });
    expect(setup.enqueue).not.toHaveBeenCalled();
  });

  it("replays a known first-input mutation through its lifecycle after the thread becomes bound", async () => {
    const setup = gateway({
      backingState: "bound",
      hasFirstInputMutation: true,
    });

    await expect(setup.instance.dispatch(dispatchInput)).resolves.toEqual({
      status: "accepted",
      targetThreadId: "thread-1",
    });

    expect(setup.firstInput).toHaveBeenCalledWith({
      scope,
      applicationThreadId: "thread-1",
      automationId: "automation-1",
      automationRunId: "run-1",
      prompt: "Run the review",
      contextExcerpts: [],
      attachmentIds: [],
      taskReferences: [],
      mutationId: "dispatch-1",
      expectedThreadRevision: 0,
    });
    expect(setup.enqueue).not.toHaveBeenCalled();
  });

  it("replays committed fork creation before checking changed anchor eligibility or enqueueing clone input", async () => {
    let resolveFork!: (value: {
      readonly status: "created";
      readonly childThreadId: string;
    }) => void;
    const forkPending = new Promise<{
      readonly status: "created";
      readonly childThreadId: string;
    }>((resolve) => {
      resolveFork = resolve;
    });
    const setup = gateway({
      backingState: "bound",
      branch: async () => forkPending,
      readThread: (threadId) => ({
        backingState: threadId === "thread-child" ? "bound" : "unbound",
        revision: 9,
      }),
      assertCanAutomate: () => {
        throw new DomainError(
          "invalid_transition",
          "The archived anchor cannot start new automation work.",
        );
      },
    });
    const dispatch = setup.instance.dispatch({
      ...dispatchInput,
      runMode: "clone",
    });
    await vi.waitFor(() => expect(setup.branch).toHaveBeenCalledOnce());
    expect(setup.enqueue).not.toHaveBeenCalled();

    resolveFork({ status: "created", childThreadId: "thread-child" });
    await expect(dispatch).resolves.toEqual({
      status: "queued",
      targetThreadId: "thread-child",
    });
    expect(setup.branch).toHaveBeenCalledWith({
      scope,
      anchorThreadId: "thread-1",
      automationId: "automation-1",
      automationRunId: "run-1",
      mutationId: "dispatch-1",
    });
    expect(setup.assertCanAutomate).not.toHaveBeenCalled();
    expect(setup.readThread).toHaveBeenCalledWith(scope, "thread-child");
    expect(setup.enqueue).toHaveBeenCalledWith(
      scope,
      "thread-child",
      expect.objectContaining({ text: "Run the review", contextExcerpts: [] }),
    );
    expect(setup.readThread.mock.invocationCallOrder[0]).toBeLessThan(
      setup.enqueue.mock.invocationCallOrder[0]!,
    );
  });

  it("still rejects a genuinely new clone when the fork service reports current branching unavailable", async () => {
    const setup = gateway({
      backingState: "bound",
      branch: async () => {
        throw new DomainError(
          "invalid_transition",
          "Clone-mode automation is no longer available for this thread.",
        );
      },
    });

    await expect(
      setup.instance.dispatch({ ...dispatchInput, runMode: "clone" }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
      message: "Clone-mode automation is no longer available for this thread.",
    });
    expect(setup.branch).toHaveBeenCalledOnce();
    expect(setup.assertCanAutomate).not.toHaveBeenCalled();
    expect(setup.enqueue).not.toHaveBeenCalled();
  });

  it("does not queue a child prompt while a provider-assigned fork is unknown", async () => {
    const setup = gateway({
      backingState: "bound",
      branch: async () => ({
        status: "recovery_required",
        childThreadId: "thread-reserved-unknown",
        retryable: false,
        uncertaintyKind: "fork_unknown",
        diagnostic:
          "Codex may have created a full native fork copy; the possible orphan requires explicit reconciliation.",
      }),
    });

    await expect(
      setup.instance.dispatch({ ...dispatchInput, runMode: "clone" }),
    ).resolves.toEqual({
      status: "uncertain",
      targetThreadId: "thread-reserved-unknown",
      diagnostic:
        "Codex may have created a full native fork copy; the possible orphan requires explicit reconciliation.",
    });
    expect(setup.readThread).not.toHaveBeenCalled();
    expect(setup.enqueue).not.toHaveBeenCalled();
  });

  it("preserves durable uncertain queue diagnostics", async () => {
    const setup = gateway({ backingState: "bound", queueState: "uncertain" });
    await expect(setup.instance.dispatch(dispatchInput)).resolves.toEqual({
      status: "uncertain",
      targetThreadId: "thread-1",
      diagnostic: "Unknown acceptance",
    });
  });
});

describe("AutomationQueueRunObserver", () => {
  it("completes a queued run through the repository and publisher so one-shot removal and attention remain centralized", () => {
    const automationRun = {
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      automationId: "automation-1",
      id: "run-1",
      occurrenceKind: "scheduled",
      state: "queued",
    };
    const completed = { ...automationRun, state: "completed" };
    const repository = {
      findRunByDispatchMutation: vi.fn(() => automationRun),
      getDefinition: vi.fn(() => ({
        schedule: { kind: "date_time" },
      })),
      updateRunState: vi.fn(() => completed),
      markRunUncertainAndPause: vi.fn(),
    };
    const publisher = { publishRun: vi.fn() };
    const observer = new AutomationQueueRunObserver({
      repository: repository as never,
      queue: { findByMutationId: vi.fn() },
      publisher: publisher as never,
      now: () => 2_000,
    });

    observer.observe(scope, "thread-1", queued("accepted"));

    expect(repository.updateRunState).toHaveBeenCalledWith(
      scope,
      "automation-1",
      "run-1",
      {
        expectedState: "queued",
        state: "completed",
        now: 2_000,
        completeDefinition: true,
      },
    );
    expect(publisher.publishRun).toHaveBeenCalledWith(scope, completed);
  });

  it("recovers a fast accepted clone receipt after restart", () => {
    const automationRun = {
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      automationId: "automation-1",
      id: "run-1",
      anchorThreadId: "thread-1",
      childThreadId: "thread-child",
      dispatchMutationId: "dispatch-1",
      occurrenceKind: "manual",
      state: "queued",
    };
    const completed = { ...automationRun, state: "completed" };
    const repository = {
      listQueueObservedRuns: vi.fn(() => [automationRun]),
      findRunByDispatchMutation: vi.fn(() => automationRun),
      getDefinition: vi.fn(() => ({
        schedule: { kind: "interval" },
      })),
      updateRunState: vi.fn(() => completed),
      markRunUncertainAndPause: vi.fn(),
    };
    const queue = {
      findByMutationId: vi.fn(() => queued("accepted")),
    };
    const publisher = { publishRun: vi.fn() };
    const observer = new AutomationQueueRunObserver({
      repository: repository as never,
      queue,
      publisher: publisher as never,
      now: () => 2_000,
    });

    observer.recover();

    expect(queue.findByMutationId).toHaveBeenCalledWith(
      scope,
      "thread-child",
      "dispatch-1",
    );
    expect(repository.updateRunState).toHaveBeenCalledWith(
      scope,
      "automation-1",
      "run-1",
      {
        expectedState: "queued",
        state: "completed",
        now: 2_000,
        completeDefinition: false,
      },
    );
    expect(publisher.publishRun).toHaveBeenCalledWith(scope, completed);
  });
});
