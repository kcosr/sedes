import type { RequestScope } from "../identity/identity-provider.js";
import type { WorkspaceFileLinkReference } from "../../shared/protocol/workspace-files.js";
import type {
  WorkspaceFileDiscoveredLinkRoot,
  WorkspaceFileLinkedWorktreeDiscoveryResult,
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

function sameScope(left: RequestScope, right: RequestScope): boolean {
  return (
    left.tenantId === right.tenantId && left.principalId === right.principalId
  );
}

function optionalAbortSignal(
  signal: AbortSignal | undefined,
): [] | [AbortSignal] {
  return signal ? [signal] : [];
}

/** Principal-scoped, exact environment-ID routing with no local fallback. */
export class CompositeWorkspaceFileProvider implements WorkspaceFileProvider {
  readonly #scope: RequestScope;
  readonly #providers: Map<string, WorkspaceFileProvider>;

  constructor(input: {
    readonly scope: RequestScope;
    readonly providers: ReadonlyMap<string, WorkspaceFileProvider>;
  }) {
    this.#scope = Object.freeze({ ...input.scope });
    this.#providers = new Map(input.providers);
  }

  /** Caller drains file operations and subscriptions before replacement. */
  set(
    scope: RequestScope,
    environmentId: string,
    provider: WorkspaceFileProvider,
  ): void {
    if (!sameScope(scope, this.#scope))
      throw new Error("workspace_file_environment_unavailable");
    if (!environmentId)
      throw new Error("execution_environment_registry_id_invalid");
    this.#providers.set(environmentId, provider);
  }

  remove(scope: RequestScope, environmentId: string): void {
    if (!sameScope(scope, this.#scope))
      throw new Error("workspace_file_environment_unavailable");
    this.#providers.delete(environmentId);
  }

  supportsPrimaryRoot(scope: RequestScope, environmentId: string): boolean {
    return this.#provider(scope, environmentId).supportsPrimaryRoot(
      scope,
      environmentId,
    );
  }

  supportsSupplementalRoots(
    scope: RequestScope,
    environmentId: string,
  ): boolean {
    return this.#provider(scope, environmentId).supportsSupplementalRoots(
      scope,
      environmentId,
    );
  }

  supportsFileLinkRootDiscovery(
    scope: RequestScope,
    environmentId: string,
  ): boolean {
    return this.#provider(scope, environmentId).supportsFileLinkRootDiscovery(
      scope,
      environmentId,
    );
  }

  supportsWatching(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
  ): boolean {
    return this.#provider(scope, root.environmentId).supportsWatching(
      scope,
      root,
    );
  }

  validateRoot(
    scope: RequestScope,
    root: WorkspaceFileRootValidationTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#provider(scope, root.environmentId).validateRoot(
      scope,
      root,
      ...optionalAbortSignal(signal),
    );
  }

  discoverFileLinkRoot(
    scope: RequestScope,
    environmentId: string,
    absolutePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileDiscoveredLinkRoot | undefined> {
    return this.#provider(scope, environmentId).discoverFileLinkRoot(
      scope,
      environmentId,
      absolutePath,
      ...optionalAbortSignal(signal),
    );
  }

  discoverLinkedWorktrees(
    scope: RequestScope,
    primaryRoot: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileLinkedWorktreeDiscoveryResult> {
    return this.#provider(
      scope,
      primaryRoot.environmentId,
    ).discoverLinkedWorktrees(
      scope,
      primaryRoot,
      ...optionalAbortSignal(signal),
    );
  }

  removeLinkedWorktree(
    scope: RequestScope,
    target: Parameters<WorkspaceFileProvider["removeLinkedWorktree"]>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    return this.#provider(
      scope,
      target.primaryRoot.environmentId,
    ).removeLinkedWorktree(scope, target, ...optionalAbortSignal(signal));
  }

  resolveFileLink(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    reference: WorkspaceFileLinkReference,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    return this.#provider(scope, root.environmentId).resolveFileLink(
      scope,
      root,
      reference,
      ...optionalAbortSignal(signal),
    );
  }

  list(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceFileRootListQuery,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).list(
      scope,
      root,
      query,
      ...optionalAbortSignal(signal),
    );
  }

  listDirectory(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceFileRootDirectoryQuery,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).listDirectory(
      scope,
      root,
      query,
      ...optionalAbortSignal(signal),
    );
  }

  read(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    relativePath: string,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).read(
      scope,
      root,
      relativePath,
      ...optionalAbortSignal(signal),
    );
  }

  withDownload<T>(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceFileRootDownloadRequest,
    operation: (source: WorkspaceFileDownloadSource) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#provider(scope, root.environmentId).withDownload(
      scope,
      root,
      input,
      operation,
      ...optionalAbortSignal(signal),
    );
  }

  write(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceFileRootWriteRequest,
  ) {
    return this.#provider(scope, root.environmentId).write(scope, root, input);
  }

  status(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).status(
      scope,
      root,
      ...optionalAbortSignal(signal),
    );
  }

  diffRepositories(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).diffRepositories(
      scope,
      root,
      ...optionalAbortSignal(signal),
    );
  }

  diffRefCatalog(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceDiffRefCatalogQuery,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).diffRefCatalog(
      scope,
      root,
      query,
      ...optionalAbortSignal(signal),
    );
  }

  diffCreateComparison(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffComparisonCreateRequest,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).diffCreateComparison(
      scope,
      root,
      input,
      ...optionalAbortSignal(signal),
    );
  }

  diffChangedFiles(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceDiffChangedFilesQuery,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).diffChangedFiles(
      scope,
      root,
      query,
      ...optionalAbortSignal(signal),
    );
  }

  diffPatch(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffFileRequest,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).diffPatch(
      scope,
      root,
      input,
      ...optionalAbortSignal(signal),
    );
  }

  diffFileContent(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffFileContentRequest,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).diffFileContent(
      scope,
      root,
      input,
      ...optionalAbortSignal(signal),
    );
  }

  diffReviewIdentity(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewIdentityRequest,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).diffReviewIdentity(
      scope,
      root,
      input,
      ...optionalAbortSignal(signal),
    );
  }

  diffValidateReviewAnchor(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewAnchorRequest,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).diffValidateReviewAnchor(
      scope,
      root,
      input,
      ...optionalAbortSignal(signal),
    );
  }

  diffValidateReviewedFile(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewedFileRequest,
    signal?: AbortSignal,
  ) {
    return this.#provider(scope, root.environmentId).diffValidateReviewedFile(
      scope,
      root,
      input,
      ...optionalAbortSignal(signal),
    );
  }

  diffReviewRepositoryIdentity(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewRepositoryIdentityRequest,
    signal?: AbortSignal,
  ) {
    return this.#provider(
      scope,
      root.environmentId,
    ).diffReviewRepositoryIdentity(
      scope,
      root,
      input,
      ...optionalAbortSignal(signal),
    );
  }

  watch(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    listener: () => void,
  ): Promise<WorkspaceFileWatchSubscription | undefined> {
    return this.#provider(scope, root.environmentId).watch(
      scope,
      root,
      listener,
    );
  }

  async close(): Promise<void> {
    await Promise.all(
      [...new Set(this.#providers.values())].map(
        async (provider) => await provider.close(),
      ),
    );
  }

  #provider(scope: RequestScope, environmentId: string): WorkspaceFileProvider {
    if (!sameScope(scope, this.#scope)) {
      throw new Error("workspace_file_environment_unavailable");
    }
    const provider = this.#providers.get(environmentId);
    if (!provider) throw new Error("workspace_file_environment_unavailable");
    return provider;
  }
}
