import { describe, expect, it, vi } from "vitest";
import { BackendError } from "../../src/server/backends/contracts.js";
import type { PreparedInteractionResponse } from "../../src/server/conversations/interaction-broker.js";
import {
  ThreadMutationGateway,
  type ProviderFeatureMutationActor,
} from "../../src/server/conversations/thread-mutation-gateway.js";
import { threadAgentToolPolicyRepository } from "../support/thread-agent-tool-policy.js";
import { DomainError } from "../../src/server/domain/errors.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import {
  ThreadRuntimeNotIdleError,
  ThreadRuntimeRetirementUnprovenError,
} from "../../src/server/events/thread-runtime-coordinator.js";
import {
  CONCURRENT_PROVIDER_FEATURE_CONCURRENCY,
  QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY,
  type ProviderFeatureConcurrency,
} from "../../src/server/provider-features/contracts.js";

const scope: RequestScope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function testThreadAgentToolPolicyRepository(database: unknown) {
  return threadAgentToolPolicyRepository(database as never);
}

type InterruptRecord = {
  tenantId: string;
  principalId: string;
  threadId: string;
  operationId: string;
  applicationOperationId: string;
  expectedActiveTurnId: string;
  state: "prepared" | "uncertain" | "accepted";
  createdAt: number;
};

function deliveryHub(
  mode: "submit" | "queue" | "steer",
  available: boolean,
  unavailableReason = "Choose the required thread settings before sending.",
  targetKind: "turn" | "conversation" = "turn",
) {
  return {
    snapshot: {
      capabilities: {
        deliveryModes: (["submit", "steer", "queue"] as const).map((id) => ({
          id,
          steerTarget: id === "steer" ? targetKind : null,
          available: available && (id !== "steer" || mode === "steer"),
          ...(available
            ? {}
            : { unavailableReason: { text: unavailableReason } }),
        })),
      },
    },
  };
}

function fixture(input?: {
  discardFork?: (scope: RequestScope, threadId: string) => Promise<{
    status: "aborted"; childThreadId: string; diagnostic: string; restartable: boolean;
  }>;
  interrupt?: () => Promise<void>;
  reconcileInterrupt?: () => Promise<{
    outcome: "accepted" | "not_applied" | "unknown";
  }>;
  runState?:
    | "running"
    | "waiting_for_approval"
    | "waiting_for_input"
    | "idle"
    | "failed"
    | "starting"
    | "stopping"
    | "disconnected"
    | "reconciling";
  activeTurnId?: string;
  recoverCreation?: () => Promise<
    | {
        status: "recovery_required";
        retryable: boolean;
      }
    | { status: "bound"; binding: object }
  >;
  moveReplay?: boolean;
  inventoryState?: "active" | "archived";
  threadAvailability?: "available" | "unavailable";
  backingState?: "unbound" | "bound";
  startFirstSend?: () => Promise<
    | { readonly status: "bound"; readonly binding: object }
    | { readonly status: "aborted" }
    | { readonly status: "recovery_required"; readonly retryable: boolean }
  >;
  startAgentControlFirstSend?: () => Promise<
    | { readonly status: "bound"; readonly binding: object }
    | { readonly status: "aborted" }
    | { readonly status: "recovery_required"; readonly retryable: boolean }
  >;
  startPrincipalClientFirstSend?: () => Promise<
    | { readonly status: "bound"; readonly binding: object }
    | { readonly status: "aborted" }
    | { readonly status: "recovery_required"; readonly retryable: boolean }
  >;
  activeQueuedInput?: boolean;
  uncertainQueuedInput?: boolean;
  reconciledQueueState?: "uncertain" | "accepted";
  deliveryMode?: "submit" | "queue" | "steer";
  steerTargetKind?: "turn" | "conversation";
  deliveryAvailable?: boolean;
  pendingMaterializationSteerSource?: "draft" | "queued_input";
  queuedDeliveryReplay?: {
    readonly id: string;
    readonly requestedDraftRevision: number;
    readonly resolvedDeliveryMode: "submit" | "steer" | "queue";
    readonly createdAt: number;
  };
  steerDeliveryReplay?: object;
  draft?: {
    readonly revision: number;
    readonly text: string;
    readonly selectedSkillId: string | null;
    readonly contextExcerpts: readonly [];
    readonly attachments: readonly [];
    readonly taskReferences: readonly [];
    readonly updatedAt: number;
  };
  publishThreadSnapshot?: () => Promise<void>;
  onPublicationError?: (error: unknown) => void;
  afterInterruptAccepted?: (
    actor: ProviderFeatureMutationActor,
  ) => Promise<boolean>;
}) {
  const database = {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => sql.includes("SELECT id FROM queued_inputs")
        ? input?.uncertainQueuedInput ? { id: "uncertain-head" } : undefined
        : input?.activeQueuedInput ? { present: 1 as const } : undefined),
    })),
  };
  const reconcileUncertain = vi.fn(async () => ({ state: input?.reconciledQueueState ?? "uncertain" }));
  let record: InterruptRecord | undefined;
  const actor: {
    readonly canEvict: boolean;
    readonly authoritativelySettled: boolean;
    timeline: {
      runState:
        | "running"
        | "waiting_for_approval"
        | "waiting_for_input"
        | "idle"
        | "failed"
        | "starting"
        | "stopping"
        | "disconnected"
        | "reconciling";
      activeTurnId?: string;
    };
    interrupt: ReturnType<typeof vi.fn<() => Promise<void>>>;
    reconcileInterrupt: ReturnType<
      typeof vi.fn<
        () => Promise<{
          outcome: "accepted" | "not_applied" | "unknown";
        }>
      >
    >;
    mutateProviderFeature: ReturnType<
      typeof vi.fn<
        () => Promise<{
          outcome: "accepted" | "uncertain" | "rejected";
        }>
      >
    >;
  } = {
    get authoritativelySettled() { return this.timeline.runState === "idle" || this.timeline.runState === "failed"; },
    get canEvict() {
      return this.timeline.runState === "idle";
    },
    timeline: {
      runState: input?.runState ?? "running",
      activeTurnId: input?.activeTurnId ?? "turn-1",
    },
    interrupt: vi.fn(input?.interrupt ?? (async () => undefined)),
    reconcileInterrupt: vi.fn(
      input?.reconcileInterrupt ??
        (async () => ({ outcome: "not_applied" as const })),
    ),
    mutateProviderFeature: vi.fn(async () => ({
      outcome: "accepted" as const,
    })),
  };
  const publishAuthoritativeReplacement = vi.fn(async () => undefined);
  const operations = {
    database,
    listPreparedDraftSteers: vi.fn(() => []),
    listUncertainSteers: vi.fn(() => []),
    listPendingMaterializationSteers: vi.fn(() => []),
    listUncertainInterrupts: vi.fn(() => []),
    listUncertainBackendActions: vi.fn(() => []),
    listUncertainInteractionResponses: vi.fn(() => []),
    rejectSteerBeforeAcceptance: vi.fn(),
    findSteer: vi.fn(() => input?.steerDeliveryReplay),
    findUncertainThreadOperation: vi.fn(
      (_scope: RequestScope, threadId: string) =>
        record?.state === "uncertain"
          ? {
              threadId,
              mutationId: record.operationId,
              operationKind: "conversation_interrupt",
            }
          : undefined,
    ),
    hasPendingMaterializationSteer: vi.fn(
      () => input?.pendingMaterializationSteerSource !== undefined,
    ),
    findPendingMaterializationSteer: vi.fn(() =>
      input?.pendingMaterializationSteerSource
        ? { source: input.pendingMaterializationSteerSource }
        : undefined,
    ),
    findInterrupt: vi.fn(() => record),
    prepareInterrupt: vi.fn(
      (
        _scope: RequestScope,
        threadId: string,
        prepare: {
          operationId: string;
          expectedActiveTurnId: string;
          now: number;
        },
      ) => {
        record = {
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          threadId,
          operationId: prepare.operationId,
          applicationOperationId: prepare.operationId,
          expectedActiveTurnId: prepare.expectedActiveTurnId,
          state: "prepared",
          createdAt: prepare.now,
        };
        return record;
      },
    ),
    markInterruptStarted: vi.fn(() => {
      if (!record) throw new Error("missing interrupt record");
      record = { ...record, state: "uncertain" };
      return record;
    }),
    acceptInterrupt: vi.fn(() => {
      if (!record) throw new Error("missing interrupt record");
      record = { ...record, state: "accepted" };
      return record;
    }),
    rejectInterruptProvenNotApplied: vi.fn(() => {
      record = undefined;
    }),
  };
  const recoverActiveFirstSend = vi.fn(input?.recoverCreation);
  const moveServerDraftWorkspace = vi.fn(async () => undefined);
  const isUnboundThreadWorkspaceMoveReplay = vi.fn(
    () => input?.moveReplay ?? false,
  );
  const publishThreadSnapshot = vi.fn(
    input?.publishThreadSnapshot ?? (async () => undefined),
  );
  const onThreadChanged = vi.fn(async () => undefined);
  const onAuthoritativeSettled = vi.fn(async () => undefined);
  const getDraft = vi.fn(
    () =>
      input?.draft ?? {
        revision: 2,
        text: "First input",
        selectedSkillId: null,
        contextExcerpts: [],
        attachments: [],
        updatedAt: 1_800_000_000_000,
      },
  );
  const enqueue = vi.fn(
    async (
      _scope: RequestScope,
      _threadId: string,
      request: { readonly mutationId: string },
    ): Promise<{
      item: {
        id: string;
        mutationId: string;
        resolvedDeliveryMode: "submit" | "steer" | "queue";
        createdAt: number;
      };
      replayed: boolean;
    }> => ({
      item: {
        id: "agent-queued-input",
        mutationId: request.mutationId,
        createdAt: 1_800_000_000_000,
        resolvedDeliveryMode:
          (
            request as {
              source?: { resolvedDeliveryMode?: "submit" | "steer" | "queue" };
            }
          ).source?.resolvedDeliveryMode ?? "queue",
      },
      replayed: false,
    }),
  );
  const findComposerDeliveryReplay = vi.fn(() => input?.queuedDeliveryReplay);
  const restoreUserInput = vi.fn(async () => ({
    item: { id: "queued-input-1" },
    replayed: false,
    threadRevision: 8,
    queue: [],
    draft: {
      revision: 3,
      text: "restored text",
      selectedSkillId: null,
      contextExcerpts: [],
      attachments: [],
      updatedAt: 1_800_000_000_000,
    },
  }));
  const startAgentControlFirstSend = vi.fn(
    input?.startAgentControlFirstSend ??
      (async () => ({ status: "bound" as const, binding: {} })),
  );
  const startPrincipalClientFirstSend = vi.fn(
    input?.startPrincipalClientFirstSend ??
      (async () => ({ status: "bound" as const, binding: {} })),
  );
  const runtimeRelease = vi.fn();
  const acquireRuntime = vi.fn(async () => ({
    actor,
    hub: deliveryHub(
      input?.deliveryMode ?? "submit",
      input?.deliveryAvailable ?? true,
      undefined, input?.steerTargetKind,
    ),
    publishAuthoritativeReplacement,
    release: runtimeRelease,
  }));
  const afterInterruptAccepted = vi.fn(
    input?.afterInterruptAccepted ?? (async () => false),
  );
  const gateway = new ThreadMutationGateway({
    bindings: {
      database,
      isUnboundThreadWorkspaceMoveReplay,
      getTarget: vi.fn(() => ({
        backingState: input?.backingState ?? "bound",
      })),
    } as never,
    inventory: {
      assertWorkspaceActive: vi.fn(),
      database,
      getThread: (_scope: RequestScope, threadId: string) => ({
        thread: {
          id: threadId,
          backendInstanceId: "backend-primary",
          revision: 7,
          backingState: input?.backingState ?? "bound",
          availability: input?.threadAvailability ?? "available",
        },
        inventory: {
          inventoryState: input?.inventoryState ?? "active",
        },
      }),
      getDraft,
    } as never,
    lifecycle: {
      recoverActiveFirstSend: input?.recoverCreation
        ? recoverActiveFirstSend
        : () => undefined,
      moveServerDraftWorkspace,
      hasFirstInputMutation: vi.fn(() => false),
      startFirstSend:
        input?.startFirstSend ??
        (async () => ({ status: "bound" as const, binding: {} })),
      startAgentControlFirstSend,
      startPrincipalClientFirstSend,
    } as never,
    forks: { recoverActive: () => undefined, discardActive: input?.discardFork ?? (async () => { throw new Error("test_unexpected_discard"); }) },
    queue: {
      reconcileUncertain,
      onAuthoritativeSettled,
      enqueue,
      restoreUserInput,
      findComposerDeliveryReplay,
    } as never,
    operations: operations as never,
    completions: { database } as never,
    queueGateway: {} as never,
    runtimes: {
      acquire: acquireRuntime,
    } as never,
    interactions: {} as never,
    presentation: {} as never,
    agentToolPolicies: testThreadAgentToolPolicyRepository(database),
    actionPersistence: new Map([
      [
        "backend-primary",
        {
          afterInterruptAccepted,
        },
      ],
    ]) as never,
    publishThreadSnapshot,
    onPublicationError: input?.onPublicationError,
    onThreadChanged,
    now: () => 1_800_000_000_000,
  });
  return {
    reconcileUncertain,
    gateway,
    actor,
    afterInterruptAccepted,
    operations,
    publishAuthoritativeReplacement,
    publishThreadSnapshot,
    onThreadChanged,
    onAuthoritativeSettled,
    enqueue,
    findComposerDeliveryReplay,
    restoreUserInput,
    startAgentControlFirstSend,
    startPrincipalClientFirstSend,
    acquireRuntime,
    runtimeRelease,
    getDraft,
    recoverActiveFirstSend,
    moveServerDraftWorkspace,
    isUnboundThreadWorkspaceMoveReplay,
    getRecord: () => record,
    setTimeline(
      runState:
        | "running"
        | "waiting_for_approval"
        | "waiting_for_input"
        | "idle"
        | "starting"
        | "stopping"
        | "disconnected"
        | "reconciling",
      activeTurnId?: string,
    ) {
      actor.timeline.runState = runState;
      actor.timeline.activeTurnId = activeTurnId;
    },
  };
}

describe("ThreadMutationGateway pending Steer restart recovery", () => {
  it("finishes startup after an uncertain legacy draft becomes terminal unknown", async () => {
    const subject = fixture();
    const receipt = {
      source: "draft", mutationId: "uncertain-draft", threadId: "thread-1",
      applicationOperationId: "uncertain-draft", reconciliationToken: "uncertain-draft",
      target: { kind: "conversation" }, state: "uncertain", attachments: [],
    };
    Object.assign(subject.operations, {
      listUncertainSteers: vi.fn(() => [receipt]),
      findUncertainThreadOperation: vi.fn(() => receipt.state === "uncertain" ? {
        operationKind: "conversation_steer", mutationId: receipt.mutationId,
      } : undefined),
      getSteer: vi.fn(() => receipt), findSteer: vi.fn(() => receipt),
      failSteerUnknown: vi.fn(() => { receipt.state = "failed_unknown"; return receipt; }),
    });
    Object.assign(subject.gateway.input.queueGateway, {
      reconcileSubmission: vi.fn(async () => ({ status: "failed_unknown", diagnostic: { text: "Original tracker ended" } })),
    });
    await expect(subject.gateway.recoverUncertain(scope)).resolves.toBeUndefined();
    expect(receipt.state).toBe("failed_unknown");
    expect(subject.enqueue).not.toHaveBeenCalled();
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(scope, "thread-1");
  });

  it.each([
    ["turn", "unresolved"], ["conversation", "unresolved"],
    ["turn", "failed_unknown"], ["conversation", "failed_unknown"],
  ] as const)(
    "recovers %s draft materialization with %s outcome without replaying delivery",
    async (kind, outcome) => {
      const receipt = {
        source: "draft", mutationId: "pending-draft-steer", threadId: "thread-1",
        applicationOperationId: "pending-draft-steer", reconciliationToken: "pending-draft-steer",
        target: kind === "turn" ? { kind, turnId: "turn-1" } : { kind },
        state: "pending_materialization", attachments: [],
      };
      const subject = fixture();
      const markSteerMaterializationUncertain = vi.fn(() => { receipt.state = "uncertain"; return receipt; });
      const failSteerUnknown = vi.fn(() => { receipt.state = "failed_unknown"; return receipt; });
      Object.assign(subject.operations, {
        listPendingMaterializationSteers: vi.fn(() => [receipt]),
        getSteer: vi.fn(() => receipt), findSteer: vi.fn(() => receipt),
        markSteerMaterializationUncertain, failSteerUnknown,
      });
      const reconcileSubmission = vi.fn(async () => ({ status: outcome, diagnostic: { text: "Consumption unknown" } }));
      Object.assign(subject.gateway.input.queueGateway, { reconcileSubmission });
      await subject.gateway.recoverUncertain(scope);
      expect(reconcileSubmission).toHaveBeenCalledOnce();
      expect(receipt.state).toBe(kind === "conversation" ? outcome === "failed_unknown" ? "failed_unknown" : "uncertain" : "pending_materialization");
      expect(markSteerMaterializationUncertain).toHaveBeenCalledTimes(kind === "conversation" && outcome === "unresolved" ? 1 : 0);
      expect(failSteerUnknown).toHaveBeenCalledTimes(kind === "conversation" && outcome === "failed_unknown" ? 1 : 0);
      expect(subject.enqueue).not.toHaveBeenCalled();
      expect(subject.acquireRuntime).not.toHaveBeenCalled();
    },
  );
});

describe("ThreadMutationGateway project removal admission", () => {
  it("rejects new delivery before touching runtime or draft when the project was removed", async () => {
    const subject = fixture({ runState: "idle" });
    vi.mocked(subject.gateway.input.inventory.assertWorkspaceActive).mockImplementation(() => { throw new Error("project_removed"); });
    await expect(subject.gateway.mutate(scope, "target-thread", {
      kind: "deliver", mutationId: "removed-delivery", mode: "submit", expectedThreadRevision: 7, expectedDraftRevision: 2,
    })).rejects.toThrow("project_removed");
    expect(subject.acquireRuntime).not.toHaveBeenCalled();
    expect(subject.getDraft).not.toHaveBeenCalled();
    expect(subject.enqueue).not.toHaveBeenCalled();
  });

  it("rechecks removal after waiting for runtime acquisition and releases the acquired lease", async () => {
    const subject = fixture({ runState: "idle" });
    vi.mocked(subject.gateway.input.inventory.assertWorkspaceActive)
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => { throw new Error("project_removed"); });
    await expect(subject.gateway.mutate(scope, "target-thread", {
      kind: "deliver", mutationId: "racing-delivery", mode: "submit", expectedThreadRevision: 7, expectedDraftRevision: 2,
    })).rejects.toThrow("project_removed");
    expect(subject.acquireRuntime).toHaveBeenCalledOnce();
    expect(subject.runtimeRelease).toHaveBeenCalledOnce();
    expect(subject.enqueue).not.toHaveBeenCalled();
  });
});

