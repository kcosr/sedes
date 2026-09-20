import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  WORKSPACE_CONTEXT_FILENAMES,
  WORKSPACE_CONTEXT_MAXIMUM_AGGREGATE_BYTES,
  WORKSPACE_CONTEXT_MAXIMUM_DEPTH,
  WORKSPACE_CONTEXT_MAXIMUM_FILE_BYTES,
  WORKSPACE_CONTEXT_MAXIMUM_FILES,
} from "../../internal/sidecar-protocol/index.js";
import { revalidatedPathForOpenHandle } from "../local-file-descriptor-path.js";
import type {
  WorkspaceContextFile,
  WorkspaceContextSnapshot,
} from "./contracts.js";
export type {
  WorkspaceContextFile,
  WorkspaceContextSnapshot,
} from "./contracts.js";
export { WORKSPACE_CONTEXT_FILENAMES } from "../../internal/sidecar-protocol/index.js";

/** Fixed `workspace_context@1` limits, suitable for direct hello advertising. */
export const WORKSPACE_CONTEXT_LIMITS = Object.freeze({
  maximumFileBytes: WORKSPACE_CONTEXT_MAXIMUM_FILE_BYTES,
  maximumAggregateBytes: WORKSPACE_CONTEXT_MAXIMUM_AGGREGATE_BYTES,
  maximumFiles: WORKSPACE_CONTEXT_MAXIMUM_FILES,
  maximumDepth: WORKSPACE_CONTEXT_MAXIMUM_DEPTH,
});

export type WorkspaceContextErrorCode =
  | "workspace_context_not_allowed"
  | "workspace_context_limit_exceeded"
  | "workspace_context_unstable";

export class WorkspaceContextDiscoveryError extends Error {
  readonly code: WorkspaceContextErrorCode;

  constructor(code: WorkspaceContextErrorCode, options?: ErrorOptions) {
    super(code, options);
    this.name = "WorkspaceContextDiscoveryError";
    this.code = code;
  }
}

