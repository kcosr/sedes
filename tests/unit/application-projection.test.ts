import { afterEach, describe, expect, it, vi } from "vitest";
import { ApplicationProjection } from "../../src/server/events/application-projection.js";
import { NormalizedApplicationStore } from "../../src/client/stores/NormalizedApplicationStore.js";
import {
  normalizedApplicationSnapshotSchema,
  type NormalizedApplicationEvent,
  type NormalizedApplicationSnapshot as Snapshot,
  type NormalizedApplicationThreadSummary as Thread,
} from "../../src/shared/protocol/application.js";
import type { AssociatedTask } from "../../src/shared/protocol/tasks.js";
import { MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES } from "../../src/shared/protocol/payload.js";

type Delta = Exclude<NormalizedApplicationEvent, { type: "snapshot" }>;
const generation = "00000000-0000-4000-8000-000000000001";
const workspaceId = "00000000-0000-4000-8000-000000000002";
const threadId = "00000000-0000-4000-8000-000000000003";
const now = "2026-09-18T00:00:00.000Z";
const uuid = (index: number) =>
  `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const bytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

function thread(patch: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    workspaceId,
    targetId: "target",
    title: { text: "Thread" },
    backend: { label: { text: "Pi" }, brand: "pi" },
    backingState: "bound",
    inventoryState: "active",
    inventoryRevision: 0,
    pinned: false,
    pinRevision: 0,
    preferredWorktree: null,
    preferredWorktreeRevision: 0,
    bookmarkRevision: 0,
    turnBookmarkCount: 0,
    groupId: null,
    groupAssignmentRevision: 0,
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
  };
}
function task(index = 1, patch: Partial<AssociatedTask> = {}): AssociatedTask {
  return {
    id: uuid(index),
    scope: { kind: "global" },
    associatedWorkspaceId: null,
    title: "Task",
    details: "",
    pinned: false,
    files: [],
    completedAt: null,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    ...patch,
  };
}
function snapshot(): Snapshot {
  return {
    environments: [
      {
        id: "environment",
        kind: "local",
        label: { text: "Local" },
        available: true,
        directoryBrowsing: "available",
      },
    ],
    workspaces: [
      {
        id: workspaceId,
        environmentId: "environment",
        label: { text: "Workspace" },
        displayPath: { text: "/workspace" },
        available: true,
      },
    ],
    threads: [thread()],
    groups: [],
    forkOrigins: [],
    lineagePlacements: [],
    lineageFamilies: [],
    executionTargets: [
      {
        id: "target",
        environmentId: "environment",
        label: { text: "Local" },
        backend: { label: { text: "Pi" }, brand: "pi" },
        workspaceExecution: { kind: "direct_only" },
        available: true,
      },
    ],
    advisories: [],
    defaultNewThreadTargetId: "target",
    counts: { active: 1, snoozed: 0, settled: 0, archived: 0 },
    tasks: [],
  };
}
function update(projection: ApplicationProjection, value: Thread): void {
  projection.prepare({
    type: "thread_upsert",
    generation,
    thread: value,
    counts: projection.counts,
  })();
}
function envelope(sequence: number, event: NormalizedApplicationEvent) {
  return {
    eventId: `${generation}.${sequence}`,
    applicationGeneration: generation,
    event,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("indexed application projection", () => {
  it("folds every incremental kind with client-equivalent ordering and exact UTF-8 bytes", () => {
    const seed = snapshot();
    const projection = new ApplicationProjection(seed);
    const client = new NormalizedApplicationStore();
    client.apply(envelope(1, { type: "snapshot", generation, snapshot: seed }));
    const environment = {
      ...seed.environments[0]!,
      id: "other",
      label: { text: "東京 😀" },
    };
    const workspace = {
      ...seed.workspaces[0]!,
      id: uuid(90),
      environmentId: "other",
    };
    const other = thread({
      id: uuid(91),
      title: { text: 'Line\n"quoted" 😀' },
    });
    const changes: Delta[] = [
      { type: "environment_upsert", generation, environment },
      {
        type: "environment_upsert",
        generation,
        environment: { ...environment, available: false },
      },
      { type: "workspace_upsert", generation, workspace },
      {
        type: "workspace_upsert",
        generation,
        workspace: { ...workspace, label: { text: "Édité" } },
      },
      {
        type: "thread_upsert",
        generation,
        thread: other,
        counts: { ...seed.counts, active: 2 },
      },
      {
        type: "thread_upsert",
        generation,
        thread: { ...other, threadRevision: 1 },
        counts: seed.counts,
      },
      {
        type: "task_upsert",
        generation,
        task: task(1, { details: '😀\n"\t' }),
      },
      { type: "task_upsert", generation, task: task(2) },
      {
        type: "task_upsert",
        generation,
        task: task(1, { revision: 1, title: "Updated" }),
      },
      {
        type: "inventory_counts_changed",
        generation,
        counts: { ...seed.counts, archived: 100 },
      },
      {
        type: "workpad_changed",
        generation,
        workpadId: "workpad",
        revision: 2,
        change: "document",
      },
      { type: "task_remove", generation, taskId: uuid(1) },
      { type: "task_remove", generation, taskId: uuid(2) },
      { type: "task_remove", generation, taskId: uuid(2) },
      {
        type: "thread_remove",
        generation,
        threadId: other.id,
        counts: seed.counts,
      },
      { type: "workspace_remove", generation, workspaceId: workspace.id },
      { type: "environment_remove", generation, environmentId: environment.id },
    ];
    for (const [index, event] of changes.entries()) {
      projection.prepare(event)();
      expect(client.apply(envelope(index + 2, event))).toEqual({
        kind: "applied",
      });
      const current = projection.materialize();
      expect(current).toEqual(client.state.snapshot);
      expect(projection.serializedBytes).toBe(bytes(current));
    }
  });

  it("never changes installed state during preparation and rejects reused or stale commits", () => {
    const projection = new ApplicationProjection(snapshot());
    const original = projection.materialize();
    const first = projection.prepare({
      type: "inventory_counts_changed",
      generation,
      counts: { ...projection.counts, active: 2 },
    });
    const stale = projection.prepare({
      type: "inventory_counts_changed",
      generation,
      counts: { ...projection.counts, active: 3 },
    });
    expect(projection.materialize()).toEqual(original);
    first();
    expect(() => first()).toThrow(
      "application_projection_prepared_update_stale",
    );
    expect(() => stale()).toThrow(
      "application_projection_prepared_update_stale",
    );
    expect(projection.counts.active).toBe(2);
  });

  it("owns immutable copies of seeds, deltas, lookups, counts and checkpoints", () => {
    const seed = snapshot();
    const projection = new ApplicationProjection(seed);
    seed.threads[0]!.title.text = "Mutated seed";
    const value = thread({ title: { text: "New" } });
    const event: Delta = {
      type: "thread_upsert",
      generation,
      thread: value,
      counts: { ...seed.counts, active: 2 },
    };
    const commit = projection.prepare(event);
    value.title.text = "Mutated event";
    event.counts.active = 9;
    commit();
    expect(projection.get("threads", threadId)!.title.text).toBe("New");
    expect(projection.counts.active).toBe(2);
    expect(() => {
      projection.get("threads", threadId)!.title.text = "Mutation";
    }).toThrow();
    expect(() => {
      projection.counts.active = 3;
    }).toThrow();
    const checkpoint = projection.materialize();
    expect(() => checkpoint.threads.push(thread())).toThrow();
    update(projection, thread({ title: { text: "Later" } }));
    expect(checkpoint.threads[0]!.title.text).toBe("New");
  });

  it("validates deltas and rejects dangling references without consuming state", () => {
    const projection = new ApplicationProjection(snapshot());
    const original = projection.materialize();
    const invalid: unknown[] = [
      { type: "unknown", generation },
      {
        type: "inventory_counts_changed",
        generation,
        counts: { ...projection.counts, active: -1 },
      },
      { type: "environment_remove", generation, environmentId: "environment" },
      { type: "workspace_remove", generation, workspaceId },
      {
        type: "thread_upsert",
        generation,
        thread: thread({ workspaceId: "missing" }),
        counts: projection.counts,
      },
      {
        type: "thread_upsert",
        generation,
        thread: thread({ targetId: "missing" }),
        counts: projection.counts,
      },
      {
        type: "thread_upsert",
        generation,
        thread: thread({ groupId: uuid(200) }),
        counts: projection.counts,
      },
      {
        type: "thread_upsert",
        generation,
        thread: thread({
          backend: { brand: "codex", label: { text: "Codex" } },
        }),
        counts: projection.counts,
      },
      {
        type: "task_upsert",
        generation,
        task: task(1, {
          scope: { kind: "workspace", workspaceId: uuid(99) },
          associatedWorkspaceId: uuid(99),
        }),
      },
    ];
    for (const event of invalid) {
      expect(() => projection.prepare(event as Delta)).toThrow();
      expect(projection.materialize()).toEqual(original);
    }
  });

  it.each([
    "inventoryRevision",
    "pinRevision",
    "preferredWorktreeRevision",
    "groupAssignmentRevision",
    "threadRevision",
    "bookmarkRevision",
  ] as const)("rejects regressing %s", (field) => {
    const seed = snapshot();
    seed.threads[0]![field] = 2;
    const projection = new ApplicationProjection(seed);
    expect(() => update(projection, thread({ [field]: 1 }))).toThrow(
      "application_thread_revision_regressed",
    );
  });

  it("rejects regressing Task revisions and mismatched thread associations", () => {
    const seed = snapshot();
    seed.tasks = [task(1, { revision: 2 })];
    seed.workspaces.push({ ...seed.workspaces[0]!, id: uuid(2) });
    const projection = new ApplicationProjection(seed);
    expect(() =>
      projection.prepare({
        type: "task_upsert",
        generation,
        task: task(1, { revision: 1 }),
      }),
    ).toThrow("application_task_revision_regressed");
    expect(() =>
      projection.prepare({
        type: "task_upsert",
        generation,
        task: task(2, {
          scope: { kind: "thread", threadId },
          associatedWorkspaceId: uuid(2),
        }),
      }),
    ).toThrow("application_inventory_reference_invalid");
    projection.prepare({
      type: "task_upsert",
      generation,
      task: task(2, {
        scope: { kind: "thread", threadId },
        associatedWorkspaceId: workspaceId,
      }),
    })();
    expect(() => update(projection, thread({ workspaceId: uuid(2) }))).toThrow(
      "application_inventory_reference_invalid",
    );
  });

  it("allows Tasks to outlive omitted threads but rejects lineage orphaning", () => {
    const seed = snapshot();
    seed.tasks = Array.from({ length: 100 }, (_, index) =>
      task(index, {
        scope: { kind: "thread", threadId },
        associatedWorkspaceId: workspaceId,
      }),
    );
    const projection = new ApplicationProjection(seed);
    expect(projection.referencesThread(threadId)).toBe(false);
    projection.prepare({
      type: "thread_remove",
      generation,
      threadId,
      counts: seed.counts,
    })();
    expect(projection.materialize().tasks).toHaveLength(100);
    seed.threads.push(thread({ id: uuid(500) }));
    seed.forkOrigins = [
      {
        childThreadId: uuid(500),
        sourceThreadId: threadId,
        sourceTurnId: null,
        sourceTurnCompletedAt: null,
        boundaryKind: "completed_turn_inclusive",
        originKind: "user_fork",
        initiatingAgentThreadId: null,
        initiatingToolClientId: null,
        branchMethod: "provider_native",
        createdAt: now,
      },
    ];
    seed.lineagePlacements = [
      {
        childThreadId: uuid(500),
        mode: "nested_under_source",
        revision: 0,
        updatedAt: now,
      },
    ];
    seed.lineageFamilies = [{ sourceThreadId: threadId, descendantCount: 1 }];
    const lineage = new ApplicationProjection(seed);
    expect(lineage.referencesThread(threadId)).toBe(true);
    expect(lineage.referencesThread(uuid(500))).toBe(true);
    expect(() =>
      lineage.prepare({
        type: "thread_remove",
        generation,
        threadId,
        counts: seed.counts,
      }),
    ).toThrow("application_inventory_reference_invalid");
    expect(lineage.materialize()).toEqual(seed);
  });

  it("caps affected adjacency at 64 and leaves ordinary high-fanout updates incremental", () => {
    const seed = snapshot();
    seed.tasks = Array.from({ length: 64 }, (_, index) =>
      task(index, {
        scope: { kind: "thread", threadId },
        associatedWorkspaceId: workspaceId,
      }),
    );
    seed.threads = [];
    const projection = new ApplicationProjection(seed);
    update(projection, thread());
    expect(projection.materialize().threads).toHaveLength(1);
    seed.tasks.push(
      task(64, {
        scope: { kind: "thread", threadId },
        associatedWorkspaceId: workspaceId,
      }),
    );
    const over = new ApplicationProjection(seed);
    expect(() => update(over, thread())).toThrow(
      "application_projection_reference_budget",
    );
    seed.threads = [thread()];
    const highFanout = new ApplicationProjection(seed);
    update(highFanout, thread({ runState: "running" }));
    expect(highFanout.materialize().threads[0]!.runState).toBe("running");
  });

  it("checks dependents when a workspace changes environment", () => {
    const seed = snapshot();
    seed.environments.push({ ...seed.environments[0]!, id: "other" });
    const projection = new ApplicationProjection(seed);
    expect(() =>
      projection.prepare({
        type: "workspace_upsert",
        generation,
        workspace: { ...seed.workspaces[0]!, environmentId: "other" },
      }),
    ).toThrow("application_inventory_reference_invalid");
  });

  it("retains opaque identifiers containing separators in reference indexes", () => {
    const seed = snapshot();
    seed.environments[0]!.id = "environment\0suffix";
    seed.workspaces[0]!.environmentId = "environment\0suffix";
    seed.executionTargets[0]!.environmentId = "environment\0suffix";
    const projection = new ApplicationProjection(seed);
    projection.prepare({
      type: "workspace_upsert",
      generation,
      workspace: { ...seed.workspaces[0]!, label: { text: "Updated" } },
    })();
    expect(projection.materialize().workspaces[0]!.label.text).toBe("Updated");
  });

  it("rejects duplicate seed identities and collection overflow", () => {
    const seed = snapshot();
    seed.threads.push(thread());
    expect(() => new ApplicationProjection(seed)).toThrow();
    seed.threads = [thread()];
    seed.environments = Array.from({ length: 256 }, (_, index) => ({
      ...seed.environments[0]!,
      id: index === 0 ? "environment" : `environment-${index}`,
    }));
    const projection = new ApplicationProjection(seed);
    expect(() =>
      projection.prepare({
        type: "environment_upsert",
        generation,
        environment: { ...seed.environments[0]!, id: "overflow" },
      }),
    ).toThrow("application_projection_collection_limit");
  });

  it("sets audit deadlines only for state changes, and resets them after an independent audit", () => {
    const clock = vi.spyOn(performance, "now").mockReturnValue(500);
    const projection = new ApplicationProjection(snapshot());
    for (let index = 0; index < 1_025; index++) {
      update(projection, thread());
      projection.prepare({
        type: "workpad_changed",
        generation,
        workpadId: "workpad",
        revision: index,
        change: "draft",
      })();
    }
    expect(projection.auditDeadline).toBeUndefined();
    expect(projection.auditDue(1_000_000)).toBe(false);
    update(projection, thread({ threadRevision: 1 }));
    expect(projection.auditDeadline).toBe(60_500);
    expect(projection.auditDue(60_499)).toBe(false);
    expect(projection.auditDue(60_500)).toBe(true);
    clock.mockReturnValue(1_000);
    update(projection, thread({ threadRevision: 2 }));
    expect(projection.auditDeadline).toBe(60_500);
    projection.materialize();
    expect(projection.auditDue(1_000_000)).toBe(false);
    expect(projection.auditDeadline).toBeUndefined();
  });

  it("audits after 1024 changed folds or 8 MiB of examined changed entity bytes", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const projection = new ApplicationProjection(snapshot());
    for (let index = 1; index <= 1_023; index++)
      update(projection, thread({ threadRevision: index }));
    expect(projection.auditDue()).toBe(false);
    update(projection, thread({ threadRevision: 1_024 }));
    expect(projection.auditDue()).toBe(true);
    projection.materialize();
    const large = task(1, { details: "😀".repeat(32_768) });
    let examined = 0;
    let previousBytes = 0;
    for (let revision = 0; examined < 8 * 1_024 * 1_024; revision++) {
      const next = { ...large, revision };
      projection.prepare({ type: "task_upsert", generation, task: next })();
      examined += previousBytes + bytes(next);
      previousBytes = bytes(next);
      expect(projection.auditDue()).toBe(examined >= 8 * 1_024 * 1_024);
    }
  });

  it("never validates or serializes the whole inventory on ordinary folds at 10000 threads", () => {
    const seed = snapshot();
    seed.threads = Array.from({ length: 10_000 }, (_, index) =>
      thread({ id: uuid(index) }),
    );
    const projection = new ApplicationProjection(seed);
    const parse = vi.spyOn(normalizedApplicationSnapshotSchema, "parse");
    const stringify = vi.spyOn(JSON, "stringify");
    update(projection, thread({ id: uuid(500), threadRevision: 1 }));
    expect(parse).not.toHaveBeenCalled();
    expect(
      stringify.mock.calls.every(
        ([value]) =>
          !(value && typeof value === "object" && "environments" in value),
      ),
    ).toBe(true);
    expect(projection.get("threads", uuid(500))!.threadRevision).toBe(1);
  });

  it("admits exact 32 MiB state and rejects one extra byte before mutation", () => {
    const seed = snapshot();
    seed.counts.active = 9;
    seed.tasks = Array.from({ length: 512 }, (_, index) => task(index));
    let remaining = MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES - 1 - bytes(seed);
    for (const value of seed.tasks) {
      const count = Math.min(remaining, 65_536);
      value.details = "x".repeat(count);
      remaining -= count;
    }
    expect(remaining).toBe(0);
    const projection = new ApplicationProjection(seed);
    expect(projection.serializedBytes).toBe(
      MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES - 1,
    );
    projection.prepare({
      type: "inventory_counts_changed",
      generation,
      counts: { ...seed.counts, active: 99 },
    })();
    expect(projection.serializedBytes).toBe(
      MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
    );
    expect(bytes(projection.materialize())).toBe(
      MAXIMUM_NORMALIZED_SNAPSHOT_OR_PAGE_BYTES,
    );
    expect(() =>
      projection.prepare({
        type: "inventory_counts_changed",
        generation,
        counts: { ...seed.counts, active: 999 },
      }),
    ).toThrow("application_projection_snapshot_limit");
    expect(projection.counts.active).toBe(99);
    seed.counts.active = 999;
    expect(() => new ApplicationProjection(seed)).toThrow();
  }, 20_000);
});
