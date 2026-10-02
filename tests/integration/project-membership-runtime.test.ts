import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ProjectManagementService } from "../../src/server/application/project-management-service.js";
import type { ThreadEventEnvelope } from "../../src/shared/protocol/conversation.js";
import { createInMemoryThreadRuntimeHarness } from "../support/in-memory-thread-runtime-harness.js";

type Harness = Awaited<ReturnType<typeof createInMemoryThreadRuntimeHarness>>;

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

/**
 * A bound thread whose first turn has settled, with an open stream that keeps
 * its runtime loaded, plus an unbound draft in the same location.
 */
async function viewedIdleThread(harness: Harness) {
  const { scope, workspaceRecord, connection, driver, lifecycle, runtimes, mutations, inventoryRepository } = harness;
  const emit = vi.spyOn(driver, "emit");
  const created = await lifecycle.createServerDraft(scope, {
    workspaceId: workspaceRecord.id,
    connectionProfileId: connection.id,
    title: "Viewed thread",
    initialText: "hello first turn",
  });
  const threadId = created.applicationThreadId;
  const view = runtimes.quiet(scope, threadId);
  const frames: ThreadEventEnvelope[] = [];
  const subscription = view.hub.subscribe((envelope) => frames.push(envelope));
  await harness.threadSnapshots.publishAuthoritativeReplacement(scope, threadId);
  await expect(mutations.mutate(scope, threadId, {
    kind: "deliver",
    mode: "submit",
    mutationId: randomUUID(),
    expectedThreadRevision: inventoryRepository.getThread(scope, threadId).thread.revision,
    expectedDraftRevision: created.draft.revision,
  })).resolves.toMatchObject({ status: "delivery_accepted" });
  await vi.waitFor(() => {
    expect(frames.some(({ event }) => event.type === "turn_upsert" && event.turn.status === "completed")).toBe(true);
    expect(runtimes.observeRuntimes(scope, [threadId]).get(threadId)).toEqual({ kind: "loaded", runState: "idle", retirable: true });
  }, { timeout: 15_000 });
  await Promise.all(harness.completionFollowUps.splice(0));
  const draft = await lifecycle.createServerDraft(scope, {
    workspaceId: workspaceRecord.id,
    connectionProfileId: connection.id,
    title: "Draft",
    initialText: "",
  });
  const generation = (await runtimes.captureLoadedRuntime(scope, threadId))!.generation;
  return {
    threadId,
    draftId: draft.applicationThreadId,
    frames,
    generation,
    /** Reports provider run-state changes that Sedes did not admit, as a native client would. */
    providerRunState(state: "running" | "idle") {
      driver.emit(emit.mock.calls[0]![0], { type: "run_state_changed", state });
    },
    close() {
      subscription.close();
      view.release();
    },
  };
}

function projectManagement(harness: Harness) {
  return new ProjectManagementService({
    inventory: harness.inventoryRepository,
    runtimes: harness.runtimes,
    files: { runWithWorkspaceRetired: (_scope, _workspaceId, operation) => operation() },
    locations: { restoreLocation: async () => { throw new Error("unexpected_location_restore"); } },
    publications: { handoffAuthoritativeReplacement: vi.fn() },
    threads: harness.threadSnapshots,
  });
}

/** Asserts the open stream learned the thread's new project as an incremental, not a new baseline. */
async function expectStreamedProject(
  frames: readonly ThreadEventEnvelope[],
  since: number,
  projectId: string,
) {
  await vi.waitFor(() => expect(frames.slice(since).some(({ event }) =>
    event.type === "application_state_changed" && event.state.workspace.projectId === projectId)).toBe(true));
  expect(frames.slice(since).some(({ event }) => event.type === "snapshot")).toBe(false);
}

/**
 * Holds runtime maintenance on one thread so a commit that includes it waits,
 * as it would behind a concurrent archive or removal of that thread.
 */
async function maintain(harness: Harness, threadId: string) {
  const gate = deferred();
  let started = false;
  const maintenance = harness.runtimes.runWithRuntimeRetired(harness.scope, threadId, async () => {
    started = true;
    await gate.promise;
  });
  await vi.waitFor(() => expect(started).toBe(true));
  return async () => {
    gate.resolve();
    await maintenance;
  };
}

