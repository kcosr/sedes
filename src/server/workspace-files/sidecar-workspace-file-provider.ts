import { isUncertainSidecarMutationError } from "../../internal/sidecar-protocol/operation-outcome.js";
import { randomUUID } from "node:crypto";
import { normalizedAbsolutePath } from "../../shared/absolute-path.js";
import { isWithinRemoteRoot } from "../execution/remote-path.js";
import {
  SidecarOperationError,
  SidecarProtocolDeliveryError,
  workspaceFilesDiscoverLinkRootOperation,
  workspaceFilesDiscoverLinkedWorktreesOperation,
  workspaceFilesRemoveLinkedWorktreeOperation,
  workspaceFilesDiffChangedFilesOperation,
  workspaceFilesDiffCreateComparisonOperation,
  workspaceFilesDiffFileContentOperation,
  workspaceFilesDiffPatchOperation,
  workspaceFilesDiffRefCatalogOperation,
  workspaceFilesDiffRepositoriesOperation,
  workspaceFilesDiffReviewIdentityOperation,
  workspaceFilesDiffValidateReviewAnchorOperation,
  workspaceFilesDiffValidateReviewedFileOperation,
  workspaceFilesDownloadCancelOperation,
  workspaceFilesDownloadStartOperation,
  workspaceFilesDiffReviewRepositoryIdentityOperation,
  workspaceFilesListOperation,
  workspaceFilesListDirectoryOperation,
  workspaceFilesReadOperation,
  workspaceFilesResolveLinkOperation,
  workspaceFilesRootCloseOperation,
  workspaceFilesRootOpenOperation,
  workspaceFilesRootValidateOperation,
  workspaceFilesStatusOperation,
  workspaceFilesWatchCloseOperation,
  workspaceFilesWatchOpenOperation,
  workspaceFilesWriteOperation,
  workspaceFilesMutationAcknowledgeOperation,
  workspaceFilesMutationInspectOperation,
  type SidecarOperationDefinition,
  type SidecarStreamDataRecord,
  type WorkspaceFilesDownloadTerminal,
} from "../../internal/sidecar-protocol/index.js";
import {
  type WorkspaceFileContentResult,
  type WorkspaceFileRootId,
} from "../../shared/protocol/workspace-files.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES } from "../../shared/workspace-file-limits.js";
import type { SidecarClientSession } from "../sidecar/sidecar-client-session.js";
import type { SidecarRuntimeOwner } from "../sidecar/sidecar-runtime.js";
import {
  WorkspaceFileAccessError,
  WorkspaceFileCursorInvalidError,
  WorkspaceFileDownloadTooLargeError,
  WorkspaceFileProviderUnavailableError,
  WorkspaceFileRevisionConflictError,
  WorkspaceFileRootUnavailableError,
  WorkspaceFileWriteOutcomeUnknownError,
  WorkspaceLinkedWorktreeRemovalOutcomeUnknownError,
  WorkspaceLinkedWorktreeDirtyError,
  WorkspaceLinkedWorktreeRemovalRejectedError,
  WORKSPACE_FILE_LINK_CANDIDATE_ROOT_ID,
  type WorkspaceFileDiscoveredLinkRoot,
  type WorkspaceFileDownloadSource,
  type WorkspaceFileProvider,
  type WorkspaceFileRootDirectoryQuery,
  type WorkspaceFileRootDownloadRequest,
  type WorkspaceFileRootListQuery,
  type WorkspaceFileRootTarget,
  type WorkspaceFileRootValidationTarget,
  type WorkspaceFileRootWriteRequest,
  type WorkspaceFileWatchSubscription,
} from "./contracts.js";

const WORKSPACE_FILE_DOWNLOAD_IDLE_MILLISECONDS = 2 * 60_000;

function combineAbortSignals(
  providerSignal?: AbortSignal,
  consumerSignal?: AbortSignal,
): AbortSignal | undefined {
  if (!providerSignal) return consumerSignal;
  if (!consumerSignal || consumerSignal === providerSignal)
    return providerSignal;
  return AbortSignal.any([providerSignal, consumerSignal]);
}

import { recoverSidecarOperation } from "../sidecar/sidecar-operation-recovery.js";

export class SidecarWorkspaceFileProvider implements WorkspaceFileProvider {
  readonly #scope: RequestScope;
  readonly #environmentId: string;
  readonly #policyRoots: readonly string[];
  readonly #runtime: SidecarRuntimeOwner<SidecarClientSession>;
  readonly #admissionIds = new Map<string, string>();
  readonly #validatedKinds = new Map<
    string,
    "primary" | "supplemental" | "linked_worktree" | "link_only"
  >();
  readonly #handles = new Map<number, Map<string, string>>();
  readonly #candidateRootUsers = new Map<string, number>();
  #closed = false;

