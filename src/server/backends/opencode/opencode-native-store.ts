import { createHash } from "node:crypto";
import path from "node:path";
import { OpenCodeRuntimeError } from "./opencode-release.js";

export function openCodeNativeStoreNamespaceKey(canonicalStorePath: string): string {
  // Main derives this identity too, including when a Windows main selects a
  // Linux execution host. Filesystem admission still belongs to that host.
  if (!path.posix.isAbsolute(canonicalStorePath) || path.posix.normalize(canonicalStorePath) !== canonicalStorePath) {
    throw new OpenCodeRuntimeError("opencode_native_store_path_invalid");
  }
  return createHash("sha256").update("sedes.opencode-native-store.v2\0").update(canonicalStorePath).digest("hex");
}
