import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath, rename, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  processTableSupported,
  readBootIdentity,
  readProcessEntries,
} from "../runtime/process-table.js";

interface LockMetadata {
  readonly pid: number;
  readonly startedAt: string;
  readonly identityHash: string;
  readonly ownerToken: string;
  /**
   * Opaque owner start token and boot identity, where the platform exposes
   * them cheaply. Platforms without them use PID-only liveness.
   */
  readonly processStartTime?: string;
  readonly bootId?: string;
}

const START_TIME_PATTERN = /^[A-Za-z0-9 :]{1,64}$/u;
const BOOT_ID_PATTERN = /^[A-Za-z0-9-]{1,80}$/u;
const OWNER_FILE_PATTERN = /^owner-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u;
const MAXIMUM_METADATA_BYTES = 16 * 1024;

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A live PID keeps the lock unless its start time or boot identity proves the
 * recorded owner is gone and the PID was reused. Unreadable evidence never
 * steals a lock.
 */
async function isLockOwnerRunning(owner: LockMetadata): Promise<boolean> {
  if (!isProcessRunning(owner.pid)) return false;
  if (owner.processStartTime === undefined || !processTableSupported()) {
    return true;
  }
  if (owner.bootId !== undefined) {
    const bootId = await readBootIdentity();
    if (bootId !== undefined && bootId !== owner.bootId) return false;
  }
  try {
    const current = (await readProcessEntries([owner.pid])).get(owner.pid);
    // Absence from a targeted read proves the PID exited after kill(0).
    return current !== undefined && current.startTime === owner.processStartTime;
  } catch {
    return true;
  }
}

async function currentProcessLiveness(): Promise<
  Pick<LockMetadata, "processStartTime" | "bootId">
> {
  if (!processTableSupported()) return {};
  const [entry, bootId] = await Promise.all([
    readProcessEntries([process.pid])
      .then((table) => table.get(process.pid))
      .catch(() => undefined),
    readBootIdentity(),
  ]);
  if (!entry || !START_TIME_PATTERN.test(entry.startTime)) return {};
  return {
    processStartTime: entry.startTime,
    ...(bootId !== undefined ? { bootId } : {}),
  };
}

function parseMetadata(value: string): LockMetadata | undefined {
  try {
    const parsed = JSON.parse(value) as Partial<LockMetadata>;
    if (
      Number.isInteger(parsed.pid) &&
      typeof parsed.pid === "number" &&
      parsed.pid > 0 &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.identityHash === "string" &&
      typeof parsed.ownerToken === "string" &&
      parsed.ownerToken.length > 0 &&
      (parsed.processStartTime === undefined ||
        (typeof parsed.processStartTime === "string" &&
          START_TIME_PATTERN.test(parsed.processStartTime))) &&
      (parsed.bootId === undefined ||
        (typeof parsed.bootId === "string" &&
          BOOT_ID_PATTERN.test(parsed.bootId)))
    ) {
      return parsed as LockMetadata;
    }
  } catch {
    // A malformed lock is never stolen automatically.
  }
  return undefined;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function readOwnerFile(filename: string): Promise<LockMetadata | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const named = await lstat(filename);
    if (!named.isFile()) return undefined;
    handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || named.dev !== opened.dev || named.ino !== opened.ino ||
        opened.size <= 0 || opened.size > MAXIMUM_METADATA_BYTES) return undefined;
    const bytes = Buffer.alloc(MAXIMUM_METADATA_BYTES + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== opened.size || bytesRead > MAXIMUM_METADATA_BYTES) return undefined;
    return parseMetadata(bytes.toString("utf8", 0, bytesRead));
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(errorCode(error) ?? "")) return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Each published directory contains exactly one immutable, uniquely named
 * owner record. A delayed stale reclaimer can remove only the old record;
 * nonrecursive rmdir can never remove a replacement owner's populated lock.
 */
async function inspectLock(lockPath: string, unsafe: () => Error): Promise<{
  readonly filename: string;
  readonly metadata: LockMetadata;
} | undefined> {
  const stat = await lstat(lockPath).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return undefined;
  // Existing regular-file locks are never migrated or removed implicitly.
  if (!stat.isDirectory()) throw unsafe();
  let filename: string | undefined;
  const directory = await opendir(lockPath).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  });
  if (!directory) return undefined;
  for await (const entry of directory) {
    if (filename !== undefined || !entry.isFile() || !OWNER_FILE_PATTERN.test(entry.name)) throw unsafe();
    filename = entry.name;
  }
  if (!filename) throw unsafe();
  const metadata = await readOwnerFile(path.join(lockPath, filename));
  if (!metadata) {
    // Another reclaimer may have retired this exact record after our scan.
    if (!await lstat(path.join(lockPath, filename)).catch((error: unknown) => {
      if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) return undefined;
      throw error;
    })) return undefined;
    throw unsafe();
  }
  if (OWNER_FILE_PATTERN.exec(filename)?.[1] !== metadata.ownerToken) throw unsafe();
  return { filename, metadata };
}