  constructor(input: {
    readonly scope: RequestScope;
    readonly environmentId: string;
    readonly policyRoots: readonly string[];
    readonly runtime: SidecarRuntimeOwner<SidecarClientSession>;
  }) {
    if (
      !input.scope.tenantId ||
      !input.scope.principalId ||
      !input.environmentId ||
      input.policyRoots.length === 0 ||
      input.policyRoots.some(
        (root) =>
          !normalizedAbsolutePath(root),
      )
    ) {
      throw new Error("sidecar_workspace_file_provider_configuration_invalid");
    }
    this.#scope = Object.freeze({ ...input.scope });
    this.#environmentId = input.environmentId;
    this.#policyRoots = Object.freeze([...input.policyRoots]);
    this.#runtime = input.runtime;
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
    return this.#supports(scope, root.environmentId);
  }

  async validateRoot(
    scope: RequestScope,
    root: WorkspaceFileRootValidationTarget,
    signal?: AbortSignal,
  ): Promise<void> {
    this.#assert(scope, root.environmentId);
    const policyRootPath = this.#policyRoot(root.canonicalPath);
    if (!policyRootPath) throw new WorkspaceFileRootUnavailableError();
    let lease: Awaited<
      ReturnType<
        SidecarRuntimeOwner<SidecarClientSession>["acquireOperation"]
      >
    >;
    try {
      lease = await this.#runtime.acquireOperation(
        scope,
        root.environmentId,
        signal ?? new AbortController().signal,
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw classifyError(error);
    }
    try {
      await lease.session.call(
        workspaceFilesRootValidateOperation,
        {
          rootKind: root.rootKind,
          declaredPath: root.canonicalPath,
          policyRootPath,
        },
        ...sidecarCallOptions(signal),
      );
      this.#validatedKinds.set(
        rootKey(root.workspaceId, root.canonicalPath),
        root.rootKind,
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw classifyError(error);
    } finally {
      lease.release();
    }
  }

  async discoverFileLinkRoot(
    scope: RequestScope,
    environmentId: string,
    absolutePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileDiscoveredLinkRoot | undefined> {
    this.#assert(scope, environmentId);
    const policyRootPath = this.#policyRoot(absolutePath);
    if (!policyRootPath) return undefined;
    let lease: Awaited<
      ReturnType<
        SidecarRuntimeOwner<SidecarClientSession>["acquireOperation"]
      >
    >;
    try {
      lease = await this.#runtime.acquireOperation(
        scope,
        environmentId,
        signal ?? new AbortController().signal,
      );
    } catch (error) {
      throw classifyError(error);
    }
    try {
      const result = await lease.session.call(
        workspaceFilesDiscoverLinkRootOperation,
        { absolutePath, policyRootPath },
        ...sidecarCallOptions(signal),
      );
      return result.status === "discovered"
        ? {
            canonicalPath: result.declaredRootPath,
            relativePath: result.relativePath,
          }
        : undefined;
    } catch (error) {
      throw classifyError(error);
    } finally {
      lease.release();
    }
  }

