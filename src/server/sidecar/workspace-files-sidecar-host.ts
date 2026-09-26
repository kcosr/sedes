import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  SidecarOperationError,
  workspaceFilesDownloadTerminalSchema,
  workspaceFilesMutationInspectOperation,
  type SidecarOutboundStream,
  type WorkspaceFilesDownloadTerminal,
  type WorkspaceFilesV8Handlers,
} from "../../internal/sidecar-protocol/index.js";
import {
  WorkspaceFileAccessError,
  WorkspaceFileCursorInvalidError,
  WorkspaceFileDownloadTooLargeError,
  WorkspaceFileRevisionConflictError,
  WorkspaceFileRootUnavailableError,
  WorkspaceLinkedWorktreeDirtyError,
  WorkspaceLinkedWorktreeRemovalRejectedError,
  type WorkspaceFileDownloadSource,
  type WorkspaceFileWatchSubscription,
} from "../workspace-files/contracts.js";
import {
  WorkspaceFilesEngine,
  type WorkspaceFilesEngineRoot,
} from "../workspace-files/workspace-files-engine.js";
import {
  WorkspaceDiffsEngine,
  type WorkspaceDiffsEngineRoot,
} from "../workspace-files/workspace-diffs-engine.js";
import type { WorkspaceFileRootId } from "../../shared/protocol/workspace-files.js";

import { SidecarOperationReceipts } from "./sidecar-operation-receipts.js";

interface AdmittedRoot {
  readonly admissionId: string;
  readonly rootId: WorkspaceFileRootId;
  readonly rootKind:
    "primary" | "supplemental" | "linked_worktree" | "link_only";
  readonly declaredPath: string;
  readonly policyRootPath: string;
  readonly engineRoot: WorkspaceFilesEngineRoot & WorkspaceDiffsEngineRoot;
}

interface ActiveWatch {
  readonly rootHandle: string;
  readonly subscription: WorkspaceFileWatchSubscription;
}

interface ActiveDownload {
  readonly controller: AbortController;
  readonly done: Promise<void>;
}