describe("ThreadMutationGateway queued-input restore", () => {
  it("returns the authoritative restored draft and publishes the application state", async () => {
    const subject = fixture();

    await expect(
      subject.gateway.mutate(scope, "target-thread", {
        kind: "restore_queued_input",
        queuedInputId: "queued-input-1",
        mutationId: "restore-operation-1",
        expectedThreadRevision: 7,
        expectedDraftRevision: 2,
      }),
    ).resolves.toEqual({
      status: "queue_restored",
      queuedInputId: "queued-input-1",
      mutationId: "restore-operation-1",
      threadRevision: 8,
      queue: [],
      draft: {
        text: "restored text",
        contextExcerpts: [],
        attachments: [],
        revision: 3,
        updatedAt: new Date(1_800_000_000_000).toISOString(),
      },
    });
    expect(subject.restoreUserInput).toHaveBeenCalledWith(
      scope,
      "target-thread",
      "queued-input-1",
      {
        mutationId: "restore-operation-1",
        expectedThreadRevision: 7,
        expectedDraftRevision: 2,
        now: 1_800_000_000_000,
      },
    );
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
      scope,
      "target-thread",
    );
    expect(subject.onThreadChanged).toHaveBeenCalledWith(
      scope,
      "target-thread",
    );
  });
});

describe("ThreadMutationGateway direct agent control", () => {
  const send = (
    subject: ReturnType<typeof fixture>,
    mutationId = "agent-send-1",
  ) =>
    subject.gateway.sendDirect(scope, {
      initiator: {
        kind: "thread_agent",
        sourceThreadId: "controller-thread",
        sourceWorkspaceId: "workspace-1",
      },
      targetThreadId: "target-thread",
      message: "Continue independently.",
      mutationId,
    });

  it.each(["idle", "failed"] as const)("admits one bound %s input without consulting the human composer draft", async (runState) => {
    const subject = fixture({
      runState,
      draft: {
        revision: 9,
        text: "unfinished human text",
        selectedSkillId: "human-skill",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        updatedAt: 1_800_000_000_000,
      },
    });

    await expect(send(subject)).resolves.toEqual({
      status: "delivery_accepted",
      operationId: "agent-send-1",
    });
    expect(subject.getDraft).not.toHaveBeenCalled();
    expect(subject.enqueue).toHaveBeenCalledWith(scope, "target-thread", {
      mutationId: "agent-send-1",
      text: "Continue independently.",
      contextExcerpts: [],
      attachmentIds: [],
      taskReferences: [],
      source: {
        kind: "agent_control",
        expectedThreadRevision: 7,
        initiatingAgentThreadId: "controller-thread",
      },
      now: 1_800_000_000_000,
    });
  });

  it("atomically requests a callback on a bound agent-control queue admission", async () => {
    const subject = fixture({ runState: "idle" });

    const result = await subject.gateway.sendDirect(scope, {
      initiator: {
        kind: "thread_agent",
        sourceThreadId: "controller-thread",
        sourceWorkspaceId: "workspace-1",
      },
      targetThreadId: "target-thread",
      message: "Continue independently.",
      callback: true,
      mutationId: "agent-send-with-callback",
    });
    if (result.status !== "delivery_accepted" || !result.callbackId) {
      throw new Error("expected_callback_delivery_acceptance");
    }

    expect(result).toEqual({
      status: "delivery_accepted",
      operationId: "agent-send-with-callback",
      callbackId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(subject.enqueue).toHaveBeenCalledWith(
      scope,
      "target-thread",
      expect.objectContaining({
        mutationId: "agent-send-with-callback",
        source: {
          kind: "agent_control",
          expectedThreadRevision: 7,
          initiatingAgentThreadId: "controller-thread",
          completionCallback: {
            id: result.callbackId,
            callerThreadId: "controller-thread",
          },
        },
      }),
    );
  });

  it.each([
    [
      "principal clients",
      { kind: "principal_client" as const, clientId: "client-1" },
      "target-thread",
    ],
    [
      "self sends",
      {
        kind: "thread_agent" as const,
        sourceThreadId: "target-thread",
        sourceWorkspaceId: "workspace-1",
      },
      "target-thread",
    ],
  ])(
    "rejects callback registration for %s",
    async (_label, initiator, targetThreadId) => {
      const subject = fixture({ runState: "idle" });

      await expect(
        subject.gateway.sendDirect(scope, {
          initiator,
          targetThreadId,
          message: "Continue independently.",
          callback: true,
          mutationId: "invalid-callback-send",
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      expect(subject.enqueue).not.toHaveBeenCalled();
      expect(subject.startAgentControlFirstSend).not.toHaveBeenCalled();
    },
  );

  it("serializes competing direct admissions through the target mailbox", async () => {
    const subject = fixture({ runState: "idle" });
    const admitted = deferred<{
      item: {
        id: string;
        mutationId: string;
        resolvedDeliveryMode: "queue";
        createdAt: number;
      };
      replayed: boolean;
    }>();
    subject.enqueue.mockImplementationOnce(() => admitted.promise);

    const first = send(subject, "agent-send-first");
    const second = send(subject, "agent-send-second");
    await vi.waitFor(() => expect(subject.enqueue).toHaveBeenCalledOnce());
    subject.setTimeline("running", "turn-from-first-send");
    admitted.resolve({
      item: {
        id: "first-input",
        mutationId: "agent-send-first",
        resolvedDeliveryMode: "queue",
        createdAt: 1_800_000_000_000,
      },
      replayed: false,
    });

    await expect(first).resolves.toEqual({
      status: "delivery_accepted",
      operationId: "agent-send-first",
    });
    await expect(second).rejects.toMatchObject({ code: "invalid_transition" });
    expect(subject.enqueue).toHaveBeenCalledOnce();
  });

  it.each([
    ["running target", { runState: "running" as const }],
    ["disconnected target", { runState: "disconnected" as const }],
    ["reconciling target", { runState: "reconciling" as const }],
    [
      "archived target",
      { runState: "idle" as const, inventoryState: "archived" as const },
    ],
    [
      "unavailable target",
      { runState: "idle" as const, threadAvailability: "unavailable" as const },
    ],
    [
      "active durable input",
      { runState: "idle" as const, activeQueuedInput: true },
    ],
  ])("rejects a %s before adding another input", async (_label, options) => {
    const subject = fixture(options);
    await expect(send(subject)).rejects.toMatchObject({
      code: "invalid_transition",
    });
    expect(subject.enqueue).not.toHaveBeenCalled();
    expect(subject.startAgentControlFirstSend).not.toHaveBeenCalled();
  });

  it("uses the independent first-send path for an unbound target", async () => {
    const subject = fixture({ runState: "idle", backingState: "unbound" });
    await expect(send(subject)).resolves.toEqual({
      status: "delivery_accepted",
      operationId: "agent-send-1",
    });
    expect(subject.startAgentControlFirstSend).toHaveBeenCalledWith(
      scope,
      "target-thread",
      {
        initiatingAgentThreadId: "controller-thread",
        prompt: "Continue independently.",
        mutationId: "agent-send-1",
        expectedThreadRevision: 7,
      },
    );
    expect(subject.acquireRuntime).toHaveBeenCalledWith(scope, "target-thread");
    expect(subject.getDraft).not.toHaveBeenCalled();
    expect(subject.enqueue).not.toHaveBeenCalled();
  });

  it("persists a principal client without inventing a controller thread", async () => {
    const subject = fixture({ runState: "idle" });
    await expect(
      subject.gateway.sendDirect(scope, {
        initiator: { kind: "principal_client", clientId: "client-1" },
        targetThreadId: "target-thread",
        message: "Continue from an external client.",
        mutationId: "client-send-1",
      }),
    ).resolves.toEqual({
      status: "delivery_accepted",
      operationId: "client-send-1",
    });
    expect(subject.enqueue).toHaveBeenCalledWith(scope, "target-thread", {
      mutationId: "client-send-1",
      text: "Continue from an external client.",
      contextExcerpts: [],
      attachmentIds: [],
      taskReferences: [],
      source: {
        kind: "principal_client_control",
        expectedThreadRevision: 7,
        initiatingToolClientId: "client-1",
      },
      now: 1_800_000_000_000,
    });
  });

  it("uses principal-client first-send provenance for an unbound target", async () => {
    const subject = fixture({ runState: "idle", backingState: "unbound" });
    await expect(
      subject.gateway.sendDirect(scope, {
        initiator: { kind: "principal_client", clientId: "client-1" },
        targetThreadId: "target-thread",
        message: "First external input.",
        mutationId: "client-first-send",
      }),
    ).resolves.toMatchObject({ status: "delivery_accepted" });
    expect(subject.startPrincipalClientFirstSend).toHaveBeenCalledWith(
      scope,
      "target-thread",
      {
        initiatingToolClientId: "client-1",
        prompt: "First external input.",
        mutationId: "client-first-send",
        expectedThreadRevision: 7,
      },
    );
    expect(subject.startAgentControlFirstSend).not.toHaveBeenCalled();
  });

  it("holds the newly bound runtime through sidebar publication", async () => {
    const publication = deferred<void>();
    const subject = fixture({
      runState: "running",
      backingState: "unbound",
      publishThreadSnapshot: () => publication.promise,
    });

    await expect(send(subject)).resolves.toEqual({
      status: "delivery_accepted",
      operationId: "agent-send-1",
    });
    await vi.waitFor(() =>
      expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
        scope,
        "target-thread",
      ),
    );
    expect(subject.runtimeRelease).not.toHaveBeenCalled();
    expect(subject.onThreadChanged).not.toHaveBeenCalled();

    publication.resolve();
    await vi.waitFor(() =>
      expect(subject.runtimeRelease).toHaveBeenCalledOnce(),
    );
    expect(subject.onThreadChanged).toHaveBeenCalledWith(
      scope,
      "target-thread",
    );
    expect(
      subject.startAgentControlFirstSend.mock.invocationCallOrder[0],
    ).toBeLessThan(subject.acquireRuntime.mock.invocationCallOrder[0]!);
    expect(subject.acquireRuntime.mock.invocationCallOrder[0]).toBeLessThan(
      subject.publishThreadSnapshot.mock.invocationCallOrder[0]!,
    );
    expect(subject.onThreadChanged.mock.invocationCallOrder[0]).toBeLessThan(
      subject.runtimeRelease.mock.invocationCallOrder[0]!,
    );
  });

  it("does not turn post-acceptance runtime observation failure into send failure", async () => {
    const observationError = new Error("runtime observation unavailable");
    const onPublicationError = vi.fn();
    const subject = fixture({
      runState: "running",
      backingState: "unbound",
      onPublicationError,
    });
    subject.acquireRuntime.mockRejectedValueOnce(observationError);

    await expect(send(subject)).resolves.toEqual({
      status: "delivery_accepted",
      operationId: "agent-send-1",
    });
    expect(onPublicationError).toHaveBeenCalledWith(observationError);
    await vi.waitFor(() =>
      expect(subject.onThreadChanged).toHaveBeenCalledWith(
        scope,
        "target-thread",
      ),
    );
    expect(subject.runtimeRelease).not.toHaveBeenCalled();
  });

  it("returns accepted before runtime observation settles and drains it on close", async () => {
    const subject = fixture({
      runState: "running",
      backingState: "unbound",
    });
    const acquisition =
      deferred<Awaited<ReturnType<(typeof subject)["acquireRuntime"]>>>();
    subject.acquireRuntime.mockImplementationOnce(() => acquisition.promise);

    await expect(send(subject)).resolves.toEqual({
      status: "delivery_accepted",
      operationId: "agent-send-1",
    });
    await vi.waitFor(() =>
      expect(subject.acquireRuntime).toHaveBeenCalledOnce(),
    );
    expect(subject.publishThreadSnapshot).not.toHaveBeenCalled();

    let closeSettled = false;
    const closing = subject.gateway.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    acquisition.resolve({
      actor: subject.actor,
      hub: deliveryHub("submit", true),
      publishAuthoritativeReplacement: subject.publishAuthoritativeReplacement,
      release: subject.runtimeRelease,
    });
    await closing;
    expect(subject.publishThreadSnapshot).toHaveBeenCalledOnce();
    expect(subject.onThreadChanged).toHaveBeenCalledOnce();
    expect(subject.runtimeRelease).toHaveBeenCalledOnce();
  });

  it.each([
    ["aborted", { status: "aborted" as const }],
    [
      "recovery required",
      { status: "recovery_required" as const, retryable: true },
    ],
  ])(
    "does not acquire a runtime when first send is %s",
    async (_label, result) => {
      const subject = fixture({
        runState: "idle",
        backingState: "unbound",
        startAgentControlFirstSend: async () => result,
      });

      await send(subject);

      expect(subject.acquireRuntime).not.toHaveBeenCalled();
    },
  );
});

describe("ThreadMutationGateway Stop receipts", () => {
  it("discards orphaned prepared draft steers during startup recovery", async () => {
    const subject = fixture();
    subject.operations.listPreparedDraftSteers.mockReturnValueOnce([
      {
        source: "draft",
        threadId: "thread-1",
        mutationId: "orphaned-prepared-steer",
        applicationOperationId: "orphaned-prepared-steer",
        reconciliationToken: "orphaned-prepared-steer",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
        target: null,
        selectedSkillId: null,
        contextExcerpts: [],
        attachments: [],
        state: "prepared",
        createdAt: 1_800_000_000_000,
      } as never,
    ]);

    await subject.gateway.recoverUncertain(scope);

    expect(subject.operations.rejectSteerBeforeAcceptance).toHaveBeenCalledWith(
      scope,
      "orphaned-prepared-steer",
    );
  });

  it("replays an accepted Stop without aborting the backend twice", async () => {
    const subject = fixture();
    const operation = {
      kind: "interrupt" as const,
      operationId: "stop-operation-1",
    };

    await expect(
      subject.gateway.mutate(scope, "thread-1", operation),
    ).resolves.toEqual({
      status: "accepted",
      operationId: "stop-operation-1",
    });
    subject.setTimeline("idle");
    await expect(
      subject.gateway.mutate(scope, "thread-1", operation),
    ).resolves.toEqual({
      status: "accepted",
      operationId: "stop-operation-1",
    });

    expect(subject.actor.interrupt).toHaveBeenCalledTimes(1);
    expect(subject.getRecord()?.state).toBe("accepted");
  });

  it("delegates accepted Stop lifecycle work to the selected backend", async () => {
    const subject = fixture({
      afterInterruptAccepted: async (actor) => {
        const result = await actor.mutateProviderFeature!({
          featureId: "test.feature",
          schemaVersion: 1,
          actionId: "settle",
          arguments: {},
        });
        return result.outcome === "accepted";
      },
    });
    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "interrupt",
        operationId: "stop-with-goal-pause",
      }),
    ).resolves.toEqual({
      status: "accepted",
      operationId: "stop-with-goal-pause",
    });
    expect(subject.actor.interrupt).toHaveBeenCalledTimes(1);
    expect(subject.afterInterruptAccepted).toHaveBeenCalledWith(subject.actor);
    expect(subject.actor.mutateProviderFeature).toHaveBeenCalledWith({
      featureId: "test.feature",
      schemaVersion: 1,
      actionId: "settle",
      arguments: {},
    });
    expect(subject.publishThreadSnapshot).toHaveBeenCalled();
  });

  it("does not fail Stop when backend-owned lifecycle work rejects", async () => {
    const subject = fixture({
      afterInterruptAccepted: async () => {
        throw new Error("feature lifecycle failed");
      },
    });
    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "interrupt",
        operationId: "stop-pause-failure",
      }),
    ).resolves.toEqual({
      status: "accepted",
      operationId: "stop-pause-failure",
    });
    expect(subject.getRecord()?.state).toBe("accepted");
  });

  it("does not let an uncertain retry stop a later active turn", async () => {
    const subject = fixture({
      interrupt: async () => {
        throw new Error("response lost");
      },
    });
    const operation = {
      kind: "interrupt" as const,
      operationId: "stop-operation-2",
    };
    await expect(
      subject.gateway.mutate(scope, "thread-1", operation),
    ).resolves.toEqual({
      status: "recovery_required",
      retryable: true,
    });
    expect(subject.getRecord()?.state).toBe("uncertain");

    subject.setTimeline("running", "turn-2");
    await expect(
      subject.gateway.mutate(scope, "thread-1", operation),
    ).resolves.toEqual({
      status: "accepted",
      operationId: "stop-operation-2",
    });

    expect(subject.actor.interrupt).toHaveBeenCalledTimes(1);
    expect(subject.getRecord()?.state).toBe("accepted");
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
      scope,
      "thread-1",
    );
    expect(subject.publishAuthoritativeReplacement).not.toHaveBeenCalled();
    expect(subject.onAuthoritativeSettled).toHaveBeenCalledWith(
      scope,
      "thread-1",
    );
  });

  it("reconciles an accepted uncertain Stop without repeating it", async () => {
    const subject = fixture({
      interrupt: async () => {
        throw new Error("response lost");
      },
      reconcileInterrupt: async () => ({ outcome: "accepted" }),
    });
    const operation = {
      kind: "interrupt" as const,
      operationId: "accepted-uncertain-stop",
    };

    await expect(
      subject.gateway.mutate(scope, "thread-1", operation),
    ).resolves.toMatchObject({ status: "recovery_required" });
    await expect(
      subject.gateway.mutate(scope, "thread-1", operation),
    ).resolves.toEqual({
      status: "accepted",
      operationId: operation.operationId,
    });

    expect(subject.actor.interrupt).toHaveBeenCalledOnce();
    expect(subject.actor.reconcileInterrupt).toHaveBeenCalledOnce();
  });

  it("retains an unknown Stop without repeating it", async () => {
    const subject = fixture({
      interrupt: async () => {
        throw new Error("response lost");
      },
      reconcileInterrupt: async () => ({ outcome: "unknown" }),
    });
    const operation = {
      kind: "interrupt" as const,
      operationId: "unknown-stop",
    };

    await subject.gateway.mutate(scope, "thread-1", operation);
    await expect(
      subject.gateway.mutate(scope, "thread-1", operation),
    ).resolves.toEqual({
      status: "recovery_required",
      retryable: true,
    });

    expect(subject.actor.interrupt).toHaveBeenCalledOnce();
    expect(subject.getRecord()?.state).toBe("uncertain");
  });

  it("retries a Stop only after the backend proves it was not applied", async () => {
    const interrupt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(undefined);
    const subject = fixture({ interrupt });
    const operation = {
      kind: "interrupt" as const,
      operationId: "not-applied-stop",
    };

    await subject.gateway.mutate(scope, "thread-1", operation);
    await expect(
      subject.gateway.mutate(scope, "thread-1", operation),
    ).resolves.toMatchObject({ status: "accepted" });

    expect(interrupt).toHaveBeenCalledTimes(2);
    expect(subject.actor.reconcileInterrupt).toHaveBeenCalledOnce();
  });

  it("removes a Stop receipt when the backend proves the request was unsent", async () => {
    const subject = fixture({
      interrupt: async () => {
        throw new BackendError({
          category: "unavailable",
          retryable: true,
          crossedSubmissionBoundary: false,
          safeMessage: "The request was not sent.",
        });
      },
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "interrupt",
        operationId: "unsent-stop",
      }),
    ).rejects.toMatchObject({ crossedSubmissionBoundary: false });
    expect(subject.getRecord()).toBeUndefined();
    expect(
      subject.operations.rejectInterruptProvenNotApplied,
    ).toHaveBeenCalledOnce();
  });

  it.each(["waiting_for_approval", "waiting_for_input"] as const)(
    "allows Stop while a turn is %s",
    async (runState) => {
      const subject = fixture({ runState });
      await expect(
        subject.gateway.mutate(scope, "thread-1", {
          kind: "interrupt",
          operationId: `stop-${runState}`,
        }),
      ).resolves.toMatchObject({ status: "accepted" });
    },
  );

  it.each(["disconnected", "reconciling"] as const)(
    "does not infer uncertain Stop acceptance while %s",
    async (runState) => {
      const subject = fixture({
        interrupt: async () => {
          throw new Error("response lost");
        },
        reconcileInterrupt: async () => ({ outcome: "not_applied" }),
      });
      await subject.gateway.mutate(scope, "thread-1", {
        kind: "interrupt",
        operationId: `uncertain-${runState}`,
      });
      subject.setTimeline(runState, "turn-1");

      await expect(
        subject.gateway.recoverThread(scope, "thread-1"),
      ).resolves.toEqual({
        status: "recovery_required",
        retryable: true,
      });
      expect(subject.actor.interrupt).toHaveBeenCalledOnce();
    },
  );

  it("fences unrelated mutations while a Stop outcome is uncertain", async () => {
    const subject = fixture({
      interrupt: async () => {
        throw new Error("response lost");
      },
    });
    await subject.gateway.mutate(scope, "thread-1", {
      kind: "interrupt",
      operationId: "stop-operation-3",
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "perform",
        mutationId: "rename-after-stop",
        expectedThreadRevision: 1,
        operation: { action: "rename", title: "New title" },
      }),
    ).rejects.toMatchObject({ code: "operation_outcome_uncertain" });
  });
});

