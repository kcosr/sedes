import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants, realpathSync, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { BackendNativeStoreLease } from "../module.js";
import { sidecarProcessOwnership, type SidecarProcessIdentity, type SidecarTargetLifetime } from "../../sidecar/sidecar-process-ownership.js";
import { createOpenCodeProcessRecovery } from "./opencode-process-cleanup.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

export interface OpenCodeRuntimeOwnershipAuthority {
  readonly tenantId: string;
  readonly principalId: string;
  readonly backendInstanceId: string;
  readonly executionEnvironmentId: string;
}
const authoritySchema = z.strictObject({
  tenantId: z.string().min(1).max(256), principalId: z.string().min(1).max(256),
  backendInstanceId: z.string().min(1).max(256), executionEnvironmentId: z.string().min(1).max(256),
});
export function openCodeRuntimeAuthorityKey(authority: OpenCodeRuntimeOwnershipAuthority): string {
  const admitted = authoritySchema.parse(authority);
  return createHash("sha256").update(JSON.stringify(["sedes.opencode.runtime-owner.v1",
    admitted.tenantId, admitted.principalId, admitted.backendInstanceId, admitted.executionEnvironmentId])).digest("hex");
}

/** Host-account ownership is independent of the provider's database and launch
 * environment. Provider HOME/XDG overrides must not move a runtime's fence. */
export function defaultOpenCodeOwnershipDirectory(): string {
  const state = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return canonicalOwnershipDirectory(path.join(state, "sedes", "opencode-owners"));
}

/** Resolve host-account aliases before creating state, but never resolve the
 * final ownership directory: that directory itself must remain a real inode. */