describe("project membership changes against live runtimes", () => {
  it("rejects a move when a provider turn starts after the thread set was observed, then moves the idle runtime without retiring it and streams its project", async () => {
    const harness = await createInMemoryThreadRuntimeHarness();
    const { scope, workspaceRecord, inventoryRepository, runtimes } = harness;
    try {
      const viewed = await viewedIdleThread(harness);
      try {
        const service = projectManagement(harness);
        const sourceProjectId = inventoryRepository.getWorkspace(scope, workspaceRecord.id).projectId;
        const move = () => service.moveLocation(scope, workspaceRecord.id, {
          target: { kind: "new", name: "Split" },
          expectedRevision: inventoryRepository.getWorkspace(scope, workspaceRecord.id).revision,
        });

        const release = await maintain(harness, viewed.draftId);
        const moving = move();
        viewed.providerRunState("running");
        await vi.waitFor(() => expect(runtimes.observeRuntimes(scope, [viewed.threadId]).get(viewed.threadId))
          .toEqual({ kind: "loaded", runState: "running", retirable: false }));
        // Only the runtime shows the provider's turn; no durable record does.
        expect(inventoryRepository.findArchiveDurablyBlockedThreadIds(scope, [viewed.threadId, viewed.draftId]).size).toBe(0);
        await release();
        await expect(moving).rejects.toMatchObject({ code: "invalid_transition" });
        expect(inventoryRepository.getWorkspace(scope, workspaceRecord.id).projectId).toBe(sourceProjectId);

        viewed.providerRunState("idle");
        await vi.waitFor(() => expect(runtimes.observeRuntimes(scope, [viewed.threadId]).get(viewed.threadId))
          .toEqual({ kind: "loaded", runState: "idle", retirable: true }));
        const since = viewed.frames.length;
        const moved = await move();
        expect(moved).toMatchObject({ name: "Split", locations: [{ id: workspaceRecord.id }] });
        await expectStreamedProject(viewed.frames, since, moved.id);
        expect(inventoryRepository.getWorkspace(scope, workspaceRecord.id).projectId).toBe(moved.id);
        expect(await runtimes.captureLoadedRuntime(scope, viewed.threadId))
          .toMatchObject({ generation: viewed.generation, runState: "idle" });
      } finally {
        viewed.close();
      }
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("rejects a merge when a provider turn starts after the thread set was observed, then merges without retiring the runtime and streams its project", async () => {
    const harness = await createInMemoryThreadRuntimeHarness();
    const { scope, workspaceRecord, inventoryRepository, runtimes } = harness;
    try {
      const viewed = await viewedIdleThread(harness);
      try {
        const service = projectManagement(harness);
        const source = inventoryRepository.getWorkspace(scope, workspaceRecord.id);
        const target = inventoryRepository.upsertWorkspace(scope, {
          environmentId: source.environmentId, canonicalPath: "/tmp/merge-target", displayName: "merge-target",
          project: { kind: "new", name: "Target" }, available: true, trustState: "trusted",
          environmentConfigurationRevision: source.environmentConfigurationRevision, now: Date.now(),
        });
        const sourceProjectId = source.projectId;
        const merge = () => service.merge(scope, sourceProjectId, {
          targetProjectId: target.projectId,
          expectedSourceMembershipRevision: inventoryRepository.getProject(scope, sourceProjectId).membershipRevision,
          expectedTargetMembershipRevision: inventoryRepository.getProject(scope, target.projectId).membershipRevision,
        });

        const release = await maintain(harness, viewed.draftId);
        const merging = merge();
        viewed.providerRunState("running");
        await vi.waitFor(() => expect(runtimes.observeRuntimes(scope, [viewed.threadId]).get(viewed.threadId))
          .toEqual({ kind: "loaded", runState: "running", retirable: false }));
        expect(inventoryRepository.findArchiveDurablyBlockedThreadIds(scope, [viewed.threadId, viewed.draftId]).size).toBe(0);
        await release();
        await expect(merging).rejects.toMatchObject({ code: "invalid_transition" });
        expect(inventoryRepository.getProject(scope, sourceProjectId).locations.map(({ id }) => id)).toEqual([workspaceRecord.id]);

        viewed.providerRunState("idle");
        await vi.waitFor(() => expect(runtimes.observeRuntimes(scope, [viewed.threadId]).get(viewed.threadId))
          .toEqual({ kind: "loaded", runState: "idle", retirable: true }));
        const since = viewed.frames.length;
        const merged = await merge();
        expect(merged.locations.map(({ id }) => id).sort()).toEqual([workspaceRecord.id, target.id].sort());
        await expectStreamedProject(viewed.frames, since, target.projectId);
        expect(() => inventoryRepository.getProject(scope, sourceProjectId)).toThrow(expect.objectContaining({ code: "not_found" }));
        expect(await runtimes.captureLoadedRuntime(scope, viewed.threadId))
          .toMatchObject({ generation: viewed.generation, runState: "idle" });
      } finally {
        viewed.close();
      }
    } finally {
      await harness.close();
    }
  }, 60_000);

  it("reports a provider turn as a busy runtime when removing the project, and removes the project once it is idle", async () => {
    const harness = await createInMemoryThreadRuntimeHarness();
    const { scope, workspaceRecord, inventoryRepository, runtimes } = harness;
    try {
      const viewed = await viewedIdleThread(harness);
      try {
        const service = projectManagement(harness);
        const location = inventoryRepository.getWorkspace(scope, workspaceRecord.id);
        const remove = () => {
          const project = inventoryRepository.getProject(scope, location.projectId);
          return service.removeProject(scope, project.id, {
            expectedRevision: project.revision, expectedMembershipRevision: project.membershipRevision,
          });
        };

        viewed.providerRunState("running");
        await vi.waitFor(() => expect(runtimes.observeRuntimes(scope, [viewed.threadId]).get(viewed.threadId))
          .toEqual({ kind: "loaded", runState: "running", retirable: false }));
        await expect(remove()).rejects.toMatchObject({
          code: "invalid_transition",
          blockers: [{ workspaceId: location.id, environmentId: location.environmentId, kind: "busy_runtime", threadIds: [viewed.threadId] }],
        });
        expect(inventoryRepository.isWorkspaceRemoved(scope, location.id)).toBe(false);

        viewed.providerRunState("idle");
        await vi.waitFor(() => expect(runtimes.observeRuntimes(scope, [viewed.threadId]).get(viewed.threadId))
          .toEqual({ kind: "loaded", runState: "idle", retirable: true }));
        await expect(remove()).resolves.toMatchObject({ id: location.projectId, removed: true });
        // Removal retires the idle runtime.
        expect(runtimes.observeRuntimes(scope, [viewed.threadId]).size).toBe(0);
      } finally {
        viewed.close();
      }
    } finally {
      await harness.close();
    }
  }, 60_000);
});
