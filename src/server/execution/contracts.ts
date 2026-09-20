import type {
  EnvironmentSummary,
  WorkspaceSummary,
} from "../../shared/protocol/domain.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  DirectoryBrowseResult,
  ParsedDirectoryBrowseRequest,
} from "../../shared/protocol/directory-browser.js";

export type ExecutionScope = RequestScope;

export interface ExecutionDirectoryBrowseRequest extends ParsedDirectoryBrowseRequest {
  readonly environmentId: string;
  readonly signal?: AbortSignal;
}

export interface ValidatedWorkspace {
  readonly summary: WorkspaceSummary;
  readonly canonicalPath: string;
  readonly authorityRevision: number;
}

/** Definitive operator-policy denial, distinct from unavailable validation. */
export class ExecutionWorkspaceAdmissionDeniedError extends Error {
  constructor() {
    super("workspace_not_allowed");
    this.name = "ExecutionWorkspaceAdmissionDeniedError";
  }
}

export interface ExecutionEnvironmentLease {
  readonly scope: ExecutionScope;
  readonly environment: EnvironmentSummary;
  readonly workspace: ValidatedWorkspace;
  release(): Promise<void>;
}

export interface ExecutionEnvironmentLeaseRequest {
  readonly environmentId: string;
  readonly workspace: ValidatedWorkspace;
}

export interface ExecutionCommandRequest {
  readonly environmentId: string;
  readonly workspace: ValidatedWorkspace;
  readonly command: string;
  readonly timeoutMilliseconds: number;
  readonly signal?: AbortSignal;
}

export type ExecutionCommandResult =
  | {
      readonly kind: "exited";
      readonly exitCode: number;
      readonly stdoutPreview: Uint8Array;
      readonly stderrPreview: Uint8Array;
      readonly stdoutBytes: number;
      readonly stderrBytes: number;
      readonly stdoutTruncated: boolean;
      readonly stderrTruncated: boolean;
      readonly durationMilliseconds: number;
    }
  | {
      readonly kind: "timed_out" | "cancelled" | "unavailable";
      readonly stdoutPreview: Uint8Array;
      readonly stderrPreview: Uint8Array;
      readonly stdoutBytes: number;
      readonly stderrBytes: number;
      readonly stdoutTruncated: boolean;
      readonly stderrTruncated: boolean;
      readonly durationMilliseconds: number;
      readonly diagnosticCode: string;
    };

export interface ExecutionEnvironmentProvider {
  listEnvironments(
    scope: ExecutionScope,
  ): Promise<readonly EnvironmentSummary[]>;
  directoryBrowsingAvailability(
    scope: ExecutionScope,
    environmentId: string,
  ): "available" | "unavailable";
  browseDirectories(
    scope: ExecutionScope,
    request: ExecutionDirectoryBrowseRequest,
  ): Promise<DirectoryBrowseResult>;
  validateWorkspace(
    scope: ExecutionScope,
    environmentId: string,
    candidatePath: string,
  ): Promise<ValidatedWorkspace>;
  revalidateWorkspace(
    scope: ExecutionScope,
    workspace: ValidatedWorkspace,
  ): Promise<ValidatedWorkspace>;
  acquireLease(
    scope: ExecutionScope,
    request: ExecutionEnvironmentLeaseRequest,
  ): Promise<ExecutionEnvironmentLease>;
  executeCommand(
    scope: ExecutionScope,
    request: ExecutionCommandRequest,
  ): Promise<ExecutionCommandResult>;
}
