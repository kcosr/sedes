import { describe, expect, it, vi } from "vitest";
import { NormalizedApplicationStore } from "../../src/client/stores/NormalizedApplicationStore.js";
import {
  SEDES_CLIENT_PROTOCOL_VERSION,
  applicationEventEnvelopeSchema,
  createThreadFromSettingsRequestSchema,
  createThreadRequestSchema,
  normalizedApplicationSessionSchema,
  normalizedApplicationSnapshotSchema,
  normalizedThreadForkOriginSchema,
  normalizedThreadDescendantsPageSchema,
  normalizedSidebarAttentionSchema,
  type ApplicationEventEnvelope,
  type NormalizedApplicationSnapshot,
  type NormalizedApplicationThreadSummary,
} from "../../src/shared/index.js";
import { SEDES_VERSION } from "../../src/shared/version.js";

const hub = "00000000-0000-4000-8000-000000000001";
const now = "2026-07-30T15:00:00.000Z";

function thread(
  patch: Partial<NormalizedApplicationThreadSummary> = {},
): NormalizedApplicationThreadSummary {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    targetId: "target-1",
    title: { text: "Thread" },
    backend: { label: { text: "Pi" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 0,
    pinned: false,
    pinRevision: 0,
    groupId: null,
    groupAssignmentRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    threadRevision: 0,
    runState: "idle",
    terminalSummary: { runningCount: 0, retainedCount: 0 },
    queuedInputCount: 0,
    stashedPromptCount: 0,
    pendingQuestionCount: 0,
    available: true,
    lastActivityAt: now,
    stateChangedAt: now,
    automation: null,
    attention: {
      wake: false,
      automationContext: null,
      unseenCompletion: false,
      queueFailure: false,
    },
    ...patch,
    preferredWorktree: patch.preferredWorktree ?? null,
    preferredWorktreeRevision: patch.preferredWorktreeRevision ?? 0,
  };
}

function snapshot(): NormalizedApplicationSnapshot {
  return {
    advisories: [],
    environments: [
      {
        id: "environment-1",
        kind: "local" as const,
        label: { text: "Machine" },
        available: true,
        directoryBrowsing: "available" as const,
      },
    ],
    workspaces: [
      {
        id: "workspace-1",
        environmentId: "environment-1",
        label: { text: "Workspace" },
        displayPath: { text: "/workspace" },
        available: true,
      },
    ],
    threads: [thread()],
    forkOrigins: [],
    lineagePlacements: [],
    groups: [],
    lineageFamilies: [],
    executionTargets: [
      {
        id: "target-1",
        environmentId: "environment-1",
        label: { text: "Local SDK" },
        backend: { label: { text: "Pi" }, brand: "pi" },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
    ],
    defaultNewThreadTargetId: "target-1",
    counts: { active: 1, snoozed: 0, settled: 0, archived: 2 },
    tasks: [],
  };
}

function session() {
  return {
    clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
    version: SEDES_VERSION,
    csrfToken: "csrf-token",
    providerPulseEnabled: true,
  };
}

function seedStore(
  store: NormalizedApplicationStore,
  initialSnapshot: NormalizedApplicationSnapshot = snapshot(),
): void {
  expect(store.installSession(session())).toEqual({ kind: "applied" });
  expect(
    store.apply(
      envelope(4, {
        type: "snapshot",
        generation: "application-1",
        snapshot: initialSnapshot,
      }),
    ),
  ).toEqual({ kind: "applied" });
}

function envelope(
  sequence: number,
  event: ApplicationEventEnvelope["event"],
  eventHub = hub,
): ApplicationEventEnvelope {
  return {
    eventId: `${eventHub}.${sequence}`,
    applicationGeneration: event.generation,
    event,
  };
}

describe("normalized application protocol", () => {
  it("rejects mismatched descendant triples and ancestry cycles", () => {
    const child = thread({ id: "child" });
    const origin = {
      childThreadId: "child",
      sourceThreadId: "thread-1",
      sourceTurnId: "turn-1",
      sourceTurnCompletedAt: "2026-07-30T14:59:00.000Z",
      boundaryKind: "completed_turn_inclusive" as const,
      originKind: "user_fork" as const,
      initiatingAgentThreadId: null,
      initiatingToolClientId: null,
      branchMethod: "provider_native" as const,
      createdAt: now,
    };
    const placement = {
      childThreadId: "child",
      mode: "nested_under_source" as const,
      revision: 0,
      updatedAt: now,
    };
    expect(
      normalizedThreadDescendantsPageSchema.safeParse({
        descendants: [
          {
            thread: child,
            origin: { ...origin, childThreadId: "different" },
            placement,
          },
        ],
      }).success,
    ).toBe(false);

    const other = thread({ id: "other" });
    expect(
      normalizedApplicationSnapshotSchema.safeParse({
        ...snapshot(),
        threads: [child, other],
        forkOrigins: [
          { ...origin, sourceThreadId: "other" },
          {
            ...origin,
            childThreadId: "other",
            sourceThreadId: "child",
          },
        ],
        lineagePlacements: [
          placement,
          { ...placement, childThreadId: "other" },
        ],
        groups: [],
        lineageFamilies: [],
      }).success,
    ).toBe(false);
  });

  it("requires fork kinds to carry exactly their durable initiator", () => {
    const base = {
      childThreadId: "child",
      sourceThreadId: "thread-1",
      sourceTurnId: "turn-1",
      sourceTurnCompletedAt: "2026-07-30T14:59:00.000Z",
      boundaryKind: "completed_turn_inclusive" as const,
      branchMethod: "provider_native" as const,
      createdAt: now,
    };
    const clientId = "10000000-0000-4000-8000-000000000099";
    expect(
      normalizedThreadForkOriginSchema.safeParse({
        ...base,
        originKind: "principal_client_fork",
        initiatingAgentThreadId: null,
        initiatingToolClientId: clientId,
      }).success,
    ).toBe(true);
    for (const invalid of [
      {
        ...base,
        originKind: "principal_client_fork",
        initiatingAgentThreadId: null,
        initiatingToolClientId: null,
      },
      {
        ...base,
        originKind: "principal_client_fork",
        initiatingAgentThreadId: "controller-thread",
        initiatingToolClientId: clientId,
      },
      {
        ...base,
        originKind: "user_fork",
        initiatingAgentThreadId: null,
        initiatingToolClientId: clientId,
      },
    ]) {
      expect(normalizedThreadForkOriginSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("requires a create-time title and normalizes the explicit default", () => {
    expect(
      createThreadRequestSchema.safeParse({
        workspaceId: "10000000-0000-4000-8000-000000000001",
        configuration: { kind: "custom", targetId: "target-1" },
        executionWorkspace: { kind: "direct" },
      }).success,
    ).toBe(false);
    expect(
      createThreadRequestSchema.parse({
        workspaceId: "10000000-0000-4000-8000-000000000001",
        title: "  Sprint notes\nline  ",
        configuration: { kind: "custom", targetId: "target-1" },
        executionWorkspace: { kind: "direct" },
      }),
    ).toEqual({
      workspaceId: "10000000-0000-4000-8000-000000000001",
      title: "Sprint notes line",
      configuration: { kind: "custom", targetId: "target-1" },
      executionWorkspace: { kind: "direct" },
    });
    expect(
      createThreadRequestSchema.parse({
        workspaceId: "10000000-0000-4000-8000-000000000001",
        title: "   ",
        configuration: { kind: "custom", targetId: "target-1" },
        executionWorkspace: { kind: "direct" },
      }).title,
    ).toBe("New thread");
    expect(
      createThreadRequestSchema.parse({
        workspaceId: "10000000-0000-4000-8000-000000000001",
        title: `  ${"x".repeat(240)}  `,
        configuration: { kind: "custom", targetId: "target-1" },
        executionWorkspace: { kind: "direct" },
      }).title,
    ).toBe("x".repeat(240));
    expect(
      createThreadRequestSchema.safeParse({
        workspaceId: "10000000-0000-4000-8000-000000000001",
        title: "New thread",
      }).success,
    ).toBe(false);
    expect(
      createThreadRequestSchema.safeParse({
        workspaceId: "10000000-0000-4000-8000-000000000001",
        title: "x".repeat(241),
        configuration: { kind: "custom", targetId: "target-1" },
        executionWorkspace: { kind: "direct" },
      }).success,
    ).toBe(false);
  });

  it("accepts a strict idempotent same-settings thread request", () => {
    const mutationId = "30000000-0000-4000-8000-000000000001";
    expect(
      createThreadFromSettingsRequestSchema.parse({
        title: "  Follow-up\nthread  ",
        mutationId,
      }),
    ).toEqual({ title: "Follow-up thread", mutationId });
    expect(
      createThreadFromSettingsRequestSchema.safeParse({
        title: "New thread",
        mutationId,
        targetId: "browser-selected-target",
      }).success,
    ).toBe(false);
  });

  it("keeps session metadata small while inventory and provider details remain normalized", () => {
    expect(normalizedApplicationSessionSchema.parse(session())).toEqual(
      session(),
    );
    expect(
      normalizedApplicationSessionSchema.safeParse({
        ...session(),
        clientProtocolVersion: 1,
      }).success,
    ).toBe(false);
    const { providerPulseEnabled: _capability, ...missingCapability } =
      session();
    expect(
      normalizedApplicationSessionSchema.safeParse(missingCapability).success,
    ).toBe(false);
    const { stashedPromptCount: _omitted, ...missingStashCount } = thread();
    expect(
      normalizedApplicationSnapshotSchema.safeParse({
        ...snapshot(),
        threads: [missingStashCount],
      }).success,
    ).toBe(false);
    expect(
      normalizedApplicationSnapshotSchema.safeParse({
        ...snapshot(),
        threads: [thread({ stashedPromptCount: -1 })],
      }).success,
    ).toBe(false);
    const { pinned: _pinned, ...missingPinned } = thread();
    expect(
      normalizedApplicationSnapshotSchema.safeParse({
        ...snapshot(),
        threads: [missingPinned],
      }).success,
    ).toBe(false);
    expect(
      normalizedApplicationSnapshotSchema.safeParse({
        ...snapshot(),
        threads: [thread({ pinRevision: -1 })],
      }).success,
    ).toBe(false);
    const { pinRevision: _pinRevision, ...missingPinRevision } = thread();
    const validUpsert = envelope(5, {
      type: "thread_upsert",
      generation: "application-1",
      thread: thread(),
      counts: snapshot().counts,
    });
    expect(
      applicationEventEnvelopeSchema.safeParse({
        ...validUpsert,
        event: {
          type: "thread_upsert",
          generation: "application-1",
          thread: missingPinRevision,
          counts: snapshot().counts,
        },
      }).success,
    ).toBe(false);
    expect(
      normalizedThreadDescendantsPageSchema.safeParse({
        threads: [missingPinned],
        forkOrigins: [],
        lineagePlacements: [],
        nextCursor: null,
      }).success,
    ).toBe(false);
    expect(
      normalizedApplicationSessionSchema.safeParse({
        ...session(),
        piSessionRoot: "/sessions",
      }).success,
    ).toBe(false);
    expect(
      applicationEventEnvelopeSchema.safeParse({
        ...envelope(5, {
          type: "thread_upsert",
          generation: "application-1",
          thread: thread(),
          counts: snapshot().counts,
        }),
        event: {
          type: "thread_upsert",
          generation: "application-1",
          thread: { ...thread(), nativeSessionPath: "/pi/session.jsonl" },
          counts: snapshot().counts,
        },
      }).success,
    ).toBe(false);
    expect(
      applicationEventEnvelopeSchema.safeParse({
        ...envelope(5, {
          type: "inventory_counts_changed",
          generation: "application-1",
          counts: snapshot().counts,
        }),
        eventId: `${hub}.999999999999999999999`,
      }).success,
    ).toBe(false);
    expect(
      normalizedApplicationSnapshotSchema.safeParse({
        ...snapshot(),
        defaultNewThreadTargetId: "missing-target",
      }).success,
    ).toBe(false);
    expect(
      normalizedApplicationSnapshotSchema.safeParse({
        ...snapshot(),
        executionTargets: [
          ...snapshot().executionTargets,
          snapshot().executionTargets[0],
        ],
      }).success,
    ).toBe(false);
    expect(
      normalizedApplicationSnapshotSchema.safeParse({
        ...snapshot(),
        executionTargets: [
          {
            ...snapshot().executionTargets[0],
            environmentId: "unknown-environment",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps sidebar attention minimal and closed", () => {
    expect(
      normalizedSidebarAttentionSchema.parse({
        wake: true,
        automationContext: "failed",
        unseenCompletion: true,
        queueFailure: false,
      }),
    ).toEqual({
      wake: true,
      automationContext: "failed",
      unseenCompletion: true,
      queueFailure: false,
    });
    expect(
      normalizedSidebarAttentionSchema.safeParse({
        wake: true,
        automationContext: null,
        unseenCompletion: false,
        queueFailure: false,
        backendRequestId: "pi-request",
      }).success,
    ).toBe(false);
  });
});

describe("NormalizedApplicationStore", () => {
  it("delivers sequenced Workpad invalidations without replacing inventory", () => {
    const store = new NormalizedApplicationStore();
    seedStore(store);
    const before = store.state;
    const changed = vi.fn();
    const inventoryChanged = vi.fn();
    store.subscribe(inventoryChanged);
    const unsubscribe = store.subscribeWorkpadChanges(changed);
    const event = envelope(5, {
      type: "workpad_changed", generation: "application-1",
      workpadId: "workpad-1", revision: 3, change: "document",
    });
    expect(store.apply(event)).toEqual({ kind: "applied" });
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      workpadId: "workpad-1", revision: 3, change: "document",
    });
    expect(store.state).toBe(before);
    expect(inventoryChanged).not.toHaveBeenCalled();
    expect(store.replayCursor).toBe(`${hub}.5`);
    expect(store.apply(event)).toEqual({ kind: "ignored" });
    expect(changed).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(store.apply(envelope(6, {
      type: "workpad_changed", generation: "application-1",
      workpadId: "workpad-1", revision: 4, change: "draft",
    }))).toEqual({ kind: "applied" });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("resynchronizes separately loaded Workpads after a replay gap", () => {
    const store = new NormalizedApplicationStore();
    seedStore(store);
    const changed = vi.fn();
    store.subscribeWorkpadChanges(changed);
    expect(store.apply(envelope(6, {
      type: "workpad_changed", generation: "application-1",
      workpadId: "workpad-1", revision: 3, change: "draft",
    }))).toEqual({ kind: "resnapshot_required", reason: "application_transport_sequence_gap" });
    expect(changed).not.toHaveBeenCalled();
    expect(store.apply(envelope(7, {
      type: "snapshot", generation: "application-1", snapshot: snapshot(),
    }))).toEqual({ kind: "applied" });
    expect(changed).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(store.state.authoritative).toBe(true);
  });

  it("merges session capabilities without replacing streamed inventory", () => {
    const store = new NormalizedApplicationStore();
    const streamedSnapshot = {
      ...snapshot(),
      counts: { active: 7, snoozed: 0, settled: 0, archived: 2 },
    };

    expect(
      store.apply(
        envelope(5, {
          type: "snapshot",
          generation: "application-1",
          snapshot: streamedSnapshot,
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.providerPulseEnabled).toBeUndefined();

    expect(store.installSession(session())).toEqual({ kind: "applied" });
    expect(store.state).toMatchObject({
      authoritative: true,
      csrfToken: "csrf-token",
      providerPulseEnabled: true,
      snapshot: { counts: streamedSnapshot.counts },
    });

    expect(
      store.apply(
        envelope(6, {
          type: "inventory_counts_changed",
          generation: "application-1",
          counts: { active: 8, snoozed: 0, settled: 0, archived: 2 },
        }),
      ),
    ).toEqual({ kind: "applied" });
  });

  it("installs session metadata and atomically applies streamed inventory updates", () => {
    const store = new NormalizedApplicationStore();
    const listener = vi.fn();
    store.subscribe(listener);

    expect(store.installSession(session())).toEqual({ kind: "applied" });
    expect(store.replayCursor).toBeUndefined();
    expect(
      store.apply(
        envelope(4, {
          type: "snapshot",
          generation: "application-1",
          snapshot: snapshot(),
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.replayCursor).toBe(`${hub}.4`);
    expect(store.state.providerPulseEnabled).toBe(true);
    listener.mockClear();
    expect(
      store.apply(
        envelope(5, {
          type: "thread_upsert",
          generation: "application-1",
          thread: thread({
            inventoryState: "snoozed",
            inventoryRevision: 1,
            snoozedUntil: "2026-07-31T15:00:00.000Z",
            attention: {
              wake: true,
              automationContext: null,
              unseenCompletion: false,
              queueFailure: false,
            },
          }),
          counts: { active: 0, snoozed: 1, settled: 0, archived: 2 },
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.replayCursor).toBe(`${hub}.5`);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.state.snapshot).toMatchObject({
      counts: { active: 0, snoozed: 1, settled: 0, archived: 2 },
      threads: [
        {
          id: "thread-1",
          inventoryState: "snoozed",
          attention: { wake: true },
        },
      ],
    });
  });

  it("rejects transport gaps and requires a snapshot across generations", () => {
    const store = new NormalizedApplicationStore();
    seedStore(store);
    expect(
      store.apply(
        envelope(6, {
          type: "inventory_counts_changed",
          generation: "application-1",
          counts: snapshot().counts,
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "application_transport_sequence_gap",
    });
    expect(store.state.authoritative).toBe(false);

    const nextHub = "00000000-0000-4000-8000-000000000002";
    expect(
      store.apply(
        envelope(
          1,
          {
            type: "snapshot",
            generation: "application-2",
            snapshot: snapshot(),
          },
          nextHub,
        ),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state).toMatchObject({
      authoritative: true,
      generation: "application-2",
      csrfToken: "csrf-token",
    });
  });

  it("clears inventory authority and transport cursor without losing session metadata", () => {
    const store = new NormalizedApplicationStore();
    seedStore(store);

    store.resetInventory();

    expect(store.replayCursor).toBeUndefined();
    expect(store.state).toEqual({
      authoritative: false,
      csrfToken: "csrf-token",
      providerPulseEnabled: true,
      generation: "application-1",
      snapshot: snapshot(),
    });
    expect(
      store.apply(
        envelope(5, {
          type: "inventory_counts_changed",
          generation: "application-1",
          counts: snapshot().counts,
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "initial_application_snapshot_missing",
    });
  });

  it("rejects revision regression and dangling inventory references", () => {
    const store = new NormalizedApplicationStore();
    const initial = {
      ...snapshot(),
      threads: [
        thread({ inventoryRevision: 2, pinRevision: 2, threadRevision: 3 }),
      ],
    };
    seedStore(store, initial);

    expect(
      store.apply(
        envelope(5, {
          type: "thread_upsert",
          generation: "application-1",
          thread: thread({ inventoryRevision: 1, threadRevision: 3 }),
          counts: snapshot().counts,
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "application_thread_revision_regressed",
    });

    seedStore(store, initial);
    expect(
      store.apply(
        envelope(5, {
          type: "thread_upsert",
          generation: "application-1",
          thread: thread({
            inventoryRevision: 2,
            pinRevision: 1,
            groupId: null,
            groupAssignmentRevision: 0,
            threadRevision: 3,
          }),
          counts: snapshot().counts,
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "application_thread_revision_regressed",
    });

    seedStore(store, initial);
    expect(
      store.apply(
        envelope(5, {
          type: "workspace_remove",
          generation: "application-1",
          workspaceId: "workspace-1",
        }),
      ),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "application_inventory_reference_invalid",
    });
    expect(store.state.snapshot?.workspaces).toHaveLength(1);
  });

  it("ignores replayed transport events and rejects invalid payloads", () => {
    const store = new NormalizedApplicationStore();
    seedStore(store);
    const update = envelope(5, {
      type: "inventory_counts_changed",
      generation: "application-1",
      counts: { active: 1, snoozed: 0, settled: 0, archived: 3 },
    });
    expect(store.apply(update)).toEqual({ kind: "applied" });
    expect(store.apply(update)).toEqual({ kind: "ignored" });
    expect(
      store.apply({
        ...envelope(6, {
          type: "inventory_counts_changed",
          generation: "application-1",
          counts: snapshot().counts,
        }),
        applicationGeneration: "application-2",
      }),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "invalid_application_event",
    });
  });

  it("allows an authoritative snapshot at the current watermark to recover", () => {
    const store = new NormalizedApplicationStore();
    seedStore(store);
    expect(store.apply({ invalid: true })).toMatchObject({
      kind: "resnapshot_required",
    });
    expect(
      store.apply(
        envelope(4, {
          type: "snapshot",
          generation: "application-1",
          snapshot: snapshot(),
        }),
      ),
    ).toEqual({ kind: "applied" });
    expect(store.state.authoritative).toBe(true);

    expect(
      store.apply(
        envelope(4, {
          type: "snapshot",
          generation: "application-stale",
          snapshot: {
            ...snapshot(),
            counts: { active: 99, snoozed: 0, settled: 0, archived: 0 },
          },
        }),
      ),
    ).toEqual({ kind: "ignored" });
    expect(store.state.generation).toBe("application-1");
    expect(store.state.snapshot?.counts.active).toBe(1);
  });
});
