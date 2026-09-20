import type { ResolvedEnvironmentVariables } from "../environment-variables/runtime-environment.js";
import type {
  WorkspaceToolsV2ErrorCode,
  workspaceToolsDirectoryListOperation,
  workspaceToolsFileEditOperation,
  workspaceToolsFileReadOperation,
  workspaceToolsFileWriteOperation,
  workspaceToolsSearchFindOperation,
  workspaceToolsSearchGrepOperation,
} from "../../internal/sidecar-protocol/index.js";
import type { z } from "zod";
import type {
  SidecarStreamDataRecord,
  WorkspaceToolsShellTerminal,
} from "../../internal/sidecar-protocol/index.js";

export interface WorkspaceToolRoot {
  readonly canonicalPath: string;
  readonly operationKey: string;
  readonly homePath: string;
}

export interface WorkspaceToolEdit {
  readonly oldText: string;
  readonly newText: string;
}

export type WorkspaceToolReadResult = z.infer<
  typeof workspaceToolsFileReadOperation.responseSchema
>;
export type WorkspaceToolMutationResult = z.infer<
  typeof workspaceToolsFileWriteOperation.responseSchema
>;
export type WorkspaceToolEditResult = z.infer<
  typeof workspaceToolsFileEditOperation.responseSchema
>;
export type WorkspaceToolListResult = z.infer<
  typeof workspaceToolsDirectoryListOperation.responseSchema
>;
export type WorkspaceToolFindResult = z.infer<
  typeof workspaceToolsSearchFindOperation.responseSchema
>;
export type WorkspaceToolGrepResult = z.infer<
  typeof workspaceToolsSearchGrepOperation.responseSchema
>;
export type WorkspaceToolGrepMatch = WorkspaceToolGrepResult["matches"][number];

export class WorkspaceToolError extends Error {
  constructor(
    readonly code: WorkspaceToolsV2ErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
    this.name = WorkspaceToolError.name;
  }
}

export class WorkspaceToolOutcomeUnknownError extends WorkspaceToolError {
  constructor(options?: ErrorOptions) {
    super("workspace_tools_outcome_unknown", options);
    this.name = WorkspaceToolOutcomeUnknownError.name;
  }
}

/** Provider-neutral execution surface. Semantic paths never imply main-host I/O. */
export interface WorkspaceToolExecutor {
  read(input: {
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceToolReadResult>;
  write(input: {
    readonly path: string;
    readonly content: string;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceToolMutationResult>;
  edit(input: {
    readonly path: string;
    readonly edits: readonly WorkspaceToolEdit[];
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceToolEditResult>;
  list(input: {
    readonly path?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceToolListResult>;
  find(input: {
    readonly pattern: string;
    readonly path?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceToolFindResult>;
  grep(input: {
    readonly pattern: string;
    readonly path?: string;
    readonly glob?: string;
    readonly ignoreCase?: boolean;
    readonly literal?: boolean;
    readonly context?: number;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<WorkspaceToolGrepResult>;
  startShell(input: {
    readonly environmentVariables?: ResolvedEnvironmentVariables;
    readonly command: string;
    readonly initialCreditBytes: number;
    readonly timeoutMilliseconds: number;
    readonly signal?: AbortSignal;
    readonly onData: (record: SidecarStreamDataRecord) => void | Promise<void>;
  }): Promise<WorkspaceToolShellProcess>;
}

export interface WorkspaceToolShellProcess {
  readonly streamId: string;
  readonly terminal: Promise<WorkspaceToolsShellTerminal>;
  addCredit(bytes: number): Promise<void>;
  cancel(): Promise<void>;
  /** Explicitly relinquish the retained final outcome after consuming it. */
  acknowledge(): Promise<void>;
}
