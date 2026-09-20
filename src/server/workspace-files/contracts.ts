import type {
  WorkspaceFileContentResult,
  WorkspaceFileDirectoryQuery,
  WorkspaceFileDirectoryResult,
  WorkspaceFileDownloadQuery,
  WorkspaceFileListQuery,
  WorkspaceFileListResult,
  WorkspaceFileLinkReference,
  WorkspaceFileRootStatus,
  WorkspaceFileRootId,
  WorkspaceFileWriteRequest,
  WorkspaceFileWriteResult,
} from "../../shared/protocol/workspace-files.js";
import type {
  WorkspaceDiffChangedFilesQuery,
  WorkspaceDiffChangedFilesResult,
  WorkspaceDiffComparisonCreateRequest,
  WorkspaceDiffComparisonCreateResult,
  WorkspaceDiffFileContentRequest,
  WorkspaceDiffFileContentResult,
  WorkspaceDiffFileRequest,
  WorkspaceDiffPatchResult,
  WorkspaceDiffRefCatalogQuery,
  WorkspaceDiffRefCatalogResult,
  WorkspaceDiffRepositoriesResult,
  WorkspaceDiffReviewAnchorRequest,
  WorkspaceDiffReviewAnchorResult,
  WorkspaceDiffReviewIdentityRequest,
  WorkspaceDiffReviewIdentityResult,
  WorkspaceDiffReviewedFileRequest,
  WorkspaceDiffReviewedFileResult,
  WorkspaceDiffReviewRepositoryIdentityRequest,
  WorkspaceDiffReviewRepositoryIdentityResult,
} from "../../shared/protocol/workspace-diffs.js";
import type { RequestScope } from "../identity/identity-provider.js";

export interface WorkspaceFileRootTarget {
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly rootId: WorkspaceFileRootId;
  readonly canonicalPath: string;
}

export interface WorkspaceFileRootValidationTarget {
  readonly workspaceId: string;
  readonly environmentId: string;
  readonly rootKind:
    "primary" | "supplemental" | "linked_worktree" | "link_only";
  readonly canonicalPath: string;
}

export interface WorkspaceFileDiscoveredLinkRoot {
  readonly canonicalPath: string;
  readonly relativePath: string;
}

export interface WorkspaceFileDiscoveredLinkedWorktree {
  readonly canonicalPath: string;
  readonly canonicalCheckoutPath: string;
  readonly canonicalGitDir: string;
  readonly identityToken: string;
  readonly displayLabel: string;
  readonly branchRef: string | null;
  readonly headOid: string;
  readonly provenanceKind: "same" | "contained" | "unmerged" | "unknown";
  readonly aheadCount: number | null;
  readonly behindCount: number | null;
}

export interface WorkspaceFileLinkedWorktreeDiscoveryResult {
  readonly worktrees: readonly WorkspaceFileDiscoveredLinkedWorktree[];
  readonly truncated: boolean;
}

export interface WorkspaceLinkedWorktreeRemovalTarget {
  readonly primaryRoot: WorkspaceFileRootTarget;
  readonly canonicalCheckoutPath: string;
  readonly canonicalGitDir: string;
  readonly identityToken: string;
}

export type WorkspaceFileRootListQuery = Omit<WorkspaceFileListQuery, "rootId">;
export type WorkspaceFileRootDirectoryQuery = Omit<
  WorkspaceFileDirectoryQuery,
  "rootId"
>;
export type WorkspaceFileRootWriteRequest = Omit<
  WorkspaceFileWriteRequest,
  "rootId"
>;
export type WorkspaceFileRootDownloadRequest = Omit<
  WorkspaceFileDownloadQuery,
  "rootId"
>;

export interface WorkspaceFileDownloadMetadata {
  readonly path: string;
  readonly fileName: string;
  readonly sizeBytes: number;
  readonly revision: string;
}