  async discoverLinkedWorktrees(
    scope: RequestScope,
    primaryRoot: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ) {
    if (primaryRoot.rootId !== "primary") {
      throw new Error("workspace_file_linked_worktree_primary_required");
    }
    return await this.#operation(
      scope,
      primaryRoot,
      async (session, rootHandle, operationSignal) =>
        await session.call(
          workspaceFilesDiscoverLinkedWorktreesOperation,
          { rootHandle, policyRootPaths: [...this.#policyRoots] },
          ...sidecarCallOptions(operationSignal),
        ),
      signal,
    );
  }

  async removeLinkedWorktree(
    scope: RequestScope,
    target: Parameters<WorkspaceFileProvider["removeLinkedWorktree"]>[1],
    signal?: AbortSignal,
  ): Promise<void> {
    this.#assert(scope, target.primaryRoot.environmentId);
    const policyRootPath = this.#policyRoot(target.canonicalCheckoutPath);
    if (!policyRootPath) throw new WorkspaceFileRootUnavailableError();
    let lease: Awaited<
      ReturnType<
        SidecarRuntimeOwner<SidecarClientSession>["acquireOperation"]
      >
    >;
    try {
      lease = await this.#runtime.acquireOperation(
        scope,
        target.primaryRoot.environmentId,
        signal ?? new AbortController().signal,
      );
    } catch (error) {
      throw classifyError(error);
    }
    let rootHandle: string;
    try {
      rootHandle = await this.#rootHandle(
        lease,
        target.primaryRoot.workspaceId,
        target.primaryRoot.rootId,
        this.#rootKind(target.primaryRoot),
        target.primaryRoot.canonicalPath,
        signal,
      );
    } catch (error) {
      lease.release();
      throw classifyError(error);
    }
    const operationId = randomUUID();
    try {
      await lease.session
        .call(
          workspaceFilesRemoveLinkedWorktreeOperation,
          {
            operationId,
            rootHandle,
            canonicalCheckoutPath: target.canonicalCheckoutPath,
            policyRootPath,
            canonicalGitDir: target.canonicalGitDir,
            identityToken: target.identityToken,
          },
          ...sidecarCallOptions(signal),
        )
        .catch(
          async (error: unknown) =>
            await recoverSidecarOperation({
              error,
              operationId,
              resultSchema:
                workspaceFilesRemoveLinkedWorktreeOperation.responseSchema,
              inspect: workspaceFilesMutationInspectOperation,
              acquire: () =>
                this.#runtime.acquireAutomaticRecovery(
                  scope,
                  target.primaryRoot.environmentId,
                  new AbortController().signal,
                ),
            }),
        );
      await lease.session
        .call(workspaceFilesMutationAcknowledgeOperation, { operationId })
        .catch(() => undefined);
    } catch (error) {
      if (
        error instanceof SidecarOperationError &&
        !isUncertainSidecarMutationError(error)
      )
        await lease.session
          .call(workspaceFilesMutationAcknowledgeOperation, { operationId })
          .catch(() => undefined);
      if (isUncertainSidecarMutationError(error)) {
        throw new WorkspaceLinkedWorktreeRemovalOutcomeUnknownError();
      }
      if (delivery(error) === "not_sent") {
        throw new WorkspaceFileProviderUnavailableError();
      }
      throw classifyError(error);
    } finally {
      lease.release();
    }
  }

  async resolveFileLink(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    reference: Parameters<WorkspaceFileProvider["resolveFileLink"]>[2],
    signal?: AbortSignal,
  ) {
    if (
      reference.kind === "root_relative" &&
      reference.rootId !== root.rootId
    ) {
      return undefined;
    }
    const sidecarReference =
      reference.kind === "root_relative"
        ? { kind: "workspace_relative" as const, path: reference.path }
        : reference;
    return await this.#operation(scope, root, async (session, rootHandle, operationSignal) => {
      const result = await session.call(workspaceFilesResolveLinkOperation, {
        rootHandle,
        reference: sidecarReference,
      }, ...sidecarCallOptions(operationSignal));
      return result.status === "resolved" ? result.path : undefined;
    }, signal);
  }

  async list(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceFileRootListQuery,
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) => ({
        availability: "available" as const,
        rootId: root.rootId,
        ...(await session.call(
          workspaceFilesListOperation,
          {
            rootHandle,
            ...(query.cursor ? { cursor: query.cursor } : {}),
            pageSize: query.pageSize,
          },
          ...sidecarCallOptions(operationSignal),
        )),
      }),
      signal,
    );
  }

  async listDirectory(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: WorkspaceFileRootDirectoryQuery,
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) => ({
        availability: "available" as const,
        rootId: root.rootId,
        ...(await session.call(
          workspaceFilesListDirectoryOperation,
          {
            rootHandle,
            directory: query.directory,
            ...(query.cursor ? { cursor: query.cursor } : {}),
            pageSize: query.pageSize,
          },
          ...sidecarCallOptions(operationSignal),
        )),
      }),
      signal,
    );
  }

  async read(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    relativePath: string,
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) =>
        normalizedRead(
          root.rootId,
          await session.call(
            workspaceFilesReadOperation,
            { rootHandle, path: relativePath },
            ...sidecarCallOptions(operationSignal),
          ),
        ),
      signal,
    );
  }

  async withDownload<T>(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceFileRootDownloadRequest,
    operation: (source: WorkspaceFileDownloadSource) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.#assert(scope, root.environmentId);
    const operationSignal = signal ?? new AbortController().signal;
    let lease: Awaited<
      ReturnType<
        SidecarRuntimeOwner<SidecarClientSession>["acquireOperation"]
      >
    >;
    try {
      lease = await this.#runtime.acquireOperation(
        scope,
        root.environmentId,
        operationSignal,
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw classifyError(error);
    }
    const streamId = randomUUID();
    const initialCreditBytes = WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES * 2;
    const queue = new DownloadStreamQueue(initialCreditBytes);
    void lease.session.closed.then(
      () => queue.close(),
      () => queue.close(),
    );
    let registration:
      | ReturnType<
          SidecarClientSession["registerIncomingWorkspaceFileDownload"]
        >
      | undefined;
    let remoteStartAttempted = false;
    let complete = false;
    try {
      const rootHandle = await this.#rootHandle(
        lease,
        root.workspaceId,
        root.rootId,
        this.#rootKind(root),
        root.canonicalPath,
        signal,
      );
      registration = lease.session.registerIncomingWorkspaceFileDownload({
        streamId,
        initialCreditBytes,
        onData: (record) => queue.push(record),
        onTerminal: (terminal) => queue.terminal(terminal),
      });
      remoteStartAttempted = true;
      const metadata = await lease.session.call(
        workspaceFilesDownloadStartOperation,
        {
          rootHandle,
          path: input.path,
          expectedRevision: input.expectedRevision,
          streamId,
          initialCreditBytes,
        },
        ...sidecarCallOptions(signal),
      );
      let streamClaimed = false;
      const source: WorkspaceFileDownloadSource = Object.freeze({
        ...metadata,
        stream: async (
          write: (chunk: Uint8Array) => Promise<void>,
          streamSignal?: AbortSignal,
        ) => {
          if (streamClaimed)
            throw new Error("workspace_file_download_stream_claimed");
          streamClaimed = true;
          let deliveredBytes = 0;
          const effectiveSignal = combineAbortSignals(signal, streamSignal);
          for (;;) {
            effectiveSignal?.throwIfAborted();
            const item = await queue.take(
              effectiveSignal,
              WORKSPACE_FILE_DOWNLOAD_IDLE_MILLISECONDS,
            );
            if (item.kind === "terminal") {
              if (
                item.terminal.outcome !== "complete" ||
                item.terminal.sizeBytes !== metadata.sizeBytes ||
                item.terminal.revision !== metadata.revision ||
                deliveredBytes !== metadata.sizeBytes
              ) {
                throw classifyDownloadTerminal(item.terminal);
              }
              complete = true;
              return;
            }
            if (item.record.channel !== "data") {
              throw new WorkspaceFileProviderUnavailableError();
            }
            await write(item.record.bytes);
            deliveredBytes += item.record.bytes.byteLength;
            if (deliveredBytes > metadata.sizeBytes) {
              throw new WorkspaceFileProviderUnavailableError();
            }
            await registration!.addCredit(item.record.bytes.byteLength);
          }
        },
      });
      return await operation(source);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw classifyError(error);
    } finally {
      if (remoteStartAttempted && !complete) {
        await lease.session
          .call(workspaceFilesDownloadCancelOperation, { streamId })
          .catch(() => undefined);
      }
      registration?.unregister();
      queue.close();
      lease.release();
    }
  }

  async write(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    input: WorkspaceFileRootWriteRequest,
  ) {
    this.#assert(scope, root.environmentId);
    let lease: Awaited<
      ReturnType<
        SidecarRuntimeOwner<SidecarClientSession>["acquireOperation"]
      >
    >;
    try {
      lease = await this.#runtime.acquireOperation(
        scope,
        root.environmentId,
        new AbortController().signal,
      );
    } catch (error) {
      throw classifyError(error);
    }
    let rootHandle: string;
    try {
      rootHandle = await this.#rootHandle(
        lease,
        root.workspaceId,
        root.rootId,
        this.#rootKind(root),
        root.canonicalPath,
      );
    } catch (error) {
      lease.release();
      // Root admission is idempotent setup, not the user's write. Losing its
      // response makes the provider unavailable but cannot make file contents
      // ambiguous.
      throw classifyError(error);
    }
    const operationId = randomUUID();
    try {
      try {
        const result = {
          availability: "available" as const,
          rootId: root.rootId,
          ...(await lease.session
            .call(workspaceFilesWriteOperation, {
              operationId,
              rootHandle,
              path: input.path,
              content: input.content,
              expectedRevision: input.expectedRevision,
            })
            .catch(
              async (error: unknown) =>
                await recoverSidecarOperation({
                  error,
                  operationId,
                  resultSchema: workspaceFilesWriteOperation.responseSchema,
                  inspect: workspaceFilesMutationInspectOperation,
                  acquire: () =>
                    this.#runtime.acquireAutomaticRecovery(
                      scope,
                      root.environmentId,
                      new AbortController().signal,
                    ),
                }),
            )),
        };
        await lease.session
          .call(workspaceFilesMutationAcknowledgeOperation, { operationId })
          .catch(() => undefined);
        return result;
      } catch (error) {
        if (
          error instanceof SidecarOperationError &&
          !isUncertainSidecarMutationError(error)
        )
          await lease.session
            .call(workspaceFilesMutationAcknowledgeOperation, { operationId })
            .catch(() => undefined);
        if (isUncertainSidecarMutationError(error)) {
          throw new WorkspaceFileWriteOutcomeUnknownError();
        }
        if (delivery(error) === "not_sent") {
          throw new WorkspaceFileProviderUnavailableError();
        }
        throw classifyError(error);
      }
    } finally {
      lease.release();
    }
  }

  async status(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) => {
        const result = await session.call(
          workspaceFilesStatusOperation,
          { rootHandle },
          ...sidecarCallOptions(operationSignal),
        );
        return {
          availability: "available" as const,
          rootId: root.rootId,
          isGitRepository: result.isGitRepository,
          entries: result.entries.map((entry) => ({
            ...entry,
            rootId: root.rootId,
          })),
          truncated: result.truncated,
        };
      },
      signal,
    );
  }

  async diffRepositories(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) =>
        await session.call(
          workspaceFilesDiffRepositoriesOperation,
          { rootHandle },
          ...sidecarCallOptions(operationSignal),
        ),
      signal,
    );
  }

  async diffRefCatalog(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: Parameters<WorkspaceFileProvider["diffRefCatalog"]>[2],
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) =>
        await session.call(
          workspaceFilesDiffRefCatalogOperation,
          { rootHandle, ...query },
          ...sidecarCallOptions(operationSignal),
        ),
      signal,
    );
  }

  async diffCreateComparison(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    request: Parameters<WorkspaceFileProvider["diffCreateComparison"]>[2],
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) =>
        await session.call(
          workspaceFilesDiffCreateComparisonOperation,
          { rootHandle, ...request },
          ...sidecarCallOptions(operationSignal),
        ),
      signal,
    );
  }

  async diffChangedFiles(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    query: Parameters<WorkspaceFileProvider["diffChangedFiles"]>[2],
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) =>
        await session.call(
          workspaceFilesDiffChangedFilesOperation,
          { rootHandle, ...query },
          ...sidecarCallOptions(operationSignal),
        ),
      signal,
    );
  }

  async diffPatch(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    request: Parameters<WorkspaceFileProvider["diffPatch"]>[2],
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) =>
        await session.call(
          workspaceFilesDiffPatchOperation,
          { rootHandle, ...request },
          ...sidecarCallOptions(operationSignal),
        ),
      signal,
    );
  }

  async diffFileContent(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    request: Parameters<WorkspaceFileProvider["diffFileContent"]>[2],
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) =>
        await session.call(
          workspaceFilesDiffFileContentOperation,
          { rootHandle, ...request },
          ...sidecarCallOptions(operationSignal),
        ),
      signal,
    );
  }

  async diffReviewIdentity(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    request: Parameters<WorkspaceFileProvider["diffReviewIdentity"]>[2],
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) =>
        await session.call(
          workspaceFilesDiffReviewIdentityOperation,
          { rootHandle, ...request },
          ...sidecarCallOptions(operationSignal),
        ),
      signal,
    );
  }

  async diffValidateReviewAnchor(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    request: Parameters<WorkspaceFileProvider["diffValidateReviewAnchor"]>[2],
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) =>
        await session.call(
          workspaceFilesDiffValidateReviewAnchorOperation,
          { rootHandle, ...request },
          ...sidecarCallOptions(operationSignal),
        ),
      signal,
    );
  }

  async diffValidateReviewedFile(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    request: Parameters<WorkspaceFileProvider["diffValidateReviewedFile"]>[2],
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) =>
        await session.call(
          workspaceFilesDiffValidateReviewedFileOperation,
          { rootHandle, ...request },
          ...sidecarCallOptions(operationSignal),
        ),
      signal,
    );
  }

  async diffReviewRepositoryIdentity(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    request: Parameters<
      WorkspaceFileProvider["diffReviewRepositoryIdentity"]
    >[2],
    signal?: AbortSignal,
  ) {
    return await this.#operation(
      scope,
      root,
      async (session, rootHandle, operationSignal) =>
        await session.call(
          workspaceFilesDiffReviewRepositoryIdentityOperation,
          {
            rootHandle,
            ...request,
          },
          ...sidecarCallOptions(operationSignal),
        ),
      signal,
    );
  }

  async watch(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    listener: () => void,
  ): Promise<WorkspaceFileWatchSubscription> {
    this.#assert(scope, root.environmentId);
    const controller = new AbortController();
    const failure = deferred<void>();
    let closed = false;
    let current: RemoteWatch | undefined;
    const releaseCurrent = () => {
      const active = current;
      current = undefined;
      if (!active) return;
      active.removeInvalidation();
      active.removeFailure();
      active.lease.release();
    };
    const open = async (conservativeInvalidation: boolean): Promise<void> => {
      const lease = await this.#runtime.acquireWatch(
        scope,
        root.environmentId,
        controller.signal,
      );
      try {
        const rootHandle = await this.#rootHandle(
          lease,
          root.workspaceId,
          root.rootId,
          this.#rootKind(root),
          root.canonicalPath,
        );
        const { subscriptionHandle } = await lease.session.call(
          workspaceFilesWatchOpenOperation,
          { rootHandle },
          { signal: controller.signal },
        );
        if (closed || this.#closed) {
          throw new WorkspaceFileProviderUnavailableError();
        }
        const removeInvalidation = lease.session.registerInvalidation(
          subscriptionHandle,
          listener,
        );
        let remote!: RemoteWatch;
        let removeFailure: () => void;
        try {
          removeFailure = lease.session.registerWatchFailure(
            subscriptionHandle,
            () => {
              if (current !== remote || closed || this.#closed) return;
              releaseCurrent();
              void recover();
            },
          );
        } catch (error) {
          removeInvalidation();
          throw error;
        }
        remote = {
          lease,
          subscriptionHandle,
          removeInvalidation,
          removeFailure,
        };
        current = remote;
        void lease.session.closed.then(() => {
          if (current !== remote || closed || this.#closed) return;
          releaseCurrent();
          void recover();
        });
        if (conservativeInvalidation) listener();
      } catch (error) {
        lease.release();
        throw error;
      }
    };
    const recover = async (): Promise<void> => {
      const delays = [0, 250, 1_000];
      for (const delayMilliseconds of delays) {
        if (closed || this.#closed) return;
        if (delayMilliseconds > 0) {
          await abortableDelay(delayMilliseconds, controller.signal).catch(
            () => undefined,
          );
        }
        if (closed || this.#closed) return;
        try {
          await open(true);
          return;
        } catch {
          // A bounded later attempt starts a fresh carrier generation and root.
        }
      }
      if (!closed && !this.#closed) failure.resolve();
    };
    try {
      await open(false);
    } catch (error) {
      controller.abort();
      releaseCurrent();
      throw classifyError(error);
    }
    return {
      failed: failure.promise,
      close: () => {
        if (closed) return;
        closed = true;
        controller.abort();
        const active = current;
        releaseCurrent();
        if (active) {
          void active.lease.session
            .call(workspaceFilesWatchCloseOperation, {
              subscriptionHandle: active.subscriptionHandle,
            })
            .catch(() => undefined);
        }
      },
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#handles.clear();
    // The environment-scoped sidecar runtime may be shared by independently
    // enabled capabilities. Production owns its lifecycle; this provider owns
    // only Files handles and watches.
  }

  async #operation<T>(
    scope: RequestScope,
    root: WorkspaceFileRootTarget,
    operation: (
      session: SidecarClientSession,
      rootHandle: string,
      signal: AbortSignal | undefined,
    ) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.#assert(scope, root.environmentId);
    let lease: Awaited<
      ReturnType<
        SidecarRuntimeOwner<SidecarClientSession>["acquireOperation"]
      >
    >;
    try {
      lease = await this.#runtime.acquireOperation(
        scope,
        root.environmentId,
        signal ?? new AbortController().signal,
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw classifyError(error);
    }
    const rootKind = this.#rootKind(root);
    const candidateKey = root.rootId === WORKSPACE_FILE_LINK_CANDIDATE_ROOT_ID
      ? rootHandleKey(root.workspaceId, root.rootId, rootKind, root.canonicalPath,
        this.#policyRoot(root.canonicalPath))
      : undefined;
    if (candidateKey) {
      this.#candidateRootUsers.set(candidateKey, (this.#candidateRootUsers.get(candidateKey) ?? 0) + 1);
    }
    try {
      const rootHandle = await this.#rootHandle(
        lease,
        root.workspaceId,
        root.rootId,
        rootKind,
        root.canonicalPath,
        signal,
      );
      return await operation(lease.session, rootHandle, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw classifyError(error);
    } finally {
      if (candidateKey) this.#releaseCandidateRoot(lease, candidateKey);
      lease.release();
    }
  }

  // Candidate paths vary per link or capture; keeping their handles would
  // exhaust the sidecar session's bounded root table.
  #releaseCandidateRoot(
    lease: {
      readonly session: SidecarClientSession;
      readonly carrierGeneration: number;
    },
    key: string,
  ): void {
    const users = (this.#candidateRootUsers.get(key) ?? 1) - 1;
    if (users > 0) {
      this.#candidateRootUsers.set(key, users);
      return;
    }
    this.#candidateRootUsers.delete(key);
    const generation = this.#handles.get(lease.carrierGeneration);
    const rootHandle = generation?.get(key);
    // An interrupted open may still have admitted a root; keeping its
    // admission lets the next use of this key recover and close it.
    if (!rootHandle) return;
    generation!.delete(key);
    this.#admissionIds.delete(key);
    // Cancellation and lease release never wait for the close.
    void lease.session
      .call(workspaceFilesRootCloseOperation, { rootHandle })
      .catch(() => undefined);
  }

  async #rootHandle(
    lease: {
      readonly session: SidecarClientSession;
      readonly carrierGeneration: number;
    },
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    rootKind: "primary" | "supplemental" | "linked_worktree" | "link_only",
    canonicalPath: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const policyRootPath = this.#policyRoot(canonicalPath);
    if (!policyRootPath) throw new WorkspaceFileRootUnavailableError();
    const key = rootHandleKey(workspaceId, rootId, rootKind, canonicalPath, policyRootPath);
    let generation = this.#handles.get(lease.carrierGeneration);
    if (!generation) {
      generation = new Map();
      // Root handles are session authority. Retain only the live generation;
      // validateRoot may warm it, but replacement revokes the whole cache.
      this.#handles.clear();
      this.#handles.set(lease.carrierGeneration, generation);
    }
    const existing = generation.get(key);
    if (existing) return existing;
    let admissionId = this.#admissionIds.get(key);
    if (!admissionId) {
      admissionId = randomUUID();
      this.#admissionIds.set(key, admissionId);
    }
    const { rootHandle } = await lease.session.call(
      workspaceFilesRootOpenOperation,
      {
        admissionId,
        rootId,
        rootKind,
        declaredPath: canonicalPath,
        policyRootPath,
      },
      ...sidecarCallOptions(signal),
    );
    generation.set(key, rootHandle);
    return rootHandle;
  }

  #rootKind(root: WorkspaceFileRootTarget) {
    return (
      this.#validatedKinds.get(rootKey(root.workspaceId, root.canonicalPath)) ??
      (root.rootId === "primary" ? "primary" : "supplemental")
    );
  }

  #policyRoot(candidate: string): string | undefined {
    return this.#policyRoots
      .filter((root) => isWithin(root, candidate))
      .sort((left, right) => right.length - left.length)[0];
  }

  #supports(scope: RequestScope, environmentId: string): boolean {
    return (
      !this.#closed &&
      scope.tenantId === this.#scope.tenantId &&
      scope.principalId === this.#scope.principalId &&
      environmentId === this.#environmentId
    );
  }

  #assert(scope: RequestScope, environmentId: string): void {
    if (!this.#supports(scope, environmentId)) {
      throw new WorkspaceFileProviderUnavailableError();
    }
  }
}