export interface WorkspaceContextDiscoveryTestHooks {
  readonly afterFileRead?: (
    relativePath: string,
    attempt: 1 | 2,
  ) => void | Promise<void>;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

class IdentityChangedError extends Error {}

/**
 * Discovers provider-neutral workspace instructions without executing or
 * interpreting them. Paths remain internal authority; callers decide how to
 * label the returned root-relative files for a provider resource view.
 */
export async function discoverWorkspaceContext(input: {
  readonly workspacePath: string;
  readonly policyRoots: readonly string[];
  readonly signal?: AbortSignal;
  readonly testHooks?: WorkspaceContextDiscoveryTestHooks;
}): Promise<WorkspaceContextSnapshot> {
  throwIfAborted(input.signal);
  const authority = await selectAuthority(
    input.workspacePath,
    input.policyRoots,
    input.signal,
  );
  for (const attempt of [1, 2] as const) {
    try {
      return await discoverAttempt({
        ...authority,
        signal: input.signal,
        testHooks: input.testHooks,
        attempt,
      });
    } catch (error) {
      if (!(error instanceof IdentityChangedError)) throw error;
      if (attempt === 2) {
        throw new WorkspaceContextDiscoveryError("workspace_context_unstable", {
          cause: error,
        });
      }
    }
  }
  throw new WorkspaceContextDiscoveryError("workspace_context_unstable");
}

async function selectAuthority(
  workspacePath: string,
  policyRoots: readonly string[],
  signal?: AbortSignal,
): Promise<{ readonly rootPath: string; readonly workspacePath: string }> {
  if (
    !path.isAbsolute(workspacePath) ||
    policyRoots.length === 0 ||
    policyRoots.some((root) => !path.isAbsolute(root))
  ) {
    throw notAllowed();
  }
  const canonicalWorkspace = await canonicalDirectory(
    workspacePath,
    signal,
  ).catch((error) => {
    if (signal?.aborted) throw signal.reason ?? error;
    throw notAllowed(error);
  });
  if (canonicalWorkspace !== path.resolve(workspacePath)) throw notAllowed();
  const roots = await Promise.all(
    [...new Set(policyRoots.map((root) => path.resolve(root)))].map(
      async (root) => ({
        declared: root,
        canonical: await canonicalDirectory(root, signal),
      }),
    ),
  ).catch((error) => {
    if (signal?.aborted) throw signal.reason ?? error;
    throw notAllowed(error);
  });
  const matching = roots
    .filter(
      (root) =>
        root.declared === root.canonical &&
        isWithin(root.canonical, canonicalWorkspace),
    )
    .sort(
      (left, right) =>
        pathDepth(right.canonical) - pathDepth(left.canonical) ||
        right.canonical.length - left.canonical.length,
    );
  const selected = matching[0];
  if (!selected) throw notAllowed();
  const peers = matching.filter(
    (candidate) =>
      pathDepth(candidate.canonical) === pathDepth(selected.canonical),
  );
  if (new Set(peers.map((peer) => peer.canonical)).size !== 1) {
    throw notAllowed();
  }
  return { rootPath: selected.canonical, workspacePath: canonicalWorkspace };
}

async function discoverAttempt(input: {
  readonly rootPath: string;
  readonly workspacePath: string;
  readonly signal?: AbortSignal;
  readonly testHooks?: WorkspaceContextDiscoveryTestHooks;
  readonly attempt: 1 | 2;
}): Promise<WorkspaceContextSnapshot> {
  throwIfAborted(input.signal);
  const relativeWorkspace = path.relative(input.rootPath, input.workspacePath);
  if (
    relativeWorkspace === ".." ||
    relativeWorkspace.startsWith(`..${path.sep}`)
  ) {
    throw notAllowed();
  }
  const segments =
    relativeWorkspace === "" ? [] : relativeWorkspace.split(path.sep);
  if (segments.length > WORKSPACE_CONTEXT_LIMITS.maximumDepth) {
    throw limitExceeded();
  }
  const directories = [
    input.rootPath,
    ...segments.map((_, index) =>
      path.join(input.rootPath, ...segments.slice(0, index + 1)),
    ),
  ];
  const accepted: WorkspaceContextFile[] = [];
  let aggregateBytes = 0;
  for (const directoryPath of directories) {
    throwIfAborted(input.signal);
    const directory = await openVerifiedDirectory(
      directoryPath,
      input.rootPath,
    );
    try {
      const contextFile = await readPriorityFile({
        directoryPath,
        directory,
        rootPath: input.rootPath,
        signal: input.signal,
        testHooks: input.testHooks,
        attempt: input.attempt,
      });
      if (!contextFile) continue;
      if (accepted.length >= WORKSPACE_CONTEXT_LIMITS.maximumFiles) {
        throw limitExceeded();
      }
      aggregateBytes += contextFile.sizeBytes;
      if (aggregateBytes > WORKSPACE_CONTEXT_LIMITS.maximumAggregateBytes) {
        throw limitExceeded();
      }
      accepted.push(contextFile);
    } finally {
      await directory.handle.close().catch(() => undefined);
    }
  }
  throwIfAborted(input.signal);
  const files = accepted.map((file) => Object.freeze(file));
  return {
    files,
    fingerprint: snapshotFingerprint(
      input.rootPath,
      input.workspacePath,
      files,
    ),
  };
}

async function readPriorityFile(input: {
  readonly directoryPath: string;
  readonly directory: Awaited<ReturnType<typeof openVerifiedDirectory>>;
  readonly rootPath: string;
  readonly signal?: AbortSignal;
  readonly testHooks?: WorkspaceContextDiscoveryTestHooks;
  readonly attempt: 1 | 2;
}): Promise<WorkspaceContextFile | undefined> {
  for (const filename of WORKSPACE_CONTEXT_FILENAMES) {
    throwIfAborted(input.signal);
    const candidate = path.join(input.directoryPath, filename);
    let entry;
    try {
      entry = await lstat(candidate, { bigint: true });
    } catch (error) {
      if (isMissing(error)) continue;
      throw new IdentityChangedError("context entry changed", { cause: error });
    }
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    let handle;
    try {
      handle = await open(
        candidate,
        fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
      );
    } catch (error) {
      throw new IdentityChangedError("context entry changed", { cause: error });
    }
    try {
      const before = await handle.stat({ bigint: true });
      if (
        !before.isFile() ||
        !sameIdentity(identity(entry), identity(before))
      ) {
        throw new IdentityChangedError("context entry changed");
      }
      if (before.size > BigInt(WORKSPACE_CONTEXT_LIMITS.maximumFileBytes)) {
        throw limitExceeded();
      }
      const expectedBytes = Number(before.size);
      const bytes = Buffer.allocUnsafe(expectedBytes + 1);
      let offset = 0;
      while (offset < bytes.byteLength) {
        throwIfAborted(input.signal);
        const result = await handle.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (result.bytesRead === 0) break;
        offset += result.bytesRead;
      }
      await input.testHooks?.afterFileRead?.(
        posixRelative(input.rootPath, candidate),
        input.attempt,
      );
      throwIfAborted(input.signal);
      const [after, currentEntry, openedPath, parentAfter, parentPath] =
        await Promise.all([
          handle.stat({ bigint: true }),
          lstat(candidate, { bigint: true }),
          revalidatedPathForOpenHandle(handle, candidate),
          input.directory.handle.stat({ bigint: true }),
          revalidatedPathForOpenHandle(
            input.directory.handle,
            input.directoryPath,
          ),
        ]).catch((error) => {
          throw new IdentityChangedError("context entry changed", {
            cause: error,
          });
        });
      if (
        offset !== expectedBytes ||
        !after.isFile() ||
        !currentEntry.isFile() ||
        currentEntry.isSymbolicLink() ||
        !sameIdentity(identity(before), identity(after)) ||
        !sameIdentity(identity(before), identity(currentEntry)) ||
        !sameIdentity(input.directory.identity, identity(parentAfter)) ||
        openedPath !== candidate ||
        parentPath !== input.directoryPath ||
        path.dirname(openedPath) !== parentPath ||
        !isWithin(input.rootPath, openedPath) ||
        !isWithin(input.rootPath, parentPath)
      ) {
        throw new IdentityChangedError("context entry changed");
      }
      const acceptedBytes = bytes.subarray(0, expectedBytes);
      const content = acceptedBytes.toString("utf8");
      if (
        Buffer.byteLength(content, "utf8") >
        WORKSPACE_CONTEXT_LIMITS.maximumFileBytes
      ) {
        throw limitExceeded();
      }
      return {
        policyRelativePath: posixRelative(input.rootPath, candidate),
        content,
        sizeBytes: expectedBytes,
        sha256: createHash("sha256").update(acceptedBytes).digest("hex"),
      };
    } finally {
      await handle.close().catch(() => undefined);
    }
  }
  return undefined;
}

async function openVerifiedDirectory(directoryPath: string, rootPath: string) {
  let entry;
  try {
    entry = await lstat(directoryPath, { bigint: true });
  } catch (error) {
    throw new IdentityChangedError("context directory changed", {
      cause: error,
    });
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new IdentityChangedError("context directory changed");
  }
  let handle;
  try {
    handle = await open(
      directoryPath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new IdentityChangedError("context directory changed", {
      cause: error,
    });
  }
  try {
    const [openedPath, descriptor] = await Promise.all([
      revalidatedPathForOpenHandle(handle, directoryPath),
      handle.stat({ bigint: true }),
    ]);
    if (
      openedPath !== directoryPath ||
      !isWithin(rootPath, openedPath) ||
      !descriptor.isDirectory() ||
      !sameIdentity(identity(entry), identity(descriptor))
    ) {
      throw new IdentityChangedError("context directory changed");
    }
    return { handle, identity: identity(descriptor), path: openedPath };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function canonicalDirectory(
  candidate: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const resolved = path.resolve(candidate);
  const directory = await openVerifiedDirectory(
    resolved,
    path.parse(resolved).root,
  );
  try {
    throwIfAborted(signal);
    return directory.path;
  } finally {
    await directory.handle.close().catch(() => undefined);
  }
}

function identity(value: {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}): FileIdentity {
  return {
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    size: value.size,
    mtimeNs: value.mtimeNs,
    ctimeNs: value.ctimeNs,
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function snapshotFingerprint(
  rootPath: string,
  workspacePath: string,
  files: readonly WorkspaceContextFile[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "workspace_context@1",
        WORKSPACE_CONTEXT_LIMITS,
        rootPath,
        posixRelative(rootPath, workspacePath),
        files.map((file) => [
          file.policyRelativePath,
          file.sizeBytes,
          file.sha256,
        ]),
      ]),
    )
    .digest("hex");
}

function throwIfAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

function pathDepth(candidate: string): number {
  return path.resolve(candidate).split(path.sep).filter(Boolean).length;
}

function posixRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).split(path.sep).join("/");
}

function notAllowed(cause?: unknown): WorkspaceContextDiscoveryError {
  return new WorkspaceContextDiscoveryError("workspace_context_not_allowed", {
    ...(cause !== undefined ? { cause } : {}),
  });
}

function limitExceeded(): WorkspaceContextDiscoveryError {
  return new WorkspaceContextDiscoveryError("workspace_context_limit_exceeded");
}
