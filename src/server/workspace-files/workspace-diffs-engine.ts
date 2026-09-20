import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  WorkspaceDiffChangedFileSummary,
  WorkspaceDiffChangedFilesQuery,
  WorkspaceDiffChangedFilesResult,
  WorkspaceDiffComparisonCreateRequest,
  WorkspaceDiffComparisonCreateResult,
  WorkspaceDiffComparisonDescriptor,
  WorkspaceDiffFileContentRequest,
  WorkspaceDiffFileContentResult,
  WorkspaceDiffFileRequest,
  WorkspaceDiffFingerprint,
  WorkspaceDiffPatchResult,
  WorkspaceDiffRefCatalogQuery,
  WorkspaceDiffRefCatalogResult,
  WorkspaceDiffRepositoriesResult,
  WorkspaceDiffRepositoryDescriptor,
  WorkspaceDiffRepositoryId,
  WorkspaceDiffResolvedEndpoint,
  WorkspaceDiffReviewAnchorRequest,
  WorkspaceDiffReviewAnchorResult,
  WorkspaceDiffReviewIdentityRequest,
  WorkspaceDiffReviewIdentityResult,
  WorkspaceDiffReviewedFileRequest,
  WorkspaceDiffReviewedFileResult,
  WorkspaceDiffReviewRepositoryIdentityRequest,
  WorkspaceDiffReviewRepositoryIdentityResult,
  WorkspaceDiffRevisionDescriptor,
  WorkspaceDiffRevisionId,
  WorkspaceDiffRevisionSelection,
} from "../../shared/protocol/workspace-diffs.js";
import type { WorkspaceFileRootId } from "../../shared/protocol/workspace-files.js";
import {
  workspaceDiffComparisonIdSchema,
  workspaceDiffFileIdSchema,
  workspaceDiffFingerprintSchema,
  workspaceDiffRepositoryIdSchema,
  workspaceDiffRevisionIdSchema,
} from "../../shared/protocol/workspace-diffs.js";
import {
  WORKSPACE_DIFF_COMPARISON_IDLE_TTL_MS,
  WORKSPACE_DIFF_MAX_CHANGED_FILES,
  WORKSPACE_DIFF_MAX_LIVE_COMPARISONS,
  WORKSPACE_DIFF_MAX_LIVE_REVISIONS,
  WORKSPACE_DIFF_MAX_LIVE_REVISIONS_PER_REPOSITORY,
  WORKSPACE_DIFF_MAX_PATCH_BYTES,
  WORKSPACE_DIFF_MAX_REFS,
  WORKSPACE_DIFF_MAX_REVIEW_SELECTION_LINES,
  WORKSPACE_DIFF_MAX_SIDE_BYTES,
  WORKSPACE_DIFF_REPOSITORY_IDLE_TTL_MS,
  WORKSPACE_DIFF_REVISION_IDLE_TTL_MS,
} from "../../shared/workspace-diff-limits.js";
import { WORKSPACE_DIFF_MAX_REPOSITORIES } from "../../shared/workspace-diff-limits.js";
import { WORKSPACE_FILE_MAX_PATH_BYTES } from "../../shared/workspace-file-limits.js";
import { revalidatedPathForOpenHandle } from "../local-file-descriptor-path.js";
import { pathIsWithin } from "../path-containment.js";
import { WorkspaceFileRootUnavailableError } from "./contracts.js";
import { classifyWorkspaceFileBytes } from "./workspace-file-content-classifier.js";
import {
  isSensitiveWorkspacePath,
  isWorkspaceFileWriteTemporaryPath,
} from "./workspace-file-policy.js";

const executeFile = promisify(execFileCallback);
const MAX_GIT_METADATA_BYTES = 16 * 1_024 * 1_024;
const MAX_GIT_REF_BYTES = 8 * 1_024 * 1_024;

/** Root authority supplied by a Files provider after workspace/root resolution. */
export interface WorkspaceDiffsEngineRoot {
  readonly canonicalPath: string;
  readonly durableRootKey: string;
  readonly operationKey: string;
  readonly rootId: WorkspaceFileRootId;
}

export interface WorkspaceDiffsEngineTestHooks {
  readonly clock?: () => number;
  readonly comparisonIdleTtlMs?: number;
  readonly maximumComparisons?: number;
}

interface RepositoryRecord {
  readonly key: string;
  readonly durableKey: string;
  readonly repositoryId: WorkspaceDiffRepositoryId;
  readonly operationKey: string;
  readonly rootId: WorkspaceFileRootId;
  readonly rootPath: string;
  readonly repositoryPath: string;
  readonly pathPrefix?: string;
  readonly descriptor: WorkspaceDiffRepositoryDescriptor;
  lastUsedAt: number;
}

interface RevisionRecord {
  readonly key: string;
  readonly repositoryId: WorkspaceDiffRepositoryId;
  readonly revisionId: WorkspaceDiffRevisionId;
  readonly oid: string;
  readonly descriptor: WorkspaceDiffRevisionDescriptor;
  lastUsedAt: number;
}

interface ComparisonFileRecord {
  readonly summary: WorkspaceDiffChangedFileSummary;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly repositoryOldPath?: string;
  readonly repositoryNewPath?: string;
  readonly untracked?: boolean;
}

interface ComparisonRecord {
  readonly dedupeKey: string;
  readonly rootKey: string;
  readonly repository: RepositoryRecord;
  readonly descriptor: WorkspaceDiffComparisonDescriptor;
  readonly baseSelection: WorkspaceDiffRevisionSelection;
  readonly headSelection: WorkspaceDiffRevisionSelection;
  readonly effectiveBaseHash?: string;
  files?: ComparisonFileRecord[];
  filesTruncated?: boolean;
  lastUsedAt: number;
}

function normalizedPath(value: string): string | undefined {
  const normalized = value.split(path.sep).join("/");
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, "utf8") > WORKSPACE_FILE_MAX_PATH_BYTES ||
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) =>
      part === "" || part === "." || part === ".."
    )
  ) return undefined;
  return normalized;
}

function safePath(value: string): string | undefined {
  const normalized = normalizedPath(value);
  return normalized &&
      !/[\u0000-\u001f\u007f]/u.test(normalized) &&
      !isSensitiveWorkspacePath(normalized) &&
      !isWorkspaceFileWriteTemporaryPath(normalized)
    ? normalized
    : undefined;
}

export function compareWorkspaceDiffRevisionDescriptors(
  left: WorkspaceDiffRevisionDescriptor,
  right: WorkspaceDiffRevisionDescriptor,
): number {
  const kindOrder = left.kind.localeCompare(right.kind);
  if (kindOrder !== 0) return kindOrder;
  if (left.kind === "commit" && right.kind === "commit") {
    const leftCommittedAt = left.committedAt ? Date.parse(left.committedAt) : Number.NaN;
    const rightCommittedAt = right.committedAt ? Date.parse(right.committedAt) : Number.NaN;
    const leftHasDate = Number.isFinite(leftCommittedAt);
    const rightHasDate = Number.isFinite(rightCommittedAt);
    if (leftHasDate !== rightHasDate) return leftHasDate ? -1 : 1;
    if (leftHasDate && leftCommittedAt !== rightCommittedAt) {
      return rightCommittedAt - leftCommittedAt;
    }
  }
  return left.label.localeCompare(right.label) || left.commitHash.localeCompare(right.commitHash);
}

function digest(...values: (string | Buffer)[]): WorkspaceDiffFingerprint {
  const hash = createHash("sha256");
  for (const value of values) hash.update(value).update("\0");
  return workspaceDiffFingerprintSchema.parse(hash.digest("base64url"));
}

