import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  constants as fsConstants,
  lstat,
  open,
  opendir,
  realpath,
  stat,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import {
  SidecarOperationError,
  type DirectoryBrowserV1Handlers,
} from "../../internal/sidecar-protocol/index.js";
import {
  pathForOpenDescriptor,
  revalidatedPathForOpenHandle,
} from "../local-file-descriptor-path.js";

const SNAPSHOT_TTL_MILLISECONDS = 60_000;
const MAXIMUM_SNAPSHOTS = 32;
const MAXIMUM_ENUMERATED_ENTRIES = 10_000;
const MAXIMUM_PROJECTED_BYTES = 1_048_576;

interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
}

interface DirectorySnapshot {
  readonly id: string;
  readonly rootPath: string;
  readonly directoryPath: string;
  readonly pageSize: number;
  readonly entries: readonly DirectoryEntry[];
  readonly truncated: boolean;
  readonly expiresAt: number;
}

/** Remote execution-environment directory authority; it exposes no raw FS RPC. */
export class DirectoryBrowserSidecarHost {
  readonly handlers: DirectoryBrowserV1Handlers;
  readonly #cursorKey: Buffer;
  readonly #snapshots = new Map<string, DirectorySnapshot>();

  constructor(input: { readonly sessionNonce: string }) {
    if (input.sessionNonce.length < 32 || input.sessionNonce.length > 160) {
      throw new Error("sidecar_session_nonce_invalid");
    }
    this.#cursorKey = createHmac("sha256", input.sessionNonce)
      .update("directory_browser@1\0cursor")
      .digest();
    this.handlers = {
      listImmediate: (request, context) =>
        this.#guard(() => this.#listImmediate(request, context.signal)),
    };
  }

  close(): void {
    this.#snapshots.clear();
    this.#cursorKey.fill(0);
  }

  detach(): void {
    this.#snapshots.clear();
  }

  async #listImmediate(
    request: {
      readonly rootPath: string;
      readonly directoryPath: string;
      readonly pageSize: number;
      readonly cursor?: string;
    },
    signal: AbortSignal,
  ) {
    this.#throwIfAborted(signal);
    this.#expireSnapshots();
    if (request.cursor) {
      const { snapshot, offset } = this.#resolveCursor(request.cursor);
      if (
        snapshot.rootPath !== request.rootPath ||
        snapshot.directoryPath !== request.directoryPath ||
        snapshot.pageSize !== request.pageSize
      ) {
        throw new SidecarOperationError("directory_browser_cursor_invalid");
      }
      return this.#page(snapshot, offset);
    }
    const projection = await this.#enumerate(request, signal);
    const snapshot: DirectorySnapshot = Object.freeze({
      id: randomBytes(18).toString("base64url"),
      rootPath: request.rootPath,
      directoryPath: request.directoryPath,
      pageSize: request.pageSize,
      entries: Object.freeze(projection.entries),
      truncated: projection.truncated,
      expiresAt: Date.now() + SNAPSHOT_TTL_MILLISECONDS,
    });
    if (snapshot.entries.length > snapshot.pageSize) {
      if (this.#snapshots.size >= MAXIMUM_SNAPSHOTS) {
        throw new SidecarOperationError("directory_browser_busy", true);
      }
      this.#snapshots.set(snapshot.id, snapshot);
    }
    return this.#page(snapshot, 0);
  }

  async #enumerate(
    request: { readonly rootPath: string; readonly directoryPath: string },
    signal: AbortSignal,
  ): Promise<{
    readonly entries: readonly DirectoryEntry[];
    truncated: boolean;
  }> {
    if (!isWithin(request.rootPath, request.directoryPath)) {
      throw directoryNotFound();
    }
    const root = await verifiedDirectory(request.rootPath);
    try {
      const directory =
        request.directoryPath === request.rootPath
          ? root
          : await verifiedDirectory(request.directoryPath);
      try {
        if (
          !isWithin(root.canonicalPath, directory.canonicalPath) ||
          root.canonicalPath !== request.rootPath ||
          directory.canonicalPath !== request.directoryPath
        ) {
          throw directoryNotFound();
        }
        return await enumerateDescriptor(
          directory.handle,
          directory.canonicalPath,
          root.canonicalPath,
          signal,
        );
      } finally {
        if (directory !== root) await directory.handle.close();
      }
    } finally {
      await root.handle.close();
    }
  }

  #page(snapshot: DirectorySnapshot, offset: number) {
    if (
      offset < 0 ||
      offset > snapshot.entries.length ||
      (offset === snapshot.entries.length && offset !== 0)
    ) {
      throw new SidecarOperationError("directory_browser_cursor_invalid");
    }
    const entries = snapshot.entries.slice(offset, offset + snapshot.pageSize);
    const nextOffset = offset + entries.length;
    if (offset > 0 && nextOffset >= snapshot.entries.length) {
      this.#snapshots.delete(snapshot.id);
    }
    return {
      directoryPath: snapshot.directoryPath,
      entries,
      ...(nextOffset < snapshot.entries.length
        ? { nextCursor: this.#cursor(snapshot.id, nextOffset) }
        : {}),
      truncated: snapshot.truncated,
    };
  }

  #cursor(snapshotId: string, offset: number): string {
    const offsetText = offset.toString(36);
    const payload = `${snapshotId}.${offsetText}`;
    const signature = createHmac("sha256", this.#cursorKey)
      .update(payload)
      .digest("base64url");
    return `${payload}.${signature}`;
  }

  #resolveCursor(cursor: string): {
    readonly snapshot: DirectorySnapshot;
    readonly offset: number;
  } {
    const [snapshotId, offsetText, signature, ...extra] = cursor.split(".");
    if (!snapshotId || !offsetText || !signature || extra.length > 0) {
      throw new SidecarOperationError("directory_browser_cursor_invalid");
    }
    const expected = createHmac("sha256", this.#cursorKey)
      .update(`${snapshotId}.${offsetText}`)
      .digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, "base64url");
    } catch {
      throw new SidecarOperationError("directory_browser_cursor_invalid");
    }
    const offset = Number.parseInt(offsetText, 36);
    const snapshot = this.#snapshots.get(snapshotId);
    if (
      actual.byteLength !== expected.byteLength ||
      !timingSafeEqual(actual, expected) ||
      !Number.isSafeInteger(offset) ||
      offset <= 0 ||
      !snapshot ||
      snapshot.expiresAt <= Date.now()
    ) {
      throw new SidecarOperationError("directory_browser_cursor_invalid");
    }
    return { snapshot, offset };
  }

  #expireSnapshots(): void {
    const now = Date.now();
    for (const [id, snapshot] of this.#snapshots) {
      if (snapshot.expiresAt <= now) this.#snapshots.delete(id);
    }
  }

  #throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new SidecarOperationError("directory_browser_cancelled", true, {
        cause: signal.reason,
      });
    }
  }

  async #guard<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof SidecarOperationError) throw error;
      throw directoryNotFound(error);
    }
  }
}

