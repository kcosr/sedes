import { describe, expect, it } from "vitest";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";
import type { PiSandboxAllocationRecord } from "../../src/server/pi-sandbox/pi-sandbox-allocation-repository.js";
import { PiSandboxExecutionWorkspaceReader } from "../../src/server/pi-sandbox/pi-sandbox-presentation.js";

const scope: RequestScope = {
  tenantId: "tenant-1",
  principalId: "principal-1",
};

function allocation(
  state: PiSandboxAllocationRecord["state"],
): PiSandboxAllocationRecord {
  return {
    tenantId: scope.tenantId,
    ownerPrincipalId: scope.principalId,
    applicationThreadId: "thread-1",
    allocationId: "10000000-0000-4000-8000-000000000001",
    executionEnvironmentId: "environment-1",
    sourceWorkspaceId: "workspace-1",
    sourceCanonicalPath: "/source/repository",
    allocationRootPath: "/allocations/one",
    homePath: "/allocations/one/home",
    workspacePath: "/allocations/one/home/workspace",
    workspaceAccess: "writable_clone",
    networkProfile: "isolated",
    state,
    retention: "active",
    operationId: null,
    completedDeleteOperationId: null,
    operationKind: null,
    diagnosticCode: null,
    sourceHeadOid: null,
    sandboxBranch: null,
    revision: 2,
    createdAt: 1,
    updatedAt: 2,
    readyAt: null,
    retainedAt: null,
    deletedAt: null,
  };
}

describe("PiSandboxExecutionWorkspaceReader", () => {
  it("projects materialization failure distinctly from active provisioning", () => {
    let record = allocation("materializing");
    const reader = new PiSandboxExecutionWorkspaceReader({
      getForThread: () => record,
    });

    expect(reader.read(scope, "thread-1")).toMatchObject({
      kind: "isolated",
      state: "provisioning",
    });
    record = allocation("materialization_failed");
    expect(reader.read(scope, "thread-1")).toMatchObject({
      kind: "isolated",
      state: "provisioning_failed",
    });
  });
});