function isMaximumBufferError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    LC_ALL: "C",
  };
}

function gitPrefix(repository: RepositoryRecord): string[] {
  return [
    "--no-pager",
    "--no-replace-objects",
    "-c", "core.pager=cat",
    "-c", "pager.diff=false",
    "-c", "diff.external=",
    "-c", "core.attributesFile=/dev/null",
    "-c", "core.hooksPath=/dev/null",
    "-C", repository.repositoryPath,
  ];
}

function unavailable(diagnosticCode: string) {
  return { status: "unavailable" as const, diagnosticCode };
}

function changeKind(status: string): WorkspaceDiffChangedFileSummary["changeKind"] {
  if (status.startsWith("A")) return "added";
  if (status.startsWith("D")) return "deleted";
  if (status.startsWith("R")) return "renamed";
  if (status.startsWith("C")) return "copied";
  if (status.startsWith("T")) return "type_changed";
  if (status.startsWith("U")) return "unmerged";
  return "modified";
}

export class WorkspaceDiffsEngine {
  readonly #signals = new AsyncLocalStorage<AbortSignal>();
  readonly #repositories = new Map<WorkspaceDiffRepositoryId, RepositoryRecord>();
  readonly #repositoryIds = new Map<string, WorkspaceDiffRepositoryId>();
  readonly #revisions = new Map<WorkspaceDiffRevisionId, RevisionRecord>();
  readonly #revisionIds = new Map<string, WorkspaceDiffRevisionId>();
  readonly #comparisons = new Map<string, ComparisonRecord>();
  readonly #comparisonIds = new Map<string, string>();
  readonly #clock: () => number;
  readonly #comparisonIdleTtlMs: number;
  readonly #maximumComparisons: number;

  constructor(input: { readonly testHooks?: WorkspaceDiffsEngineTestHooks } = {}) {
    this.#clock = input.testHooks?.clock ?? Date.now;
    this.#comparisonIdleTtlMs =
      input.testHooks?.comparisonIdleTtlMs ??
      WORKSPACE_DIFF_COMPARISON_IDLE_TTL_MS;
    this.#maximumComparisons =
      input.testHooks?.maximumComparisons ??
      WORKSPACE_DIFF_MAX_LIVE_COMPARISONS;
  }

  repositories(root: WorkspaceDiffsEngineRoot, signal?: AbortSignal): Promise<WorkspaceDiffRepositoriesResult> {
    return this.#operate(signal, () => this.#repositoriesForRoot(root));
  }

  refCatalog(root: WorkspaceDiffsEngineRoot, query: WorkspaceDiffRefCatalogQuery, signal?: AbortSignal): Promise<WorkspaceDiffRefCatalogResult> {
    return this.#operate(signal, () => this.#refCatalogForRoot(root, query));
  }

  createComparison(root: WorkspaceDiffsEngineRoot, input: WorkspaceDiffComparisonCreateRequest, signal?: AbortSignal): Promise<WorkspaceDiffComparisonCreateResult> {
    return this.#operate(signal, () => this.#createComparisonForRoot(root, input));
  }

  changedFiles(root: WorkspaceDiffsEngineRoot, query: WorkspaceDiffChangedFilesQuery, signal?: AbortSignal): Promise<WorkspaceDiffChangedFilesResult> {
    return this.#operate(signal, () => this.#changedFilesForRoot(root, query));
  }

  patch(root: WorkspaceDiffsEngineRoot, input: WorkspaceDiffFileRequest, signal?: AbortSignal): Promise<WorkspaceDiffPatchResult> {
    return this.#operate(signal, () => this.#patchForRoot(root, input));
  }

  fileContent(root: WorkspaceDiffsEngineRoot, input: WorkspaceDiffFileContentRequest, signal?: AbortSignal): Promise<WorkspaceDiffFileContentResult> {
    return this.#operate(signal, () => this.#fileContentForRoot(root, input));
  }

  reviewIdentity(root: WorkspaceDiffsEngineRoot, input: WorkspaceDiffReviewIdentityRequest, signal?: AbortSignal): Promise<WorkspaceDiffReviewIdentityResult> {
    return this.#operate(signal, () => this.#reviewIdentityForRoot(root, input));
  }

  validateReviewAnchor(root: WorkspaceDiffsEngineRoot, input: WorkspaceDiffReviewAnchorRequest, signal?: AbortSignal): Promise<WorkspaceDiffReviewAnchorResult> {
    return this.#operate(signal, () => this.#validateReviewAnchorForRoot(root, input));
  }

  validateReviewedFile(root: WorkspaceDiffsEngineRoot, input: WorkspaceDiffReviewedFileRequest, signal?: AbortSignal): Promise<WorkspaceDiffReviewedFileResult> {
    return this.#operate(signal, () => this.#validateReviewedFileForRoot(root, input));
  }

  reviewRepositoryIdentity(root: WorkspaceDiffsEngineRoot, input: WorkspaceDiffReviewRepositoryIdentityRequest, signal?: AbortSignal): Promise<WorkspaceDiffReviewRepositoryIdentityResult> {
    return this.#operate(signal, () => this.#reviewRepositoryIdentityForRoot(root, input));
  }