function rootHandleKey(
  workspaceId: string,
  rootId: WorkspaceFileRootId,
  rootKind: "primary" | "supplemental" | "linked_worktree" | "link_only",
  canonicalPath: string,
  policyRootPath: string | undefined,
): string {
  return `${workspaceId}\0${rootId}\0${rootKind}\0${canonicalPath}\0${policyRootPath}`;
}

function classifyError(error: unknown): Error {
  if (
    error instanceof WorkspaceFileAccessError ||
    error instanceof WorkspaceFileCursorInvalidError ||
    error instanceof WorkspaceFileDownloadTooLargeError ||
    error instanceof WorkspaceFileRevisionConflictError ||
    error instanceof WorkspaceFileRootUnavailableError ||
    error instanceof WorkspaceFileWriteOutcomeUnknownError ||
    error instanceof WorkspaceLinkedWorktreeRemovalOutcomeUnknownError ||
    error instanceof WorkspaceLinkedWorktreeDirtyError ||
    error instanceof WorkspaceLinkedWorktreeRemovalRejectedError ||
    error instanceof WorkspaceFileProviderUnavailableError
  ) {
    return error;
  }
  if (error instanceof SidecarOperationError) {
    if (error.code === "workspace_file_not_found")
      return new WorkspaceFileAccessError();
    if (error.code === "workspace_file_list_cursor_invalid")
      return new WorkspaceFileCursorInvalidError();
    if (error.code === "workspace_file_revision_conflict")
      return new WorkspaceFileRevisionConflictError();
    if (error.code === "workspace_file_download_too_large")
      return new WorkspaceFileDownloadTooLargeError();
    if (
      error.code === "workspace_file_root_unavailable" ||
      error.code === "sidecar_root_handle_invalid"
    )
      return new WorkspaceFileRootUnavailableError();
    if (error.code === "workspace_linked_worktree_dirty")
      return new WorkspaceLinkedWorktreeDirtyError();
    if (error.code === "workspace_linked_worktree_removal_rejected")
      return new WorkspaceLinkedWorktreeRemovalRejectedError();
  }
  return new WorkspaceFileProviderUnavailableError();
}

