import type { NormalizedThreadExecutionWorkspace } from "../../shared/protocol/conversation.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type { PiSandboxAllocationRepository } from "./pi-sandbox-allocation-repository.js";
import type { PiSandboxAllocationRecord } from "./pi-sandbox-allocation-repository.js";
import { piSandboxEffectiveWorkspacePath } from "./pi-sandbox-allocation-repository.js";

function state(
  record: PiSandboxAllocationRecord,
): Extract<NormalizedThreadExecutionWorkspace, { kind: "isolated" }>["state"] {
  if (record.state === "ready") {
    return record.retention === "retained" ? "retained" : "ready";
  }
  switch (record.state) {
    case "reserved":
    case "materializing":
      return "provisioning";
    case "materialization_failed":
      return "provisioning_failed";
    case "deleting":
      return "deleting";
    case "delete_failed":
      return "deletion_failed";
    case "deleted":
      return "deleted";
  }
}

export class PiSandboxExecutionWorkspaceReader {
  constructor(
    readonly allocations: Pick<PiSandboxAllocationRepository, "getForThread">,
  ) {}

  read(
    scope: RequestScope,
    applicationThreadId: string,
  ): NormalizedThreadExecutionWorkspace {
    const record = this.allocations.getForThread(scope, applicationThreadId);
    return record
      ? {
          kind: "isolated",
          workspaceAccess: record.workspaceAccess,
          state: state(record),
          networkProfile: record.networkProfile,
          hostPaths: {
            home: record.homePath,
            workspace: piSandboxEffectiveWorkspacePath(record),
          },
        }
      : { kind: "direct" };
  }
}
