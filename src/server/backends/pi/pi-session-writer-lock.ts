import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { ExclusiveProcessLock, lockIdentity } from "../../security/locks.js";
import { readBootIdentity } from "../../runtime/process-table.js";

export interface PiSessionWriterLock {
  release(): Promise<void>;
}

export class PiSessionWriterCleanupRequiredError extends Error {
  readonly code = "pi_session_native_writer_cleanup_required";
  constructor() { super("pi_session_native_writer_cleanup_required"); this.name = "PiSessionWriterCleanupRequiredError"; }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
interface NativeWriterMarker {
  readonly version: 1;
  readonly identity: string;
  readonly ownerToken: string;
  readonly hostPid: number;
  readonly bootId: string | null;
}
async function currentBootId(): Promise<string | null> {
  const value = await readBootIdentity();
  return value && uuid.test(value) ? value.toLowerCase() : null;
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return right.isFile() && left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
async function markerStat(filename: string): Promise<BigIntStats | undefined> {
  return lstat(filename, { bigint: true }).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });
}
async function readMarker(filename: string, identity: string): Promise<{ record: NativeWriterMarker; stat: BigIntStats } | undefined> {
  const named = await markerStat(filename);
  if (!named) return undefined;
  if (!named.isFile() || named.size === 0n || named.size > 4096n) throw new PiSessionWriterCleanupRequiredError();
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch(() => { throw new PiSessionWriterCleanupRequiredError(); });
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(named, opened)) throw new PiSessionWriterCleanupRequiredError();
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (BigInt(bytesRead) !== named.size || !sameFile(opened, await handle.stat({ bigint: true }))) throw new PiSessionWriterCleanupRequiredError();
    let record: NativeWriterMarker;
    try { record = JSON.parse(buffer.toString("utf8", 0, bytesRead)) as NativeWriterMarker; }
    catch { throw new PiSessionWriterCleanupRequiredError(); }
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        Object.keys(record).sort().join() !== "bootId,hostPid,identity,ownerToken,version" || record.version !== 1 ||
        record.identity !== identity || typeof record.ownerToken !== "string" || !uuid.test(record.ownerToken) ||
        !Number.isSafeInteger(record.hostPid) || record.hostPid <= 0 ||
        !(record.bootId === null || (typeof record.bootId === "string" && uuid.test(record.bootId)))) throw new PiSessionWriterCleanupRequiredError();
    return { record, stat: opened };
  } finally { await handle.close(); }
}
/** Called only while the session's exclusive writer lease is held. A changed
 * inode or contents is not the inspected marker and must never be removed. */
async function removeExactMarker(filename: string, expected: BigIntStats): Promise<void> {
  const current = await markerStat(filename);
  if (!current || !sameFile(expected, current)) throw new PiSessionWriterCleanupRequiredError();
  await unlink(filename);
}

/**
 * SDK sessions and native Pi processes share this exact writer boundary.
 * Keep the lock beside the session so different Sedes runtime directories
 * cannot admit competing writers. An absent file uses its canonical parent,
 * giving atomic creation and the resulting live session the same identity.
 */
export async function acquirePiSessionWriterLock(
  sessionFile: string,
  options: { readonly detachedWriter?: boolean } = {},
): Promise<PiSessionWriterLock> {
  if (!path.isAbsolute(sessionFile)) throw new Error("pi_session_path_invalid");
  await mkdir(path.dirname(sessionFile), { recursive: true, mode: 0o700 });
  const canonicalFile = await realpath(sessionFile).catch(async (cause: NodeJS.ErrnoException) => {
    if (cause.code !== "ENOENT") throw cause;
    const entry = await lstat(sessionFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return undefined;
    });
    // A dangling file symlink would gain a different lock identity when its
    // target appears. Only genuinely absent files can use the parent identity.
    if (entry) throw new Error("pi_session_path_unresolved");
    return path.join(await realpath(path.dirname(sessionFile)), path.basename(sessionFile));
  });
  const identity = lockIdentity(canonicalFile);
  const lock = await ExclusiveProcessLock.acquire(
    `${canonicalFile}.sedes-writer.lock`,
    identity,
    "Pi session writer",
  );
  const markerFile = `${canonicalFile}.sedes-native-writer`;
  const ownerToken = options.detachedWriter ? randomUUID() : undefined;
  let createdMarker: BigIntStats | undefined;
  let ownedRecord: NativeWriterMarker | undefined;
  try {
    const marker = await readMarker(markerFile, identity);
    const bootId = await currentBootId();
    if (marker) {
      // Host PID death says nothing about a detached child or its descendants.
      // A different kernel boot proves every process from that boot is gone.
      if (!bootId || !marker.record.bootId || bootId === marker.record.bootId.toLowerCase()) throw new PiSessionWriterCleanupRequiredError();
      await removeExactMarker(markerFile, marker.stat);
    }
    if (ownerToken) {
      // The process owning this lease may die before its native child. A
      // durable marker prevents PID-only stale recovery from admitting SDK
      // writes until the native child has positively closed. Do not infer
      // native-child death from this host process's liveness.
      const handle = await open(markerFile, "wx", 0o600);
      try {
        ownedRecord = { version: 1, identity, ownerToken, hostPid: process.pid, bootId };
        await handle.writeFile(`${JSON.stringify(ownedRecord)}\n`, "utf8");
        await handle.sync();
      } finally {
        try { createdMarker = await handle.stat({ bigint: true }); }
        finally { await handle.close(); }
      }
    }
  } catch (cause) {
    // No caller can have launched a child until this acquisition returns.
    try { if (createdMarker) await removeExactMarker(markerFile, createdMarker); }
    finally { await lock.release(); }
    throw cause;
  }
  let releasing: Promise<void> | undefined;
  return {
    release() {
      return releasing ??= (async () => {
        if (ownerToken) {
          const marker = await readMarker(markerFile, identity);
          if (marker) {
            if (!createdMarker || !sameFile(createdMarker, marker.stat) || JSON.stringify(marker.record) !== JSON.stringify(ownedRecord)) {
              throw new Error("pi_session_native_writer_identity_changed");
            }
            await removeExactMarker(markerFile, marker.stat);
          }
        }
        await lock.release();
      })().catch((cause) => { releasing = undefined; throw cause; });
    },
  };
}