function classifyDownloadTerminal(
  terminal: WorkspaceFilesDownloadTerminal,
): Error {
  if (terminal.outcome === "complete") {
    return new WorkspaceFileProviderUnavailableError();
  }
  if (terminal.code === "workspace_file_not_found") {
    return new WorkspaceFileAccessError();
  }
  if (terminal.code === "workspace_file_revision_conflict") {
    return new WorkspaceFileRevisionConflictError();
  }
  if (terminal.code === "workspace_file_download_too_large") {
    return new WorkspaceFileDownloadTooLargeError();
  }
  return new WorkspaceFileProviderUnavailableError();
}

type DownloadQueueItem =
  | Readonly<{ kind: "data"; record: SidecarStreamDataRecord }>
  | Readonly<{
      kind: "terminal";
      terminal: WorkspaceFilesDownloadTerminal;
    }>;

class DownloadStreamQueue {
  readonly #maximumBytes: number;
  readonly #items: DownloadQueueItem[] = [];
  #queuedBytes = 0;
  #waiter:
    | {
        readonly resolve: (item: DownloadQueueItem) => void;
        readonly reject: (error: unknown) => void;
        readonly signal?: AbortSignal;
        readonly abort?: () => void;
        readonly timer: NodeJS.Timeout;
      }
    | undefined;
  #closed = false;