/** Sidecar-only authority adapter over the shared Files engine. */
export class WorkspaceFilesSidecarHost {
  readonly handlers: WorkspaceFilesV8Handlers;
  readonly #sessionNonce: string;
  readonly #engine: WorkspaceFilesEngine;
  readonly #diffsEngine: WorkspaceDiffsEngine;
  readonly #sendInvalidation: (subscriptionHandle: string) => Promise<void>;
  readonly #sendWatchFailure: (subscriptionHandle: string) => Promise<void>;
  readonly #openDownloadStream: (input: {
    readonly streamId: string;
    readonly initialCreditBytes: number;
  }) => SidecarOutboundStream;
  readonly #onDownloadCleanupFailure: () => void;
  readonly #roots = new Map<string, AdmittedRoot>();
  readonly #admissions = new Map<string, string>();
  readonly #watches = new Map<string, ActiveWatch>();
  readonly #downloads = new Map<string, ActiveDownload>();
  readonly #receipts = new SidecarOperationReceipts();
  readonly #opening = new Map<
    string,
    {
      readonly key: string;
      readonly promise: Promise<{ readonly rootHandle: string }>;
      waiters: number;
    }
  >();
  readonly #captureAdmission: () => () => void;
  #attachmentEpoch = 0;
  #transferRevision = 0;
  #closed = false;

  /** Watches are attachment-local hints; clients refresh when opening new ones. */
  detach(): void {
    this.#attachmentEpoch += 1;
    for (const watch of this.#watches.values()) watch.subscription.close();
    this.#watches.clear();
    this.#roots.clear();
    this.#admissions.clear();
    this.#opening.clear();
    for (const download of this.#downloads.values()) {
      download.controller.abort(new Error("sidecar_upstream_detached"));
    }
  }

  snapshot(): {
    revision: string;
    state: "idle" | "active";
    blockers: ("transfer_in_progress" | "active_work" | "unsettled_outcome")[];
  } {
    const receipts = this.#receipts.snapshot();
    return {
      revision: `${receipts.revision}/${this.#transferRevision}`,
      state: this.#downloads.size ? "active" : receipts.state,
      blockers: [
        ...receipts.blockers,
        ...(this.#downloads.size ? ["transfer_in_progress" as const] : []),
      ],
    };
  }

  abandonmentEvidence() { return this.#receipts.abandonmentEvidence(); }
  async stop(force = false): Promise<void> {
    this.detach();
    await Promise.all(
      [...this.#downloads.values()].map((download) => download.done),
    );
    await this.#receipts.stop(force);
    this.close();
  }

  #admission(): () => void {
    const epoch = this.#attachmentEpoch;
    const assertExternal = this.#captureAdmission();
    return () => {
      if (epoch !== this.#attachmentEpoch)
        throw new SidecarOperationError("sidecar_controller_stale");
      assertExternal();
    };
  }

  constructor(input: {
    readonly sessionNonce: string;
    readonly captureAdmission?: () => () => void;
    readonly engine?: WorkspaceFilesEngine;
    readonly diffsEngine?: WorkspaceDiffsEngine;
    readonly sendInvalidation: (subscriptionHandle: string) => Promise<void>;
    readonly sendWatchFailure: (subscriptionHandle: string) => Promise<void>;
    readonly openDownloadStream: (input: {
      readonly streamId: string;
      readonly initialCreditBytes: number;
    }) => SidecarOutboundStream;
    readonly onDownloadCleanupFailure: () => void;
  }) {
    if (input.sessionNonce.length < 32 || input.sessionNonce.length > 160) {
      throw new Error("sidecar_session_nonce_invalid");
    }
    this.#sessionNonce = input.sessionNonce;
    this.#captureAdmission = input.captureAdmission ?? (() => () => undefined);
    this.#engine = input.engine ?? new WorkspaceFilesEngine();
    this.#diffsEngine = input.diffsEngine ?? new WorkspaceDiffsEngine();
    this.#sendInvalidation = input.sendInvalidation;
    this.#sendWatchFailure = input.sendWatchFailure;
    this.#openDownloadStream = input.openDownloadStream;
    this.#onDownloadCleanupFailure = input.onDownloadCleanupFailure;
    this.handlers = {
      mutationList: () => ({ operationIds: [...this.#receipts.ids()] }),
      mutationInspect: ({ operationId }) =>
        workspaceFilesMutationInspectOperation.responseSchema.parse(
          this.#receipts.inspect(operationId),
        ),
      mutationAcknowledge: ({ operationId }) => ({
        acknowledged: this.#receipts.acknowledge(operationId),
      }),
      rootValidate: (request) => this.#guard(() => this.#rootValidate(request)),
      rootOpen: (request, context) =>
        this.#guard(() => this.#rootOpen(request, context.signal)),
      rootClose: (request) =>
        this.#guard(() => this.#rootClose(request.rootHandle)),
      list: (request, context) =>
        this.#guard(async () => {
          const result = await this.#engine.list(
            this.#root(request.rootHandle),
            {
              ...(request.cursor ? { cursor: request.cursor } : {}),
              pageSize: request.pageSize,
            },
            context.signal,
          );
          return result;
        }),
      listDirectory: (request, context) =>
        this.#guard(() =>
          this.#engine.listDirectory(
            this.#root(request.rootHandle),
            {
              directory: request.directory,
              ...(request.cursor ? { cursor: request.cursor } : {}),
              pageSize: request.pageSize,
            },
            context.signal,
          ),
        ),
      read: (request, context) =>
        this.#guard(async () =>
          protocolReadResult(
            await this.#engine.read(
              this.#root(request.rootHandle),
              request.path,
              context.signal,
            ),
          ),
        ),
      downloadStart: (request, context) =>
        this.#guard(() => this.#downloadStart(request, context.signal)),
      downloadCancel: (request) =>
        this.#guard(() => this.#downloadCancel(request.streamId)),
      write: (request) =>
        this.#receipts.run(
          request.operationId,
          { operation: "write", ...request },
          () =>
            this.#guard(() =>
              this.#engine.write(this.#root(request.rootHandle), {
                path: request.path,
                content: request.content,
                expectedRevision: request.expectedRevision,
              }),
            ),
        ),
      status: (request, context) =>
        this.#guard(
          async () =>
            await this.#engine.status(
              this.#root(request.rootHandle),
              context.signal,
            ),
        ),
      resolveLink: (request) =>
        this.#guard(async () => {
          const resolved = await this.#engine.resolveFileLink(
            this.#root(request.rootHandle),
            request.reference,
          );
          return resolved
            ? { status: "resolved" as const, path: resolved }
            : { status: "not_found" as const };
        }),
      discoverLinkRoot: (request, context) =>
        this.#guard(() =>
          this.#discoverLinkRoot(request.absolutePath, request.policyRootPath, context.signal),
        ),
      discoverLinkedWorktrees: (request, context) =>
        this.#guard(() =>
          this.#discoverLinkedWorktrees(
            request.rootHandle,
            request.policyRootPaths,
            context.signal,
          ),
        ),
      removeLinkedWorktree: (request, context) =>
        this.#receipts.run(
          request.operationId,
          { operation: "remove", ...request },
          () =>
            this.#guard(async () => {
              const assertAdmission = this.#admission();
              assertAdmission();
              const policyRoot = await canonicalDirectory(
                request.policyRootPath,
              );
              assertAdmission();
              if (
                policyRoot !== request.policyRootPath ||
                !isWithin(policyRoot, request.canonicalCheckoutPath)
              ) {
                throw new WorkspaceFileRootUnavailableError();
              }
              await this.#engine.removeLinkedWorktree(
                this.#root(request.rootHandle),
                request,
                context.signal,
              );
              return { removed: true as const };
            }),
        ),
      watchOpen: (request) =>
        this.#guard(() => this.#watchOpen(request.rootHandle)),
      watchClose: (request) =>
        this.#guard(() => this.#watchClose(request.subscriptionHandle)),
      diffRepositories: (request, context) =>
        this.#guard(() =>
          this.#diffsEngine.repositories(
            this.#root(request.rootHandle),
            context.signal,
          ),
        ),
      diffRefCatalog: ({ rootHandle, ...query }, context) =>
        this.#guard(() =>
          this.#diffsEngine.refCatalog(
            this.#root(rootHandle),
            query,
            context.signal,
          ),
        ),
      diffCreateComparison: ({ rootHandle, ...request }, context) =>
        this.#guard(() =>
          this.#diffsEngine.createComparison(
            this.#root(rootHandle),
            request,
            context.signal,
          ),
        ),
      diffChangedFiles: ({ rootHandle, ...query }, context) =>
        this.#guard(() =>
          this.#diffsEngine.changedFiles(
            this.#root(rootHandle),
            query,
            context.signal,
          ),
        ),
      diffPatch: ({ rootHandle, ...request }, context) =>
        this.#guard(() =>
          this.#diffsEngine.patch(
            this.#root(rootHandle),
            request,
            context.signal,
          ),
        ),
      diffFileContent: ({ rootHandle, ...request }, context) =>
        this.#guard(() =>
          this.#diffsEngine.fileContent(
            this.#root(rootHandle),
            request,
            context.signal,
          ),
        ),
      diffReviewIdentity: ({ rootHandle, ...request }, context) =>
        this.#guard(() =>
          this.#diffsEngine.reviewIdentity(
            this.#root(rootHandle),
            request,
            context.signal,
          ),
        ),
      diffValidateReviewAnchor: ({ rootHandle, ...request }, context) =>
        this.#guard(() =>
          this.#diffsEngine.validateReviewAnchor(
            this.#root(rootHandle),
            request,
            context.signal,
          ),
        ),
      diffValidateReviewedFile: ({ rootHandle, ...request }, context) =>
        this.#guard(() =>
          this.#diffsEngine.validateReviewedFile(
            this.#root(rootHandle),
            request,
            context.signal,
          ),
        ),
      diffReviewRepositoryIdentity: ({ rootHandle, ...request }, context) =>
        this.#guard(() =>
          this.#diffsEngine.reviewRepositoryIdentity(
            this.#root(rootHandle),
            request,
            context.signal,
          ),
        ),
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const watch of this.#watches.values()) watch.subscription.close();
    for (const download of this.#downloads.values()) {
      download.controller.abort(new Error("sidecar_session_closed"));
    }
    this.#watches.clear();
    this.#downloads.clear();
    this.#roots.clear();
    this.#admissions.clear();
    this.#opening.clear();
    this.#engine.close();
  }

  async #rootValidate(request: {
    readonly rootKind:
      "primary" | "supplemental" | "linked_worktree" | "link_only";
    readonly declaredPath: string;
    readonly policyRootPath: string;
  }): Promise<{ readonly validated: true }> {
    this.#assertOpen();
    if (!isWithin(request.policyRootPath, request.declaredPath)) {
      throw new WorkspaceFileRootUnavailableError();
    }
    const [canonicalPolicy, canonicalRoot] = await Promise.all([
      canonicalDirectory(request.policyRootPath),
      canonicalDirectory(request.declaredPath),
    ]);
    if (
      canonicalRoot !== request.declaredPath ||
      !isWithin(canonicalPolicy, canonicalRoot)
    ) {
      throw new WorkspaceFileRootUnavailableError();
    }
    await this.#engine.validateRoot(request.declaredPath);
    return { validated: true };
  }

  async #downloadStart(
    request: {
      readonly rootHandle: string;
      readonly path: string;
      readonly expectedRevision: string;
      readonly streamId: string;
      readonly initialCreditBytes: number;
    },
    requestSignal: AbortSignal,
  ): Promise<{
    readonly path: string;
    readonly fileName: string;
    readonly sizeBytes: number;
    readonly revision: string;
  }> {
    this.#assertOpen();
    if (this.#downloads.has(request.streamId)) {
      throw new SidecarOperationError("sidecar_download_stream_duplicate");
    }
    if (this.#downloads.size >= 16)
      throw new SidecarOperationError("sidecar_download_capacity", true);
    const controller = new AbortController();
    const abortSetup = () => controller.abort(requestSignal.reason);
    requestSignal.addEventListener("abort", abortSetup, { once: true });
    const metadata = deferred<{
      readonly path: string;
      readonly fileName: string;
      readonly sizeBytes: number;
      readonly revision: string;
    }>();
    let sourceOpened = false;
    const done = this.#engine
      .withDownload(
        this.#root(request.rootHandle),
        {
          path: request.path,
          expectedRevision: request.expectedRevision,
        },
        async (source: WorkspaceFileDownloadSource) => {
          sourceOpened = true;
          metadata.resolve({
            path: source.path,
            fileName: source.fileName,
            sizeBytes: source.sizeBytes,
            revision: source.revision,
          });
          let stream: SidecarOutboundStream | undefined;
          try {
            const openedStream = this.#openDownloadStream({
              streamId: request.streamId,
              initialCreditBytes: request.initialCreditBytes,
            });
            stream = openedStream;
            await source.stream(
              async (chunk) =>
                await openedStream.send("data", chunk, {
                  signal: controller.signal,
                }),
              controller.signal,
            );
            await openedStream.terminal(
              {
                outcome: "complete",
                sizeBytes: source.sizeBytes,
                revision: source.revision,
              } satisfies WorkspaceFilesDownloadTerminal,
              workspaceFilesDownloadTerminalSchema,
            );
          } catch (error) {
            const terminal = classifyDownloadTerminal(error, controller.signal);
            if (stream) {
              await stream
                .terminal(terminal, workspaceFilesDownloadTerminalSchema)
                .catch(() => {
                  if (!controller.signal.aborted)
                    this.#onDownloadCleanupFailure();
                });
            } else {
              if (!controller.signal.aborted) this.#onDownloadCleanupFailure();
            }
          }
        },
        controller.signal,
      )
      .catch((error: unknown) => {
        if (!sourceOpened) metadata.reject(error);
      })
      .finally(() => {
        requestSignal.removeEventListener("abort", abortSetup);
        this.#downloads.delete(request.streamId);
        this.#transferRevision += 1;
      });
    this.#downloads.set(request.streamId, { controller, done });
    this.#transferRevision += 1;
    return await metadata.promise;
  }

  async #downloadCancel(
    streamId: string,
  ): Promise<{ readonly cancelled: true }> {
    this.#assertOpen();
    const download = this.#downloads.get(streamId);
    if (download) {
      download.controller.abort(new Error("workspace_file_download_cancelled"));
      // Do not acknowledge cancellation until the producer has emitted its
      // terminal record and released the descriptor. The consumer unregisters
      // its stream immediately after this response, so an earlier response
      // would turn the crossed terminal into a protocol-fatal unknown stream.
      await download.done;
    }
    return { cancelled: true };
  }

  async #rootOpen(request: {
    readonly admissionId: string;
    readonly rootId: WorkspaceFileRootId;
    readonly rootKind:
      "primary" | "supplemental" | "linked_worktree" | "link_only";
    readonly declaredPath: string;
    readonly policyRootPath: string;
  }, signal: AbortSignal): Promise<{ readonly rootHandle: string }> {
    const key = JSON.stringify(request);
    let opening = this.#opening.get(request.admissionId);
    if (opening) {
      if (opening.key !== key)
        throw new SidecarOperationError("sidecar_root_admission_mismatch");
    } else {
      if (this.#opening.size >= 1024)
        throw new SidecarOperationError(
          "sidecar_workspace_admission_capacity",
          true,
        );
      const admission: {
        readonly key: string;
        promise: Promise<{ readonly rootHandle: string }>;
        waiters: number;
      } = { key, promise: Promise.resolve({ rootHandle: "" }), waiters: 0 };
      admission.promise = this.#rootOpenAdmitted(request).then((result) => {
        // Every request for this admission stopped waiting, so no client can
        // learn or close the handle; release it instead of filling the table.
        if (admission.waiters === 0 && this.#roots.has(result.rootHandle)) {
          this.#rootClose(result.rootHandle);
        }
        return result;
      });
      this.#opening.set(request.admissionId, admission);
      opening = admission;
    }
    const current = opening;
    current.waiters += 1;
    let waiting = true;
    const abandon = () => {
      if (!waiting) return;
      waiting = false;
      current.waiters -= 1;
    };
    signal.addEventListener("abort", abandon, { once: true });
    if (signal.aborted) abandon();
    try {
      return await current.promise;
    } finally {
      signal.removeEventListener("abort", abandon);
      if (this.#opening.get(request.admissionId) === current)
        this.#opening.delete(request.admissionId);
    }
  }

  async #rootOpenAdmitted(request: {
    readonly admissionId: string;
    readonly rootId: WorkspaceFileRootId;
    readonly rootKind:
      "primary" | "supplemental" | "linked_worktree" | "link_only";
    readonly declaredPath: string;
    readonly policyRootPath: string;
  }): Promise<{ readonly rootHandle: string }> {
    this.#assertOpen();
    const assertAdmission = this.#admission();
    assertAdmission();
    const existingHandle = this.#admissions.get(request.admissionId);
    if (existingHandle) {
      const existing = this.#roots.get(existingHandle);
      if (
        !existing ||
        existing.rootId !== request.rootId ||
        existing.rootKind !== request.rootKind ||
        existing.declaredPath !== request.declaredPath ||
        existing.policyRootPath !== request.policyRootPath
      ) {
        throw new SidecarOperationError("sidecar_root_admission_mismatch");
      }
      return { rootHandle: existingHandle };
    }
    if (!isWithin(request.policyRootPath, request.declaredPath)) {
      throw new WorkspaceFileRootUnavailableError();
    }
    const [canonicalPolicy, canonicalRoot] = await Promise.all([
      canonicalDirectory(request.policyRootPath),
      canonicalDirectory(request.declaredPath),
    ]);
    if (
      canonicalRoot !== request.declaredPath ||
      !isWithin(canonicalPolicy, canonicalRoot)
    ) {
      throw new WorkspaceFileRootUnavailableError();
    }
    await this.#engine.validateRoot(request.declaredPath);
    assertAdmission();
    if (this.#roots.size >= 1024)
      throw new SidecarOperationError("sidecar_root_capacity", true);
    const rootHandle = randomUUID();
    const admitted: AdmittedRoot = Object.freeze({
      ...request,
      engineRoot: Object.freeze({
        canonicalPath: canonicalRoot,
        durableRootKey: `${request.rootId}\0${request.rootKind}\0${canonicalPolicy}\0${canonicalRoot}`,
        operationKey: `${this.#sessionNonce}\0${rootHandle}`,
        rootId: request.rootId,
      }),
    });
    this.#roots.set(rootHandle, admitted);
    this.#admissions.set(request.admissionId, rootHandle);
    return { rootHandle };
  }

  #rootClose(rootHandle: string): { readonly closed: true } {
    this.#assertOpen();
    const root = this.#roots.get(rootHandle);
    if (!root) throw new SidecarOperationError("sidecar_root_handle_invalid");
    for (const [handle, watch] of this.#watches) {
      if (watch.rootHandle !== rootHandle) continue;
      watch.subscription.close();
      this.#watches.delete(handle);
    }
    this.#roots.delete(rootHandle);
    this.#admissions.delete(root.admissionId);
    return { closed: true };
  }

  async #discoverLinkRoot(absolutePath: string, policyRootPath: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.#assertOpen();
    if (!isWithin(policyRootPath, absolutePath)) {
      return { status: "not_found" as const };
    }
    const [canonicalPolicy, canonicalCandidate] = await Promise.all([
      canonicalDirectory(policyRootPath),
      realpath(absolutePath).catch(() => undefined),
    ]);
    if (!canonicalCandidate || !isWithin(canonicalPolicy, canonicalCandidate)) {
      return { status: "not_found" as const };
    }
    const discovered = await this.#engine.discoverFileLinkRoot(absolutePath, signal);
    if (!discovered || !isWithin(canonicalPolicy, discovered.canonicalPath)) {
      return { status: "not_found" as const };
    }
    const relativeRoot = path.relative(
      canonicalPolicy,
      discovered.canonicalPath,
    );
    const declaredRootPath = relativeRoot
      ? path.join(policyRootPath, relativeRoot)
      : policyRootPath;
    if (
      (await realpath(declaredRootPath).catch(() => undefined)) !==
      discovered.canonicalPath
    ) {
      return { status: "not_found" as const };
    }
    return {
      status: "discovered" as const,
      declaredRootPath,
      relativePath: discovered.relativePath,
    };
  }

  async #discoverLinkedWorktrees(
    rootHandle: string,
    policyRootPaths: readonly string[],
    signal: AbortSignal,
  ) {
    this.#assertOpen();
    const admitted = this.#admittedRoot(rootHandle);
    if (
      admitted.rootKind !== "primary" ||
      !policyRootPaths.includes(admitted.policyRootPath)
    ) {
      throw new SidecarOperationError(
        "sidecar_linked_worktree_primary_root_required",
      );
    }
    const canonicalPolicies = (
      await Promise.all(
        policyRootPaths.map((candidate) =>
          canonicalDirectory(candidate).catch(() => undefined),
        ),
      )
    ).filter((candidate) => candidate !== undefined);
    const result = await this.#engine.discoverLinkedWorktrees(
      admitted.engineRoot,
      signal,
      canonicalPolicies,
    );
    return { worktrees: [...result.worktrees], truncated: result.truncated };
  }

  async #watchOpen(rootHandle: string) {
    this.#assertOpen();
    const assertAdmission = this.#admission();
    assertAdmission();
    if (this.#watches.size >= 256)
      throw new SidecarOperationError("sidecar_watch_capacity", true);
    const root = this.#root(rootHandle);
    const subscriptionHandle = randomUUID();
    const subscription = await this.#engine.watch(root, () => {
      void this.#sendInvalidation(subscriptionHandle).catch(() => undefined);
    });
    try {
      assertAdmission();
      if (this.#watches.size >= 256)
        throw new SidecarOperationError("sidecar_watch_capacity", true);
    } catch (error) {
      subscription.close();
      throw error;
    }
    this.#watches.set(subscriptionHandle, { rootHandle, subscription });
    void subscription.failed.then(() => {
      const active = this.#watches.get(subscriptionHandle);
      if (active?.subscription === subscription) {
        this.#watches.delete(subscriptionHandle);
        void this.#sendWatchFailure(subscriptionHandle).catch(() => undefined);
      }
    });
    return { subscriptionHandle };
  }

  #watchClose(subscriptionHandle: string): { readonly closed: true } {
    this.#assertOpen();
    const watch = this.#watches.get(subscriptionHandle);
    if (!watch) {
      throw new SidecarOperationError("sidecar_watch_handle_invalid");
    }
    this.#watches.delete(subscriptionHandle);
    watch.subscription.close();
    return { closed: true };
  }

  #root(
    rootHandle: string,
  ): WorkspaceFilesEngineRoot & WorkspaceDiffsEngineRoot {
    this.#assertOpen();
    return this.#admittedRoot(rootHandle).engineRoot;
  }

  #admittedRoot(rootHandle: string): AdmittedRoot {
    this.#assertOpen();
    const root = this.#roots.get(rootHandle);
    if (!root) throw new SidecarOperationError("sidecar_root_handle_invalid");
    return root;
  }

  async #guard<T>(operation: () => T | Promise<T>): Promise<T> {
    try {
      this.#admission()();
      return await operation();
    } catch (error) {
      if (error instanceof SidecarOperationError) throw error;
      if (error instanceof WorkspaceFileRevisionConflictError) {
        throw new SidecarOperationError("workspace_file_revision_conflict");
      }
      if (error instanceof WorkspaceFileDownloadTooLargeError) {
        throw new SidecarOperationError("workspace_file_download_too_large");
      }
      if (error instanceof WorkspaceFileAccessError) {
        throw new SidecarOperationError("workspace_file_not_found");
      }
      if (error instanceof WorkspaceFileCursorInvalidError) {
        throw new SidecarOperationError("workspace_file_list_cursor_invalid");
      }
      if (error instanceof WorkspaceFileRootUnavailableError) {
        throw new SidecarOperationError("workspace_file_root_unavailable");
      }
      if (error instanceof WorkspaceLinkedWorktreeDirtyError) {
        throw new SidecarOperationError("workspace_linked_worktree_dirty");
      }
      if (error instanceof WorkspaceLinkedWorktreeRemovalRejectedError) {
        throw new SidecarOperationError(
          "workspace_linked_worktree_removal_rejected",
        );
      }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new SidecarOperationError("sidecar_session_closed");
  }
}

