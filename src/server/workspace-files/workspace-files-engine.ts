import { normalizedAbsolutePath as isNormalizedAbsolutePath } from "../../shared/absolute-path.js";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fileConstants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  WorkspaceFileDirectoryEntry,
  WorkspaceFileGitStatusKind,
  WorkspaceFileImageMediaType,
  WorkspaceFileLinkReference,
} from "../../shared/protocol/workspace-files.js";
import {
  WORKSPACE_FILE_MAX_CONTENT_BYTES,
  WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES,
  WORKSPACE_FILE_MAX_DOWNLOAD_BYTES,
  WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES,
  WORKSPACE_FILE_MAX_PAGE_SIZE,
  WORKSPACE_FILE_MAX_PATH_BYTES,
  WORKSPACE_FILE_MAX_LINKED_WORKTREES,
} from "../../shared/workspace-file-limits.js";
import {
  openVerifiedDirectory,
  pathForOpenDescriptor,
  revalidatedPathForOpenHandle,
} from "../local-file-descriptor-path.js";
import { pathIsWithin } from "../path-containment.js";
import type {
  WorkspaceFileDiscoveredLinkRoot,
  WorkspaceFileDiscoveredLinkedWorktree,
  WorkspaceFileDownloadSource,
  WorkspaceFileRootDirectoryQuery,
  WorkspaceFileRootDownloadRequest,
  WorkspaceFileRootListQuery,
  WorkspaceFileRootWriteRequest,
  WorkspaceFileWatchSubscription,
} from "./contracts.js";
import {
  WorkspaceFileAccessError,
  WorkspaceFileCursorInvalidError,
  WorkspaceFileDownloadTooLargeError,
  WorkspaceFileRevisionConflictError,
  WorkspaceFileRootUnavailableError,
  WorkspaceLinkedWorktreeDirtyError,
  WorkspaceLinkedWorktreeRemovalRejectedError,
} from "./contracts.js";
import type { WorkspaceLinkedWorktreeRemovalTarget } from "./contracts.js";
import { LocalWorkspaceFileWatcherRegistry } from "./local-workspace-file-watcher.js";
import {
  classifyWorkspaceFileBytes,
  workspaceFileImageMediaTypeForPath,
} from "./workspace-file-content-classifier.js";
import {
  isSensitiveWorkspacePath,
  isWorkspaceFileWriteTemporaryPath,
} from "./workspace-file-policy.js";
import { CanonicalMutationSerializer } from "./canonical-mutation-serializer.js";

const executeFile = promisify(execFile);
const MAXIMUM_SCANNED_FILES = 50_000;
const MAXIMUM_SCANNED_DIRECTORIES = 50_000;
const MAXIMUM_DIRECTORY_DEPTH = 64;
const MAXIMUM_WORKTREE_DISCOVERY_DEPTH = 128;
const MAXIMUM_GIT_OUTPUT_BYTES = 16 * 1_024 * 1_024;
const MAXIMUM_LINKED_WORKTREE_OUTPUT_BYTES = 1024 * 1024;
const MAXIMUM_RETAINED_LIST_CURSORS = 8;
const LIST_CURSOR_TTL_MILLISECONDS = 2 * 60_000;

function combineAbortSignals(
  providerSignal?: AbortSignal,
  consumerSignal?: AbortSignal,
): AbortSignal | undefined {
  if (!providerSignal) return consumerSignal;
  if (!consumerSignal || consumerSignal === providerSignal)
    return providerSignal;
  return AbortSignal.any([providerSignal, consumerSignal]);
}

function isWithin(root: string, candidate: string): boolean {
  return pathIsWithin(root, candidate);
}

function isMaximumBufferError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
  );
}

function isGitNonRepositoryError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly stderr?: unknown;
  };
  return (
    candidate.code === 128 &&
    typeof candidate.stderr === "string" &&
    candidate.stderr.includes("not a git repository")
  );
}

