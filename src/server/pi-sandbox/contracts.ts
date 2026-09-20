import type { EnvironmentChannelScope } from "../execution/environment-channel.js";
import type { WorkspaceContextReader } from "../workspace-context/contracts.js";
import type { WorkspaceToolExecutor } from "../workspace-tools/contracts.js";

export const PI_SANDBOX_HOME = "/home/agent";
export const PI_SANDBOX_WORKSPACE = "/home/agent/workspace";

export type PiSandboxNetworkMode = "isolated" | "execution_host";
export type PiSandboxWorkspaceAccess = "writable_clone" | "read_only";

/** Durable, server-derived allocation metadata. Browser input is never trusted here. */
export interface PiSandboxAllocation {
  readonly allocationId: string;
  readonly scope: EnvironmentChannelScope;
  readonly applicationThreadId: string;
  readonly sourceWorkspaceId: string;
  readonly hostHomePath: string;
  readonly hostWorkspacePath: string;
  readonly serviceCwd: string;
  readonly networkMode: PiSandboxNetworkMode;
  readonly workspaceAccess: PiSandboxWorkspaceAccess;
}

export interface PiSandboxWorkerArtifact {
  readonly executablePath: string;
  readonly buildId: string;
  readonly sha256: string;
}

export interface PiSandboxWorkspaceLease {
  readonly allocationId: string;
  readonly semanticHome: typeof PI_SANDBOX_HOME;
  readonly semanticCwd: typeof PI_SANDBOX_HOME;
  readonly workspaceAccess: PiSandboxWorkspaceAccess;
  readonly serviceCwd: string;
  readonly hostHomePath: string;
  readonly hostWorkspacePath: string;
  readonly executor: WorkspaceToolExecutor;
  readonly contextReader: WorkspaceContextReader;
  readonly environmentLabel: string;
  release(): Promise<void>;
}
