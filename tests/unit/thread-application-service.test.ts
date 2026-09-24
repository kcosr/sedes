import { ConversationEventBridge } from "../../src/server/events/conversation-event-bridge.js";
import { ThreadEventPresentation } from "../../src/server/events/thread-event-presentation.js";
import { ThreadEventHub } from "../../src/server/events/thread-event-hub.js";
import { NormalizedThreadStore } from "../../src/client/stores/NormalizedThreadStore.js";
import type { ConversationActorListener } from "../../src/server/conversations/conversation-actor.js";
import { describe, expect, it, vi } from "vitest";
import {
  ActorBackedThreadApplicationConversationReader,
  ThreadApplicationService,
  type AuthorizedThreadApplicationState,
  type ThreadConversationCapture,
  type ThreadApplicationPresentation,
} from "../../src/server/conversations/thread-application-service.js";
import type { ThreadApplicationOperation } from "../../src/shared/protocol/api.js";
import type {
  BackendInteraction,
  NormalizedThreadSnapshot,
  QueuedInputSummary,
} from "../../src/shared/protocol/conversation.js";
import { BackendError } from "../../src/server/backends/contracts.js";
import type { AcquireConversationActorInput } from "../../src/server/conversations/conversation-actor-manager.js";
import {
  CONCURRENT_PROVIDER_FEATURE_CONCURRENCY,
  QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY,
  type ProviderFeatureConcurrency,
} from "../../src/server/provider-features/contracts.js";
import type { ProviderFeatureRef } from "../../src/shared/protocol/provider-feature.js";

const scope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
};

function inventory(
  backingState: AuthorizedThreadApplicationState["thread"]["backingState"] = "bound",
): AuthorizedThreadApplicationState {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    backendInstanceId: "backend-1",
    backendSessionId: "backend-session-1",
    executionWorkspace: { kind: "direct" },
    thread: {
      id: "thread-1",
      workspaceId: "workspace-1",
      targetId: "target-1",
      title: { text: "Normalized thread" },
      backend: { label: { text: "Pi" }, brand: "pi" },
      backingState,
      inventoryState: "active",
      inventoryRevision: 2,
      threadRevision: 7,
      available: true,
      lastActivityAt: "2026-07-30T10:00:00.000Z",
      stateChangedAt: "2026-07-30T09:00:00.000Z",
      automation: null,
    },
    workspace: {
      id: "workspace-1",
      environmentId: "environment-1",
      label: { text: "Sedes" },
      displayPath: { text: "/workspace/sedes" },
      available: true,
    },
    environment: {
      id: "environment-1",
      kind: "local" as const,
      label: { text: "Machine" },
      available: true,
      directoryBrowsing: "available" as const,
    },
    draft: {
      text: "later",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 3,
      updatedAt: "2026-07-30T10:01:00.000Z",
    },
    stashes: [
      {
        id: "stash-1",
        text: "saved",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        createdAt: "2026-07-30T09:30:00.000Z",
      },
    ],
    agentTools: {
      enabled: false,
      accessBoundary: "environment",
      groups: [
        {
          id: "context",
          label: { text: "Context" },
          description: { text: "Inspect source context." },
          order: 10,
          tools: [
            {
              id: "agent.context",
              label: { text: "Sedes agent context" },
              order: 10,
              effects: {
                application: "read",
                modelUsage: "none",
                external: "none",
              },
              enabled: false,
              available: true,
            },
          ],
        },
      ],
      presentation: { surface: "native", mode: "individual" },
      presentationOptions: [
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      revision: 0,
    },
    attention: {
      unseenCompletion: {
        operationId: "operation-1",
        completedAt: "2026-07-30T09:59:00.000Z",
      },
    },
  };
}

function mutableProviderFeature(
  featureId: string,
): ThreadApplicationPresentation["providerFeatureCapabilities"][number] {
  return {
    ref: { featureId, schemaVersion: 1 },
    revision: 1,
    label: { text: featureId },
    availability: "available",
    operations: [
      {
        actionId: "change",
        label: { text: "Change" },
        effects: {
          application: "write",
          modelUsage: "none",
          external: "none",
        },
        confirmation: "none",
        execution: "inline",
      },
    ],
    presentationSlots: ["thread_details"],
  };
}

const concurrentTuiAndQuietPreference = (
  feature: ProviderFeatureRef,
): ProviderFeatureConcurrency =>
  feature.featureId === "codex.tui"
    ? CONCURRENT_PROVIDER_FEATURE_CONCURRENCY
    : QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY;