function normalizedPath(value: string): string | undefined {
  if (
    (process.platform === "win32" &&
      !isNormalizedAbsolutePath(`C:\\${value.replaceAll("/", "\\")}`)) ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > WORKSPACE_FILE_MAX_PATH_BYTES ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return value;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && value !== undefined)
      environment[key] = value;
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

interface PorcelainWorktreeRecord {
  readonly worktreePath: string;
  readonly headOid: string;
  readonly branchRef: string | null;
  readonly prunable: boolean;
  readonly bare: boolean;
}

function parseWorktreePorcelain(
  output: string,
): readonly PorcelainWorktreeRecord[] {
  const records: PorcelainWorktreeRecord[] = [];
  let fields: string[] = [];
  const flush = (): void => {
    if (fields.length === 0) return;
    let worktreePath: string | undefined;
    let headOid: string | undefined;
    let branchRef: string | null = null;
    let prunable = false;
    let bare = false;
    for (const field of fields) {
      if (field.startsWith("worktree ")) worktreePath = field.slice(9);
      else if (field.startsWith("HEAD ")) headOid = field.slice(5);
      else if (field.startsWith("branch refs/heads/"))
        branchRef = field.slice(7);
      else if (field === "prunable" || field.startsWith("prunable "))
        prunable = true;
      else if (field === "bare") bare = true;
    }
    fields = [];
    if (
      !worktreePath ||
      !headOid ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(headOid)
    )
      return;
    if (
      branchRef &&
      (Buffer.byteLength(branchRef, "utf8") > 1_024 ||
        /[\u0000-\u001f\u007f]/u.test(branchRef))
    )
      branchRef = null;
    records.push({ worktreePath, headOid, branchRef, prunable, bare });
  };
  for (const field of output.split("\0")) {
    if (field === "") flush();
    else fields.push(field);
  }
  flush();
  return records;
}

function normalizedAbsolutePath(value: string): string | undefined {
  return path.isAbsolute(value) &&
    path.normalize(value) === value &&
    value.length > 1 &&
    !value.endsWith(path.sep) &&
    Buffer.byteLength(value, "utf8") <= WORKSPACE_FILE_MAX_PATH_BYTES &&
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

async function linkedWorktreeGitDirectory(
  worktreePath: string,
  commonDirectory: string,
): Promise<
  | { readonly canonicalGitDir: string; readonly identityToken: string }
  | undefined
> {
  const markerPath = path.join(worktreePath, ".git");
  const marker = await lstat(markerPath, { bigint: true }).catch(
    () => undefined,
  );
  if (!marker?.isFile() || marker.size > 16n * 1_024n) return undefined;
  const contents = await readFile(markerPath, "utf8").catch(() => undefined);
  const match = contents?.match(/^gitdir: ([^\r\n]+)\r?\n?$/u);
  if (!match?.[1]) return undefined;
  const declared = path.isAbsolute(match[1])
    ? path.normalize(match[1])
    : path.resolve(worktreePath, match[1]);
  const canonical = await realpath(declared).catch(() => undefined);
  const metadata = canonical
    ? await stat(canonical, { bigint: true }).catch(() => undefined)
    : undefined;
  const worktreesDirectory = path.join(commonDirectory, "worktrees");
  if (
    !canonical ||
    !metadata?.isDirectory() ||
    normalizedAbsolutePath(canonical) === undefined ||
    path.dirname(canonical) !== worktreesDirectory
  ) {
    return undefined;
  }
  const backlinkPath = path.join(canonical, "gitdir");
  const [backlink, backlinkMetadata, canonicalMarker] = await Promise.all([
    readFile(backlinkPath, "utf8").catch(() => undefined),
    stat(backlinkPath, { bigint: true }).catch(() => undefined),
    realpath(markerPath).catch(() => undefined),
  ]);
  const declaredMarker = backlink?.replace(/\r?\n$/u, "");
  if (
    !declaredMarker ||
    !backlinkMetadata?.isFile() ||
    !canonicalMarker ||
    (await realpath(declaredMarker).catch(() => undefined)) !== canonicalMarker
  ) {
    return undefined;
  }
  return {
    canonicalGitDir: canonical,
    identityToken: createHash("sha256")
      .update(
        `${metadata.dev}\0${metadata.ino}\0${metadata.birthtimeNs}\0${marker.dev}\0${marker.ino}\0${marker.birthtimeNs}\0${backlinkMetadata.dev}\0${backlinkMetadata.ino}\0${backlinkMetadata.birthtimeNs}`,
      )
      .digest("hex"),
  };
}

function revisionToken(file: Awaited<ReturnType<typeof stat>>): string {
  const bigint = file as unknown as {
    dev: bigint;
    ino: bigint;
    size: bigint;
    mtimeNs: bigint;
    ctimeNs: bigint;
  };
  return createHash("sha256")
    .update(
      `${bigint.dev}\0${bigint.ino}\0${bigint.size}\0${bigint.mtimeNs}\0${bigint.ctimeNs}`,
    )
    .digest("base64url");
}

function gitStatus(xy: string): WorkspaceFileGitStatusKind {
  if (xy === "??") return "untracked";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "conflicted";
  if (xy.includes("D")) return "deleted";
  if (xy.includes("R")) return "renamed";
  if (xy.includes("A")) return "added";
  return "modified";
}

export interface WorkspaceFilesEngineRoot {
  readonly canonicalPath: string;
  /** Adapter-owned identity used only for process-local write/watch isolation. */
  readonly operationKey: string;
}

export interface WorkspaceFilesEngineListResult {
  readonly entries: string[];
  readonly nextCursor?: string;
  readonly scanTruncated: boolean;
}

export interface WorkspaceFilesEngineDirectoryResult {
  readonly directory: string;
  readonly entries: WorkspaceFileDirectoryEntry[];
  readonly nextCursor?: string;
  readonly scanTruncated: boolean;
}

type RetainedListCursor =
  | {
      readonly kind: "tree";
      readonly rootKey: string;
      readonly entries: readonly string[];
      readonly offset: number;
      readonly scanTruncated: boolean;
      readonly expiresAt: number;
    }
  | {
      readonly kind: "directory";
      readonly rootKey: string;
      readonly directory: string;
      readonly entries: readonly WorkspaceFileDirectoryEntry[];
      readonly offset: number;
      readonly scanTruncated: boolean;
      readonly expiresAt: number;
    };

interface WorkspaceFilesEngineContentBase {
  readonly path: string;
  readonly sizeBytes: number;
  readonly revision: string;
  readonly editable: boolean;
}

interface WorkspaceFilesEngineTruncation {
  readonly truncated: true;
  readonly retainedBytes: number;
  readonly reason: "byte_limit";
}

export type WorkspaceFilesEngineContentResult =
  | (WorkspaceFilesEngineContentBase & {
      readonly contentKind: "text";
      readonly content: string;
      readonly truncation?: WorkspaceFilesEngineTruncation;
    })
  | (WorkspaceFilesEngineContentBase & {
      readonly contentKind: "binary";
      readonly content: "";
      readonly editable: false;
      readonly truncation?: WorkspaceFilesEngineTruncation;
    })
  | (WorkspaceFilesEngineContentBase & {
      readonly contentKind: "image";
      readonly previewState: "available";
      readonly mediaType: WorkspaceFileImageMediaType;
      readonly contentEncoding: "base64";
      readonly content: string;
      readonly editable: false;
    })
  | (WorkspaceFilesEngineContentBase & {
      readonly contentKind: "image";
      readonly previewState: "too_large";
      readonly mediaType: WorkspaceFileImageMediaType;
      readonly editable: false;
    });

export interface WorkspaceFilesEngineWriteResult {
  readonly path: string;
  readonly sizeBytes: number;
  readonly revision: string;
}

export interface WorkspaceFilesEngineStatusResult {
  readonly isGitRepository: boolean;
  readonly entries: {
    readonly path: string;
    readonly status: WorkspaceFileGitStatusKind;
  }[];
  readonly truncated: boolean;
}

export interface WorkspaceFilesEngineTestHooks {
  beforeWriteCommit?(): Promise<void> | void;
  beforeWalkDirectoryOpen?(relativePath: string): Promise<void> | void;
  afterReadMetadata?(relativePath: string): Promise<void> | void;
  afterDownloadMetadata?(relativePath: string): Promise<void> | void;
  beforeDownloadFinalValidation?(relativePath: string): Promise<void> | void;
  beforeLinkedWorktreeRemovalIdentityValidation?(): Promise<void> | void;
  readonly maximumGitOutputBytes?: number;
}

/**
 * Server-only implementation of workspace filesystem semantics. Application
 * scope/environment authorization and remote protocol authority stay in the
 * adapters that construct its roots.
 */
export class WorkspaceFilesEngine {
  readonly #mutations: CanonicalMutationSerializer;
  readonly #watchers: LocalWorkspaceFileWatcherRegistry;
  readonly #testHooks: WorkspaceFilesEngineTestHooks | undefined;
  readonly #listCursors = new Map<string, RetainedListCursor>();

  constructor(
    input: {
      readonly watchers?: LocalWorkspaceFileWatcherRegistry;
      readonly testHooks?: WorkspaceFilesEngineTestHooks;
      readonly mutations?: CanonicalMutationSerializer;
    } = {},
  ) {
    this.#watchers = input.watchers ?? new LocalWorkspaceFileWatcherRegistry();
    this.#testHooks = input.testHooks;
    this.#mutations = input.mutations ?? new CanonicalMutationSerializer();
  }

  /** Revalidates a canonical filesystem root without performing an operation. */
  async validateRoot(canonicalPath: string): Promise<void> {
    await this.#validatedRoot(canonicalPath);
  }

  async discoverFileLinkRoot(
    absolutePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFileDiscoveredLinkRoot | undefined> {
    signal?.throwIfAborted();
    if (!path.isAbsolute(absolutePath)) {
      return undefined;
    }
    const canonicalFile = await realpath(absolutePath).catch(() => undefined);
    signal?.throwIfAborted();
    if (!canonicalFile) return undefined;
    const canonicalParent = path.dirname(canonicalFile);
    const canonicalRoot =
      (await this.#findWorktreeRoot(canonicalParent, signal)) ?? canonicalParent;
    const relativePath = normalizedPath(
      path.relative(canonicalRoot, canonicalFile).split(path.sep).join("/"),
    );
    if (
      !relativePath ||
      isSensitiveWorkspacePath(relativePath) ||
      isWorkspaceFileWriteTemporaryPath(relativePath)
    ) {
      return undefined;
    }
    signal?.throwIfAborted();
    const handle = await open(
      absolutePath,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    ).catch(() => undefined);
    if (!handle) return undefined;
    try {
      signal?.throwIfAborted();
      const openedPath = await revalidatedPathForOpenHandle(
        handle,
        canonicalFile,
      );
      const metadata = await handle.stat().catch(() => undefined);
      if (openedPath !== canonicalFile || !metadata?.isFile()) return undefined;
      signal?.throwIfAborted();
      return { canonicalPath: canonicalRoot, relativePath };
    } finally {
      await handle.close();
    }
  }

  /** Enumerates only live linked worktrees registered to the primary root's repository. */
  async discoverLinkedWorktrees(
    rootTarget: WorkspaceFilesEngineRoot,
    signal?: AbortSignal,
    policyRoots?: readonly string[],
  ): Promise<{
    readonly worktrees: readonly WorkspaceFileDiscoveredLinkedWorktree[];
    readonly truncated: boolean;
  }> {
    signal?.throwIfAborted();
    const root = await this.#root(rootTarget);
    let stdout: string;
    let commonOutput: string;
    try {
      const options = {
        encoding: "utf8",
        maxBuffer: MAXIMUM_LINKED_WORKTREE_OUTPUT_BYTES,
        env: gitEnvironment(),
        windowsHide: true,
        timeout: 10_000,
        killSignal: "SIGKILL",
        ...(signal ? { signal } : {}),
      } as const;
      [{ stdout }, { stdout: commonOutput }] = await Promise.all([
        executeFile(
          "git",
          [
            "--no-pager",
            "--no-replace-objects",
            "-c",
            "core.pager=cat",
            "-c",
            "core.hooksPath=/dev/null",
            "-C",
            root,
            "worktree",
            "list",
            "--porcelain",
            "-z",
          ],
          options,
        ),
        executeFile(
          "git",
          [
            "--no-pager",
            "--no-replace-objects",
            "-C",
            root,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          ],
          options,
        ),
      ]);
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      // A non-repository primary has no linked-worktree topology.
      if (isGitNonRepositoryError(error)) {
        return { worktrees: [], truncated: false };
      }
      throw new Error(
        isMaximumBufferError(error)
          ? "workspace_file_linked_worktree_discovery_too_large"
          : "workspace_file_linked_worktree_discovery_failed",
        {
          cause: error,
        },
      );
    }
    const declaredCommon = commonOutput.replace(/\r?\n$/u, "");
    const commonDirectory = await realpath(declaredCommon).catch(
      () => undefined,
    );
    const commonMetadata = commonDirectory
      ? await stat(commonDirectory).catch(() => undefined)
      : undefined;
    if (
      !commonDirectory ||
      !commonMetadata?.isDirectory() ||
      normalizedAbsolutePath(commonDirectory) === undefined
    )
      throw new Error("workspace_file_linked_worktree_discovery_failed");
    const records = parseWorktreePorcelain(stdout);
    const primary = records
      .filter(({ worktreePath }) => {
        const normalized = normalizedAbsolutePath(worktreePath);
        return normalized !== undefined && isWithin(normalized, root);
      })
      .sort(
        (left, right) => right.worktreePath.length - left.worktreePath.length,
      )[0];
    if (!primary) {
      throw new Error("workspace_file_linked_worktree_discovery_failed");
    }
    const projectPrefix = path.relative(primary.worktreePath, root);
    const discovered: WorkspaceFileDiscoveredLinkedWorktree[] = [];
    for (const record of records) {
      signal?.throwIfAborted();
      if (
        record === primary ||
        record.prunable ||
        record.bare ||
        normalizedAbsolutePath(record.worktreePath) === undefined
      )
        continue;
      const candidate = projectPrefix
        ? path.join(record.worktreePath, projectPrefix)
        : record.worktreePath;
      const canonicalCheckoutPath = await realpath(record.worktreePath).catch(
        () => undefined,
      );
      const canonical = await realpath(candidate).catch(() => undefined);
      const metadata = canonical
        ? await stat(canonical).catch(() => undefined)
        : undefined;
      if (
        canonical !== candidate ||
        canonicalCheckoutPath !== record.worktreePath ||
        normalizedAbsolutePath(canonical ?? "") === undefined ||
        !metadata?.isDirectory()
      )
        continue;
      if (
        policyRoots &&
        !policyRoots.some((policyRoot) => isWithin(policyRoot, canonical))
      ) {
        continue;
      }
      const identity = await linkedWorktreeGitDirectory(
        record.worktreePath,
        commonDirectory,
      );
      if (!identity) continue;
      let provenanceKind: WorkspaceFileDiscoveredLinkedWorktree["provenanceKind"] =
        "unknown";
      let aheadCount: number | null = null;
      let behindCount: number | null = null;
      if (record.headOid === primary.headOid) {
        provenanceKind = "same";
        aheadCount = 0;
        behindCount = 0;
      } else {
        try {
          const { stdout: countsOutput } = await executeFile(
            "git",
            [
              "--no-pager",
              "--no-replace-objects",
              "-C",
              root,
              "rev-list",
              "--left-right",
              "--count",
              `${primary.headOid}...${record.headOid}`,
            ],
            {
              encoding: "utf8",
              maxBuffer: 1024,
              env: gitEnvironment(),
              windowsHide: true,
              timeout: 10_000,
              killSignal: "SIGKILL",
              ...(signal ? { signal } : {}),
            },
          );
          const match = /^(\d+)\s+(\d+)\s*$/u.exec(countsOutput);
          if (match) {
            behindCount = Number.parseInt(match[1]!, 10);
            aheadCount = Number.parseInt(match[2]!, 10);
            provenanceKind = aheadCount === 0 ? "contained" : "unmerged";
          }
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
        }
      }
      const branchName = record.branchRef?.startsWith("refs/heads/")
        ? record.branchRef.slice(11)
        : undefined;
      const pathLabel = path.basename(record.worktreePath);
      const displayLabel =
        (branchName
          ? [branchName, pathLabel]
          : [`Detached ${record.headOid.slice(0, 12)}`, pathLabel]
        ).find(
          (value) =>
            value !== undefined &&
            value.length > 0 &&
            value.length <= 240 &&
            !/[\u0000-\u001f\u007f]/u.test(value),
        ) ?? `Worktree ${record.headOid.slice(0, 12)}`;
      discovered.push({
        canonicalPath: canonical,
        canonicalCheckoutPath,
        canonicalGitDir: identity.canonicalGitDir,
        identityToken: identity.identityToken,
        displayLabel,
        branchRef: record.branchRef,
        headOid: record.headOid,
        provenanceKind,
        aheadCount,
        behindCount,
      });
    }
    discovered.sort(
      (left, right) =>
        left.displayLabel.localeCompare(right.displayLabel) ||
        comparePaths(left.canonicalPath, right.canonicalPath),
    );
    return {
      worktrees: discovered.slice(0, WORKSPACE_FILE_MAX_LINKED_WORKTREES),
      truncated: discovered.length > WORKSPACE_FILE_MAX_LINKED_WORKTREES,
    };
  }

  async removeLinkedWorktree(
    primaryRootTarget: WorkspaceFilesEngineRoot,
    target: Pick<
      WorkspaceLinkedWorktreeRemovalTarget,
      "canonicalCheckoutPath" | "canonicalGitDir" | "identityToken"
    > & { readonly policyRootPath?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const primaryRoot = await this.#root(primaryRootTarget);
    const checkout = await realpath(target.canonicalCheckoutPath).catch(
      () => undefined,
    );
    if (
      checkout !== target.canonicalCheckoutPath ||
      normalizedAbsolutePath(checkout ?? "") === undefined ||
      (target.policyRootPath !== undefined &&
        !isWithin(target.policyRootPath, checkout!)) ||
      isWithin(checkout!, primaryRoot)
    ) {
      throw new WorkspaceFileRootUnavailableError();
    }
    const { stdout: commonOutput } = await executeFile(
      "git",
      [
        "--no-pager",
        "--no-replace-objects",
        "-C",
        primaryRoot,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      {
        encoding: "utf8",
        maxBuffer: 4096,
        env: gitEnvironment(),
        windowsHide: true,
        timeout: 10_000,
        killSignal: "SIGKILL",
        ...(signal ? { signal } : {}),
      },
    );
    const commonDirectory = await realpath(
      commonOutput.replace(/\r?\n$/u, ""),
    ).catch(() => undefined);
    const identity = commonDirectory
      ? await linkedWorktreeGitDirectory(checkout!, commonDirectory)
      : undefined;
    if (
      !identity ||
      identity.canonicalGitDir !== target.canonicalGitDir ||
      identity.identityToken !== target.identityToken
    ) {
      throw new WorkspaceFileRootUnavailableError();
    }
    const options = {
      encoding: "utf8",
      maxBuffer: MAXIMUM_GIT_OUTPUT_BYTES,
      env: gitEnvironment(),
      windowsHide: true,
      timeout: 30_000,
      killSignal: "SIGKILL",
      ...(signal ? { signal } : {}),
    } as const;
    const { stdout: statusOutput } = await executeFile(
      "git",
      [
        "--no-pager",
        "--no-replace-objects",
        "-c",
        "core.hooksPath=/dev/null",
        "-C",
        checkout!,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
      options,
    );
    if (statusOutput.length > 0) throw new WorkspaceLinkedWorktreeDirtyError();
    await this.#testHooks?.beforeLinkedWorktreeRemovalIdentityValidation?.();
    const currentCheckout = await realpath(target.canonicalCheckoutPath).catch(
      () => undefined,
    );
    let currentCommonOutput: string;
    try {
      ({ stdout: currentCommonOutput } = await executeFile(
        "git",
        [
          "--no-pager",
          "--no-replace-objects",
          "-C",
          primaryRoot,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ],
        {
          encoding: "utf8",
          maxBuffer: 4096,
          env: gitEnvironment(),
          windowsHide: true,
          timeout: 10_000,
          killSignal: "SIGKILL",
          ...(signal ? { signal } : {}),
        },
      ));
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      throw new WorkspaceFileRootUnavailableError();
    }
    const currentCommonDirectory = await realpath(
      currentCommonOutput.replace(/\r?\n$/u, ""),
    ).catch(() => undefined);
    if (
      currentCheckout !== checkout ||
      currentCommonDirectory !== commonDirectory
    ) {
      throw new WorkspaceFileRootUnavailableError();
    }
    const currentIdentity = await linkedWorktreeGitDirectory(
      currentCheckout!,
      currentCommonDirectory!,
    );
    if (
      !currentIdentity ||
      currentIdentity.canonicalGitDir !== target.canonicalGitDir ||
      currentIdentity.identityToken !== target.identityToken
    ) {
      throw new WorkspaceFileRootUnavailableError();
    }
    try {
      await executeFile(
        "git",
        [
          "--no-pager",
          "--no-replace-objects",
          "-c",
          "core.hooksPath=/dev/null",
          "-C",
          primaryRoot,
          "worktree",
          "remove",
          "--",
          checkout!,
        ],
        options,
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if ((await realpath(checkout!).catch(() => undefined)) === undefined) {
        return;
      }
      throw new WorkspaceLinkedWorktreeRemovalRejectedError();
    }
  }

  async resolveFileLink(
    rootTarget: WorkspaceFilesEngineRoot,
    reference: WorkspaceFileLinkReference,
  ): Promise<string | undefined> {
    const root = await this.#root(rootTarget);
    const absolutePath =
      reference.kind === "absolute"
        ? reference.path
        : path.join(root, ...reference.path.split("/"));
    if (!path.isAbsolute(absolutePath) || !isWithin(root, absolutePath)) {
      return undefined;
    }
    const requestedRelative = normalizedPath(
      path.relative(root, absolutePath).split(path.sep).join("/"),
    );
    if (
      !requestedRelative ||
      isSensitiveWorkspacePath(requestedRelative) ||
      isWorkspaceFileWriteTemporaryPath(requestedRelative)
    ) {
      return undefined;
    }
    const canonical = await realpath(absolutePath).catch(() => undefined);
    if (!canonical || !isWithin(root, canonical)) return undefined;
    const canonicalRelative = normalizedPath(
      path.relative(root, canonical).split(path.sep).join("/"),
    );
    if (
      !canonicalRelative ||
      isSensitiveWorkspacePath(canonicalRelative) ||
      isWorkspaceFileWriteTemporaryPath(canonicalRelative)
    ) {
      return undefined;
    }
    const handle = await open(
      absolutePath,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    ).catch(() => undefined);
    if (!handle) return undefined;
    try {
      const openedPath = await revalidatedPathForOpenHandle(handle, canonical);
      const metadata = await handle.stat().catch(() => undefined);
      if (openedPath !== canonical || !metadata?.isFile()) return undefined;
      return canonicalRelative;
    } finally {
      await handle.close();
    }
  }

  async list(
    rootTarget: WorkspaceFilesEngineRoot,
    query: WorkspaceFileRootListQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesEngineListResult> {
    signal?.throwIfAborted();
    const root = await this.#root(rootTarget);
    signal?.throwIfAborted();
    const rootKey = `${rootTarget.operationKey}\0${root}`;
    if (query.cursor) {
      const retained = this.#takeListCursor(query.cursor, rootKey, "tree");
      const page = retained.entries.slice(
        retained.offset,
        retained.offset + query.pageSize,
      );
      return {
        entries: [...page],
        ...this.#nextTreeCursor(retained, retained.offset + page.length),
        scanTruncated: retained.scanTruncated,
      };
    }
    const scanned = await this.#walk(root, signal);
    signal?.throwIfAborted();
    const sorted = [...new Set(scanned.entries)].sort(comparePaths);
    const page = sorted.slice(0, query.pageSize);
    const retained: Extract<RetainedListCursor, { kind: "tree" }> = {
      kind: "tree",
      rootKey,
      entries: sorted,
      offset: 0,
      scanTruncated: scanned.truncated,
      expiresAt: Date.now() + LIST_CURSOR_TTL_MILLISECONDS,
    };
    return {
      entries: page,
      ...this.#nextTreeCursor(retained, page.length),
      scanTruncated: scanned.truncated,
    };
  }

  async listDirectory(
    rootTarget: WorkspaceFilesEngineRoot,
    query: WorkspaceFileRootDirectoryQuery,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesEngineDirectoryResult> {
    signal?.throwIfAborted();
    const root = await this.#root(rootTarget);
    signal?.throwIfAborted();
    const rootKey = `${rootTarget.operationKey}\0${root}`;
    if (query.cursor) {
      const retained = this.#takeListCursor(query.cursor, rootKey, "directory");
      if (retained.directory !== query.directory) {
        throw new WorkspaceFileCursorInvalidError();
      }
      const page = retained.entries.slice(
        retained.offset,
        retained.offset + query.pageSize,
      );
      return {
        directory: retained.directory,
        entries: [...page],
        ...this.#nextDirectoryCursor(retained, retained.offset + page.length),
        scanTruncated: retained.scanTruncated,
      };
    }
    const scanned = await this.#listImmediate(root, query.directory, signal);
    signal?.throwIfAborted();
    const entries = scanned.entries.sort((left, right) =>
      comparePaths(left.path, right.path),
    );
    const page = entries.slice(0, query.pageSize);
    const retained: Extract<RetainedListCursor, { kind: "directory" }> = {
      kind: "directory",
      rootKey,
      directory: query.directory,
      entries,
      offset: 0,
      scanTruncated: scanned.truncated,
      expiresAt: Date.now() + LIST_CURSOR_TTL_MILLISECONDS,
    };
    return {
      directory: query.directory,
      entries: page,
      ...this.#nextDirectoryCursor(retained, page.length),
      scanTruncated: scanned.truncated,
    };
  }

  async read(
    rootTarget: WorkspaceFilesEngineRoot,
    relativePath: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesEngineContentResult> {
    signal?.throwIfAborted();
    const root = await this.#root(rootTarget);
    signal?.throwIfAborted();
    const safePath = normalizedPath(relativePath);
    if (
      !safePath ||
      isSensitiveWorkspacePath(safePath) ||
      isWorkspaceFileWriteTemporaryPath(safePath)
    ) {
      throw new WorkspaceFileAccessError();
    }
    const candidate = path.join(root, ...safePath.split("/"));
    const canonical = await realpath(candidate).catch(() => {
      throw new WorkspaceFileAccessError();
    });
    const canonicalRelative = normalizedPath(
      path.relative(root, canonical).split(path.sep).join("/"),
    );
    if (
      !isWithin(root, canonical) ||
      !canonicalRelative ||
      isSensitiveWorkspacePath(canonicalRelative) ||
      isWorkspaceFileWriteTemporaryPath(canonicalRelative)
    ) {
      throw new WorkspaceFileAccessError();
    }
    const handle = await open(
      candidate,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    ).catch(() => {
      throw new WorkspaceFileAccessError();
    });
    try {
      // The descriptor is authoritative after open. Re-resolving it closes
      // the parent-directory swap race between the initial realpath and open.
      const openedPath = await revalidatedPathForOpenHandle(handle, canonical);
      if (!openedPath) throw new WorkspaceFileAccessError();
      if (!isWithin(root, openedPath) || openedPath !== canonical) {
        throw new WorkspaceFileAccessError();
      }
      const metadata = await handle.stat({ bigint: true }).catch(() => {
        throw new WorkspaceFileAccessError();
      });
      if (!metadata.isFile()) throw new WorkspaceFileAccessError();
      const descriptorRevision = revisionToken(metadata as never);
      await this.#testHooks?.afterReadMetadata?.(safePath);
      signal?.throwIfAborted();
      const maximum =
        workspaceFileImageMediaTypeForPath(safePath) === undefined
          ? WORKSPACE_FILE_MAX_CONTENT_BYTES
          : WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES;
      const buffer = Buffer.allocUnsafe(maximum + 4);
      // read(2) may return fewer bytes than requested; a single call would
      // silently present a partial file as complete and editable, and saving
      // it would truncate the file on disk.
      let filled = 0;
      while (filled < buffer.length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(
          buffer,
          filled,
          buffer.length - filled,
          filled,
        );
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      const source = buffer.subarray(0, filled);
      signal?.throwIfAborted();
      const revalidatedOpenedPath = await revalidatedPathForOpenHandle(
        handle,
        canonical,
      );
      if (!revalidatedOpenedPath) throw new WorkspaceFileAccessError();
      const revalidatedMetadata = await handle
        .stat({ bigint: true })
        .catch(() => {
          throw new WorkspaceFileAccessError();
        });
      if (
        revalidatedOpenedPath !== openedPath ||
        !isWithin(root, revalidatedOpenedPath) ||
        !revalidatedMetadata.isFile() ||
        revisionToken(revalidatedMetadata as never) !== descriptorRevision
      ) {
        throw new WorkspaceFileAccessError();
      }
      const truncated = metadata.size > BigInt(maximum);
      if (!truncated && filled !== Number(metadata.size)) {
        throw new WorkspaceFileAccessError();
      }
      const retained = source.subarray(0, Math.min(source.length, maximum));
      const classification = classifyWorkspaceFileBytes({
        relativePath: safePath,
        bytes: retained,
        truncated,
      });
      const sizeBytes = Number(
        metadata.size > BigInt(Number.MAX_SAFE_INTEGER)
          ? BigInt(Number.MAX_SAFE_INTEGER)
          : metadata.size,
      );
      if (classification.kind === "image") {
        if (truncated) {
          return {
            path: safePath,
            contentKind: "image",
            previewState: "too_large",
            mediaType: classification.mediaType,
            sizeBytes,
            revision: descriptorRevision,
            editable: false,
          };
        }
        return {
          path: safePath,
          contentKind: "image",
          previewState: "available",
          mediaType: classification.mediaType,
          contentEncoding: "base64",
          content: retained.toString("base64"),
          sizeBytes,
          revision: descriptorRevision,
          editable: false,
        };
      }
      if (classification.kind === "text") {
        return {
          path: safePath,
          contentKind: "text",
          content: classification.content,
          sizeBytes,
          revision: descriptorRevision,
          editable: !truncated,
          ...(truncated
            ? {
                truncation: {
                  truncated: true as const,
                  retainedBytes: classification.retainedBytes,
                  reason: "byte_limit" as const,
                },
              }
            : {}),
        };
      }
      return {
        path: safePath,
        contentKind: "binary",
        content: "",
        sizeBytes,
        revision: descriptorRevision,
        editable: false,
        ...(truncated
          ? {
              truncation: {
                truncated: true as const,
                retainedBytes: 0,
                reason: "byte_limit" as const,
              },
            }
          : {}),
      };
    } finally {
      await handle.close();
    }
  }

  async withDownload<T>(
    rootTarget: WorkspaceFilesEngineRoot,
    input: WorkspaceFileRootDownloadRequest,
    operation: (source: WorkspaceFileDownloadSource) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const root = await this.#root(rootTarget);
    signal?.throwIfAborted();
    const safePath = normalizedPath(input.path);
    if (
      !safePath ||
      isSensitiveWorkspacePath(safePath) ||
      isWorkspaceFileWriteTemporaryPath(safePath)
    ) {
      throw new WorkspaceFileAccessError();
    }
    const candidate = path.join(root, ...safePath.split("/"));
    const canonical = await realpath(candidate).catch(() => {
      throw new WorkspaceFileAccessError();
    });
    const canonicalRelative = normalizedPath(
      path.relative(root, canonical).split(path.sep).join("/"),
    );
    if (
      !isWithin(root, canonical) ||
      !canonicalRelative ||
      isSensitiveWorkspacePath(canonicalRelative) ||
      isWorkspaceFileWriteTemporaryPath(canonicalRelative)
    ) {
      throw new WorkspaceFileAccessError();
    }
    const handle = await open(
      candidate,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    ).catch(() => {
      throw new WorkspaceFileAccessError();
    });
    try {
      const openedPath = await revalidatedPathForOpenHandle(handle, canonical);
      if (!openedPath) throw new WorkspaceFileAccessError();
      if (openedPath !== canonical || !isWithin(root, openedPath)) {
        throw new WorkspaceFileAccessError();
      }
      const metadata = await handle.stat({ bigint: true }).catch(() => {
        throw new WorkspaceFileAccessError();
      });
      if (!metadata.isFile() || metadata.size < 0n) {
        throw new WorkspaceFileAccessError();
      }
      if (metadata.size > BigInt(WORKSPACE_FILE_MAX_DOWNLOAD_BYTES)) {
        throw new WorkspaceFileDownloadTooLargeError();
      }
      const descriptorRevision = revisionToken(metadata as never);
      if (descriptorRevision !== input.expectedRevision) {
        throw new WorkspaceFileRevisionConflictError();
      }
      const sizeBytes = Number(metadata.size);
      await this.#testHooks?.afterDownloadMetadata?.(safePath);
      signal?.throwIfAborted();
      let streamStarted = false;
      const source: WorkspaceFileDownloadSource = {
        path: safePath,
        fileName: path.basename(safePath),
        sizeBytes,
        revision: descriptorRevision,
        stream: async (write, streamSignal) => {
          if (streamStarted) {
            throw new Error("workspace_file_download_stream_already_consumed");
          }
          streamStarted = true;
          const effectiveSignal = combineAbortSignals(signal, streamSignal);
          effectiveSignal?.throwIfAborted();
          const buffer = Buffer.allocUnsafe(
            Math.min(
              WORKSPACE_FILE_DOWNLOAD_CHUNK_BYTES,
              Math.max(sizeBytes, 1),
            ),
          );
          let offset = 0;
          let pending: Buffer | undefined;
          while (offset < sizeBytes) {
            effectiveSignal?.throwIfAborted();
            const requested = Math.min(buffer.length, sizeBytes - offset);
            let filled = 0;
            while (filled < requested) {
              effectiveSignal?.throwIfAborted();
              const { bytesRead } = await handle.read(
                buffer,
                filled,
                requested - filled,
                offset + filled,
              );
              if (bytesRead === 0) throw new WorkspaceFileAccessError();
              filled += bytesRead;
            }
            if (pending) await write(pending);
            pending = Buffer.from(buffer.subarray(0, filled));
            offset += filled;
          }
          await this.#testHooks?.beforeDownloadFinalValidation?.(safePath);
          effectiveSignal?.throwIfAborted();
          const [revalidatedOpenedPath, revalidatedMetadata] =
            await Promise.all([
              revalidatedPathForOpenHandle(handle, canonical),
              handle.stat({ bigint: true }).catch(() => undefined),
            ]);
          if (
            revalidatedOpenedPath !== openedPath ||
            !revalidatedMetadata?.isFile() ||
            revisionToken(revalidatedMetadata as never) !== descriptorRevision
          ) {
            throw new WorkspaceFileAccessError();
          }
          effectiveSignal?.throwIfAborted();
          if (pending) await write(pending);
        },
      };
      return await operation(source);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async write(
    rootTarget: WorkspaceFilesEngineRoot,
    input: WorkspaceFileRootWriteRequest,
  ): Promise<WorkspaceFilesEngineWriteResult> {
    const safePath = normalizedPath(input.path);
    if (
      !safePath ||
      isSensitiveWorkspacePath(safePath) ||
      isWorkspaceFileWriteTemporaryPath(safePath)
    ) {
      throw new WorkspaceFileAccessError();
    }
    const admittedRoot = await this.#root(rootTarget);
    const candidate = path.join(admittedRoot, ...safePath.split("/"));
    const requestedParent = path.dirname(candidate);
    const admittedParent = await realpath(requestedParent).catch(() => {
      throw new WorkspaceFileAccessError();
    });
    if (!isWithin(admittedRoot, admittedParent)) {
      throw new WorkspaceFileAccessError();
    }
    const basename = path.basename(candidate);
    // Root-qualified identities may intentionally address the same file when
    // a supplemental root overlaps Primary. Serialize by canonical
    // destination rather than root ID so one CAS winner remains authoritative.
    const key = path.join(admittedParent, basename);
    return this.#mutations.run(key, async () => {
      const root = await this.#root(rootTarget);
      const canonicalParent = await realpath(requestedParent).catch(() => {
        throw new WorkspaceFileRevisionConflictError();
      });
      if (
        canonicalParent !== admittedParent ||
        !isWithin(root, canonicalParent)
      ) {
        throw new WorkspaceFileRevisionConflictError();
      }
      const parentHandle = await openVerifiedDirectory(canonicalParent).catch(
        () => {
          throw new WorkspaceFileAccessError();
        },
      );
      try {
        const parentDescriptorPath = pathForOpenDescriptor(
          parentHandle.fd,
          canonicalParent,
        );
        const openedParent = await revalidatedPathForOpenHandle(
          parentHandle,
          canonicalParent,
        );
        if (
          openedParent !== canonicalParent ||
          !isWithin(root, canonicalParent)
        ) {
          throw new WorkspaceFileRevisionConflictError();
        }
        const descriptorDestination = path.join(parentDescriptorPath, basename);
        const canonicalDestination = path.join(canonicalParent, basename);
        const canonicalRelative = normalizedPath(
          path.relative(root, canonicalDestination).split(path.sep).join("/"),
        );
        if (
          !canonicalRelative ||
          isSensitiveWorkspacePath(canonicalRelative) ||
          isWorkspaceFileWriteTemporaryPath(canonicalRelative)
        ) {
          throw new WorkspaceFileAccessError();
        }

        const original = await this.#openedTarget(
          root,
          canonicalParent,
          descriptorDestination,
        );
        if (!original) throw new WorkspaceFileRevisionConflictError();
        if (original.revision !== input.expectedRevision) {
          throw new WorkspaceFileRevisionConflictError();
        }
        if (original.size > BigInt(WORKSPACE_FILE_MAX_CONTENT_BYTES)) {
          throw new WorkspaceFileAccessError();
        }
        if (!original.editableText) throw new WorkspaceFileAccessError();

        const bytes = Buffer.from(input.content, "utf8");
        if (bytes.byteLength > WORKSPACE_FILE_MAX_CONTENT_BYTES) {
          throw new WorkspaceFileAccessError();
        }
        if (bytes.includes(0)) throw new WorkspaceFileAccessError();
        const temporaryPath = path.join(
          parentDescriptorPath,
          `.sedes-${basename}-${randomUUID()}.tmp`,
        );
        let temporaryCreated = false;
        try {
          const temporary = await open(
            temporaryPath,
            fileConstants.O_WRONLY |
              fileConstants.O_CREAT |
              fileConstants.O_EXCL |
              fileConstants.O_NOFOLLOW,
            0o600,
          );
          temporaryCreated = true;
          try {
            const openedTemporaryPath = await revalidatedPathForOpenHandle(
              temporary,
              temporaryPath,
            );
            if (
              !openedTemporaryPath ||
              !isWithin(root, openedTemporaryPath) ||
              path.dirname(openedTemporaryPath) !== canonicalParent
            ) {
              throw new WorkspaceFileRevisionConflictError();
            }
            await temporary.writeFile(bytes);
            await temporary.chmod(Number(original.mode & 0o777n));
            await temporary.sync();
          } finally {
            await temporary.close();
          }

          await this.#testHooks?.beforeWriteCommit?.();
          const freshParent = await revalidatedPathForOpenHandle(
            parentHandle,
            canonicalParent,
          );
          if (freshParent !== canonicalParent || !isWithin(root, freshParent)) {
            throw new WorkspaceFileRevisionConflictError();
          }
          const fresh = await this.#openedTarget(
            root,
            canonicalParent,
            descriptorDestination,
          );
          if (!fresh || fresh.revision !== input.expectedRevision) {
            throw new WorkspaceFileRevisionConflictError();
          }

          await rename(temporaryPath, descriptorDestination);
          temporaryCreated = false;
          const written = await this.#openedTarget(
            root,
            canonicalParent,
            descriptorDestination,
          );
          if (!written) {
            throw new Error("workspace_file_write_verification_failed");
          }
          if (process.platform !== "win32") await parentHandle.sync();
          return {
            path: safePath,
            sizeBytes: bytes.byteLength,
            revision: written.revision,
          };
        } finally {
          if (temporaryCreated) {
            await unlink(temporaryPath).catch(() => undefined);
          }
        }
      } finally {
        await parentHandle.close();
      }
    });
  }

  async status(
    rootTarget: WorkspaceFilesEngineRoot,
    signal?: AbortSignal,
  ): Promise<WorkspaceFilesEngineStatusResult> {
    signal?.throwIfAborted();
    const root = await this.#root(rootTarget);
    signal?.throwIfAborted();
    const gitPrefix = await this.#gitPrefix(root);
    if (gitPrefix === undefined) {
      return {
        isGitRepository: false,
        entries: [],
        truncated: false,
      };
    }
    let stdout: string;
    try {
      ({ stdout } = await executeFile(
        "git",
        [
          "-c",
          "status.relativePaths=false",
          "-C",
          root,
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
          "--",
          ".",
        ],
        {
          encoding: "utf8",
          maxBuffer:
            this.#testHooks?.maximumGitOutputBytes ?? MAXIMUM_GIT_OUTPUT_BYTES,
          ...(signal ? { signal } : {}),
        },
      ));
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (isMaximumBufferError(error)) {
        return {
          isGitRepository: true,
          entries: [],
          truncated: true,
        };
      }
      throw new Error("workspace_file_git_status_failed", { cause: error });
    }
    const records = stdout.split("\0");
    const entries: {
      path: string;
      status: WorkspaceFileGitStatusKind;
    }[] = [];
    for (
      let index = 0;
      index < records.length && entries.length <= WORKSPACE_FILE_MAX_PAGE_SIZE;
      index += 1
    ) {
      const record = records[index];
      if (!record) continue;
      const xy = record.slice(0, 2);
      const rawPath = this.#workspaceRelativeGitPath(
        record.slice(3),
        gitPrefix,
      );
      const relative =
        rawPath === undefined ? undefined : normalizedPath(rawPath);
      if (
        relative &&
        !isSensitiveWorkspacePath(relative) &&
        !isWorkspaceFileWriteTemporaryPath(relative)
      ) {
        entries.push({
          path: relative,
          status: gitStatus(xy),
        });
      }
      if (xy.includes("R") || xy.includes("C")) index += 1;
    }
    entries.sort((left, right) => comparePaths(left.path, right.path));
    return {
      isGitRepository: true,
      entries: entries.slice(0, WORKSPACE_FILE_MAX_PAGE_SIZE),
      truncated: entries.length > WORKSPACE_FILE_MAX_PAGE_SIZE,
    };
  }

  async watch(
    rootTarget: WorkspaceFilesEngineRoot,
    listener: () => void,
  ): Promise<WorkspaceFileWatchSubscription> {
    const root = await this.#root(rootTarget);
    const key = `${rootTarget.operationKey}\0${root}`;
    return this.#watchers.subscribe(key, root, listener);
  }

  #takeListCursor<K extends RetainedListCursor["kind"]>(
    cursor: string,
    rootKey: string,
    kind: K,
  ): Extract<RetainedListCursor, { kind: K }> {
    this.#pruneListCursors();
    const retained = this.#listCursors.get(cursor);
    this.#listCursors.delete(cursor);
    if (
      !retained ||
      retained.kind !== kind ||
      retained.rootKey !== rootKey ||
      retained.expiresAt <= Date.now()
    ) {
      throw new WorkspaceFileCursorInvalidError();
    }
    return retained as Extract<RetainedListCursor, { kind: K }>;
  }

  #nextTreeCursor(
    retained: Extract<RetainedListCursor, { kind: "tree" }>,
    offset: number,
  ): { readonly nextCursor?: string } {
    if (offset >= retained.entries.length) return {};
    return { nextCursor: this.#retainListCursor({ ...retained, offset }) };
  }

  #nextDirectoryCursor(
    retained: Extract<RetainedListCursor, { kind: "directory" }>,
    offset: number,
  ): { readonly nextCursor?: string } {
    if (offset >= retained.entries.length) return {};
    return { nextCursor: this.#retainListCursor({ ...retained, offset }) };
  }

  #retainListCursor(retained: RetainedListCursor): string {
    this.#pruneListCursors();
    while (this.#listCursors.size >= MAXIMUM_RETAINED_LIST_CURSORS) {
      const oldest = this.#listCursors.keys().next().value;
      if (oldest === undefined) break;
      this.#listCursors.delete(oldest);
    }
    const cursor = randomUUID();
    this.#listCursors.set(cursor, {
      ...retained,
      expiresAt: Date.now() + LIST_CURSOR_TTL_MILLISECONDS,
    });
    return cursor;
  }

  #pruneListCursors(): void {
    const now = Date.now();
    for (const [cursor, retained] of this.#listCursors) {
      if (retained.expiresAt <= now) this.#listCursors.delete(cursor);
    }
  }

  close(): void {
    this.#listCursors.clear();
    this.#watchers.close();
  }

  async #root(root: WorkspaceFilesEngineRoot): Promise<string> {
    if (!root.operationKey || !path.isAbsolute(root.canonicalPath)) {
      throw new Error("workspace_file_environment_unavailable");
    }
    return this.#validatedRoot(root.canonicalPath);
  }

  async #validatedRoot(canonicalPath: string): Promise<string> {
    if (!path.isAbsolute(canonicalPath)) {
      throw new Error("workspace_file_environment_unavailable");
    }
    const canonical = await realpath(canonicalPath).catch(() => {
      throw new WorkspaceFileRootUnavailableError();
    });
    const metadata = await stat(canonical).catch(() => {
      throw new WorkspaceFileRootUnavailableError();
    });
    if (!metadata.isDirectory() || canonical !== canonicalPath) {
      throw new WorkspaceFileRootUnavailableError();
    }
    return canonical;
  }

  async #openedTarget(
    root: string,
    canonicalParent: string,
    candidate: string,
  ): Promise<
    | {
        readonly revision: string;
        readonly size: bigint;
        readonly mode: bigint;
        readonly editableText: boolean;
      }
    | undefined
  > {
    const handle = await open(
      candidate,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    ).catch(() => undefined);
    if (!handle) return undefined;
    try {
      const openedPath = await revalidatedPathForOpenHandle(handle, candidate);
      if (
        !openedPath ||
        !isWithin(root, openedPath) ||
        path.dirname(openedPath) !== canonicalParent
      ) {
        return undefined;
      }
      const metadata = await handle
        .stat({ bigint: true })
        .catch(() => undefined);
      if (!metadata?.isFile()) return undefined;
      const descriptorRevision = revisionToken(metadata as never);
      let editableText = false;
      if (metadata.size <= BigInt(WORKSPACE_FILE_MAX_CONTENT_BYTES)) {
        const expectedSize = Number(metadata.size);
        const contents = Buffer.allocUnsafe(expectedSize + 1);
        let offset = 0;
        while (offset < contents.length) {
          const { bytesRead } = await handle.read(
            contents,
            offset,
            contents.length - offset,
            offset,
          );
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset === expectedSize) {
          const bounded = contents.subarray(0, offset);
          const revalidatedMetadata = await handle
            .stat({ bigint: true })
            .catch(() => undefined);
          if (
            revalidatedMetadata?.isFile() &&
            revisionToken(revalidatedMetadata as never) === descriptorRevision
          ) {
            const relativePath = normalizedPath(
              path.relative(root, openedPath).split(path.sep).join("/"),
            );
            editableText =
              relativePath !== undefined &&
              classifyWorkspaceFileBytes({
                relativePath,
                bytes: bounded,
                truncated: false,
              }).kind === "text";
          }
        }
      }
      return {
        revision: descriptorRevision,
        size: metadata.size,
        mode: metadata.mode,
        editableText,
      };
    } finally {
      await handle.close();
    }
  }

  async #gitPrefix(root: string): Promise<string | undefined> {
    try {
      const { stdout } = await executeFile(
        "git",
        ["-C", root, "rev-parse", "--show-prefix"],
        { encoding: "utf8", maxBuffer: 8 * 1_024 },
      );
      return stdout.replace(/\r?\n$/u, "");
    } catch {
      return undefined;
    }
  }

  async #findWorktreeRoot(start: string, signal?: AbortSignal): Promise<string | undefined> {
    let current = start;
    for (let depth = 0; depth <= MAXIMUM_WORKTREE_DISCOVERY_DEPTH; depth += 1) {
      signal?.throwIfAborted();
      const marker = await lstat(path.join(current, ".git")).catch(
        () => undefined,
      );
      if (marker?.isDirectory() || marker?.isFile()) return current;
      const parent = path.dirname(current);
      if (parent === current) return undefined;
      current = parent;
    }
    return undefined;
  }

  #workspaceRelativeGitPath(
    repositoryRelativePath: string,
    prefix: string,
  ): string | undefined {
    if (prefix === "") return repositoryRelativePath;
    return repositoryRelativePath.startsWith(prefix)
      ? repositoryRelativePath.slice(prefix.length)
      : undefined;
  }

  async #listImmediate(
    root: string,
    directoryPath: string,
    signal?: AbortSignal,
  ): Promise<{
    entries: WorkspaceFileDirectoryEntry[];
    truncated: boolean;
  }> {
    signal?.throwIfAborted();
    const safeDirectory =
      directoryPath === "" ? "" : normalizedPath(directoryPath);
    if (
      safeDirectory === undefined ||
      (safeDirectory !== "" &&
        (isSensitiveWorkspacePath(safeDirectory) ||
          isWorkspaceFileWriteTemporaryPath(safeDirectory)))
    ) {
      throw new WorkspaceFileAccessError();
    }
    const candidate = safeDirectory
      ? path.join(root, ...safeDirectory.split("/"))
      : root;
    const canonical = await realpath(candidate).catch(() => {
      throw new WorkspaceFileAccessError();
    });
    const canonicalRelative =
      canonical === root
        ? ""
        : normalizedPath(
            path.relative(root, canonical).split(path.sep).join("/"),
          );
    if (
      !isWithin(root, canonical) ||
      canonicalRelative === undefined ||
      (canonicalRelative !== "" &&
        (isSensitiveWorkspacePath(canonicalRelative) ||
          isWorkspaceFileWriteTemporaryPath(canonicalRelative)))
    ) {
      throw new WorkspaceFileAccessError();
    }
    const handle = await openVerifiedDirectory(candidate).catch(() => {
      throw new WorkspaceFileAccessError();
    });
    try {
      const opened = await revalidatedPathForOpenHandle(handle, canonical);
      if (!opened) throw new WorkspaceFileAccessError();
      if (opened !== canonical || !isWithin(root, opened)) {
        throw new WorkspaceFileAccessError();
      }
      const entries: WorkspaceFileDirectoryEntry[] = [];
      let truncated = false;
      const directory = await opendir(
        pathForOpenDescriptor(handle.fd, canonical),
      ).catch(() => {
        throw new WorkspaceFileAccessError();
      });
      for await (const entry of directory) {
        signal?.throwIfAborted();
        const currentDirectory = await revalidatedPathForOpenHandle(
          handle,
          canonical,
        );
        if (
          currentDirectory !== canonical ||
          !isWithin(root, currentDirectory)
        ) {
          throw new WorkspaceFileAccessError();
        }
        if (entries.length >= MAXIMUM_SCANNED_FILES) {
          truncated = true;
          break;
        }
        const relative = safeDirectory
          ? `${safeDirectory}/${entry.name}`
          : entry.name;
        const safePath = normalizedPath(relative);
        if (
          !safePath ||
          entry.name === ".git" ||
          entry.isSymbolicLink() ||
          isSensitiveWorkspacePath(safePath) ||
          isWorkspaceFileWriteTemporaryPath(safePath)
        ) {
          continue;
        }
        if (entry.isDirectory()) {
          entries.push({ path: safePath, kind: "directory" });
        } else if (entry.isFile()) {
          entries.push({ path: safePath, kind: "file" });
        }
      }
      return { entries, truncated };
    } finally {
      await handle.close();
    }
  }

  async #walk(
    root: string,
    signal?: AbortSignal,
  ): Promise<{ entries: string[]; truncated: boolean }> {
    const entries: string[] = [];
    let visitedDirectories = 0;
    let truncated = false;
    const visit = async (
      directoryHandle: FileHandle,
      canonicalDirectory: string,
      prefix: string,
      depth: number,
    ): Promise<void> => {
      signal?.throwIfAborted();
      if (
        depth > MAXIMUM_DIRECTORY_DEPTH ||
        visitedDirectories >= MAXIMUM_SCANNED_DIRECTORIES
      ) {
        truncated = true;
        return;
      }
      visitedDirectories += 1;
      // A directory the server cannot read is an expected condition in a real
      // workspace; skipping it degrades one subtree instead of failing the
      // whole listing with an untyped error.
      const descriptorPath = pathForOpenDescriptor(
        directoryHandle.fd,
        canonicalDirectory,
      );
      const directory = await opendir(descriptorPath).catch(() => undefined);
      if (!directory) return;
      for await (const entry of directory) {
        signal?.throwIfAborted();
        const currentDirectory = await revalidatedPathForOpenHandle(
          directoryHandle,
          canonicalDirectory,
        );
        if (
          currentDirectory !== canonicalDirectory ||
          !isWithin(root, currentDirectory)
        ) {
          return;
        }
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (
          entry.name === ".git" ||
          isSensitiveWorkspacePath(relative) ||
          isWorkspaceFileWriteTemporaryPath(relative)
        ) {
          continue;
        }
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (
            depth >= MAXIMUM_DIRECTORY_DEPTH ||
            visitedDirectories >= MAXIMUM_SCANNED_DIRECTORIES
          ) {
            truncated = true;
            continue;
          }
          await this.#testHooks?.beforeWalkDirectoryOpen?.(relative);
          const expectedDirectory = path.join(canonicalDirectory, entry.name);
          const childHandle = await openVerifiedDirectory(
            path.join(descriptorPath, entry.name),
          ).catch(() => undefined);
          if (!childHandle) continue;
          try {
            const openedDirectory = await revalidatedPathForOpenHandle(
              childHandle,
              expectedDirectory,
            );
            if (
              openedDirectory !== expectedDirectory ||
              !isWithin(root, openedDirectory)
            ) {
              continue;
            }
            await visit(childHandle, openedDirectory, relative, depth + 1);
          } finally {
            await childHandle.close();
          }
        }
        // Names the wire contract cannot express (backslashes, control
        // characters, over-long paths) are dropped here. Emitting one would
        // fail response validation and take the entire tree down with it.
        else if (entry.isFile() && normalizedPath(relative) !== undefined) {
          if (entries.length >= MAXIMUM_SCANNED_FILES) {
            truncated = true;
            return;
          }
          entries.push(relative);
        }
      }
    };
    const rootHandle = await openVerifiedDirectory(root).catch(() => undefined);
    if (rootHandle) {
      try {
        const openedRoot = await revalidatedPathForOpenHandle(rootHandle, root);
        if (openedRoot === root) await visit(rootHandle, root, "", 0);
      } finally {
        await rootHandle.close();
      }
    }
    return {
      entries,
      truncated,
    };
  }
}