describe("ThreadMutationGateway draft movement", () => {
  const move = {
    kind: "move_draft" as const,
    workspaceId: "workspace-2",
    expectedThreadRevision: 3,
    mutationId: "move-operation-1",
  };

  it("replays an exact completed move before a later uncertainty barrier", async () => {
    const subject = fixture({
      interrupt: async () => {
        throw new Error("response lost");
      },
      moveReplay: true,
    });
    await subject.gateway.mutate(scope, "thread-1", {
      kind: "interrupt",
      operationId: "uncertain-stop-before-replay",
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", move),
    ).resolves.toEqual({ status: "completed" });
    expect(subject.moveServerDraftWorkspace).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "archived",
      fixtureInput: { inventoryState: "archived" as const },
    },
    {
      name: "unavailable",
      fixtureInput: { threadAvailability: "unavailable" as const },
    },
  ])("rejects a new move for an $name draft", async ({ fixtureInput }) => {
    const subject = fixture(fixtureInput);

    await expect(
      subject.gateway.mutate(scope, "thread-1", move),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(subject.moveServerDraftWorkspace).not.toHaveBeenCalled();
  });
});

describe("ThreadMutationGateway creation recovery", () => {
  it.each(["uncertain", "accepted"] as const)("reconciles an uncertain queue head without a separate operation receipt (%s)", async (state) => {
    const subject = fixture({ uncertainQueuedInput: true, reconciledQueueState: state });
    await expect(subject.gateway.recoverThread(scope, "thread-1")).resolves.toEqual(
      state === "uncertain" ? { status: "recovery_required", retryable: true } : { status: "completed" },
    );
    expect(subject.reconcileUncertain).toHaveBeenCalledWith(scope, "thread-1", "uncertain-head");
    expect(subject.enqueue).not.toHaveBeenCalled();
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(scope, "thread-1");
  });

  it("routes the explicit recovery command through the active first-send lifecycle", async () => {
    const subject = fixture({
      recoverCreation: async () => ({
        status: "bound",
        binding: {},
      }),
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "recover_uncertain",
      }),
    ).resolves.toEqual({ status: "completed" });

    expect(subject.recoverActiveFirstSend).toHaveBeenCalledWith(
      scope,
      "thread-1",
    );
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
      scope,
      "thread-1",
    );
    expect(subject.onThreadChanged).toHaveBeenCalledWith(scope, "thread-1");
  });

  it("discards an unfinished fork and returns why", async () => {
    const discardFork = vi.fn(async (_scope: RequestScope, threadId: string) => ({
      status: "aborted" as const, childThreadId: threadId, diagnostic: "The fork was discarded.", restartable: true }));
    const subject = fixture({ discardFork });
    await expect(subject.gateway.mutate(scope, "thread-1", { kind: "discard_fork" }))
      .resolves.toEqual({ status: "aborted", diagnostic: "The fork was discarded." });
    expect(discardFork).toHaveBeenCalledWith(scope, "thread-1");
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(scope, "thread-1");
    expect(subject.onThreadChanged).toHaveBeenCalledWith(scope, "thread-1");
  });

  it("keeps a still-failing creation recovery actionable", async () => {
    const subject = fixture({
      recoverCreation: async () => ({
        status: "recovery_required",
        retryable: true,
      }),
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "recover_uncertain",
      }),
    ).resolves.toEqual({
      status: "recovery_required",
      retryable: true,
    });
    expect(subject.publishThreadSnapshot).toHaveBeenCalledOnce();
  });
});