function createService(input?: {
  state?: AuthorizedThreadApplicationState;
  disconnected?: boolean;
  runState?:
    | "idle"
    | "failed"
    | "starting"
    | "running"
    | "stopping"
    | "disconnected"
    | "reconciling";
  includeInteraction?: boolean;
  interaction?: BackendInteraction;
  interactionMode?: "interactive" | "read_only";
  actions?: readonly (
    | "rename"
    | "compact"
    | "set_model"
    | "set_thinking_level"
    | "set_tool_access"
  )[];
  steerTarget?: "turn" | "conversation" | null;
  deliveryModes?: readonly ("submit" | "steer")[];
  composerAttachments?: {
    readonly fileStaging: boolean;
    readonly nativeImage: boolean;
  };
  attachmentStagingAvailable?: boolean;
  branchingAvailable?: boolean;
  sourceMustBeIdle?: boolean;
  interactionKinds?: readonly (
    | "choice"
    | "confirmation"
    | "text_input"
    | "editor"
    | "decision"
    | "questionnaire"
  )[];
  modelValue?: string | null;
  automationAllowed?: boolean;
  nextTurnSettingIds?: ThreadApplicationPresentation["nextTurnSettingIds"];
  providerFeatureCapabilities?: ThreadApplicationPresentation["providerFeatureCapabilities"];
  providerFeatureConcurrency?: (
    feature: ProviderFeatureRef,
    actionId: string,
  ) => ProviderFeatureConcurrency;
  queue?: readonly QueuedInputSummary[];
  recovery?: NonNullable<NormalizedThreadSnapshot["recovery"]>;
  pendingDelivery?: boolean;
  mutation?: (
    operation: ThreadApplicationOperation,
  ) => Promise<
    | { readonly status: "queued"; readonly queuedInputId: string }
    | { readonly status: "completed" }
  >;
}) {
  const state = input?.state ?? inventory();
  const getAuthorized = vi.fn(async () => state);
  const capture = vi.fn(async (): Promise<ThreadConversationCapture> =>
    input?.disconnected
      ? { status: "disconnected" as const }
      : {
          status: "connected" as const,
          state: {
            timeline: {
              generation: "generation-1",
              orderedTurnIds: ["turn-1"],
              turnsById: {
                "turn-1": {
                  id: "turn-1",
                  revision: 0,
                  status: "in_progress" as const,
                  orderedItemIds: ["item-1"],
                },
              },
              itemsById: {
                "item-1": {
                  id: "item-1",
                  turnId: "turn-1",
                  kind: "assistant_message" as const,
                  status: "streaming" as const,
                  revision: 0,
                  markdown: { text: "Working" },
                },
              },
              runState: input?.runState ?? ("running" as const),
              ...(input?.runState === "idle" || input?.runState === "failed"
                ? {}
                : { activeTurnId: "turn-1" }),
            },
            backendCapabilities: {
              revision: "backend-capabilities-4",
              actions:
                input?.actions === undefined
                  ? [
                      "rename" as const,
                      "compact" as const,
                      "set_model" as const,
                    ]
                  : [...input.actions],
              deliveryModes:
                input?.deliveryModes === undefined
                  ? ["submit", "steer"]
                  : [...input.deliveryModes],
              steerTarget: input?.steerTarget ?? (input?.deliveryModes?.includes("steer") === false ? null : "turn"),
              composerAttachments: {
                fileStaging: input?.composerAttachments?.fileStaging ?? false,
                nativeImage: input?.composerAttachments?.nativeImage ?? false,
              },
              nonblockingQuestions: false,
              providerOutputArtifacts: { nativeImage: false },
              supportsHistory: true,
              branching:
                input?.branchingAvailable === false
                  ? {
                      availability: "unavailable" as const,
                      reason: { text: "Branching is unavailable." },
                    }
                  : {
                      availability: "available" as const,
                      boundaries: [
                        "latest_completed" as const,
                        "selected_completed_turn" as const,
                      ],
                      method: "provider_native" as const,
                      sourceMustBeIdle: input?.sourceMustBeIdle ?? true,
                      settingsInheritance: "application_applied" as const,
                      fidelity: {
                        instructions: true,
                        messages: true,
                        toolCalls: true,
                        toolResults: true,
                        compaction: true,
                        attachments: true,
                        settings: true,
                        limitations: [],
                      },
                      childIdentity: "application_reserved" as const,
                      creationRecovery: "idempotent" as const,
                    },
              interactionKinds:
                input?.interactionKinds === undefined
                  ? ["choice", "confirmation"]
                  : [...input.interactionKinds],
              usageAccounting: "supported" as const, usageSections: ["context" as const],
              effectiveSettings: {},
            },
            usage: {
              context: {
                usedTokens: 25,
                windowTokens: 100,
                percent: 25,
              },
            },
          },
        },
  );
  const list = vi.fn(async () =>
    input?.queue === undefined
      ? [
          {
            id: "queue-1",
            deliveryOperationId: "queue-operation-1",
            resolvedDeliveryMode: "queue" as const,
            sequence: 1,
            origin: "user" as const,
            isHead: true,
            state: "pending" as const,
            preview: { text: "Next request" },
            attachmentCount: 0,
            taskCount: 0,
            createdAt: "2026-07-30T10:02:00.000Z",
          },
        ]
      : [...input.queue],
  );
  const interaction = {
    id: "interaction-1",
    threadId: "thread-1",
    sourceLabel: { text: "Tool" },
    title: { text: "Approve?" },
    kind: "confirmation" as const,
    message: { text: "Allow the operation?" },
    openedAt: "2026-07-30T10:03:00.000Z",
    secret: false,
    destructive: true,
    cancellable: true,
  };
  const mutate = vi.fn(
    async (
      _scope: typeof scope,
      _threadId: string,
      operation: ThreadApplicationOperation,
    ) =>
      input?.mutation?.(operation) ??
      Promise.resolve({ status: "completed" as const }),
  );
  const presentation = async () => ({
    revision: "presentation-2",
    backend: {
      label: { text: "Coding agent" },
      modelLabel: { text: "Model" },
    },
    interactionMode: input?.interactionMode ?? "interactive",
    automationAllowed: input?.automationAllowed,
    nextTurnSettingIds: input?.nextTurnSettingIds,
    providerFeatureCapabilities:
      input?.providerFeatureCapabilities === undefined
        ? []
        : [...input.providerFeatureCapabilities],
    providerFeatureStates: [],
    settings: {
      revision: 4,
      values: [
        {
          id: "model" as const,
          desiredValue:
            input?.modelValue === undefined ? "model-1" : input.modelValue,
          effectiveValue:
            input?.modelValue === undefined ? "model-1" : input.modelValue,
          applicationState: "effective" as const,
        },
      ],
    },
    settingDescriptors: [
      {
        id: "model" as const,
        label: { text: "Model" },
        requiredForFirstSubmission: true,
        options: [
          {
            value: "model-1",
            label: { text: "Model 1" },
            available: true,
          },
        ],
        available: true,
      },
    ],
    composerCommands: [
      {
        invocation: "/review",
        source: "prompt" as const,
        description: { text: "Review changes" },
      },
    ],
    skills: [],
  });
  const readPresentation = vi.fn(presentation);
  const readCachedPresentation = vi.fn(presentation);
  const service = new ThreadApplicationService({
    usage: { registerVisibleTurns: () => undefined },
    inventory: { getAuthorized },
    conversations: { capture },
    queue: { list },
    presentation: {
      read: readPresentation,
      readCached: readCachedPresentation,
    },
    recovery: {
      read: async () => input?.recovery,
      hasPendingDelivery: async () => input?.pendingDelivery ?? false,
    },
    interactions: {
      listPending: () =>
        input?.includeInteraction === false
          ? []
          : [input?.interaction ?? interaction],
    },
    actionPersistence: new Map([
      [
        state.backendInstanceId,
        {
          providerFeatureConcurrency:
            input?.providerFeatureConcurrency ??
            (() => QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY),
        } as never,
      ],
    ]),
    attachmentDelivery: {
      supports: () => input?.attachmentStagingAvailable ?? false,
    },
    mutations: { mutate },
  });
  service.bindHistory({
    operational: (actor) => actor !== undefined,
    window: () => ({ hasOlder: false }),
  });
  return {
    getAuthorized,
    capture,
    list,
    mutate,
    readPresentation,
    readCachedPresentation,
    service,
  };
}

