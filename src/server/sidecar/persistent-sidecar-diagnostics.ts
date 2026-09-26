import { constants } from "node:fs";
import { lstat, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { assertOwnedDirectory, ensureOwnedDirectory } from "./persistent-sidecar-bootstrap.js";

const MAXIMUM_CONFIGURATION_BYTES = 1_024;
/** Earlier daemon PIDs whose capture files survive a restart. */
const RETAINED_PREVIOUS_CAPTURES = 4;
const CAPTURE_FILE_PATTERN = /^delivery-([1-9][0-9]{0,9})\.jsonl(?:\.1)?$/u;

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
    await pruneDeliveryCaptures(directory, process.pid).catch(() => undefined);
    return { enabled: true, filePath: path.join(directory, `delivery-${process.pid}.jsonl`) };
  } catch { return; }
}

/**
 * Each daemon PID writes at most a 1 MiB file plus one rotation. Keep this
 * PID and the most recent earlier PIDs; never remove a live PID's capture or
 * anything other than an owned regular capture file.
 */
export async function pruneDeliveryCaptures(
  directory: string,
  currentPid: number,
  retain = RETAINED_PREVIOUS_CAPTURES,
): Promise<readonly string[]> {
  const captures = new Map<number, { newest: number; files: string[] }>();
  for (const name of await readdir(directory)) {
    const pid = Number(CAPTURE_FILE_PATTERN.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid === currentPid) continue;
    const metadata = await lstat(path.join(directory, name));
    if (!metadata.isFile() || metadata.uid !== process.getuid?.()) continue;
    const capture = captures.get(pid) ?? { newest: 0, files: [] };
    capture.newest = Math.max(capture.newest, metadata.mtimeMs);
    capture.files.push(name);
    captures.set(pid, capture);
  }
  const removed: string[] = [];
  const expired = [...captures].sort(([, left], [, right]) => right.newest - left.newest).slice(retain);
  for (const [pid, capture] of expired) {
    if (processMayExist(pid)) continue;
    for (const name of capture.files) {
      await unlink(path.join(directory, name));
      removed.push(name);
    }
  }
  return removed;
}

function processMayExist(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}
