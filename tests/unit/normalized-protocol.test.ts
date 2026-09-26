import { describe, expect, it } from "vitest";
import {
  COMPOSER_ATTACHMENT_POLICY,
  SEDES_CLIENT_PROTOCOL_VERSION,
  ARCHIVE_IMPACT_TASK_SUMMARY_LIMIT,
  TASK_DETAILS_MAX_CHARACTERS,
  TASK_FILES_MAX_COUNT,
  TASK_FILE_MAX_PATH_BYTES,
  backendItemSchema,
  backendConversationSnapshotSchema,
  backendPresentationSchema,
  backendHistoryPageSchema,
  backendConversationEventSchema,
  backendTurnSchema,
  activityDetailModeSchema,
  activitySummaryItemSchema,
  applicationEventStreamQuerySchema,
  boundedValueSchema,
  conversationItemSchema,
  conversationTurnSchema,
  createTaskRequestSchema,
  fileRangeSchema,
  forkThreadRequestSchema,
  hasDeliverableComposerInput,
  conversationHistoryWindowSchema,
  historyPageSchema,
  inventoryTransitionSchema,
  loadThreadHistoryRequestSchema,
  normalizedThreadAttentionSchema,
  normalizedThreadAgentToolPolicySchema,
  normalizedApplicationSessionSchema,
  normalizedThreadSnapshotSchema,
  MAXIMUM_BACKEND_ITEMS_PER_TURN,
  MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES,
  MAXIMUM_NORMALIZED_ITEMS_PER_TURN,
  MAXIMUM_OUTPUT_IMAGE_BYTES,
  MAXIMUM_REASONING_SUMMARY_PARTS,
  queuedInputSummarySchema,
  threadApplicationMutationResultSchema,
  threadDeliveryMutationResultSchema,
  threadQueueMutationResultSchema,
  threadApplicationOperationSchema,
  threadHistorySeekResultSchema,
  threadEventStreamQuerySchema,
  threadSnapshotQuerySchema,
  seekThreadHistoryRequestSchema,
  threadArchiveImpactSchema,
  threadForceResetImpactSchema,
  threadForceResetRequestSchema,
  threadForceResetResultSchema,
  threadOperationDescriptorSchema,
  threadEventEnvelopeSchema,
  threadCheckpointSchema,
  updateTaskRequestSchema,
  WORKSPACE_FILE_MAX_CONTENT_BYTES,
  WORKSPACE_FILE_MAX_PATH_BYTES,
  workspaceFilePathSchema,
  workspaceFileWriteRequestSchema,
  workspaceFileWriteResultSchema,
} from "../../src/shared/index.js";
import { SEDES_VERSION } from "../../src/shared/version.js";

describe("application session and resume contracts", () => {
  it("keeps session metadata strict and inventory-free", () => {
    const session = {
      clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
      version: SEDES_VERSION,
      csrfToken: "a".repeat(32),
      providerPulseEnabled: false, experimentalUsageEnabled: false,
    };

    expect(normalizedApplicationSessionSchema.parse(session)).toEqual(session);
    const { experimentalUsageEnabled: _usage, ...withoutUsageFlag } = session;
    expect(normalizedApplicationSessionSchema.safeParse(withoutUsageFlag).success).toBe(false);
    expect(
      normalizedApplicationSessionSchema.safeParse({
        ...session,
        snapshot: { threads: [] },
      }).success,
    ).toBe(false);
  });

  it("carries the server's product version in the session handshake", () => {
    const session = {
      clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
      version: SEDES_VERSION,
      csrfToken: "a".repeat(32),
      providerPulseEnabled: false, experimentalUsageEnabled: false,
    };

    expect(normalizedApplicationSessionSchema.parse(session).version).toBe(
      SEDES_VERSION,
    );
    const { version: _omitted, ...withoutVersion } = session;
    expect(
      normalizedApplicationSessionSchema.safeParse(withoutVersion).success,
    ).toBe(false);
    expect(
      normalizedApplicationSessionSchema.safeParse({ ...session, version: "" })
        .success,
    ).toBe(false);
  });

  it("accepts only one validated opaque application replay hint", () => {
    const replayCursor = "00000000-0000-4000-8000-000000000001.7";

    expect(applicationEventStreamQuerySchema.parse({ replayCursor })).toEqual({
      replayCursor,
    });
    expect(
      applicationEventStreamQuerySchema.safeParse({
        replayCursor: "foreign-or-malformed",
      }).success,
    ).toBe(false);
    expect(
      applicationEventStreamQuerySchema.safeParse({
        replayCursor,
        tenantId: "tenant",
      }).success,
    ).toBe(false);
    expect(
      applicationEventStreamQuerySchema.parse({
        handshake: "authoritative_replacement",
      }),
    ).toEqual({ handshake: "authoritative_replacement" });
    expect(
      applicationEventStreamQuerySchema.safeParse({
        replayCursor,
        handshake: "authoritative_replacement",
      }).success,
    ).toBe(false);
    expect(
      applicationEventStreamQuerySchema.safeParse({ handshake: "fresh" })
        .success,
    ).toBe(false);
  });
});

describe("fork requests", () => {
  it("keeps exact completed turns and latest provider snapshots distinct", () => {
    expect(
      forkThreadRequestSchema.parse({
        boundary: "selected_completed_turn",
        sourceTurnId: "turn-1",
        expectedTurnRevision: 4,
        mutationId: "20000000-0000-4000-8000-000000000001",
      }),
    ).toMatchObject({ boundary: "selected_completed_turn" });
    expect(
      forkThreadRequestSchema.parse({
        boundary: "latest_provider_snapshot",
        mutationId: "20000000-0000-4000-8000-000000000002",
      }),
    ).toEqual({
      boundary: "latest_provider_snapshot",
      mutationId: "20000000-0000-4000-8000-000000000002",
    });
    expect(
      forkThreadRequestSchema.safeParse({
        boundary: "latest_provider_snapshot",
        sourceTurnId: "turn-1",
        expectedTurnRevision: 4,
        mutationId: "20000000-0000-4000-8000-000000000003",
      }).success,
    ).toBe(false);
    expect(
      forkThreadRequestSchema.safeParse({
        sourceTurnId: "turn-1",
        expectedTurnRevision: 4,
        mutationId: "20000000-0000-4000-8000-000000000004",
      }).success,
    ).toBe(false);
  });
});

describe("composer delivery input", () => {
  it("requires meaningful text, one selected skill, or an annotated excerpt", () => {
    expect(hasDeliverableComposerInput({ text: "send this" })).toBe(true);
    expect(
      hasDeliverableComposerInput({
        text: "",
        selectedSkillId: "skill-review",
      }),
    ).toBe(true);
    expect(
      hasDeliverableComposerInput({
        text: "",
        contextExcerpts: [{ note: "Inspect this path." }],
      }),
    ).toBe(true);
    expect(
      hasDeliverableComposerInput({
        text: "",
        contextExcerpts: [{}],
      }),
    ).toBe(false);
    expect(
      hasDeliverableComposerInput({
        text: "  \n\t",
        selectedSkillId: "skill-review",
      }),
    ).toBe(true);
    expect(hasDeliverableComposerInput({ text: "  \n\t" })).toBe(false);
    expect(hasDeliverableComposerInput({ text: "" })).toBe(false);
  });
});

