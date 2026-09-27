import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { BackendNativeStoreLifecycle, BackendNativeStoreLease } from "../module.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

export interface OpenCodeNativeStoreLease extends BackendNativeStoreLease {
  readonly namespaceKey: string;
  readonly canonicalStorePath: string;
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

/** Atomic no-steal ownership. A crash/uncertain cleanup leaves a marker for operator inspection. */
export function createOpenCodeNativeStoreLifecycle(input: {
  readonly canonicalStorePath: string;
  readonly label: string;
}): OpenCodeNativeStoreLifecycle {
  const namespaceKey = openCodeNativeStoreNamespaceKey(input.canonicalStorePath);
  return {
    namespaceKey, sortKey: `opencode:${namespaceKey}`, label: input.label,
    acquire: async () => {
      const parent = path.dirname(input.canonicalStorePath);
      if (await realpath(parent) !== parent) throw new OpenCodeRuntimeError("opencode_native_store_parent_changed");
      const lock = path.join(parent, `.sedes-opencode-${namespaceKey.slice(0, 32)}.lock`);
      try { await mkdir(lock, { mode: 0o700 }); }
      catch { throw new OpenCodeRuntimeError("opencode_native_store_already_owned"); }
      let identity: BigIntStats;
      try { identity = await lstat(lock, { bigint: true }); }
      catch { throw new OpenCodeRuntimeError("opencode_native_store_initialization_unproved"); }
      const token = randomUUID();
      const owner = path.join(lock, "owner.json");
      const serialized = JSON.stringify({ version: 1, token, pid: process.pid });
      let ownerIdentity: BigIntStats | undefined;
      try {
        const descriptor = await open(owner, "wx", 0o600);
        try {
          ownerIdentity = await descriptor.stat({ bigint: true });
          await descriptor.writeFile(serialized); await descriptor.sync();
        }
        finally { await descriptor.close(); }
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
        namespaceKey, canonicalStorePath: input.canonicalStorePath,
        release: () => release ??= (async () => {
          const verify = async (directory: string) => {
            const current = await lstat(directory, { bigint: true });
            if (!current.isDirectory() || current.dev !== identity.dev || current.ino !== identity.ino ||
                current.uid !== BigInt(process.getuid!()) || (current.mode & 0o077n) !== 0n) throw new Error();
            const descriptor = await open(path.join(directory, "owner.json"), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
              const metadata = await descriptor.stat();
              if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid!() ||
                  (metadata.mode & 0o077) !== 0 || metadata.size > 512) throw new Error();
              const bytes = Buffer.alloc(513);
              const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0);
              if (bytesRead > 512 || bytes.subarray(0, bytesRead).toString("utf8") !== serialized) throw new Error();
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
          } catch {
            await mkdir(lock, { mode: 0o700 }).catch(() => undefined);
            throw new OpenCodeRuntimeError("opencode_native_store_release_unproved");
          }
        })(),
      };
    },
  };
}
