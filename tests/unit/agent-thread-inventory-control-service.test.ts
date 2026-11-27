import { describe, expect, it, vi } from "vitest";
import { AgentThreadInventoryControlService } from "../../src/server/agent-tools/application/agent-thread-inventory-control-service.js";
import { DomainError } from "../../src/server/domain/errors.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const environmentAuthority = {
  id: "grant-1",
  callerKind: "thread_agent" as const,
  defaults: {
    kind: "thread_agent" as const,
    environmentId: "environment-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    threadId: "thread-1",
  },
  policyIdentity: {
    ownerKind: "thread" as const,
    ownerId: "thread-1",
    revision: 1,
  },
  resourceScope: {allowOtherEnvironments:false,allowOtherProjects:false},
  admittedEnvironmentIds: ["environment-1"],
  targetEnvironmentIds: [] as string[],
  resolvedResourceRefs: [
    {
      kind: "thread_family" as const,
      id: "thread-1",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
    },
    {
      kind: "thread_family" as const,
      id: "thread-2",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
    },
    {
      kind: "thread" as const,
      id: "thread-1",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
      projectId: "project-1",
    },
  ],
  canonicalInputDigest: "input-digest",
  authorityDigest: "authority-digest",
  display: { targetEnvironmentLabels: [], resourceLabels: [] },
};

function thread(
  id: string,
  environmentId = "environment-1",
  workspaceId = "workspace-1",
) {
  return { thread: { id, environmentId, workspaceId, projectId: "project-1" } } as never;
}