  constructor(maximumBytes: number) {
    this.#maximumBytes = maximumBytes;
  }

  push(record: SidecarStreamDataRecord): void {
    if (this.#closed) throw new Error("workspace_file_download_queue_closed");
    const item = Object.freeze({ kind: "data" as const, record });
    if (this.#waiter) {
      this.#settleWaiter(item);
      return;
    }
    if (this.#queuedBytes + record.bytes.byteLength > this.#maximumBytes) {
      throw new Error("workspace_file_download_queue_limit");
    }
    this.#queuedBytes += record.bytes.byteLength;
    this.#items.push(item);
  }

  terminal(terminal: WorkspaceFilesDownloadTerminal): void {
    if (this.#closed) return;
    const item = Object.freeze({ kind: "terminal" as const, terminal });
    if (this.#waiter) {
      this.#settleWaiter(item);
      return;
    }
    this.#items.push(item);
  }

  async take(
    signal: AbortSignal | undefined,
    idleMilliseconds: number,
  ): Promise<DownloadQueueItem> {
    if (signal?.aborted) throw signal.reason;
    const item = this.#items.shift();
    if (item) {
      if (item.kind === "data") {
        this.#queuedBytes -= item.record.bytes.byteLength;
      }
      return item;
    }
    if (this.#closed) {
      throw new WorkspaceFileProviderUnavailableError();
    }
    if (this.#waiter) throw new Error("workspace_file_download_queue_claimed");
    return await new Promise<DownloadQueueItem>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.#waiter?.resolve !== resolve) return;
        this.#waiter = undefined;
        if (abort) signal!.removeEventListener("abort", abort);
        reject(new WorkspaceFileProviderUnavailableError());
      }, idleMilliseconds);
      timer.unref();
      const abort = signal
        ? () => {
            if (this.#waiter?.resolve !== resolve) return;
            this.#waiter = undefined;
            clearTimeout(timer);
            reject(signal.reason);
          }
        : undefined;
      this.#waiter = {
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        ...(abort ? { abort } : {}),
        timer,
      };
      signal?.addEventListener("abort", abort!, { once: true });
      if (signal?.aborted) abort!();
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#items.length = 0;
    this.#queuedBytes = 0;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    if (waiter.abort) {
      waiter.signal!.removeEventListener("abort", waiter.abort);
    }
    waiter.reject(new WorkspaceFileProviderUnavailableError());
  }

