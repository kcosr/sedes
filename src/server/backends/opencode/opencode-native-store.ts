import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { BackendNativeStoreLifecycle, BackendNativeStoreLease } from "../module.js";
import { sidecarProcessOwnership, type SidecarProcessIdentity, type SidecarTargetLifetime } from "../../sidecar/sidecar-process-ownership.js";
import { createOpenCodeProcessRecovery } from "./opencode-process-cleanup.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

export interface OpenCodeNativeStoreLease extends BackendNativeStoreLease {
  readonly namespaceKey: string;
  readonly canonicalStorePath: string;
  readonly processMarker: string | null;
}

export interface OpenCodeNativeStoreLifecycle extends BackendNativeStoreLifecycle {
  acquire(): Promise<OpenCodeNativeStoreLease>;
}

export function openCodeNativeStoreNamespaceKey(canonicalStorePath: string): string {
  // Main derives this identity too, including when a Windows main selects a
  // Linux execution host. Filesystem admission still belongs to that host.
  if (!path.posix.isAbsolute(canonicalStorePath) || path.posix.normalize(canonicalStorePath) !== canonicalStorePath) {
    throw new OpenCodeRuntimeError("opencode_native_store_path_invalid");
  }
  return createHash("sha256").update("sedes.opencode-native-store.v2\0").update(canonicalStorePath).digest("hex");
}

const OWNER_MAXIMUM_BYTES = 8_192;
const ownerSchema = z.strictObject({
  version: z.literal(2), token: z.uuid(), namespaceKey: z.string().regex(/^[a-f0-9]{64}$/u),
  canonicalStorePath: z.string().min(1).max(4_096), ownership: z.enum(["owned", "external"]),
  hostIncarnation: z.string().min(1).max(256),
  process: z.custom<SidecarProcessIdentity>(sidecarProcessOwnership.validProcess),
  lifetime: z.custom<SidecarTargetLifetime>(sidecarProcessOwnership.validLifetime),
  processMarker: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
}).refine(record => (record.ownership === "owned") === (record.processMarker !== null) &&
  sidecarProcessOwnership.lifetimeMatchesProcess(record.lifetime, record.process));
export type OpenCodeNativeStoreOwnerRecord = z.infer<typeof ownerSchema>;
export interface OpenCodeNativeStoreOwnerInspection {
  readonly record: OpenCodeNativeStoreOwnerRecord;
  /** Exact file/directory inode, token and bytes; required by explicit recovery. */
  readonly fingerprint: string;
}

