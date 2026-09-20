import path from "node:path";
import type { WorkspaceFileLinkReference } from "../../shared/protocol/workspace-files.js";
import type {
  WorkspaceDiffChangedFilesQuery,
  WorkspaceDiffComparisonCreateRequest,
  WorkspaceDiffFileContentRequest,
  WorkspaceDiffFileRequest,
  WorkspaceDiffRefCatalogQuery,
  WorkspaceDiffReviewAnchorRequest,
  WorkspaceDiffReviewIdentityRequest,
  WorkspaceDiffReviewedFileRequest,
  WorkspaceDiffReviewRepositoryIdentityRequest,
} from "../../shared/protocol/workspace-diffs.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  WorkspaceFileDiscoveredLinkRoot,
  WorkspaceFileProvider,
  WorkspaceFileRootDirectoryQuery,
  WorkspaceFileRootDownloadRequest,
  WorkspaceFileRootListQuery,
  WorkspaceFileRootTarget,
  WorkspaceFileRootValidationTarget,
  WorkspaceFileRootWriteRequest,
  WorkspaceFileWatchSubscription,
  WorkspaceFileDownloadSource,
} from "./contracts.js";
import { LocalWorkspaceFileWatcherRegistry } from "./local-workspace-file-watcher.js";
import {
  WorkspaceFilesEngine,
  type WorkspaceFilesEngineRoot,
  type WorkspaceFilesEngineTestHooks,
} from "./workspace-files-engine.js";
import {
  WorkspaceDiffsEngine,
  type WorkspaceDiffsEngineRoot,
} from "./workspace-diffs-engine.js";

function sameScope(left: RequestScope, right: RequestScope): boolean {
  return (
    left.tenantId === right.tenantId && left.principalId === right.principalId
  );
}

export type LocalWorkspaceFileProviderTestHooks = WorkspaceFilesEngineTestHooks;

/** Local application-authority adapter over the shared filesystem engine. */
export class LocalWorkspaceFileProvider implements WorkspaceFileProvider {
  readonly #scope: RequestScope;
  readonly #environmentId: string;
  readonly #engine: WorkspaceFilesEngine;
  readonly #diffs = new WorkspaceDiffsEngine();

