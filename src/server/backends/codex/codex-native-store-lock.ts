import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import {
  constants as filesystemConstants,
  type BigIntStats,
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
  type FileHandle,
} from "node:fs/promises";
import { z } from "zod";
import {
  assertSidecarLaunchRetirementRecorded,
  sidecarLaunchLedgerDirectory,
  sidecarLaunchOwnerSchema,
  type SidecarLaunchOwner,
} from "../../sidecar/sidecar-launch-ledger.js";
import { sidecarServiceKey } from "../../sidecar/persistent-sidecar-paths.js";
import { sidecarProcessOwnership } from "../../sidecar/sidecar-process-ownership.js";
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
const MAXIMUM_OWNER_METADATA_BYTES = 8_192;
const OWNER_READ_BUFFER_BYTES = MAXIMUM_OWNER_METADATA_BYTES + 1;
const MAXIMUM_V1_OWNER_BYTES = 256;

export interface CodexSidecarStoreContext {
  readonly serviceDirectory: string;
  readonly owner: SidecarLaunchOwner;
}

type SidecarStoreAuthority = CodexSidecarStoreContext & {
  readonly backendInstanceId: string;
};

const sidecarStoreClaimSchema = z.strictObject({
  version: z.literal(2),
  nonce: z.uuid(),
  namespaceKey: z.hash("sha256"),
  backendInstanceId: z.string().min(1).max(512),
  sidecar: sidecarLaunchOwnerSchema,
  // Fixed-width final field. Retirement writes this one byte through the pinned
  // original owner file. The canonical directory continues excluding old clients.
  retired: z.union([z.literal(0), z.literal(1)]),
});
type SidecarStoreClaim = z.infer<typeof sidecarStoreClaimSchema>;

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
 * Exclusive mkdir coordinates every Sedes version. A proved sidecar retirement
 * can clear its own claim while retaining the directory until the operator has
 * established that external Codex processes are no longer using the native store.
 */