describe("ThreadMutationGateway delivery readiness", () => {
  it("rejects unresolved required settings before durable enqueue", async () => {
    const database = {};
    const enqueue = vi.fn();
    const getDraft = vi.fn();
    const release = vi.fn();
    const gateway = new ThreadMutationGateway({
      bindings: {
        database,
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      inventory: {
        assertWorkspaceActive: vi.fn(),
        database,
        getThread: vi.fn(() => ({
          thread: { availability: "available", revision: 7 },
          inventory: { inventoryState: "active" },
        })),
        getDraft,
      } as never,
      lifecycle: {
        hasFirstInputMutation: vi.fn(() => false),
      } as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: {
        enqueue,
        findComposerDeliveryReplay: vi.fn(() => undefined),
      } as never,
      operations: {
        database,
        findUncertainThreadOperation: vi.fn(() => undefined),
        hasPendingMaterializationSteer: vi.fn(() => false),
        findSteer: vi.fn(() => undefined),
      } as never,
      completions: { database } as never,
      queueGateway: {} as never,
      runtimes: {
        acquire: vi.fn(async () => ({
          actor: {
            canEvict: true,
            timeline: { runState: "idle" },
            authoritativelySettled: true,
            backendCapabilities: vi.fn(async () => ({
              deliveryModes: ["submit"],
              steerTarget: null,
            })),
          },
          hub: deliveryHub("submit", false),
          release,
        })),
      } as never,
      interactions: {} as never,
      presentation: {
        read: vi.fn(async () => ({
          revision: "presentation-1",
          backend: { label: { text: "Codex" } },
          interactionMode: "interactive",
          settings: {
            revision: 1,
            values: [
              {
                id: "model",
                desiredValue: null,
                effectiveValue: null,
                applicationState: "confirmation_unknown",
              },
            ],
          },
          settingDescriptors: [
            {
              id: "model",
              label: { text: "Model" },
              requiredForFirstSubmission: true,
              available: true,
              options: [
                {
                  value: "model-1",
                  label: { text: "Model 1" },
                  available: true,
                },
              ],
            },
          ],
          providerFeatureCapabilities: [],
          providerFeatureStates: [],
          composerCommands: [],
        })),
      } as never,
      agentToolPolicies: testThreadAgentToolPolicyRepository(database),
      actionPersistence: new Map(),
      publishThreadSnapshot: vi.fn(async () => undefined),
      now: () => 1_800_000_000_000,
    });

    await expect(
      gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "submit",
        mutationId: "submit-1",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
      message: "Choose the required thread settings before sending.",
    });

    expect(getDraft).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects unresolved required settings before durable active-queue enqueue", async () => {
    const database = {};
    const enqueue = vi.fn();
    const getDraft = vi.fn();
    const release = vi.fn();
    const gateway = new ThreadMutationGateway({
      bindings: {
        database,
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      inventory: {
        assertWorkspaceActive: vi.fn(),
        database,
        getThread: vi.fn(() => ({
          thread: { availability: "available", revision: 7 },
          inventory: { inventoryState: "active" },
        })),
        getDraft,
      } as never,
      lifecycle: {
        hasFirstInputMutation: vi.fn(() => false),
      } as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: {
        enqueue,
        findComposerDeliveryReplay: vi.fn(() => undefined),
      } as never,
      operations: {
        database,
        findUncertainThreadOperation: vi.fn(() => undefined),
        hasPendingMaterializationSteer: vi.fn(() => false),
        findSteer: vi.fn(() => undefined),
      } as never,
      completions: { database } as never,
      queueGateway: {} as never,
      runtimes: {
        acquire: vi.fn(async () => ({
          actor: {
            timeline: { runState: "running" },
            backendCapabilities: vi.fn(async () => ({
              deliveryModes: ["submit"],
              steerTarget: null,
            })),
          },
          hub: deliveryHub(
            "queue",
            false,
            "Choose the required thread settings before sending.",
          ),
          release,
        })),
      } as never,
      interactions: {} as never,
      presentation: {
        read: vi.fn(async () => ({
          revision: "presentation-1",
          backend: { label: { text: "Codex" } },
          interactionMode: "interactive",
          settings: {
            revision: 1,
            values: [
              {
                id: "model",
                desiredValue: null,
                effectiveValue: null,
                applicationState: "confirmation_unknown",
              },
            ],
          },
          settingDescriptors: [
            {
              id: "model",
              label: { text: "Model" },
              requiredForFirstSubmission: true,
              available: true,
              options: [
                {
                  value: "model-1",
                  label: { text: "Model 1" },
                  available: true,
                },
              ],
            },
          ],
          providerFeatureCapabilities: [],
          providerFeatureStates: [],
          composerCommands: [],
        })),
      } as never,
      agentToolPolicies: testThreadAgentToolPolicyRepository(database),
      actionPersistence: new Map(),
      publishThreadSnapshot: vi.fn(async () => undefined),
      now: () => 1_800_000_000_000,
    });

    await expect(
      gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "queue",
        mutationId: "queue-1",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
      message: "Choose the required thread settings before sending.",
    });

    expect(getDraft).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("ThreadMutationGateway incremental publication", () => {
  it.each(["submit", "queue"] as const)(
    "replays an accepted bound %s before consulting the cleared draft or runtime",
    async (mode) => {
      const subject = fixture({
        queuedDeliveryReplay: {
          id: `queued-${mode}`,
          requestedDraftRevision: 2,
          resolvedDeliveryMode: mode,
          createdAt: 1_800_000_000_000,
        },
      });
      subject.getDraft.mockImplementation(() => {
        throw new Error("deleted task left the accepted draft unavailable");
      });

      await expect(
        subject.gateway.mutate(scope, "thread-1", {
          kind: "deliver",
          mode,
          mutationId: `accepted-${mode}`,
          expectedThreadRevision: 4,
          expectedDraftRevision: 2,
        }),
      ).resolves.toEqual({
        status: "delivery_queued",
        queuedInputId: `queued-${mode}`,
        resolvedDeliveryMode: mode,
        threadRevision: 7,
        draft: {
          text: "",
          contextExcerpts: [],
          attachments: [],
          taskReferences: [],
          revision: 3,
          updatedAt: new Date(1_800_000_000_000).toISOString(),
        },
      });
      expect(subject.getDraft).not.toHaveBeenCalled();
      expect(subject.enqueue).not.toHaveBeenCalled();
      expect(subject.findComposerDeliveryReplay).toHaveBeenCalledWith(
        scope,
        "thread-1",
        {
          mutationId: `accepted-${mode}`,
          requestedDeliveryMode: mode,
          expectedThreadRevision: 4,
          expectedDraftRevision: 2,
        },
      );
    },
  );

  it("replays an accepted draft Steer before consulting the cleared draft or runtime", async () => {
    const subject = fixture({
      steerDeliveryReplay: {
        source: "draft",
        threadId: "thread-1",
        mutationId: "accepted-steer",
        applicationOperationId: "accepted-steer",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
        target: { kind: "turn", turnId: "turn-1" },
        state: "accepted",
        createdAt: 1_800_000_000_000,
      },
    });
    subject.getDraft.mockImplementation(() => {
      throw new Error("deleted task left the accepted draft unavailable");
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "steer",
        mutationId: "accepted-steer",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
        steerTarget: { kind: "turn", turnId: "turn-1" },
      }),
    ).resolves.toEqual({
      status: "delivery_accepted",
      operationId: "accepted-steer",
      resolvedDeliveryMode: "steer",
      threadRevision: 7,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 3,
        updatedAt: new Date(1_800_000_000_000).toISOString(),
      },
    });
    expect(subject.getDraft).not.toHaveBeenCalled();
    expect(subject.enqueue).not.toHaveBeenCalled();
  });

  it("rejects a Steer mutation replayed with another delivery mode", async () => {
    const subject = fixture({
      steerDeliveryReplay: {
        source: "draft",
        threadId: "thread-1",
        mutationId: "accepted-steer",
        applicationOperationId: "accepted-steer",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
        state: "accepted",
        createdAt: 1_800_000_000_000,
      },
    });
    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "submit",
        mutationId: "accepted-steer",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(subject.getDraft).not.toHaveBeenCalled();
  });

  it("returns the authoritative cleared draft when first-send recovery is required", async () => {
    const subject = fixture({
      backingState: "unbound",
      startFirstSend: async () => ({
        status: "recovery_required",
        retryable: false,
      }),
      draft: {
        revision: 3,
        text: "",
        selectedSkillId: null,
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        updatedAt: 1_800_000_000_100,
      },
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "submit",
        mutationId: "first-send-recovery-1",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).resolves.toEqual({
      status: "recovery_required",
      retryable: false,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 3,
        updatedAt: new Date(1_800_000_000_100).toISOString(),
      },
    });
  });

  it("returns first-send acceptance while its owned publication is pending", async () => {
    const publication = deferred<void>();
    const subject = fixture({
      backingState: "unbound",
      startFirstSend: async () => ({ status: "bound", binding: {} }),
      publishThreadSnapshot: () => publication.promise,
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "submit",
        mutationId: "first-send-1",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).resolves.toEqual({
      status: "delivery_accepted",
      operationId: "first-send-1",
      resolvedDeliveryMode: "submit",
      threadRevision: 7,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 3,
        updatedAt: new Date(1_800_000_000_000).toISOString(),
      },
    });
    expect(subject.publishThreadSnapshot).toHaveBeenCalledOnce();

    let closeSettled = false;
    const closing = subject.gateway.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    publication.resolve();
    await closing;
    expect(subject.onThreadChanged).toHaveBeenCalledWith(scope, "thread-1");
  });

  it("publishes a semantic application change after a bound submit enqueue", async () => {
    const database = {};
    const publishThreadSnapshot = vi.fn(async () => undefined);
    const publishAuthoritativeReplacement = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => ({
      item: {
        id: "queued-1",
        resolvedDeliveryMode: "submit" as const,
        createdAt: 1_800_000_000_000,
      },
    }));
    const presentationRead = vi.fn(() => {
      throw new Error("delivery must not read presentation");
    });
    const gateway = new ThreadMutationGateway({
      bindings: {
        database,
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      inventory: {
        assertWorkspaceActive: vi.fn(),
        database,
        getThread: vi.fn(() => ({
          thread: { availability: "available", revision: 7 },
          inventory: { inventoryState: "active" },
        })),
        getDraft: vi.fn(() => ({
          revision: 2,
          text: "",
          selectedSkillId: "opaque-skill-1",
          contextExcerpts: [],
          attachments: [],
        })),
      } as never,
      lifecycle: {
        hasFirstInputMutation: vi.fn(() => false),
      } as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: {
        enqueue,
        findComposerDeliveryReplay: vi.fn(() => undefined),
      } as never,
      operations: {
        database,
        findUncertainThreadOperation: vi.fn(() => undefined),
        hasPendingMaterializationSteer: vi.fn(() => false),
        findSteer: vi.fn(() => undefined),
      } as never,
      completions: { database } as never,
      queueGateway: {} as never,
      runtimes: {
        acquire: vi.fn(async () => ({
          actor: {
            canEvict: true,
            timeline: { runState: "idle" },
            authoritativelySettled: true,
            backendCapabilities: vi.fn(async () => ({
              deliveryModes: ["submit"],
              steerTarget: null,
            })),
          },
          hub: deliveryHub("submit", true),
          publishAuthoritativeReplacement,
          release: vi.fn(),
        })),
        quiet: vi.fn(() => ({
          hub: { snapshot: { runState: "idle" } },
          generation: "application-1",
          publishIfUnowned: vi.fn(() => undefined),
          release: vi.fn(),
        })),
      } as never,
      interactions: {} as never,
      presentation: { read: presentationRead } as never,
      agentToolPolicies: testThreadAgentToolPolicyRepository(database),
      actionPersistence: new Map(),
      publishThreadSnapshot,
      now: () => 1_800_000_000_000,
    });

    await expect(
      gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "submit",
        mutationId: "submit-1",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).resolves.toEqual({
      status: "delivery_queued",
      queuedInputId: "queued-1",
      resolvedDeliveryMode: "submit",
      threadRevision: 7,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 3,
        updatedAt: new Date(1_800_000_000_000).toISOString(),
      },
    });

    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      scope,
      "thread-1",
      expect.objectContaining({ selectedSkillId: "opaque-skill-1" }),
    );
    expect(presentationRead).not.toHaveBeenCalled();
    expect(publishThreadSnapshot).toHaveBeenCalledWith(scope, "thread-1");
    expect(publishAuthoritativeReplacement).not.toHaveBeenCalled();
  });

  it("admits Queue behind a queued-input Steer awaiting provider materialization", async () => {
    const subject = fixture({
      runState: "running",
      deliveryMode: "queue",
      pendingMaterializationSteerSource: "queued_input",
    });
    subject.enqueue.mockResolvedValueOnce({
      item: {
        id: "agent-queued-input",
        mutationId: "queue-behind-pending-steer",
        resolvedDeliveryMode: "queue",
        createdAt: 1_800_000_000_000,
      },
      replayed: false,
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "queue",
        mutationId: "queue-behind-pending-steer",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).resolves.toMatchObject({
      status: "delivery_queued",
      queuedInputId: "agent-queued-input",
    });
    expect(subject.enqueue).toHaveBeenCalledOnce();
  });

  it("retains the legacy draft barrier while a draft-source Pi Steer awaits materialization", async () => {
    const subject = fixture({
      runState: "running",
      deliveryMode: "queue",
      pendingMaterializationSteerSource: "draft",
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "queue",
        mutationId: "queue-behind-draft-steer",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).rejects.toThrow("Wait for the previous steering input to appear");
    expect(subject.enqueue).not.toHaveBeenCalled();
  });

  it("returns the queued receipt before post-enqueue publication settles", async () => {
    const database = {};
    let releasePublication!: () => void;
    const publishThreadSnapshot = vi.fn(
      () =>
        new Promise<undefined>((resolve) => {
          releasePublication = () => resolve(undefined);
        }),
    );
    const enqueue = vi.fn(async () => ({
      item: {
        id: "queued-1",
        resolvedDeliveryMode: "submit" as const,
        createdAt: 1_800_000_000_000,
      },
    }));
    const gateway = new ThreadMutationGateway({
      bindings: {
        database,
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      inventory: {
        assertWorkspaceActive: vi.fn(),
        database,
        getThread: vi.fn(() => ({
          thread: { availability: "available", revision: 7 },
          inventory: { inventoryState: "active" },
        })),
        getDraft: vi.fn(() => ({
          revision: 2,
          text: "Hello",
          selectedSkillId: null,
          contextExcerpts: [],
          attachments: [],
        })),
      } as never,
      lifecycle: {
        hasFirstInputMutation: vi.fn(() => false),
      } as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: {
        enqueue,
        findComposerDeliveryReplay: vi.fn(() => undefined),
      } as never,
      operations: {
        database,
        findUncertainThreadOperation: vi.fn(() => undefined),
        hasPendingMaterializationSteer: vi.fn(() => false),
        findSteer: vi.fn(() => undefined),
      } as never,
      completions: { database } as never,
      queueGateway: {} as never,
      runtimes: {
        acquire: vi.fn(async () => ({
          actor: {
            canEvict: true,
            timeline: { runState: "idle" },
            authoritativelySettled: true,
            backendCapabilities: vi.fn(async () => ({
              deliveryModes: ["submit"],
              steerTarget: null,
            })),
          },
          hub: deliveryHub("submit", true),
          publishAuthoritativeReplacement: vi.fn(async () => undefined),
          release: vi.fn(),
        })),
        quiet: vi.fn(() => ({
          hub: { snapshot: { runState: "idle" } },
          generation: "application-1",
          publishIfUnowned: vi.fn(() => undefined),
          release: vi.fn(),
        })),
      } as never,
      interactions: {} as never,
      presentation: {
        read: vi.fn(async () => ({
          settings: { values: [] },
          settingDescriptors: [],
          skills: [],
        })),
      } as never,
      agentToolPolicies: testThreadAgentToolPolicyRepository(database),
      actionPersistence: new Map(),
      publishThreadSnapshot,
      now: () => 1_800_000_000_000,
    });

    // Publication is still in flight, but the durable receipt resolves
    // immediately while close retains ownership of the continuation.
    await expect(
      gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "submit",
        mutationId: "submit-1",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).resolves.toEqual({
      status: "delivery_queued",
      queuedInputId: "queued-1",
      resolvedDeliveryMode: "submit",
      threadRevision: 7,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 3,
        updatedAt: new Date(1_800_000_000_000).toISOString(),
      },
    });
    expect(publishThreadSnapshot).toHaveBeenCalledWith(scope, "thread-1");
    let closeSettled = false;
    const closing = gateway.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);
    releasePublication();
    await closing;
    expect(closeSettled).toBe(true);
  });

  it("returns the queued receipt when post-enqueue publication fails", async () => {
    const database = {};
    const publicationFailure = new Error("The Codex daemon is unavailable.");
    const publishThreadSnapshot = vi.fn(async () => {
      throw publicationFailure;
    });
    const onPublicationError = vi.fn();
    const onThreadChanged = vi.fn();
    const enqueue = vi.fn(async () => ({
      item: {
        id: "queued-1",
        resolvedDeliveryMode: "submit" as const,
        createdAt: 1_800_000_000_000,
      },
    }));
    const gateway = new ThreadMutationGateway({
      bindings: {
        database,
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      inventory: {
        assertWorkspaceActive: vi.fn(),
        database,
        getThread: vi.fn(() => ({
          thread: { availability: "available", revision: 7 },
          inventory: { inventoryState: "active" },
        })),
        getDraft: vi.fn(() => ({
          revision: 2,
          text: "Hello",
          selectedSkillId: null,
          contextExcerpts: [],
          attachments: [],
        })),
      } as never,
      lifecycle: {
        hasFirstInputMutation: vi.fn(() => false),
      } as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: {
        enqueue,
        findComposerDeliveryReplay: vi.fn(() => undefined),
      } as never,
      operations: {
        database,
        findUncertainThreadOperation: vi.fn(() => undefined),
        hasPendingMaterializationSteer: vi.fn(() => false),
        findSteer: vi.fn(() => undefined),
      } as never,
      completions: { database } as never,
      queueGateway: {} as never,
      runtimes: {
        acquire: vi.fn(async () => ({
          actor: {
            canEvict: true,
            timeline: { runState: "idle" },
            authoritativelySettled: true,
            backendCapabilities: vi.fn(async () => ({
              deliveryModes: ["submit"],
              steerTarget: null,
            })),
          },
          hub: deliveryHub("submit", true),
          release: vi.fn(),
        })),
        quiet: vi.fn(() => ({
          hub: { snapshot: { runState: "idle" } },
          generation: "application-1",
          publishIfUnowned: vi.fn(() => undefined),
          release: vi.fn(),
        })),
      } as never,
      interactions: {} as never,
      presentation: {
        read: vi.fn(async () => ({
          settings: { values: [] },
          settingDescriptors: [],
          skills: [],
        })),
      } as never,
      agentToolPolicies: testThreadAgentToolPolicyRepository(database),
      actionPersistence: new Map(),
      publishThreadSnapshot,
      onPublicationError,
      onThreadChanged,
      now: () => 1_800_000_000_000,
    });

    await expect(
      gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "submit",
        mutationId: "submit-1",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).resolves.toEqual({
      status: "delivery_queued",
      queuedInputId: "queued-1",
      resolvedDeliveryMode: "submit",
      threadRevision: 7,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 3,
        updatedAt: new Date(1_800_000_000_000).toISOString(),
      },
    });

    expect(enqueue).toHaveBeenCalledOnce();
    // Close drains the rejected background publication and does not return
    // until its failure has reached the diagnostic observer.
    await gateway.close();
    expect(onPublicationError).toHaveBeenCalledWith(publicationFailure);
    expect(onThreadChanged).not.toHaveBeenCalled();
  });

  it("publishes the lightweight post-deliver overlay without waiting for turn settlement", async () => {
    const database = {};
    const publishThreadSnapshot = vi.fn(async () => undefined);
    const onThreadChanged = vi.fn(async () => undefined);
    const onPublicationError = vi.fn();
    const enqueue = vi.fn(async () => ({
      item: {
        id: "queued-1",
        resolvedDeliveryMode: "submit" as const,
        createdAt: 1_800_000_000_000,
      },
    }));
    const gateway = new ThreadMutationGateway({
      bindings: {
        database,
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      inventory: {
        assertWorkspaceActive: vi.fn(),
        database,
        getThread: vi.fn(() => ({
          thread: { availability: "available", revision: 7 },
          inventory: { inventoryState: "active" },
        })),
        getDraft: vi.fn(() => ({
          revision: 2,
          text: "Hello",
          selectedSkillId: null,
          contextExcerpts: [],
          attachments: [],
        })),
      } as never,
      lifecycle: {
        hasFirstInputMutation: vi.fn(() => false),
      } as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: {
        enqueue,
        findComposerDeliveryReplay: vi.fn(() => undefined),
      } as never,
      operations: {
        database,
        findUncertainThreadOperation: vi.fn(() => undefined),
        hasPendingMaterializationSteer: vi.fn(() => false),
        findSteer: vi.fn(() => undefined),
      } as never,
      completions: { database } as never,
      queueGateway: {} as never,
      runtimes: {
        acquire: vi.fn(async () => ({
          actor: {
            canEvict: true,
            timeline: { runState: "idle" },
            authoritativelySettled: true,
            backendCapabilities: vi.fn(async () => ({
              deliveryModes: ["submit"],
              steerTarget: null,
            })),
          },
          hub: deliveryHub("submit", true),
          release: vi.fn(),
        })),
      } as never,
      interactions: {} as never,
      presentation: {
        read: vi.fn(async () => ({
          settings: { values: [] },
          settingDescriptors: [],
          skills: [],
        })),
      } as never,
      agentToolPolicies: testThreadAgentToolPolicyRepository(database),
      actionPersistence: new Map(),
      publishThreadSnapshot,
      onThreadChanged,
      now: () => 1_800_000_000_000,
    });

    await expect(
      gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "submit",
        mutationId: "submit-1",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).resolves.toEqual({
      status: "delivery_queued",
      queuedInputId: "queued-1",
      resolvedDeliveryMode: "submit",
      threadRevision: 7,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 3,
        updatedAt: new Date(1_800_000_000_000).toISOString(),
      },
    });
    await vi.waitFor(() => {
      expect(publishThreadSnapshot).toHaveBeenCalledWith(scope, "thread-1");
    });
    await vi.waitFor(() => {
      expect(onThreadChanged).toHaveBeenCalledWith(scope, "thread-1");
    });
    expect(onPublicationError).not.toHaveBeenCalled();
    expect(publishThreadSnapshot).toHaveBeenCalledOnce();
  });

  it("durably admits Steer before provider delivery and publishes the queue", async () => {
    const database = {
      transaction<T>(operation: () => T) {
        return () => operation();
      },
    };
    const receipt = {
      source: "draft" as const,
      mutationId: "steer-1",
      applicationOperationId: "steer-1",
      reconciliationToken: "steer-1",
      target: { kind: "turn", turnId: "turn-1" },
      selectedSkillId: "opaque-skill-1",
      contextExcerpts: [],
      attachments: [],
      expectedDraftRevision: 2,
      state: "prepared" as const,
    };
    const publication = deferred<void>();
    const publishThreadSnapshot = vi.fn(() => publication.promise);
    const publishAuthoritativeReplacement = vi.fn(async () => undefined);
    const release = vi.fn();
    const onThreadChanged = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => ({
      item: {
        id: "queued-steer-1",
        resolvedDeliveryMode: "steer" as const,
        createdAt: 1_800_000_000_000,
      },
    }));
    const actor = {
      timeline: { runState: "running" as const, activeTurnId: "turn-1" },
      materializeAttachments: vi.fn(async () => ({
        attachments: [],
        canonicalBytes: {
          read: async () => {
            throw new Error("unexpected_canonical_attachment_read");
          },
        },
        canonicalEvidence: { resolve: () => [] },
      })),
      steer: vi.fn(async () => ({
        status: "accepted" as const,
        reconciliationToken: "steer-1",
        completionCorrelation: "steer-1",
        backendTurnId: "turn-1",
      })),
      replayAuthoritativeCompletions: vi.fn(async () => undefined),
    };
    const gateway = new ThreadMutationGateway({
      bindings: {
        database,
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      inventory: {
        assertWorkspaceActive: vi.fn(),
        database,
        getThread: vi.fn(() => ({
          thread: { availability: "available", revision: 7 },
          inventory: { inventoryState: "active" },
        })),
        getDraft: vi.fn(() => ({
          revision: 2,
          text: "",
          selectedSkillId: "opaque-skill-1",
          contextExcerpts: [],
          attachments: [],
        })),
      } as never,
      lifecycle: { hasFirstInputMutation: vi.fn(() => false) } as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: {
        findComposerDeliveryReplay: vi.fn(() => undefined),
        enqueue,
      } as never,
      operations: {
        database,
        findUncertainThreadOperation: vi.fn(() => undefined),
        hasPendingMaterializationSteer: vi.fn(() => false),
        findSteer: vi.fn(() => undefined),
        prepareSteer: vi.fn(() => receipt),
        markSteerSubmissionStarted: vi.fn(() => receipt),
        acceptSteer: vi.fn(),
      } as never,
      completions: {
        database,
        recordAccepted: vi.fn(),
      } as never,
      queueGateway: {} as never,
      runtimes: {
        acquire: vi.fn(async () => ({
          actor,
          hub: deliveryHub("steer", true),
          publishAuthoritativeReplacement,
          release,
        })),
      } as never,
      interactions: {} as never,
      presentation: {} as never,
      agentToolPolicies: testThreadAgentToolPolicyRepository(database),
      actionPersistence: new Map(),
      publishThreadSnapshot,
      onThreadChanged,
      now: () => 1_800_000_000_000,
    });

    await expect(
      gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "steer",
        mutationId: "steer-1",
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
        steerTarget: { kind: "turn", turnId: "turn-1" },
      }),
    ).resolves.toEqual({
      status: "delivery_queued",
      queuedInputId: "queued-steer-1",
      resolvedDeliveryMode: "steer",
      threadRevision: 7,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 3,
        updatedAt: new Date(1_800_000_000_000).toISOString(),
      },
    });

    expect(actor.steer).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      scope,
      "thread-1",
      expect.objectContaining({
        mutationId: "steer-1",
        source: expect.objectContaining({
          requestedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "turn", turnId: "turn-1" },
        }),
      }),
    );
    await vi.waitFor(() =>
      expect(publishThreadSnapshot).toHaveBeenCalledWith(scope, "thread-1"),
    );
    expect(actor.replayAuthoritativeCompletions).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(publishAuthoritativeReplacement).not.toHaveBeenCalled();

    publication.resolve();
    await gateway.close();
    expect(onThreadChanged).toHaveBeenCalledWith(scope, "thread-1");
  });

  it("admits an observed Steer target that settled before server admission", async () => {
    const subject = fixture({
      runState: "idle",
      deliveryMode: "submit",
    });
    subject.enqueue.mockResolvedValueOnce({
      item: {
        id: "settled-steer-queue",
        mutationId: "settled-steer",
        resolvedDeliveryMode: "submit",
        createdAt: 1_800_000_000_000,
      },
      replayed: false,
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "steer",
        mutationId: "settled-steer",
        expectedThreadRevision: 7,
        expectedDraftRevision: 2,
        steerTarget: { kind: "turn", turnId: "turn-1" },
      }),
    ).resolves.toMatchObject({
      status: "delivery_queued",
      queuedInputId: "settled-steer-queue",
      resolvedDeliveryMode: "submit",
    });
    expect(subject.enqueue).toHaveBeenCalledWith(
      scope,
      "thread-1",
      expect.objectContaining({
        mutationId: "settled-steer",
        source: expect.objectContaining({
          requestedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "turn", turnId: "turn-1" },
          resolvedDeliveryMode: "submit",
        }),
      }),
    );
  });

  it.each(["turn", "conversation"] as const)(
    "queues an observed %s Steer when the descriptor disappears before admission",
    async (kind) => {
      const subject = fixture({ runState: "running", deliveryMode: "steer", steerTargetKind: kind });
      const runtime = await subject.acquireRuntime();
      runtime.hub.snapshot.capabilities.deliveryModes = runtime.hub.snapshot.capabilities.deliveryModes.filter(({ id }) => id !== "steer");
      subject.acquireRuntime.mockResolvedValue(runtime);
      const steerTarget = kind === "turn" ? { kind, turnId: "turn-1" } : { kind };
      await expect(subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver", mode: "steer", mutationId: "lost-steer-capability",
        expectedThreadRevision: 7, expectedDraftRevision: 2, steerTarget,
      })).resolves.toMatchObject({ resolvedDeliveryMode: "queue" });
      expect(subject.enqueue).toHaveBeenCalledWith(scope, "thread-1", expect.objectContaining({
        source: expect.objectContaining({ requestedDeliveryMode: "steer", requestedSteerTarget: steerTarget, resolvedDeliveryMode: "queue" }),
      }));
    },
  );

  it.each(["turn", "conversation"] as const)(
    "rejects a genuinely wrong target for an advertised %s Steer",
    async (kind) => {
      const subject = fixture({ runState: "running", deliveryMode: "steer", steerTargetKind: kind });
      await expect(subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver", mode: "steer", mutationId: "wrong-steer-target",
        expectedThreadRevision: 7, expectedDraftRevision: 2,
        steerTarget: kind === "turn" ? { kind: "conversation" } : { kind: "turn", turnId: "turn-1" },
      })).rejects.toThrow("The requested steering target is not supported by this backend.");
      expect(subject.enqueue).not.toHaveBeenCalled();
    },
  );

  it("preserves the observed Steer target when another turn is now active", async () => {
    const subject = fixture({
      runState: "running",
      activeTurnId: "turn-2",
      deliveryMode: "steer",
    });
    subject.enqueue.mockResolvedValueOnce({
      item: {
        id: "displaced-steer-queue",
        mutationId: "displaced-steer",
        resolvedDeliveryMode: "queue",
        createdAt: 1_800_000_000_000,
      },
      replayed: false,
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "steer",
        mutationId: "displaced-steer",
        expectedThreadRevision: 7,
        expectedDraftRevision: 2,
        steerTarget: { kind: "turn", turnId: "turn-1" },
      }),
    ).resolves.toMatchObject({
      resolvedDeliveryMode: "queue",
    });

    expect(subject.enqueue).toHaveBeenCalledWith(
      scope,
      "thread-1",
      expect.objectContaining({
        source: expect.objectContaining({
          requestedDeliveryMode: "steer",
          requestedSteerTarget: { kind: "turn", turnId: "turn-1" },
          resolvedDeliveryMode: "queue",
        }),
      }),
    );
  });

  it.each(["submit", "steer"] as const)("routes active %s to native conversation steering", async (mode) => {
    const subject = fixture({ runState: "running", deliveryMode: "steer", steerTargetKind: "conversation" });
    await expect(subject.gateway.mutate(scope, "thread-1", {
      kind: "deliver", mode, mutationId: `conversation-${mode}`, expectedThreadRevision: 7,
      expectedDraftRevision: 2, ...(mode === "steer" ? { steerTarget: { kind: "conversation" as const } } : {}),
    })).resolves.toMatchObject({ status: "delivery_queued", resolvedDeliveryMode: "steer" });
    expect(subject.enqueue).toHaveBeenCalledWith(scope, "thread-1", expect.objectContaining({
      source: expect.objectContaining({ requestedDeliveryMode: mode, resolvedDeliveryMode: "steer", resolvedSteerTarget: { kind: "conversation" } }),
    }));
  });

  it("resolves Send against the active server turn without client retargeting", async () => {
    const subject = fixture({
      runState: "running",
      activeTurnId: "turn-at-admission",
      deliveryMode: "steer",
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "submit",
        mutationId: "send-became-steer",
        expectedThreadRevision: 7,
        expectedDraftRevision: 2,
      }),
    ).resolves.toMatchObject({
      status: "delivery_queued",
      resolvedDeliveryMode: "steer",
    });
    expect(subject.enqueue).toHaveBeenCalledWith(
      scope,
      "thread-1",
      expect.objectContaining({
        source: expect.objectContaining({
          requestedDeliveryMode: "submit",
          resolvedDeliveryMode: "steer",
          resolvedSteerTarget: { kind: "turn", turnId: "turn-at-admission" },
        }),
      }),
    );
  });

  it("returns the durable resolution when a concurrent admission replays the queue row", async () => {
    const subject = fixture({
      runState: "running",
      activeTurnId: "turn-at-admission",
      deliveryMode: "steer",
    });
    subject.enqueue.mockResolvedValueOnce({
      item: {
        id: "concurrent-delivery",
        mutationId: "concurrent-delivery",
        resolvedDeliveryMode: "queue",
        createdAt: 1_800_000_000_000,
      },
      replayed: true,
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "submit",
        mutationId: "concurrent-delivery",
        expectedThreadRevision: 7,
        expectedDraftRevision: 2,
      }),
    ).resolves.toMatchObject({
      status: "delivery_queued",
      resolvedDeliveryMode: "queue",
    });
  });

  it.each(["starting", "stopping", "disconnected", "reconciling"] as const)(
    "fails delivery closed while the runtime is %s",
    async (runState) => {
      const subject = fixture({
        runState,
        deliveryMode: "queue",
      });

      await expect(
        subject.gateway.mutate(scope, "thread-1", {
          kind: "deliver",
          mode: "queue",
          mutationId: `delivery-${runState}`,
          expectedThreadRevision: 7,
          expectedDraftRevision: 2,
        }),
      ).rejects.toMatchObject({ code: "invalid_transition" });
      expect(subject.enqueue).not.toHaveBeenCalled();
    },
  );

  it("clears the draft after durable Steer admission without waiting for Pi materialization", async () => {
    const database = {
      transaction<T>(operation: () => T) {
        return () => operation();
      },
    };
    let state: "prepared" | "uncertain" | "pending_materialization" =
      "prepared";
    const receipt = () => ({
      source: "draft" as const,
      threadId: "thread-1",
      mutationId: "pending-steer-1",
      applicationOperationId: "pending-steer-1",
      reconciliationToken: "pending-steer-1",
      target: state === "prepared" ? null : { kind: "turn", turnId: "turn-1" },
      selectedSkillId: null,
      contextExcerpts: [],
      attachments: [],
      expectedDraftRevision: 2,
      expectedThreadRevision: 4,
      state,
      createdAt: 1_800_000_000_000,
    });
    const retainedDraft = {
      revision: 2,
      text: "Change course",
      selectedSkillId: null,
      contextExcerpts: [],
      attachments: [],
      updatedAt: 1_800_000_000_100,
    };
    const acceptSteer = vi.fn();
    const recordAccepted = vi.fn();
    const publicationFailure = new Error("snapshot unavailable");
    const publishThreadSnapshot = vi.fn(async () => {
      throw publicationFailure;
    });
    const onPublicationError = vi.fn();
    const onThreadChanged = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => ({
      item: {
        id: "queued-pending-steer-1",
        resolvedDeliveryMode: "steer" as const,
        createdAt: 1_800_000_000_000,
      },
    }));
    const actor = {
      timeline: { runState: "running" as const, activeTurnId: "turn-1" },
      materializeAttachments: vi.fn(async () => ({
        attachments: [],
        canonicalBytes: {
          read: async () => {
            throw new Error("unexpected_canonical_attachment_read");
          },
        },
        canonicalEvidence: { resolve: () => [] },
      })),
      steer: vi.fn(async () => ({
        status: "pending_materialization" as const,
        reconciliationToken: "pending-steer-1",
        completionCorrelation: "pending-steer-1",
        backendTurnId: "turn-1",
      })),
    };
    const acquire = vi.fn(async () => ({
      actor,
      hub: deliveryHub("steer", true),
      release: vi.fn(),
    }));
    const gateway = new ThreadMutationGateway({
      bindings: {
        database,
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      inventory: {
        assertWorkspaceActive: vi.fn(),
        database,
        getThread: vi.fn(() => ({
          thread: { availability: "available", revision: 5 },
          inventory: { inventoryState: "active" },
        })),
        getDraft: vi.fn(() => retainedDraft),
      } as never,
      lifecycle: { hasFirstInputMutation: vi.fn(() => false) } as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: {
        findComposerDeliveryReplay: vi.fn(() => undefined),
        enqueue,
      } as never,
      operations: {
        database,
        findUncertainThreadOperation: vi.fn(() => undefined),
        hasPendingMaterializationSteer: vi.fn(() => false),
        findSteer: vi.fn(() => undefined),
        prepareSteer: vi.fn(() => receipt()),
        markSteerSubmissionStarted: vi.fn(() => {
          state = "uncertain";
          return receipt();
        }),
        markSteerPendingMaterialization: vi.fn(() => {
          state = "pending_materialization";
          return receipt();
        }),
        acceptSteer,
      } as never,
      completions: { database, recordAccepted } as never,
      queueGateway: {} as never,
      runtimes: { acquire } as never,
      interactions: {} as never,
      presentation: {} as never,
      agentToolPolicies: testThreadAgentToolPolicyRepository(database),
      actionPersistence: new Map(),
      publishThreadSnapshot,
      onPublicationError,
      onThreadChanged,
      now: () => 1_800_000_000_000,
    });
    const operation = {
      kind: "deliver" as const,
      mode: "steer" as const,
      mutationId: "pending-steer-1",
      expectedThreadRevision: 4,
      expectedDraftRevision: 2,
      steerTarget: { kind: "turn" as const, turnId: "turn-1" },
    };

    await expect(gateway.mutate(scope, "thread-1", operation)).resolves.toEqual(
      {
        status: "delivery_queued",
        queuedInputId: "queued-pending-steer-1",
        resolvedDeliveryMode: "steer",
        threadRevision: 5,
        draft: {
          text: "",
          contextExcerpts: [],
          attachments: [],
          taskReferences: [],
          revision: retainedDraft.revision + 1,
          updatedAt: new Date(1_800_000_000_000).toISOString(),
        },
      },
    );
    expect(actor.steer).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(acceptSteer).not.toHaveBeenCalled();
    expect(recordAccepted).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(publishThreadSnapshot).toHaveBeenCalledOnce();
      expect(onPublicationError).toHaveBeenCalledWith(publicationFailure);
    });
    expect(onThreadChanged).not.toHaveBeenCalled();
  });

  it("does not admit a durable Steer when runtime acquisition fails", async () => {
    const database = {
      transaction<T>(operation: () => T) {
        return () => operation();
      },
    };
    const receipt = {
      source: "draft" as const,
      threadId: "thread-1",
      mutationId: "prepared-steer-acquire-failure",
      applicationOperationId: "prepared-steer-acquire-failure",
      reconciliationToken: "prepared-steer-acquire-failure",
      target: null,
      selectedSkillId: null,
      contextExcerpts: [],
      attachments: [],
      expectedDraftRevision: 2,
      expectedThreadRevision: 4,
      state: "prepared" as const,
      createdAt: 1_800_000_000_000,
    };
    const rejectSteerBeforeAcceptance = vi.fn();
    const acquireFailure = new Error("runtime unavailable");
    const gateway = new ThreadMutationGateway({
      bindings: {
        database,
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      inventory: {
        assertWorkspaceActive: vi.fn(),
        database,
        getThread: vi.fn(() => ({
          thread: { availability: "available", revision: 4 },
          inventory: { inventoryState: "active" },
        })),
        getDraft: vi.fn(() => ({
          revision: 2,
          text: "Change course",
          selectedSkillId: null,
          contextExcerpts: [],
          attachments: [],
          updatedAt: 1_800_000_000_000,
        })),
      } as never,
      lifecycle: { hasFirstInputMutation: vi.fn(() => false) } as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: { findComposerDeliveryReplay: vi.fn(() => undefined) } as never,
      operations: {
        database,
        findUncertainThreadOperation: vi.fn(() => undefined),
        hasPendingMaterializationSteer: vi.fn(() => false),
        findSteer: vi.fn(() => undefined),
        prepareSteer: vi.fn(() => receipt),
        rejectSteerBeforeAcceptance,
      } as never,
      completions: { database } as never,
      queueGateway: {} as never,
      runtimes: {
        acquire: vi.fn(async () => {
          throw acquireFailure;
        }),
      } as never,
      interactions: {} as never,
      presentation: {} as never,
      agentToolPolicies: testThreadAgentToolPolicyRepository(database),
      actionPersistence: new Map(),
      publishThreadSnapshot: vi.fn(async () => undefined),
      onThreadChanged: vi.fn(async () => undefined),
      now: () => 1_800_000_000_000,
    });

    await expect(
      gateway.mutate(scope, "thread-1", {
        kind: "deliver",
        mode: "steer",
        mutationId: receipt.mutationId,
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
        steerTarget: { kind: "turn", turnId: "turn-1" },
      }),
    ).rejects.toBe(acquireFailure);
    expect(rejectSteerBeforeAcceptance).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "admits behind an uncertain queue-owned Steer",
      priorSource: "queued_input" as const,
      admitted: true,
    },
    {
      name: "retains the barrier behind an uncertain legacy draft Steer",
      priorSource: "draft" as const,
      admitted: false,
    },
  ])("$name", async ({ priorSource, admitted }) => {
    const database = {
      transaction<T>(operation: () => T) {
        return () => operation();
      },
    };
    const receipt = {
      mutationId: "steer-uncertain",
      applicationOperationId: "steer-uncertain",
      reconciliationToken: "steer-uncertain",
      expectedThreadRevision: 4,
      expectedDraftRevision: 2,
      source: "draft" as const,
      selectedSkillId: null,
      contextExcerpts: [],
      attachments: [],
      target: { kind: "turn", turnId: "turn-1" },
      state: "prepared" as const,
      createdAt: 1_800_000_000_000,
      threadId: "thread-1",
    };
    const retainedDraft = {
      revision: 2,
      text: "Change course",
      selectedSkillId: null,
      contextExcerpts: [],
      attachments: [],
      updatedAt: 1_800_000_000_100,
    };
    const enqueue = vi.fn(async () => ({
      item: {
        id: "queued-steer-uncertain",
        resolvedDeliveryMode: "steer" as const,
        createdAt: 1_800_000_000_000,
      },
    }));
    const gateway = new ThreadMutationGateway({
      bindings: {
        database,
        getTarget: vi.fn(() => ({ backingState: "bound" })),
      } as never,
      inventory: {
        assertWorkspaceActive: vi.fn(),
        database,
        getThread: vi.fn(() => ({
          thread: { availability: "available", revision: 7 },
          inventory: { inventoryState: "active" },
        })),
        getDraft: vi.fn(() => retainedDraft),
      } as never,
      lifecycle: { hasFirstInputMutation: vi.fn(() => false) } as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: {
        findComposerDeliveryReplay: vi.fn(() => undefined),
        enqueue,
      } as never,
      operations: {
        database,
        findUncertainThreadOperation: vi.fn(() => ({
          threadId: "thread-1",
          mutationId: "prior-steer",
          operationKind: "conversation_steer",
        })),
        hasPendingMaterializationSteer: vi.fn(() => false),
        findSteer: vi.fn((_scope: RequestScope, mutationId: string) =>
          mutationId === "prior-steer" ? { source: priorSource } : undefined,
        ),
        prepareSteer: vi.fn(() => receipt),
        markSteerSubmissionStarted: vi.fn(() => receipt),
      } as never,
      completions: { database } as never,
      queueGateway: {} as never,
      runtimes: {
        acquire: vi.fn(async () => ({
          actor: {
            timeline: {
              runState: "running" as const,
              activeTurnId: "turn-1",
            },
            materializeAttachments: vi.fn(async () => ({
              attachments: [],
              canonicalBytes: {
                read: async () => {
                  throw new Error("unexpected_canonical_attachment_read");
                },
              },
              canonicalEvidence: { resolve: () => [] },
            })),
            steer: vi.fn(async () => {
              throw new Error("provider response lost");
            }),
          },
          hub: deliveryHub("steer", true),
          release: vi.fn(),
        })),
      } as never,
      interactions: {} as never,
      presentation: {} as never,
      agentToolPolicies: testThreadAgentToolPolicyRepository(database),
      actionPersistence: new Map(),
      publishThreadSnapshot: vi.fn(async () => undefined),
      now: () => 1_800_000_000_000,
    });

    const mutation = gateway.mutate(scope, "thread-1", {
      kind: "deliver",
      mode: "steer",
      mutationId: "steer-uncertain",
      expectedThreadRevision: 4,
      expectedDraftRevision: 2,
      steerTarget: { kind: "turn", turnId: "turn-1" },
    });
    if (!admitted) {
      await expect(mutation).rejects.toMatchObject({
        code: "operation_outcome_uncertain",
      });
      expect(enqueue).not.toHaveBeenCalled();
      return;
    }
    await expect(mutation).resolves.toEqual({
      status: "delivery_queued",
      queuedInputId: "queued-steer-uncertain",
      resolvedDeliveryMode: "steer",
      threadRevision: 7,
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 3,
        updatedAt: new Date(1_800_000_000_000).toISOString(),
      },
    });
    expect(enqueue).toHaveBeenCalledOnce();
  });
});

