import type { WorkspaceContextReader } from "../workspace-context/contracts.js";
import type { WorkspaceToolExecutor } from "../workspace-tools/contracts.js";
import type { ExecutionScope, ValidatedWorkspace } from "./contracts.js";

/**
 * Server-private execution-environment lease for one thread-owned workspace.
 * Backends adapt this generic tool/context surface to their native session
 * semantics; no provider identity or protocol type crosses this boundary.
 */
interface ThreadWorkspaceIsolationResolutionBase {
  readonly effectiveWorkspace: ValidatedWorkspace;
  readonly workspaceAccess: "read_write" | "read_only";
  /**
   * Releases any resolution-scoped ownership; implementations must be
   * idempotent.
   */
  release(): Promise<void>;
}

export type ThreadWorkspaceIsolationResolution =
  | (ThreadWorkspaceIsolationResolutionBase & {
      readonly access: "passive";
    })
  | (ThreadWorkspaceIsolationResolutionBase & {
      readonly access: "prepare";
    })
  | (ThreadWorkspaceIsolationResolutionBase & {
      readonly access: "active";
      readonly semanticCwd: string;
      readonly serviceCwd: string;
      readonly executor: WorkspaceToolExecutor;
      readonly contextReader: WorkspaceContextReader;
      readonly environmentLabel: string;
    });

export interface ThreadWorkspaceIsolationResolver {
  /**
   * Reports whether isolation was selected without materializing the
   * workspace or acquiring a worker lease.
   */
  isSelected(input: {
    readonly scope: ExecutionScope;
    readonly applicationThreadId: string;
    readonly sourceWorkspace: ValidatedWorkspace;
  }): boolean;
  resolve(input: {
    readonly scope: ExecutionScope;
    readonly applicationThreadId: string;
    readonly sourceWorkspace: ValidatedWorkspace;
    readonly access: "passive" | "prepare" | "active";
  }): Promise<ThreadWorkspaceIsolationResolution | undefined>;
}