export function createCodexNativeStoreLifecycle(input: {
  readonly canonicalCodexHome: string;
  readonly createIfMissing?: boolean;
  readonly label: string;
  readonly ownership: CodexNativeStoreOwnershipGate;
  readonly sidecar?: SidecarStoreAuthority;
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
          input.sidecar,
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
  sidecar: SidecarStoreAuthority | undefined,
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
    throw await existingLockError(canonicalCodexHome, lockDirectory, ownerFile, sidecar);
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
  const nonce = randomUUID();
  const ownerToken = sidecar
    ? sidecarStoreClaimSchema.parse({
        version: 2,
        nonce,
        namespaceKey: codexNativeStoreNamespaceKey(canonicalCodexHome),
        backendInstanceId: sidecar.backendInstanceId,
        sidecar: sidecar.owner,
        retired: 0,
      })
    : { version: 1 as const, pid: process.pid, nonce };
  const serializedOwner = JSON.stringify(ownerToken);
  if (Buffer.byteLength(serializedOwner, "utf8") > MAXIMUM_OWNER_METADATA_BYTES) {
    throw new Error("codex_native_store_owner_metadata_too_large");
  }
  let witnessPath: string | undefined;
  try {
    if (sidecar && ownerToken.version === 2) {
      witnessPath = claimWitnessPath(sidecar, nonce);
      const handle = await openAsync(ownerFile, "wx", 0o600);
      try {
        // Bind the service-private witness to the specific home, lock directory,
        // and owner file. A copied claim cannot authorize a different lock.
        const witness = await claimWitness(canonicalCodexHome, lockDirectory, handle, ownerToken);
        await writeFileAsync(witnessPath, witness, { flag: "wx", mode: 0o600, flush: true });
        await syncDirectory(path.dirname(witnessPath));
        await handle.writeFile(serializedOwner);
        await handle.sync();
      } finally { await handle.close(); }
      await syncDirectory(lockDirectory);
      await syncDirectory(canonicalCodexHome);
      await verifyOwnedLock(lockDirectory, ownerFile, lockIdentity, serializedOwner);
    } else {
      await writeFileAsync(ownerFile, serializedOwner, { encoding: "utf8", flag: "wx", mode: 0o600 });
    }
  } catch {
    // Failed initialization leaves the canonical marker in place.
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
      if (phase === "released" && !witnessPath) return Promise.resolve();
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
      }).then(async () => {
        if (witnessPath) {
          await unlinkAsync(witnessPath).catch(error => {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("codex_native_store_release_cleanup_failed");
          });
          witnessPath = undefined;
        }
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

function claimWitnessPath(sidecar: CodexSidecarStoreContext, nonce: string): string {
  const directory = sidecarLaunchLedgerDirectory(sidecar.serviceDirectory, sidecar.owner.serviceIncarnation);
  return path.join(directory, `codex-claim-${nonce}.json`);
}

async function claimWitness(home: string, lockDirectory: string, owner: FileHandle, claim: SidecarStoreClaim): Promise<string> {
  const [homeStat, directory, file] = await Promise.all([
    lstatAsync(home, { bigint: true }),
    lstatAsync(lockDirectory, { bigint: true }),
    owner.stat({ bigint: true }),
  ]);
  assertUsableHomeDirectory(homeStat);
  assertOwnedLockDirectory(directory);
  assertSafeOwnerFile(file);
  // The claim embeds the scope, service process, incarnation and target lifetime.
  // The immutable witness is the same for both states of this specific claim.
  const digest = createHash("sha256").update(JSON.stringify({ ...claim, retired: 0 })).digest("hex");
  const identity = (stat: BigIntStats) => [String(stat.dev), String(stat.ino)];
  return JSON.stringify({
    version: 1, digest,
    home: identity(homeStat),
    directory: identity(directory),
    owner: identity(file),
  });
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await openAsync(directory, filesystemConstants.O_RDONLY | filesystemConstants.O_DIRECTORY | filesystemConstants.O_NOFOLLOW);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

async function existingLockError(
  home: string,
  lockDirectory: string,
  ownerFile: string,
  current: SidecarStoreAuthority | undefined,
): Promise<Error> {
  const serialized = await readBoundedOwner(ownerFile).catch(() => "");
  const pid = parseOwnerPid(serialized);
  if (pid !== undefined && processExists(pid)) return new Error("codex_native_store_already_locked");
  const manual = new Error("codex_native_store_stale_lock_requires_operator");
  try {
    const claim = sidecarStoreClaimSchema.parse(JSON.parse(serialized));
    if (!await sidecarProcessOwnership.lifetimeEnded(claim.sidecar.lifetime) &&
        await sidecarProcessOwnership.processMatches(claim.sidecar.process)) {
      return new Error("codex_native_store_already_locked");
    }
    if (!current || claim.namespaceKey !== codexNativeStoreNamespaceKey(home) ||
        claim.backendInstanceId !== current.backendInstanceId ||
        sidecarServiceKey(claim.sidecar.scope) !== sidecarServiceKey(current.owner.scope)) return manual;
    await retireSidecarClaim(home, lockDirectory, ownerFile, current, claim);
    return new Error("codex_native_store_exclusivity_requires_operator");
  } catch {
    // Missing or changed evidence leaves the lock on the manual path.
    return manual;
  }
}

async function retireSidecarClaim(
  home: string,
  directory: string,
  ownerFile: string,
  current: CodexSidecarStoreContext,
  claim: SidecarStoreClaim,
): Promise<void> {
  const active = JSON.stringify({ ...claim, retired: 0 });
  const retired = JSON.stringify({ ...claim, retired: 1 });
  if (!active.endsWith(',"retired":0}')) throw new Error("claim_invalid");
  await withBoundedOwner(ownerFile, true, async (handle, serialized) => {
    if (serialized !== active && serialized !== retired) throw new Error("claim_changed");
    const witness = await claimWitness(home, directory, handle, claim);
    const witnessPath = claimWitnessPath(
      { serviceDirectory: current.serviceDirectory, owner: claim.sidecar }, claim.nonce,
    );
    if (await readBoundedOwner(witnessPath) !== witness) throw new Error("claim_changed");
    // Recheck same-boot identity, launch evidence and the retirement recorded by
    // startup under its lock. Namespace or boot replacement alone cannot retire
    // a lock on a filesystem that another host/container might still share.
    await assertSidecarLaunchRetirementRecorded(current.serviceDirectory, claim.sidecar);
    if (await claimWitness(home, directory, handle, claim) !== witness ||
        await readBoundedOwner(witnessPath) !== witness) throw new Error("claim_changed");
    const latest = await readBoundedOwner(ownerFile);
    if (latest !== active && latest !== retired) throw new Error("claim_changed");
    if (latest === active) {
      const byte = Buffer.from("1");
      const written = await handle.write(byte, 0, 1, Buffer.byteLength(serialized) - 2);
      if (written.bytesWritten !== 1) throw new Error("claim_write_failed");
      await handle.sync();
    }
    const named = await lstatAsync(ownerFile, { bigint: true });
    const pinned = await handle.stat({ bigint: true });
    if (named.dev !== pinned.dev || named.ino !== pinned.ino ||
        await readBoundedOwner(ownerFile) !== retired) throw new Error("claim_changed");
  });
}

async function readBoundedOwner(filename: string): Promise<string> {
  return await withBoundedOwner(filename, false, async (_handle, serialized) => serialized);
}

async function withBoundedOwner<T>(
  filename: string,
  writable: boolean,
  use: (handle: FileHandle, serialized: string) => Promise<T>,
): Promise<T> {
  let handle: FileHandle | undefined;
  try {
    const pathMetadata = await lstatAsync(filename, { bigint: true });
    assertSafeOwnerFile(pathMetadata);
    const access = writable ? filesystemConstants.O_RDWR : filesystemConstants.O_RDONLY;
    handle = await openAsync(
      filename, access | filesystemConstants.O_NOFOLLOW | filesystemConstants.O_NONBLOCK,
    );
    const before = await handle.stat({ bigint: true });
    assertSafeOwnerFile(before);
    if (
      before.dev !== pathMetadata.dev ||
      before.ino !== pathMetadata.ino ||
      before.size > BigInt(MAXIMUM_OWNER_METADATA_BYTES)
    ) {
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
    return await use(handle, new TextDecoder("utf-8", { fatal: true }).decode(value.subarray(0, bytesRead)));
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
  if (Buffer.byteLength(value) > MAXIMUM_V1_OWNER_BYTES) return undefined;
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
