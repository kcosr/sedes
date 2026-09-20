import type {
  ThreadWorkspaceIsolationResolution,
  ThreadWorkspaceIsolationResolver,
} from "../../execution/thread-workspace-isolation.js";
import { PI_SANDBOX_HOME } from "../../pi-sandbox/contracts.js";
import {
  WorkspaceToolError,
  type WorkspaceToolExecutor,
} from "../../workspace-tools/contracts.js";
import type { RemotePiWorkspaceServices } from "./pi-remote-workspace.js";

/**
 * Backend-private view of one thread's isolated Pi workspace.
 *
 * The application continues to own the source workspace identity. The
 * effective workspace and service paths returned here must never be copied
 * into normalized conversation settings or bindings.
 */
export type PiIsolatedWorkspaceResolution = ThreadWorkspaceIsolationResolution;
export type PiIsolatedWorkspaceResolver = ThreadWorkspaceIsolationResolver;

const unavailablePassiveExecutor: WorkspaceToolExecutor = {
  async read() {
    throw new WorkspaceToolError("workspace_tools_unavailable");
  },
  async write() {
    throw new WorkspaceToolError("workspace_tools_unavailable");
  },
  async edit() {
    throw new WorkspaceToolError("workspace_tools_unavailable");
  },
  async list() {
    throw new WorkspaceToolError("workspace_tools_unavailable");
  },
  async find() {
    throw new WorkspaceToolError("workspace_tools_unavailable");
  },
  async grep() {
    throw new WorkspaceToolError("workspace_tools_unavailable");
  },
  async startShell() {
    throw new WorkspaceToolError("workspace_tools_unavailable");
  },
};

/**
 * Gives passive Pi sessions the strict executor-backed resource shape without
 * granting host execution or acquiring an isolated worker.
 */
export function passivePiIsolatedWorkspaceServices(
  resolution: Extract<PiIsolatedWorkspaceResolution, { access: "passive" }>,
): RemotePiWorkspaceServices {
  return {
    semanticCwd: PI_SANDBOX_HOME,
    serviceCwd: resolution.effectiveWorkspace.canonicalPath,
    sandboxWorkspaceAccess: resolution.workspaceAccess,
    executor: unavailablePassiveExecutor,
    contextReader: {
      async read() {
        return {
          files: [],
          fingerprint:
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        };
      },
    },
    environmentLabel: "Isolated workspace",
  };
}
