import { AsyncLocalStorage } from "node:async_hooks";
import { SidecarOperationError } from "../../internal/sidecar-protocol/operation-registry.js";
import type { ExecutionPolicySnapshot } from "../../internal/sidecar-protocol/execution-policy.js";
import { workspaceRootGrant } from "../execution/workspace-root-grant.js";

export type WorkspaceAuthorityCheck = (() => void) & { readonly identity: string };

export interface WorkspacePolicyGuard {
  capture(capability: string, path?: string, binding?: { authorityRootId?: string; authorityRevision: number }, expectedCapabilityGeneration?: number): WorkspaceAuthorityCheck;
}

/** The daemon keeps issued handles across controller attachments. Each captures
 * the original grants, and consults the currently installed snapshot on use. */
export function createWorkspacePolicyGuard(readPolicy: () => ExecutionPolicySnapshot | undefined): WorkspacePolicyGuard {
  return {
    capture(capability, path, binding, expectedCapabilityGeneration) {
      const snapshot = readPolicy();
      const grant = snapshot?.capabilities.find(item => item.id === capability);
      const root = path !== undefined && snapshot ? workspaceRootGrant(snapshot.roots, path, binding) : undefined;
      if (!grant || (expectedCapabilityGeneration !== undefined && grant.generation !== expectedCapabilityGeneration) || (path !== undefined && !root)) throw new SidecarOperationError("workspace_policy_denied");
      const check = () => {
        const current = readPolicy();
        if (!current?.capabilities.some(item => item.id === grant.id && item.generation === grant.generation) ||
          (root && !current.roots.some(item => item.id === root.id && item.generation === root.generation))) {
          throw new SidecarOperationError("workspace_policy_revoked");
        }
      };
      return Object.assign(check, { identity: JSON.stringify([grant.id, grant.generation, root?.id, root?.generation]) });
    },
  };
}

// A read may cross multiple awaits and may disclose paths from multiple grants.
// Retain every consulted handle through the response publication boundary.
const readChecks = new AsyncLocalStorage<Set<() => void>>();
export function checkWorkspaceAuthority(check?: () => void): void {
  if (check) {
    check();
    readChecks.getStore()?.add(check);
  }
}
export async function withWorkspaceReadAuthority<T>(operation: () => Promise<T> | T): Promise<T> {
  const checks = new Set<() => void>();
  return readChecks.run(checks, async () => {
    const result = await operation();
    for (const check of checks) check();
    return result;
  });
}