/** Valid only for the duration of the provider's `withDownload` callback. */
export interface WorkspaceFileDownloadSource extends WorkspaceFileDownloadMetadata {
  stream(
    write: (chunk: Uint8Array) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void>;
}

export interface WorkspaceFileWatchSubscription {
  /** Resolves only when an established watcher later loses health. */
  readonly failed: Promise<void>;
  close(): void | Promise<void>;
}

export interface WorkspaceFileProvider {
  /** Whether the environment exposes its primary workspace root through Files. */
  supportsPrimaryRoot(scope: RequestScope, environmentId: string): boolean;
  supportsSupplementalRoots(
    scope: RequestScope,
    environmentId: string,
  ): boolean;
  supportsFileLinkRootDiscovery(
    scope: RequestScope,
    environmentId: string,
  ): boolean;
  supportsWatching(scope: RequestScope, root: WorkspaceFileRootTarget): boolean;
  /**
   * Revalidate one server-authorized root against the provider's live
   * filesystem authority. This is stronger than lexical environment admission.
   */
  validateRoot(
    scope: RequestScope,
    root: WorkspaceFileRootValidationTarget,
    signal?: AbortSignal,
  ): Promise<void>;
  discoverFileLinkRoot(
    scope: RequestScope,
    environmentId: string,
    absolutePath: string,
  ): Promise<WorkspaceFileDiscoveredLinkRoot | undefined>;
  discoverLinkedWorktrees(
    scope: RequestScope,
    primaryRoot: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileLinkedWorktreeDiscoveryResult>;
  removeLinkedWorktree(
    scope: RequestScope,
    target: WorkspaceLinkedWorktreeRemovalTarget,
    signal?: AbortSignal,
  ): Promise<void>;
  resolveFileLink(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    reference: WorkspaceFileLinkReference,
  ): Promise<string | undefined>;
  list(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceFileRootListQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileListResult>;
  listDirectory(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceFileRootDirectoryQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileDirectoryResult>;
  read(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileContentResult>;
  withDownload<T>(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceFileRootDownloadRequest,
    operation: (source: WorkspaceFileDownloadSource) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  write(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceFileRootWriteRequest,
  ): Promise<WorkspaceFileWriteResult>;
  status(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileRootStatus>;
  diffRepositories(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffRepositoriesResult>;
  diffRefCatalog(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceDiffRefCatalogQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffRefCatalogResult>;
  diffCreateComparison(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffComparisonCreateRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffComparisonCreateResult>;
  diffChangedFiles(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceDiffChangedFilesQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffChangedFilesResult>;
  diffPatch(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffFileRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffPatchResult>;
  diffFileContent(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffFileContentRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffFileContentResult>;
  diffReviewIdentity(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewIdentityRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewIdentityResult>;
  diffValidateReviewAnchor(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewAnchorRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewAnchorResult>;
  diffValidateReviewedFile(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewedFileRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewedFileResult>;
  diffReviewRepositoryIdentity(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewRepositoryIdentityRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewRepositoryIdentityResult>;
  watch(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    listener: () => void,
  ): Promise<WorkspaceFileWatchSubscription | undefined>;
  close(): void;
}

/** Stable, non-leaking denial for missing, sensitive, or escaping paths. */
export class WorkspaceFileAccessError extends Error {
  constructor() {
    super("workspace_file_not_found");
    this.name = "WorkspaceFileAccessError";
  }
}

/** A retained filesystem listing cursor is missing, expired, or mismatched. */
export class WorkspaceFileCursorInvalidError extends Error {
  constructor() {
    super("workspace_file_list_cursor_invalid");
    this.name = "WorkspaceFileCursorInvalidError";
  }
}

export class WorkspaceFileRevisionConflictError extends Error {
  constructor() {
    super("workspace_file_revision_conflict");
    this.name = "WorkspaceFileRevisionConflictError";
  }
}

export class WorkspaceFileDownloadTooLargeError extends Error {
  constructor() {
    super("workspace_file_download_too_large");
    this.name = "WorkspaceFileDownloadTooLargeError";
  }
}

/** A write may have committed remotely, so callers must reconcile, not retry. */
export class WorkspaceFileWriteOutcomeUnknownError extends Error {
  constructor() {
    super("workspace_file_write_outcome_unknown");
    this.name = "WorkspaceFileWriteOutcomeUnknownError";
  }
}

export class WorkspaceLinkedWorktreeRemovalOutcomeUnknownError extends Error {
  constructor() {
    super("workspace_linked_worktree_removal_outcome_unknown");
    this.name = "WorkspaceLinkedWorktreeRemovalOutcomeUnknownError";
  }
}

export class WorkspaceLinkedWorktreeDirtyError extends Error {
  constructor() {
    super("workspace_linked_worktree_dirty");
    this.name = "WorkspaceLinkedWorktreeDirtyError";
  }
}

export class WorkspaceLinkedWorktreeRemovalRejectedError extends Error {
  constructor() {
    super("workspace_linked_worktree_removal_rejected");
    this.name = "WorkspaceLinkedWorktreeRemovalRejectedError";
  }
}

/** The remembered root itself is missing, moved, or no longer canonical. */
export class WorkspaceFileRootUnavailableError extends Error {
  readonly diagnosticCode = "workspace_file_root_unavailable" as const;

  constructor() {
    super("workspace_file_root_unavailable");
    this.name = "WorkspaceFileRootUnavailableError";
  }
}

/** The configured Files provider cannot currently perform remote operations. */
export class WorkspaceFileProviderUnavailableError extends Error {
  constructor(
    readonly diagnosticCode:
      | "workspace_files_sidecar_unavailable"
      | "workspace_files_unsupported" = "workspace_files_sidecar_unavailable",
  ) {
    super(diagnosticCode);
    this.name = "WorkspaceFileProviderUnavailableError";
  }
}

export class UnsupportedWorkspaceFileProvider implements WorkspaceFileProvider {
  supportsPrimaryRoot(_scope: RequestScope, _environmentId: string): boolean {
    return false;
  }

  supportsSupplementalRoots(
    _scope: RequestScope,
    _environmentId: string,
  ): boolean {
    return false;
  }

  supportsFileLinkRootDiscovery(
    _scope: RequestScope,
    _environmentId: string,
  ): boolean {
    return false;
  }

  supportsWatching(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
  ): boolean {
    return false;
  }

  async validateRoot(
    _scope: RequestScope,
    _root: WorkspaceFileRootValidationTarget,
  ): Promise<void> {
    throw new WorkspaceFileProviderUnavailableError(
      "workspace_files_unsupported",
    );
  }

  async resolveFileLink(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _reference: WorkspaceFileLinkReference,
  ): Promise<undefined> {
    return undefined;
  }

  async discoverFileLinkRoot(
    _scope: RequestScope,
    _environmentId: string,
    _absolutePath: string,
  ): Promise<undefined> {
    return undefined;
  }

  async discoverLinkedWorktrees(
    _scope: RequestScope,
    _primaryRoot: WorkspaceFileRootTarget,
  ): Promise<WorkspaceFileLinkedWorktreeDiscoveryResult> {
    return { worktrees: [], truncated: false };
  }

  async removeLinkedWorktree(): Promise<void> {
    throw new WorkspaceFileProviderUnavailableError(
      "workspace_files_unsupported",
    );
  }

  async list(
    _scope: RequestScope,
    root: WorkspaceFileRootTarget,
    _query: WorkspaceFileRootListQuery,
  ): Promise<WorkspaceFileListResult> {
    return unavailableRoot(root);
  }

  async listDirectory(
    _scope: RequestScope,
    root: WorkspaceFileRootTarget,
    _query: WorkspaceFileRootDirectoryQuery,
  ): Promise<WorkspaceFileDirectoryResult> {
    return unavailableRoot(root);
  }

  async read(
    _scope: RequestScope,
    root: WorkspaceFileRootTarget,
    _relativePath: string,
  ): Promise<WorkspaceFileContentResult> {
    return unavailableRoot(root);
  }

  async withDownload<T>(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _input: WorkspaceFileRootDownloadRequest,
    _operation: (source: WorkspaceFileDownloadSource) => Promise<T>,
  ): Promise<T> {
    throw new WorkspaceFileProviderUnavailableError(
      "workspace_files_unsupported",
    );
  }

  async write(
    _scope: RequestScope,
    root: WorkspaceFileRootTarget,
    _input: WorkspaceFileRootWriteRequest,
  ): Promise<WorkspaceFileWriteResult> {
    return unavailableRoot(root);
  }

  async status(
    _scope: RequestScope,
    root: WorkspaceFileRootTarget,
  ): Promise<WorkspaceFileRootStatus> {
    return unavailableRoot(root);
  }

  async diffRepositories(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
  ): Promise<WorkspaceDiffRepositoriesResult> {
    return unavailableDiff();
  }

  async diffRefCatalog(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _query: WorkspaceDiffRefCatalogQuery,
  ): Promise<WorkspaceDiffRefCatalogResult> {
    return unavailableDiff();
  }

  async diffCreateComparison(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _input: WorkspaceDiffComparisonCreateRequest,
  ): Promise<WorkspaceDiffComparisonCreateResult> {
    return unavailableDiff();
  }

  async diffChangedFiles(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _query: WorkspaceDiffChangedFilesQuery,
  ): Promise<WorkspaceDiffChangedFilesResult> {
    return unavailableDiff();
  }

  async diffPatch(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _input: WorkspaceDiffFileRequest,
  ): Promise<WorkspaceDiffPatchResult> {
    return unavailableDiff();
  }

  async diffFileContent(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _input: WorkspaceDiffFileContentRequest,
  ): Promise<WorkspaceDiffFileContentResult> {
    return unavailableDiff();
  }

  async diffReviewIdentity(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _input: WorkspaceDiffReviewIdentityRequest,
  ): Promise<WorkspaceDiffReviewIdentityResult> {
    return unavailableDiff();
  }

  async diffValidateReviewAnchor(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _input: WorkspaceDiffReviewAnchorRequest,
  ): Promise<WorkspaceDiffReviewAnchorResult> {
    return unavailableDiff();
  }

  async diffValidateReviewedFile(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _input: WorkspaceDiffReviewedFileRequest,
  ): Promise<WorkspaceDiffReviewedFileResult> {
    return unavailableDiff();
  }

  async diffReviewRepositoryIdentity(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _input: WorkspaceDiffReviewRepositoryIdentityRequest,
  ): Promise<WorkspaceDiffReviewRepositoryIdentityResult> {
    return unavailableDiff();
  }

  async watch(
    _scope: RequestScope,
    _root: WorkspaceFileRootTarget,
    _listener: () => void,
  ): Promise<undefined> {
    return undefined;
  }

  close(): void {}
}

function unavailableRoot(root: WorkspaceFileRootTarget): {
  readonly availability: "unavailable";
  readonly rootId: WorkspaceFileRootId;
  readonly diagnosticCode: "workspace_files_unsupported";
} {
  return {
    availability: "unavailable",
    rootId: root.rootId,
    diagnosticCode: "workspace_files_unsupported",
  };
}

function unavailableDiff(): {
  readonly status: "unavailable";
  readonly diagnosticCode: "workspace_files_unsupported";
} {
  return {
    status: "unavailable",
    diagnosticCode: "workspace_files_unsupported",
  };
}
