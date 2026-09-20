import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  constants as filesystemConstants,
  realpathSync,
  statSync,
} from "node:fs";
import {
  lstat as lstatAsync,
  mkdir as mkdirAsync,
  open as openAsync,
  realpath as realpathAsync,
  rename as renameAsync,
  rmdir as rmdirAsync,
  stat as statAsync,
  unlink as unlinkAsync,
  writeFile as writeFileAsync,
} from "node:fs/promises";
import type {
  BackendNativeStoreLease,
  BackendNativeStoreLifecycle,
} from "../module.js";
import {
  guardCodexNativeStoreLease,
  type CodexNativeStoreOwnershipGate,
} from "./codex-native-store-ownership.js";

// This invisible name is a cross-version exclusion key, not product-facing
// branding. Keep the pre-rename identity so Harness and Sedes processes can
// never acquire the same provider-native Codex home concurrently.
const LOCK_DIRECTORY_NAME = ".harness-codex-runtime.lock";
const OWNER_FILE_NAME = "owner.json";
const NAMESPACE_DOMAIN = "harness.codex-native-store.v1\n";
const MAXIMUM_OWNER_METADATA_BYTES = 256;
const OWNER_READ_BUFFER_BYTES = MAXIMUM_OWNER_METADATA_BYTES + 1;

type LockIdentity = {
  readonly device: bigint;
  readonly inode: bigint;
};

type ReleasePhase =
  | "held"
  | "quarantined_unverified"
  | "quarantined"
  | "owner_removed"
  | "released";

/**
 * Atomic directory creation excludes every application version. Locks are never
 * stolen: a SIGKILL leaves a fail-closed stale marker that an operator must
 * inspect and remove only after proving the daemon/process group is gone.
 */
export function createCodexNativeStoreLifecycle(input: {
  readonly canonicalCodexHome: string;
  readonly createIfMissing?: boolean;
  readonly label: string;
  readonly ownership: CodexNativeStoreOwnershipGate;
}): BackendNativeStoreLifecycle {
  if (!path.isAbsolute(input.canonicalCodexHome) || !input.label) {
    throw new Error("codex_native_store_lock_configuration_invalid");
  }
  let canonicalCodexHome = input.canonicalCodexHome;
  if (input.createIfMissing) {
    try {
      const canonicalParent = realpathSync(path.dirname(canonicalCodexHome));
      if (
        path.join(canonicalParent, path.basename(canonicalCodexHome)) !==
        canonicalCodexHome
      ) {
        throw new Error("codex_native_store_home_not_canonical");
      }
    } catch (error) {
      if (isStableLockError(error)) throw error;
      throw new Error("codex_native_store_home_unavailable");
    }
  } else {
    try {
      canonicalCodexHome = realpathSync(canonicalCodexHome);
      assertUsableHomeDirectory(statSync(canonicalCodexHome, { bigint: true }));
    } catch (error) {
      if (isStableLockError(error)) throw error;
      throw new Error("codex_native_store_home_unavailable");
    }
  }
  const namespaceKey = codexNativeStoreNamespaceKey(canonicalCodexHome);
  return Object.freeze({
    sortKey: `codex:${namespaceKey}`,
    namespaceKey,
    label: input.label,
    acquire: async () =>
      guardCodexNativeStoreLease(
        await acquireCodexNativeStoreLock(
          canonicalCodexHome,
          input.createIfMissing === true,
        ),
        input.ownership,
      ),
  });
}

export function codexNativeStoreNamespaceKey(
  canonicalCodexHome: string,
): string {
  if (!path.isAbsolute(canonicalCodexHome)) {
    throw new Error("codex_native_store_namespace_invalid");
  }
  return createHash("sha256")
    .update(NAMESPACE_DOMAIN)
    .update(canonicalCodexHome)
    .digest("hex");
}

