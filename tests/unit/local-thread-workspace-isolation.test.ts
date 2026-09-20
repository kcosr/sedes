import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import {
  LocalThreadWorkspaceIsolationResolver,
  UnavailableThreadWorkspaceIsolationResolver,
} from "../../src/server/pi-sandbox/local-thread-workspace-isolation.js";
import type { PiSandboxAllocationRecord } from "../../src/server/pi-sandbox/pi-sandbox-allocation-repository.js";

const scope = { tenantId: "tenant-1", principalId: "principal-1" } as const;
const workspace: ValidatedWorkspace = {
  summary: {
    id: "workspace-1",
    environmentId: "environment-1",
    displayName: "Project",
    displayPath: "/source/project",
    availability: "available",
    trustState: "trusted",
    revision: 1,
  },
  canonicalPath: "/source/project",
  authorityRevision: 1,
};

function allocation(
  state: PiSandboxAllocationRecord["state"] = "reserved",
  networkProfile: PiSandboxAllocationRecord["networkProfile"] = "isolated",
): PiSandboxAllocationRecord {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    applicationThreadId: "thread-1",
    allocationId: "00000000-0000-4000-8000-000000000001",
    executionEnvironmentId: "environment-1",
    sourceWorkspaceId: workspace.summary.id,
    sourceCanonicalPath: workspace.canonicalPath,
    allocationRootPath: "/state/thread-workspaces/allocation-1",
    homePath: "/state/thread-workspaces/allocation-1/home",
    workspacePath: "/state/thread-workspaces/allocation-1/home/workspace",
    workspaceAccess: "writable_clone",
    networkProfile,
    state,
    retention: "active",
    operationId: null,
    operationKind: null,
    diagnosticCode: null,
    sourceHeadOid: null,
    sandboxBranch: null,
    completedDeleteOperationId: null,
    revision: state === "ready" ? 2 : 0,
    createdAt: 1,
    updatedAt: 1,
    readyAt: state === "ready" ? 1 : null,
    retainedAt: null,
    deletedAt: null,
  };
}

