import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rm } from "node:fs/promises";
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
   * them cheaply. Records written before these fields existed, and records
   * from platforms without them, fall back to PID-only liveness.
   */
  readonly processStartTime?: string;
  readonly bootId?: string;
}

const START_TIME_PATTERN = /^[A-Za-z0-9 :]{1,64}$/u;
const BOOT_ID_PATTERN = /^[A-Za-z0-9-]{1,80}$/u;

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

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        return new ExclusiveProcessLock(
          lockPath,
          identityHash,
          metadata.ownerToken,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }

        const existing = await readFile(lockPath, "utf8")
          .then(parseMetadata)
          .catch(() => undefined);
        if (!existing || existing.identityHash !== identityHash) {
          throw new Error(
            `The Sedes ${resourceLabel} lock (${identityHash.slice(0, 12)}) cannot be recovered safely.`,
          );
        }
        if (await isLockOwnerRunning(existing)) {
          throw new Error(
            `Another Sedes process owns this ${resourceLabel} (lock ${identityHash.slice(0, 12)}).`,
          );
        }
        await rm(lockPath);
      }
    }

    throw new Error("Could not acquire the Sedes process lock.");
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }

    const existing = await readFile(this.lockPath, "utf8").then(
      parseMetadata,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") {
          return undefined;
        }
        throw error;
      },
    );
    if (
      existing?.pid === process.pid &&
      existing.identityHash === this.identityHash &&
      existing.ownerToken === this.ownerToken
    ) {
      await rm(this.lockPath, { force: true });
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
