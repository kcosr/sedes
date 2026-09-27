import { open, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseLinuxProcessStat } from "../../runtime/process-table.js";
import { OpenCodeRuntimeError } from "./opencode-release.js";

export interface OpenCodeFileIdentity { readonly device: string; readonly inode: string; }
export interface OpenCodeNativeIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly uid: number;
  readonly executablePath: string;
  readonly executable: OpenCodeFileIdentity;
  readonly nativeStorePath: string;
  readonly store: OpenCodeFileIdentity;
  readonly storeObservation: "open_file" | "operator_declared";
}

export async function boundedOpenCodeProcessFile(file: string, maximumBytes: number): Promise<Buffer> {
  const descriptor = await open(file, "r");
  try {
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await descriptor.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) return bytes.subarray(0, length);
      length += result.bytesRead;
    }
    throw new OpenCodeRuntimeError("opencode_process_metadata_too_large");
  } finally { await descriptor.close(); }
}

export async function canonicalOpenCodeStore(value: string, allowMissing: boolean): Promise<string> {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) throw new OpenCodeRuntimeError("opencode_native_store_path_invalid");
  try {
    const canonical = await realpath(value);
    if (canonical !== value) throw new OpenCodeRuntimeError("opencode_native_store_not_canonical");
    const metadata = await stat(canonical);
    if (!metadata.isFile() || metadata.nlink !== 1) throw new OpenCodeRuntimeError("opencode_native_store_identity_ambiguous");
    return canonical;
  }
  catch (cause) {
    if (cause instanceof OpenCodeRuntimeError) throw cause;
    if (!allowMissing || (cause as NodeJS.ErrnoException).code !== "ENOENT") throw new OpenCodeRuntimeError("opencode_native_store_unavailable");
    try {
      const canonical = path.join(await realpath(path.dirname(value)), path.basename(value));
      if (canonical !== value) throw new Error();
      return canonical;
    }
    catch { throw new OpenCodeRuntimeError("opencode_native_store_parent_unavailable"); }
  }
}

export async function openCodeFileIdentity(file: string): Promise<OpenCodeFileIdentity> {
  try {
    const metadata = await stat(file, { bigint: true });
    if (!metadata.isFile()) throw new Error();
    return Object.freeze({ device: String(metadata.dev), inode: String(metadata.ino) });
  } catch { throw new OpenCodeRuntimeError("opencode_native_file_identity_unavailable"); }
}

export async function readOpenCodeNativeIdentity(input: {
  readonly pid: number;
  readonly nativeStorePath: string;
  readonly expectedExecutablePath?: string;
}): Promise<OpenCodeNativeIdentity> {
  if (process.platform !== "linux" || !process.getuid || !Number.isSafeInteger(input.pid) || input.pid <= 1) {
    throw new OpenCodeRuntimeError("opencode_local_process_identity_unavailable");
  }
  try {
    const proc = `/proc/${input.pid}`;
    const before = parseLinuxProcessStat(input.pid, (await boundedOpenCodeProcessFile(`${proc}/stat`, 4_096)).toString("utf8"));
    const uid = (await stat(proc)).uid;
    if (!before || before.exited || uid !== process.getuid()) throw new Error();
    const executablePath = await readlink(`${proc}/exe`);
    if (!path.isAbsolute(executablePath) || (input.expectedExecutablePath && executablePath !== input.expectedExecutablePath)) throw new Error();
    const executable = await openCodeFileIdentity(`${proc}/exe`);
    const nativeStorePath = await canonicalOpenCodeStore(input.nativeStorePath, false);
    const store = await openCodeFileIdentity(nativeStorePath);
    let storeObservation: OpenCodeNativeIdentity["storeObservation"] = "operator_declared";
    const descriptors = await readdir(`${proc}/fd`);
    if (descriptors.length > 16_384) throw new Error();
    for (const descriptor of descriptors) {
      try {
        const file = await stat(`${proc}/fd/${descriptor}`, { bigint: true });
        if (file.isFile() && String(file.dev) === store.device && String(file.ino) === store.inode) {
          storeObservation = "open_file"; break;
        }
      } catch (cause) { if (!["ENOENT", "ESRCH"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause; }
    }
    const after = parseLinuxProcessStat(input.pid, (await boundedOpenCodeProcessFile(`${proc}/stat`, 4_096)).toString("utf8"));
    if (!after || after.exited || before.startTime !== after.startTime ||
        (await readlink(`${proc}/exe`)) !== executablePath || !sameOpenCodeFileIdentity(executable, await openCodeFileIdentity(`${proc}/exe`))) throw new Error();
    return Object.freeze({ pid: input.pid, startTime: before.startTime, uid, executablePath,
      executable, nativeStorePath, store, storeObservation });
  } catch { throw new OpenCodeRuntimeError("opencode_local_process_identity_unproved"); }
}

export function sameOpenCodeFileIdentity(left: OpenCodeFileIdentity, right: OpenCodeFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode;
}

export function sameOpenCodeNativeIdentity(left: OpenCodeNativeIdentity, right: OpenCodeNativeIdentity): boolean {
  return left.pid === right.pid && left.startTime === right.startTime && left.uid === right.uid &&
    left.executablePath === right.executablePath && sameOpenCodeFileIdentity(left.executable, right.executable) &&
    left.nativeStorePath === right.nativeStorePath && sameOpenCodeFileIdentity(left.store, right.store);
}