function classifyDownloadTerminal(
  error: unknown,
  signal: AbortSignal,
): WorkspaceFilesDownloadTerminal {
  if (signal.aborted) {
    return { outcome: "error", code: "workspace_file_download_cancelled" };
  }
  if (error instanceof WorkspaceFileRevisionConflictError) {
    return { outcome: "error", code: "workspace_file_revision_conflict" };
  }
  if (error instanceof WorkspaceFileDownloadTooLargeError) {
    return { outcome: "error", code: "workspace_file_download_too_large" };
  }
  if (error instanceof WorkspaceFileAccessError) {
    return { outcome: "error", code: "workspace_file_not_found" };
  }
  return { outcome: "error", code: "workspace_file_download_failed" };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function canonicalDirectory(value: string): Promise<string> {
  const canonical = await realpath(value).catch(() => {
    throw new WorkspaceFileRootUnavailableError();
  });
  const metadata = await stat(canonical).catch(() => {
    throw new WorkspaceFileRootUnavailableError();
  });
  if (!metadata.isDirectory()) throw new WorkspaceFileRootUnavailableError();
  return canonical;
}

function isWithin(root: string, candidate: string): boolean {
  return root === "/" || candidate === root || candidate.startsWith(`${root}/`);
}

function protocolReadResult(
  result: Awaited<ReturnType<WorkspaceFilesEngine["read"]>>,
) {
  const common = {
    path: result.path,
    sizeBytes: result.sizeBytes,
    revision: result.revision,
  };
  if (result.contentKind === "text") {
    return {
      ...common,
      contentKind: "text" as const,
      content: result.content,
      editable: result.editable,
      ...(result.truncation
        ? {
            truncation: {
              retainedBytes: result.truncation.retainedBytes,
              reason: "byte_limit" as const,
            },
          }
        : {}),
    };
  }
  if (result.contentKind === "binary") {
    return {
      ...common,
      contentKind: "binary" as const,
      editable: false as const,
      ...(result.truncation
        ? {
            truncation: {
              retainedBytes: result.truncation.retainedBytes,
              reason: "byte_limit" as const,
            },
          }
        : {}),
    };
  }
  return result.previewState === "available"
    ? {
        ...common,
        contentKind: "image" as const,
        previewState: "available" as const,
        mediaType: result.mediaType,
        contentBase64: result.content,
        editable: false as const,
      }
    : {
        ...common,
        contentKind: "image" as const,
        previewState: "too_large" as const,
        mediaType: result.mediaType,
        editable: false as const,
      };
}
