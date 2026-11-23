import { canonicalLocalWorkspaceRoots, isWithinLocalWorkspaceRoot } from "../execution/local-workspace-roots.js";
import { WorkspaceFileRootUnavailableError, WORKSPACE_FILE_LINK_CANDIDATE_ROOT_ID } from "./contracts.js";
import { workspaceRootGrant, type WorkspaceRootGrant } from "../execution/workspace-root-grant.js";
import { realpath } from "node:fs/promises";
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

function captureGrant(root: WorkspaceRootGrant, readRoots: () => readonly WorkspaceRootGrant[]) {
  return { root, check() {
    const current = canonicalLocalWorkspaceRoots(readRoots());
    if (!current.some(item => item.id === root.id && item.generation === root.generation && item.path === root.path))
      throw new WorkspaceFileRootUnavailableError();
  } };
}

export type LocalWorkspaceFileProviderTestHooks = WorkspaceFilesEngineTestHooks;

/** Local application-authority adapter over the shared filesystem engine. */
export class LocalWorkspaceFileProvider implements WorkspaceFileProvider {
  readonly #scope: RequestScope;
  readonly #environmentId: string;
  readonly #engine: WorkspaceFilesEngine;
  readonly #diffs = new WorkspaceDiffsEngine();

  constructor(readonly input: {
    readonly readWorkspaceRoots?: () => readonly WorkspaceRootGrant[];
    readonly readWorkspaceBinding?: (workspaceId: string, rootId?: string) => {authorityRootId?: string; authorityRevision: number} | undefined;
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
    const authority = this.#capture(root.canonicalPath, root.rootKind === "primary" || root.rootId ? root.workspaceId : undefined, root.rootId);
    await this.#engine.validateRoot(root.canonicalPath);
    authority?.check();
  }

  async discoverFileLinkRoot(
    scope: RequestScope,
    environmentId: string,
    absolutePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileDiscoveredLinkRoot | undefined> {
    if (
      !this.#supports(scope, environmentId) ||
      !path.isAbsolute(absolutePath)
    ) {
      return undefined;
    }
    signal?.throwIfAborted();
    let authority;
    const readRoots = this.input.readWorkspaceRoots;
    if (readRoots) {
      const candidates = canonicalLocalWorkspaceRoots(readRoots()).filter(root =>
        isWithinLocalWorkspaceRoot(absolutePath, root.path) || isWithinLocalWorkspaceRoot(absolutePath, root.declaredPath));
      if (!candidates.length) return undefined;
      const canonicalFile = await realpath(absolutePath).catch(() => undefined);
      signal?.throwIfAborted();
      const grant = canonicalFile && workspaceRootGrant(candidates, canonicalFile);
      if (!grant) return undefined;
      authority = captureGrant(grant, readRoots);
      authority.check();
    }
    const result = await this.#engine.discoverFileLinkRoot(absolutePath, signal);
    authority?.check();
    if (authority && result && !isWithinLocalWorkspaceRoot(result.canonicalPath, authority.root.path)) return undefined;
    signal?.throwIfAborted();
    return result;
  }

  async discoverLinkedWorktrees(
    scope: RequestScope,
    primaryRoot: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ) {
    if (primaryRoot.rootId !== "primary") {
      throw new Error("workspace_file_linked_worktree_primary_required");
    }
    const primary = this.#root(scope, primaryRoot);
    const candidates = this.input.readWorkspaceRoots && canonicalLocalWorkspaceRoots(this.input.readWorkspaceRoots());
    const result = await this.#engine.discoverLinkedWorktrees(primary, signal, candidates?.map(root => root.path));
    primary.assertCurrent?.();
    const current = this.input.readWorkspaceRoots && canonicalLocalWorkspaceRoots(this.input.readWorkspaceRoots());
    return candidates ? { ...result, worktrees: result.worktrees.filter(worktree => {
      const old = workspaceRootGrant(candidates, worktree.canonicalPath);
      return old && current?.some(root => root.id === old.id && root.generation === old.generation && root.path === old.path);
    }) } : result;
  }

  async removeLinkedWorktree(
    scope: RequestScope,
    target: Parameters<WorkspaceFileProvider["removeLinkedWorktree"]>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    if ((this.input.readWorkspaceRoots && !target.checkoutAuthority) ||
        target.linkedRoot.workspaceId !== target.primaryRoot.workspaceId ||
        !isWithinLocalWorkspaceRoot(target.linkedRoot.canonicalPath, target.canonicalCheckoutPath)) throw new WorkspaceFileRootUnavailableError();
    const primary = this.#root(scope, target.primaryRoot);
    const linked = this.#root(scope, target.linkedRoot);
    const checkout = this.#capture(target.canonicalCheckoutPath, undefined, undefined, target.checkoutAuthority);
    await this.#engine.removeLinkedWorktree(
      { ...primary, assertCurrent: () => { primary.assertCurrent?.(); linked.assertCurrent?.(); checkout?.check(); } },
      target,
      signal,
    );
  }

  async resolveFileLink(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    reference: WorkspaceFileLinkReference,
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    if (
      reference.kind === "root_relative" &&
      reference.rootId !== root.rootId
    ) {
      return undefined;
    }
    signal?.throwIfAborted();
    const bound = this.#root(scope, root);
    const result = await this.#engine.resolveFileLink(bound, reference);
    signal?.throwIfAborted();
    bound.assertCurrent?.();
    return result;
  }

  async list(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceFileRootListQuery,
    signal?: AbortSignal,
  ) {
    const bound = this.#root(scope, root);
    const result = await this.#engine.list(
      bound,
      query,
      signal,
    );
    bound.assertCurrent?.();
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
    const bound = this.#root(scope, root);
    const result = await this.#engine.listDirectory(
      bound,
      query,
      signal,
    );
    bound.assertCurrent?.();
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
    const bound = this.#root(scope, root);
    const result = await this.#engine.read(
      bound,
      relativePath,
      signal,
    );
    bound.assertCurrent?.();
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
    const bound = this.#root(scope, root);
    return this.#engine.withDownload(bound, input, async source => {
      bound.assertCurrent?.();
      const result = await operation({ ...source, stream: (write, signal) =>
        source.stream(chunk => { bound.assertCurrent?.(); return write(chunk); }, signal) });
      bound.assertCurrent?.();
      return result;
    }, signal);
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
    const bound = this.#root(scope, root);
    const result = await this.#engine.status(bound, signal);
    bound.assertCurrent?.();
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
    return this.#readDiff(scope, root, bound => this.#diffs.repositories(bound, signal));
  }

  diffRefCatalog(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceDiffRefCatalogQuery,
    signal?: AbortSignal,
  ) {
    return this.#readDiff(scope, root, bound => this.#diffs.refCatalog(bound, query, signal));
  }

  diffCreateComparison(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffComparisonCreateRequest,
    signal?: AbortSignal,
  ) {
    return this.#readDiff(scope, root, bound => this.#diffs.createComparison(bound, input, signal));
  }

  diffChangedFiles(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceDiffChangedFilesQuery,
    signal?: AbortSignal,
  ) {
    return this.#readDiff(scope, root, bound => this.#diffs.changedFiles(bound, query, signal));
  }

  diffPatch(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffFileRequest,
    signal?: AbortSignal,
  ) {
    return this.#readDiff(scope, root, bound => this.#diffs.patch(bound, input, signal));
  }

  diffFileContent(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffFileContentRequest,
    signal?: AbortSignal,
  ) {
    return this.#readDiff(scope, root, bound => this.#diffs.fileContent(bound, input, signal));
  }

  diffReviewIdentity(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewIdentityRequest,
    signal?: AbortSignal,
  ) {
    return this.#readDiff(scope, root, bound => this.#diffs.reviewIdentity(bound, input, signal));
  }

  diffValidateReviewAnchor(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewAnchorRequest,
    signal?: AbortSignal,
  ) {
    return this.#readDiff(scope, root, bound => this.#diffs.validateReviewAnchor(bound, input, signal));
  }

  diffValidateReviewedFile(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewedFileRequest,
    signal?: AbortSignal,
  ) {
    return this.#readDiff(scope, root, bound => this.#diffs.validateReviewedFile(bound, input, signal));
  }

  diffReviewRepositoryIdentity(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceDiffReviewRepositoryIdentityRequest,
    signal?: AbortSignal,
  ) {
    return this.#readDiff(scope, root, bound => this.#diffs.reviewRepositoryIdentity(bound, input, signal));
  }

  async watch(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    listener: () => void,
  ): Promise<WorkspaceFileWatchSubscription> {
    const bound = this.#root(scope, root);
    let revoke!: () => void;
    const failed = new Promise<void>(resolve => { revoke = resolve; });
    let subscription: WorkspaceFileWatchSubscription | undefined;
    const close = async () => {
      const active = subscription;
      subscription = undefined;
      await active?.close();
    };
    subscription = await this.#engine.watch(bound, () => {
      try { bound.assertCurrent?.(); } catch {
        void close().then(revoke, revoke);
        return;
      }
      listener();
    });
    try { bound.assertCurrent?.(); } catch (error) { await close(); throw error; }
    return { failed: Promise.race([subscription.failed, failed]), close };
  }

  close(): void {
    this.#engine.close();
  }

  #capture(path: string, workspaceId?: string, rootId?: string, expected?: {authorityRootId: string; authorityRevision: number}) {
    const roots = this.input.readWorkspaceRoots;
    if (!roots) return undefined;
    const requiresBinding = workspaceId !== undefined && rootId !== WORKSPACE_FILE_LINK_CANDIDATE_ROOT_ID;
    const binding = requiresBinding ? this.input.readWorkspaceBinding?.(workspaceId, rootId) : expected;
    const root = workspaceRootGrant(canonicalLocalWorkspaceRoots(roots()), path, binding);
    if (!root || (requiresBinding && !binding)) throw new WorkspaceFileRootUnavailableError();
    return captureGrant(root, roots);
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
    const authority = this.#capture(root.canonicalPath, root.workspaceId, root.rootId);
    return {
      ...(authority && { assertCurrent: authority.check }),
      canonicalPath: root.canonicalPath,
      operationKey: [scope.tenantId, scope.principalId, root.workspaceId, root.rootId, ...(authority ? [authority.root.id, authority.root.generation] : [])].join("\0"),
    };
  }

  #readDiff<T>(scope: RequestScope, root: WorkspaceFileRootTarget,
    read: (root: WorkspaceDiffsEngineRoot) => Promise<T>): Promise<T> {
    const bound = this.#root(scope, root);
    return read({ canonicalPath: bound.canonicalPath, durableRootKey: bound.operationKey,
      operationKey: bound.operationKey, rootId: root.rootId }).then(result => {
      bound.assertCurrent?.();
      return result;
    });
  }

}
