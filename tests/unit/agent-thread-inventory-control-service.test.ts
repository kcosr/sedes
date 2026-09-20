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
    threadId: "thread-1",
  },
  policyIdentity: {
    ownerKind: "thread" as const,
    ownerId: "thread-1",
    revision: 1,
  },
  admittedEnvironmentIds: ["environment-1"],
  targetEnvironmentIds: [] as string[],
  resolvedResourceRefs: [
    {
      kind: "thread_family" as const,
      id: "thread-1",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
    },
    {
      kind: "thread_family" as const,
      id: "thread-2",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
    },
    {
      kind: "thread" as const,
      id: "thread-1",
      environmentId: "environment-1",
      workspaceId: "workspace-1",
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
  return { thread: { id, environmentId, workspaceId } } as never;
}

describe("AgentThreadInventoryControlService", () => {
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
      archives: { archive },
      transitions: { transition },
    });

    await expect(
      service.archive(scope, {
        threadId: "thread-1",
        includeDescendants: true,
        openTaskDisposition: "move_to_workspace",
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
      openTaskDisposition: "move_to_workspace",
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
      archives: { archive },
      transitions: { transition },
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
      archives: { archive },
      transitions: { transition },
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
      archives: { archive },
      transitions: { transition: vi.fn() },
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
      archives: { archive },
      transitions: { transition: vi.fn() },
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