  #settleWaiter(item: DownloadQueueItem): void {
    const waiter = this.#waiter!;
    this.#waiter = undefined;
    clearTimeout(waiter.timer);
    if (waiter.abort) {
      waiter.signal!.removeEventListener("abort", waiter.abort);
    }
    waiter.resolve(item);
  }
}

function normalizedRead(
  rootId: WorkspaceFileRootId,
  result: OperationResponse<typeof workspaceFilesReadOperation>,
): WorkspaceFileContentResult {
  const common = {
    availability: "available" as const,
    rootId,
    path: result.path,
    sizeBytes: result.sizeBytes,
    revision: result.revision,
    editable: result.editable,
  };
  if (result.contentKind === "text") {
    return {
      ...common,
      contentKind: "text",
      content: result.content,
      ...(result.truncation
        ? { truncation: { truncated: true, ...result.truncation } }
        : {}),
    };
  }
  if (result.contentKind === "binary") {
    return {
      ...common,
      contentKind: "binary",
      content: "",
      editable: false,
      ...(result.truncation
        ? { truncation: { truncated: true, ...result.truncation } }
        : {}),
    };
  }
  return result.previewState === "available"
    ? {
        ...common,
        contentKind: "image",
        previewState: "available",
        mediaType: result.mediaType,
        contentEncoding: "base64",
        content: result.contentBase64,
        editable: false,
      }
    : {
        ...common,
        contentKind: "image",
        previewState: "too_large",
        mediaType: result.mediaType,
        editable: false,
      };
}