describe("delivery mutation receipts", () => {
  it("requires an authoritative cleared draft on delivery-specific results", () => {
    expect(
      threadApplicationMutationResultSchema.parse({
        status: "delivery_queued",
        queuedInputId: "queued-1",
        resolvedDeliveryMode: "queue",
        threadRevision: 7,
        draft: {
          text: "",
          contextExcerpts: [],
          attachments: [] as [],
          taskReferences: [] as [],
          revision: 5,
          updatedAt: "2026-08-07T07:00:00.000Z",
        },
      }),
    ).toMatchObject({
      status: "delivery_queued",
      threadRevision: 7,
      draft: { revision: 5 },
    });
    expect(() =>
      threadApplicationMutationResultSchema.parse({
        status: "delivery_queued",
        queuedInputId: "queued-1",
      }),
    ).toThrow();
    expect(() =>
      threadApplicationMutationResultSchema.parse({
        status: "delivery_queued",
        queuedInputId: "queued-1",
        draft: {
          text: "not cleared",
          contextExcerpts: [],
          attachments: [] as [],
          taskReferences: [] as [],
          revision: 5,
          updatedAt: "2026-08-07T07:00:00.000Z",
        },
      }),
    ).toThrow();
    expect(
      threadDeliveryMutationResultSchema.parse({
        status: "delivery_accepted",
        operationId: "delivery-operation-1",
        resolvedDeliveryMode: "submit",
        threadRevision: 8,
        draft: {
          text: "",
          contextExcerpts: [],
          attachments: [] as [],
          taskReferences: [] as [],
          revision: 5,
          updatedAt: "2026-08-07T07:00:00.000Z",
        },
      }),
    ).toMatchObject({
      status: "delivery_accepted",
      threadRevision: 8,
    });
    expect(() =>
      threadDeliveryMutationResultSchema.parse({
        status: "delivery_accepted",
        operationId: "delivery-operation-1",
        draft: {
          text: "",
          contextExcerpts: [],
          attachments: [] as [],
          taskReferences: [] as [],
          revision: 5,
          updatedAt: "2026-08-07T07:00:00.000Z",
        },
      }),
    ).toThrow();
  });

  it("requires the authoritative current draft on delivery recovery", () => {
    expect(
      threadDeliveryMutationResultSchema.parse({
        status: "recovery_required",
        retryable: false,
        draft: {
          text: "Retained after a proven non-acceptance",
          contextExcerpts: [],
          attachments: [],
          taskReferences: [],
          revision: 4,
          updatedAt: "2026-08-07T07:00:00.000Z",
        },
      }),
    ).toMatchObject({
      status: "recovery_required",
      draft: { revision: 4 },
    });
    expect(() =>
      threadDeliveryMutationResultSchema.parse({
        status: "recovery_required",
        retryable: false,
      }),
    ).toThrow();

    // Non-delivery operations share the generic recovery status but do not
    // fabricate a composer receipt.
    expect(
      threadApplicationMutationResultSchema.parse({
        status: "recovery_required",
        retryable: true,
      }),
    ).toEqual({ status: "recovery_required", retryable: true });
  });

  it("keeps pending materialization distinct from acceptance and recovery", () => {
    const retained = {
      text: "Wait for Pi to persist this steer",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 4,
      updatedAt: "2026-08-07T07:00:00.000Z",
    };
    expect(
      threadDeliveryMutationResultSchema.parse({
        status: "delivery_pending_materialization",
        operationId: "10000000-0000-4000-8000-000000000010",
        resolvedDeliveryMode: "steer",
        threadRevision: 8,
        draft: retained,
      }),
    ).toMatchObject({
      status: "delivery_pending_materialization",
      threadRevision: 8,
      draft: retained,
    });
    expect(() =>
      threadDeliveryMutationResultSchema.parse({
        status: "delivery_pending_materialization",
        operationId: "10000000-0000-4000-8000-000000000010",
        threadRevision: 8,
        draft: retained,
        retryable: true,
      }),
    ).toThrow();
  });
});