function canonicalOwnershipDirectory(directory: string): string {
  if (!path.posix.isAbsolute(directory) || path.posix.normalize(directory) !== directory || directory.includes("\0")) {
    throw new OpenCodeRuntimeError("opencode_runtime_owner_target_invalid");
  }
  const missing = [path.basename(directory)];
  let ancestor = path.dirname(directory);
  for (;;) {
    try { return path.join(realpathSync(ancestor), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || ancestor === path.dirname(ancestor)) {
        throw new OpenCodeRuntimeError("opencode_runtime_owner_directory_invalid");
      }
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}

export interface OpenCodeRuntimeOwnershipLease extends BackendNativeStoreLease {
  readonly authorityKey: string;
  readonly processMarker: string | null;
}
export interface OpenCodeRuntimeOwnershipLifecycle {
  readonly authorityKey: string;
  readonly ownershipDirectory: string;
  readonly label: string;
  acquire(): Promise<OpenCodeRuntimeOwnershipLease>;
}
export interface OpenCodeRuntimeOwnerTarget {
  readonly authorityKey: string;
  readonly ownershipDirectory?: string;
}
function ownerTarget(input: OpenCodeRuntimeOwnerTarget): { authorityKey: string; ownershipDirectory: string } {
  const ownershipDirectory = input.ownershipDirectory ?? defaultOpenCodeOwnershipDirectory();
  if (!/^[a-f0-9]{64}$/u.test(input.authorityKey) || !path.posix.isAbsolute(ownershipDirectory) ||
      path.posix.normalize(ownershipDirectory) !== ownershipDirectory || ownershipDirectory.includes("\0")) {
    throw new OpenCodeRuntimeError("opencode_runtime_owner_target_invalid");
  }
  return { authorityKey: input.authorityKey, ownershipDirectory: canonicalOwnershipDirectory(ownershipDirectory) };
}
async function assertOwnershipDirectory(directory: string): Promise<void> {
  try {
    const metadata = await lstat(directory, { bigint: true });
    if (await realpath(directory) !== directory || !metadata.isDirectory() ||
        metadata.uid !== BigInt(process.getuid!()) || (metadata.mode & 0o777n) !== 0o700n) throw new Error();
  } catch {
    throw new OpenCodeRuntimeError("opencode_runtime_owner_directory_invalid");
  }
}

const OWNER_MAXIMUM_BYTES = 8_192;
const ownerSchema = z.strictObject({
  version: z.literal(1), token: z.uuid(), authorityKey: z.string().regex(/^[a-f0-9]{64}$/u),
  authority: authoritySchema, ownership: z.enum(["owned", "external"]),
  hostIncarnation: z.string().min(1).max(256),
  process: z.custom<SidecarProcessIdentity>(sidecarProcessOwnership.validProcess),
  lifetime: z.custom<SidecarTargetLifetime>(sidecarProcessOwnership.validLifetime),
  processMarker: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
}).refine(record => (record.ownership === "owned") === (record.processMarker !== null) &&
  sidecarProcessOwnership.lifetimeMatchesProcess(record.lifetime, record.process));
export type OpenCodeRuntimeOwnerRecord = z.infer<typeof ownerSchema>;
export interface OpenCodeRuntimeOwnerInspection {
  readonly record: OpenCodeRuntimeOwnerRecord;
  /** Exact file/directory inode, token and bytes; required by explicit recovery. */
  readonly fingerprint: string;
}

function lockPath(target: ReturnType<typeof ownerTarget>): string {
  return path.join(target.ownershipDirectory, `${target.authorityKey}.lock`);
}
async function syncDirectory(directory: string): Promise<void> {
  const descriptor = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await descriptor.sync(); } finally { await descriptor.close(); }
}
async function readOwner(target: ReturnType<typeof ownerTarget>, directory = lockPath(target)): Promise<OpenCodeRuntimeOwnerInspection> {
  try {
    await assertOwnershipDirectory(target.ownershipDirectory);
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
      if (record.authorityKey !== target.authorityKey || record.authorityKey !== openCodeRuntimeAuthorityKey(record.authority)) throw new Error();
      const currentDirectory = await lstat(directory, { bigint: true }), currentOwner = await lstat(path.join(directory, "owner.json"), { bigint: true });
      if (currentDirectory.dev !== identity.dev || currentDirectory.ino !== identity.ino ||
          currentOwner.dev !== metadata.dev || currentOwner.ino !== metadata.ino) throw new Error();
      const fingerprint = createHash("sha256").update(JSON.stringify([identity.dev.toString(), identity.ino.toString(),
        metadata.dev.toString(), metadata.ino.toString(), serialized])).digest("hex");
      return { record, fingerprint };
    } finally { await descriptor.close(); }
  } catch (error) {
    if (error instanceof OpenCodeRuntimeError && error.code === "opencode_runtime_owner_directory_invalid") throw error;
    throw new OpenCodeRuntimeError("opencode_runtime_owner_recovery_required");
  }
}

/** Read-only inspection does not confer permission to signal the owner. */
export function inspectOpenCodeRuntimeOwner(input: OpenCodeRuntimeOwnerTarget): Promise<OpenCodeRuntimeOwnerInspection> {
  return readOwner(ownerTarget(input));
}

async function retireOwner(target: ReturnType<typeof ownerTarget>, inspection: OpenCodeRuntimeOwnerInspection): Promise<void> {
  const { token } = inspection.record, lock = lockPath(target);
  const verify = async (directory: string) => {
    if ((await readOwner(target, directory)).fingerprint !== inspection.fingerprint) throw new Error();
  };
  try {
    await verify(lock);
    const retired = `${lock}.released-${token}`;
    await rename(lock, retired); await verify(retired);
    await unlink(path.join(retired, "owner.json")); await rmdir(retired);
    await syncDirectory(target.ownershipDirectory);
  } catch {
    await mkdir(lock, { mode: 0o700 }).catch(() => undefined);
    throw new OpenCodeRuntimeError("opencode_runtime_owner_release_unproved");
  }
}

/** Host-local operator recovery requires the exact inspected record. A dead
 * Sedes PID alone never authorizes removing an owned process's fence. */