describe("ThreadApplicationService", () => {
  it("exposes reconciliation for an uncertain queue without a thread recovery receipt", async () => {
    const queued = {
      id: "uncertain-head", sequence: 1, state: "uncertain", isHead: true,
      origin: "user", resolvedDeliveryMode: "submit", deliveryMode: "submit", deliveryOperationId: "submission-1",
      preview: { text: "Earlier input" }, attachmentCount: 0, taskCount: 0,
      createdAt: "2026-09-17T20:32:52.000Z",
    } as const;
    const { service } = createService({ runState: "idle", queue: [queued] });
    const result = await service.snapshot(scope, "thread-1");
    expect(result.recovery).toBeUndefined();
    expect(result.capabilities.operations.find(({ id }) => id === "recover_uncertain")).toMatchObject({ available: true });
    const cleared = await createService({ runState: "idle", queue: [] }).service.snapshot(scope, "thread-1");
    expect(cleared.capabilities.operations.find(({ id }) => id === "recover_uncertain")).toMatchObject({ available: true });
  });

  it("keeps transcript capture readable while an unavailable project disables new work", async () => {
    const state = inventory();
    const current = createService({ state: { ...state, workspace: { ...state.workspace, available: false } } });
    const snapshot = await current.service.snapshot(scope, "thread-1");
    expect(current.capture).toHaveBeenCalledOnce();
    expect(snapshot.workspace.available).toBe(false);
    expect(snapshot.thread.inventoryState).toBe("active");
    expect(snapshot.capabilities.deliveryModes.every(mode => !mode.available)).toBe(true);
    expect(snapshot.capabilities.automation.available).toBe(false);
    expect(snapshot.capabilities.operations.find(operation => operation.id === "rename")?.available).toBe(false);
    expect(snapshot.forkSource.selectedCompletedTurn.available).toBe(false);
  });

  it("withholds native image capability when attachment staging is unavailable", async () => {
    const unavailable = createService({
      runState: "idle",
      queue: [],
      composerAttachments: { fileStaging: true, nativeImage: true },
      attachmentStagingAvailable: false,
    });

    const snapshot = await unavailable.service.snapshot(scope, "thread-1");

    expect(snapshot.capabilities.composerAttachments).toMatchObject({
      fileStaging: { availability: "unavailable" },
      nativeImage: { availability: "unavailable" },
    });
  });

  it("makes every composer delivery mode unavailable while Pi materialization is pending", async () => {
    const base = createService({
      runState: "running",
      includeInteraction: false,
      deliveryModes: ["submit", "steer"],
      steerTarget: "turn",
    });
    const pending = createService({
      runState: "running",
      includeInteraction: false,
      deliveryModes: ["submit", "steer"],
      steerTarget: "turn",
      pendingDelivery: true,
    });

    const [baseSnapshot, pendingSnapshot] = await Promise.all([
      base.service.snapshot(scope, "thread-1"),
      pending.service.snapshot(scope, "thread-1"),
    ]);

    expect(
      pendingSnapshot.capabilities.deliveryModes.find(
        ({ id }) => id === "steer",
      ),
    ).toMatchObject({
      available: false,
      unavailableReason: {
        text: "Wait for the previous steering input to appear before steering again.",
      },
    });
    expect(
      pendingSnapshot.capabilities.deliveryModes.every(
        ({ available }) => !available,
      ),
    ).toBe(true);
    expect(
      pendingSnapshot.capabilities.deliveryModes.find(
        ({ id }) => id === "queue",
      ),
    ).toMatchObject({
      available: false,
      unavailableReason: {
        text: "Wait for the previous steering input to appear before queueing more input.",
      },
    });
    expect(pendingSnapshot.capabilities.revision).not.toBe(
      baseSnapshot.capabilities.revision,
    );
  });

  it("uses only cached durable presentation for application-state captures", async () => {
    const bound = createService({ runState: "idle", queue: [] });
    const captured = await bound.capture();
    if (captured.status !== "connected") {
      throw new Error("expected connected actor capture");
    }
    const base = inventory();
    const unbound = createService({
      runState: "idle",
      queue: [],
      state: {
        ...base,
        thread: { ...base.thread, backingState: "unbound" },
      },
    });

    await unbound.service.applicationState(scope, "thread-1");
    await bound.service.applicationStateFromActorCapture(
      scope,
      "thread-1",
      captured.state,
    );

    expect(unbound.capture).not.toHaveBeenCalled();
    expect(unbound.readPresentation).not.toHaveBeenCalled();
    expect(bound.readPresentation).not.toHaveBeenCalled();
    expect(unbound.readCachedPresentation).toHaveBeenCalledOnce();
    expect(bound.readCachedPresentation).toHaveBeenCalledOnce();
  });

  it("composes targeted capabilities and fork state identically to the actor snapshot", async () => {
    const current = createService({ runState: "idle", queue: [] });
    const captured = await current.capture();
    if (captured.status !== "connected") {
      throw new Error("expected connected actor capture");
    }
    const snapshot = await current.service.snapshotFromActorCapture(
      scope,
      "thread-1",
      captured.state,
    );
    expect(snapshot.backendSessionId).toBe("backend-session-1");
    expect(snapshot.agentTools).toEqual(inventory().agentTools);

    const targeted =
      await current.service.capabilitiesAndProviderFeaturesFromActorCapture(
        scope,
        "thread-1",
        captured.state,
      );
    expect(targeted.capabilities).toEqual(snapshot.capabilities);
    expect(targeted.providerFeatures).toEqual(snapshot.providerFeatures);
    await expect(
      current.service.forkSourceFromActorCapture(
        scope,
        "thread-1",
        captured.state,
      ),
    ).resolves.toEqual(snapshot.forkSource);
  });

  it("keeps fork creation unavailable while source work is queued", async () => {
    const queued = await createService({ runState: "idle" }).service.snapshot(
      scope,
      "thread-1",
    );
    expect(queued.forkSource).toEqual({
      selectedCompletedTurn: {
        available: false,
        unavailableReason: {
          text: "Resolve or cancel queued source work before forking.",
        },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: {
          text: "Resolve or cancel queued source work before forking.",
        },
      },
    });

    const clear = await createService({
      runState: "idle",
      queue: [],
    }).service.snapshot(scope, "thread-1");
    expect(clear.forkSource).toEqual({
      selectedCompletedTurn: { available: true },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: {
          text: "This backend cannot fork its latest provider snapshot.",
        },
      },
    });
  });

  it("keeps active-source historical forking capability-aware", async () => {
    const supported = await createService({
      runState: "running",
      queue: [],
      sourceMustBeIdle: false,
    }).service.snapshot(scope, "thread-1");
    expect(supported.forkSource).toEqual({
      selectedCompletedTurn: { available: true },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: {
          text: "This backend cannot fork its latest provider snapshot.",
        },
      },
    });

    const idleOnly = await createService({
      runState: "running",
      queue: [],
      sourceMustBeIdle: true,
    }).service.snapshot(scope, "thread-1");
    expect(idleOnly.forkSource).toEqual({
      selectedCompletedTurn: {
        available: false,
        unavailableReason: {
          text: "The source thread must be idle before it can be forked.",
        },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: {
          text: "This backend cannot fork its latest provider snapshot.",
        },
      },
    });

    const reconciling = await createService({
      runState: "reconciling",
      queue: [],
      sourceMustBeIdle: false,
    }).service.snapshot(scope, "thread-1");
    expect(reconciling.forkSource).toEqual({
      selectedCompletedTurn: {
        available: false,
        unavailableReason: {
          text: "The source thread must be idle before it can be forked.",
        },
      },
      latestProviderSnapshot: {
        available: false,
        unavailableReason: {
          text: "This backend cannot fork its latest provider snapshot.",
        },
      },
    });
  });

  it("composes a complete normalized snapshot from scoped durable and actor state", async () => {
    const { service } = createService();
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(snapshot).toMatchObject({
      thread: {
        id: "thread-1",
        runState: "waiting_for_approval",
        queuedInputCount: 1,
      },
      runState: "waiting_for_approval",
      activeTurnId: "turn-1",
      orderedTurnIds: ["turn-1"],
      queue: [{ id: "queue-1", state: "pending" }],
      settings: { revision: 4 },
      usage: { context: { usedTokens: 25, windowTokens: 100 } },
      interactions: [{ id: "interaction-1", kind: "confirmation" }],
      attention: {
        unseenCompletion: { operationId: "operation-1" },
      },
    });
    expect(snapshot.capabilities).toMatchObject({
      backend: { label: { text: "Coding agent" } },
      runState: "waiting_for_approval",
      history: { available: true, paginated: true },
      automation: { canCloneOnRun: true },
    });
    expect(
      snapshot.capabilities.deliveryModes.find(({ id }) => id === "steer"),
    ).toMatchObject({
      available: false,
      unavailableReason: {
        text: "The active backend turn cannot be steered.",
      },
    });
    expect(
      snapshot.capabilities.deliveryModes.find(({ id }) => id === "queue"),
    ).toMatchObject({ available: true });
    expect(
      snapshot.capabilities.operations.find(({ id }) => id === "interrupt"),
    ).toMatchObject({
      available: true,
      label: { text: "Stop" },
    });
    expect(snapshot.capabilities.settings).toEqual([
      expect.objectContaining({ id: "model", available: false }),
    ]);
    expect(snapshot.composerCommands).toEqual([
      expect.objectContaining({ invocation: "/review" }),
    ]);
    expect(snapshot.history).toEqual({ hasOlder: false });
    expect(
      snapshot.capabilities.interactions.find(
        ({ kind }) => kind === "text_input",
      ),
    ).toBeUndefined();
  });

  it("does not acquire a backend conversation for a server-side draft", async () => {
    const { service, capture } = createService({
      state: inventory("unbound"),
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(capture).not.toHaveBeenCalled();
    expect(snapshot).toMatchObject({
      runState: "idle",
      orderedTurnIds: [],
      usage: {},
      interactions: [{ id: "interaction-1" }],
    });
    expect(
      snapshot.capabilities.deliveryModes.find(({ id }) => id === "submit"),
    ).toMatchObject({ available: true });
    expect(snapshot.capabilities.settings).toEqual([
      expect.objectContaining({ id: "model", available: true }),
    ]);
    expect(snapshot.capabilities.automation).toMatchObject({
      available: true,
      canAttach: true,
    });
    expect(snapshot.capabilities.history.available).toBe(false);
  });

  it("requires an available explicit model before a server-side draft can send", async () => {
    const { service } = createService({
      state: inventory("unbound"),
      modelValue: null,
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(
      snapshot.capabilities.deliveryModes.find(({ id }) => id === "submit"),
    ).toMatchObject({
      available: false,
      unavailableReason: {
        text: "Choose the required thread settings before sending.",
      },
    });
  });

  it("requires resolved desired settings before a bound idle thread can send", async () => {
    const { service } = createService({
      runState: "idle",
      modelValue: null,
      queue: [],
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(
      snapshot.capabilities.deliveryModes.find(({ id }) => id === "submit"),
    ).toMatchObject({
      available: false,
      unavailableReason: {
        text: "Choose the required thread settings before sending.",
      },
    });
  });

  it("requires resolved desired settings before a bound active thread can queue input", async () => {
    const { service } = createService({
      runState: "running",
      modelValue: null,
      queue: [],
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(
      snapshot.capabilities.deliveryModes.find(({ id }) => id === "queue"),
    ).toMatchObject({
      available: false,
      unavailableReason: {
        text: "Choose the required thread settings before queueing input.",
      },
    });
  });

  it.each([
    {
      queueState: "failed" as const,
      settingsAvailable: true,
      featureAvailability: "available",
    },
    {
      queueState: "pending" as const,
      settingsAvailable: false,
      featureAvailability: "read_only",
    },
  ])(
    "treats a $queueState queue row correctly when deriving next-turn mutability",
    async ({ queueState, settingsAvailable, featureAvailability }) => {
      const { service } = createService({
        runState: "idle",
        queue: [
          {
            id: "queue-1",
            deliveryOperationId: "queue-operation-1",
            resolvedDeliveryMode: "queue" as const,
            sequence: 1,
            origin: "user" as const,
            isHead: true,
            state: queueState,
            preview: { text: "Next request" },
            attachmentCount: 0,
            taskCount: 0,
            createdAt: "2026-07-30T10:02:00.000Z",
            ...(queueState === "failed"
              ? { diagnostic: { text: "Dispatch was rejected." } }
              : {}),
          },
        ],
        nextTurnSettingIds: ["model"],
        providerFeatureCapabilities: [
          {
            ref: { featureId: "test.preference", schemaVersion: 1 },
            revision: 1,
            label: { text: "Preference" },
            availability: "available",
            operations: [
              {
                actionId: "set",
                label: { text: "Set" },
                effects: {
                  application: "write",
                  modelUsage: "none",
                  external: "none",
                },
                confirmation: "none",
                execution: "inline",
              },
            ],
            presentationSlots: ["thread_details"],
          },
        ],
      });
      const snapshot = await service.snapshot(scope, "thread-1");

      expect(
        snapshot.capabilities.settings.find(({ id }) => id === "model"),
      ).toMatchObject({ available: settingsAvailable });
      expect(snapshot.capabilities.providerFeatures).toEqual([
        expect.objectContaining({ availability: featureAvailability }),
      ]);
    },
  );

  it("does not let concurrent disposition override recovery, archive, or application availability", async () => {
    const ordinary = inventory();
    const cases = [
      {
        name: "recovery",
        recovery: {
          kind: "operation_uncertain" as const,
          operationCategory: "other" as const,
          diagnostic: { text: "The mutation outcome is uncertain." },
          submissionMayHaveBeenAccepted: false,
          recoverable: false,
        },
      },
      {
        name: "archive",
        state: {
          ...ordinary,
          thread: { ...ordinary.thread, inventoryState: "archived" as const },
        },
      },
      {
        name: "application availability",
        state: {
          ...ordinary,
          thread: { ...ordinary.thread, available: false },
        },
      },
    ];

    for (const current of cases) {
      const snapshot = await createService({
        runState: "idle",
        includeInteraction: false,
        queue: [],
        ...(current.state ? { state: current.state } : {}),
        ...(current.recovery ? { recovery: current.recovery } : {}),
        providerFeatureCapabilities: [mutableProviderFeature("codex.tui")],
        providerFeatureConcurrency: concurrentTuiAndQuietPreference,
      }).service.snapshot(scope, "thread-1");

      expect(
        snapshot.capabilities.providerFeatures[0],
        current.name,
      ).toMatchObject({ availability: "read_only" });
    }
  });

  it("keeps concurrent actions available through every active run state while quiet actions remain read-only", async () => {
    const textInput: BackendInteraction = {
      id: "interaction-text",
      threadId: "thread-1",
      sourceLabel: { text: "Tool" },
      title: { text: "Provide input" },
      kind: "text_input",
      openedAt: "2026-07-30T10:03:00.000Z",
      secret: false,
      destructive: false,
      cancellable: true,
      multiline: false,
    };
    const cases = [
      { runState: "starting" as const, includeInteraction: false },
      { runState: "running" as const, includeInteraction: false },
      { runState: "running" as const, expected: "waiting_for_approval" },
      {
        runState: "running" as const,
        interaction: textInput,
        expected: "waiting_for_input",
      },
      { runState: "stopping" as const, includeInteraction: false },
    ];

    for (const current of cases) {
      const snapshot = await createService({
        runState: current.runState,
        queue: [],
        ...(current.includeInteraction === undefined
          ? {}
          : { includeInteraction: current.includeInteraction }),
        ...(current.interaction ? { interaction: current.interaction } : {}),
        providerFeatureCapabilities: [
          mutableProviderFeature("codex.tui"),
          mutableProviderFeature("codex.execution"),
        ],
        providerFeatureConcurrency: concurrentTuiAndQuietPreference,
      }).service.snapshot(scope, "thread-1");

      expect(snapshot.runState).toBe(current.expected ?? current.runState);
      expect(snapshot.capabilities.providerFeatures).toEqual([
        expect.objectContaining({
          ref: { featureId: "codex.tui", schemaVersion: 1 },
          availability: "available",
        }),
        expect.objectContaining({
          ref: { featureId: "codex.execution", schemaVersion: 1 },
          availability: "read_only",
        }),
      ]);
    }
  });

  it.each(["decision", "editor", "questionnaire"] as const)(
    "keeps %s gates authoritative through bridge publication, native status, resolution and reconnect",
    async (kind) => {
      const base = {
        id: "interaction-1",
        threadId: "thread-1",
        sourceLabel: { text: "Tool" },
        title: { text: "Approval" },
        openedAt: "2026-07-30T10:03:00.000Z",
        secret: false,
        destructive: false,
        cancellable: true,
      };
      const interaction: BackendInteraction =
        kind === "decision"
          ? {
              ...base,
              kind,
              actions: [
                { id: "accept", label: { text: "Approve" }, role: "primary" },
              ],
            }
          : kind === "editor"
            ? { ...base, kind, initialValue: { text: "{}" }, language: "json" }
            : {
                ...base,
                kind,
                questions: [
                  {
                    id: "question-1",
                    header: { text: "Name" },
                    prompt: { text: "Enter name" },
                    secret: false,
                    input: { kind: "text", multiline: false },
                  },
                ],
              };
      const options = {
        runState: "running" as const,
        interaction,
        includeInteraction: false,
        queue: [],
      };
      const { service, capture, readPresentation } = createService(options);
      const captured = await capture();
      if (captured.status !== "connected")
        throw new Error("fixture disconnected");
      let current = captured.state;
      let listener!: ConversationActorListener;
      const hub = new ThreadEventHub();
      const client = new NormalizedThreadStore();
      const failures: unknown[] = [];
      const unsubscribe = hub.subscribe((event) => {
        expect(client.apply(event).kind).not.toBe("resnapshot_required");
      });
      const binding = new ConversationEventBridge(
        new ThreadEventPresentation(service), () => undefined
      ).bind({
        scope,
        applicationThreadId: "thread-1",
        hub,
        actor: {
          subscribe(next) {
            listener = next;
            next({ type: "projection_replaced", state: current });
            return () => {};
          },
        },
        captureAuthoritativeState: async () => current,
        onFailure: (error) => {
          failures.push(error);
        },
      });
      try {
        await binding.ready;
        client.confirmReplayCaughtUp();
        expect(client.state.authoritative).toBe(true);
        options.includeInteraction = true;
        binding.opened(scope, "thread-1", "generation-1", interaction);
        const waiting =
          kind === "decision" ? "waiting_for_approval" : "waiting_for_input";
        await vi.waitFor(() =>
          expect(hub.currentCheckpoint()?.capabilityRunState).toBe(waiting),
        );
        expect(client.state.authoritative).toBe(true);
        expect(client.state.snapshot?.runState).toBe(waiting);
        expect(client.state.snapshot?.capabilities.interactions).toContainEqual({
          kind,
          available: true,
        });

        // Codex reports native active/running even while its reverse request is pending.
        listener({
          type: "projection_events",
          generation: "generation-1",
          events: [
            {
              type: "run_state",
              generation: "generation-1",
              state: "running",
              activeTurnId: "turn-1",
            },
          ],
        });
        listener({
          type: "backend_event",
          generation: "generation-1",
          event: {
            type: "capabilities_changed",
            capabilities: current.backendCapabilities,
          },
        });
        await vi.waitFor(() => expect(hub.watermark).toBeGreaterThan(4));
        expect(client.state.snapshot?.runState).toBe(waiting);
        expect(client.state.authoritative).toBe(true);

        const reconnected = new NormalizedThreadStore();
        expect(reconnected.applyCheckpoint(hub.currentCheckpoint()!).kind).toBe(
          "applied",
        );
        reconnected.confirmReplayCaughtUp();
        expect(reconnected.state.authoritative).toBe(true);
        expect(reconnected.state.snapshot?.interactions).toEqual([interaction]);

        options.includeInteraction = false;
        binding.resolved(scope, "thread-1", "generation-1", interaction.id);
        await vi.waitFor(() => expect(hub.snapshot?.interactions).toEqual([]));
        expect(client.state.snapshot?.runState).toBe("running");
        expect(client.state.authoritative).toBe(true);
        expect(hub.currentCheckpoint()?.capabilityRunState).toBe("running");

        // The broker can resolve a gate while asynchronous presentation reads
        // are pending. Publish the authoritative current set, not the queued
        // opening callback's obsolete payload.
        const presentation = await readPresentation();
        let compositionStarted = false;
        let releaseComposition!: () => void;
        const compositionGate = new Promise<void>((resolve) => {
          releaseComposition = resolve;
        });
        readPresentation.mockImplementationOnce(async () => {
          compositionStarted = true;
          await compositionGate;
          return presentation;
        });
        const transientPublications: unknown[] = [];
        const transientSubscription = hub.subscribe((event) => {
          if (event.event.type === "interaction_opened")
            transientPublications.push(event.event);
        });
        options.includeInteraction = true;
        binding.opened(scope, "thread-1", "generation-1", interaction);
        await vi.waitFor(() => expect(compositionStarted).toBe(true));
        options.includeInteraction = false;
        binding.resolved(scope, "thread-1", "generation-1", interaction.id);
        // The actor capture can also be ahead of its queued terminal events.
        current = {
          ...current,
          timeline: {
            ...current.timeline,
            runState: "idle",
            activeTurnId: undefined,
          },
        };
        listener({
          type: "projection_events",
          generation: "generation-1",
          events: [
            { type: "run_state", generation: "generation-1", state: "idle" },
          ],
        });
        listener({
          type: "backend_event",
          generation: "generation-1",
          event: {
            type: "capabilities_changed",
            capabilities: current.backendCapabilities,
          },
        });
        releaseComposition();
        await vi.waitFor(() =>
          expect(hub.currentCheckpoint()?.capabilityRunState).toBe("idle"),
        );
        // Wait for the queued run-state event to clear the old active turn too.
        await vi.waitFor(() =>
          expect(hub.snapshot?.activeTurnId).toBeUndefined(),
        );
        expect(client.state.authoritative).toBe(true);
        expect(client.state.snapshot?.interactions).toEqual([]);
        expect(transientPublications).toEqual([]);
        transientSubscription.close();

        current = {
          ...current,
          timeline: { ...current.timeline, generation: "generation-2" },
        };
        listener({ type: "projection_replaced", state: current });
        await vi.waitFor(() =>
          expect(hub.projectionGeneration).toBe("generation-2"),
        );
        const watermark = hub.watermark;
        binding.opened(scope, "thread-1", "generation-1", interaction);
        binding.resolved(scope, "thread-1", "generation-1", interaction.id);
        await binding.release();
        expect(hub.watermark).toBe(watermark);
        expect(hub.snapshot?.interactions).toEqual([]);
        expect(failures).toEqual([]);
      } finally {
        unsubscribe.close();
        await binding.release();
      }
    },
  );

  it("treats an application-owned decision as approval even when the backend does not advertise decisions", async () => {
    const interaction: BackendInteraction = {
      id: "application-decision",
      threadId: "thread-1",
      sourceLabel: { text: "Sedes" },
      title: { text: "Allow access to another environment?" },
      kind: "decision",
      openedAt: "2026-08-13T10:03:00.000Z",
      secret: false,
      destructive: false,
      cancellable: true,
      actions: [
        { id: "allow", label: { text: "Allow once" }, role: "primary" },
        { id: "deny", label: { text: "Deny" }, role: "reject" },
      ],
    };
    const snapshot = await createService({
      runState: "running",
      interaction,
      interactionKinds: [],
      queue: [],
    }).service.snapshot(scope, "thread-1");

    expect(snapshot.runState).toBe("waiting_for_approval");
    expect(snapshot.capabilities.interactions).toContainEqual({
      kind: "decision",
      available: true,
    });
  });

  it("filters a mixed feature per action instead of widening its quiet action", async () => {
    const feature = mutableProviderFeature("test.mixed");
    const snapshot = await createService({
      runState: "running",
      includeInteraction: false,
      queue: [],
      providerFeatureCapabilities: [
        {
          ...feature,
          operations: [
            { ...feature.operations[0]!, actionId: "observe" },
            { ...feature.operations[0]!, actionId: "reconfigure" },
          ],
        },
      ],
      providerFeatureConcurrency: (_ref, actionId) =>
        actionId === "observe"
          ? CONCURRENT_PROVIDER_FEATURE_CONCURRENCY
          : QUIET_THREAD_PROVIDER_FEATURE_CONCURRENCY,
    }).service.snapshot(scope, "thread-1");

    expect(snapshot.capabilities.providerFeatures[0]).toMatchObject({
      availability: "available",
      operations: [{ actionId: "observe" }],
    });
  });

  it.each(["pending", "retry_wait", "dispatching"] as const)(
    "keeps concurrent actions available while a %s queue row blocks quiet actions",
    async (queueState) => {
      const snapshot = await createService({
        runState: "idle",
        includeInteraction: false,
        queue: [
          {
            id: "queue-1",
            deliveryOperationId: "queue-operation-1",
            resolvedDeliveryMode: "queue" as const,
            sequence: 1,
            origin: "user" as const,
            isHead: true,
            state: queueState,
            ...(queueState === "dispatching"
              ? { deliveryMode: "submit" as const }
              : {}),
            preview: { text: "Next request" },
            attachmentCount: 0,
            taskCount: 0,
            createdAt: "2026-07-30T10:02:00.000Z",
          },
        ],
        providerFeatureCapabilities: [
          mutableProviderFeature("codex.tui"),
          mutableProviderFeature("codex.execution"),
        ],
        providerFeatureConcurrency: concurrentTuiAndQuietPreference,
      }).service.snapshot(scope, "thread-1");

      expect(snapshot.capabilities.providerFeatures).toEqual([
        expect.objectContaining({ availability: "available" }),
        expect.objectContaining({ availability: "read_only" }),
      ]);
    },
  );

  it.each([
    { name: "disconnected", disconnected: true },
    { name: "reconciling", runState: "reconciling" as const },
  ])(
    "does not let concurrent disposition override a $name backend transition",
    async (current) => {
      const snapshot = await createService({
        ...current,
        includeInteraction: false,
        queue: [],
        providerFeatureCapabilities: [mutableProviderFeature("codex.tui")],
        providerFeatureConcurrency: concurrentTuiAndQuietPreference,
      }).service.snapshot(scope, "thread-1");

      expect(snapshot.capabilities.providerFeatures[0]).toMatchObject({
        availability: "read_only",
      });
    },
  );

  it.each(["creating", "creation_unknown"] as const)(
    "does not advertise submit while a %s first-send must be recovered",
    async (backingState) => {
      const { service, capture } = createService({
        state: inventory(backingState),
      });
      const snapshot = await service.snapshot(scope, "thread-1");

      expect(capture).not.toHaveBeenCalled();
      expect(
        snapshot.capabilities.deliveryModes.find(({ id }) => id === "submit"),
      ).toBeUndefined();
    },
  );

  it("treats a failed settled backend as restartable", async () => {
    const { service } = createService({ runState: "failed" });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(snapshot.runState).toBe("failed");
    expect(
      snapshot.capabilities.deliveryModes.find(({ id }) => id === "submit"),
    ).toMatchObject({ available: true });
    expect(
      snapshot.capabilities.operations.find(({ id }) => id === "compact"),
    ).toMatchObject({ available: true });
    expect(snapshot.capabilities.settings).toEqual([
      expect.objectContaining({ id: "model", available: true }),
    ]);
    expect(snapshot.capabilities.automation.canCloneOnRun).toBe(true);
  });

  it("keeps stored automation manageable while a backend policy blocks new runs", async () => {
    const state = inventory();
    const { service } = createService({
      state: {
        ...state,
        thread: {
          ...state.thread,
          automation: {
            status: "enabled",
            runMode: "same_thread",
            scheduleKind: "interval",
            nextRunAt: "2026-07-30T11:00:00.000Z",
            revision: 1,
            hasPrecheck: false,
          },
        },
      },
      automationAllowed: false,
      includeInteraction: false,
      queue: [],
      runState: "idle",
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(snapshot.capabilities.automation).toMatchObject({
      available: true,
      canAttach: false,
      canRunNow: false,
      canCloneOnRun: false,
    });
    expect(
      snapshot.capabilities.operations.find(
        ({ id }) => id === "remove_automation",
      ),
    ).toMatchObject({ available: true });
  });

  it("honors a bound backend that does not support submit", async () => {
    const { service } = createService({
      runState: "idle",
      deliveryModes: ["steer"],
      steerTarget: "turn",
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(
      snapshot.capabilities.deliveryModes.find(({ id }) => id === "submit"),
    ).toBeUndefined();
  });

  it("offers durable Queue but no Steer for an active submit-only backend", async () => {
    const { service } = createService({
      runState: "running",
      deliveryModes: ["submit"],
      steerTarget: null,
      queue: [],
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(
      snapshot.capabilities.deliveryModes.find(({ id }) => id === "queue"),
    ).toMatchObject({ available: true });
    expect(
      snapshot.capabilities.deliveryModes.find(({ id }) => id === "steer"),
    ).toBeUndefined();
  });

  it("does not expose rename for an interactive bound backend that omits the action", async () => {
    const { service } = createService({
      runState: "idle",
      actions: ["compact"],
      interactionMode: "interactive",
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(
      snapshot.capabilities.operations.find(({ id }) => id === "rename"),
    ).toBeUndefined();
    expect(
      snapshot.capabilities.operations.find(({ id }) => id === "compact"),
    ).toMatchObject({ available: true });
  });

  it("omits provider controls for a bound read-only backend", async () => {
    const { service } = createService({
      runState: "idle",
      actions: [],
      deliveryModes: [],
      steerTarget: null,
      interactionKinds: [],
      branchingAvailable: false,
      interactionMode: "read_only",
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(snapshot.capabilities.deliveryModes).toEqual([]);
    expect(snapshot.capabilities.interactionMode).toBe("read_only");
    expect(snapshot.capabilities.interactions).toEqual([]);
    expect(snapshot.capabilities.operations.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([
        "rename",
        "compact",
        "interrupt",
        "clone",
        "attach_automation",
      ]),
    );
    expect(snapshot.capabilities.automation).toMatchObject({
      available: false,
      canAttach: false,
      canRunNow: false,
    });
  });

  it("keeps a read-only unbound thread free of provider and draft controls", async () => {
    const { service } = createService({
      state: inventory("unbound"),
      runState: "idle",
      actions: ["rename"],
      deliveryModes: ["submit", "steer"],
      steerTarget: "turn",
      interactionKinds: ["choice", "confirmation"],
      branchingAvailable: true,
      interactionMode: "read_only",
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(snapshot.capabilities.interactionMode).toBe("read_only");
    expect(snapshot.capabilities.deliveryModes).toEqual([]);
    expect(snapshot.capabilities.interactions).toEqual([]);
    expect(snapshot.capabilities.operations.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining([
        "rename",
        "move_draft",
        "compact",
        "interrupt",
        "clone",
        "attach_automation",
      ]),
    );
  });

  it("preserves application-owned state while presenting a bound backend as disconnected", async () => {
    const { service } = createService({ disconnected: true });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(snapshot.runState).toBe("disconnected");
    expect(snapshot.capabilities.interactionMode).toBe("interactive");
    expect(snapshot.draft.text).toBe("later");
    expect(snapshot.stashes).toHaveLength(1);
    expect(snapshot.queue).toHaveLength(1);
    for (const operationId of ["archive", "settle", "snooze"] as const) {
      expect(
        snapshot.capabilities.operations.find(({ id }) => id === operationId),
      ).toMatchObject({ available: false });
    }
  });

  it("keeps every backend and inventory mutation unavailable while reconciling", async () => {
    const { service } = createService({
      runState: "reconciling",
      actions: ["rename", "compact"],
      deliveryModes: ["submit", "steer"],
      steerTarget: "turn",
      interactionKinds: ["choice", "confirmation"],
      branchingAvailable: true,
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(snapshot.runState).toBe("reconciling");
    expect(snapshot.capabilities.interactionMode).toBe("interactive");
    expect(
      snapshot.capabilities.operations
        .filter(({ id }) =>
          ["rename", "compact", "archive", "settle", "snooze"].includes(id),
        )
        .every(({ available }) => !available),
    ).toBe(true);
    expect(
      snapshot.capabilities.deliveryModes.every(({ available }) => !available),
    ).toBe(true);
    expect(
      snapshot.capabilities.interactions.every(({ available }) => !available),
    ).toBe(true);
    expect(snapshot.capabilities.automation).toMatchObject({
      available: false,
      canAttach: false,
      canRunNow: false,
      canCloneOnRun: false,
    });
  });

  it("does not acquire or offer backend delivery when the inventory target is unavailable", async () => {
    const state = inventory();
    const { service, capture } = createService({
      state: {
        ...state,
        thread: { ...state.thread, available: false },
      },
    });
    const snapshot = await service.snapshot(scope, "thread-1");

    expect(capture).not.toHaveBeenCalled();
    expect(snapshot.runState).toBe("disconnected");
    expect(
      snapshot.capabilities.deliveryModes.every(({ available }) => !available),
    ).toBe(true);
    expect(snapshot.capabilities.automation.available).toBe(false);
  });

  it("rejects a mismatched authorization result before reading runtime state", async () => {
    const mismatched = {
      ...inventory(),
      ownerPrincipalId: "another-principal",
    };
    const { service, capture, list } = createService({ state: mismatched });

    await expect(service.snapshot(scope, "thread-1")).rejects.toThrow(
      "thread_application_scope_mismatch",
    );
    expect(capture).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it("authorizes backend-neutral mutations before delegating them", async () => {
    const operation: ThreadApplicationOperation = {
      kind: "deliver",
      mode: "queue",
      mutationId: "mutation-1",
      expectedThreadRevision: 7,
      expectedDraftRevision: 3,
    };
    const { service, mutate, getAuthorized } = createService({
      mutation: async () => ({
        status: "queued",
        queuedInputId: "queue-1",
      }),
    });

    await expect(service.mutate(scope, "thread-1", operation)).resolves.toEqual(
      { status: "queued", queuedInputId: "queue-1" },
    );
    expect(getAuthorized).toHaveBeenCalledBefore(mutate);
    expect(mutate).toHaveBeenCalledWith(scope, "thread-1", operation);
  });

  it("composes a bridge snapshot from the supplied actor generation without reacquiring", async () => {
    const { service, capture } = createService();
    const result = await capture();
    if (result.status !== "connected") throw new Error("expected_capture");
    capture.mockClear();

    const snapshot = await service.snapshotFromActorCapture(scope, "thread-1", {
      ...result.state,
      timeline: {
        ...result.state.timeline,
        generation: "bridge-generation",
      },
      usage: { counters: { userMessages: 19 } },
    });

    expect(capture).not.toHaveBeenCalled();
    expect(snapshot.usage).toEqual({ counters: { userMessages: 19 } });
    expect(snapshot.orderedTurnIds).toEqual(["turn-1"]);
  });

  it("changes capability revision for draft, attention, and recovery changes", async () => {
    const first = createService({
      runState: "idle",
      state: inventory(),
    });
    const changedState = inventory();
    const second = createService({
      runState: "idle",
      state: {
        ...changedState,
        draft: { ...changedState.draft, revision: 4 },
        attention: {},
      },
      recovery: {
        kind: "conversation_creation",
        creationType: "first_input",
        phase: "recovery_required",
        diagnostic: { text: "Needs reconciliation." },
        submissionMayHaveBeenAccepted: true,
        forkUncertainty: null,
        possibleProviderOrphan: null,
        recoverable: true,
      },
    });

    const [before, after] = await Promise.all([
      first.service.snapshot(scope, "thread-1"),
      second.service.snapshot(scope, "thread-1"),
    ]);
    expect(after.capabilities.revision).not.toBe(before.capabilities.revision);
  });

  it("emits recovery commands for uncertain operations and creation attempts", async () => {
    const { service } = createService({
      runState: "idle",
      recovery: {
        kind: "operation_uncertain",
        operationCategory: "compaction",
        diagnostic: { text: "The action outcome is unknown." },
        submissionMayHaveBeenAccepted: false,
        recoverable: true,
      },
    });

    const snapshot = await service.snapshot(scope, "thread-1");

    expect(
      snapshot.capabilities.operations.find(
        ({ id }) => id === "recover_uncertain",
      ),
    ).toMatchObject({
      available: true,
      label: { text: "Reconcile operation" },
      parameters: { kind: "none" },
    });

    const creation = createService({
      runState: "idle",
      recovery: {
        kind: "conversation_creation",
        creationType: "first_input",
        phase: "recovery_required",
        diagnostic: { text: "Settings could not be applied." },
        submissionMayHaveBeenAccepted: false,
        forkUncertainty: null,
        possibleProviderOrphan: null,
        recoverable: true,
      },
    });
    const creationSnapshot = await creation.service.snapshot(scope, "thread-1");
    expect(
      creationSnapshot.capabilities.operations.find(
        ({ id }) => id === "recover_uncertain",
      ),
    ).toMatchObject({
      available: true,
      label: { text: "Resume submission" },
      parameters: { kind: "none" },
    });

    const forkCreation = createService({
      runState: "idle",
      recovery: {
        kind: "conversation_creation",
        creationType: "fork",
        phase: "recovery_required",
        diagnostic: { text: "Fork binding is awaiting recovery." },
        submissionMayHaveBeenAccepted: false,
        forkUncertainty: null,
        possibleProviderOrphan: null,
        recoverable: true,
      },
    });
    const forkSnapshot = await forkCreation.service.snapshot(scope, "thread-1");
    expect(
      forkSnapshot.capabilities.operations.find(
        ({ id }) => id === "recover_uncertain",
      ),
    ).toMatchObject({
      available: true,
      label: { text: "Recover fork" },
      parameters: { kind: "none" },
    });

    const terminalCreation = createService({
      runState: "failed",
      recovery: {
        kind: "conversation_creation",
        creationType: "first_input",
        phase: "recovery_required",
        diagnostic: { text: "The provider create outcome is unknown." },
        submissionMayHaveBeenAccepted: false,
        forkUncertainty: null,
        possibleProviderOrphan: null,
        recoverable: false,
      },
    });
    const terminalSnapshot = await terminalCreation.service.snapshot(
      scope,
      "thread-1",
    );
    expect(
      terminalSnapshot.capabilities.operations.find(
        ({ id }) => id === "recover_uncertain",
      ),
    ).toMatchObject({
      available: false,
      label: { text: "Recovery unavailable" },
      unavailableReason: {
        text: "The provider-assigned create outcome cannot be replayed or reconciled automatically.",
      },
    });
  });
});

describe("ActorBackedThreadApplicationConversationReader", () => {
  const target = {
    scope,
    binding: {
      tenantId: scope.tenantId,
      ownerPrincipalId: scope.principalId,
      applicationThreadId: "thread-1",
    },
  } as AcquireConversationActorInput;

  it("releases the scoped actor after capturing its state", async () => {
    const state = {
      timeline: {
        generation: "generation-1",
        orderedTurnIds: [],
        turnsById: {},
        itemsById: {},
        runState: "idle" as const,
      },
      backendCapabilities: {
        revision: "backend-1",
        actions: [],
        deliveryModes: [],
        steerTarget: null,
        composerAttachments: { fileStaging: false, nativeImage: false },
        nonblockingQuestions: false,
        providerOutputArtifacts: { nativeImage: false },
        supportsHistory: false,
        branching: {
          availability: "unavailable" as const,
          reason: { text: "Branching is unavailable in this fixture." },
        },
        interactionKinds: [],
        usageAccounting: "supported" as const, usageSections: [],
      },
      usage: {},
    };
    const release = vi.fn();
    const captureSnapshotState = vi.fn(async () => state);
    const acquire = vi.fn(async () => ({
      actor: { captureSnapshotState },
      release,
    }));
    const reader = new ActorBackedThreadApplicationConversationReader({
      actors: { acquire } as never,
      targets: { resolve: async () => target },
    });

    await expect(reader.capture(scope, "thread-1")).resolves.toEqual({
      status: "connected",
      state,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("maps transient backend acquisition failures to disconnected state", async () => {
    const reader = new ActorBackedThreadApplicationConversationReader({
      actors: {
        acquire: vi.fn(async () => {
          throw new BackendError({
            category: "unavailable",
            retryable: true,
            crossedSubmissionBoundary: false,
            safeMessage: "Backend unavailable.",
          });
        }),
      } as never,
      targets: { resolve: async () => target },
    });

    await expect(reader.capture(scope, "thread-1")).resolves.toEqual({
      status: "disconnected",
    });
  });

  it("rejects a resolver that crosses the owner scope before acquisition", async () => {
    const acquire = vi.fn();
    const reader = new ActorBackedThreadApplicationConversationReader({
      actors: { acquire } as never,
      targets: {
        resolve: async () =>
          ({
            ...target,
            binding: {
              ...target.binding,
              ownerPrincipalId: "principal-2",
            },
          }) as AcquireConversationActorInput,
      },
    });

    await expect(reader.capture(scope, "thread-1")).rejects.toThrow(
      "thread_application_actor_target_scope_mismatch",
    );
    expect(acquire).not.toHaveBeenCalled();
  });
});