describe("AgentThreadInventoryControlService", () => {
  it("rechecks the target's admitted workspace before changing lifecycle", async () => {
    const getInventory = vi.fn();
    const park = vi.fn();
    const transition = vi.fn();
    const service = new AgentThreadInventoryControlService({
      inventory: { getInventory },
      threads: {
        getThread: vi.fn(() => thread("thread-1", "environment-1", "moved-workspace")),
      },
      lineage: { listFamilyThreadIds: vi.fn() },
      archives: { archive: vi.fn(), park },
      transitions: { transition, setPinned: vi.fn() },
      groupAssignments: { getAssignment: vi.fn() },
      groups: { updateAssignment: vi.fn() },
    });

    await expect(service.setState(scope, {
      lifecycle: "parked",
      mutationId: "mutation-moved-thread",
      environmentAuthority,
    })).rejects.toMatchObject({ code: "permission_denied" });
    expect(getInventory).not.toHaveBeenCalled();
    expect(park).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("checks target admission before reading even an already-satisfied pin or membership", async () => {
    const getInventory = vi.fn();
    const getAssignment = vi.fn();
    const service = new AgentThreadInventoryControlService({
      inventory: { getInventory },
      threads: { getThread: vi.fn(() => thread("thread-1", "environment-1", "moved-workspace")) },
      lineage: { listFamilyThreadIds: vi.fn() },
      archives: { archive: vi.fn(), park: vi.fn() },
      transitions: { transition: vi.fn(), setPinned: vi.fn() },
      groupAssignments: { getAssignment },
      groups: { updateAssignment: vi.fn() },
    });
    const context = { environmentAuthority, mutationId: "mutation-1" };
    for (const request of [
      () => service.setPinned(scope, { ...context, pinned: false }),
      () => service.setGroup(scope, { ...context, groupId: null }),
      () => service.createGroup(scope, { ...context, name: "Planning" }),
    ]) {
      await expect(request()).rejects.toMatchObject({ code: "permission_denied" });
    }
    expect(getInventory).not.toHaveBeenCalled();
    expect(getAssignment).not.toHaveBeenCalled();
  });

  it("reports revision conflicts from concurrent edits without retrying a write", async () => {
    const getInventory = vi.fn(() => ({ pinRevision: 11, pinned: 0 }) as never);
    const setPinned = vi.fn().mockRejectedValue(new DomainError("pin_revision_conflict", "Pin changed."));
    const getAssignment = vi.fn(() => ({ threadId: "thread-1", groupId: null, revision: 6 }));
    const updateAssignment = vi.fn().mockRejectedValue(new DomainError("group_assignment_revision_conflict", "Group changed."));
    const service = new AgentThreadInventoryControlService({
      inventory: { getInventory },
      threads: { getThread: vi.fn(() => thread("thread-1")) },
      lineage: { listFamilyThreadIds: vi.fn() },
      archives: { archive: vi.fn(), park: vi.fn() },
      transitions: { transition: vi.fn(), setPinned },
      groupAssignments: { getAssignment },
      groups: { updateAssignment },
    });
    const context = { mutationId: "mutation-1", environmentAuthority };
    await expect(service.setPinned(scope, { ...context, pinned: true }))
      .rejects.toMatchObject({ code: "pin_revision_conflict" });
    expect(setPinned).toHaveBeenCalledExactlyOnceWith(scope, "thread-1", {
      mutationId: "mutation-1", expectedRevision: 11, pinned: true,
    });
    const groupId = "5d90f8cc-d73d-4cdc-b03a-37c80f7f9433";
    await expect(service.setGroup(scope, { ...context, groupId }))
      .rejects.toMatchObject({ code: "group_assignment_revision_conflict" });
    expect(updateAssignment).toHaveBeenCalledExactlyOnceWith(scope, "thread-1", {
      action: "assign", groupId, mutationId: "mutation-1", expectedRevision: 6,
    });
  });

  it("archives from the current scoped revision and preserves explicit family/task choices", async () => {
    const getInventory = vi.fn(() => ({ inventoryRevision: 7 }) as never);
    const archive = vi.fn(async () => ["thread-1", "thread-2"]);
    const transition = vi.fn();
    const getThread = vi.fn((_scope, id: string) => thread(id));
    const listFamilyThreadIds = vi.fn(() => ["thread-1", "thread-2"]);
    const service = new AgentThreadInventoryControlService({
      inventory: { getInventory },
      threads: { getThread },
      lineage: { listFamilyThreadIds },
      archives: { archive, park: vi.fn() },
      transitions: { transition, setPinned: vi.fn() },
      groupAssignments: { getAssignment: vi.fn() },
      groups: { updateAssignment: vi.fn() },
    });

    await expect(
      service.archive(scope, {
        threadId: "thread-1",
        includeDescendants: true,
        openTaskDisposition: "move_to_project",
        mutationId: "mutation-1",
        environmentAuthority,
      }),
    ).resolves.toEqual({ threadId: "thread-1", archivedThreadCount: 2 });
    expect(getInventory).toHaveBeenCalledWith(scope, "thread-1");
    expect(archive).toHaveBeenCalledWith(scope, "thread-1", {
      expectedRevision: 7,
      mutationId: "mutation-1",
      includeDescendants: true,
      expectedThreadIds: ["thread-1", "thread-2"],
      openTaskDisposition: "move_to_project",
      executionWorkspaceDisposition: { kind: "keep" },
    });
    expect(transition).not.toHaveBeenCalled();
  });

  it("defaults archive task handling in the domain and restores from the current scoped revision", async () => {
    const getInventory = vi.fn(() => ({ inventoryRevision: 4 }) as never);
    const archive = vi.fn(async () => ["thread-1"]);
    const transition = vi.fn(async () => ({}) as never);
    const getThread = vi.fn((_scope, id: string) => thread(id));
    const service = new AgentThreadInventoryControlService({
      inventory: { getInventory },
      threads: { getThread },
      lineage: { listFamilyThreadIds: vi.fn(() => ["thread-1"]) },
      archives: { archive, park: vi.fn() },
      transitions: { transition, setPinned: vi.fn() },
      groupAssignments: { getAssignment: vi.fn() },
      groups: { updateAssignment: vi.fn() },
    });

    await service.archive(scope, {
      threadId: "thread-1",
      includeDescendants: false,
      mutationId: "mutation-archive",
      environmentAuthority,
    });
    expect(archive).toHaveBeenCalledWith(scope, "thread-1", {
      expectedRevision: 4,
      mutationId: "mutation-archive",
      includeDescendants: false,
      expectedThreadIds: ["thread-1"],
      executionWorkspaceDisposition: { kind: "keep" },
    });
    expect(getThread).toHaveBeenCalledWith(scope, "thread-1");

    await expect(
      service.restore(scope, {
        threadId: "thread-1",
        mutationId: "mutation-restore",
        environmentAuthority,
      }),
    ).resolves.toEqual({ threadId: "thread-1" });
    expect(transition).toHaveBeenCalledWith(scope, "thread-1", {
      expectedRevision: 4,
      mutationId: "mutation-restore",
      change: { action: "restore" },
    });
  });

  it("fails closed when the scoped inventory lookup cannot see the target", async () => {
    const getInventory = vi.fn(() => {
      throw new DomainError("not_found", "Thread not found.");
    });
    const archive = vi.fn();
    const transition = vi.fn();
    const service = new AgentThreadInventoryControlService({
      inventory: { getInventory },
      threads: { getThread: vi.fn((_scope, id: string) => thread(id)) },
      lineage: { listFamilyThreadIds: vi.fn(() => ["thread-1"]) },
      archives: { archive, park: vi.fn() },
      transitions: { transition, setPinned: vi.fn() },
      groupAssignments: { getAssignment: vi.fn() },
      groups: { updateAssignment: vi.fn() },
    });

    await expect(
      service.restore(scope, {
        threadId: "foreign-thread",
        mutationId: "mutation-1",
        environmentAuthority,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(archive).not.toHaveBeenCalled();
    expect(transition).not.toHaveBeenCalled();
  });

  it("fails closed before archive when lineage crosses environments", async () => {
    const archive = vi.fn();
    const service = new AgentThreadInventoryControlService({
      inventory: {
        getInventory: vi.fn(() => ({ inventoryRevision: 1 }) as never),
      },
      threads: {
        getThread: vi.fn((_scope, id: string) =>
          thread(id, id === "thread-2" ? "environment-2" : "environment-1"),
        ),
      },
      lineage: {
        listFamilyThreadIds: vi.fn(() => ["thread-1", "thread-2"]),
      },
      archives: { archive, park: vi.fn() },
      transitions: { transition: vi.fn(), setPinned: vi.fn() },
      groupAssignments: { getAssignment: vi.fn() },
      groups: { updateAssignment: vi.fn() },
    });

    await expect(
      service.archive(scope, {
        threadId: "thread-1",
        includeDescendants: true,
        mutationId: "mutation-1",
        environmentAuthority,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(archive).not.toHaveBeenCalled();
  });

  it("fails closed before archive when lineage crosses workspaces", async () => {
    const archive = vi.fn();
    const service = new AgentThreadInventoryControlService({
      inventory: {
        getInventory: vi.fn(() => ({ inventoryRevision: 1 }) as never),
      },
      threads: {
        getThread: vi.fn((_scope, id: string) =>
          thread(
            id,
            "environment-1",
            id === "thread-2" ? "workspace-2" : "workspace-1",
          ),
        ),
      },
      lineage: {
        listFamilyThreadIds: vi.fn(() => ["thread-1", "thread-2"]),
      },
      archives: { archive, park: vi.fn() },
      transitions: { transition: vi.fn(), setPinned: vi.fn() },
      groupAssignments: { getAssignment: vi.fn() },
      groups: { updateAssignment: vi.fn() },
    });

    await expect(
      service.archive(scope, {
        threadId: "thread-1",
        includeDescendants: true,
        mutationId: "mutation-workspace",
        environmentAuthority,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(archive).not.toHaveBeenCalled();
  });
});