function interactionResponseFixture(input?: {
  readonly initialState?: "prepared" | "uncertain" | "accepted";
  readonly reconciliation?: "accepted" | "not_applied" | "unknown";
  readonly respond?: () => Promise<void>;
  readonly publishThreadSnapshot?: () => Promise<void>;
  readonly onPublicationError?: (error: unknown) => void;
}) {
  const database = { prepare: vi.fn(() => ({ get: vi.fn(() => undefined) })) };
  const operationId = "interaction-response-1";
  const interactionId = "interaction-1";
  let state = input?.initialState;
  const response = { kind: "confirmation" as const, confirmed: true };
  const backendResponse = {
    applicationOperationId: operationId,
    interactionId: "pi-interaction-1",
    ...response,
  };
  const record = () =>
    state
      ? {
          tenantId: scope.tenantId,
          principalId: scope.principalId,
          threadId: "thread-1",
          operationId,
          applicationOperationId: operationId,
          interactionId,
          response: state === "accepted" ? undefined : response,
          backendResponse: state === "accepted" ? undefined : backendResponse,
          state,
          createdAt: 1,
        }
      : undefined;
  const respond = vi.fn(input?.respond ?? (async () => undefined));
  const operations = {
    database,
    findUncertainThreadOperation: vi.fn(() =>
      state === "uncertain"
        ? {
            threadId: "thread-1",
            mutationId: operationId,
            operationKind: "conversation_interaction_response",
          }
        : undefined,
    ),
    findInteractionResponse: vi.fn(() => record()),
    prepareRecoverableInteractionResponse: vi.fn(() => {
      state ??= "prepared";
      return record();
    }),
    getInteractionResponse: vi.fn(() => record()),
    markInteractionResponseStarted: vi.fn(() => {
      state = "uncertain";
      return record();
    }),
    acceptInteractionResponse: vi.fn(() => {
      state = "accepted";
      return record();
    }),
    acceptInteractionResponseIfUncertain: vi.fn(() => {
      if (state !== "uncertain") return false;
      state = "accepted";
      return true;
    }),
    rejectInteractionResponseProvenNotApplied: vi.fn(() => {
      state = undefined;
    }),
  };
  const interactions = {
    prepareResponse: vi.fn((): PreparedInteractionResponse => ({
      owner: "provider",
      persistence: "durable",
      backendResponse,
    })),
    respondPrepared: respond,
  };
  const reconcileInteractionResponse = vi.fn(async () => ({
    outcome: input?.reconciliation ?? "not_applied",
  }));
  const publishThreadSnapshot = vi.fn(
    input?.publishThreadSnapshot ?? (async () => undefined),
  );
  const onThreadChanged = vi.fn(async () => undefined);
  const gateway = new ThreadMutationGateway({
    bindings: { database } as never,
    inventory: {
      assertWorkspaceActive: vi.fn(),
      database,
      getThread: vi.fn(() => ({
        thread: { id: "thread-1" },
        inventory: { inventoryState: "active" },
      })),
    } as never,
    lifecycle: { recoverActiveFirstSend: () => undefined } as never,
    forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
    queue: {} as never,
    operations: operations as never,
    completions: { database } as never,
    queueGateway: {} as never,
    runtimes: {
      acquire: vi.fn(async () => ({
        actor: { reconcileInteractionResponse },
        release: vi.fn(),
      })),
    } as never,
    interactions: interactions as never,
    presentation: {} as never,
    agentToolPolicies: testThreadAgentToolPolicyRepository(database),
    actionPersistence: new Map(),
    publishThreadSnapshot,
    onPublicationError: input?.onPublicationError,
    onThreadChanged,
    now: () => 1_800_000_000_000,
  });
  const operation = {
    kind: "respond" as const,
    operationId,
    interactionId,
    response,
  };
  return {
    gateway,
    operation,
    operations,
    interactions,
    respond,
    reconcileInteractionResponse,
    publishThreadSnapshot,
    onThreadChanged,
    state: () => state,
    abandon: () => {
      state = undefined;
    },
  };
}

