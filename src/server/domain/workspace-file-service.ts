import path from "node:path";
import type {
  WorkspaceFileContentResult,
  WorkspaceFileDirectoryQuery,
  WorkspaceFileDirectoryResult,
  WorkspaceFileDownloadQuery,
  WorkspaceFileLinkReference,
  WorkspaceFileLinkResolveRequest,
  WorkspaceFileLinkResolveResult,
  WorkspaceFileListQuery,
  WorkspaceFileListResult,
  WorkspaceFileRootCreateRequest,
  WorkspaceFileRootCreateResult,
  WorkspaceFileRootDeleteRequest,
  WorkspaceFileRootDeleteResult,
  WorkspaceFileRootDescriptor,
  WorkspaceFileRootId,
  WorkspaceFileLinkedWorktreeRootId,
  WorkspaceFileSupplementalRootId,
  WorkspaceFileRootsResult,
  WorkspaceFileStatusResult,
  WorkspaceFileWriteRequest,
  WorkspaceFileWriteResult,
  WorkspaceLinkedWorktreeDeleteRequest,
  WorkspaceLinkedWorktreeDeleteResult,
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
import {
  WORKSPACE_FILE_MAX_SUPPLEMENTAL_ROOTS,
  WORKSPACE_FILE_PRIMARY_ROOT_ID,
  workspaceFileRootDisplayLabelSchema,
  workspaceFileSupplementalRootIdSchema,
} from "../../shared/protocol/workspace-files.js";
import type {
  InventoryRepository,
  InventoryWorkspaceRecord,
} from "../db/repositories/inventory-repository.js";
import type {
  WorkspaceFileRootRecord,
  WorkspaceFileRootRepository,
} from "../db/repositories/workspace-file-root-repository.js";
import type { WorkspaceFileLinkedWorktreeRepository } from "../db/repositories/workspace-file-linked-worktree-repository.js";
import {
  ExecutionWorkspaceAdmissionDeniedError,
  type ExecutionEnvironmentProvider,
} from "../execution/contracts.js";
import type { RequestScope } from "../identity/identity-provider.js";
import type {
  WorkspaceFileProvider,
  WorkspaceFileDiscoveredLinkedWorktree,
  WorkspaceFileDownloadSource,
  WorkspaceFileRootTarget,
  WorkspaceFileWatchSubscription,
} from "../workspace-files/contracts.js";
import {
  WorkspaceFileAccessError,
  WorkspaceFileDownloadTooLargeError,
  WorkspaceFileCursorInvalidError,
  WorkspaceFileProviderUnavailableError,
  WorkspaceFileRevisionConflictError,
  WorkspaceFileRootUnavailableError,
  WorkspaceFileWriteOutcomeUnknownError,
  WorkspaceLinkedWorktreeDirtyError,
  WorkspaceLinkedWorktreeRemovalOutcomeUnknownError,
  WorkspaceLinkedWorktreeRemovalRejectedError,
} from "../workspace-files/contracts.js";
import {
  mostSpecificWorkspaceFileRootMatch,
  supplementalRootConflictsWithPrimary,
  workspaceFileRootsOverlap,
} from "../workspace-files/root-topology.js";
import { isSensitiveWorkspacePath } from "../workspace-files/workspace-file-policy.js";
import { DomainError } from "./errors.js";
import { boundDisplayText } from "../conversations/payload-policy.js";

const ROOT_UNAVAILABLE = "workspace_file_root_unavailable";
const FILES_UNSUPPORTED = "workspace_files_unsupported";
const WORKSPACE_UNAVAILABLE = "workspace_unavailable";

type ResolvedRoot =
  | { readonly target: WorkspaceFileRootTarget }
  | { readonly diagnosticCode: string };

type ProjectedRoot = {
  readonly descriptor: WorkspaceFileRootDescriptor;
  readonly target: WorkspaceFileRootTarget | undefined;
};

type ResolvedRootCandidate = {
  readonly rootId: WorkspaceFileRootId;
  readonly canonicalPath: string;
  readonly displayLabel: string;
  readonly sortOrder: number;
  readonly revision: number;
  readonly kind: "primary" | "supplemental" | "linked_worktree";
  readonly branch?: string | null;
  readonly head?: string;
  readonly provenance?: {
    readonly kind: "same" | "contained" | "unmerged" | "unknown";
    readonly ahead: number | null;
    readonly behind: number | null;
  };
  readonly linkedAvailability?: "available" | "unavailable";
  readonly canonicalCheckoutPath?: string | null;
  readonly removal?:
    | { readonly status: "allowed"; readonly displayPath: string }
    | { readonly status: "forget" }
    | { readonly status: "unavailable" };
  readonly record?: WorkspaceFileRootRecord;
};

type RootOperationLifecycle = {
  active: number;
  draining: boolean;
  deleted: boolean;
  readonly drained: Set<() => void>;
  readonly drainCallbacks: Set<() => void>;
};

function derivedRootDisplayLabel(canonicalPath: string): string {
  const basename = path
    .basename(canonicalPath)
    .replace(/[\\\u0000-\u001f\u007f]/gu, "\uFFFD");
  const bounded = [...basename].slice(0, 240).join("") || "Files";
  const parsed = workspaceFileRootDisplayLabelSchema.safeParse(bounded);
  return parsed.success ? parsed.data : "Files";
}

function optionalAbortSignal(
  signal: AbortSignal | undefined,
): [] | [AbortSignal] {
  return signal ? [signal] : [];
}

/** Principal-scoped root topology and workspace-file application service. */
export class WorkspaceFileService {
  readonly #rootMutations = new Map<string, Promise<void>>();
  readonly #watchability = new Map<string, boolean>();
  readonly #topologyListeners = new Map<string, Set<() => void>>();
  readonly #rootOperationLifecycles = new Map<string, RootOperationLifecycle>();
  readonly #workspaceAdmissions = new Map<string, {
    retiring: boolean;
    readonly pending: Set<Promise<void>>;
  }>();
  readonly #workspaceWatchClosers = new Map<string, Set<() => void>>();
  readonly #linkedWorktreeDiscoveries = new Map<
    string,
    { readonly promise: Promise<void>; expiresAt: number }
  >();

  constructor(
    readonly inventory: Pick<
      InventoryRepository,
      "getWorkspace" | "listWorkspaces" | "getThread" | "assertWorkspaceActive"
    >,
    readonly roots: WorkspaceFileRootRepository,
    readonly linkedWorktrees: WorkspaceFileLinkedWorktreeRepository,
    readonly execution: ExecutionEnvironmentProvider,
    readonly providers: WorkspaceFileProvider,
    readonly applicationThreads: {
      publishApplicationThreadChanges(
        scope: RequestScope,
        applicationThreadIds: readonly string[],
      ): void | Promise<void>;
    },
  ) {}

  async listRoots(
    scope: RequestScope,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileRootsResult> {
    const workspace = this.inventory.getWorkspace(scope, workspaceId);
    return { roots: await this.#descriptors(scope, workspace, signal) };
  }

  async requireAvailableLinkedWorktree(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileLinkedWorktreeRootId,
    signal?: AbortSignal,
  ): Promise<void> {
    const { roots } = await this.listRoots(scope, workspaceId, signal);
    if (
      !roots.some(
        (root) =>
          root.rootId === rootId &&
          root.kind === "linked_worktree" &&
          root.availability === "available",
      )
    ) {
      throw new DomainError(
        "not_found",
        "The linked worktree is not available for this workspace.",
      );
    }
  }

  async attachRoot(
    scope: RequestScope,
    workspaceId: string,
    input: WorkspaceFileRootCreateRequest,
  ): Promise<WorkspaceFileRootCreateResult> {
    return this.#serializeRootMutation(scope, workspaceId, () =>
      this.#attachRoot(scope, workspaceId, input),
    );
  }

  async #attachRoot(
    scope: RequestScope,
    workspaceId: string,
    input: WorkspaceFileRootCreateRequest,
  ): Promise<WorkspaceFileRootCreateResult> {
    const replayed = this.roots.replayCreate(scope, workspaceId, input);
    if (replayed) {
      const rootId = workspaceFileSupplementalRootIdSchema.parse(
        replayed.rootId,
      );
      let watchable = false;
      try {
        const workspace = this.inventory.getWorkspace(scope, workspaceId);
        watchable = this.#isWatchable(scope, {
          workspaceId,
          environmentId: workspace.environmentId,
          rootId,
          canonicalPath: replayed.canonicalPath,
        });
      } catch {
        // Receipt replay remains authoritative even when mutable inventory is
        // gone; unavailable provider state is projected as non-watchable.
      }
      return {
        root: this.#availableDescriptor(
          "supplemental",
          rootId,
          replayed.displayLabel,
          replayed.canonicalPath,
          replayed.sortOrder + 1,
          replayed.revision,
          watchable,
        ),
      };
    }
    const workspace = this.inventory.getWorkspace(scope, workspaceId);
    if (workspace.availability !== "available") {
      throw new DomainError(
        "runtime_unavailable",
        "The workspace execution environment is unavailable.",
        true,
      );
    }
    if (
      !this.providers.supportsSupplementalRoots(scope, workspace.environmentId)
    ) {
      throw new DomainError(
        "invalid_transition",
        "Supplemental file roots require a file-capable execution environment.",
      );
    }
    if (
      this.roots.list(scope, workspaceId).length >=
      WORKSPACE_FILE_MAX_SUPPLEMENTAL_ROOTS
    ) {
      throw new DomainError(
        "conflict",
        `A workspace can have at most ${WORKSPACE_FILE_MAX_SUPPLEMENTAL_ROOTS} supplemental file roots.`,
      );
    }

    const validated = await this.execution
      .validateWorkspace(scope, workspace.environmentId, input.path)
      .catch(() => {
        throw new DomainError(
          "invalid_transition",
          "The supplemental file root is not an allowed local directory.",
        );
      });
    const canonicalPath = validated.canonicalPath;
    const policyPath = canonicalPath
      .slice(path.parse(canonicalPath).root.length)
      .split(path.sep)
      .join("/");
    if (isSensitiveWorkspacePath(policyPath)) {
      throw new DomainError(
        "invalid_transition",
        "Sensitive credential and configuration directories cannot be attached.",
      );
    }
    const currentRoots = this.roots.list(scope, workspaceId);
    if (
      supplementalRootConflictsWithPrimary(
        workspace.canonicalPath,
        canonicalPath,
      ) ||
      currentRoots.some((root) =>
        workspaceFileRootsOverlap(root.canonicalPath, canonicalPath),
      )
    ) {
      throw new DomainError(
        "conflict",
        "A supplemental file root cannot equal Primary or overlap another supplemental root.",
      );
    }
    if (
      this.inventory
        .listWorkspaces(scope)
        .some(
          (candidate) =>
            candidate.id !== workspace.id &&
            candidate.canonicalPath === canonicalPath,
        )
    ) {
      throw new DomainError(
        "conflict",
        "Another workspace already owns that directory.",
      );
    }

    const displayLabel =
      input.displayLabel === undefined
        ? derivedRootDisplayLabel(canonicalPath)
        : workspaceFileRootDisplayLabelSchema.parse(input.displayLabel);
    if (
      [
        workspace.displayName,
        ...currentRoots.map((root) => root.displayLabel),
      ].some(
        (label) =>
          label.localeCompare(displayLabel, undefined, {
            sensitivity: "accent",
          }) === 0,
      )
    ) {
      throw new DomainError(
        "conflict",
        "Workspace file-root labels must be unique ignoring case.",
      );
    }
    try {
      await this.providers.validateRoot(scope, {
        workspaceId: workspace.id,
        environmentId: workspace.environmentId,
        rootKind: "supplemental",
        canonicalPath,
      });
    } catch (error) {
      if (error instanceof WorkspaceFileProviderUnavailableError) {
        throw this.#providerUnavailable();
      }
      if (error instanceof WorkspaceFileRootUnavailableError) {
        throw new DomainError(
          "invalid_transition",
          "The supplemental file root is not an available directory.",
        );
      }
      throw error;
    }
    const record = this.roots.create(scope, workspaceId, {
      path: input.path,
      ...(input.displayLabel === undefined
        ? {}
        : { displayLabel: input.displayLabel }),
      canonicalPath,
      resolvedDisplayLabel: displayLabel,
      mutationId: input.mutationId,
      now: Date.now(),
    });
    this.#publishTopology(scope, workspaceId);
    const supplementalRootId = workspaceFileSupplementalRootIdSchema.parse(
      record.rootId,
    );
    return {
      root: this.#availableDescriptor(
        "supplemental",
        supplementalRootId,
        record.displayLabel,
        record.canonicalPath,
        record.sortOrder + 1,
        record.revision,
        this.providers.supportsWatching(scope, {
          workspaceId: workspace.id,
          environmentId: workspace.environmentId,
          rootId: supplementalRootId,
          canonicalPath: record.canonicalPath,
        }),
      ),
    };
  }

  async deleteRoot(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileSupplementalRootId,
    input: WorkspaceFileRootDeleteRequest,
  ): Promise<WorkspaceFileRootDeleteResult> {
    return this.#serializeRootMutation(scope, workspaceId, async () => {
      const replayed = this.roots.replayRemove(
        scope,
        workspaceId,
        rootId,
        input,
      );
      if (replayed) {
        return {
          rootId: workspaceFileSupplementalRootIdSchema.parse(replayed.rootId),
        };
      }
      this.inventory.getWorkspace(scope, workspaceId);
      const lifecycle = await this.#drainRootOperations(
        scope,
        workspaceId,
        rootId,
      );
      let removed: WorkspaceFileRootRecord;
      try {
        removed = this.roots.remove(scope, workspaceId, rootId, {
          expectedRevision: input.expectedRevision,
          mutationId: input.mutationId,
          now: Date.now(),
        });
        lifecycle.deleted = true;
      } catch (error) {
        lifecycle.draining = false;
        if (lifecycle.active === 0) {
          this.#rootOperationLifecycles.delete(
            this.#rootOperationKey(scope, workspaceId, rootId),
          );
        }
        throw error;
      }
      this.#watchability.delete(
        `${scope.tenantId}\0${scope.principalId}\0${workspaceId}\0${rootId}`,
      );
      this.#publishTopology(scope, workspaceId);
      this.#rootOperationLifecycles.delete(
        this.#rootOperationKey(scope, workspaceId, rootId),
      );
      return {
        rootId: workspaceFileSupplementalRootIdSchema.parse(removed.rootId),
      };
    });
  }

  async deleteLinkedWorktree(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileLinkedWorktreeRootId,
    input: WorkspaceLinkedWorktreeDeleteRequest,
  ): Promise<WorkspaceLinkedWorktreeDeleteResult> {
    return this.#serializeRootMutation(scope, workspaceId, async () => {
      const replayed = this.linkedWorktrees.replayForget(
        scope,
        workspaceId,
        rootId,
        input,
      );
      if (replayed) return replayed as WorkspaceLinkedWorktreeDeleteResult;
      const workspace = this.inventory.getWorkspace(scope, workspaceId);
      await this.#discoverLinkedWorktrees(scope, workspace, undefined, true);
      let root = this.linkedWorktrees.get(scope, workspaceId, rootId);
      if (
        root.availability === "available" &&
        root.revision !== input.expectedRevision
      ) {
        throw new DomainError(
          "conflict",
          "The linked worktree changed in another client.",
        );
      }
      let outcome: "removed" | "forgotten" = "forgotten";
      let drainedLifecycle: RootOperationLifecycle | undefined;
      if (root.availability === "available") {
        if (!root.canonicalCheckoutPath) {
          throw new DomainError(
            "conflict",
            "Refresh worktree discovery before removing this checkout.",
          );
        }
        let admittedCheckout;
        try {
          admittedCheckout = await this.execution.validateWorkspace(
            scope,
            workspace.environmentId,
            root.canonicalCheckoutPath,
          );
        } catch (error) {
          if (error instanceof ExecutionWorkspaceAdmissionDeniedError) {
            throw new DomainError(
              "not_found",
              "The linked worktree is not available for removal.",
            );
          }
          throw new DomainError(
            "runtime_unavailable",
            "The workspace execution environment is unavailable.",
            true,
          );
        }
        if (admittedCheckout.canonicalPath !== root.canonicalCheckoutPath) {
          throw new DomainError(
            "not_found",
            "The linked worktree is not available for removal.",
          );
        }
        if (
          this.linkedWorktrees.hasOtherWorkspaceOverlap(
            scope,
            workspace.environmentId,
            workspaceId,
            root.canonicalCheckoutPath,
          )
        ) {
          throw new DomainError(
            "conflict",
            "Another Sedes project overlaps this linked worktree.",
          );
        }
        const primaryRoot: WorkspaceFileRootTarget = {
          workspaceId,
          environmentId: workspace.environmentId,
          rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
          canonicalPath: workspace.canonicalPath,
        };
        const lifecycle = await this.#drainRootOperations(
          scope,
          workspaceId,
          rootId,
        );
        drainedLifecycle = lifecycle;
        try {
          try {
            await this.providers.removeLinkedWorktree(scope, {
              primaryRoot,
              canonicalCheckoutPath: root.canonicalCheckoutPath,
              canonicalGitDir: root.canonicalGitDir,
              identityToken: root.identityToken,
            });
            outcome = "removed";
          } catch (error) {
            if (error instanceof WorkspaceLinkedWorktreeDirtyError) {
              throw new DomainError(
                "conflict",
                "The linked worktree has uncommitted or untracked changes.",
              );
            }
            if (error instanceof WorkspaceLinkedWorktreeRemovalRejectedError) {
              throw new DomainError(
                "conflict",
                "Git refused to remove this clean linked worktree.",
              );
            }
            if (
              !(
                error instanceof
                WorkspaceLinkedWorktreeRemovalOutcomeUnknownError
              )
            ) {
              throw error;
            }
            await this.#discoverLinkedWorktrees(
              scope,
              workspace,
              undefined,
              true,
            );
            root = this.linkedWorktrees.get(scope, workspaceId, rootId);
            if (root.availability === "available") {
              throw new DomainError(
                "operation_outcome_uncertain",
                "The remote worktree removal outcome is unknown; refresh before retrying.",
                true,
              );
            }
            outcome = "removed";
          }
        } catch (error) {
          lifecycle.draining = false;
          if (lifecycle.active === 0) {
            this.#rootOperationLifecycles.delete(
              this.#rootOperationKey(scope, workspaceId, rootId),
            );
          }
          throw error;
        }
      }
      let result;
      try {
        result = this.linkedWorktrees.forget(scope, workspaceId, rootId, {
          ...input,
          outcome,
          now: Date.now(),
        });
        if (drainedLifecycle) drainedLifecycle.deleted = true;
      } catch (error) {
        if (drainedLifecycle) {
          drainedLifecycle.draining = false;
          if (drainedLifecycle.active === 0) {
            this.#rootOperationLifecycles.delete(
              this.#rootOperationKey(scope, workspaceId, rootId),
            );
          }
        }
        throw error;
      }
      await this.applicationThreads.publishApplicationThreadChanges(
        scope,
        result.clearedThreadIds,
      );
      this.#publishTopology(scope, workspaceId);
      this.#rootOperationLifecycles.delete(
        this.#rootOperationKey(scope, workspaceId, rootId),
      );
      return result as WorkspaceLinkedWorktreeDeleteResult;
    });
  }

  async list(
    scope: RequestScope,
    workspaceId: string,
    query: WorkspaceFileListQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileListResult> {
    return this.#withRootOperation(
      scope,
      workspaceId,
      query.rootId,
      async () => {
        const resolved = await this.#resolveRoot(
          scope,
          workspaceId,
          query.rootId,
          signal,
        );
        if ("diagnosticCode" in resolved) {
          return this.#unavailable(query.rootId, resolved.diagnosticCode);
        }
        try {
          const result = await this.providers.list(
            scope,
            resolved.target,
            {
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
              pageSize: query.pageSize,
            },
            ...optionalAbortSignal(signal),
          );
          return this.#providerResult(resolved.target.rootId, result);
        } catch (error) {
          if (error instanceof WorkspaceFileAccessError) {
            throw new DomainError(
              "not_found",
              "The workspace directory was not found.",
            );
          }
          if (error instanceof WorkspaceFileCursorInvalidError) {
            throw new DomainError(
              "cursor_invalid",
              "The workspace file listing cursor is invalid or expired.",
            );
          }
          if (error instanceof WorkspaceFileProviderUnavailableError) {
            return this.#unavailable(query.rootId, error.diagnosticCode);
          }
          if (error instanceof WorkspaceFileRootUnavailableError) {
            return this.#unavailable(query.rootId, error.diagnosticCode);
          }
          throw error;
        }
      },
    );
  }

  async listDirectory(
    scope: RequestScope,
    workspaceId: string,
    query: WorkspaceFileDirectoryQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileDirectoryResult> {
    return this.#withRootOperation(
      scope,
      workspaceId,
      query.rootId,
      async () => {
        const resolved = await this.#resolveRoot(
          scope,
          workspaceId,
          query.rootId,
          signal,
        );
        if ("diagnosticCode" in resolved) {
          return this.#unavailable(query.rootId, resolved.diagnosticCode);
        }
        try {
          const result = await this.providers.listDirectory(
            scope,
            resolved.target,
            {
              directory: query.directory,
              ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
              pageSize: query.pageSize,
            },
            ...optionalAbortSignal(signal),
          );
          return this.#providerResult(resolved.target.rootId, result);
        } catch (error) {
          if (error instanceof WorkspaceFileAccessError) {
            throw new DomainError(
              "not_found",
              "The workspace directory was not found.",
            );
          }
          if (error instanceof WorkspaceFileCursorInvalidError) {
            throw new DomainError(
              "cursor_invalid",
              "The workspace directory listing cursor is invalid or expired.",
            );
          }
          if (
            error instanceof WorkspaceFileProviderUnavailableError ||
            error instanceof WorkspaceFileRootUnavailableError
          ) {
            return this.#unavailable(query.rootId, error.diagnosticCode);
          }
          throw error;
        }
      },
    );
  }

  async read(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileContentResult> {
    return this.#withRootOperation(scope, workspaceId, rootId, async () => {
      const resolved = await this.#resolveRoot(
        scope,
        workspaceId,
        rootId,
        signal,
      );
      if ("diagnosticCode" in resolved) {
        return this.#unavailable(rootId, resolved.diagnosticCode);
      }
      try {
        return this.#providerResult(
          rootId,
          await this.providers.read(
            scope,
            resolved.target,
            relativePath,
            ...optionalAbortSignal(signal),
          ),
        );
      } catch (error) {
        if (error instanceof WorkspaceFileProviderUnavailableError) {
          return this.#unavailable(rootId, error.diagnosticCode);
        }
        if (error instanceof WorkspaceFileAccessError) {
          throw new DomainError(
            "not_found",
            "The workspace file was not found.",
          );
        }
        if (error instanceof WorkspaceFileRootUnavailableError) {
          return this.#unavailable(rootId, error.diagnosticCode);
        }
        throw error;
      }
    });
  }

  async withDownload<T>(
    scope: RequestScope,
    workspaceId: string,
    input: WorkspaceFileDownloadQuery,
    operation: (source: WorkspaceFileDownloadSource) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const rootDrainController = new AbortController();
    const downloadSignal = signal
      ? AbortSignal.any([signal, rootDrainController.signal])
      : rootDrainController.signal;
    return this.#withRootOperation(
      scope,
      workspaceId,
      input.rootId,
      async () => {
        const resolved = await this.#resolveRoot(
          scope,
          workspaceId,
          input.rootId,
          downloadSignal,
        );
        if ("diagnosticCode" in resolved) {
          if (
            resolved.diagnosticCode === "workspace_files_sidecar_unavailable"
          ) {
            throw this.#providerUnavailable();
          }
          throw new DomainError(
            "not_found",
            "The workspace file was not found.",
          );
        }
        try {
          const { rootId: _rootId, ...providerInput } = input;
          return await this.providers.withDownload(
            scope,
            resolved.target,
            providerInput,
            operation,
            downloadSignal,
          );
        } catch (error) {
          if (error instanceof WorkspaceFileAccessError) {
            throw new DomainError(
              "not_found",
              "The workspace file was not found.",
            );
          }
          if (error instanceof WorkspaceFileRevisionConflictError) {
            throw new DomainError(
              "workspace_file_revision_conflict",
              "The workspace file changed before it could be downloaded.",
            );
          }
          if (error instanceof WorkspaceFileDownloadTooLargeError) {
            throw new DomainError(
              "workspace_file_download_too_large",
              "The workspace file is larger than the 1 GiB download limit.",
            );
          }
          if (error instanceof WorkspaceFileProviderUnavailableError) {
            throw this.#providerUnavailable();
          }
          if (error instanceof WorkspaceFileRootUnavailableError) {
            throw new DomainError(
              "not_found",
              "The workspace file was not found.",
            );
          }
          throw error;
        }
      },
      () => {
        rootDrainController.abort(
          new DomainError(
            "not_found",
            "The workspace file root is being removed.",
          ),
        );
      },
    );
  }

  async status(
    scope: RequestScope,
    workspaceId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileStatusResult> {
    const workspace = this.inventory.getWorkspace(scope, workspaceId);
    const descriptors = await this.#resolvedRoots(
      scope,
      workspace,
      true,
      signal,
    );
    return {
      roots: await Promise.all(
        descriptors.map(async ({ descriptor }) => {
          try {
            return await this.#withRootOperation(
              scope,
              workspaceId,
              descriptor.rootId,
              async () => {
                const resolved = await this.#resolveRoot(
                  scope,
                  workspaceId,
                  descriptor.rootId,
                  signal,
                );
                if ("diagnosticCode" in resolved) {
                  return this.#unavailable(
                    descriptor.rootId,
                    resolved.diagnosticCode,
                  );
                }
                try {
                  return this.#providerResult(
                    resolved.target.rootId,
                    await this.providers.status(
                      scope,
                      resolved.target,
                      ...optionalAbortSignal(signal),
                    ),
                  );
                } catch (error) {
                  if (signal?.aborted) throw signal.reason ?? error;
                  return this.#unavailable(
                    descriptor.rootId,
                    this.#providerDiagnostic(error) ?? ROOT_UNAVAILABLE,
                  );
                }
              },
            );
          } catch (error) {
            if (signal?.aborted) throw signal.reason ?? error;
            return this.#unavailable(descriptor.rootId);
          }
        }),
      ),
    };
  }

  diffRepositories(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffRepositoriesResult> {
    return this.#withDiffRoot(
      scope,
      workspaceId,
      rootId,
      (target) =>
        this.providers.diffRepositories(
          scope,
          target,
          ...optionalAbortSignal(signal),
        ),
      signal,
    );
  }

  diffRefCatalog(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    query: WorkspaceDiffRefCatalogQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffRefCatalogResult> {
    return this.#withDiffRoot(
      scope,
      workspaceId,
      rootId,
      (target) =>
        this.providers.diffRefCatalog(
          scope,
          target,
          query,
          ...optionalAbortSignal(signal),
        ),
      signal,
    );
  }

  diffCreateComparison(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    input: WorkspaceDiffComparisonCreateRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffComparisonCreateResult> {
    return this.#withDiffRoot(
      scope,
      workspaceId,
      rootId,
      (target) =>
        this.providers.diffCreateComparison(
          scope,
          target,
          input,
          ...optionalAbortSignal(signal),
        ),
      signal,
    );
  }

  diffChangedFiles(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    query: WorkspaceDiffChangedFilesQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffChangedFilesResult> {
    return this.#withDiffRoot(
      scope,
      workspaceId,
      rootId,
      (target) =>
        this.providers.diffChangedFiles(
          scope,
          target,
          query,
          ...optionalAbortSignal(signal),
        ),
      signal,
    );
  }

  diffPatch(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    input: WorkspaceDiffFileRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffPatchResult> {
    return this.#withDiffRoot(
      scope,
      workspaceId,
      rootId,
      (target) =>
        this.providers.diffPatch(
          scope,
          target,
          input,
          ...optionalAbortSignal(signal),
        ),
      signal,
    );
  }

  diffFileContent(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    input: WorkspaceDiffFileContentRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffFileContentResult> {
    return this.#withDiffRoot(
      scope,
      workspaceId,
      rootId,
      (target) =>
        this.providers.diffFileContent(
          scope,
          target,
          input,
          ...optionalAbortSignal(signal),
        ),
      signal,
    );
  }

  diffReviewIdentity(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    input: WorkspaceDiffReviewIdentityRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewIdentityResult> {
    return this.#withDiffRoot(
      scope,
      workspaceId,
      rootId,
      (target) =>
        this.providers.diffReviewIdentity(
          scope,
          target,
          input,
          ...optionalAbortSignal(signal),
        ),
      signal,
    );
  }

  diffValidateReviewAnchor(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    input: WorkspaceDiffReviewAnchorRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewAnchorResult> {
    return this.#withDiffRoot(
      scope,
      workspaceId,
      rootId,
      (target) =>
        this.providers.diffValidateReviewAnchor(
          scope,
          target,
          input,
          ...optionalAbortSignal(signal),
        ),
      signal,
    );
  }

  diffValidateReviewedFile(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    input: WorkspaceDiffReviewedFileRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewedFileResult> {
    return this.#withDiffRoot(
      scope,
      workspaceId,
      rootId,
      (target) =>
        this.providers.diffValidateReviewedFile(
          scope,
          target,
          input,
          ...optionalAbortSignal(signal),
        ),
      signal,
    );
  }

  diffReviewRepositoryIdentity(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    input: WorkspaceDiffReviewRepositoryIdentityRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDiffReviewRepositoryIdentityResult> {
    return this.#withDiffRoot(
      scope,
      workspaceId,
      rootId,
      (target) =>
        this.providers.diffReviewRepositoryIdentity(
          scope,
          target,
          input,
          ...optionalAbortSignal(signal),
        ),
      signal,
    );
  }

  async write(
    scope: RequestScope,
    workspaceId: string,
    input: WorkspaceFileWriteRequest,
  ): Promise<WorkspaceFileWriteResult> {
    return this.#withRootOperation(
      scope,
      workspaceId,
      input.rootId,
      async () => {
        const resolved = await this.#resolveRoot(
          scope,
          workspaceId,
          input.rootId,
        );
        if ("diagnosticCode" in resolved) {
          return this.#unavailable(input.rootId, resolved.diagnosticCode);
        }
        try {
          const { rootId: _rootId, ...providerInput } = input;
          return this.#providerResult(
            resolved.target.rootId,
            await this.providers.write(scope, resolved.target, providerInput),
          );
        } catch (error) {
          if (error instanceof WorkspaceFileAccessError) {
            throw new DomainError(
              "not_found",
              "The workspace file was not found.",
            );
          }
          if (error instanceof WorkspaceFileRevisionConflictError) {
            throw new DomainError(
              "workspace_file_revision_conflict",
              "The workspace file changed before it could be saved.",
            );
          }
          if (error instanceof WorkspaceFileWriteOutcomeUnknownError) {
            throw new DomainError(
              "workspace_file_write_outcome_unknown",
              "The remote save may have completed. Reload before deciding whether to overwrite it.",
            );
          }
          if (error instanceof WorkspaceFileProviderUnavailableError) {
            return this.#unavailable(input.rootId, error.diagnosticCode);
          }
          if (error instanceof WorkspaceFileRootUnavailableError) {
            return this.#unavailable(input.rootId, error.diagnosticCode);
          }
          throw error;
        }
      },
    );
  }

  async resolveThreadFileLink(
    scope: RequestScope,
    threadId: string,
    input: WorkspaceFileLinkResolveRequest,
  ): Promise<WorkspaceFileLinkResolveResult> {
    const thread = this.inventory.getThread(scope, threadId);
    return this.#resolveFileLink(
      scope,
      thread.thread.workspaceId,
      input,
      thread.inventory
        .preferredWorktreeRootId as WorkspaceFileLinkedWorktreeRootId | null,
    );
  }

  /** Workspace-scoped task/file references have no thread preference. */
  async resolveWorkspaceFileLink(
    scope: RequestScope,
    workspaceId: string,
    input: WorkspaceFileLinkResolveRequest,
  ): Promise<WorkspaceFileLinkResolveResult> {
    return this.#resolveFileLink(scope, workspaceId, input, null);
  }

  async #resolveFileLink(
    scope: RequestScope,
    workspaceId: string,
    input: WorkspaceFileLinkResolveRequest,
    preferredRootId: WorkspaceFileLinkedWorktreeRootId | null,
  ): Promise<WorkspaceFileLinkResolveResult> {
    return this.#withWorkspaceOperation(scope, workspaceId, () =>
      this.#resolveActiveFileLink(scope, workspaceId, input, preferredRootId));
  }

  async #resolveActiveFileLink(
    scope: RequestScope,
    workspaceId: string,
    input: WorkspaceFileLinkResolveRequest,
    preferredRootId: WorkspaceFileLinkedWorktreeRootId | null,
  ): Promise<WorkspaceFileLinkResolveResult> {
    const workspace = this.inventory.getWorkspace(scope, workspaceId);
    const roots = await this.#resolvedRoots(
      scope,
      workspace,
      true,
      undefined,
      true,
    );
    const requestedRootId =
      input.reference.kind === "root_relative"
        ? input.reference.rootId
        : undefined;
    const effectivePreferredRootId =
      preferredRootId !== null &&
      roots.some(
        (root) =>
          root.descriptor.rootId === preferredRootId &&
          root.descriptor.availability === "available",
      )
        ? preferredRootId
        : WORKSPACE_FILE_PRIMARY_ROOT_ID;
    const candidateRoots =
      input.reference.kind === "workspace_relative"
        ? roots.filter(
            (root) => root.descriptor.rootId === effectivePreferredRootId,
          )
        : input.reference.kind === "root_relative"
          ? roots.filter((root) => root.descriptor.rootId === requestedRootId)
          : roots;
    const matches: Array<{
      rootId: WorkspaceFileRootId;
      path: string;
      canonicalPath: string;
      primary: boolean;
    }> = [];
    for (const root of candidateRoots) {
      if (
        root.descriptor.availability === "unavailable" &&
        root.descriptor.diagnosticCode === "workspace_files_sidecar_unavailable"
      ) {
        throw this.#providerUnavailable();
      }
      if (!root.target || root.descriptor.availability !== "available")
        continue;
      const relativePath = await this.#withRootOperation(
        scope,
        workspaceId,
        root.descriptor.rootId,
        async () => {
          const resolved = await this.#resolveRoot(
            scope,
            workspaceId,
            root.descriptor.rootId,
          );
          if ("target" in resolved) {
            return this.providers.resolveFileLink(
              scope,
              resolved.target,
              input.reference,
            );
          }
          if (
            resolved.diagnosticCode === "workspace_files_sidecar_unavailable"
          ) {
            throw this.#providerUnavailable();
          }
          return undefined;
        },
      ).catch((error: unknown) => this.#fileLinkMissOrThrow(error));
      if (relativePath !== undefined) {
        matches.push({
          rootId: root.descriptor.rootId,
          path: relativePath,
          canonicalPath: root.target.canonicalPath,
          primary: root.descriptor.rootId === WORKSPACE_FILE_PRIMARY_ROOT_ID,
        });
      }
    }
    const selectedMatch = mostSpecificWorkspaceFileRootMatch(matches);
    if (selectedMatch) {
      return {
        status: "resolved",
        rootId: selectedMatch.rootId,
        path: selectedMatch.path,
        rootVisibility: "listed",
      };
    }
    if (
      matches.length > 0 ||
      input.reference.kind !== "absolute" ||
      workspace.availability !== "available" ||
      !this.providers.supportsFileLinkRootDiscovery(
        scope,
        workspace.environmentId,
      )
    ) {
      return { status: "not_found" };
    }
    // Establish execution-environment authority before the file provider
    // probes the candidate or chooses a hidden containing root. This keeps
    // arbitrary absolute paths from turning link resolution into host-wide
    // filesystem discovery.
    const admittedParent = await this.execution
      .validateWorkspace(
        scope,
        workspace.environmentId,
        path.dirname(input.reference.path),
      )
      .catch(() => undefined);
    if (!admittedParent) return { status: "not_found" };
    const discovered = await this.providers
      .discoverFileLinkRoot(
        scope,
        workspace.environmentId,
        input.reference.path,
      )
      .catch((error: unknown) => this.#fileLinkMissOrThrow(error));
    if (!discovered) return { status: "not_found" };
    const policyPath = discovered.canonicalPath
      .slice(path.parse(discovered.canonicalPath).root.length)
      .split(path.sep)
      .join("/");
    if (isSensitiveWorkspacePath(policyPath)) {
      return { status: "not_found" };
    }
    const validated = await this.execution
      .validateWorkspace(
        scope,
        workspace.environmentId,
        discovered.canonicalPath,
      )
      .catch(() => undefined);
    if (!validated || validated.canonicalPath !== discovered.canonicalPath) {
      return { status: "not_found" };
    }
    try {
      await this.providers.validateRoot(scope, {
        workspaceId: workspace.id,
        environmentId: workspace.environmentId,
        rootKind: "link_only",
        canonicalPath: discovered.canonicalPath,
      });
    } catch (error) {
      this.#fileLinkMissOrThrow(error);
      return { status: "not_found" };
    }
    const candidateTarget: WorkspaceFileRootTarget = {
      workspaceId: workspace.id,
      environmentId: workspace.environmentId,
      rootId: "link-candidate" as WorkspaceFileRootId,
      canonicalPath: discovered.canonicalPath,
    };
    const canonicalReference: WorkspaceFileLinkReference = {
      kind: "absolute",
      path: path.join(
        discovered.canonicalPath,
        ...discovered.relativePath.split("/"),
      ),
    };
    const relativePath = await this.providers
      .resolveFileLink(scope, candidateTarget, canonicalReference)
      .catch((error: unknown) => this.#fileLinkMissOrThrow(error));
    if (
      relativePath === undefined ||
      relativePath !== discovered.relativePath
    ) {
      return { status: "not_found" };
    }
    let remembered;
    try {
      remembered = this.roots.rememberLinkRoot(
        scope,
        workspace.id,
        discovered.canonicalPath,
        Date.now(),
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === "conflict") {
        return { status: "not_found" };
      }
      throw error;
    }
    return {
      status: "resolved",
      rootId: remembered.rootId as WorkspaceFileRootId,
      path: relativePath,
      rootVisibility: "link_only",
    };
  }

  async watch(
    scope: RequestScope,
    workspaceId: string,
    listener: () => void,
  ): Promise<WorkspaceFileWatchSubscription> {
    return this.#withWorkspaceOperation(scope, workspaceId, () =>
      this.#watch(scope, workspaceId, listener));
  }

  async #watch(
    scope: RequestScope,
    workspaceId: string,
    listener: () => void,
  ): Promise<WorkspaceFileWatchSubscription> {
    const subscriptions = new Map<
      WorkspaceFileRootId,
      {
        readonly target: WorkspaceFileRootTarget;
        readonly subscription: WorkspaceFileWatchSubscription;
      }
    >();
    let closed = false;
    let refresh = Promise.resolve();
    const refreshWatchers = (): Promise<boolean> => this.#withWorkspaceOperation(scope, workspaceId, refreshActiveWatchers);
    const refreshActiveWatchers = async (): Promise<boolean> => {
      const workspace = this.inventory.getWorkspace(scope, workspaceId);
      const roots = await this.#resolvedRoots(
        scope,
        workspace,
        true,
        undefined,
        true,
      );
      const desired = new Map(
        roots.flatMap(({ descriptor, target }) =>
          target &&
          descriptor.availability === "available" &&
          descriptor.kind !== "linked_worktree" &&
          this.providers.supportsWatching(scope, target)
            ? [[target.rootId, target] as const]
            : [],
        ),
      );
      let watchabilityChanged = false;

      // Release removed or retargeted roots before opening additions so a
      // full watcher budget can be reused without a transient false failure.
      for (const [rootId, current] of subscriptions) {
        const target = desired.get(rootId);
        if (target && this.#sameTarget(current.target, target)) continue;
        current.subscription.close();
        subscriptions.delete(rootId);
      }

      await Promise.all(
        [...desired.values()].map(async (target) => {
          if (subscriptions.has(target.rootId)) return;
          const key = this.#watchabilityKey(scope, target);
          try {
            const subscription = await this.providers.watch(
              scope,
              target,
              () => {
                this.#linkedWorktreeDiscoveries.delete(
                  this.#topologyKey(scope, workspaceId),
                );
                listener();
              },
            );
            if (subscription) {
              if (closed) {
                subscription.close();
                return;
              }
              subscriptions.set(target.rootId, { target, subscription });
              void subscription.failed.then(() => {
                const current = subscriptions.get(target.rootId);
                if (closed || current?.subscription !== subscription) return;
                subscriptions.delete(target.rootId);
                const failedKey = this.#watchabilityKey(scope, target);
                if (this.#watchability.get(failedKey) !== false) {
                  this.#watchability.set(failedKey, false);
                  listener();
                }
              });
              if (this.#watchability.delete(key)) {
                watchabilityChanged = true;
              }
            } else if (this.#watchability.get(key) !== false) {
              this.#watchability.set(key, false);
              watchabilityChanged = true;
            }
          } catch {
            if (this.#watchability.get(key) !== false) {
              this.#watchability.set(key, false);
              watchabilityChanged = true;
            }
          }
        }),
      );
      return watchabilityChanged;
    };

    const topologyKey = this.#topologyKey(scope, workspaceId);
    const enqueueTopologyRefresh = (): void => {
      const publish = () => {
        if (!closed) listener();
      };
      refresh = refresh
        .catch(() => undefined)
        .then(refreshWatchers)
        .then(publish, () => publish());
    };
    const topologyListener = enqueueTopologyRefresh;
    const topologyListeners =
      this.#topologyListeners.get(topologyKey) ?? new Set();
    topologyListeners.add(topologyListener);
    this.#topologyListeners.set(topologyKey, topologyListeners);
    const closers = this.#workspaceWatchClosers.get(topologyKey) ?? new Set();
    let fail!: () => void;
    const failed = new Promise<void>(resolve => { fail = resolve; });
    const close = () => {
      if (closed) return;
      closed = true;
      topologyListeners.delete(topologyListener);
      if (topologyListeners.size === 0) this.#topologyListeners.delete(topologyKey);
      closers.delete(close);
      if (closers.size === 0) this.#workspaceWatchClosers.delete(topologyKey);
      for (const current of subscriptions.values()) current.subscription.close();
      subscriptions.clear();
      fail();
    };
    closers.add(close);
    this.#workspaceWatchClosers.set(topologyKey, closers);
    try {
      // Registration precedes the first await. A topology mutation during
      // setup queues a generation-fenced follow-up refresh instead of being
      // lost between initial enumeration and subscription publication.
      const initialRefresh = refresh.then(refreshWatchers).then((changed) => {
        if (!closed && changed) listener();
      });
      refresh = initialRefresh;
      await initialRefresh;
      let observed: Promise<void>;
      do {
        observed = refresh;
        await observed;
      } while (observed !== refresh);
    } catch (error) {
      close();
      throw error;
    }
    return { failed, close };
  }

  async close(): Promise<void> {
    for (const closers of this.#workspaceWatchClosers.values()) {
      for (const close of [...closers]) close();
    }
    this.#topologyListeners.clear();
    this.#watchability.clear();
    this.#linkedWorktreeDiscoveries.clear();
    this.#rootOperationLifecycles.clear();
    await this.providers.close();
  }

  get retainedRootOperationLifecycleCount(): number {
    return this.#rootOperationLifecycles.size;
  }

  async #resolveRoot(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    signal?: AbortSignal,
  ): Promise<ResolvedRoot> {
    const workspace = this.inventory.getWorkspace(scope, workspaceId);
    const roots = await this.#resolvedRoots(scope, workspace, true, signal);
    const resolved = roots.find(
      ({ descriptor }) => descriptor.rootId === rootId,
    );
    if (resolved) {
      return resolved.target && resolved.descriptor.availability === "available"
        ? { target: resolved.target }
        : {
            diagnosticCode:
              resolved.descriptor.availability === "unavailable"
                ? resolved.descriptor.diagnosticCode
                : ROOT_UNAVAILABLE,
          };
    }
    const linkRoot = this.roots.findLinkRoot(scope, workspaceId, rootId);
    if (!linkRoot) {
      throw new DomainError(
        "not_found",
        "The workspace file root was not found.",
      );
    }
    if (
      workspace.availability !== "available" ||
      !this.providers.supportsFileLinkRootDiscovery(
        scope,
        workspace.environmentId,
      )
    ) {
      return {
        diagnosticCode:
          workspace.availability !== "available"
            ? WORKSPACE_UNAVAILABLE
            : FILES_UNSUPPORTED,
      };
    }
    const reopened = await this.execution
      .validateWorkspace(scope, workspace.environmentId, linkRoot.canonicalPath)
      .catch(() => undefined);
    if (reopened?.canonicalPath !== linkRoot.canonicalPath) {
      return { diagnosticCode: ROOT_UNAVAILABLE };
    }
    const target = {
      workspaceId,
      environmentId: workspace.environmentId,
      rootId,
      canonicalPath: linkRoot.canonicalPath,
    };
    try {
      await this.providers.validateRoot(
        scope,
        {
          workspaceId: target.workspaceId,
          environmentId: target.environmentId,
          rootKind: "link_only",
          canonicalPath: target.canonicalPath,
        },
        ...optionalAbortSignal(signal),
      );
      return { target };
    } catch (error) {
      const diagnosticCode = this.#providerDiagnostic(error);
      if (diagnosticCode) return { diagnosticCode };
      throw error;
    }
  }

  async #withDiffRoot<T>(
    scope: RequestScope,
    workspaceId: string,
    rootId: WorkspaceFileRootId,
    operation: (target: WorkspaceFileRootTarget) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.#withRootOperation(scope, workspaceId, rootId, async () => {
      const resolved = await this.#resolveRoot(
        scope,
        workspaceId,
        rootId,
        signal,
      );
      if ("diagnosticCode" in resolved) {
        return {
          status: "unavailable",
          diagnosticCode: resolved.diagnosticCode,
        } as T;
      }
      try {
        return await operation(resolved.target);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        const diagnosticCode = this.#providerDiagnostic(error);
        if (diagnosticCode) {
          return { status: "unavailable", diagnosticCode } as T;
        }
        throw error;
      }
    });
  }

  async #descriptors(
    scope: RequestScope,
    workspace: InventoryWorkspaceRecord,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileRootDescriptor[]> {
    return (
      await this.#resolvedRoots(scope, workspace, true, signal, true)
    ).map(({ descriptor }) => descriptor);
  }

  async #discoverLinkedWorktrees(
    scope: RequestScope,
    workspace: InventoryWorkspaceRecord,
    signal?: AbortSignal,
    force = false,
  ): Promise<void> {
    const key = this.#topologyKey(scope, workspace.id);
    const retained = this.#linkedWorktreeDiscoveries.get(key);
    if (
      retained &&
      (retained.expiresAt === Number.POSITIVE_INFINITY ||
        (!force && retained.expiresAt > Date.now()))
    ) {
      return retained.promise;
    }
    const promise = this.#refreshLinkedWorktrees(scope, workspace, signal);
    const entry = { promise, expiresAt: Number.POSITIVE_INFINITY };
    this.#linkedWorktreeDiscoveries.set(key, entry);
    try {
      await promise;
      entry.expiresAt = Date.now() + 2_000;
    } catch (error) {
      if (this.#linkedWorktreeDiscoveries.get(key) === entry) {
        this.#linkedWorktreeDiscoveries.delete(key);
      }
      throw error;
    }
  }

  async #refreshLinkedWorktrees(
    scope: RequestScope,
    workspace: InventoryWorkspaceRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    if (
      workspace.availability !== "available" ||
      !this.providers.supportsPrimaryRoot(scope, workspace.environmentId)
    ) {
      return;
    }
    const primaryRoot: WorkspaceFileRootTarget = {
      workspaceId: workspace.id,
      environmentId: workspace.environmentId,
      rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID,
      canonicalPath: workspace.canonicalPath,
    };
    let discovery;
    try {
      discovery = await this.providers.discoverLinkedWorktrees(
        scope,
        primaryRoot,
        ...optionalAbortSignal(signal),
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // Discovery is an opportunistic topology refresh. A provider failure
      // must retain the last successful topology and thread preference.
      return;
    }
    const admitted: WorkspaceFileDiscoveredLinkedWorktree[] = [];
    let admissionComplete = true;
    for (const candidate of discovery.worktrees) {
      signal?.throwIfAborted();
      if (candidate.canonicalPath === workspace.canonicalPath) continue;
      let validated;
      try {
        validated = await this.execution.validateWorkspace(
          scope,
          workspace.environmentId,
          candidate.canonicalPath,
        );
      } catch (error) {
        if (!(error instanceof ExecutionWorkspaceAdmissionDeniedError)) {
          admissionComplete = false;
        }
        continue;
      }
      if (!validated || validated.canonicalPath !== candidate.canonicalPath) {
        admissionComplete = false;
        continue;
      }
      admitted.push(candidate);
    }
    const reconciliation = this.linkedWorktrees.reconcileDiscovery(
      scope,
      workspace.id,
      admitted,
      {
        complete: !discovery.truncated && admissionComplete,
        now: Date.now(),
      },
    );
    await this.applicationThreads.publishApplicationThreadChanges(
      scope,
      reconciliation.clearedThreadIds,
    );
  }

  async #resolvedRoots(
    scope: RequestScope,
    workspace: InventoryWorkspaceRecord,
    retryConcurrentMutation = true,
    signal?: AbortSignal,
    forceDiscovery = false,
  ): Promise<ProjectedRoot[]> {
    return this.#withWorkspaceOperation(scope, workspace.id, () =>
      this.#resolveActiveRoots(scope, workspace, retryConcurrentMutation, signal, forceDiscovery));
  }

  async #resolveActiveRoots(
    scope: RequestScope,
    workspace: InventoryWorkspaceRecord,
    retryConcurrentMutation: boolean,
    signal: AbortSignal | undefined,
    forceDiscovery: boolean,
  ): Promise<ProjectedRoot[]> {
    if (forceDiscovery) {
      await this.#discoverLinkedWorktrees(scope, workspace, signal, true);
    }
    const records = this.roots.list(scope, workspace.id);
    const linkedWorktrees = this.linkedWorktrees.list(scope, workspace.id, {
      includeUnavailable: true,
    });
    const candidates: ResolvedRootCandidate[] = [
      {
        rootId: WORKSPACE_FILE_PRIMARY_ROOT_ID as WorkspaceFileRootId,
        canonicalPath: workspace.canonicalPath,
        displayLabel: workspace.displayName.replace(
          /[\u0000-\u001f\u007f]/gu,
          "\uFFFD",
        ),
        sortOrder: 0,
        revision: 0,
        kind: "primary",
      },
      ...records.map((record) => ({
        rootId: record.rootId as WorkspaceFileRootId,
        canonicalPath: record.canonicalPath,
        displayLabel: record.displayLabel,
        sortOrder: record.sortOrder + 1,
        revision: record.revision,
        kind: "supplemental" as const,
        record,
      })),
      ...linkedWorktrees.map((record, index) => ({
        rootId: record.rootId as WorkspaceFileRootId,
        canonicalPath: record.canonicalPath,
        displayLabel: record.displayLabel,
        sortOrder: records.length + index + 1,
        revision: record.revision,
        kind: "linked_worktree" as const,
        branch: record.branchRef?.startsWith("refs/heads/")
          ? record.branchRef.slice("refs/heads/".length)
          : null,
        head: record.headOid,
        provenance: {
          kind: record.provenanceKind,
          ahead: record.aheadCount,
          behind: record.behindCount,
        },
        linkedAvailability: record.availability,
        canonicalCheckoutPath: record.canonicalCheckoutPath,
      })),
    ];
    const validated = await Promise.all(
      candidates.map(async (candidate) => {
        signal?.throwIfAborted();
        if (
          candidate.kind === "linked_worktree" &&
          "linkedAvailability" in candidate &&
          candidate.linkedAvailability === "unavailable"
        ) {
          return {
            ...candidate,
            available: false,
            diagnosticCode: ROOT_UNAVAILABLE,
            removal: { status: "forget" as const },
          };
        }
        if (workspace.availability !== "available") {
          return {
            ...candidate,
            available: false,
            diagnosticCode: WORKSPACE_UNAVAILABLE,
          };
        }
        const supported =
          candidate.kind === "supplemental"
            ? this.providers.supportsSupplementalRoots(
                scope,
                workspace.environmentId,
              )
            : this.providers.supportsPrimaryRoot(
                scope,
                workspace.environmentId,
              );
        if (!supported) {
          return {
            ...candidate,
            available: false,
            diagnosticCode: FILES_UNSUPPORTED,
          };
        }
        try {
          const reopened = await this.execution.validateWorkspace(
            scope,
            workspace.environmentId,
            candidate.canonicalPath,
          );
          if (reopened.canonicalPath !== candidate.canonicalPath) {
            return {
              ...candidate,
              available: false,
              diagnosticCode: ROOT_UNAVAILABLE,
            };
          }
          await this.providers.validateRoot(
            scope,
            {
              workspaceId: workspace.id,
              environmentId: workspace.environmentId,
              rootKind: candidate.kind,
              canonicalPath: candidate.canonicalPath,
            },
            ...optionalAbortSignal(signal),
          );
          let removal: ResolvedRootCandidate["removal"];
          if (
            candidate.kind === "linked_worktree" &&
            candidate.canonicalCheckoutPath
          ) {
            try {
              const admittedCheckout = await this.execution.validateWorkspace(
                scope,
                workspace.environmentId,
                candidate.canonicalCheckoutPath,
              );
              removal =
                admittedCheckout.canonicalPath ===
                candidate.canonicalCheckoutPath
                  ? {
                      status: "allowed",
                      displayPath: candidate.canonicalCheckoutPath,
                    }
                  : { status: "unavailable" };
            } catch {
              removal = { status: "unavailable" };
            }
          }
          return {
            ...candidate,
            available: true,
            diagnosticCode: null,
            ...(candidate.kind === "linked_worktree"
              ? { removal: removal ?? { status: "unavailable" as const } }
              : {}),
          };
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          const providerDiagnostic = this.#providerDiagnostic(error);
          return {
            ...candidate,
            available: false,
            diagnosticCode: providerDiagnostic ?? ROOT_UNAVAILABLE,
          };
        }
      }),
    );

    for (let index = 1; index < validated.length; index += 1) {
      const candidate = validated[index];
      if (!candidate?.available || candidate.kind !== "supplemental") continue;
      if (
        validated.some(
          (other, otherIndex) =>
            otherIndex !== index &&
            other.available &&
            (otherIndex === 0
              ? supplementalRootConflictsWithPrimary(
                  other.canonicalPath,
                  candidate.canonicalPath,
                )
              : other.kind === "supplemental" &&
                workspaceFileRootsOverlap(
                  candidate.canonicalPath,
                  other.canonicalPath,
                )),
        )
      ) {
        validated[index] = {
          ...candidate,
          available: false,
          diagnosticCode: ROOT_UNAVAILABLE,
        };
      }
    }

    try {
      return validated.map((candidate) => {
        if (candidate.kind === "supplemental" && candidate.record) {
          const availability = candidate.available
            ? "available"
            : "unavailable";
          const updated = this.roots.setAvailability(
            scope,
            workspace.id,
            candidate.rootId,
            { availability, now: Date.now() },
          );
          candidate = {
            ...candidate,
            revision: updated.revision,
            record: updated,
          };
        }
        const descriptor = candidate.available
          ? this.#availableDescriptor(
              candidate.kind,
              candidate.rootId,
              candidate.displayLabel,
              candidate.canonicalPath,
              candidate.sortOrder,
              candidate.revision,
              candidate.kind !== "linked_worktree" &&
                this.#isWatchable(scope, {
                  workspaceId: workspace.id,
                  environmentId: workspace.environmentId,
                  rootId: candidate.rootId,
                  canonicalPath: candidate.canonicalPath,
                }),
              candidate.branch,
              candidate.head,
              candidate.provenance,
              candidate.removal,
            )
          : this.#unavailableDescriptor(
              candidate.kind,
              candidate.rootId,
              candidate.displayLabel,
              candidate.canonicalPath,
              candidate.sortOrder,
              candidate.revision,
              candidate.diagnosticCode ?? ROOT_UNAVAILABLE,
              candidate.branch,
              candidate.head,
              candidate.provenance,
              candidate.removal,
            );
        return {
          descriptor,
          target: candidate.available
            ? {
                workspaceId: workspace.id,
                environmentId: workspace.environmentId,
                rootId: candidate.rootId,
                canonicalPath: candidate.canonicalPath,
              }
            : undefined,
        };
      });
    } catch (error) {
      if (
        retryConcurrentMutation &&
        error instanceof DomainError &&
        error.code === "not_found"
      ) {
        return this.#resolvedRoots(scope, workspace, false, signal, false);
      }
      throw error;
    }
  }

  #availableDescriptor(
    kind: "primary" | "supplemental" | "linked_worktree",
    rootId: WorkspaceFileRootId,
    displayLabel: string,
    displayPath: string,
    sortOrder: number,
    revision: number,
    watchable: boolean,
    branch?: string | null,
    head?: string,
    provenance?: ResolvedRootCandidate["provenance"],
    removal?: ResolvedRootCandidate["removal"],
  ): WorkspaceFileRootDescriptor {
    const descriptor = {
      ...(kind === "linked_worktree"
        ? {
            kind,
            branch: branch ?? null,
            head: head!,
            provenance: provenance!,
            removal:
              removal?.status === "allowed"
                ? {
                    status: "allowed" as const,
                    displayPath: boundDisplayText(removal.displayPath),
                  }
                : removal?.status === "forget"
                  ? { status: "forget" as const }
                  : { status: "unavailable" as const },
          }
        : { kind }),
      rootId,
      displayLabel,
      displayPath: boundDisplayText(displayPath),
      sortOrder,
      revision,
      availability: "available",
      watchable,
    };
    return descriptor as WorkspaceFileRootDescriptor;
  }

  #unavailableDescriptor(
    kind: "primary" | "supplemental" | "linked_worktree",
    rootId: WorkspaceFileRootId,
    displayLabel: string,
    displayPath: string,
    sortOrder: number,
    revision: number,
    diagnosticCode: string,
    branch?: string | null,
    head?: string,
    provenance?: ResolvedRootCandidate["provenance"],
    removal?: ResolvedRootCandidate["removal"],
  ): WorkspaceFileRootDescriptor {
    const descriptor = {
      ...(kind === "linked_worktree"
        ? {
            kind,
            branch: branch ?? null,
            head: head!,
            provenance: provenance!,
            removal:
              removal?.status === "forget"
                ? { status: "forget" as const }
                : { status: "unavailable" as const },
          }
        : { kind }),
      rootId,
      displayLabel,
      displayPath: boundDisplayText(displayPath),
      sortOrder,
      revision,
      availability: "unavailable",
      watchable: false,
      diagnosticCode,
    };
    return descriptor as WorkspaceFileRootDescriptor;
  }

  #unavailable(rootId: WorkspaceFileRootId, diagnosticCode = ROOT_UNAVAILABLE) {
    return { availability: "unavailable" as const, rootId, diagnosticCode };
  }

  #providerResult<T extends { readonly rootId: string }>(
    expectedRootId: string,
    result: T,
  ): T {
    if (result.rootId !== expectedRootId) {
      throw new Error("workspace_file_provider_root_mismatch");
    }
    return result;
  }

  #providerDiagnostic(error: unknown): string | undefined {
    if (error instanceof WorkspaceFileProviderUnavailableError) {
      return error.diagnosticCode;
    }
    if (error instanceof WorkspaceFileRootUnavailableError) {
      return error.diagnosticCode;
    }
    return undefined;
  }

  #fileLinkMissOrThrow(error: unknown): undefined {
    if (
      error instanceof WorkspaceFileAccessError ||
      error instanceof WorkspaceFileRootUnavailableError ||
      (error instanceof DomainError && error.code === "not_found")
    ) {
      return undefined;
    }
    if (error instanceof WorkspaceFileProviderUnavailableError) {
      if (error.diagnosticCode === FILES_UNSUPPORTED) return undefined;
      throw this.#providerUnavailable();
    }
    throw error;
  }

  #providerUnavailable(): DomainError {
    return new DomainError(
      "runtime_unavailable",
      "Remote workspace files are temporarily unavailable.",
      true,
    );
  }

  #watchabilityKey(
    scope: RequestScope,
    target: WorkspaceFileRootTarget,
  ): string {
    return `${scope.tenantId}\0${scope.principalId}\0${target.workspaceId}\0${target.rootId}`;
  }

  #rootOperationKey(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
  ): string {
    return `${scope.tenantId}\0${scope.principalId}\0${workspaceId}\0${rootId}`;
  }

  #rootOperationLifecycle(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
  ): RootOperationLifecycle {
    const key = this.#rootOperationKey(scope, workspaceId, rootId);
    const existing = this.#rootOperationLifecycles.get(key);
    if (existing) return existing;
    const created: RootOperationLifecycle = {
      active: 0,
      draining: false,
      deleted: false,
      drained: new Set(),
      drainCallbacks: new Set(),
    };
    this.#rootOperationLifecycles.set(key, created);
    return created;
  }

  async #withRootOperation<T>(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
    operation: () => Promise<T>,
    onDrain?: () => void,
  ): Promise<T> {
    this.#assertWorkspaceAdmitted(scope, workspaceId);
    const lifecycle = this.#rootOperationLifecycle(scope, workspaceId, rootId);
    if (lifecycle.draining || lifecycle.deleted) {
      throw new DomainError(
        "not_found",
        "The workspace file root was not found.",
      );
    }
    lifecycle.active += 1;
    if (onDrain) lifecycle.drainCallbacks.add(onDrain);
    try {
      return await this.#withWorkspaceOperation(scope, workspaceId, operation);
    } finally {
      if (onDrain) lifecycle.drainCallbacks.delete(onDrain);
      lifecycle.active -= 1;
      if (lifecycle.active === 0) {
        for (const resolve of lifecycle.drained) resolve();
        lifecycle.drained.clear();
        if (!lifecycle.draining && !lifecycle.deleted) {
          this.#rootOperationLifecycles.delete(
            this.#rootOperationKey(scope, workspaceId, rootId),
          );
        }
      }
    }
  }

  async #drainRootOperations(
    scope: RequestScope,
    workspaceId: string,
    rootId: string,
  ): Promise<RootOperationLifecycle> {
    const lifecycle = this.#rootOperationLifecycle(scope, workspaceId, rootId);
    lifecycle.draining = true;
    for (const cancel of [...lifecycle.drainCallbacks]) cancel();
    if (lifecycle.active > 0) {
      await new Promise<void>((resolve) => lifecycle.drained.add(resolve));
    }
    return lifecycle;
  }

  #sameTarget(
    left: WorkspaceFileRootTarget,
    right: WorkspaceFileRootTarget,
  ): boolean {
    return (
      left.workspaceId === right.workspaceId &&
      left.environmentId === right.environmentId &&
      left.rootId === right.rootId &&
      left.canonicalPath === right.canonicalPath
    );
  }

  #topologyKey(scope: RequestScope, workspaceId: string): string {
    return `${scope.tenantId}\0${scope.principalId}\0${workspaceId}`;
  }

  #publishTopology(scope: RequestScope, workspaceId: string): void {
    for (const listener of this.#topologyListeners.get(
      this.#topologyKey(scope, workspaceId),
    ) ?? []) {
      listener();
    }
  }

  #isWatchable(scope: RequestScope, target: WorkspaceFileRootTarget): boolean {
    return (
      this.providers.supportsWatching(scope, target) &&
      this.#watchability.get(this.#watchabilityKey(scope, target)) !== false
    );
  }

  async #serializeRootMutation<T>(
    scope: RequestScope,
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = `${scope.tenantId}\0${scope.principalId}\0${workspaceId}`;
    const previous = this.#rootMutations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#rootMutations.set(key, queued);
    await previous;
    try {
      return await this.#withWorkspaceOperation(scope, workspaceId, operation);
    } finally {
      release();
      if (this.#rootMutations.get(key) === queued)
        this.#rootMutations.delete(key);
    }
  }

  #assertWorkspaceAdmitted(scope: RequestScope, workspaceId: string): void {
    this.inventory.assertWorkspaceActive(scope, workspaceId);
    if (this.#workspaceAdmissions.get(this.#topologyKey(scope, workspaceId))?.retiring) {
      throw new DomainError("invalid_transition", "Files are unavailable while this project is being removed.");
    }
  }

  async #withWorkspaceOperation<T>(scope: RequestScope, workspaceId: string, operation: () => Promise<T>): Promise<T> {
    this.#assertWorkspaceAdmitted(scope, workspaceId);
    const key = this.#topologyKey(scope, workspaceId);
    const admission = this.#workspaceAdmissions.get(key) ?? { retiring: false, pending: new Set<Promise<void>>() };
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    admission.pending.add(pending);
    this.#workspaceAdmissions.set(key, admission);
    try { return await operation(); }
    finally {
      admission.pending.delete(pending);
      finish();
      if (!admission.retiring && admission.pending.size === 0) this.#workspaceAdmissions.delete(key);
    }
  }

  /** Drain admitted file operations and close watches before removing the project. */
  async runWithWorkspaceRetired<T>(scope: RequestScope, workspaceId: string, operation: () => Promise<T>): Promise<T> {
    this.inventory.getWorkspace(scope, workspaceId);
    const key = this.#topologyKey(scope, workspaceId);
    const admission = this.#workspaceAdmissions.get(key) ?? { retiring: false, pending: new Set<Promise<void>>() };
    if (admission.retiring) throw new DomainError("conflict", "This project's file access is already being retired.");
    admission.retiring = true;
    this.#workspaceAdmissions.set(key, admission);
    try {
      for (const close of [...(this.#workspaceWatchClosers.get(key) ?? [])]) close();
      for (const [rootKey, lifecycle] of this.#rootOperationLifecycles) {
        if (rootKey.startsWith(`${key}\0`)) {
          for (const cancel of [...lifecycle.drainCallbacks]) cancel();
        }
      }
      await Promise.all(admission.pending);
      await this.#rootMutations.get(key);
      return await operation();
    } finally {
      admission.retiring = false;
      if (admission.pending.size === 0) this.#workspaceAdmissions.delete(key);
    }
  }
}
