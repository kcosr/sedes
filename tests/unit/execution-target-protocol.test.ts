import { describe, expect, it } from "vitest";
import {
  SEDES_CLIENT_PROTOCOL_VERSION,
  associatedTaskSchema,
  normalizedApplicationSnapshotSchema,
} from "../../src/shared/index.js";
import { SEDES_VERSION } from "../../src/shared/version.js";
import type { AssociatedTask } from "../../src/shared/index.js";
import { NormalizedApplicationStore } from "../../src/client/stores/NormalizedApplicationStore.js";

const WORKSPACE_ID = "30000000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "30000000-0000-4000-8000-000000000002";
const THREAD_ID = "40000000-0000-4000-8000-000000000001";
const ARCHIVED_THREAD_ID = "40000000-0000-4000-8000-000000000002";

function snapshot() {
  return {
    environments: [
      {
        id: "environment-1",
        kind: "local" as const,
        label: { text: "Local" },
        available: true,
        directoryBrowsing: "available" as const,
      },
      {
        id: "environment-2",
        kind: "ssh" as const,
        label: { text: "Remote" },
        available: false,
        directoryBrowsing: "unavailable" as const,
      },
    ],
    workspaces: [
      {
        id: WORKSPACE_ID,
        environmentId: "environment-1",
        label: { text: "Sedes" },
        displayPath: { text: "/work/sedes" },
        available: true,
      },
    ],
    executionTargets: [
      {
        id: "target-1",
        environmentId: "environment-1",
        label: { text: "Local Pi" },
        backend: { label: { text: "Pi" }, brand: "pi" as const },
        workspaceExecution: { kind: "direct_only" as const },
        available: true,
      },
      {
        id: "target-2",
        environmentId: "environment-2",
        label: { text: "Remote Codex" },
        backend: { label: { text: "Codex" }, brand: "codex" as const },
        workspaceExecution: { kind: "direct_only" as const },
        available: false,
        unavailableReason: { text: "Remote target is unavailable." },
      },
    ],
    advisories: [],
    defaultNewThreadTargetId: "target-1",
    threads: [
      {
        id: THREAD_ID,
        workspaceId: WORKSPACE_ID,
        targetId: "target-1",
        title: { text: "Target-aware inventory" },
        backend: { label: { text: "Pi" }, brand: "pi" as const },
        backingState: "bound" as const,
        inventoryState: "active" as const,
        inventoryRevision: 0,
        preferredWorktree: null,
        preferredWorktreeRevision: 0,
        pinned: false,
        pinRevision: 0,
        bookmarkRevision: 0,
        turnBookmarkCount: 0,
        groupId: null,
        groupAssignmentRevision: 0,
        threadRevision: 0,
        runState: "idle" as const,
        terminalSummary: { runningCount: 0, retainedCount: 0 },
        queuedInputCount: 0,
        stashedPromptCount: 0,
        pendingQuestionCount: 0,
        available: true,
        lastActivityAt: "2026-08-09T12:00:00.000Z",
        stateChangedAt: "2026-08-09T12:00:00.000Z",
        automation: null,
        attention: {
          wake: false,
          automationContext: null,
          unseenCompletion: false,
          queueFailure: false,
        },
      },
    ],
    forkOrigins: [],
    lineagePlacements: [],
    groups: [],
    lineageFamilies: [],
    counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
    tasks: [] as AssociatedTask[],
  };
}

function associatedTask(
  scope:
    | { readonly kind: "global" }
    | { readonly kind: "workspace"; readonly workspaceId: string }
    | { readonly kind: "thread"; readonly threadId: string },
  associatedWorkspaceId: string | null,
) {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    scope,
    associatedWorkspaceId,
    title: "Task",
    details: "",
    pinned: false,
    files: [],
    completedAt: null,
    revision: 0,
    createdAt: "2026-08-09T12:00:00.000Z",
    updatedAt: "2026-08-09T12:00:00.000Z",
  };
}