describe("local thread workspace isolation composition", () => {
  it("resolves ready and retained passive paths without materialization or a worker", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "sedes-passive-isolation-"),
    );
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    try {
      for (const retention of ["active", "retained"] as const) {
        const persisted = {
          ...allocation("ready"),
          homePath: root,
          workspacePath,
          retention,
          retainedAt: retention === "retained" ? 2 : null,
        };
        const materialize = vi.fn();
        const acquire = vi.fn();
        const resolver = new LocalThreadWorkspaceIsolationResolver({
          allocations: { getForThread: () => persisted },
          materializer: { materialize },
          runtime: { acquire },
          backendInstanceId: "backend-1",
          admittedNetworkProfiles: new Set(["isolated"]),
        });

        await expect(
          resolver.resolve({
            scope,
            applicationThreadId: persisted.applicationThreadId,
            sourceWorkspace: workspace,
            access: "passive",
          }),
        ).resolves.toMatchObject({
          access: "passive",
          effectiveWorkspace: { canonicalPath: workspacePath },
        });
        expect(materialize).not.toHaveBeenCalled();
        expect(acquire).not.toHaveBeenCalled();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed without materializing non-ready passive allocations", async () => {
    const materialize = vi.fn();
    const acquire = vi.fn();
    for (const state of [
      "reserved",
      "materializing",
      "materialization_failed",
      "deleting",
      "delete_failed",
      "deleted",
    ] as const) {
      const persisted = allocation(state);
      const resolver = new LocalThreadWorkspaceIsolationResolver({
        allocations: { getForThread: () => persisted },
        materializer: { materialize },
        runtime: { acquire },
        backendInstanceId: "backend-1",
        admittedNetworkProfiles: new Set(["isolated"]),
      });
      await expect(
        resolver.resolve({
          scope,
          applicationThreadId: persisted.applicationThreadId,
          sourceWorkspace: workspace,
          access: "passive",
        }),
      ).rejects.toMatchObject({ code: "runtime_unavailable" });
    }
    expect(materialize).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("prepares a reserved allocation without acquiring a worker", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "sedes-prepare-isolation-"),
    );
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    try {
      const reserved = allocation("reserved");
      const ready = {
        ...allocation("ready"),
        homePath: root,
        workspacePath,
      };
      const materialize = vi.fn(async () => ready);
      const acquire = vi.fn();
      const resolver = new LocalThreadWorkspaceIsolationResolver({
        allocations: { getForThread: () => reserved },
        materializer: { materialize },
        runtime: { acquire },
        backendInstanceId: "backend-1",
        admittedNetworkProfiles: new Set(["isolated"]),
      });

      await expect(
        resolver.resolve({
          scope,
          applicationThreadId: reserved.applicationThreadId,
          sourceWorkspace: workspace,
          access: "prepare",
        }),
      ).resolves.toMatchObject({
        access: "prepare",
        effectiveWorkspace: { canonicalPath: workspacePath },
      });
      expect(materialize).toHaveBeenCalledOnce();
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for missing or deletion-requested passive paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-invalid-passive-"));
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    try {
      const materialize = vi.fn();
      const acquire = vi.fn();
      for (const persisted of [
        {
          ...allocation("ready"),
          homePath: root,
          workspacePath: path.join(root, "missing"),
        },
        {
          ...allocation("ready"),
          homePath: root,
          workspacePath,
          retention: "delete_requested" as const,
        },
      ]) {
        const resolver = new LocalThreadWorkspaceIsolationResolver({
          allocations: { getForThread: () => persisted },
          materializer: { materialize },
          runtime: { acquire },
          backendInstanceId: "backend-1",
          admittedNetworkProfiles: new Set(["isolated"]),
        });
        await expect(
          resolver.resolve({
            scope,
            applicationThreadId: persisted.applicationThreadId,
            sourceWorkspace: workspace,
            access: "passive",
          }),
        ).rejects.toMatchObject({ code: "runtime_unavailable" });
      }
      expect(materialize).not.toHaveBeenCalled();
      expect(acquire).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("materializes a reserved allocation and acquires the exact backend-scoped worker", async () => {
    const reserved = allocation();
    const ready = { ...allocation("ready"), sourceHeadOid: "a".repeat(40) };
    const release = vi.fn(async () => undefined);
    const materialize = vi.fn(async () => ready);
    const acquire = vi.fn(async () => ({
      allocationId: ready.allocationId,
      semanticHome: "/home/agent" as const,
      semanticCwd: "/home/agent" as const,
      workspaceAccess: "writable_clone" as const,
      serviceCwd: ready.workspacePath,
      hostHomePath: ready.homePath,
      hostWorkspacePath: ready.workspacePath,
      executor: {} as never,
      contextReader: {} as never,
      environmentLabel: "Local",
      release,
    }));
    const resolver = new LocalThreadWorkspaceIsolationResolver({
      allocations: { getForThread: () => reserved },
      materializer: { materialize },
      runtime: { acquire },
      backendInstanceId: "backend-1",
      admittedNetworkProfiles: new Set(["isolated"]),
    });

    expect(
      resolver.isSelected({
        scope,
        applicationThreadId: reserved.applicationThreadId,
        sourceWorkspace: workspace,
      }),
    ).toBe(true);
    expect(materialize).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();

    const result = await resolver.resolve({
      scope,
      applicationThreadId: reserved.applicationThreadId,
      sourceWorkspace: workspace,
      access: "active",
    });

    expect(materialize).toHaveBeenCalledWith(
      scope,
      reserved.applicationThreadId,
      {
        expectedRevision: reserved.revision,
      },
    );
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          ...scope,
          backendInstanceId: "backend-1",
          executionEnvironmentId: "environment-1",
        },
        hostHomePath: ready.homePath,
        hostWorkspacePath: ready.workspacePath,
      }),
    );
    expect(result?.effectiveWorkspace.canonicalPath).toBe(ready.workspacePath);
    await result?.release();
    expect(release).toHaveBeenCalledOnce();
  });

  it("uses the source as a read-only workspace while retaining the private home", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "sedes-read-only-isolation-"),
    );
    const source = path.join(root, "source");
    const home = path.join(root, "allocation", "home");
    const placeholder = path.join(home, "workspace");
    await mkdir(source, { recursive: true });
    await mkdir(placeholder, { recursive: true });
    try {
      const sourceWorkspace = { ...workspace, canonicalPath: source };
      const ready = {
        ...allocation("ready"),
        sourceCanonicalPath: source,
        homePath: home,
        workspacePath: placeholder,
        workspaceAccess: "read_only" as const,
      };
      const acquire = vi.fn(async () => ({
        allocationId: ready.allocationId,
        semanticHome: "/home/agent" as const,
        semanticCwd: "/home/agent" as const,
        workspaceAccess: "read_only" as const,
        serviceCwd: source,
        hostHomePath: home,
        hostWorkspacePath: source,
        executor: {} as never,
        contextReader: {} as never,
        environmentLabel: "Local",
        release: async () => undefined,
      }));
      const resolver = new LocalThreadWorkspaceIsolationResolver({
        allocations: { getForThread: () => ready },
        materializer: { materialize: vi.fn() },
        runtime: { acquire },
        backendInstanceId: "backend-1",
        admittedNetworkProfiles: new Set(["isolated"]),
      });

      await expect(
        resolver.resolve({
          scope,
          applicationThreadId: ready.applicationThreadId,
          sourceWorkspace,
          access: "passive",
        }),
      ).resolves.toMatchObject({
        effectiveWorkspace: { canonicalPath: source },
      });
      const active = await resolver.resolve({
        scope,
        applicationThreadId: ready.applicationThreadId,
        sourceWorkspace,
        access: "active",
      });
      expect(acquire).toHaveBeenCalledWith(
        expect.objectContaining({
          hostHomePath: home,
          hostWorkspacePath: source,
          serviceCwd: source,
          workspaceAccess: "read_only",
        }),
      );
      expect(active?.effectiveWorkspace.canonicalPath).toBe(source);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed for persisted allocations when the runtime is unavailable", async () => {
    const resolver = new UnavailableThreadWorkspaceIsolationResolver({
      getForThread: () => allocation("ready"),
    });
    expect(
      resolver.isSelected({
        scope,
        applicationThreadId: "thread-1",
        sourceWorkspace: workspace,
      }),
    ).toBe(true);
    await expect(
      resolver.resolve({
        scope,
        applicationThreadId: "thread-1",
        sourceWorkspace: workspace,
        access: "active",
      }),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });
  });

  it("preserves ready passive reads when the worker runtime is unavailable", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "sedes-unavailable-passive-"),
    );
    const workspacePath = path.join(root, "workspace");
    await mkdir(workspacePath);
    try {
      const persisted = {
        ...allocation("ready"),
        homePath: root,
        workspacePath,
      };
      const resolver = new UnavailableThreadWorkspaceIsolationResolver({
        getForThread: () => persisted,
      });
      await expect(
        resolver.resolve({
          scope,
          applicationThreadId: persisted.applicationThreadId,
          sourceWorkspace: workspace,
          access: "passive",
        }),
      ).resolves.toMatchObject({
        access: "passive",
        effectiveWorkspace: { canonicalPath: workspacePath },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when current operator policy no longer admits the allocation profile", async () => {
    const persisted = allocation("ready", "execution_host");
    const materialize = vi.fn();
    const acquire = vi.fn();
    const resolver = new LocalThreadWorkspaceIsolationResolver({
      allocations: { getForThread: () => persisted },
      materializer: { materialize },
      runtime: { acquire },
      backendInstanceId: "backend-1",
      admittedNetworkProfiles: new Set(["isolated"]),
    });

    await expect(
      resolver.resolve({
        scope,
        applicationThreadId: persisted.applicationThreadId,
        sourceWorkspace: workspace,
        access: "active",
      }),
    ).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(materialize).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("preserves direct execution when no allocation is selected", async () => {
    const resolver = new UnavailableThreadWorkspaceIsolationResolver({
      getForThread: () => undefined,
    });
    expect(
      resolver.isSelected({
        scope,
        applicationThreadId: "thread-1",
        sourceWorkspace: workspace,
      }),
    ).toBe(false);
    await expect(
      resolver.resolve({
        scope,
        applicationThreadId: "thread-1",
        sourceWorkspace: workspace,
        access: "active",
      }),
    ).resolves.toBeUndefined();
  });
});