type OperationResponse<Definition> =
  Definition extends SidecarOperationDefinition<infer _Request, infer Response>
    ? Response
    : never;

interface RemoteWatch {
  readonly lease: Awaited<
    ReturnType<SidecarRuntimeOwner<SidecarClientSession>["acquireWatch"]>
  >;
  readonly subscriptionHandle: string;
  readonly removeInvalidation: () => void;
  readonly removeFailure: () => void;
}

function rootKey(workspaceId: string, canonicalPath: string): string {
  return `${workspaceId}\0${canonicalPath}`;
}

function isWithin(root: string, candidate: string): boolean {
  return isWithinRemoteRoot(candidate, root);
}

function delivery(
  error: unknown,
): "not_sent" | "sent_outcome_unknown" | undefined {
  if (error instanceof SidecarProtocolDeliveryError) return error.delivery;
  if (typeof error !== "object" || error === null || !("delivery" in error)) {
    return undefined;
  }
  return error.delivery === "not_sent" ||
    error.delivery === "sent_outcome_unknown"
    ? error.delivery
    : undefined;
}

function sidecarCallOptions(
  signal: AbortSignal | undefined,
): [] | [{ readonly signal: AbortSignal }] {
  return signal ? [{ signal }] : [];
}

function deferred<T>() {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise as (value?: T | PromiseLike<T>) => void;
  });
  return { promise, resolve };
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    timer.unref();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    function finish() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}
