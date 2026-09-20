import {
  SidecarOperationError,
  type WorkspaceContextV1Handlers,
} from "../../internal/sidecar-protocol/index.js";
import {
  WorkspaceContextDiscoveryError,
  discoverWorkspaceContext,
} from "../workspace-context/workspace-context-discovery.js";

export class WorkspaceContextSidecarHost {
  readonly handlers: WorkspaceContextV1Handlers;
  #closed = false;

  constructor() {
    this.handlers = {
      readContext: (request, context) => this.#read(request, context.signal),
    };
  }
  close(): void {
    this.#closed = true;
  }

  async #read(
    request: { readonly declaredPath: string; readonly policyRootPath: string },
    signal: AbortSignal,
  ) {
    if (this.#closed)
      throw new SidecarOperationError("workspace_context_unavailable");
    try {
      return await discoverWorkspaceContext({
        workspacePath: request.declaredPath,
        policyRoots: [request.policyRootPath],
        signal,
      });
    } catch (error) {
      if (signal.aborted)
        throw new SidecarOperationError("workspace_context_cancelled");
      if (error instanceof WorkspaceContextDiscoveryError) {
        const code =
          error.code === "workspace_context_limit_exceeded"
            ? "workspace_context_limit_exceeded"
            : error.code === "workspace_context_unstable"
              ? "workspace_context_path_unstable"
              : "workspace_context_workspace_outside_policy";
        throw new SidecarOperationError(code);
      }
      throw error;
    }
  }
}