async function removeOwner(lockPath: string, filename: string): Promise<void> {
  try {
    await unlink(path.join(lockPath, filename));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? "")) return;
    throw error;
  }
  // Never use recursive removal. A replacement may have been published since
  // unlink; its unique owner record makes this rmdir fail harmlessly.
  try {
    await rmdir(lockPath);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ENOTEMPTY", "EEXIST"].includes(errorCode(error) ?? "")) return;
    throw error;
  }
}

export class ExclusiveProcessLock {
  private released = false;

  private constructor(
    private readonly lockPath: string,
    private readonly identityHash: string,
    private readonly ownerToken: string,
  ) {}

  static async acquire(
    lockPath: string,
    identityHash: string,
    resourceLabel = "state",
  ): Promise<ExclusiveProcessLock> {
    await mkdir(path.dirname(lockPath), { mode: 0o700, recursive: true });
    const metadata: LockMetadata = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      identityHash,
      ownerToken: randomUUID(),
      ...(await currentProcessLiveness()),
    };
    const filename = `owner-${metadata.ownerToken}.json`;
    const candidate = `${lockPath}.candidate-${metadata.ownerToken}`;
    const unsafe = () => new Error(`The Sedes ${resourceLabel} lock (${identityHash.slice(0, 12)}) cannot be recovered safely.`);
    await mkdir(candidate, { mode: 0o700 });
    try {
      const handle = await open(path.join(candidate, filename), "wx", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const existing = await inspectLock(lockPath, unsafe);
        if (existing) {
          if (existing.metadata.identityHash !== identityHash) throw unsafe();
          if (await isLockOwnerRunning(existing.metadata)) {
            throw new Error(`Another Sedes process owns this ${resourceLabel} (lock ${identityHash.slice(0, 12)}).`);
          }
          await removeOwner(lockPath, existing.filename);
        }
        try {
          // Publish only a populated directory. A live lock is never empty,
          // so rename cannot replace another owner on any supported platform.
          await rename(candidate, lockPath);
          return new ExclusiveProcessLock(lockPath, identityHash, metadata.ownerToken);
        } catch (error) {
          if (!["EEXIST", "ENOTEMPTY", "ENOTDIR", "EISDIR", "EPERM"].includes(errorCode(error) ?? "")) throw error;
          if (!await lstat(lockPath).catch((cause: unknown) => {
            if (errorCode(cause) === "ENOENT") return undefined;
            throw cause;
          })) throw error;
        }
      }
      throw new Error("Could not acquire the Sedes process lock.");
    } finally {
      // This unique unpublished candidate belongs only to this attempt.
      await rm(candidate, { recursive: true, force: true });
    }
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }

    const filename = `owner-${this.ownerToken}.json`;
    const existing = await readOwnerFile(path.join(this.lockPath, filename));
    if (
      existing?.pid === process.pid &&
      existing.identityHash === this.identityHash &&
      existing.ownerToken === this.ownerToken
    ) {
      await removeOwner(this.lockPath, filename);
    }
    this.released = true;
  }
}

export function lockIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function acquireStateDirectoryLock(
  stateDirectory: string,
): Promise<ExclusiveProcessLock> {
  await mkdir(stateDirectory, { mode: 0o700, recursive: true });
  const canonicalStateDirectory = await realpath(stateDirectory);
  const identity = lockIdentity(canonicalStateDirectory);
  return ExclusiveProcessLock.acquire(
    path.join(stateDirectory, ".state.lock"),
    identity,
    "state directory",
  );
}

export async function acquireNativeStoreLock(
  canonicalNativeStore: string,
  runtimeRoot: string,
  label: string,
): Promise<ExclusiveProcessLock> {
  const identity = lockIdentity(canonicalNativeStore);
  return ExclusiveProcessLock.acquire(
    path.join(runtimeRoot, "sedes", "locks", `${identity}.lock`),
    identity,
    label,
  );
}