async function verifiedDirectory(directoryPath: string): Promise<{
  readonly canonicalPath: string;
  readonly handle: Awaited<ReturnType<typeof open>>;
}> {
  const metadata = await lstat(directoryPath);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw directoryNotFound();
  }
  const handle = await open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const [canonicalPath, descriptorMetadata] = await Promise.all([
      realpath(directoryPath),
      handle.stat(),
    ]);
    const canonicalMetadata = await stat(canonicalPath);
    if (
      canonicalPath !== directoryPath ||
      canonicalMetadata.dev !== descriptorMetadata.dev ||
      canonicalMetadata.ino !== descriptorMetadata.ino
    ) {
      throw directoryNotFound();
    }
    return { canonicalPath, handle };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function enumerateDescriptor(
  handle: FileHandle,
  directoryPath: string,
  rootPath: string,
  signal: AbortSignal,
): Promise<{
  readonly entries: readonly DirectoryEntry[];
  truncated: boolean;
}> {
  const openedPath = await revalidatedPathForOpenHandle(handle, directoryPath);
  if (openedPath !== directoryPath) throw directoryNotFound();
  const directory = await opendir(pathForOpenDescriptor(handle.fd, openedPath));
  const entries: DirectoryEntry[] = [];
  let enumerated = 0;
  let projectedBytes = 0;
  let truncated = false;
  try {
    for await (const entry of directory) {
      if (signal.aborted) {
        throw new SidecarOperationError("directory_browser_cancelled", true, {
          cause: signal.reason,
        });
      }
      enumerated += 1;
      if (enumerated > MAXIMUM_ENUMERATED_ENTRIES) {
        truncated = true;
        break;
      }
      if (
        !entry.isDirectory() ||
        entry.isSymbolicLink() ||
        !validName(entry.name)
      ) {
        continue;
      }
      const childPath = path.join(directoryPath, entry.name);
      if (!isWithin(rootPath, childPath)) continue;
      let child;
      try {
        child = await verifiedDirectory(childPath);
      } catch {
        continue;
      }
      await child.handle.close();
      if (child.canonicalPath !== childPath) continue;
      const bytes =
        Buffer.byteLength(entry.name, "utf8") +
        Buffer.byteLength(childPath, "utf8");
      if (projectedBytes + bytes > MAXIMUM_PROJECTED_BYTES) {
        truncated = true;
        break;
      }
      projectedBytes += bytes;
      entries.push(Object.freeze({ name: entry.name, path: childPath }));
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en", { sensitivity: "variant" }),
  );
  return { entries, truncated };
}

function validName(name: string): boolean {
  return (
    !name.startsWith(".") &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !/[\u0000-\u001f\u007f\\]/u.test(name) &&
    Buffer.byteLength(name, "utf8") <= 255
  );
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== "..")
  );
}

function directoryNotFound(cause?: unknown): SidecarOperationError {
  return new SidecarOperationError(
    "directory_browser_directory_not_found",
    false,
    {
      ...(cause !== undefined ? { cause } : {}),
    },
  );
}