function lockPath(canonicalStorePath: string): string {
  return path.join(path.dirname(canonicalStorePath), `.sedes-opencode-${openCodeNativeStoreNamespaceKey(canonicalStorePath).slice(0, 32)}.lock`);
}
async function syncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await descriptor.sync(); } finally { await descriptor.close(); }
}
async function readOwner(canonicalStorePath: string, directory = lockPath(canonicalStorePath)): Promise<OpenCodeNativeStoreOwnerInspection> {
  try {
    const parent = path.dirname(canonicalStorePath);
    if (await realpath(parent) !== parent) throw new Error();
    const identity = await lstat(directory, { bigint: true });
    if (!identity.isDirectory() || identity.uid !== BigInt(process.getuid!()) || (identity.mode & 0o777n) !== 0o700n) throw new Error();
    const entries = await readdir(directory);
    if (entries.length !== 1 || entries[0] !== "owner.json") throw new Error();
    const descriptor = await open(path.join(directory, "owner.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await descriptor.stat({ bigint: true });
      if (!metadata.isFile() || metadata.nlink !== 1n || metadata.uid !== BigInt(process.getuid!()) ||
          (metadata.mode & 0o777n) !== 0o600n || metadata.size > BigInt(OWNER_MAXIMUM_BYTES)) throw new Error();
      const bytes = Buffer.alloc(OWNER_MAXIMUM_BYTES + 1);
      const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
      if (bytesRead > OWNER_MAXIMUM_BYTES || BigInt(bytesRead) !== metadata.size) throw new Error();
      const serialized = bytes.subarray(0, bytesRead).toString("utf8"), record = ownerSchema.parse(JSON.parse(serialized));
      if (record.canonicalStorePath !== canonicalStorePath || record.namespaceKey !== openCodeNativeStoreNamespaceKey(canonicalStorePath)) throw new Error();
      const currentDirectory = await lstat(directory, { bigint: true }), currentOwner = await lstat(path.join(directory, "owner.json"), { bigint: true });
      if (currentDirectory.dev !== identity.dev || currentDirectory.ino !== identity.ino ||
          currentOwner.dev !== metadata.dev || currentOwner.ino !== metadata.ino) throw new Error();
      const fingerprint = createHash("sha256").update(JSON.stringify([identity.dev.toString(), identity.ino.toString(),
        metadata.dev.toString(), metadata.ino.toString(), serialized])).digest("hex");
      return { record, fingerprint };
    } finally { await descriptor.close(); }
  } catch { throw new OpenCodeRuntimeError("opencode_native_store_recovery_required"); }
}

/** Read-only inspection does not confer permission to signal the owner. */
export function inspectOpenCodeNativeStoreOwner(canonicalStorePath: string): Promise<OpenCodeNativeStoreOwnerInspection> {
  return readOwner(canonicalStorePath);
}

async function retireOwner(inspection: OpenCodeNativeStoreOwnerInspection): Promise<void> {
  const { canonicalStorePath, token } = inspection.record, lock = lockPath(canonicalStorePath);
  const verify = async (directory: string) => {
    if ((await readOwner(canonicalStorePath, directory)).fingerprint !== inspection.fingerprint) throw new Error();
  };
  try {
    await verify(lock);
    const retired = `${lock}.released-${token}`;
    await rename(lock, retired); await verify(retired);
    await unlink(path.join(retired, "owner.json")); await rmdir(retired);
    await syncDirectory(path.dirname(canonicalStorePath));
  } catch {
    await mkdir(lock, { mode: 0o700 }).catch(() => undefined);
    throw new OpenCodeRuntimeError("opencode_native_store_release_unproved");
  }
}

/** Host-local operator recovery requires the exact inspected record. A dead
 * Sedes PID alone never authorizes removing an owned process's fence. */
export async function recoverOpenCodeNativeStoreOwner(input: {
  readonly canonicalStorePath: string;
  readonly expectedInspectionFingerprint: string;
  readonly terminateOwnedDescendants: boolean;
}): Promise<void> {
  const inspection = await readOwner(input.canonicalStorePath), record = inspection.record;
  if (inspection.fingerprint !== input.expectedInspectionFingerprint) throw new OpenCodeRuntimeError("opencode_native_store_recovery_changed");
  const assertDeadOwner = async () => {
    const current = await readOwner(input.canonicalStorePath);
    if (current.fingerprint !== inspection.fingerprint) throw new OpenCodeRuntimeError("opencode_native_store_recovery_changed");
    const lifetime = await sidecarProcessOwnership.readTargetLifetime();
    // A changed namespace or time namespace cannot grant signal authority in
    // another process tree. Keep its fence for explicit host repair.
    if (JSON.stringify(lifetime) !== JSON.stringify(record.lifetime)) throw new OpenCodeRuntimeError("opencode_native_store_recovery_required");
    if (await sidecarProcessOwnership.processMatches(record.process)) throw new OpenCodeRuntimeError("opencode_native_store_already_owned");
  };
  await assertDeadOwner();
  if (record.ownership === "owned") {
    const recovery = await createOpenCodeProcessRecovery(record.processMarker!, record.process.startTime, assertDeadOwner);
    try { if (input.terminateOwnedDescendants) await recovery.stop(); else await recovery.inspect(); }
    catch { throw new OpenCodeRuntimeError("opencode_native_store_recovery_required"); }
  }
  await assertDeadOwner(); await retireOwner(inspection);
}

/** Ownership and the descendant marker are durable before the first launch. */
export function createOpenCodeNativeStoreLifecycle(input: {
  readonly canonicalStorePath: string;
  readonly label: string;
  readonly ownership: "owned" | "external";
  readonly hostIncarnation: string;
}): OpenCodeNativeStoreLifecycle {
  const namespaceKey = openCodeNativeStoreNamespaceKey(input.canonicalStorePath);
  return {
    namespaceKey, sortKey: `opencode:${namespaceKey}`, label: input.label,
    acquire: async () => {
      const parent = path.dirname(input.canonicalStorePath);
      if (await realpath(parent) !== parent) throw new OpenCodeRuntimeError("opencode_native_store_parent_changed");
      const ownerProcess = await sidecarProcessOwnership.readProcess(process.pid);
      const lifetime = await sidecarProcessOwnership.readTargetLifetime();
      const token = randomUUID(), processMarker = input.ownership === "owned" ? randomBytes(32).toString("hex") : null;
      const record = ownerSchema.parse({ version: 2, token, namespaceKey, canonicalStorePath: input.canonicalStorePath,
        ownership: input.ownership, hostIncarnation: input.hostIncarnation, process: ownerProcess, lifetime, processMarker });
      const lock = lockPath(input.canonicalStorePath);
      try { await mkdir(lock, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new OpenCodeRuntimeError("opencode_native_store_already_owned");
        const existing = await readOwner(input.canonicalStorePath);
        await recoverOpenCodeNativeStoreOwner({ canonicalStorePath: input.canonicalStorePath,
          expectedInspectionFingerprint: existing.fingerprint, terminateOwnedDescendants: false });
        try { await mkdir(lock, { mode: 0o700 }); }
        catch { throw new OpenCodeRuntimeError("opencode_native_store_already_owned"); }
      }
      let identity: BigIntStats;
      try { identity = await lstat(lock, { bigint: true }); }
      catch { throw new OpenCodeRuntimeError("opencode_native_store_initialization_unproved"); }
      const owner = path.join(lock, "owner.json");
      const serialized = JSON.stringify(record);
      let ownerIdentity: BigIntStats | undefined;
      try {
        const descriptor = await open(owner, "wx", 0o600);
        try {
          ownerIdentity = await descriptor.stat({ bigint: true });
          await descriptor.writeFile(serialized); await descriptor.sync();
        }
        finally { await descriptor.close(); }
        await syncDirectory(lock); await syncDirectory(parent);
      } catch {
        // No native process has started. Remove only the exact directory and
        // partial owner record created here; unknown identities/remnants retain
        // the no-steal fence just like an uncertain running-owner shutdown.
        try {
          const verifyPartial = async (directory: string) => {
            const current = await lstat(directory, { bigint: true });
            if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino ||
                current.uid !== BigInt(process.getuid!()) || (current.mode & 0o077n) !== 0n) throw new Error();
            const entries = await readdir(directory);
            if (entries.length === 0 && !ownerIdentity) return;
            if (entries.length !== 1 || entries[0] !== "owner.json" || !ownerIdentity) throw new Error();
            const descriptor = await open(path.join(directory, "owner.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const metadata = await descriptor.stat({ bigint: true });
              if (!metadata.isFile() || metadata.dev !== ownerIdentity.dev || metadata.ino !== ownerIdentity.ino ||
                  metadata.nlink !== 1n || metadata.uid !== BigInt(process.getuid!()) ||
                  (metadata.mode & 0o077n) !== 0n || metadata.size > BigInt(Buffer.byteLength(serialized))) throw new Error();
              const bytes = Buffer.alloc(Buffer.byteLength(serialized) + 1);
              const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
              if (!Buffer.from(serialized).subarray(0, bytesRead).equals(bytes.subarray(0, bytesRead))) throw new Error();
            } finally { await descriptor.close(); }
          };
          await verifyPartial(lock);
          const retired = `${lock}.failed-${token}`;
          await rename(lock, retired);
          await verifyPartial(retired);
          if (ownerIdentity) await unlink(path.join(retired, "owner.json"));
          await rmdir(retired);
        } catch {
          await mkdir(lock, { mode: 0o700 }).catch(() => undefined);
          throw new OpenCodeRuntimeError("opencode_native_store_initialization_unproved");
        }
        throw new OpenCodeRuntimeError("opencode_native_store_owner_write_failed");
      }
      let release: Promise<void> | undefined;
      return {
        namespaceKey, canonicalStorePath: input.canonicalStorePath, processMarker,
        release: () => release ??= (async () => {
          const verify = async (directory: string) => {
            const current = await lstat(directory, { bigint: true });
            if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino ||
                current.uid !== BigInt(process.getuid!()) || (current.mode & 0o077n) !== 0n) throw new Error();
            const descriptor = await open(path.join(directory, "owner.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const metadata = await descriptor.stat({ bigint: true });
              if (!metadata.isFile() || metadata.dev !== ownerIdentity!.dev || metadata.ino !== ownerIdentity!.ino ||
                  metadata.nlink !== 1n || metadata.uid !== BigInt(process.getuid!()) || (metadata.mode & 0o077n) !== 0n || metadata.size > BigInt(OWNER_MAXIMUM_BYTES)) throw new Error();
              const bytes = Buffer.alloc(OWNER_MAXIMUM_BYTES + 1);
              const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
              if (bytesRead > OWNER_MAXIMUM_BYTES || bytes.subarray(0, bytesRead).toString("utf8") !== serialized) throw new Error();
            } finally { await descriptor.close(); }
          };
          try {
            // Verify again after quarantine: pathname replacement never permits
            // deleting someone else's metadata or silently dropping the fence.
            await verify(lock);
            const retired = `${lock}.released-${token}`;
            await rename(lock, retired);
            await verify(retired);
            await unlink(path.join(retired, "owner.json"));
            await rmdir(retired);
            await syncDirectory(parent);
          } catch {
            await mkdir(lock, { mode: 0o700 }).catch(() => undefined);
            throw new OpenCodeRuntimeError("opencode_native_store_release_unproved");
          }
        })(),
      };
    },
  };
}
