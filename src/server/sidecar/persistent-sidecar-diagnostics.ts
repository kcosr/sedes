import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { assertOwnedDirectory, ensureOwnedDirectory } from "./persistent-sidecar-bootstrap.js";

const MAXIMUM_CONFIGURATION_BYTES = 1_024;

/** Local operator opt-in, scoped to this already validated service namespace.
 * It is deliberately absent from application configuration and management RPCs.
 * Invalid or unavailable diagnostics never prevent normal service startup. */
export async function persistentSidecarDiagnosticOptions(
  serviceDirectory: string,
): Promise<{ readonly enabled: true; readonly filePath: string } | undefined> {
  if (process.platform !== "linux" && process.platform !== "darwin") return;
  try {
    if (!path.isAbsolute(serviceDirectory) || path.normalize(serviceDirectory) !== serviceDirectory) return;
    await assertOwnedDirectory(serviceDirectory, true);
    const configurationPath = path.join(serviceDirectory, "diagnostics.json");
    const before = await lstat(configurationPath);
    if (!before.isFile() || before.isSymbolicLink()) return;
    const configuration = await open(configurationPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await configuration.stat();
      if (!metadata.isFile() || metadata.uid !== process.getuid?.() || metadata.nlink !== 1 ||
        (metadata.mode & 0o777) !== 0o600 || metadata.size > MAXIMUM_CONFIGURATION_BYTES ||
        metadata.dev !== before.dev || metadata.ino !== before.ino) return;
      // A fixed read stays bounded even if the operator replaces or grows the
      // file concurrently. No arbitrary path or environment value is admitted.
      const bytes = Buffer.alloc(MAXIMUM_CONFIGURATION_BYTES + 1);
      const { bytesRead } = await configuration.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAXIMUM_CONFIGURATION_BYTES) return;
      const value: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).length !== 1 || !("delivery" in value) || value.delivery !== true) return;
    } finally { await configuration.close(); }
    const directory = path.join(serviceDirectory, "diagnostics");
    await ensureOwnedDirectory(directory);
    return { enabled: true, filePath: path.join(directory, `delivery-${process.pid}.jsonl`) };
  } catch { return; }
}