export async function recoverOpenCodeRuntimeOwner(input: OpenCodeRuntimeOwnerTarget & {
  readonly expectedInspectionFingerprint: string;
  readonly terminateOwnedDescendants: boolean;
}): Promise<void> {
  const target = ownerTarget(input), inspection = await readOwner(target), record = inspection.record;
  if (inspection.fingerprint !== input.expectedInspectionFingerprint) throw new OpenCodeRuntimeError("opencode_runtime_owner_recovery_changed");
  const assertDeadOwner = async () => {
    const current = await readOwner(target);
    if (current.fingerprint !== inspection.fingerprint) throw new OpenCodeRuntimeError("opencode_runtime_owner_recovery_changed");
    const lifetime = await sidecarProcessOwnership.readTargetLifetime();
    // A changed namespace or time namespace cannot grant signal authority in
    // another process tree. Keep its fence for explicit host repair.
    if (JSON.stringify(lifetime) !== JSON.stringify(record.lifetime)) throw new OpenCodeRuntimeError("opencode_runtime_owner_recovery_required");
    if (await sidecarProcessOwnership.processMatches(record.process)) throw new OpenCodeRuntimeError("opencode_runtime_owner_already_owned");
  };
  await assertDeadOwner();
  if (record.ownership === "owned") {
    const recovery = await createOpenCodeProcessRecovery(record.processMarker!, record.process.startTime, assertDeadOwner);
    try { if (input.terminateOwnedDescendants) await recovery.stop(); else await recovery.inspect(); }
    catch { throw new OpenCodeRuntimeError("opencode_runtime_owner_recovery_required"); }
  }
  await assertDeadOwner(); await retireOwner(target, inspection);
}

/** Ownership and the descendant marker are durable before the first launch. */
export function createOpenCodeRuntimeOwnershipLifecycle(input: {
  readonly authority: OpenCodeRuntimeOwnershipAuthority;
  readonly ownershipDirectory?: string;
  readonly label: string;
  readonly ownership: "owned" | "external";
  readonly hostIncarnation: string;
}): OpenCodeRuntimeOwnershipLifecycle {
  const authority = authoritySchema.parse(input.authority);
  const target = ownerTarget({ authorityKey: openCodeRuntimeAuthorityKey(authority), ownershipDirectory: input.ownershipDirectory });
  const { authorityKey, ownershipDirectory } = target;
  return {
    authorityKey, ownershipDirectory, label: input.label,
    acquire: async () => {
      const parent = ownershipDirectory;
      try { await mkdir(parent, { recursive: true, mode: 0o700 }); }
      catch { throw new OpenCodeRuntimeError("opencode_runtime_owner_directory_invalid"); }
      await assertOwnershipDirectory(parent);
      const ownerProcess = await sidecarProcessOwnership.readProcess(process.pid);
      const lifetime = await sidecarProcessOwnership.readTargetLifetime();
      const token = randomUUID(), processMarker = input.ownership === "owned" ? randomBytes(32).toString("hex") : null;
      const record = ownerSchema.parse({ version: 1, token, authorityKey, authority,
        ownership: input.ownership, hostIncarnation: input.hostIncarnation, process: ownerProcess, lifetime, processMarker });
      const lock = lockPath(target);
      try { await mkdir(lock, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new OpenCodeRuntimeError("opencode_runtime_owner_already_owned");
        const existing = await readOwner(target);
        await recoverOpenCodeRuntimeOwner({ ...target,
          expectedInspectionFingerprint: existing.fingerprint, terminateOwnedDescendants: false });
        try { await mkdir(lock, { mode: 0o700 }); }
        catch { throw new OpenCodeRuntimeError("opencode_runtime_owner_already_owned"); }
      }
      let identity: BigIntStats;
      try { identity = await lstat(lock, { bigint: true }); }
      catch { throw new OpenCodeRuntimeError("opencode_runtime_owner_initialization_unproved"); }
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
          throw new OpenCodeRuntimeError("opencode_runtime_owner_initialization_unproved");
        }
        throw new OpenCodeRuntimeError("opencode_runtime_owner_write_failed");
      }
      let release: Promise<void> | undefined;
      return {
        authorityKey, processMarker,
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
            throw new OpenCodeRuntimeError("opencode_runtime_owner_release_unproved");
          }
        })(),
      };
    },
  };
}