describe("ThreadMutationGateway interaction-response recovery", () => {
  it("retains and retries the exact response while the interaction remains pending", async () => {
    const respond = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("response outcome unknown"))
      .mockResolvedValueOnce(undefined);
    const subject = interactionResponseFixture({ respond });

    await expect(
      subject.gateway.mutate(scope, "thread-1", subject.operation),
    ).resolves.toEqual({ status: "recovery_required", retryable: true });
    expect(subject.state()).toBe("uncertain");
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
      scope,
      "thread-1",
    );
    expect(subject.onThreadChanged).toHaveBeenCalledWith(scope, "thread-1");

    await expect(
      subject.gateway.mutate(scope, "thread-1", subject.operation),
    ).resolves.toEqual({ status: "completed" });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenLastCalledWith(scope, "thread-1", {
      owner: "provider",
      persistence: "durable",
      backendResponse: {
        applicationOperationId: subject.operation.operationId,
        interactionId: "pi-interaction-1",
        ...subject.operation.response,
      },
    });
    expect(subject.state()).toBe("accepted");
    await vi.waitFor(() =>
      expect(subject.publishThreadSnapshot).toHaveBeenCalledTimes(2),
    );
    await vi.waitFor(() =>
      expect(subject.onThreadChanged).toHaveBeenCalledTimes(2),
    );
  });

  it("waits for recovery projection publication before returning its receipt", async () => {
    const publication = deferred<void>();
    const subject = interactionResponseFixture({
      respond: async () => {
        throw new Error("response outcome unknown");
      },
      publishThreadSnapshot: () => publication.promise,
    });
    let settled = false;
    const response = subject.gateway
      .mutate(scope, "thread-1", subject.operation)
      .then((result) => {
        settled = true;
        return result;
      });

    await vi.waitFor(() =>
      expect(subject.publishThreadSnapshot).toHaveBeenCalledOnce(),
    );
    expect(settled).toBe(false);

    publication.resolve();
    await expect(response).resolves.toEqual({
      status: "recovery_required",
      retryable: true,
    });
    expect(subject.onThreadChanged).toHaveBeenCalledOnce();
  });

  it("accepts only an exact backend reconciliation", async () => {
    const subject = interactionResponseFixture({
      initialState: "uncertain",
      reconciliation: "accepted",
    });

    await expect(
      subject.gateway.recoverThread(scope, "thread-1"),
    ).resolves.toEqual({ status: "completed" });
    expect(subject.respond).not.toHaveBeenCalled();
    expect(subject.state()).toBe("accepted");
    await vi.waitFor(() =>
      expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
        scope,
        "thread-1",
      ),
    );
    await vi.waitFor(() =>
      expect(subject.onThreadChanged).toHaveBeenCalledWith(scope, "thread-1"),
    );
  });

  it("keeps a completed receipt authoritative when post-accept publication fails", async () => {
    const onPublicationError = vi.fn();
    const subject = interactionResponseFixture({
      publishThreadSnapshot: async () => {
        throw new Error("projection unavailable");
      },
      onPublicationError,
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", subject.operation),
    ).resolves.toEqual({ status: "completed" });
    expect(subject.state()).toBe("accepted");

    await subject.gateway.close();
    expect(onPublicationError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "projection unavailable" }),
    );
  });

  it("publishes a completed recovery when no uncertain receipt remains", async () => {
    const subject = interactionResponseFixture();

    await expect(
      subject.gateway.recoverThread(scope, "thread-1"),
    ).resolves.toEqual({ status: "completed" });
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
      scope,
      "thread-1",
    );
    expect(subject.onThreadChanged).toHaveBeenCalledWith(scope, "thread-1");
  });

  it("retains uncertainty when exact backend reconciliation is inconclusive", async () => {
    const subject = interactionResponseFixture({
      initialState: "uncertain",
      reconciliation: "unknown",
    });

    await expect(
      subject.gateway.recoverThread(scope, "thread-1"),
    ).resolves.toEqual({ status: "recovery_required", retryable: true });
    expect(subject.respond).not.toHaveBeenCalled();
    expect(subject.state()).toBe("uncertain");
    expect(
      subject.operations.rejectInteractionResponseProvenNotApplied,
    ).not.toHaveBeenCalled();
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
      scope,
      "thread-1",
    );
    expect(subject.onThreadChanged).toHaveBeenCalledWith(scope, "thread-1");
  });

  it("executes an ephemeral response without creating a durable receipt", async () => {
    const subject = interactionResponseFixture();
    subject.interactions.prepareResponse.mockReturnValueOnce({
      owner: "provider",
      persistence: "ephemeral",
      backendResponse: {
        applicationOperationId: subject.operation.operationId,
        interactionId: "pi-interaction-1",
        ...subject.operation.response,
      },
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", subject.operation),
    ).resolves.toEqual({ status: "completed" });

    expect(
      subject.operations.prepareRecoverableInteractionResponse,
    ).not.toHaveBeenCalled();
    expect(
      subject.operations.markInteractionResponseStarted,
    ).not.toHaveBeenCalled();
    expect(subject.operations.acceptInteractionResponse).not.toHaveBeenCalled();
    expect(subject.respond).toHaveBeenCalledWith(
      scope,
      "thread-1",
      expect.objectContaining({ persistence: "ephemeral" }),
    );
  });

  it("makes an uncertain ephemeral response explicitly non-retryable", async () => {
    const subject = interactionResponseFixture({
      respond: async () => {
        throw new BackendError({
          category: "submission_unknown",
          retryable: false,
          crossedSubmissionBoundary: true,
          safeMessage: "The secret response outcome is unknown.",
        });
      },
    });
    subject.interactions.prepareResponse.mockReturnValueOnce({
      owner: "provider",
      persistence: "ephemeral",
      backendResponse: {
        applicationOperationId: subject.operation.operationId,
        interactionId: "pi-interaction-1",
        ...subject.operation.response,
      },
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", subject.operation),
    ).resolves.toEqual({ status: "recovery_required", retryable: false });
    expect(
      subject.operations.prepareRecoverableInteractionResponse,
    ).not.toHaveBeenCalled();
    expect(subject.state()).toBeUndefined();
  });

  it("owns a late accepted response through shutdown and durably unblocks it", async () => {
    const late = deferred<{
      outcome: "accepted" | "not_applied" | "unknown";
    }>();
    const subject = interactionResponseFixture({
      respond: async () => {
        throw new BackendError(
          {
            category: "unavailable",
            retryable: true,
            crossedSubmissionBoundary: true,
            safeMessage: "The response outcome is not confirmed yet.",
          },
          { lateMutationReconciliation: late.promise },
        );
      },
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", subject.operation),
    ).resolves.toEqual({ status: "recovery_required", retryable: true });
    expect(subject.state()).toBe("uncertain");

    const close = subject.gateway.close();
    let closed = false;
    void close.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    late.resolve({ outcome: "accepted" });
    await close;
    expect(subject.state()).toBe("accepted");
    expect(
      subject.operations.acceptInteractionResponseIfUncertain,
    ).toHaveBeenCalledWith(scope, "thread-1", {
      operationId: subject.operation.operationId,
      interactionId: subject.operation.interactionId,
      response: subject.operation.response,
    });
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
      scope,
      "thread-1",
    );
    expect(subject.onThreadChanged).toHaveBeenCalledWith(scope, "thread-1");
    expect(subject.publishThreadSnapshot).toHaveBeenCalledTimes(2);
    expect(subject.onThreadChanged).toHaveBeenCalledTimes(2);
  });

  it("lets a force-reset tombstone win over a late accepted response", async () => {
    const late = deferred<{
      outcome: "accepted" | "not_applied" | "unknown";
    }>();
    const subject = interactionResponseFixture({
      respond: async () => {
        throw new BackendError(
          {
            category: "unavailable",
            retryable: true,
            crossedSubmissionBoundary: true,
            safeMessage: "The response outcome is not confirmed yet.",
          },
          { lateMutationReconciliation: late.promise },
        );
      },
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", subject.operation),
    ).resolves.toEqual({ status: "recovery_required", retryable: true });
    subject.publishThreadSnapshot.mockClear();
    subject.onThreadChanged.mockClear();
    subject.abandon();
    late.resolve({ outcome: "accepted" });
    await subject.gateway.close();

    expect(subject.state()).toBeUndefined();
    expect(subject.publishThreadSnapshot).not.toHaveBeenCalled();
    expect(subject.onThreadChanged).not.toHaveBeenCalled();
  });
});

function backendActionFixture(input?: {
  perform?: () => Promise<{ accepted: true; capabilityRevision?: string }>;
  reconcileAction?: () => Promise<{
    outcome: "accepted" | "not_applied" | "unknown";
  }>;
}) {
  const database = {
    transaction<T>(operation: () => T) {
      return () => operation();
    },
    prepare: () => ({ get: () => undefined }),
  };
  let record:
    | {
        threadId: string;
        mutationId: string;
        applicationOperationId: string;
        operationKind: "conversation_compact";
        action: "compact";
        expectedThreadRevision: number;
        operation: { action: "compact"; instructions?: string };
        state: "prepared" | "uncertain" | "accepted";
        createdAt: number;
      }
    | undefined;
  let aggregateRevision = 4;
  const actor = {
    timeline: { runState: "idle" as const },
    backendCapabilities: vi.fn(async () => ({
      actions: ["compact"],
    })),
    perform: vi.fn(
      input?.perform ??
        (async () => ({
          accepted: true as const,
          capabilityRevision: "cap-2",
        })),
    ),
    reconcileAction: vi.fn(
      input?.reconcileAction ??
        (async () => ({ outcome: "not_applied" as const })),
    ),
  };
  const operations = {
    database,
    findUncertainThreadOperation: vi.fn(() =>
      record?.state === "uncertain"
        ? {
            threadId: record.threadId,
            mutationId: record.mutationId,
            operationKind: record.operationKind,
          }
        : undefined,
    ),
    findBackendAction: vi.fn(() => record),
    getBackendAction: vi.fn(() => {
      if (!record) throw new Error("missing action record");
      return record;
    }),
    prepareBackendAction: vi.fn(
      (
        _scope: RequestScope,
        threadId: string,
        operation: {
          mutationId: string;
          expectedThreadRevision: number;
          now: number;
        },
      ) => {
        record ??= {
          threadId,
          mutationId: operation.mutationId,
          applicationOperationId: operation.mutationId,
          operationKind: "conversation_compact",
          action: "compact",
          expectedThreadRevision: operation.expectedThreadRevision,
          operation: {
            action: "compact",
            instructions: "Keep the decisions.",
          },
          state: "prepared",
          createdAt: operation.now,
        };
        return record;
      },
    ),
    markBackendActionStarted: vi.fn(() => {
      if (!record) throw new Error("missing action record");
      record = { ...record, state: "uncertain" };
      return record;
    }),
    acceptBackendAction: vi.fn(() => {
      if (!record) throw new Error("missing action record");
      record = { ...record, state: "accepted" };
      return record;
    }),
    rejectBackendActionProvenNotApplied: vi.fn(() => {
      record = undefined;
    }),
  };
  const persistAccepted = vi.fn();
  const publishAuthoritativeReplacement = vi.fn(async () => undefined);
  const publishThreadSnapshot = vi.fn(async () => undefined);
  const gateway = new ThreadMutationGateway({
    bindings: { database } as never,
    inventory: {
      assertWorkspaceActive: vi.fn(),
      database,
      getThread: vi.fn(() => ({
        thread: {
          revision: aggregateRevision,
          availability: "available",
          backingState: "bound",
          backendInstanceId: "backend-1",
        },
        inventory: { inventoryState: "active" },
      })),
    } as never,
    lifecycle: {} as never,
    forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
    queue: {} as never,
    operations: operations as never,
    completions: { database } as never,
    queueGateway: {} as never,
    runtimes: {
      acquire: vi.fn(async () => ({
        actor,
        publishAuthoritativeReplacement,
        release: vi.fn(),
      })),
    } as never,
    interactions: {} as never,
    presentation: {} as never,
    agentToolPolicies: testThreadAgentToolPolicyRepository(database),
    actionPersistence: new Map([
      [
        "backend-1",
        {
          driverAction: (
            operation: { action: "compact"; instructions?: string },
            applicationOperationId: string,
          ) => ({ ...operation, applicationOperationId }),
          persistAccepted,
          afterPersistAccepted: async () => undefined,
        },
      ],
    ]) as never,
    publishThreadSnapshot,
    now: () => 1_800_000_000_000,
  });
  return {
    gateway,
    actor,
    operations,
    persistAccepted,
    publishAuthoritativeReplacement,
    publishThreadSnapshot,
    getRecord: () => record,
    setAggregateRevision(revision: number) {
      aggregateRevision = revision;
    },
  };
}

function unboundSettingFixture(input?: {
  readonly queuedInputState?: "pending" | "failed";
  readonly afterPersistAccepted?: () => Promise<void>;
  readonly settingDescriptors?: readonly {
    readonly id: "model" | "thinking_level" | "tool_access";
    readonly available: boolean;
    readonly options: readonly {
      readonly value: string;
      readonly available: boolean;
    }[];
  }[];
}) {
  const database = {
    transaction<T>(operation: () => T) {
      return () => operation();
    },
    prepare: (sql: string) => ({
      get: () =>
        input?.queuedInputState && sql.includes(`'${input.queuedInputState}'`)
          ? { present: 1 as const }
          : undefined,
    }),
  };
  let state: "prepared" | "accepted" | undefined;
  const receipt = {
    threadId: "thread-1",
    mutationId: "setting-operation-1",
    applicationOperationId: "setting-operation-1",
    operationKind: "conversation_setting" as const,
    action: "set_setting" as const,
    expectedThreadRevision: 4,
    settingsGuard: { kind: "staged" as const, expectedRevision: 0 },
    operation: {
      action: "set_setting" as const,
      settingId: "thinking_level",
      value: "high",
    },
    createdAt: 1_800_000_000_000,
  };
  const prepareBackendAction = vi.fn(() => {
    state ??= "prepared";
    return { ...receipt, state };
  });
  const acceptBackendAction = vi.fn(() => {
    state = "accepted";
    return { ...receipt, state };
  });
  const rejectBackendActionProvenNotApplied = vi.fn(() => {
    state = undefined;
  });
  const persistAccepted = vi.fn();
  const afterPersistAccepted = vi.fn(
    input?.afterPersistAccepted ?? (async () => undefined),
  );
  const driverAction = vi.fn();
  const acquire = vi.fn();
  const onThreadChanged = vi.fn(async () => undefined);
  const publishThreadSnapshot = vi.fn(async () => undefined);
  const presentation = {
    read: vi.fn(async () => ({
      revision: "presentation-1",
      backend: { label: { text: "Pi" } },
      interactionMode: "interactive",
      settings: { revision: 0, values: [] },
      settingDescriptors: input?.settingDescriptors ?? [
        {
          id: "model" as const,
          available: true,
          options: [
            {
              value: "model-available",
              available: true,
            },
          ],
        },
        {
          id: "thinking_level" as const,
          available: true,
          options: [
            {
              value: "high",
              available: true,
            },
          ],
        },
        {
          id: "tool_access" as const,
          available: true,
          options: [
            {
              value: "read_only",
              available: true,
            },
            {
              value: "full",
              available: true,
            },
          ],
        },
      ],
      composerCommands: [],
    })),
  };
  const gateway = new ThreadMutationGateway({
    bindings: { database } as never,
    inventory: {
      assertWorkspaceActive: vi.fn(),
      database,
      getThread: vi.fn(() => ({
        thread: {
          revision: 4,
          availability: "available",
          backingState: "unbound",
          backendInstanceId: "backend-1",
        },
        inventory: { inventoryState: "active" },
      })),
    } as never,
    lifecycle: {} as never,
    forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
    queue: {} as never,
    operations: {
      database,
      findUncertainThreadOperation: vi.fn(() => undefined),
      hasPendingMaterializationSteer: vi.fn(() => false),
      findSteer: vi.fn(() => undefined),
      findBackendAction: vi.fn(() =>
        state === undefined ? undefined : { ...receipt, state },
      ),
      prepareBackendAction,
      acceptBackendAction,
      rejectBackendActionProvenNotApplied,
    } as never,
    completions: { database } as never,
    queueGateway: {} as never,
    runtimes: { acquire } as never,
    interactions: {} as never,
    presentation: presentation as never,
    agentToolPolicies: testThreadAgentToolPolicyRepository(database),
    actionPersistence: new Map([
      [
        "backend-1",
        {
          driverAction,
          persistAccepted,
          afterPersistAccepted,
        },
      ],
    ]) as never,
    publishThreadSnapshot,
    onThreadChanged,
    now: () => 1_800_000_000_000,
  });
  return {
    gateway,
    acquire,
    driverAction,
    persistAccepted,
    afterPersistAccepted,
    prepareBackendAction,
    acceptBackendAction,
    publishThreadSnapshot,
    onThreadChanged,
    presentation,
  };
}

function boundSettingActionFixture(input?: {
  perform?: () => Promise<{ accepted: true; capabilityRevision?: string }>;
  reconcileAction?: () => Promise<{
    outcome: "accepted" | "not_applied" | "unknown";
  }>;
}) {
  const database = {
    transaction<T>(operation: () => T) {
      return () => operation();
    },
    prepare: () => ({ get: () => undefined }),
  };
  let record:
    | {
        threadId: string;
        mutationId: string;
        applicationOperationId: string;
        operationKind: "conversation_settings";
        action: "set_setting";
        expectedThreadRevision: number;
        expectedSettingsRevision: number;
        operation: {
          action: "set_setting";
          settingId: "thinking_level";
          value: string;
        };
        state: "prepared" | "uncertain" | "accepted";
        createdAt: number;
      }
    | undefined;
  let aggregateRevision = 4;
  const actor = {
    timeline: { runState: "idle" as const },
    backendCapabilities: vi.fn(async () => ({
      actions: ["set_model", "set_thinking_level", "set_tool_access"],
    })),
    perform: vi.fn(
      input?.perform ??
        (async () => ({
          accepted: true as const,
          capabilityRevision: "cap-2",
        })),
    ),
    reconcileAction: vi.fn(
      input?.reconcileAction ??
        (async () => ({ outcome: "not_applied" as const })),
    ),
  };
  const operations = {
    database,
    findUncertainThreadOperation: vi.fn(() =>
      record?.state === "uncertain"
        ? {
            threadId: record.threadId,
            mutationId: record.mutationId,
            operationKind: record.operationKind,
          }
        : undefined,
    ),
    findBackendAction: vi.fn(() => record),
    getBackendAction: vi.fn(() => {
      if (!record) throw new Error("missing action record");
      return record;
    }),
    prepareBackendAction: vi.fn(
      (
        _scope: RequestScope,
        threadId: string,
        operation: {
          mutationId: string;
          expectedThreadRevision: number;
          expectedSettingsRevision?: number;
          now: number;
        },
      ) => {
        record ??= {
          threadId,
          mutationId: operation.mutationId,
          applicationOperationId: operation.mutationId,
          operationKind: "conversation_settings",
          action: "set_setting",
          expectedThreadRevision: operation.expectedThreadRevision,
          expectedSettingsRevision: operation.expectedSettingsRevision ?? 2,
          operation: {
            action: "set_setting",
            settingId: "thinking_level",
            value: "high",
          },
          state: "prepared",
          createdAt: operation.now,
        };
        return record;
      },
    ),
    markBackendActionStarted: vi.fn(() => {
      if (!record) throw new Error("missing action record");
      record = { ...record, state: "uncertain" };
      return record;
    }),
    acceptBackendAction: vi.fn(() => {
      if (!record) throw new Error("missing action record");
      record = { ...record, state: "accepted" };
      return record;
    }),
    rejectBackendActionProvenNotApplied: vi.fn(() => {
      record = undefined;
    }),
  };
  const persistAccepted = vi.fn();
  const publishAuthoritativeReplacement = vi.fn(async () => undefined);
  const publishThreadSnapshot = vi.fn(async () => undefined);
  const gateway = new ThreadMutationGateway({
    bindings: { database } as never,
    inventory: {
      assertWorkspaceActive: vi.fn(),
      database,
      getThread: vi.fn(() => ({
        thread: {
          revision: aggregateRevision,
          availability: "available",
          backingState: "bound",
          backendInstanceId: "backend-1",
        },
        inventory: { inventoryState: "active" },
      })),
    } as never,
    lifecycle: {} as never,
    forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
    queue: {} as never,
    operations: operations as never,
    completions: { database } as never,
    queueGateway: {} as never,
    runtimes: {
      acquire: vi.fn(async () => ({
        actor,
        publishAuthoritativeReplacement,
        release: vi.fn(),
      })),
    } as never,
    interactions: {} as never,
    presentation: {} as never,
    agentToolPolicies: testThreadAgentToolPolicyRepository(database),
    actionPersistence: new Map([
      [
        "backend-1",
        {
          driverAction: (
            operation: { action: "set_setting"; value: string },
            applicationOperationId: string,
          ) => ({
            applicationOperationId,
            action: "set_thinking_level",
            level: operation.value,
          }),
          persistAccepted,
          afterPersistAccepted: async () => undefined,
        },
      ],
    ]) as never,
    publishThreadSnapshot,
    now: () => 1_800_000_000_000,
  });
  return {
    gateway,
    actor,
    operations,
    persistAccepted,
    publishThreadSnapshot,
    getRecord: () => record,
    setAggregateRevision(revision: number) {
      aggregateRevision = revision;
    },
  };
}

describe("ThreadMutationGateway backend-action receipts", () => {
  const compact = {
    kind: "perform" as const,
    mutationId: "compact-operation-1",
    expectedThreadRevision: 4,
    operation: {
      action: "compact" as const,
      instructions: "Keep the decisions.",
    },
  };
  const boundSetting = {
    kind: "perform" as const,
    mutationId: "bound-setting-operation-1",
    expectedThreadRevision: 4,
    expectedSettingsRevision: 2,
    operation: {
      action: "set_setting" as const,
      settingId: "thinking_level" as const,
      value: "high",
    },
  };

  it("atomically accepts and replays a backend action", async () => {
    const subject = backendActionFixture();
    await expect(
      subject.gateway.mutate(scope, "thread-1", compact),
    ).resolves.toEqual({
      status: "accepted",
      operationId: compact.mutationId,
    });
    await expect(
      subject.gateway.mutate(scope, "thread-1", compact),
    ).resolves.toEqual({
      status: "accepted",
      operationId: compact.mutationId,
    });

    expect(subject.actor.perform).toHaveBeenCalledTimes(1);
    expect(subject.actor.perform).toHaveBeenCalledWith({
      action: "compact",
      applicationOperationId: compact.mutationId,
      instructions: "Keep the decisions.",
    });
    expect(subject.persistAccepted).toHaveBeenCalledTimes(1);
    expect(subject.getRecord()?.state).toBe("accepted");
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
      scope,
      "thread-1",
    );
    expect(subject.publishAuthoritativeReplacement).not.toHaveBeenCalled();
  });

  it("durably stages and idempotently replays an unbound setting without acquiring an actor", async () => {
    const subject = unboundSettingFixture();
    const operation = {
      kind: "perform" as const,
      mutationId: "setting-operation-1",
      expectedThreadRevision: 4,
      expectedSettingsRevision: 0,
      operation: {
        action: "set_setting" as const,
        settingId: "thinking_level",
        value: "high",
      },
    } as const;

    await expect(
      subject.gateway.mutate(scope, "thread-1", operation),
    ).resolves.toEqual({
      status: "accepted",
      operationId: "setting-operation-1",
    });
    await expect(
      subject.gateway.mutate(scope, "thread-1", operation),
    ).resolves.toEqual({
      status: "accepted",
      operationId: "setting-operation-1",
    });

    expect(subject.persistAccepted).toHaveBeenCalledTimes(1);
    expect(subject.persistAccepted).toHaveBeenCalledWith(
      scope,
      "thread-1",
      expect.objectContaining({
        mutationId: "setting-operation-1",
        expectedThreadRevision: 4,
        settingsGuard: { kind: "staged", expectedRevision: 0 },
        operation: operation.operation,
      }),
    );
    expect(subject.acceptBackendAction).toHaveBeenCalledTimes(1);
    expect(subject.acquire).not.toHaveBeenCalled();
    expect(subject.driverAction).not.toHaveBeenCalled();
    expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
      scope,
      "thread-1",
    );
    expect(subject.onThreadChanged).not.toHaveBeenCalled();
  });

  it("awaits provider post-commit convergence before publishing the accepted snapshot", async () => {
    let converge!: () => void;
    const convergence = new Promise<void>((resolve) => {
      converge = resolve;
    });
    const subject = unboundSettingFixture({
      afterPersistAccepted: async () => await convergence,
    });
    const mutation = subject.gateway.mutate(scope, "thread-1", {
      kind: "perform",
      mutationId: "setting-operation-1",
      expectedThreadRevision: 4,
      expectedSettingsRevision: 0,
      operation: {
        action: "set_setting",
        settingId: "thinking_level",
        value: "high",
      },
    });

    await vi.waitFor(() =>
      expect(subject.afterPersistAccepted).toHaveBeenCalled(),
    );
    expect(subject.acceptBackendAction).toHaveBeenCalledTimes(1);
    expect(subject.publishThreadSnapshot).not.toHaveBeenCalled();

    converge();
    await expect(mutation).resolves.toMatchObject({ status: "accepted" });
    expect(subject.publishThreadSnapshot).toHaveBeenCalledTimes(1);
    expect(
      subject.afterPersistAccepted.mock.invocationCallOrder[0],
    ).toBeLessThan(subject.publishThreadSnapshot.mock.invocationCallOrder[0]!);
  });

  it("allows a next-turn setting mutation after queued input has terminally failed", async () => {
    const subject = unboundSettingFixture({ queuedInputState: "failed" });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "perform",
        mutationId: "setting-operation-1",
        expectedThreadRevision: 4,
        expectedSettingsRevision: 0,
        operation: {
          action: "set_setting",
          settingId: "thinking_level",
          value: "high",
        },
      }),
    ).resolves.toMatchObject({ status: "accepted" });
  });

  it("still rejects a next-turn setting mutation while queued input is pending", async () => {
    const subject = unboundSettingFixture({ queuedInputState: "pending" });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "perform",
        mutationId: "setting-operation-1",
        expectedThreadRevision: 4,
        expectedSettingsRevision: 0,
        operation: {
          action: "set_setting",
          settingId: "thinking_level",
          value: "high",
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
      message:
        "The setting cannot change while the thread has active durable work.",
    });
  });

  it.each([
    {
      label: "an unavailable model",
      settingId: "model" as const,
      value: "model-no-longer-advertised",
    },
    {
      label: "an unsupported thinking level",
      settingId: "thinking_level" as const,
      value: "ultra",
    },
    {
      label: "an unsupported tool access mode",
      settingId: "tool_access" as const,
      value: "write_only",
    },
  ])(
    "rejects $label before preparing or accepting a staged-setting receipt",
    async ({ settingId, value }) => {
      const subject = unboundSettingFixture();

      await expect(
        subject.gateway.mutate(scope, "thread-1", {
          kind: "perform",
          mutationId: "rejected-setting-operation",
          expectedThreadRevision: 4,
          expectedSettingsRevision: 0,
          operation: {
            action: "set_setting",
            settingId,
            value,
          },
        }),
      ).rejects.toMatchObject({
        code: "invalid_transition",
        message: "The requested setting value is not currently available.",
      });

      expect(subject.presentation.read).toHaveBeenCalledWith(scope, "thread-1");
      expect(subject.prepareBackendAction).not.toHaveBeenCalled();
      expect(subject.persistAccepted).not.toHaveBeenCalled();
      expect(subject.acceptBackendAction).not.toHaveBeenCalled();
      expect(subject.acquire).not.toHaveBeenCalled();
      expect(subject.publishThreadSnapshot).not.toHaveBeenCalled();
    },
  );

  it("rejects a staged setting whose descriptor is currently unavailable", async () => {
    const subject = unboundSettingFixture({
      settingDescriptors: [
        {
          id: "model",
          available: false,
          options: [{ value: "model-available", available: true }],
        },
      ],
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "perform",
        mutationId: "unavailable-setting-operation",
        expectedThreadRevision: 4,
        expectedSettingsRevision: 0,
        operation: {
          action: "set_setting",
          settingId: "model",
          value: "model-available",
        },
      }),
    ).rejects.toMatchObject({
      code: "invalid_transition",
      message: "The requested setting is not currently available.",
    });

    expect(subject.prepareBackendAction).not.toHaveBeenCalled();
    expect(subject.persistAccepted).not.toHaveBeenCalled();
    expect(subject.acceptBackendAction).not.toHaveBeenCalled();
  });

  it("keeps a failed boundary call uncertain and permits only its retry", async () => {
    const perform = vi
      .fn<() => Promise<{ accepted: true }>>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({ accepted: true });
    const subject = backendActionFixture({ perform });
    await expect(
      subject.gateway.mutate(scope, "thread-1", compact),
    ).resolves.toEqual({
      status: "recovery_required",
      retryable: true,
    });
    expect(subject.getRecord()?.state).toBe("uncertain");

    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        kind: "interrupt",
        operationId: "unrelated-stop",
      }),
    ).rejects.toMatchObject({ code: "operation_outcome_uncertain" });
    await expect(
      subject.gateway.mutate(scope, "thread-1", compact),
    ).resolves.toEqual({
      status: "accepted",
      operationId: compact.mutationId,
    });
    expect(perform).toHaveBeenCalledTimes(2);
    expect(subject.getRecord()?.state).toBe("accepted");
  });

  it("persists an uncertain action against the current aggregate revision after completion races ahead", async () => {
    const perform = vi
      .fn<() => Promise<{ accepted: true }>>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({ accepted: true });
    const subject = backendActionFixture({
      perform,
      reconcileAction: async () => ({ outcome: "accepted" }),
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", compact),
    ).resolves.toMatchObject({ status: "recovery_required" });
    subject.setAggregateRevision(5);
    await expect(
      subject.gateway.recoverThread(scope, "thread-1"),
    ).resolves.toEqual({
      status: "accepted",
      operationId: compact.mutationId,
    });

    expect(subject.persistAccepted).toHaveBeenCalledWith(
      scope,
      "thread-1",
      expect.objectContaining({
        expectedThreadRevision: 5,
        settingsGuard: { kind: "proven_applied" },
      }),
    );
  });

  it("retains an unknown backend action without repeating it", async () => {
    const perform = vi.fn(async () => {
      throw new Error("response lost");
    });
    const subject = backendActionFixture({
      perform,
      reconcileAction: async () => ({ outcome: "unknown" }),
    });

    await subject.gateway.mutate(scope, "thread-1", compact);
    await expect(
      subject.gateway.recoverThread(scope, "thread-1"),
    ).resolves.toEqual({
      status: "recovery_required",
      retryable: true,
    });
    expect(perform).toHaveBeenCalledOnce();
  });

  it("retains an uncertain backend action when reconciliation fails", async () => {
    const perform = vi.fn(async () => {
      throw new Error("response lost");
    });
    const subject = backendActionFixture({
      perform,
      reconcileAction: async () => {
        throw new Error("read unavailable");
      },
    });

    await subject.gateway.mutate(scope, "thread-1", compact);
    await expect(
      subject.gateway.recoverThread(scope, "thread-1"),
    ).resolves.toEqual({
      status: "recovery_required",
      retryable: true,
    });
    expect(perform).toHaveBeenCalledOnce();
  });

  it("does not retry a proven-not-applied action after its revision changes", async () => {
    const perform = vi.fn(async () => {
      throw new Error("response lost");
    });
    const subject = backendActionFixture({ perform });
    await subject.gateway.mutate(scope, "thread-1", compact);
    subject.setAggregateRevision(5);

    await expect(
      subject.gateway.recoverThread(scope, "thread-1"),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(perform).toHaveBeenCalledOnce();
    expect(subject.getRecord()).toBeUndefined();
  });

  it("removes the receipt when the backend proves the action was not applied", async () => {
    const subject = backendActionFixture({
      perform: async () => {
        throw new BackendError({
          category: "rejected",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "Unsupported setting.",
        });
      },
    });
    await expect(
      subject.gateway.mutate(scope, "thread-1", compact),
    ).rejects.toMatchObject({ category: "rejected" });
    expect(subject.getRecord()).toBeUndefined();
    expect(
      subject.operations.rejectBackendActionProvenNotApplied,
    ).toHaveBeenCalledTimes(1);
  });

  it("clears a wedged uncertain action once reconciliation proves non-application", async () => {
    const perform = vi
      .fn<() => Promise<{ accepted: true }>>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockRejectedValueOnce(
        new BackendError({
          category: "rejected",
          retryable: false,
          crossedSubmissionBoundary: false,
          safeMessage: "Unsupported setting.",
          backendCode: "pi_thinking_level_unsupported",
        }),
      )
      .mockResolvedValue({ accepted: true });
    const subject = backendActionFixture({
      perform,
      reconcileAction: async () => ({ outcome: "not_applied" }),
    });

    // The initial attempt crosses the boundary and wedges the receipt.
    await expect(
      subject.gateway.mutate(scope, "thread-1", compact),
    ).resolves.toEqual({ status: "recovery_required", retryable: true });
    expect(subject.getRecord()?.state).toBe("uncertain");

    // Recovery proves the action never applied, re-performs it, and the
    // backend's non-crossed rejection clears the receipt for good.
    await expect(
      subject.gateway.recoverThread(scope, "thread-1"),
    ).rejects.toMatchObject({ category: "rejected" });
    expect(subject.getRecord()).toBeUndefined();
    expect(
      subject.operations.rejectBackendActionProvenNotApplied,
    ).toHaveBeenCalledTimes(1);

    // A later mutation is no longer blocked by the cleared uncertainty.
    await expect(
      subject.gateway.mutate(scope, "thread-1", {
        ...compact,
        mutationId: "compact-operation-2",
      }),
    ).resolves.toEqual({
      status: "accepted",
      operationId: "compact-operation-2",
    });
  });

  it("accepts a bound settings action against the proven-applied fence rather than the staged revision", async () => {
    const subject = boundSettingActionFixture();

    await expect(
      subject.gateway.mutate(scope, "thread-1", boundSetting),
    ).resolves.toEqual({
      status: "accepted",
      operationId: boundSetting.mutationId,
    });

    expect(subject.actor.perform).toHaveBeenCalledTimes(1);
    // The action is proven applied once perform returns, so persistence must
    // not reuse the client-staged settings revision: provider-owned
    // observed-settings adoption may have advanced it while the action was
    // in flight.
    expect(subject.persistAccepted).toHaveBeenCalledWith(
      scope,
      "thread-1",
      expect.objectContaining({
        expectedThreadRevision: 4,
        settingsGuard: { kind: "proven_applied" },
        operation: boundSetting.operation,
      }),
    );
    expect(subject.getRecord()?.state).toBe("accepted");
  });

  it("recovers an uncertain settings action with the proven-applied fence once reconciliation accepts", async () => {
    const perform = vi
      .fn<() => Promise<{ accepted: true }>>()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({ accepted: true });
    const subject = boundSettingActionFixture({
      perform,
      reconcileAction: async () => ({ outcome: "accepted" }),
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", boundSetting),
    ).resolves.toEqual({ status: "recovery_required", retryable: true });
    expect(subject.getRecord()?.state).toBe("uncertain");

    subject.setAggregateRevision(5);
    await expect(
      subject.gateway.recoverThread(scope, "thread-1"),
    ).resolves.toEqual({
      status: "accepted",
      operationId: boundSetting.mutationId,
    });

    // Reconciliation proved application; the action is not re-performed, and
    // persistence uses the proven-applied fence so a settings revision that
    // advanced underneath the wedge can never block recovery again.
    expect(perform).toHaveBeenCalledTimes(1);
    expect(subject.persistAccepted).toHaveBeenCalledWith(
      scope,
      "thread-1",
      expect.objectContaining({
        expectedThreadRevision: 5,
        settingsGuard: { kind: "proven_applied" },
        operation: boundSetting.operation,
      }),
    );
    expect(subject.getRecord()?.state).toBe("accepted");
  });
});

describe("ThreadMutationGateway durable submission observation", () => {
  it("delegates an uncertain queue-source Steer to the queue serializer", async () => {
    const observeAuthoritativeSubmission = vi.fn(async () => true);
    const findAwaitingSteerSubmission = vi.fn(() => ({
      source: "queued_input" as const,
      queuedInputId: "queued-input-1",
    }));
    const gateway = new ThreadMutationGateway({
      bindings: {} as never,
      inventory: {} as never,
      lifecycle: {} as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: { observeAuthoritativeSubmission } as never,
      operations: {
        findAwaitingSteerSubmission,
      } as never,
      completions: {} as never,
      queueGateway: {} as never,
      runtimes: {} as never,
      interactions: {} as never,
      presentation: {} as never,
      agentToolPolicies: {} as never,
      actionPersistence: new Map(),
      publishThreadSnapshot: vi.fn(async () => undefined),
      now: () => 2_000,
    });

    await gateway.observeAuthoritativeSubmission(
      scope,
      "thread-1",
      "queued-steer-1",
    );

    expect(observeAuthoritativeSubmission).toHaveBeenCalledWith(
      scope,
      "thread-1",
      "queued-steer-1",
    );
    expect(findAwaitingSteerSubmission).toHaveBeenCalledWith(
      scope,
      "thread-1",
      "queued-steer-1",
    );
  });

  it("atomically accepts a pending steer when its Pi user turn persists", async () => {
    const transaction =
      <T>(operation: () => T) =>
      () =>
        operation();
    const database = { transaction };
    const receipt = {
      tenantId: scope.tenantId,
      principalId: scope.principalId,
      threadId: "thread-1",
      mutationId: "steer-1",
      applicationOperationId: "steer-1",
      reconciliationToken: "steer-1",
      expectedThreadRevision: 4,
      expectedDraftRevision: 2,
      target: { kind: "turn", turnId: "turn-1" },
      attachments: [],
      state: "pending_materialization" as const,
      createdAt: 1,
    };
    let awaiting = true;
    const acceptSteer = vi.fn(() => {
      awaiting = false;
    });
    const recordAccepted = vi.fn();
    const publishAuthoritativeReplacement = vi.fn(async () => undefined);
    const publishThreadSnapshot = vi.fn(async () => undefined);
    const acquire = vi.fn(async () => ({
      actor: {},
      publishAuthoritativeReplacement,
      release: vi.fn(),
    }));
    const gateway = new ThreadMutationGateway({
      bindings: { database } as never,
      inventory: { database } as never,
      lifecycle: {} as never,
      forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
      queue: {} as never,
      operations: {
        database,
        findAwaitingSteerSubmission: vi.fn(
          (
            _scope: RequestScope,
            _threadId: string,
            backendCorrelation: string,
          ) =>
            awaiting && backendCorrelation === receipt.applicationOperationId
              ? receipt
              : undefined,
        ),
        acceptSteer,
      } as never,
      completions: {
        database,
        recordAccepted,
      } as never,
      queueGateway: {} as never,
      runtimes: {
        acquire,
      } as never,
      interactions: {} as never,
      presentation: {} as never,
      agentToolPolicies: testThreadAgentToolPolicyRepository(database),
      actionPersistence: new Map(),
      publishThreadSnapshot,
      now: () => 2_000,
    });

    await gateway.observeAuthoritativeSubmission(
      scope,
      "thread-1",
      "another-steer",
    );
    await gateway.observeAuthoritativeSubmission(scope, "thread-1", "steer-1");
    await gateway.observeAuthoritativeSubmission(scope, "thread-1", "steer-1");

    expect(acceptSteer).toHaveBeenCalledWith(scope, "steer-1", 2_000);
    expect(recordAccepted).toHaveBeenCalledWith(scope, "thread-1", {
      operationId: "steer-1",
      acceptedAt: 2_000,
      backendCorrelation: "steer-1",
      attachmentIds: [],
    });
    expect(publishThreadSnapshot).toHaveBeenCalledWith(scope, "thread-1");
    expect(acceptSteer).toHaveBeenCalledOnce();
    expect(recordAccepted).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(publishAuthoritativeReplacement).not.toHaveBeenCalled();
  });
});

function providerFeatureMutationFixture(input: {
  readonly concurrency: ProviderFeatureConcurrency;
  readonly runState: "idle" | "running";
  readonly queuedInput: boolean;
}) {
  const database = {
    prepare: (sql: string) => ({
      get: () =>
        input.queuedInput && sql.includes("FROM queued_inputs")
          ? { present: 1 as const }
          : undefined,
    }),
  };
  const mutateProviderFeature = vi.fn(async () => ({
    outcome: "accepted" as const,
    projectedState: {
      lifecycle: "running",
      resourceGeneration: 1,
      streamAvailable: true,
    },
  }));
  const release = vi.fn();
  const acquire = vi.fn(async () => ({
    actor: {
      timeline: {
        runState: input.runState,
        ...(input.runState === "running" ? { activeTurnId: "turn-1" } : {}),
      },
      mutateProviderFeature,
    },
    release,
  }));
  const providerFeatureConcurrency = vi.fn(() => input.concurrency);
  const performProviderFeature = vi.fn(
    async (
      _scope: RequestScope,
      _threadId: string,
      request: {
        readonly mutationId: string;
        readonly mutateExternal?: (input: {
          readonly featureId: string;
          readonly schemaVersion: number;
          readonly actionId: string;
          readonly arguments: unknown;
        }) => Promise<{
          readonly outcome: "accepted" | "uncertain" | "rejected";
        }>;
      },
    ) => {
      await request.mutateExternal?.({
        featureId: "codex.tui",
        schemaVersion: 1,
        actionId: "start",
        arguments: null,
      });
      return { applicationOperationId: request.mutationId };
    },
  );
  const gateway = new ThreadMutationGateway({
    bindings: { database } as never,
    inventory: {
      assertWorkspaceActive: vi.fn(),
      database,
      getThread: vi.fn(() => ({
        thread: {
          revision: 4,
          availability: "available",
          backingState: "bound",
          backendInstanceId: "backend-1",
        },
        inventory: { inventoryState: "active" },
      })),
    } as never,
    lifecycle: {} as never,
    forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
    queue: {} as never,
    operations: {
      database,
      findUncertainThreadOperation: vi.fn(() => undefined),
      hasPendingMaterializationSteer: vi.fn(() => false),
      findSteer: vi.fn(() => undefined),
    } as never,
    completions: { database } as never,
    queueGateway: {} as never,
    runtimes: { acquire } as never,
    interactions: {} as never,
    presentation: {
      read: vi.fn(async () => ({
        providerFeatureCapabilities: [
          {
            ref: { featureId: "codex.tui", schemaVersion: 1 },
            revision: 7,
            availability: "available",
            operations: [
              {
                actionId: "start",
                confirmation: "none",
              },
            ],
          },
        ],
      })),
    } as never,
    agentToolPolicies: testThreadAgentToolPolicyRepository(database),
    actionPersistence: new Map([
      [
        "backend-1",
        {
          providerFeatureConcurrency,
          requiresRuntimeProviderFeature: () => true,
          replayProviderFeature: () => undefined,
          performProviderFeature,
        } as never,
      ],
    ]),
    publishThreadSnapshot: vi.fn(async () => undefined),
  });
  const operation = {
    kind: "perform" as const,
    mutationId: "tui-start",
    expectedThreadRevision: 4,
    operation: {
      action: "perform_provider_feature" as const,
      feature: { featureId: "codex.tui", schemaVersion: 1 },
      actionId: "start",
      arguments: null,
      expectedFeatureRevision: 7,
    },
  };
  return {
    gateway,
    operation,
    acquire,
    release,
    providerFeatureConcurrency,
    performProviderFeature,
    mutateProviderFeature,
  };
}

describe("ThreadMutationGateway provider-feature concurrency", () => {
  it.each([
    {
      name: "an active turn",
      runState: "running" as const,
      queuedInput: false,
    },
    { name: "queued input", runState: "idle" as const, queuedInput: true },
  ])("allows a concurrent action beside $name", async (current) => {
    const subject = providerFeatureMutationFixture({
      ...current,
      concurrency: CONCURRENT_PROVIDER_FEATURE_CONCURRENCY,
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", subject.operation),
    ).resolves.toEqual({ status: "accepted", operationId: "tui-start" });
    expect(subject.providerFeatureConcurrency).toHaveBeenCalledWith(
      { featureId: "codex.tui", schemaVersion: 1 },
      "start",
    );
    expect(subject.performProviderFeature).toHaveBeenCalledTimes(1);
    expect(subject.mutateProviderFeature).toHaveBeenCalledTimes(1);
    expect(subject.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "an active turn",
      runState: "running" as const,
      queuedInput: false,
    },
    { name: "queued input", runState: "idle" as const, queuedInput: true },
  ])("rejects a quiet-thread action beside $name", async (current) => {
    const subject = providerFeatureMutationFixture({
      ...current,
      concurrency: QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY,
    });

    await expect(
      subject.gateway.mutate(scope, "thread-1", subject.operation),
    ).rejects.toMatchObject({ code: "invalid_transition" });
    expect(subject.performProviderFeature).not.toHaveBeenCalled();
    expect(subject.mutateProviderFeature).not.toHaveBeenCalled();
  });
});

function agentToolPolicyMutationFixture(input: {
  readonly presentation?: {
    readonly surface: "native" | "cli";
    readonly mode: "progressive" | "individual";
  };
  readonly backingState?: "unbound" | "bound" | "creating";
  readonly runState?: "idle" | "failed" | "running";
  readonly queued?: boolean;
  readonly uncertain?: boolean;
  readonly updateError?: Error;
  readonly retirementUnproven?: boolean;
}) {
  const lifecycle: string[] = [];
  const database = {
    prepare: (sql: string) => ({
      get: () =>
        input.queued && sql.includes("FROM queued_inputs")
          ? { present: 1 as const }
          : undefined,
    }),
  };
  const agentToolPolicies = threadAgentToolPolicyRepository(database as never);
  vi.spyOn(agentToolPolicies, "get").mockReturnValue({
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    applicationThreadId: "thread-1",
    enabled: false,
    enabledToolIds: [],
    presentation: input.presentation ?? {
      surface: "native", mode: "individual",
    },
    accessBoundary: "environment",
    revision: 2,
    updatedAt: 100,
  });
  const update = vi
    .spyOn(agentToolPolicies, "update")
    .mockImplementation((requestScope, applicationThreadId, request) => {
      if (input.updateError) throw input.updateError;
      lifecycle.push("policy_updated");
      return {
        tenantId: requestScope.tenantId,
        ownerPrincipalId: requestScope.principalId,
        applicationThreadId,
        enabled: request.enabled,
        presentation: request.presentation,
        accessBoundary: request.accessBoundary,
        revision: request.expectedRevision + 1,
        updatedAt: request.now,
        enabledToolIds: request.enabledToolIds,
      };
    });
  const runWithRuntimeRetired = vi.fn(
    async <T>(
      _scope: RequestScope,
      _applicationThreadId: string,
      operation: () => Promise<T>,
    ) => {
      if (input.runState === "running") {
        throw new ThreadRuntimeNotIdleError();
      }
      if (input.retirementUnproven) {
        throw new ThreadRuntimeRetirementUnprovenError(
          new Error("close failed"),
        );
      }
      lifecycle.push("runtime_retired");
      const result = await operation();
      lifecycle.push("retirement_released");
      return result;
    },
  );
  const publishThreadSnapshot = vi.fn(async () => undefined);
  const gateway = new ThreadMutationGateway({
    bindings: { database } as never,
    inventory: {
      assertWorkspaceActive: vi.fn(),
      database,
      getThread: vi.fn(() => ({
        thread: {
          availability: "available",
          backingState: input.backingState ?? "bound",
        },
        inventory: { inventoryState: "active" },
      })),
    } as never,
    lifecycle: {} as never,
    forks: { recoverActive: () => undefined, discardActive: async () => { throw new Error("test_unexpected_discard"); } },
    queue: {} as never,
    operations: {
      database,
      findUncertainThreadOperation: vi.fn(() =>
        input.uncertain
          ? {
              operationKind: "conversation_rename",
              mutationId: "another-mutation",
            }
          : undefined,
      ),
    } as never,
    completions: { database } as never,
    queueGateway: {} as never,
    runtimes: { runWithRuntimeRetired } as never,
    interactions: {} as never,
    presentation: {} as never,
    agentToolPolicies,
    actionPersistence: new Map(),
    publishThreadSnapshot,
    now: () => 500,
  });
  const operation = {
    kind: "set_agent_tool_policy" as const,
    mutationId: "10000000-0000-4000-8000-000000000003",
    expectedPolicyRevision: 2,
    enabled: true,
    enabledToolIds: ["thread.status"],
    presentation: input.presentation ?? {
      surface: "native" as const, mode: "individual" as const,
    },
    accessBoundary: "environment" as const,
  };
  return {
    gateway,
    operation,
    update,
    runWithRuntimeRetired,
    lifecycle,
    publishThreadSnapshot,
  };
}

describe("ThreadMutationGateway agent-tool policy", () => {
  it.each(["progressive", "individual"] as const)(
    "updates CLI %s grants and master access during a turn without retiring it",
    async (mode) => {
      const subject = agentToolPolicyMutationFixture({
        runState: "running",
        queued: true,
        presentation: { surface: "cli", mode },
      });
      await expect(
        subject.gateway.mutate(scope, "thread-1", subject.operation),
      ).resolves.toMatchObject({ status: "accepted" });
      await expect(
        subject.gateway.mutate(scope, "thread-1", {
          ...subject.operation,
          enabled: false,
          enabledToolIds: [],
        }),
      ).resolves.toMatchObject({ status: "accepted" });
      expect(subject.runWithRuntimeRetired).not.toHaveBeenCalled();
      expect(subject.lifecycle).toEqual(["policy_updated", "policy_updated"]);
      expect(subject.update).toHaveBeenLastCalledWith(
        scope, "thread-1", expect.objectContaining({
          enabled: false,
          enabledToolIds: [],
        }),
      );
      expect(subject.publishThreadSnapshot).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { surface: "cli", mode: "individual" },
    { surface: "native", mode: "progressive" },
  ] as const)(
    "rejects a running CLI presentation change to $surface/$mode",
    async (presentation) => {
      const subject = agentToolPolicyMutationFixture({
        runState: "running",
        presentation: { surface: "cli", mode: "progressive" },
      });
      await expect(subject.gateway.mutate(scope, "thread-1", {
        ...subject.operation,
        presentation,
      })).rejects.toMatchObject({ code: "invalid_transition" });
      expect(subject.update).not.toHaveBeenCalled();
    },
  );

  it("rejects switching a running native session to CLI", async () => {
    const subject = agentToolPolicyMutationFixture({ runState: "running" });
    await expect(subject.gateway.mutate(scope, "thread-1", {
      ...subject.operation,
      presentation: { surface: "cli", mode: "individual" },
    })).rejects.toMatchObject({ code: "invalid_transition" });
    expect(subject.update).not.toHaveBeenCalled();
  });

  it("preserves revision conflicts on live CLI updates", async () => {
    const subject = agentToolPolicyMutationFixture({
      runState: "running",
      presentation: { surface: "cli", mode: "progressive" },
      updateError: new DomainError("conflict", "stale policy"),
    });
    await expect(subject.gateway.mutate(scope, "thread-1", subject.operation))
      .rejects.toMatchObject({ code: "conflict" });
    expect(subject.runWithRuntimeRetired).not.toHaveBeenCalled();
    expect(subject.publishThreadSnapshot).not.toHaveBeenCalled();
  });

  it.each(["idle", "failed"] as const)(
    "applies one CAS policy while a bound thread is %s",
    async (runState) => {
      const subject = agentToolPolicyMutationFixture({ runState });
      await expect(
        subject.gateway.mutate(scope, "thread-1", subject.operation),
      ).resolves.toEqual({
        status: "accepted",
        operationId: subject.operation.mutationId,
      });
      expect(subject.update).toHaveBeenCalledWith(scope, "thread-1", {
        expectedRevision: 2,
        enabled: true,
        enabledToolIds: ["thread.status"],
        presentation: { surface: "native", mode: "individual" },
        accessBoundary: "environment",
        now: 500,
      });
      expect(subject.runWithRuntimeRetired).toHaveBeenCalledWith(
        scope,
        "thread-1",
        expect.any(Function),
      );
      expect(subject.lifecycle).toEqual([
        "runtime_retired",
        "policy_updated",
        "retirement_released",
      ]);
      expect(subject.publishThreadSnapshot).toHaveBeenCalledWith(
        scope,
        "thread-1",
      );
    },
  );

  it("allows an unbound idle draft without retiring a runtime", async () => {
    const subject = agentToolPolicyMutationFixture({ backingState: "unbound" });
    await subject.gateway.mutate(scope, "thread-1", subject.operation);
    expect(subject.runWithRuntimeRetired).not.toHaveBeenCalled();
    expect(subject.update).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "active turn",
      input: { runState: "running" as const },
      code: "invalid_transition",
    },
    {
      name: "active durable queue",
      input: { queued: true },
      code: "invalid_transition",
    },
    {
      name: "thread creation",
      input: { backingState: "creating" as const },
      code: "invalid_transition",
    },
    {
      name: "uncertain work",
      input: { uncertain: true },
      code: "operation_outcome_uncertain",
    },
    {
      name: "unproven runtime retirement",
      input: { retirementUnproven: true },
      code: "operation_outcome_uncertain",
    },
  ])(
    "rejects beside $name without queueing the policy",
    async ({ input, code }) => {
      const subject = agentToolPolicyMutationFixture(input);
      await expect(
        subject.gateway.mutate(scope, "thread-1", subject.operation),
      ).rejects.toMatchObject({ code });
      expect(subject.update).not.toHaveBeenCalled();
      expect(subject.publishThreadSnapshot).not.toHaveBeenCalled();
    },
  );

  it("propagates a stale policy revision without publishing", async () => {
    const subject = agentToolPolicyMutationFixture({
      updateError: new DomainError("conflict", "stale policy"),
    });
    await expect(
      subject.gateway.mutate(scope, "thread-1", subject.operation),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(subject.publishThreadSnapshot).not.toHaveBeenCalled();
  });
});