async function acquireCodexNativeStoreLock(
  canonicalCodexHome: string,
  createIfMissing: boolean,
): Promise<BackendNativeStoreLease> {
  if (createIfMissing) {
    try {
      await mkdirAsync(canonicalCodexHome, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new Error("codex_native_store_home_create_failed");
      }
    }
  }
  let currentCodexHome: string;
  try {
    currentCodexHome = await realpathAsync(canonicalCodexHome);
  } catch {
    throw new Error("codex_native_store_home_unavailable");
  }
  if (currentCodexHome !== canonicalCodexHome) {
    throw new Error("codex_native_store_home_not_canonical");
  }
  try {
    assertUsableHomeDirectory(
      await statAsync(canonicalCodexHome, { bigint: true }),
    );
  } catch (error) {
    if (isStableLockError(error)) throw error;
    throw new Error("codex_native_store_home_unavailable");
  }
  const lockDirectory = path.join(canonicalCodexHome, LOCK_DIRECTORY_NAME);
  const ownerFile = path.join(lockDirectory, OWNER_FILE_NAME);
  try {
    await mkdirAsync(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error("codex_native_store_lock_create_failed");
    }
    throw await existingLockError(ownerFile);
  }

  let metadata: Awaited<ReturnType<typeof lstatAsync>>;
  try {
    metadata = await lstatAsync(lockDirectory, { bigint: true });
    assertOwnedLockDirectory(metadata);
  } catch {
    // Once mkdir succeeds, uncertainty must retain a marker at the canonical
    // path. A later startup can inspect it but must never steal it.
    throw new Error("codex_native_store_lock_initialization_failed");
  }
  const lockIdentity: LockIdentity = {
    device: metadata.dev,
    inode: metadata.ino,
  };
  const ownerToken = Object.freeze({
    version: 1,
    pid: process.pid,
    nonce: randomUUID(),
  });
  const serializedOwner = JSON.stringify(ownerToken);
  if (
    Buffer.byteLength(serializedOwner, "utf8") > MAXIMUM_OWNER_METADATA_BYTES
  ) {
    throw new Error("codex_native_store_owner_metadata_too_large");
  }
  try {
    await writeFileAsync(ownerFile, serializedOwner, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    // Do not attempt pathname cleanup after ownership initialization fails.
    // The empty/partial directory is an intentional fail-closed stale marker.
    throw new Error("codex_native_store_owner_write_failed");
  }

  const quarantineDirectory = path.join(
    canonicalCodexHome,
    `${LOCK_DIRECTORY_NAME}.release-${ownerToken.nonce}`,
  );
  const quarantineOwnerFile = path.join(quarantineDirectory, OWNER_FILE_NAME);
  let phase: ReleasePhase = "held";
  let releasePromise: Promise<void> | undefined;
  return Object.freeze({
    release: () => {
      if (phase === "released") return Promise.resolve();
      releasePromise ??= releaseCodexNativeStoreLock({
        lockDirectory,
        ownerFile,
        quarantineDirectory,
        quarantineOwnerFile,
        lockIdentity,
        serializedOwner,
        phase: () => phase,
        setPhase: (next) => {
          phase = next;
        },
      }).finally(() => {
        releasePromise = undefined;
      });
      return releasePromise;
    },
  });
}

async function releaseCodexNativeStoreLock(input: {
  readonly lockDirectory: string;
  readonly ownerFile: string;
  readonly quarantineDirectory: string;
  readonly quarantineOwnerFile: string;
  readonly lockIdentity: LockIdentity;
  readonly serializedOwner: string;
  phase(): ReleasePhase;
  setPhase(phase: ReleasePhase): void;
}): Promise<void> {
  if (input.phase() === "held") {
    await verifyOwnedLock(
      input.lockDirectory,
      input.ownerFile,
      input.lockIdentity,
      input.serializedOwner,
    );
    await assertPathAbsent(input.quarantineDirectory);
    try {
      await renameAsync(input.lockDirectory, input.quarantineDirectory);
    } catch {
      throw new Error("codex_native_store_release_quarantine_failed");
    }
    input.setPhase("quarantined_unverified");
  }

  if (input.phase() === "quarantined_unverified") {
    try {
      await verifyOwnedLock(
        input.quarantineDirectory,
        input.quarantineOwnerFile,
        input.lockIdentity,
        input.serializedOwner,
      );
    } catch {
      await ensureFailClosedMarker(input.lockDirectory);
      throw new Error("codex_native_store_lock_identity_changed");
    }
    input.setPhase("quarantined");
  }

  if (input.phase() === "quarantined") {
    await verifyOwnedLock(
      input.quarantineDirectory,
      input.quarantineOwnerFile,
      input.lockIdentity,
      input.serializedOwner,
    );
    try {
      await unlinkAsync(input.quarantineOwnerFile);
    } catch {
      throw new Error("codex_native_store_release_cleanup_failed");
    }
    input.setPhase("owner_removed");
  }

  if (input.phase() === "owner_removed") {
    await verifyLockDirectoryIdentity(
      input.quarantineDirectory,
      input.lockIdentity,
    );
    try {
      await rmdirAsync(input.quarantineDirectory);
    } catch {
      throw new Error("codex_native_store_release_cleanup_failed");
    }
    input.setPhase("released");
  }
}

async function existingLockError(ownerFile: string): Promise<Error> {
  const owner = await readBoundedOwner(ownerFile).catch(() => "");
  const pid = parseOwnerPid(owner);
  return new Error(
    pid !== undefined && processExists(pid)
      ? "codex_native_store_already_locked"
      : "codex_native_store_stale_lock_requires_operator",
  );
}

async function readBoundedOwner(filename: string): Promise<string> {
  let handle: Awaited<ReturnType<typeof openAsync>> | undefined;
  try {
    const pathMetadata = await lstatAsync(filename, { bigint: true });
    assertSafeOwnerFile(pathMetadata);
    handle = await openAsync(
      filename,
      filesystemConstants.O_RDONLY | filesystemConstants.O_NOFOLLOW,
    );
    const before = await handle.stat({ bigint: true });
    assertSafeOwnerFile(before);
    if (before.size > BigInt(MAXIMUM_OWNER_METADATA_BYTES)) {
      throw new Error("codex_native_store_owner_metadata_invalid");
    }
    const value = Buffer.alloc(OWNER_READ_BUFFER_BYTES);
    let bytesRead = 0;
    while (bytesRead < value.byteLength) {
      const outcome = await handle.read(
        value,
        bytesRead,
        value.byteLength - bytesRead,
        bytesRead,
      );
      if (outcome.bytesRead === 0) break;
      bytesRead += outcome.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      bytesRead > MAXIMUM_OWNER_METADATA_BYTES ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      BigInt(bytesRead) !== after.size
    ) {
      throw new Error("codex_native_store_owner_metadata_invalid");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      value.subarray(0, bytesRead),
    );
  } catch {
    throw new Error("codex_native_store_owner_metadata_invalid");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function verifyOwnedLock(
  lockDirectory: string,
  ownerFile: string,
  identity: LockIdentity,
  serializedOwner: string,
): Promise<void> {
  await verifyLockDirectoryIdentity(lockDirectory, identity);
  const recordedOwner = await readBoundedOwner(ownerFile).catch(() => "");
  if (recordedOwner !== serializedOwner) {
    throw new Error("codex_native_store_lock_identity_changed");
  }
}

async function verifyLockDirectoryIdentity(
  lockDirectory: string,
  identity: LockIdentity,
): Promise<void> {
  let current: Awaited<ReturnType<typeof lstatAsync>>;
  try {
    current = await lstatAsync(lockDirectory, { bigint: true });
    assertOwnedLockDirectory(current);
  } catch {
    throw new Error("codex_native_store_lock_identity_changed");
  }
  if (current.dev !== identity.device || current.ino !== identity.inode) {
    throw new Error("codex_native_store_lock_identity_changed");
  }
}

async function assertPathAbsent(filename: string): Promise<void> {
  try {
    await lstatAsync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error("codex_native_store_release_quarantine_failed");
  }
  throw new Error("codex_native_store_release_quarantine_failed");
}

async function ensureFailClosedMarker(lockDirectory: string): Promise<void> {
  try {
    await mkdirAsync(lockDirectory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    // The caller still fails identity validation. Never replace or remove an
    // unknown canonical path while attempting best-effort recovery.
  }
}

function parseOwnerPid(value: string): number | undefined {
  try {
    const parsed = JSON.parse(value) as {
      readonly version?: unknown;
      readonly pid?: unknown;
      readonly nonce?: unknown;
    };
    return parsed.version === 1 &&
      typeof parsed.pid === "number" &&
      Number.isSafeInteger(parsed.pid) &&
      parsed.pid > 0 &&
      typeof parsed.nonce === "string" &&
      parsed.nonce.length <= 64
      ? parsed.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function assertUsableHomeDirectory(metadata: { isDirectory(): boolean }): void {
  // The exclusive Sedes lock provides cross-process coordination. Filesystem
  // exposure of CODEX_HOME is an operator responsibility; Sedes no longer
  // rejects otherwise valid homes solely for group/world readability.
  if (!metadata.isDirectory()) {
    throw new Error("codex_native_store_home_unavailable");
  }
}

function assertOwnedLockDirectory(metadata: {
  readonly uid: bigint;
  readonly mode: bigint;
  isDirectory(): boolean;
}): void {
  // Windows does not expose a POSIX uid and its mode bits do not describe the
  // effective ACL. Keep the type/identity checks that Node can prove there;
  // exclusive mkdir still establishes ownership of the lock acquisition.
  if (process.platform === "win32") {
    if (!metadata.isDirectory()) {
      throw new Error("codex_native_store_lock_identity_changed");
    }
    return;
  }

  const currentUserId = process.getuid?.();
  if (
    currentUserId === undefined ||
    !metadata.isDirectory() ||
    metadata.uid !== BigInt(currentUserId) ||
    (metadata.mode & 0o077n) !== 0n
  ) {
    throw new Error("codex_native_store_lock_identity_changed");
  }
}

function assertSafeOwnerFile(metadata: {
  readonly uid: bigint;
  readonly mode: bigint;
  readonly nlink: bigint;
  isFile(): boolean;
}): void {
  // As above, uid and POSIX permission bits are not meaningful on Windows.
  // Requiring a regular, singly-linked file retains the checks available via
  // Node without rejecting every native Windows launch.
  if (process.platform === "win32") {
    if (!metadata.isFile() || metadata.nlink !== 1n) {
      throw new Error("codex_native_store_owner_metadata_invalid");
    }
    return;
  }

  const currentUserId = process.getuid?.();
  if (
    currentUserId === undefined ||
    !metadata.isFile() ||
    metadata.uid !== BigInt(currentUserId) ||
    metadata.nlink !== 1n ||
    (metadata.mode & 0o077n) !== 0n
  ) {
    throw new Error("codex_native_store_owner_metadata_invalid");
  }
}

function isStableLockError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.startsWith("codex_native_store_")
  );
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
