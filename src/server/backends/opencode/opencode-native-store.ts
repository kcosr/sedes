import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
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
  if (!path.isAbsolute(canonicalStorePath) || path.normalize(canonicalStorePath) !== canonicalStorePath) {
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
      const identity = await lstat(lock, { bigint: true });
      const token = randomUUID();
      const owner = path.join(lock, "owner.json");
      const serialized = JSON.stringify({ version: 1, token, pid: process.pid });
      try {
        const descriptor = await open(owner, "wx", 0o600);
        try { await descriptor.writeFile(serialized); await descriptor.sync(); }
        finally { await descriptor.close(); }
      } catch { throw new OpenCodeRuntimeError("opencode_native_store_owner_write_failed"); }
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