describe("queued input actions", () => {
  const mutationId = "10000000-0000-4000-8000-000000000001";
  const queue = [
    {
      id: "queued-1",
      deliveryOperationId: mutationId,
      sequence: 1,
      origin: "user" as const,
      isHead: true,
      state: "dispatching" as const,
      resolvedDeliveryMode: "steer" as const,
      deliveryMode: "steer" as const,
      attachmentCount: 0,
      taskCount: 0,
      preview: { text: "Review this" },
      createdAt: "2026-08-07T07:00:00.000Z",
    },
  ];

  it("parses only the closed cancel, Restore, and Steer request shapes", () => {
    expect(
      threadApplicationOperationSchema.parse({
        kind: "cancel_queued_input",
        queuedInputId: "queued-1",
        mutationId,
        expectedThreadRevision: 4,
      }),
    ).toMatchObject({ kind: "cancel_queued_input", queuedInputId: "queued-1" });
    expect(
      threadApplicationOperationSchema.parse({
        kind: "restore_queued_input",
        queuedInputId: "queued-1",
        mutationId,
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }),
    ).toMatchObject({
      kind: "restore_queued_input",
      queuedInputId: "queued-1",
      expectedDraftRevision: 2,
    });
    expect(
      threadApplicationOperationSchema.safeParse({
        kind: "restore_queued_input",
        queuedInputId: "queued-1",
        mutationId,
        expectedThreadRevision: 4,
      }).success,
    ).toBe(false);
    expect(
      threadApplicationOperationSchema.safeParse({
        kind: "restore_queued_input",
        queuedInputId: "queued-1",
        mutationId,
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
        text: "client reconstruction is forbidden",
      }).success,
    ).toBe(false);
    expect(
      threadApplicationOperationSchema.safeParse({
        kind: "steer_queued_input",
        queuedInputId: "queued-1",
        mutationId,
        expectedThreadRevision: 4,
        backendTurnId: "native-turn",
      }).success,
    ).toBe(false);
  });

  it("binds composer Steer delivery to the browser-observed active turn", () => {
    expect(
      threadApplicationOperationSchema.safeParse({
        kind: "deliver",
        mode: "steer",
        mutationId,
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
      }).success,
    ).toBe(false);
    expect(
      threadApplicationOperationSchema.parse({
        kind: "deliver",
        mode: "steer",
        mutationId,
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
        steerTarget: { kind: "turn", turnId: "turn-1" },
      }),
    ).toMatchObject({ mode: "steer", steerTarget: { kind: "turn", turnId: "turn-1" } });
    expect(
      threadApplicationOperationSchema.safeParse({
        kind: "deliver",
        mode: "submit",
        mutationId,
        expectedThreadRevision: 4,
        expectedDraftRevision: 2,
        steerTarget: { kind: "turn", turnId: "turn-1" },
      }).success,
    ).toBe(false);
  });

  it("accepts conversation Steer without a turn and rejects mixed or missing target shapes", () => {
    const request = { kind: "deliver", mode: "steer", mutationId, expectedThreadRevision: 4, expectedDraftRevision: 2 };
    expect(threadApplicationOperationSchema.parse({ ...request, steerTarget: { kind: "conversation" } })).toMatchObject({ steerTarget: { kind: "conversation" } });
    for (const steerTarget of [{ kind: "turn" }, { kind: "conversation", turnId: "invented" }, { kind: "unknown" }]) {
      expect(threadApplicationOperationSchema.safeParse({ ...request, steerTarget }).success).toBe(false);
    }
    expect(threadApplicationOperationSchema.safeParse({ ...request, expectedActiveTurnId: "old-shape" }).success).toBe(false);
  });

  it("requires nonblank previews and delivery modes exactly at the delivery boundary", () => {
    expect(queuedInputSummarySchema.parse(queue[0])).toEqual(queue[0]);
    expect(
      queuedInputSummarySchema.safeParse({
        ...queue[0],
        deliveryOperationId: undefined,
      }).success,
    ).toBe(false);
    expect(
      queuedInputSummarySchema.safeParse({
        ...queue[0],
        deliveryMode: undefined,
      }).success,
    ).toBe(false);
    expect(
      queuedInputSummarySchema.safeParse({
        ...queue[0],
        state: "pending",
      }).success,
    ).toBe(false);
    expect(
      queuedInputSummarySchema.safeParse({
        ...queue[0],
        preview: { text: "" },
      }).success,
    ).toBe(false);
    expect(
      queuedInputSummarySchema.safeParse({
        ...queue[0],
        preview: { text: " \n" },
      }).success,
    ).toBe(false);

    const clientId = "10000000-0000-4000-8000-000000000099";
    expect(
      queuedInputSummarySchema.safeParse({
        ...queue[0],
        origin: "principal_client_control",
        initiatingToolClientId: clientId,
      }).success,
    ).toBe(true);
    expect(
      queuedInputSummarySchema.safeParse({
        ...queue[0],
        origin: "agent_control",
        initiatingAgentThreadId: "controller-thread",
        inputOrigin: {
          kind: "agent_message",
          sourceThreadId: "controller-thread",
          sourceThreadLabel: { text: "Main implementation" },
        },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...queue[0], origin: "principal_client_control" },
      {
        ...queue[0],
        origin: "principal_client_control",
        initiatingAgentThreadId: "controller-thread",
        initiatingToolClientId: clientId,
      },
      { ...queue[0], origin: "user", initiatingToolClientId: clientId },
      {
        ...queue[0],
        origin: "agent_control",
        initiatingToolClientId: clientId,
      },
    ]) {
      expect(queuedInputSummarySchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("returns strict authoritative queue receipts", () => {
    const restoredDraft = {
      text: "Review this",
      contextExcerpts: [],
      attachments: [],
      taskReferences: [],
      revision: 3,
    };
    expect(
      threadQueueMutationResultSchema.parse({
        status: "queue_restored",
        queuedInputId: "queued-1",
        mutationId,
        threadRevision: 5,
        queue: [],
        draft: restoredDraft,
      }),
    ).toMatchObject({
      status: "queue_restored",
      threadRevision: 5,
      queue: [],
      draft: restoredDraft,
    });
    expect(
      threadQueueMutationResultSchema.safeParse({
        status: "queue_restored",
        queuedInputId: "queued-1",
        mutationId,
        threadRevision: 5,
        queue: [],
        draft: restoredDraft,
        attachmentIds: [],
      }).success,
    ).toBe(false);
    expect(
      threadQueueMutationResultSchema.parse({
        status: "queue_steer_pending_materialization",
        queuedInputId: "queued-1",
        operationId: mutationId,
        threadRevision: 5,
        queue,
      }),
    ).toMatchObject({
      status: "queue_steer_pending_materialization",
      threadRevision: 5,
      queue: [{ state: "dispatching", deliveryMode: "steer" }],
    });
    expect(
      threadQueueMutationResultSchema.parse({
        status: "queue_steer_recovery_required",
        queuedInputId: "queued-1",
        operationId: mutationId,
        retryable: false,
        threadRevision: 5,
        queue,
      }),
    ).toMatchObject({
      status: "queue_steer_recovery_required",
      threadRevision: 5,
    });
    expect(
      threadQueueMutationResultSchema.parse({
        status: "queue_steer_restored",
        queuedInputId: "queued-1",
        operationId: mutationId,
        threadRevision: 6,
        queue: [
          {
            ...queue[0],
            state: "pending",
            deliveryMode: undefined,
          },
        ],
      }),
    ).toMatchObject({ status: "queue_steer_restored", threadRevision: 6 });
    expect(
      threadApplicationMutationResultSchema.safeParse({
        status: "queue_cancelled",
        queuedInputId: "queued-1",
        mutationId,
        threadRevision: 5,
      }).success,
    ).toBe(false);
  });
});

const common = {
  id: "item-1",
  turnId: "turn-1",
  status: "completed" as const,
  revision: 1,
};

describe("task protocol", () => {
  it("rejects ill-formed UTF-16 in every persisted task text field", () => {
    const base = {
      mutationId: "10000000-0000-4000-8000-000000000001",
      title: "Valid",
      scope: { kind: "global" as const },
    };
    for (const request of [
      { ...base, title: "bad\ud800title" },
      { ...base, details: "bad\udc00details" },
      { ...base, files: ["/tmp/bad\ud800.txt"] },
    ]) {
      expect(createTaskRequestSchema.safeParse(request).success).toBe(false);
    }
  });

  it("accepts atomic task create content while preserving omitted defaults", () => {
    const base = {
      mutationId: "10000000-0000-4000-8000-000000000001",
      title: "Atomic task",
      scope: { kind: "global" as const },
    };
    expect(createTaskRequestSchema.parse(base)).toEqual(base);
    expect(
      createTaskRequestSchema.parse({
        ...base,
        details: "Initial details",
        pinned: true,
        files: ["/tmp/design.md"],
      }),
    ).toMatchObject({ details: "Initial details", pinned: true });
  });

  it("accepts large task documents up to the shared character limit", () => {
    const request = {
      mutationId: "10000000-0000-4000-8000-000000000001",
      expectedRevision: 0,
      details: "x".repeat(TASK_DETAILS_MAX_CHARACTERS),
    };

    expect(updateTaskRequestSchema.safeParse(request).success).toBe(true);
    expect(
      updateTaskRequestSchema.safeParse({
        ...request,
        details: `${request.details}x`,
      }).success,
    ).toBe(false);
  });

  it("accepts bounded unique absolute task file paths and atomic scope updates", () => {
    const request = {
      mutationId: "10000000-0000-4000-8000-000000000001",
      expectedRevision: 3,
      pinned: true,
      files: ["/workspace/docs/design.md", "/tmp/release.zip"],
      scope: { kind: "global" as const },
    };
    expect(updateTaskRequestSchema.parse(request)).toEqual(request);

    for (const files of [
      ["relative/file.md"],
      ["/same", "/same"],
      Array.from(
        { length: TASK_FILES_MAX_COUNT + 1 },
        (_, index) => `/${index}`,
      ),
      [`/${"é".repeat(TASK_FILE_MAX_PATH_BYTES / 2)}`],
      ["/contains\0nul"],
    ]) {
      expect(
        updateTaskRequestSchema.safeParse({ ...request, files }).success,
      ).toBe(false);
    }
  });
});

describe("thread archive-impact protocol", () => {
  const impact = {
    descendantCount: 1,
    pendingQuestions: { root: 0, descendants: 0 },
    stashedPrompts: { root: 1, descendants: 2 },
    openTasks: {
      root: {
        items: [
          {
            id: "10000000-0000-4000-8000-000000000001",
            title: "Root task",
            threadId: "10000000-0000-4000-8000-000000000002",
          },
        ],
        total: 2,
        omitted: 1,
      },
      descendants: { items: [], total: 0, omitted: 0 },
    },
    executionWorkspace: { kind: "direct" as const },
    archiveOnly: { available: true as const },
    archiveAll: { available: true as const },
  };

  it("requires strict bounded summaries with truthful omission accounting", () => {
    expect(threadArchiveImpactSchema.parse(impact)).toEqual(impact);
    expect(
      threadArchiveImpactSchema.safeParse({
        ...impact,
        openTasks: {
          ...impact.openTasks,
          root: { ...impact.openTasks.root, omitted: 0 },
        },
      }).success,
    ).toBe(false);
    expect(
      threadArchiveImpactSchema.safeParse({
        ...impact,
        openTasks: {
          ...impact.openTasks,
          descendants: {
            items: Array.from(
              { length: ARCHIVE_IMPACT_TASK_SUMMARY_LIMIT + 1 },
              (_, index) => ({
                id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
                title: `Task ${index}`,
                threadId: "10000000-0000-4000-8000-000000000002",
              }),
            ),
            total: ARCHIVE_IMPACT_TASK_SUMMARY_LIMIT + 1,
            omitted: 0,
          },
        },
      }).success,
    ).toBe(false);
  });

  it("requires explicit root and descendant stash counts", () => {
    const { stashedPrompts: _stashedPrompts, ...withoutStashes } = impact;
    expect(threadArchiveImpactSchema.safeParse(withoutStashes).success).toBe(
      false,
    );
  });

  it("rejects the obsolete count-only archive shape", () => {
    expect(
      threadArchiveImpactSchema.safeParse({
        ...impact,
        openTaskCount: 2,
        descendantOpenTaskCount: 0,
      }).success,
    ).toBe(false);
  });
});

describe("inventory transition confirmation protocol", () => {
  const mutationId = "10000000-0000-4000-8000-000000000001";

  it("accepts only a nonblank bounded reminder for remind", () => {
    expect(
      inventoryTransitionSchema.parse({
        action: "remind",
        wakeReminder: "  Review this result  ",
        expectedRevision: 0,
        mutationId,
      }),
    ).toMatchObject({ wakeReminder: "Review this result" });
    expect(
      inventoryTransitionSchema.safeParse({
        action: "remind",
        wakeReminder: "   ",
        expectedRevision: 0,
        mutationId,
      }).success,
    ).toBe(false);
    expect(
      inventoryTransitionSchema.safeParse({
        action: "remind",
        wakeReminder: "Review",
        snoozedUntil: "2026-08-30T12:00:00.000Z",
        expectedRevision: 0,
        mutationId,
      }).success,
    ).toBe(false);
  });

  for (const action of ["settle", "archive", "archive_family"] as const) {
    it(`requires a confirmed stash count for ${action}`, () => {
      const input = { action, expectedRevision: 0, mutationId };
      expect(inventoryTransitionSchema.safeParse(input).success).toBe(false);
      expect(
        inventoryTransitionSchema.safeParse({
          ...input,
          expectedStashedPromptCount: 0,
          ...(action === "archive" || action === "archive_family"
            ? { executionWorkspaceDisposition: { kind: "keep" } }
            : {}),
        }).success,
      ).toBe(true);
    });
  }

  for (const action of ["archive", "archive_family"] as const) {
    it(`requires an explicit isolated-workspace disposition for ${action}`, () => {
      expect(
        inventoryTransitionSchema.safeParse({
          action,
          expectedRevision: 0,
          expectedStashedPromptCount: 0,
          mutationId,
        }).success,
      ).toBe(false);
    });
  }
});

describe("thread force-reset protocol", () => {
  const threadId = "10000000-0000-4000-8000-000000000002";
  const blockerFingerprint = "a".repeat(64);
  const blockers = [
    { kind: "pending_interaction" as const, count: 1 },
    { kind: "conversation_operation" as const, count: 2 },
    { kind: "thread_creation_state" as const, count: 1 },
  ];

  it("accepts only strict bounded impact, request, and result documents", () => {
    expect(
      threadForceResetImpactSchema.parse({
        blockerFingerprint,
        resettable: true,
        blockers,
        affectedThreads: [{ threadId, title: "Thread", runtime: { runState: "running",
          backgroundActivity: { state: "known", agents: 1, commands: 0, other: 0 } } }],
        warnings: [
          {
            code: "provider_side_effects_may_remain",
            message: "Provider effects may remain.",
          },
        ],
      }),
    ).toBeTruthy();
    expect(
      threadForceResetRequestSchema.parse({
        expectedBlockerFingerprint: blockerFingerprint,
        mutationId: "10000000-0000-4000-8000-000000000003",
      }),
    ).toBeTruthy();
    expect(
      threadForceResetResultSchema.parse({
        resetAt: 1,
        blockerFingerprint,
        resetBlockers: blockers,
        affectedThreadIds: [threadId],
      }),
    ).toBeTruthy();
  });

  it("rejects duplicate blocker kinds, unknown warnings, and loose fields", () => {
    const impact = {
      blockerFingerprint,
      resettable: true,
      blockers: [blockers[0], blockers[0]],
      affectedThreads: [{ threadId, title: "Thread" }],
      warnings: [],
    };
    expect(threadForceResetImpactSchema.safeParse(impact).success).toBe(false);
    expect(
      threadForceResetImpactSchema.safeParse({
        ...impact,
        blockers,
        warnings: [{ code: "reconcile_first", message: "No." }],
      }).success,
    ).toBe(false);
    expect(
      threadForceResetRequestSchema.safeParse({
        expectedBlockerFingerprint: blockerFingerprint.toUpperCase(),
        mutationId: "10000000-0000-4000-8000-000000000003",
        force: true,
      }).success,
    ).toBe(false);
  });
});

describe("workspace-file write protocol", () => {
  it("bounds normalized paths by encoded bytes", () => {
    expect(
      workspaceFilePathSchema.safeParse(
        "é".repeat(WORKSPACE_FILE_MAX_PATH_BYTES / 2),
      ).success,
    ).toBe(true);
    expect(
      workspaceFilePathSchema.safeParse(
        "é".repeat(WORKSPACE_FILE_MAX_PATH_BYTES / 2 + 1),
      ).success,
    ).toBe(false);
  });

  it("requires a strict revision-fenced UTF-8 request within the byte limit", () => {
    const request = {
      rootId: "primary",
      path: "src/example.ts",
      content: "export {};\n",
      expectedRevision: "revision-1",
    };
    expect(workspaceFileWriteRequestSchema.parse(request)).toEqual(request);
    for (const invalid of [
      { path: request.path, content: request.content },
      { ...request, overwrite: true },
      {
        ...request,
        content: "é".repeat(WORKSPACE_FILE_MAX_CONTENT_BYTES / 2 + 1),
      },
    ]) {
      expect(workspaceFileWriteRequestSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("keeps successful write results strict", () => {
    const result = {
      availability: "available" as const,
      rootId: "primary",
      path: "src/example.ts",
      sizeBytes: 11,
      revision: "revision-2",
    };
    expect(workspaceFileWriteResultSchema.parse(result)).toEqual(result);
    expect(
      workspaceFileWriteResultSchema.safeParse({ ...result, overwritten: true })
        .success,
    ).toBe(false);
  });
});

describe("normalized conversation protocol", () => {
  it("validates one current agent-tool policy and idle mutation shape", () => {
    const policy = {
      enabled: true,
      groups: [
        {
          id: "threads",
          label: { text: "Threads" },
          description: { text: "Inspect and create threads." },
          order: 20,
          tools: [
            {
              id: "thread.status",
              label: { text: "Sedes thread status" },
              order: 10,
              effects: {
                application: "read",
                modelUsage: "none",
                external: "none",
              },
              enabled: true,
              available: true,
            },
          ],
        },
      ],
      presentation: { surface: "native", mode: "progressive" },
      presentationOptions: [
        { surface: "native", modes: ["progressive", "individual"] },
        { surface: "cli", modes: ["progressive", "individual"] },
      ],
      accessBoundary: "environment" as const,
      revision: 2,
    };
    expect(normalizedThreadAgentToolPolicySchema.parse(policy)).toEqual(policy);
    expect(
      normalizedThreadAgentToolPolicySchema.safeParse({
        ...policy,
        accessBoundary: undefined,
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadAgentToolPolicySchema.safeParse({
        ...policy,
        accessBoundary: "deny",
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadAgentToolPolicySchema.safeParse({
        ...policy,
        tools: policy.groups[0]?.tools,
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadAgentToolPolicySchema.safeParse({
        ...policy,
        groups: [policy.groups[0], policy.groups[0]],
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadAgentToolPolicySchema.safeParse({
        ...policy,
        groups: [
          policy.groups[0],
          { ...policy.groups[0], id: "other", order: 30 },
        ],
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadAgentToolPolicySchema.safeParse({
        ...policy,
        groups: [
          {
            ...policy.groups[0],
            tools: [
              {
                ...policy.groups[0]?.tools[0],
                effects: {
                  application: "network",
                  modelUsage: "none",
                  external: "none",
                },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadAgentToolPolicySchema.safeParse({
        ...policy,
        presentationOptions: [
          { surface: "cli", modes: ["progressive", "individual"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadAgentToolPolicySchema.safeParse({
        ...policy,
        presentation: { surface: "native", mode: "individual" },
        presentationOptions: [
          { surface: "native", modes: ["progressive"] },
          { surface: "cli", modes: ["progressive", "individual"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadAgentToolPolicySchema.safeParse({
        ...policy,
        presentationOptions: [
          { surface: "native", modes: ["progressive"] },
          { surface: "native", modes: ["individual"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadAgentToolPolicySchema.safeParse({
        ...policy,
        presentationOptions: [
          { surface: "native", modes: ["progressive", "progressive"] },
        ],
      }).success,
    ).toBe(false);
    expect(
      threadApplicationOperationSchema.safeParse({
        kind: "set_agent_tool_policy",
        mutationId: "10000000-0000-4000-8000-000000000002",
        expectedPolicyRevision: 2,
        enabled: true,
        enabledToolIds: ["thread.status"],
        presentation: { surface: "native", mode: "progressive" },
        accessBoundary: "unrestricted",
      }).success,
    ).toBe(true);
    expect(
      threadApplicationOperationSchema.safeParse({
        kind: "set_agent_tool_policy",
        mutationId: "10000000-0000-4000-8000-000000000002",
        expectedPolicyRevision: 2,
        enabled: true,
        enabledToolIds: ["thread.status"],
        presentation: { surface: "native", mode: "individual" },
      }).success,
    ).toBe(false);
    // The deployed flat mode shape is migration input only, never API input.
    expect(
      threadApplicationOperationSchema.safeParse({
        kind: "set_agent_tool_policy",
        mutationId: "10000000-0000-4000-8000-000000000002",
        expectedPolicyRevision: 2,
        enabled: true,
        enabledToolIds: ["thread.status"],
        presentationMode: "native_progressive",
        accessBoundary: "unrestricted",
      }).success,
    ).toBe(false);
    expect(
      threadApplicationOperationSchema.safeParse({
        kind: "set_agent_tool_policy",
        mutationId: "10000000-0000-4000-8000-000000000002",
        expectedPolicyRevision: 2,
        enabled: true,
        enabledToolIds: ["thread.status", "thread.status"],
        presentation: { surface: "native", mode: "progressive" },
        accessBoundary: "unrestricted",
      }).success,
    ).toBe(false);
  });

  it("requires an explicit activity projection on every browser transcript request", () => {
    expect(activityDetailModeSchema.options).toEqual(["full", "summary"]);
    expect(
      threadSnapshotQuerySchema.parse({ activityDetail: "summary" }),
    ).toEqual({ activityDetail: "summary" });
    expect(
      threadEventStreamQuerySchema.parse({
        activityDetail: "full",
        replayCursor: "10000000-0000-4000-8000-000000000001.12",
      }),
    ).toEqual({
      activityDetail: "full",
      replayCursor: "10000000-0000-4000-8000-000000000001.12",
    });
    expect(
      seekThreadHistoryRequestSchema.parse({
        activityDetail: "summary",
        turnId: "turn-1",
      }),
    ).toEqual({ activityDetail: "summary", turnId: "turn-1" });

    for (const [schema, request] of [
      [threadSnapshotQuerySchema, {}],
      [threadEventStreamQuerySchema, {}],
      [seekThreadHistoryRequestSchema, { turnId: "turn-1" }],
    ] as const) {
      expect(schema.safeParse(request).success).toBe(false);
    }
  });

  it("accepts only opaque activity summary descriptors and explicit reasoning summaries", () => {
    const item = {
      id: "item-1",
      turnId: "turn-1",
      kind: "activity_summary",
      activityKind: "tool",
      status: "completed",
      revision: 2,
      startedAt: "2026-08-14T15:00:00.000Z",
      completedAt: "2026-08-14T15:00:01.000Z",
    } as const;
    expect(activitySummaryItemSchema.parse(item)).toEqual(item);
    expect(conversationItemSchema.parse(item)).toEqual(item);

    for (const forbidden of [
      { title: "secret title" },
      { arguments: { secret: true } },
      { result: { content: [{ kind: "text", text: "secret result" }] } },
      { markdown: "secret reasoning" },
      { error: { message: "secret error" } },
    ]) {
      expect(
        activitySummaryItemSchema.safeParse({ ...item, ...forbidden }).success,
      ).toBe(false);
    }

    const reasoningSummary = {
      ...item,
      activityKind: "reasoning",
      summaryParts: [{ text: "Inspecting the protocol" }],
    } as const;
    expect(activitySummaryItemSchema.parse(reasoningSummary)).toEqual(
      reasoningSummary,
    );
    expect(
      activitySummaryItemSchema.safeParse({
        ...item,
        summaryParts: [{ text: "must not reach a tool descriptor" }],
      }).success,
    ).toBe(false);
    expect(
      activitySummaryItemSchema.safeParse({
        ...reasoningSummary,
        summaryParts: [],
      }).success,
    ).toBe(false);
  });

  it("keeps canonical reasoning summary parts separate from detailed markdown", () => {
    const summaryParts = [{ text: "Inspecting" }, { text: "Running tests" }];
    const backend = {
      backendItemId: "backend-reasoning-1",
      backendTurnId: "backend-turn-1",
      semanticKind: "reasoning",
      status: "streaming",
      sourceOrder: 2,
      summaryParts,
      markdown: { text: "Detailed private reasoning" },
    } as const;
    expect(backendItemSchema.parse(backend)).toEqual(backend);

    const conversation = {
      id: "reasoning-1",
      turnId: "turn-1",
      kind: "reasoning",
      status: "streaming",
      revision: 3,
      summaryParts,
      markdown: { text: "Detailed private reasoning" },
    } as const;
    expect(conversationItemSchema.parse(conversation)).toEqual(conversation);
    expect(MAXIMUM_REASONING_SUMMARY_PARTS).toBe(1_000);
    expect(
      conversationItemSchema.safeParse({
        ...conversation,
        summaryParts: Array.from(
          { length: MAXIMUM_REASONING_SUMMARY_PARTS },
          () => ({ text: "summary" }),
        ),
      }).success,
    ).toBe(true);
    expect(
      conversationItemSchema.safeParse({
        ...conversation,
        summaryParts: Array.from(
          { length: MAXIMUM_REASONING_SUMMARY_PARTS + 1 },
          () => ({ text: "summary" }),
        ),
      }).success,
    ).toBe(false);
  });

  it("makes compaction summaries optional without admitting an empty summary shape", () => {
    const backend = {
      backendItemId: "backend-compaction-1",
      backendTurnId: "backend-turn-1",
      semanticKind: "compaction",
      status: "completed",
      sourceOrder: 1,
    } as const;
    const conversation = {
      id: "compaction-1",
      turnId: "turn-1",
      kind: "compaction",
      status: "completed",
      revision: 2,
    } as const;

    expect(backendItemSchema.parse(backend)).toEqual(backend);
    expect(conversationItemSchema.parse(conversation)).toEqual(conversation);
    expect(
      backendItemSchema.parse({
        ...backend,
        summary: { text: "The retained context summary" },
      }),
    ).toMatchObject({ summary: { text: "The retained context summary" } });
    expect(
      conversationItemSchema.safeParse({ ...conversation, summary: null })
        .success,
    ).toBe(false);
    for (const summary of [{ text: "" }, { text: "   \n" }]) {
      expect(backendItemSchema.safeParse({ ...backend, summary }).success).toBe(
        false,
      );
      expect(
        conversationItemSchema.safeParse({ ...conversation, summary }).success,
      ).toBe(false);
    }
  });

  it("requires one bounded older-history page size and activity projection", () => {
    for (const limit of [5, 10, 25, 50, 100]) {
      expect(
        loadThreadHistoryRequestSchema.parse({
          activityDetail: "full",
          cursor: "history_cursor",
          limit,
        }),
      ).toEqual({ activityDetail: "full", cursor: "history_cursor", limit });
    }
    for (const request of [
      { activityDetail: "full", cursor: "history_cursor" },
      { activityDetail: "full", cursor: "history_cursor", limit: 1 },
      { activityDetail: "full", cursor: "history_cursor", limit: 500 },
      {
        activityDetail: "full",
        cursor: "history_cursor",
        limit: 10,
        pageSize: 10,
      },
      { cursor: "history_cursor", limit: 10 },
    ]) {
      expect(loadThreadHistoryRequestSchema.safeParse(request).success).toBe(
        false,
      );
    }
  });

  it("rejects provider cursor material in a targeted history result", () => {
    const result = {
      status: "found",
      targetTurnId: "turn-1",
      page: {
        orderedTurnIds: ["turn-1"],
        turnsById: {
          "turn-1": {
            id: "turn-1",
            revision: 1,
            status: "completed",
            endedBy: "agent_settled",
            orderedItemIds: [],
          },
        },
        forkSource: {
          selectedCompletedTurn: { available: true },
          latestProviderSnapshot: {
            available: false,
            unavailableReason: { text: "Provider snapshots are unavailable." },
          },
        },
        forksByTurnId: {
          "turn-1": {
            sourceTurnId: "turn-1",
            expectedTurnRevision: 1,
            available: true,
          },
        },
        itemsById: {},
        previousCursor: "provider-private-cursor",
      },
    };

    expect(threadHistorySeekResultSchema.safeParse(result).success).toBe(false);
    expect(
      threadHistorySeekResultSchema.safeParse({
        ...result,
        page: { ...result.page, previousCursor: undefined },
      }).success,
    ).toBe(true);
    expect(
      threadHistorySeekResultSchema.safeParse({
        ...result,
        targetTurnId: "different-turn",
        page: { ...result.page, previousCursor: undefined },
      }).success,
    ).toBe(false);
  });

  it("exposes uncertain-operation recovery as a closed no-parameter capability", () => {
    expect(
      threadOperationDescriptorSchema.parse({
        id: "recover_uncertain",
        label: { text: "Recover" },
        destructive: false,
        available: true,
        parameters: { kind: "none" },
      }).id,
    ).toBe("recover_uncertain");
  });

  it("keeps backend brand marks a closed optional presentation enum", () => {
    expect(
      backendPresentationSchema.parse({
        label: { text: "Pi" },
        brand: "pi",
      }),
    ).toEqual({ label: { text: "Pi" }, brand: "pi" });
    expect(
      backendPresentationSchema.parse({
        label: { text: "Claude" },
        brand: "claude",
      }),
    ).toEqual({ label: { text: "Claude" }, brand: "claude" });
    // Absent brand is the fail-closed disposition for backends without a
    // registered mark; unknown marks are rejected at the contract boundary.
    expect(
      backendPresentationSchema.parse({ label: { text: "Custom" } }),
    ).toEqual({ label: { text: "Custom" } });
    expect(
      backendPresentationSchema.safeParse({
        label: { text: "Custom" },
        brand: "custom",
      }).success,
    ).toBe(false);
  });

  it("represents durable queue-failure attention without provider fields", () => {
    expect(
      normalizedThreadAttentionSchema.parse({
        queueFailure: {
          queuedInputId: "queue-1",
          failedAt: "2026-07-30T12:00:00.000Z",
          diagnostic: { text: "The backend rejected the queued input." },
        },
      }),
    ).toEqual({
      queueFailure: {
        queuedInputId: "queue-1",
        failedAt: "2026-07-30T12:00:00.000Z",
        diagnostic: { text: "The backend rejected the queued input." },
      },
    });
  });

  it("accepts a semantic command and rejects provider escape hatches", () => {
    const command = {
      ...common,
      kind: "command",
      phase: "completed",
      command: { text: "npm test" },
      cwd: { text: "/workspace" },
      output: { text: "passed" },
      exitCode: 0,
    };

    expect(conversationItemSchema.parse(command)).toEqual(command);
    expect(
      conversationItemSchema.safeParse({
        ...command,
        rawProviderPayload: { type: "pi_tool" },
      }).success,
    ).toBe(false);
  });

  it("shares a retained message part ceiling independent of composer inputs", () => {
    const content = Array.from({ length: 10_000 }, (_, index) => ({
      kind: "text" as const, text: { text: `part ${index}` },
    }));
    const item = { ...common, kind: "user_message", content };
    const backendItem = {
      backendItemId: "native-item", backendTurnId: "native-turn",
      semanticKind: "user_message", status: "completed", sourceOrder: 0, content,
    };
    expect(conversationItemSchema.safeParse(item).success).toBe(true);
    expect(backendItemSchema.safeParse(backendItem).success).toBe(true);
    const excess = [...content, { kind: "text", text: { text: "last part" } }];
    expect(conversationItemSchema.safeParse({ ...item, content: excess }).success).toBe(false);
    expect(backendItemSchema.safeParse({ ...backendItem, content: excess }).success).toBe(false);
  });

  it("keeps exact file replacements bounded, exclusive, and provider-neutral", () => {
    const item = {
      ...common,
      kind: "file_change" as const,
      phase: "completed" as const,
      operation: "edit" as const,
      effect: "applied" as const,
      path: { text: "src/example.ts" },
      replacement: {
        before: { text: "value" },
        after: { text: "value\n" },
      },
      additions: 1,
      deletions: 1,
    };
    expect(conversationItemSchema.parse(item)).toEqual(item);
    expect(
      backendItemSchema.parse({
        backendItemId: "native-item",
        backendTurnId: "native-turn",
        semanticKind: "file_change",
        status: "completed",
        sourceOrder: 0,
        ...Object.fromEntries(
          Object.entries(item).filter(
            ([key]) => !["id", "turnId", "kind", "revision"].includes(key),
          ),
        ),
      }),
    ).toMatchObject({ replacement: item.replacement });

    for (const invalid of [
      { ...item, operation: "write" },
      {
        ...item,
        path: {
          text: "src/example…",
          truncation: {
            truncated: true as const,
            retainedBytes: 13,
            reason: "byte_limit" as const,
          },
        },
      },
      { ...item, path: { text: " src/example.ts" } },
      { ...item, path: { text: "/dev/null" } },
      { ...item, diff: { text: { text: "@@ -1 +1 @@\n-old\n+new\n" } } },
      {
        ...item,
        replacement: {
          before: {
            text: "old…",
            truncation: {
              truncated: true as const,
              retainedBytes: 6,
              reason: "byte_limit" as const,
            },
          },
          after: { text: "new" },
        },
      },
      {
        ...item,
        replacement: {
          before: { text: "same" },
          after: { text: "same" },
        },
      },
    ]) {
      expect(conversationItemSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("uses a closed item kind union", () => {
    expect(
      conversationItemSchema.safeParse({
        ...common,
        kind: "provider_custom",
        payload: {},
      }).success,
    ).toBe(false);
  });

  it("uses one durable artifact reference for normalized images", () => {
    const image = {
      ...common,
      kind: "image" as const,
      image: {
        representation: "artifact" as const,
        artifactId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        mimeType: "image/png" as const,
        byteSize: 24,
        sha256: "a".repeat(64),
        alt: { text: "Generated chart" },
        fileName: { text: "chart.png" },
      },
    };
    expect(conversationItemSchema.parse(image)).toEqual(image);
    expect(
      conversationItemSchema.safeParse({
        ...image,
        image: { ...image.image, byteSize: MAXIMUM_OUTPUT_IMAGE_BYTES },
      }).success,
    ).toBe(true);
    expect(
      backendItemSchema.parse({
        backendItemId: "native-image",
        backendTurnId: "native-turn",
        semanticKind: "image",
        status: "completed",
        sourceOrder: 0,
        image: image.image,
      }),
    ).toMatchObject({ image: image.image });

    for (const invalidImage of [
      {
        representation: "inline",
        mimeType: "image/png",
        dataBase64: "iVBORw==",
        decodedBytes: 4,
      },
      { ...image.image, artifactId: image.image.artifactId.toUpperCase() },
      { ...image.image, sha256: "A".repeat(64) },
      { ...image.image, byteSize: MAXIMUM_OUTPUT_IMAGE_BYTES + 1 },
      { ...image.image, providerPath: "/tmp/generated.png" },
      { ...image.image, providerUrl: "https://provider.invalid/image.png" },
    ]) {
      expect(
        conversationItemSchema.safeParse({ ...image, image: invalidImage })
          .success,
      ).toBe(false);
    }

    expect(
      conversationItemSchema.parse({
        ...image,
        image: {
          representation: "omitted",
          mimeType: "image/png",
          alt: { text: "Generated chart" },
          reason: "unavailable",
        },
      }),
    ).toMatchObject({ image: { reason: "unavailable" } });
  });

  it("validates bounded recursive values without permitting extra keys", () => {
    const value = {
      kind: "object",
      entries: [
        {
          key: { text: "query" },
          value: {
            kind: "array",
            values: [{ text: "one" }, 2, true, null],
          },
        },
        {
          key: { text: "secret" },
          value: { kind: "redacted", reason: "sensitive_key" },
        },
      ],
    };
    expect(boundedValueSchema.parse(value)).toEqual(value);
    expect(
      boundedValueSchema.safeParse({
        kind: "omitted",
        reason: "binary",
        raw: "not allowed",
      }).success,
    ).toBe(false);
  });

  it("validates turn and range invariants", () => {
    expect(
      conversationTurnSchema.parse({
        id: "turn-1",
        revision: 0,
        status: "completed",
        endedBy: "agent_settled",
        orderedItemIds: ["item-1"],
      }).orderedItemIds,
    ).toEqual(["item-1"]);
    expect(
      fileRangeSchema.safeParse({ startLine: 20, endLine: 10 }).success,
    ).toBe(false);
  });

  it("keeps the backend and normalized per-turn item ceilings aligned", () => {
    const backendItemIds = Array.from(
      { length: MAXIMUM_BACKEND_ITEMS_PER_TURN },
      (_, index) => `backend-item-${index}`,
    );
    const itemIds = Array.from(
      { length: MAXIMUM_NORMALIZED_ITEMS_PER_TURN },
      (_, index) => `item-${index}`,
    );

    expect(
      backendTurnSchema.safeParse({
        backendTurnId: "backend-turn",
        status: "completed",
        endedBy: "agent_settled",
        orderedBackendItemIds: backendItemIds,
      }).success,
    ).toBe(true);
    expect(
      backendTurnSchema.safeParse({
        backendTurnId: "backend-turn",
        status: "completed",
        endedBy: "agent_settled",
        orderedBackendItemIds: [...backendItemIds, "one-too-many"],
      }).success,
    ).toBe(false);
    expect(
      conversationTurnSchema.safeParse({
        id: "turn",
        revision: 0,
        status: "completed",
        endedBy: "agent_settled",
        orderedItemIds: itemIds,
      }).success,
    ).toBe(true);
    expect(
      conversationTurnSchema.safeParse({
        id: "turn",
        revision: 0,
        status: "completed",
        endedBy: "agent_settled",
        orderedItemIds: [...itemIds, "one-too-many"],
      }).success,
    ).toBe(false);
  });

  it("keeps backend identities and phases out of browser item shapes", () => {
    const backendItem = {
      backendItemId: "pi-entry-1",
      backendTurnId: "pi-turn-1",
      semanticKind: "command",
      phase: "preflight_or_executing",
      status: "streaming",
      sourceOrder: 2,
      command: { text: "npm test" },
    };
    expect(backendItemSchema.parse(backendItem)).toEqual(backendItem);
    expect(
      backendItemSchema.safeParse({
        ...backendItem,
        id: "browser-id",
      }).success,
    ).toBe(false);
  });

  it("keeps a complete backend snapshot distinct from browser identity", () => {
    const item = {
      backendItemId: "entry-1:0",
      backendTurnId: "entry-1",
      semanticKind: "assistant_message",
      status: "completed",
      sourceOrder: 0,
      markdown: { text: "Done" },
    } as const;
    expect(
      backendConversationSnapshotSchema.parse({
        orderedBackendTurnIds: ["entry-1"],
        turnsById: {
          "entry-1": {
            backendTurnId: "entry-1",
            status: "completed",
            orderedBackendItemIds: ["entry-1:0"],
          },
        },
        itemsById: { "entry-1:0": item },
        runState: "idle",
      }),
    ).toMatchObject({ runState: "idle" });
  });

  it("rejects structurally inconsistent backend timelines at the contract boundary", () => {
    const valid = {
      orderedBackendTurnIds: ["turn-1"],
      turnsById: {
        "turn-1": {
          backendTurnId: "turn-1",
          status: "completed" as const,
          orderedBackendItemIds: ["item-1"],
        },
      },
      itemsById: {
        "item-1": {
          backendItemId: "item-1",
          backendTurnId: "turn-1",
          semanticKind: "assistant_message" as const,
          status: "completed" as const,
          sourceOrder: 0,
          markdown: { text: "Done" },
        },
      },
      runState: "idle" as const,
    };
    const invalid = [
      {
        ...valid,
        orderedBackendTurnIds: ["turn-1", "turn-1"],
      },
      {
        ...valid,
        turnsById: {
          "turn-1": {
            ...valid.turnsById["turn-1"],
            backendTurnId: "another-turn",
          },
        },
      },
      {
        ...valid,
        turnsById: {
          "turn-1": {
            ...valid.turnsById["turn-1"],
            orderedBackendItemIds: ["item-1", "item-1"],
          },
        },
      },
      {
        ...valid,
        turnsById: {
          "turn-1": {
            ...valid.turnsById["turn-1"],
            completionCorrelations: ["operation-1", "operation-1"],
          },
        },
      },
      {
        ...valid,
        itemsById: {
          "item-1": {
            ...valid.itemsById["item-1"],
            backendItemId: "another-item",
          },
        },
      },
      {
        ...valid,
        itemsById: {
          "item-1": {
            ...valid.itemsById["item-1"],
            backendTurnId: "another-turn",
          },
        },
      },
      {
        ...valid,
        itemsById: {
          ...valid.itemsById,
          orphan: {
            ...valid.itemsById["item-1"],
            backendItemId: "orphan",
          },
        },
      },
      {
        ...valid,
        activeBackendTurnId: "missing-turn",
      },
    ];

    for (const candidate of invalid) {
      expect(
        backendConversationSnapshotSchema.safeParse(candidate).success,
      ).toBe(false);
    }
  });

  it("rejects structurally inconsistent normalized snapshots and history pages", () => {
    const timeline = {
      orderedTurnIds: ["turn-1"],
      turnsById: {
        "turn-1": {
          id: "turn-1",
          revision: 0,
          status: "completed" as const,
          orderedItemIds: ["item-1"],
        },
      },
      itemsById: {
        "item-1": {
          id: "item-1",
          turnId: "turn-1",
          kind: "assistant_message" as const,
          status: "completed" as const,
          revision: 0,
          markdown: { text: "Done" },
        },
      },
    };
    const invalid = [
      { ...timeline, orderedTurnIds: ["turn-1", "turn-1"] },
      {
        ...timeline,
        turnsById: {
          "turn-1": { ...timeline.turnsById["turn-1"], id: "wrong" },
        },
      },
      {
        ...timeline,
        turnsById: {
          "turn-1": {
            ...timeline.turnsById["turn-1"],
            orderedItemIds: ["item-1", "item-1"],
          },
        },
      },
      {
        ...timeline,
        itemsById: {
          "item-1": { ...timeline.itemsById["item-1"], id: "wrong" },
        },
      },
      {
        ...timeline,
        itemsById: {
          "item-1": {
            ...timeline.itemsById["item-1"],
            turnId: "wrong",
          },
        },
      },
      {
        ...timeline,
        itemsById: {
          ...timeline.itemsById,
          orphan: {
            ...timeline.itemsById["item-1"],
            id: "orphan",
          },
        },
      },
    ];

    for (const candidate of invalid) {
      expect(historyPageSchema.safeParse(candidate).success).toBe(false);
    }
  });

  it("rejects aggregate backend and normalized pages above their byte caps", () => {
    const text = "x".repeat(65_536);
    const backendItemIds = Array.from(
      {
        length:
          Math.floor(MAXIMUM_BACKEND_SNAPSHOT_OR_PAGE_BYTES / text.length) + 1,
      },
      (_, index) => `backend-item-${index}`,
    );
    const backendItems = Object.fromEntries(
      backendItemIds.map((backendItemId, sourceOrder) => [
        backendItemId,
        {
          backendItemId,
          backendTurnId: "backend-turn",
          semanticKind: "assistant_message",
          status: "completed",
          sourceOrder,
          markdown: { text },
        },
      ]),
    );
    expect(
      backendHistoryPageSchema.safeParse({
        orderedBackendTurnIds: ["backend-turn"],
        turnsById: {
          "backend-turn": {
            backendTurnId: "backend-turn",
            status: "completed",
            orderedBackendItemIds: backendItemIds,
          },
        },
        itemsById: backendItems,
      }).success,
    ).toBe(false);

    const itemIds = Array.from({ length: 512 }, (_, index) => `item-${index}`);
    const items = Object.fromEntries(
      itemIds.map((id) => [
        id,
        {
          id,
          turnId: "turn",
          kind: "assistant_message",
          status: "completed",
          revision: 0,
          markdown: { text },
        },
      ]),
    );
    expect(
      historyPageSchema.safeParse({
        orderedTurnIds: ["turn"],
        turnsById: {
          turn: {
            id: "turn",
            status: "completed",
            revision: 0,
            orderedItemIds: itemIds,
          },
        },
        itemsById: items,
      }).success,
    ).toBe(false);
  });

  it("keeps valid maximum-ish non-transcript thread state readable", () => {
    const display = { text: "d".repeat(4_000) };
    const interactions = Array.from({ length: 16 }, (_, interactionIndex) => ({
      id: `interaction-${interactionIndex}`,
      threadId: "thread",
      sourceLabel: { text: "Extension" },
      openedAt: "2026-07-30T12:00:00.000Z",
      secret: false,
      destructive: false,
      cancellable: true,
      kind: "choice" as const,
      title: { text: "Choose" },
      options: Array.from({ length: 60 }, (_, optionIndex) => ({
        id: `option-${optionIndex}`,
        label: display,
        description: display,
      })),
      multiple: false,
    }));
    const snapshot = {
      thread: {
        id: "thread",
        workspaceId: "workspace",
        targetId: "target",
        title: { text: "Large thread" },
        backend: { label: display, brand: "pi" },
        backingState: "bound",
        inventoryState: "active",
        inventoryRevision: 0,
        threadRevision: 0,
        runState: "idle",
        queuedInputCount: 0,
        available: true,
        lastActivityAt: "2026-07-30T12:00:00.000Z",
        stateChangedAt: "2026-07-30T12:00:00.000Z",
        automation: null,
      },
      executionWorkspace: { kind: "direct" as const },
      backendSessionId: "provider-native-session-1",
      workspace: {
        id: "workspace",
        environmentId: "environment",
        label: { text: "Workspace" },
        displayPath: { text: "/workspace" },
        available: true,
      },
      environment: {
        id: "environment",
        kind: "local",
        label: { text: "Machine" },
        available: true,
        directoryBrowsing: "available",
      },
      draft: {
        text: "x".repeat(262_144),
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 0,
      },
      stashes: Array.from({ length: 50 }, (_, index) => ({
        id: `stash-${index}`,
        text: "s".repeat(262_144),
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        createdAt: "2026-07-30T12:00:00.000Z",
      })),
      composerCommands: Array.from({ length: 512 }, (_, index) => ({
        invocation: `/command-${index}`,
        source: "extension" as const,
        description: display,
        argumentHint: display,
      })),
      agentTools: {
        enabled: false,
        groups: [
          {
            id: "context",
            label: display,
            description: display,
            order: 10,
            tools: [
              {
                id: "agent.context",
                label: { text: "Sedes agent context" },
                description: { text: "Returns the source context." },
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
        presentation: { surface: "native", mode: "progressive" },
        presentationOptions: [
          { surface: "native", modes: ["progressive", "individual"] },
          { surface: "cli", modes: ["progressive", "individual"] },
        ],
        accessBoundary: "environment" as const,
        revision: 0,
      },
      orderedTurnIds: [],
      turnsById: {},
      forkSource: {
        selectedCompletedTurn: {
          available: false,
          unavailableReason: { text: "No completed turn is available." },
        },
        latestProviderSnapshot: {
          available: false,
          unavailableReason: { text: "Provider snapshots are unavailable." },
        },
      },
      forksByTurnId: {},
      itemsById: {},
      history: { hasOlder: false },
      runState: "idle",
      queue: [],
      capabilities: {
        revision: "capabilities",
        backend: { label: { text: "Pi" } },
        interactionMode: "interactive",
        runState: "idle",
        operations: [],
        deliveryModes: [],
        settings: [],
        composerActions: [],
        nonblockingQuestions: false,
        providerOutputArtifacts: { nativeImage: false },
        composerAttachments: {
          fileStaging: {
            availability: "unavailable" as const,
            reason: { text: "Attachment staging is unavailable." },
          },
          nativeImage: {
            availability: "unavailable" as const,
            reason: { text: "Native image input is unavailable." },
          },
          policy: COMPOSER_ATTACHMENT_POLICY,
        },
        interactions: [],
        providerFeatures: [],
        history: { available: true, paginated: true },
        automation: {
          available: true,
          canAttach: true,
          canRunNow: true,
          canCloneOnRun: true,
        },
      },
      settings: { revision: 0, values: [] },
      providerFeatures: [],
      usage: {},
      interactions,
      attention: {},
    };

    expect(normalizedThreadSnapshotSchema.safeParse(snapshot).success).toBe(
      true,
    );
    const checkpoint = {
      eventId: "00000000-0000-4000-8000-000000000001.7",
      projectionGeneration: "checkpoint-generation",
      snapshot,
      notices: [],
      capabilityThreadRevision: snapshot.thread.threadRevision,
      capabilityRunState: snapshot.runState,
    };
    expect(threadCheckpointSchema.parse(checkpoint)).toEqual(checkpoint);
    expect(threadEventEnvelopeSchema.safeParse(checkpoint).success).toBe(false);
    expect(threadCheckpointSchema.safeParse({
      ...checkpoint,
      capabilityThreadRevision: snapshot.thread.threadRevision + 1,
    }).success).toBe(false);
    expect(threadCheckpointSchema.safeParse({
      ...checkpoint,
      eventId: "00000000-0000-4000-8000-000000000001.9007199254740992",
    }).success).toBe(false);
    expect(threadCheckpointSchema.safeParse({
      ...checkpoint,
      tenantId: "browser-selected-authority",
    }).success).toBe(false);
    const itemFeature = {
      ref: { featureId: "fixture.item_annotation", schemaVersion: 1 },
      payload: { kind: "object" as const, entries: [] },
    };
    const itemFeatureCapability = {
      ref: itemFeature.ref,
      revision: 1,
      label: { text: "Item annotation" },
      availability: "available" as const,
      operations: [],
      presentationSlots: ["conversation_item" as const],
    };
    const snapshotWithItemFeature = {
      ...snapshot,
      orderedTurnIds: ["turn-1"],
      turnsById: {
        "turn-1": {
          id: "turn-1",
          revision: 1,
          status: "completed" as const,
          endedBy: "agent_settled" as const,
          orderedItemIds: ["item-1"],
        },
      },
      forksByTurnId: {
        "turn-1": {
          sourceTurnId: "turn-1",
          expectedTurnRevision: 1,
          available: true,
        },
      },
      itemsById: {
        "item-1": {
          id: "item-1",
          turnId: "turn-1",
          status: "completed" as const,
          revision: 1,
          kind: "assistant_message" as const,
          markdown: { text: "Choose a path." },
          providerFeatures: [itemFeature],
        },
      },
      capabilities: {
        ...snapshot.capabilities,
        providerFeatures: [itemFeatureCapability],
      },
    };
    expect(
      normalizedThreadSnapshotSchema.safeParse(snapshotWithItemFeature).success,
    ).toBe(true);
    expect(
      normalizedThreadSnapshotSchema.safeParse({
        ...snapshotWithItemFeature,
        capabilities: snapshot.capabilities,
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadSnapshotSchema.safeParse({
        ...snapshotWithItemFeature,
        capabilities: {
          ...snapshot.capabilities,
          providerFeatures: [
            { ...itemFeatureCapability, presentationSlots: ["thread_details"] },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadSnapshotSchema.safeParse({
        ...snapshot,
        backendSessionId: "x".repeat(129),
      }).success,
    ).toBe(false);
    const { interactionMode: _interactionMode, ...legacyCapabilities } =
      snapshot.capabilities;
    expect(
      normalizedThreadSnapshotSchema.safeParse({
        ...snapshot,
        capabilities: legacyCapabilities,
      }).success,
    ).toBe(false);
    const {
      providerOutputArtifacts: _providerOutputArtifacts,
      ...missingOutputArtifactCapability
    } = snapshot.capabilities;
    expect(
      normalizedThreadSnapshotSchema.safeParse({
        ...snapshot,
        capabilities: missingOutputArtifactCapability,
      }).success,
    ).toBe(false);
  });

  it("rejects contradictory operation, history, and generation state", () => {
    expect(
      conversationItemSchema.safeParse({
        ...common,
        kind: "command",
        phase: "result_streaming",
        command: { text: "npm test" },
      }).success,
    ).toBe(false);
    expect(
      conversationHistoryWindowSchema.safeParse({
        hasOlder: true,
      }).success,
    ).toBe(false);
    expect(
      threadEventEnvelopeSchema.safeParse({
        eventId: "hub.1",
        projectionGeneration: "generation-a",
        event: {
          type: "run_state",
          generation: "generation-b",
          state: "idle",
        },
      }).success,
    ).toBe(false);
  });

  it("covers backend ancillary events without provider escape hatches", () => {
    expect(
      backendConversationEventSchema.parse({
        type: "turn_updated",
        turn: {
          backendTurnId: "turn-1",
          completionCorrelations: ["operation-1"],
          status: "in_progress",
          orderedBackendItemIds: [],
        },
      }),
    ).toMatchObject({ type: "turn_updated" });
    expect(
      backendConversationEventSchema.parse({
        type: "usage_changed",
        usage: {
          context: { usedTokens: 12, windowTokens: 100, percent: 12 },
        },
      }),
    ).toMatchObject({ type: "usage_changed" });
    expect(
      backendConversationEventSchema.safeParse({
        type: "notice",
        notice: {
          id: "notice-1",
          tone: "warning",
          message: { text: "Bounded notice" },
          createdAt: "2026-01-01T00:00:00.000Z",
          rawPiPayload: {},
        },
      }).success,
    ).toBe(false);
  });
});