  constructor(input: {
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly watchers?: LocalWorkspaceFileWatcherRegistry;
    readonly testHooks?: LocalWorkspaceFileProviderTestHooks;
  }) {
    this.#scope = Object.freeze({ ...input.scope });
    this.#environmentId = input.environmentId;
    this.#engine = new WorkspaceFilesEngine({
      ...(input.watchers ? { watchers: input.watchers } : {}),
      ...(input.testHooks ? { testHooks: input.testHooks } : {}),
    });
  }

  supportsPrimaryRoot(scope: RequestScope, environmentId: string): boolean {
    return this.#supports(scope, environmentId);
  }

  supportsSupplementalRoots(
    scope: RequestScope,
    environmentId: string,
  ): boolean {
    return this.#supports(scope, environmentId);
  }

  supportsFileLinkRootDiscovery(
    scope: RequestScope,
    environmentId: string,
  ): boolean {
    return this.#supports(scope, environmentId);
  }

  supportsWatching(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
  ): boolean {
    return (
      this.#supports(scope, root.environmentId) &&
      Boolean(root.workspaceId) &&
      Boolean(root.rootId) &&
      path.isAbsolute(root.canonicalPath)
    );
  }

  async validateRoot(
    scope: RequestScope,
    root: WorkspaceFileRootValidationTarget,
  ): Promise<void> {
    if (
      !this.#supports(scope, root.environmentId) ||
      !root.workspaceId ||
      !path.isAbsolute(root.canonicalPath)
    ) {
      throw new Error("workspace_file_environment_unavailable");
    }
    await this.#engine.validateRoot(root.canonicalPath);
  }

  async discoverFileLinkRoot(
    scope: RequestScope,
    environmentId: string,
    absolutePath: string,
  ): Promise<WorkspaceFileDiscoveredLinkRoot | undefined> {
    if (
      !this.#supports(scope, environmentId) ||
      !path.isAbsolute(absolutePath)
    ) {
      return undefined;
    }
    return this.#engine.discoverFileLinkRoot(absolutePath);
  }

  async discoverLinkedWorktrees(
    scope: RequestScope,
    primaryRoot: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ) {
    if (primaryRoot.rootId !== "primary") {
      throw new Error("workspace_file_linked_worktree_primary_required");
    }
    return this.#engine.discoverLinkedWorktrees(
      this.#root(scope, primaryRoot),
      signal,
    );
  }

  async removeLinkedWorktree(
    scope: RequestScope,
    target: Parameters<WorkspaceFileProvider["removeLinkedWorktree"]>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#engine.removeLinkedWorktree(
      this.#root(scope, target.primaryRoot),
      target,
      signal,
    );
  }

  async resolveFileLink(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    reference: WorkspaceFileLinkReference,
  ): Promise<string | undefined> {
    if (
      reference.kind === "root_relative" &&
      reference.rootId !== root.rootId
    ) {
      return undefined;
    }
    return this.#engine.resolveFileLink(this.#root(scope, root), reference);
  }

  async list(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceFileRootListQuery,
    signal?: AbortSignal,
  ) {
    const result = await this.#engine.list(
      this.#root(scope, root),
      query,
      signal,
    );
    return {
      availability: "available" as const,
      rootId: root.rootId,
      ...result,
    };
  }

  async listDirectory(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceFileRootDirectoryQuery,
    signal?: AbortSignal,
  ) {
    const result = await this.#engine.listDirectory(
      this.#root(scope, root),
      query,
      signal,
    );
    return {
      availability: "available" as const,
      rootId: root.rootId,
      ...result,
    };
  }

  async read(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    relativePath: string,
    signal?: AbortSignal,
  ) {
    const result = await this.#engine.read(
      this.#root(scope, root),
      relativePath,
      signal,
    );
    return {
      availability: "available" as const,
      rootId: root.rootId,
      ...result,
    };
  }

  async withDownload<T>(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceFileRootDownloadRequest,
    operation: (source: WorkspaceFileDownloadSource) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#engine.withDownload(
      this.#root(scope, root),
      input,
      operation,
      signal,
    );
  }

  async write(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceFileRootWriteRequest,
  ) {
    const result = await this.#engine.write(this.#root(scope, root), input);
    return {
      availability: "available" as const,
      rootId: root.rootId,
      ...result,
    };
  }

  async status(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ) {
    const result = await this.#engine.status(this.#root(scope, root), signal);
    return {
      availability: "available" as const,
      rootId: root.rootId,
      ...result,
      entries: result.entries.map((entry) => ({
        rootId: root.rootId,
        ...entry,
      })),
    };
  }

  diffRepositories(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ) {
    return this.#diffs.repositories(this.#diffRoot(scope, root), signal);
  }

  diffRefCatalog(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceDiffRefCatalogQuery,
    signal?: AbortSignal,
  ) {
    return this.#diffs.refCatalog(this.#diffRoot(scope, root), query, signal);
  }

  diffCreateComparison(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffComparisonCreateRequest,
    signal?: AbortSignal,
  ) {
    return this.#diffs.createComparison(
      this.#diffRoot(scope, root),
      input,
      signal,
    );
  }

  diffChangedFiles(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceDiffChangedFilesQuery,
    signal?: AbortSignal,
  ) {
    return this.#diffs.changedFiles(this.#diffRoot(scope, root), query, signal);
  }

  diffPatch(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffFileRequest,
    signal?: AbortSignal,
  ) {
    return this.#diffs.patch(this.#diffRoot(scope, root), input, signal);
  }

  diffFileContent(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffFileContentRequest,
    signal?: AbortSignal,
  ) {
    return this.#diffs.fileContent(this.#diffRoot(scope, root), input, signal);
  }

  diffReviewIdentity(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewIdentityRequest,
    signal?: AbortSignal,
  ) {
    return this.#diffs.reviewIdentity(
      this.#diffRoot(scope, root),
      input,
      signal,
    );
  }

  diffValidateReviewAnchor(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewAnchorRequest,
    signal?: AbortSignal,
  ) {
    return this.#diffs.validateReviewAnchor(
      this.#diffRoot(scope, root),
      input,
      signal,
    );
  }

  diffValidateReviewedFile(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewedFileRequest,
    signal?: AbortSignal,
  ) {
    return this.#diffs.validateReviewedFile(
      this.#diffRoot(scope, root),
      input,
      signal,
    );
  }

  diffReviewRepositoryIdentity(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewRepositoryIdentityRequest,
    signal?: AbortSignal,
  ) {
    return this.#diffs.reviewRepositoryIdentity(
      this.#diffRoot(scope, root),
      input,
      signal,
    );
  }

  async watch(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    listener: () => void,
  ): Promise<WorkspaceFileWatchSubscription> {
    return this.#engine.watch(this.#root(scope, root), listener);
  }

  close(): void {
    this.#engine.close();
  }

  #supports(scope: RequestScope, environmentId: string): boolean {
    return (
      sameScope(scope, this.#scope) && environmentId === this.#environmentId
    );
  }

  #root(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
  ): WorkspaceFilesEngineRoot {
    if (
      !this.#supports(scope, root.environmentId) ||
      !root.workspaceId ||
      !root.rootId ||
      !path.isAbsolute(root.canonicalPath)
    ) {
      throw new Error("workspace_file_environment_unavailable");
    }
    return {
      canonicalPath: root.canonicalPath,
      operationKey: `${scope.tenantId}\0${scope.principalId}\0${root.workspaceId}\0${root.rootId}`,
    };
  }

  #diffRoot(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
  ): WorkspaceDiffsEngineRoot {
    const resolved = this.#root(scope, root);
    return {
      canonicalPath: resolved.canonicalPath,
      durableRootKey: resolved.operationKey,
      operationKey: resolved.operationKey,
      rootId: root.rootId,
    };
  }
}