  #operate<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    this.#prune();
    return this.#run(signal, async () => {
      try {
        return await operation();
      } finally {
        this.#prune();
      }
    });
  }

  #run<T>(signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    if (!signal) return operation();
    if (signal.aborted) {
      return Promise.reject(
        signal.reason ?? new DOMException("The operation was aborted", "AbortError"),
      );
    }
    return this.#signals.run(signal, () => {
      return new Promise<T>((resolve, reject) => {
        const aborted = () => reject(
          signal.reason ?? new DOMException("The operation was aborted", "AbortError"),
        );
        signal.addEventListener("abort", aborted, { once: true });
        operation().then(resolve, reject).finally(() =>
          signal.removeEventListener("abort", aborted));
      });
    });
  }

  async #repositoriesForRoot(
    rootTarget: WorkspaceDiffsEngineRoot,
  ): Promise<WorkspaceDiffRepositoriesResult> {
    const root = await this.#validatedRoot(rootTarget);
    const probe = await this.#rawGit(root, ["rev-parse", "--show-toplevel"], 16_384)
      .catch(() => undefined);
    if (!probe) return { status: "available", repositories: [] };
    const repositoryPath = await realpath(probe.stdout.trim()).catch(() => undefined);
    if (!repositoryPath || !pathIsWithin(repositoryPath, root)) {
      return unavailable("workspace_diff_repository_unavailable");
    }
    const relativePrefix = path.relative(repositoryPath, root).split(path.sep).join("/");
    const pathPrefix = relativePrefix === "" ? undefined : safePath(relativePrefix);
    if (relativePrefix !== "" && !pathPrefix) {
      return unavailable("workspace_diff_repository_unavailable");
    }
    const key = `${rootTarget.operationKey}\0${rootTarget.rootId}\0${root}\0${repositoryPath}`;
    const durableKey =
      `${rootTarget.durableRootKey}\0${rootTarget.rootId}\0${root}\0${repositoryPath}`;
    let repositoryId = this.#repositoryIds.get(key);
    if (!repositoryId) {
      repositoryId = workspaceDiffRepositoryIdSchema.parse(randomUUID());
      this.#repositoryIds.set(key, repositoryId);
    }
    const headHash = await this.#rawGit(root, ["rev-parse", "--verify", "HEAD^{commit}"], 1_024)
      .then(({ stdout }) => stdout.trim())
      .catch(() => undefined);
    const label = await this.#rawGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], 4_096)
      .then(({ stdout }) => stdout.trim() || undefined)
      .catch(() => undefined);
    const descriptor: WorkspaceDiffRepositoryDescriptor = {
      repositoryId,
      rootId: rootTarget.rootId,
      displayName: path.basename(repositoryPath),
      ...(pathPrefix ? { pathPrefix } : {}),
      ...(headHash && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headHash)
        ? { head: { commitHash: headHash, shortHash: headHash.slice(0, 12), ...(label ? { label } : {}) } }
        : {}),
    };
    const record: RepositoryRecord = {
      key,
      durableKey,
      repositoryId,
      operationKey: rootTarget.operationKey,
      rootId: rootTarget.rootId,
      rootPath: root,
      repositoryPath,
      ...(pathPrefix ? { pathPrefix } : {}),
      descriptor,
      lastUsedAt: this.#clock(),
    };
    this.#repositories.set(repositoryId, record);
    return { status: "available", repositories: [descriptor] };
  }

  async #refCatalogForRoot(
    rootTarget: WorkspaceDiffsEngineRoot,
    query: WorkspaceDiffRefCatalogQuery,
  ): Promise<WorkspaceDiffRefCatalogResult> {
    const repository = await this.#repository(rootTarget, query.repositoryId);
    if (!repository) return unavailable("workspace_diff_repository_unavailable");
    const requested = Math.min(query.pageSize, WORKSPACE_DIFF_MAX_REFS);
    let refs: string;
    try {
      ({ stdout: refs } = await this.#git(repository, [
        "for-each-ref",
        `--count=${requested + 1}`,
        "--format=%(refname)%00%(objectname)%00%(*objectname)%00%(objecttype)%00%(*objecttype)",
        "refs/heads", "refs/remotes", "refs/tags",
      ], MAX_GIT_REF_BYTES));
    } catch {
      return unavailable("workspace_diff_ref_catalog_unavailable");
    }
    const descriptors: WorkspaceDiffRevisionDescriptor[] = [];
    let truncated = false;
    for (const line of refs.split("\n")) {
      if (!line) continue;
      if (descriptors.length >= requested) {
        truncated = true;
        break;
      }
      const [refName, objectName, peeledName, objectType, peeledType] = line.split("\0");
      if (!refName || !objectName) continue;
      const oid = objectType === "commit" ? objectName
        : peeledType === "commit" ? peeledName : undefined;
      if (!oid || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) continue;
      const classification = refName.startsWith("refs/heads/")
        ? { kind: "local_branch" as const, label: refName.slice(11) }
        : refName.startsWith("refs/remotes/")
          ? { kind: "remote_branch" as const, label: refName.slice(13) }
          : refName.startsWith("refs/tags/")
            ? { kind: "tag" as const, label: refName.slice(10) }
            : undefined;
      if (!classification || Buffer.byteLength(classification.label, "utf8") > 1_024) continue;
      descriptors.push(this.#revision(repository, classification.kind, classification.label, oid));
    }
    const remaining = Math.max(0, requested - descriptors.length);
    if (remaining > 0) {
      const recent = await this.#git(repository, [
        "log", "--all", `--max-count=${remaining + 1}`, "--format=%H%x00%ct%x00%s",
      ], MAX_GIT_REF_BYTES).catch(() => undefined);
      for (const line of recent?.stdout.split("\n") ?? []) {
        if (descriptors.length >= requested) {
          truncated = true;
          break;
        }
        const [oid, timestamp, summary] = line.split("\0");
        if (!oid || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid)) continue;
        const descriptor = this.#revision(repository, "commit", oid.slice(0, 12), oid, {
          ...(summary ? { summary: summary.slice(0, 500) } : {}),
          ...(timestamp && /^\d+$/u.test(timestamp)
            ? { committedAt: new Date(Number(timestamp) * 1_000).toISOString() }
            : {}),
        });
        if (!descriptors.some((candidate) => candidate.commitHash === oid && candidate.kind === "commit")) {
          descriptors.push(descriptor);
        }
      }
    }
    descriptors.sort(compareWorkspaceDiffRevisionDescriptors);
    return {
      status: "available",
      repositoryId: repository.repositoryId,
      revisions: descriptors.slice(0, requested),
      truncated,
    };
  }

  async #createComparisonForRoot(
    rootTarget: WorkspaceDiffsEngineRoot,
    input: WorkspaceDiffComparisonCreateRequest,
  ): Promise<WorkspaceDiffComparisonCreateResult> {
    const repository = await this.#repository(rootTarget, input.repositoryId);
    if (!repository) return unavailable("workspace_diff_repository_unavailable");
    const base = await this.#resolveEndpoint(repository, input.base);
    const head = await this.#resolveEndpoint(repository, input.head);
    if (!base || !head) return unavailable("workspace_diff_revision_unavailable");
    let mergeBaseCommitHash: string | undefined;
    let effectiveBaseHash = this.#hashForEndpoint(base);
    if (input.mode === "merge_base") {
      const baseCommit = base.kind === "revision" ? base.commitHash : undefined;
      const headCommit = head.kind === "revision" ? head.commitHash : undefined;
      if (!baseCommit || !headCommit) return unavailable("workspace_diff_merge_base_unavailable");
      mergeBaseCommitHash = await this.#git(repository, ["merge-base", baseCommit, headCommit], 1_024)
        .then(({ stdout }) => stdout.trim())
        .catch(() => undefined);
      if (!mergeBaseCommitHash || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(mergeBaseCommitHash)) {
        return unavailable("workspace_diff_merge_base_unavailable");
      }
      effectiveBaseHash = mergeBaseCommitHash;
    }
    const fingerprint = await this.#comparisonFingerprint(repository, input.mode, base, head, mergeBaseCommitHash);
    const dedupeKey = [
      repository.key,
      input.mode,
      JSON.stringify(base),
      JSON.stringify(head),
      mergeBaseCommitHash ?? "",
      fingerprint,
    ].join("\0");
    const existingId = this.#comparisonIds.get(dedupeKey);
    const existing = existingId ? this.#comparisons.get(existingId) : undefined;
    if (existing) {
      existing.lastUsedAt = this.#clock();
      return { status: "available", comparison: existing.descriptor };
    }
    const comparisonId = workspaceDiffComparisonIdSchema.parse(randomUUID());
    const descriptor: WorkspaceDiffComparisonDescriptor = {
      comparisonId,
      repositoryId: repository.repositoryId,
      mode: input.mode,
      base,
      head,
      ...(mergeBaseCommitHash ? { mergeBaseCommitHash } : {}),
      fingerprint,
    };
    this.#comparisons.set(comparisonId, {
      dedupeKey,
      rootKey: repository.key,
      repository,
      descriptor,
      baseSelection: input.base,
      headSelection: input.head,
      ...(effectiveBaseHash ? { effectiveBaseHash } : {}),
      lastUsedAt: this.#clock(),
    });
    this.#comparisonIds.set(dedupeKey, comparisonId);
    return { status: "available", comparison: descriptor };
  }

  async #changedFilesForRoot(
    rootTarget: WorkspaceDiffsEngineRoot,
    query: WorkspaceDiffChangedFilesQuery,
  ): Promise<WorkspaceDiffChangedFilesResult> {
    const checked = await this.#checkedComparison(rootTarget, query.comparisonId, query.fingerprint);
    if (checked.status !== "available") return checked;
    const comparison = checked.comparison;
    const files = comparison.files ?? await this.#loadChangedFiles(comparison);
    comparison.files = files;
    const afterIndex = query.after
      ? files.findIndex((file) => file.summary.fileId === query.after)
      : -1;
    if (query.after && afterIndex < 0) return unavailable("workspace_diff_cursor_unavailable");
    const start = afterIndex + 1;
    const page = files.slice(start, start + query.pageSize);
    return {
      status: "available",
      comparisonId: comparison.descriptor.comparisonId,
      fingerprint: comparison.descriptor.fingerprint,
      files: page.map((file) => file.summary),
      ...(start + page.length < files.length && page.at(-1)
        ? { nextCursor: page.at(-1)!.summary.fileId }
        : {}),
      totalFiles: files.length,
      truncated: comparison.filesTruncated ?? false,
    };
  }

  async #patchForRoot(
    rootTarget: WorkspaceDiffsEngineRoot,
    input: WorkspaceDiffFileRequest,
  ): Promise<WorkspaceDiffPatchResult> {
    const resolved = await this.#checkedFile(rootTarget, input);
    if (resolved.status !== "available") return resolved;
    const { comparison, file } = resolved;
    if (file.summary.binary) return { status: "binary" };
    if (file.untracked) {
      const side = file.newPath ? "new" as const : "old" as const;
      const content = await this.fileContent(rootTarget, { ...input, side });
      if (content.status === "binary") return { status: "binary" };
      if (content.status === "too_large") {
        return { status: "too_large", maximumBytes: WORKSPACE_DIFF_MAX_PATCH_BYTES };
      }
      if (content.status !== "available") return unavailable("workspace_diff_patch_unavailable");
      const lines = content.content.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const pathLabel = content.path;
      const added = side === "new";
      const body = lines.map((line) => `${added ? "+" : "-"}${line}`).join("\n");
      const patch = [
        `diff --git a/${pathLabel} b/${pathLabel}`,
        added ? "new file mode 100644" : "deleted file mode 100644",
        added ? "--- /dev/null" : `--- a/${pathLabel}`,
        added ? `+++ b/${pathLabel}` : "+++ /dev/null",
        added ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`,
        body,
        "",
      ].join("\n");
      if (Buffer.byteLength(patch, "utf8") > WORKSPACE_DIFF_MAX_PATCH_BYTES) {
        return { status: "too_large", maximumBytes: WORKSPACE_DIFF_MAX_PATCH_BYTES };
      }
      return {
        status: "available", comparisonId: input.comparisonId,
        fingerprint: input.fingerprint, fileId: input.fileId, patch,
      };
    }
    const args = this.#diffArguments(comparison);
    if (!args) return {
      status: "available", comparisonId: input.comparisonId,
      fingerprint: input.fingerprint, fileId: input.fileId, patch: "",
    };
    try {
      const paths = [file.repositoryOldPath, file.repositoryNewPath]
        .filter((value): value is string => value !== undefined);
      const { stdout } = await this.#git(comparison.repository, [
        ...args, "--no-ext-diff", "--no-textconv", "--find-renames", "--find-copies", "--", ...new Set(paths),
      ], WORKSPACE_DIFF_MAX_PATCH_BYTES);
      if (Buffer.byteLength(stdout, "utf8") > WORKSPACE_DIFF_MAX_PATCH_BYTES) {
        return { status: "too_large", maximumBytes: WORKSPACE_DIFF_MAX_PATCH_BYTES };
      }
      return {
        status: "available", comparisonId: input.comparisonId,
        fingerprint: input.fingerprint, fileId: input.fileId, patch: stdout,
      };
    } catch (error) {
      return isMaximumBufferError(error)
        ? { status: "too_large", maximumBytes: WORKSPACE_DIFF_MAX_PATCH_BYTES }
        : unavailable("workspace_diff_patch_unavailable");
    }
  }

  async #fileContentForRoot(
    rootTarget: WorkspaceDiffsEngineRoot,
    input: WorkspaceDiffFileContentRequest,
  ): Promise<WorkspaceDiffFileContentResult> {
    const resolved = await this.#checkedFile(rootTarget, input);
    if (resolved.status !== "available") return resolved;
    const { comparison, file } = resolved;
    const scopedPath = input.side === "old" ? file.oldPath : file.newPath;
    const repositoryPath = input.side === "old" ? file.repositoryOldPath : file.repositoryNewPath;
    if (!scopedPath || !repositoryPath) return { status: "absent" };
    const endpoint = input.side === "old"
      ? comparison.descriptor.base : comparison.descriptor.head;
    const effectiveEndpoint = input.side === "old" && comparison.effectiveBaseHash
      ? comparison.effectiveBaseHash : this.#hashForEndpoint(endpoint);
    let bytes: Buffer;
    let revision: string;
    if (endpoint.kind === "working_tree" && !effectiveEndpoint) {
      const loaded = await this.#readWorkingFile(comparison.repository, scopedPath);
      if (!loaded) return unavailable("workspace_diff_file_unavailable");
      if (loaded.sizeBytes > WORKSPACE_DIFF_MAX_SIDE_BYTES) {
        return { status: "too_large", sizeBytes: loaded.sizeBytes, maximumBytes: WORKSPACE_DIFF_MAX_SIDE_BYTES };
      }
      bytes = loaded.bytes;
      revision = digest(bytes);
    } else {
      if (!effectiveEndpoint) return { status: "absent" };
      const spec = `${effectiveEndpoint}:${repositoryPath}`;
      const size = await this.#git(comparison.repository, ["cat-file", "-s", spec], 1_024)
        .then(({ stdout }) => Number(stdout.trim()))
        .catch(() => undefined);
      if (size === undefined || !Number.isSafeInteger(size) || size < 0) return { status: "absent" };
      if (size > WORKSPACE_DIFF_MAX_SIDE_BYTES) {
        return { status: "too_large", sizeBytes: size, maximumBytes: WORKSPACE_DIFF_MAX_SIDE_BYTES };
      }
      const content = await this.#gitBuffer(comparison.repository, ["show", spec], WORKSPACE_DIFF_MAX_SIDE_BYTES)
        .catch(() => undefined);
      if (!content) return unavailable("workspace_diff_file_unavailable");
      bytes = content;
      revision = await this.#git(comparison.repository, ["rev-parse", spec], 1_024)
        .then(({ stdout }) => stdout.trim()).catch(() => digest(bytes));
    }
    const classification = classifyWorkspaceFileBytes({ relativePath: scopedPath, bytes, truncated: false });
    if (classification.kind !== "text") return { status: "binary" };
    return {
      status: "available", comparisonId: input.comparisonId,
      fingerprint: input.fingerprint, fileId: input.fileId, side: input.side,
      path: scopedPath, content: classification.content, revision,
    };
  }

  async #reviewIdentityForRoot(
    rootTarget: WorkspaceDiffsEngineRoot,
    input: WorkspaceDiffReviewIdentityRequest,
  ): Promise<WorkspaceDiffReviewIdentityResult> {
    const checked = await this.#checkedComparison(rootTarget, input.comparisonId, input.fingerprint);
    if (checked.status !== "available") return checked;
    const { descriptor, repository } = checked.comparison;
    const stateEndpoint = (endpoint: WorkspaceDiffResolvedEndpoint) => endpoint.kind === "revision"
      ? { kind: "revision" as const, commitHash: endpoint.commitHash }
      : endpoint.kind === "index"
        ? { kind: "index" as const, treeHash: endpoint.treeHash }
        : { kind: "working_tree" as const, stateFingerprint: descriptor.fingerprint };
    return {
      status: "available",
      identity: {
        repositoryKey: this.#repositoryKey(repository),
        mode: descriptor.mode,
        base: stateEndpoint(descriptor.base),
        head: stateEndpoint(descriptor.head),
        ...(descriptor.mergeBaseCommitHash ? { mergeBaseCommitHash: descriptor.mergeBaseCommitHash } : {}),
        fingerprint: descriptor.fingerprint,
      },
    };
  }

  async #validateReviewAnchorForRoot(
    rootTarget: WorkspaceDiffsEngineRoot,
    input: WorkspaceDiffReviewAnchorRequest,
  ): Promise<WorkspaceDiffReviewAnchorResult> {
    if (
      input.endLine - input.startLine + 1 >
      WORKSPACE_DIFF_MAX_REVIEW_SELECTION_LINES
    ) return { status: "line_unavailable" };
    const checked = await this.#checkedFile(rootTarget, input);
    if (checked.status !== "available") return checked;
    const patchResult = await this.patch(rootTarget, input);
    if (patchResult.status === "too_large") {
      return unavailable("workspace_diff_review_patch_too_large");
    }
    if (patchResult.status !== "available") return patchResult;
    const hunk = this.#displayedHunk(patchResult.patch, input.side, input.startLine, input.endLine);
    if (!hunk) return { status: "line_unavailable" };
    const content = await this.fileContent(rootTarget, input);
    if (content.status !== "available") return content;
    const lineCount = content.content.length === 0 ? 1 : content.content.split("\n").length;
    if (input.endLine > lineCount) return { status: "line_unavailable" };
    const identity = await this.reviewIdentity(rootTarget, input);
    if (identity.status !== "available") return identity;
    const oldContentId = await this.#sideContentId(checked.comparison, checked.file, "old");
    const newContentId = await this.#sideContentId(checked.comparison, checked.file, "new");
    if (oldContentId === undefined || newContentId === undefined) {
      return unavailable("workspace_diff_review_content_identity_unavailable");
    }
    const selectedText = content.content.split("\n")
      .slice(input.startLine - 1, input.endLine).join("\n");
    if (Buffer.byteLength(selectedText, "utf8") > 64 * 1_024) {
      return { status: "line_unavailable" };
    }
    return {
      status: "available",
      anchor: {
        repositoryKey: identity.identity.repositoryKey,
        comparisonFingerprint: input.fingerprint,
        reviewFileIdentity: this.#reviewFileIdentity(
          identity.identity.repositoryKey,
          identity.identity.base,
          identity.identity.head,
          checked.file,
          oldContentId,
          newContentId,
        ),
        side: input.side,
        ...(checked.file.oldPath ? { oldPath: checked.file.oldPath } : {}),
        ...(checked.file.newPath ? { newPath: checked.file.newPath } : {}),
        oldContentId,
        newContentId,
        selectedText,
        selectedTextSha256: createHash("sha256").update(selectedText).digest("hex"),
        hunkFingerprint: digest(hunk),
        startLine: input.startLine,
        endLine: input.endLine,
      },
    };
  }

  async #validateReviewedFileForRoot(
    rootTarget: WorkspaceDiffsEngineRoot,
    input: WorkspaceDiffReviewedFileRequest,
  ): Promise<WorkspaceDiffReviewedFileResult> {
    const checked = await this.#checkedFile(rootTarget, input);
    if (checked.status !== "available") return checked;
    const { comparison, file } = checked;
    if (comparison.filesTruncated || file.summary.changeKind === "unmerged") {
      return unavailable("workspace_diff_review_file_ineligible");
    }
    const patch = await this.patch(rootTarget, input);
    if (patch.status !== "available" && patch.status !== "binary") {
      return unavailable("workspace_diff_review_file_ineligible");
    }
    const [oldContentId, newContentId, identity] = await Promise.all([
      this.#sideContentId(comparison, file, "old"),
      this.#sideContentId(comparison, file, "new"),
      this.reviewIdentity(rootTarget, input),
    ]);
    if (
      oldContentId === undefined || newContentId === undefined ||
      (oldContentId === null && newContentId === null) ||
      identity.status !== "available"
    ) return unavailable("workspace_diff_review_content_identity_unavailable");
    const reviewFileIdentity = this.#reviewFileIdentity(
      identity.identity.repositoryKey,
      identity.identity.base,
      identity.identity.head,
      file,
      oldContentId,
      newContentId,
    );
    return {
      status: "available",
      file: {
        repositoryKey: identity.identity.repositoryKey,
        comparisonFingerprint: input.fingerprint,
        reviewFileIdentity,
        path: file.newPath ?? file.oldPath!,
        contentFingerprint: digest(
          oldContentId ?? "absent", newContentId ?? "absent",
          patch.status === "available" ? patch.patch : "binary",
        ),
        binary: patch.status === "binary",
        eligible: true,
      },
    };
  }

  async #reviewRepositoryIdentityForRoot(
    rootTarget: WorkspaceDiffsEngineRoot,
    input: WorkspaceDiffReviewRepositoryIdentityRequest,
  ): Promise<WorkspaceDiffReviewRepositoryIdentityResult> {
    const repository = await this.#repository(rootTarget, input.repositoryId);
    return repository
      ? { status: "available", repositoryKey: this.#repositoryKey(repository) }
      : unavailable("workspace_diff_repository_unavailable");
  }

  #repositoryKey(repository: RepositoryRecord): string {
    return digest(repository.durableKey, repository.repositoryPath);
  }

  #reviewFileIdentity(
    repositoryKey: string,
    base: unknown,
    head: unknown,
    file: ComparisonFileRecord,
    oldContentId: string | null,
    newContentId: string | null,
  ): string {
    return digest(
      repositoryKey, JSON.stringify(base), JSON.stringify(head),
      file.oldPath ?? "", file.newPath ?? "",
      oldContentId ?? "absent", newContentId ?? "absent",
    );
  }

  async #sideContentId(
    comparison: ComparisonRecord,
    file: ComparisonFileRecord,
    side: "old" | "new",
  ): Promise<string | null | undefined> {
    const scopedPath = side === "old" ? file.oldPath : file.newPath;
    const repositoryPath = side === "old" ? file.repositoryOldPath : file.repositoryNewPath;
    if (!scopedPath || !repositoryPath) return null;
    const endpoint = side === "old" ? comparison.descriptor.base : comparison.descriptor.head;
    const effective = side === "old" && comparison.effectiveBaseHash
      ? comparison.effectiveBaseHash : this.#hashForEndpoint(endpoint);
    if (endpoint.kind !== "working_tree" || effective) {
      if (!effective) return undefined;
      return this.#git(comparison.repository, ["rev-parse", `${effective}:${repositoryPath}`], 1_024)
        .then(({ stdout }) => stdout.trim() || undefined).catch(() => undefined);
    }
    const loaded = await this.#readWorkingFile(comparison.repository, scopedPath);
    if (!loaded || loaded.sizeBytes > WORKSPACE_DIFF_MAX_SIDE_BYTES) return undefined;
    return digest(loaded.bytes);
  }

  #displayedHunk(
    patch: string,
    side: "old" | "new",
    startLine: number,
    endLine: number,
  ): string | undefined {
    const lines = patch.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[index] ?? "");
      if (!match) continue;
      let oldLine = Number(match[1]);
      let newLine = Number(match[3]);
      const hunk: string[] = [lines[index]!];
      const visible = new Set<number>();
      for (index += 1; index < lines.length && !lines[index]?.startsWith("@@ "); index += 1) {
        const line = lines[index]!;
        if (line.startsWith("diff --git ")) break;
        hunk.push(line);
        if (line.startsWith("\\")) continue;
        if (line.startsWith("-")) {
          if (side === "old") visible.add(oldLine);
          oldLine += 1;
        } else if (line.startsWith("+")) {
          if (side === "new") visible.add(newLine);
          newLine += 1;
        } else {
          if (side === "old") visible.add(oldLine);
          else visible.add(newLine);
          oldLine += 1;
          newLine += 1;
        }
      }
      let complete = true;
      for (let line = startLine; line <= endLine; line += 1) {
        if (!visible.has(line)) complete = false;
      }
      if (complete) return hunk.join("\n");
      index -= 1;
    }
    return undefined;
  }

  #revision(
    repository: RepositoryRecord,
    kind: WorkspaceDiffRevisionDescriptor["kind"],
    label: string,
    oid: string,
    extra: Pick<WorkspaceDiffRevisionDescriptor, "summary" | "committedAt"> = {},
  ): WorkspaceDiffRevisionDescriptor {
    const key = `${repository.repositoryId}\0${kind}\0${label}\0${oid}`;
    let revisionId = this.#revisionIds.get(key);
    if (!revisionId) {
      revisionId = workspaceDiffRevisionIdSchema.parse(randomUUID());
      this.#revisionIds.set(key, revisionId);
    }
    const descriptor = { revisionId, kind, label, commitHash: oid, shortHash: oid.slice(0, 12), ...extra };
    this.#revisions.set(revisionId, {
      key,
      repositoryId: repository.repositoryId,
      revisionId,
      oid,
      descriptor,
      lastUsedAt: this.#clock(),
    });
    return descriptor;
  }

  async #resolveEndpoint(
    repository: RepositoryRecord,
    selection: WorkspaceDiffRevisionSelection,
  ): Promise<WorkspaceDiffResolvedEndpoint | undefined> {
    if (selection.kind === "revision") {
      const revision = this.#revisions.get(selection.revisionId);
      if (revision?.repositoryId === repository.repositoryId) {
        revision.lastUsedAt = this.#clock();
      }
      return revision?.repositoryId === repository.repositoryId
        ? { kind: "revision", revisionId: revision.revisionId, commitHash: revision.oid, label: revision.descriptor.label }
        : undefined;
    }
    if (selection.kind === "index") {
      const treeHash = await this.#git(repository, ["write-tree"], 1_024)
        .then(({ stdout }) => stdout.trim()).catch(() => undefined);
      return treeHash && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(treeHash)
        ? { kind: "index", treeHash } : undefined;
    }
    return { kind: "working_tree" };
  }

  #hashForEndpoint(endpoint: WorkspaceDiffResolvedEndpoint): string | undefined {
    return endpoint.kind === "revision" ? endpoint.commitHash
      : endpoint.kind === "index" ? endpoint.treeHash : undefined;
  }

  async #headCommit(repository: RepositoryRecord): Promise<string | undefined> {
    return this.#git(repository, ["rev-parse", "--verify", "HEAD^{commit}"], 1_024)
      .then(({ stdout }) => stdout.trim()).catch(() => undefined);
  }

  async #comparisonFingerprint(
    repository: RepositoryRecord,
    mode: string,
    base: WorkspaceDiffResolvedEndpoint,
    head: WorkspaceDiffResolvedEndpoint,
    mergeBase?: string,
  ): Promise<WorkspaceDiffFingerprint> {
    const endpointIdentity = async (endpoint: WorkspaceDiffResolvedEndpoint): Promise<string> => {
      if (endpoint.kind === "revision") return `revision:${endpoint.commitHash}`;
      if (endpoint.kind === "index") {
        const current = await this.#git(repository, ["write-tree"], 1_024)
          .then(({ stdout }) => stdout.trim());
        return `index:${current}`;
      }
      return `working:${await this.#workingTreeFingerprint(repository)}`;
    };
    return digest(
      repository.durableKey,
      mode,
      await endpointIdentity(base),
      await endpointIdentity(head),
      mergeBase ?? "",
    );
  }

  async #workingTreeFingerprint(repository: RepositoryRecord): Promise<string> {
    const status = await this.#git(repository, [
      "-c", "status.relativePaths=true", "status", "--porcelain=v1", "-z",
      "--untracked-files=all", "--", ...(repository.pathPrefix ? [repository.pathPrefix] : ["."]),
    ], MAX_GIT_METADATA_BYTES);
    const hash = createHash("sha256").update(status.stdout);
    const records = status.stdout.split("\0");
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      const raw = record.slice(3);
      const repositoryRelative = safePath(raw);
      if (record.slice(0, 2).includes("R") || record.slice(0, 2).includes("C")) index += 1;
      const scoped = repositoryRelative ? this.#scopedPath(repository, repositoryRelative) : undefined;
      if (!scoped) continue;
      const loaded = await this.#workingFileFingerprint(repository, scoped);
      if (loaded) hash.update(scoped).update("\0").update(loaded);
    }
    return hash.digest("base64url");
  }

  async #checkedComparison(root: WorkspaceDiffsEngineRoot, id: string, fingerprint: string): Promise<
    | { status: "available"; comparison: ComparisonRecord }
    | { status: "stale"; currentFingerprint: WorkspaceDiffFingerprint }
    | { status: "unavailable"; diagnosticCode: string }
  > {
    await this.#validatedRoot(root);
    const comparison = this.#comparisons.get(id);
    if (!comparison || comparison.rootKey !== this.#rootKey(root, comparison.repository.repositoryPath)) {
      return unavailable("workspace_diff_comparison_unavailable");
    }
    const current = await this.#comparisonFingerprint(
      comparison.repository, comparison.descriptor.mode,
      comparison.descriptor.base, comparison.descriptor.head,
      comparison.descriptor.mergeBaseCommitHash,
    ).catch(() => undefined);
    if (!current) return unavailable("workspace_diff_comparison_unavailable");
    if (current !== fingerprint || fingerprint !== comparison.descriptor.fingerprint) {
      return { status: "stale", currentFingerprint: current };
    }
    comparison.lastUsedAt = this.#clock();
    return { status: "available", comparison };
  }

  async #checkedFile(root: WorkspaceDiffsEngineRoot, input: WorkspaceDiffFileRequest) {
    const checked = await this.#checkedComparison(root, input.comparisonId, input.fingerprint);
    if (checked.status !== "available") return checked;
    const files = checked.comparison.files ?? await this.#loadChangedFiles(checked.comparison);
    checked.comparison.files = files;
    const file = files.find((candidate) => candidate.summary.fileId === input.fileId);
    return file ? { status: "available" as const, comparison: checked.comparison, file }
      : unavailable("workspace_diff_file_unavailable");
  }

  #diffArguments(comparison: ComparisonRecord): string[] | undefined {
    const baseHash = comparison.effectiveBaseHash ?? this.#hashForEndpoint(comparison.descriptor.base);
    const headHash = this.#hashForEndpoint(comparison.descriptor.head);
    const baseWorking = comparison.descriptor.base.kind === "working_tree" && !comparison.effectiveBaseHash;
    const headWorking = comparison.descriptor.head.kind === "working_tree";
    if (baseWorking && headWorking) return undefined;
    if (headWorking && baseHash) return ["diff", baseHash];
    if (baseWorking && headHash) return ["diff", "-R", headHash];
    if (baseHash && headHash) return ["diff", baseHash, headHash];
    return undefined;
  }

  async #loadChangedFiles(comparison: ComparisonRecord): Promise<ComparisonFileRecord[]> {
    const args = this.#diffArguments(comparison);
    if (!args) return [];
    const pathspec = comparison.repository.pathPrefix ?? ".";
    const raw = await this.#git(comparison.repository, [
      ...args, "--raw", "-z", "--no-abbrev", "--no-ext-diff", "--no-textconv",
      "--find-renames", "--find-copies", "--", pathspec,
    ], MAX_GIT_METADATA_BYTES).catch(() => undefined);
    if (!raw) return [];
    const numstat = await this.#git(comparison.repository, [
      ...args, "--numstat", "-z", "--no-ext-diff", "--no-textconv",
      "--find-renames", "--find-copies", "--", pathspec,
    ], MAX_GIT_METADATA_BYTES).catch(() => undefined);
    const stats = this.#parseNumstat(numstat?.stdout ?? "");
    const records = raw.stdout.split("\0");
    const files: ComparisonFileRecord[] = [];
    for (let index = 0; index < records.length && files.length <= WORKSPACE_DIFF_MAX_CHANGED_FILES; index += 1) {
      const header = records[index];
      if (!header?.startsWith(":")) continue;
      const fields = header.slice(1).split(" ");
      if (fields.length < 5) continue;
      const status = fields[4]!;
      const first = records[++index];
      const second = status.startsWith("R") || status.startsWith("C") ? records[++index] : undefined;
      if (!first) continue;
      const oldRepo = status.startsWith("A") ? undefined : first;
      const newRepo = status.startsWith("D") ? undefined : second ?? first;
      const oldPath = oldRepo ? this.#scopedPath(comparison.repository, oldRepo) : undefined;
      const newPath = newRepo ? this.#scopedPath(comparison.repository, newRepo) : undefined;
      if ((oldRepo && !oldPath) || (newRepo && !newPath)) continue;
      const fileId = workspaceDiffFileIdSchema.parse(randomUUID());
      const stat = stats.get(`${oldRepo ?? ""}\0${newRepo ?? ""}`) ??
        stats.get(`\0${newRepo ?? oldRepo ?? ""}`);
      files.push({
        summary: {
          fileId, changeKind: changeKind(status),
          ...(oldPath ? { oldPath } : {}), ...(newPath ? { newPath } : {}),
          ...(fields[0] ? { oldMode: fields[0] } : {}),
          ...(fields[1] ? { newMode: fields[1] } : {}),
          ...(stat?.additions !== undefined ? { additions: stat.additions } : {}),
          ...(stat?.deletions !== undefined ? { deletions: stat.deletions } : {}),
          binary: stat?.binary ?? false,
        },
        ...(oldPath ? { oldPath, repositoryOldPath: oldRepo } : {}),
        ...(newPath ? { newPath, repositoryNewPath: newRepo } : {}),
      });
    }
    const includeUntrackedHead = comparison.descriptor.head.kind === "working_tree";
    const includeUntrackedBase = comparison.descriptor.base.kind === "working_tree" && !comparison.effectiveBaseHash;
    if (includeUntrackedHead !== includeUntrackedBase && files.length <= WORKSPACE_DIFF_MAX_CHANGED_FILES) {
      const untracked = await this.#git(comparison.repository, [
        "ls-files", "--others", "--exclude-standard", "-z", "--", pathspec,
      ], MAX_GIT_METADATA_BYTES).catch(() => undefined);
      for (const repositoryPath of untracked?.stdout.split("\0") ?? []) {
        if (!repositoryPath || files.length > WORKSPACE_DIFF_MAX_CHANGED_FILES) continue;
        const scoped = this.#scopedPath(comparison.repository, repositoryPath);
        if (!scoped) continue;
        const loaded = await this.#readWorkingFile(comparison.repository, scoped);
        if (!loaded) continue;
        const classification = classifyWorkspaceFileBytes({ relativePath: scoped, bytes: loaded.bytes, truncated: false });
        const fileId = workspaceDiffFileIdSchema.parse(randomUUID());
        const asAdded = includeUntrackedHead;
        files.push({
          summary: {
            fileId, changeKind: asAdded ? "added" : "deleted",
            ...(asAdded ? { newPath: scoped } : { oldPath: scoped }),
            binary: classification.kind !== "text",
          },
          ...(asAdded
            ? { newPath: scoped, repositoryNewPath: repositoryPath }
            : { oldPath: scoped, repositoryOldPath: repositoryPath }),
          untracked: true,
        });
      }
    }
    files.sort((left, right) =>
      (left.newPath ?? left.oldPath ?? "").localeCompare(right.newPath ?? right.oldPath ?? ""));
    comparison.filesTruncated = files.length > WORKSPACE_DIFF_MAX_CHANGED_FILES;
    return files.slice(0, WORKSPACE_DIFF_MAX_CHANGED_FILES);
  }

  #parseNumstat(output: string): Map<string, {
    additions?: number;
    deletions?: number;
    binary: boolean;
  }> {
    const result = new Map<string, { additions?: number; deletions?: number; binary: boolean }>();
    const records = output.split("\0");
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (!record) continue;
      const firstTab = record.indexOf("\t");
      const secondTab = record.indexOf("\t", firstTab + 1);
      if (firstTab < 0 || secondTab < 0) continue;
      const added = record.slice(0, firstTab);
      const deleted = record.slice(firstTab + 1, secondTab);
      const firstPath = record.slice(secondTab + 1);
      const renamed = firstPath === "";
      const oldPath = renamed ? records[++index] : undefined;
      const newPath = renamed ? records[++index] : firstPath;
      if (!newPath) continue;
      const binary = added === "-" || deleted === "-";
      result.set(`${oldPath ?? ""}\0${newPath}`, {
        ...(binary ? {} : { additions: Number(added), deletions: Number(deleted) }),
        binary,
      });
      if (!renamed) result.set(`\0${newPath}`, result.get(`${oldPath ?? ""}\0${newPath}`)!);
    }
    return result;
  }

  #scopedPath(repository: RepositoryRecord, repositoryRelative: string): string | undefined {
    const raw = normalizedPath(repositoryRelative);
    if (!raw) return undefined;
    const prefix = repository.pathPrefix;
    const scoped = prefix
      ? raw === prefix ? undefined : raw.startsWith(`${prefix}/`) ? raw.slice(prefix.length + 1) : undefined
      : raw;
    return scoped ? safePath(scoped) : undefined;
  }

  async #readWorkingFile(repository: RepositoryRecord, scopedPath: string): Promise<
    { bytes: Buffer; sizeBytes: number } | undefined
  > {
    if (!safePath(scopedPath)) return undefined;
    const candidate = path.join(repository.rootPath, ...scopedPath.split("/"));
    const handle = await open(candidate, "r").catch(() => undefined);
    if (!handle) return undefined;
    try {
      const canonical = await revalidatedPathForOpenHandle(handle, candidate);
      const metadata = await handle.stat().catch(() => undefined);
      if (!canonical || !pathIsWithin(repository.rootPath, canonical) || !metadata?.isFile()) return undefined;
      const maximum = WORKSPACE_DIFF_MAX_SIDE_BYTES + 1;
      const chunks: Buffer[] = [];
      let offset = 0;
      while (offset < metadata.size && offset < maximum) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, metadata.size - offset, maximum - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (bytesRead === 0) break;
        const read = chunk.subarray(0, bytesRead);
        chunks.push(read);
        offset += bytesRead;
      }
      return { bytes: Buffer.concat(chunks), sizeBytes: metadata.size };
    } finally {
      await handle.close();
    }
  }

  async #workingFileFingerprint(repository: RepositoryRecord, scopedPath: string): Promise<string | undefined> {
    if (!safePath(scopedPath)) return undefined;
    const candidate = path.join(repository.rootPath, ...scopedPath.split("/"));
    const handle = await open(candidate, "r").catch(() => undefined);
    if (!handle) return undefined;
    try {
      const canonical = await revalidatedPathForOpenHandle(handle, candidate);
      const metadata = await handle.stat().catch(() => undefined);
      if (!canonical || !pathIsWithin(repository.rootPath, canonical) || !metadata?.isFile()) return undefined;
      const hash = createHash("sha256").update(`${metadata.size}\0${metadata.mtimeMs}\0`);
      const maximum = Math.min(metadata.size, 2 * 1_024 * 1_024);
      let offset = 0;
      while (offset < maximum) {
        const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, maximum - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (bytesRead === 0) break;
        hash.update(chunk.subarray(0, bytesRead));
        offset += bytesRead;
      }
      return hash.digest("base64url");
    } finally {
      await handle.close();
    }
  }

  #prune(): void {
    const now = this.#clock();
    for (const [comparisonId, comparison] of this.#comparisons) {
      if (now - comparison.lastUsedAt >= this.#comparisonIdleTtlMs) {
        this.#deleteComparison(comparisonId, comparison);
      }
    }
    if (this.#comparisons.size > this.#maximumComparisons) {
      const oldest = [...this.#comparisons.entries()].sort(
        (left, right) => left[1].lastUsedAt - right[1].lastUsedAt,
      );
      for (const [comparisonId, comparison] of oldest) {
        if (this.#comparisons.size <= this.#maximumComparisons) break;
        this.#deleteComparison(comparisonId, comparison);
      }
    }

    const protectedRevisionIds = new Set<string>();
    for (const comparison of this.#comparisons.values()) {
      if (comparison.baseSelection.kind === "revision") {
        protectedRevisionIds.add(comparison.baseSelection.revisionId);
      }
      if (comparison.headSelection.kind === "revision") {
        protectedRevisionIds.add(comparison.headSelection.revisionId);
      }
    }
    for (const [revisionId, revision] of this.#revisions) {
      if (
        !protectedRevisionIds.has(revisionId) &&
        now - revision.lastUsedAt >= WORKSPACE_DIFF_REVISION_IDLE_TTL_MS
      ) {
        this.#deleteRevision(revisionId, revision);
      }
    }
    const revisionCounts = new Map<WorkspaceDiffRepositoryId, number>();
    for (const revision of this.#revisions.values()) {
      revisionCounts.set(
        revision.repositoryId,
        (revisionCounts.get(revision.repositoryId) ?? 0) + 1,
      );
    }
    const revisionCandidates = [...this.#revisions.entries()]
      .filter(([revisionId]) => !protectedRevisionIds.has(revisionId))
      .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
    for (const [revisionId, revision] of revisionCandidates) {
      const repositoryCount = revisionCounts.get(revision.repositoryId) ?? 0;
      if (
        this.#revisions.size <= WORKSPACE_DIFF_MAX_LIVE_REVISIONS &&
        repositoryCount <= WORKSPACE_DIFF_MAX_LIVE_REVISIONS_PER_REPOSITORY
      ) continue;
      this.#deleteRevision(revisionId, revision);
      revisionCounts.set(revision.repositoryId, repositoryCount - 1);
    }

    const repositoryHasDependencies = (
      repositoryId: WorkspaceDiffRepositoryId,
    ): boolean =>
      [...this.#revisions.values()].some((revision) =>
        revision.repositoryId === repositoryId
      ) || [...this.#comparisons.values()].some((comparison) =>
        comparison.repository.repositoryId === repositoryId
      );
    for (const [repositoryId, repository] of this.#repositories) {
      if (
        !repositoryHasDependencies(repositoryId) &&
        now - repository.lastUsedAt >= WORKSPACE_DIFF_REPOSITORY_IDLE_TTL_MS
      ) {
        this.#deleteRepository(repositoryId, repository);
      }
    }
    if (this.#repositories.size > WORKSPACE_DIFF_MAX_REPOSITORIES) {
      const candidates = [...this.#repositories.entries()]
        .filter(([repositoryId]) => !repositoryHasDependencies(repositoryId))
        .sort((left, right) => left[1].lastUsedAt - right[1].lastUsedAt);
      for (const [repositoryId, repository] of candidates) {
        if (this.#repositories.size <= WORKSPACE_DIFF_MAX_REPOSITORIES) break;
        this.#deleteRepository(repositoryId, repository);
      }
    }
  }

  #deleteComparison(id: string, comparison: ComparisonRecord): void {
    this.#comparisons.delete(id);
    if (this.#comparisonIds.get(comparison.dedupeKey) === id) {
      this.#comparisonIds.delete(comparison.dedupeKey);
    }
  }

  #deleteRevision(id: WorkspaceDiffRevisionId, revision: RevisionRecord): void {
    this.#revisions.delete(id);
    if (this.#revisionIds.get(revision.key) === id) {
      this.#revisionIds.delete(revision.key);
    }
  }

  #deleteRepository(
    id: WorkspaceDiffRepositoryId,
    repository: RepositoryRecord,
  ): void {
    this.#repositories.delete(id);
    if (this.#repositoryIds.get(repository.key) === id) {
      this.#repositoryIds.delete(repository.key);
    }
  }

  async #repository(root: WorkspaceDiffsEngineRoot, id: WorkspaceDiffRepositoryId): Promise<RepositoryRecord | undefined> {
    await this.#validatedRoot(root);
    const repository = this.#repositories.get(id);
    if (repository && repository.key === this.#rootKey(root, repository.repositoryPath)) {
      repository.lastUsedAt = this.#clock();
      return repository;
    }
    return undefined;
  }

  #rootKey(root: WorkspaceDiffsEngineRoot, repositoryPath: string): string {
    return `${root.operationKey}\0${root.rootId}\0${root.canonicalPath}\0${repositoryPath}`;
  }

  async #validatedRoot(root: WorkspaceDiffsEngineRoot): Promise<string> {
    if (
      !root.operationKey ||
      !root.durableRootKey ||
      !path.isAbsolute(root.canonicalPath)
    ) {
      throw new WorkspaceFileRootUnavailableError();
    }
    const canonical = await realpath(root.canonicalPath).catch(() => undefined);
    const metadata = canonical ? await stat(canonical).catch(() => undefined) : undefined;
    if (canonical !== root.canonicalPath || !metadata?.isDirectory()) {
      throw new WorkspaceFileRootUnavailableError();
    }
    return canonical;
  }

  async #rawGit(cwd: string, args: string[], maxBuffer: number) {
    return executeFile("git", [
      "--no-pager", "--no-replace-objects",
      "-c", "core.pager=cat", "-c", "pager.diff=false",
      "-c", "diff.external=", "-c", "core.attributesFile=/dev/null",
      "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args,
    ], {
      encoding: "utf8", maxBuffer, env: gitEnvironment(), windowsHide: true,
      timeout: 30_000, killSignal: "SIGKILL",
      ...(this.#signals.getStore() ? { signal: this.#signals.getStore() } : {}),
    });
  }

  async #git(repository: RepositoryRecord, args: string[], maxBuffer: number) {
    return executeFile("git", [...gitPrefix(repository), ...args], {
      encoding: "utf8", maxBuffer, env: gitEnvironment(), windowsHide: true, timeout: 30_000, killSignal: "SIGKILL",
      ...(this.#signals.getStore() ? { signal: this.#signals.getStore() } : {}),
    });
  }

  async #gitBuffer(repository: RepositoryRecord, args: string[], maxBuffer: number): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      execFileCallback("git", [...gitPrefix(repository), ...args], {
        encoding: "buffer", maxBuffer, env: gitEnvironment(), windowsHide: true,
        timeout: 30_000, killSignal: "SIGKILL",
        ...(this.#signals.getStore() ? { signal: this.#signals.getStore() } : {}),
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
  }
}