describe("execution-target application protocol", () => {
  it("uses the current client protocol for associated task presentation", () => {
    expect(SEDES_CLIENT_PROTOCOL_VERSION).toBe(121);
  });

  it("enforces exact associated-workspace semantics on task projections", () => {
    expect(
      associatedTaskSchema.safeParse(
        associatedTask({ kind: "global" }, WORKSPACE_ID),
      ).success,
    ).toBe(false);
    expect(
      associatedTaskSchema.safeParse(
        associatedTask(
          { kind: "workspace", workspaceId: WORKSPACE_ID },
          OTHER_WORKSPACE_ID,
        ),
      ).success,
    ).toBe(false);
    expect(
      associatedTaskSchema.safeParse(
        associatedTask({ kind: "thread", threadId: THREAD_ID }, null),
      ).success,
    ).toBe(false);
  });

  it("accepts omitted threads but checks known workspace and present-thread association", () => {
    const omittedThread = snapshot();
    omittedThread.tasks = [
      associatedTask(
        { kind: "thread", threadId: ARCHIVED_THREAD_ID },
        WORKSPACE_ID,
      ),
    ];
    expect(
      normalizedApplicationSnapshotSchema.safeParse(omittedThread).success,
    ).toBe(true);

    const unknownWorkspace = snapshot();
    unknownWorkspace.tasks = [
      associatedTask(
        { kind: "thread", threadId: ARCHIVED_THREAD_ID },
        OTHER_WORKSPACE_ID,
      ),
    ];
    expect(
      normalizedApplicationSnapshotSchema.safeParse(unknownWorkspace).success,
    ).toBe(false);

    const mismatchedPresentThread = snapshot();
    mismatchedPresentThread.workspaces.push({
      ...mismatchedPresentThread.workspaces[0]!,
      id: OTHER_WORKSPACE_ID,
      label: { text: "Other project" },
    });
    mismatchedPresentThread.tasks = [
      associatedTask(
        { kind: "thread", threadId: THREAD_ID },
        OTHER_WORKSPACE_ID,
      ),
    ];
    expect(
      normalizedApplicationSnapshotSchema.safeParse(mismatchedPresentThread)
        .success,
    ).toBe(false);
  });

  it("accepts available and retained unavailable targets", () => {
    expect(normalizedApplicationSnapshotSchema.parse(snapshot())).toEqual(
      snapshot(),
    );
  });

  it("requires selectable workspace execution defaults to use an advertised network profile", () => {
    const valid = {
      ...snapshot(),
      executionTargets: [
        {
          ...snapshot().executionTargets[0]!,
          workspaceExecution: {
            kind: "selectable" as const,
            default: {
              kind: "isolated" as const,
              workspaceAccess: "writable_clone" as const,
              networkProfile: "isolated" as const,
            },
            isolatedNetworkProfiles: [
              "isolated" as const,
              "execution_host" as const,
            ],
          },
        },
        snapshot().executionTargets[1]!,
      ],
    };
    expect(normalizedApplicationSnapshotSchema.safeParse(valid).success).toBe(
      true,
    );

    const invalid = {
      ...snapshot(),
      executionTargets: [
        {
          ...snapshot().executionTargets[0]!,
          workspaceExecution: {
            kind: "selectable" as const,
            default: {
              kind: "isolated" as const,
              workspaceAccess: "writable_clone" as const,
              networkProfile: "execution_host" as const,
            },
            isolatedNetworkProfiles: ["isolated" as const],
          },
        },
        snapshot().executionTargets[1]!,
      ],
    };
    expect(normalizedApplicationSnapshotSchema.safeParse(invalid).success).toBe(
      false,
    );
  });

  it("requires the normalized Local or SSH environment kind", () => {
    const missing = snapshot();
    const { kind: _kind, ...environmentWithoutKind } = missing.environments[0]!;
    missing.environments[0] = environmentWithoutKind as never;
    expect(normalizedApplicationSnapshotSchema.safeParse(missing).success).toBe(
      false,
    );

    const unknown = snapshot();
    unknown.environments[0]!.kind = "container" as never;
    expect(normalizedApplicationSnapshotSchema.safeParse(unknown).success).toBe(
      false,
    );
  });

  it("requires the default target to be available", () => {
    expect(
      normalizedApplicationSnapshotSchema.safeParse({
        ...snapshot(),
        defaultNewThreadTargetId: "target-2",
      }).success,
    ).toBe(false);
  });

  it("requires every thread target to exist and match its workspace environment", () => {
    const missing = snapshot();
    missing.threads[0]!.targetId = "missing-target";
    expect(normalizedApplicationSnapshotSchema.safeParse(missing).success).toBe(
      false,
    );

    const mismatched = snapshot();
    mismatched.threads[0]!.targetId = "target-2";
    expect(
      normalizedApplicationSnapshotSchema.safeParse(mismatched).success,
    ).toBe(false);
  });

  it("requires thread backend presentation to agree with its exact target", () => {
    const mismatched = snapshot();
    mismatched.threads[0]!.backend.label.text = "Another Pi";
    expect(
      normalizedApplicationSnapshotSchema.safeParse(mismatched).success,
    ).toBe(false);
  });

  it("keeps target availability independent from environment channel availability", () => {
    const contradictory = snapshot();
    contradictory.executionTargets[0]!.unavailableReason = {
      text: "Should not be present.",
    };
    expect(
      normalizedApplicationSnapshotSchema.safeParse(contradictory).success,
    ).toBe(false);

    const environmentUnavailable = snapshot();
    environmentUnavailable.environments[0]!.available = false;
    expect(
      normalizedApplicationSnapshotSchema.safeParse(environmentUnavailable)
        .success,
    ).toBe(true);
  });

  it("requires a resnapshot when a thread upsert omits target identity", () => {
    const store = new NormalizedApplicationStore();
    expect(
      store.installSession({
        clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
        version: SEDES_VERSION,
        csrfToken: "csrf",
        providerPulseEnabled: true,
      }),
    ).toEqual({ kind: "applied" });
    expect(
      store.apply({
        eventId: "10000000-0000-4000-8000-000000000001.1",
        applicationGeneration: "application-1",
        event: {
          type: "snapshot",
          generation: "application-1",
          snapshot: snapshot(),
        },
      }),
    ).toEqual({ kind: "applied" });
    const { targetId: _targetId, ...threadWithoutTarget } =
      snapshot().threads[0]!;

    expect(
      store.apply({
        eventId: "10000000-0000-4000-8000-000000000001.1",
        applicationGeneration: "application-1",
        event: {
          type: "thread_upsert",
          generation: "application-1",
          thread: threadWithoutTarget,
          counts: snapshot().counts,
        },
      }),
    ).toEqual({
      kind: "resnapshot_required",
      reason: "invalid_application_event",
    });
  });
});
