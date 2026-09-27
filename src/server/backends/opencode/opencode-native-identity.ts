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
    // OPENCODE_DB is concrete native configuration evidence, not an operator
    // declaration. Its relative-path rule is pinned in CLI database-path.ts
    // and util/global-roots.ts. Never admit a known different store namespace.
    const environment = new Map((await boundedOpenCodeProcessFile(`${proc}/environ`, 1_048_576))
      .toString("utf8").split("\0").map(entry => {
        const equals = entry.indexOf("=");
        return [entry.slice(0, equals), entry.slice(equals + 1)] as const;
      }));
    const database = environment.get("OPENCODE_DB");
    const home = environment.get("HOME");
    const data = environment.get("XDG_DATA_HOME") || (home && path.join(home, ".local", "share"));
    if (database !== undefined) {
      if (database === ":memory:") throw new Error();
      let selected = database;
      if (!path.isAbsolute(selected)) {
        if (!data || !path.isAbsolute(data)) throw new Error();
        selected = path.resolve(data, "opencode", selected);
      }
      if (await realpath(selected) !== nativeStorePath) throw new Error();
    }
    let nativeDefaultDirectory: string | undefined;
    if (database === undefined && data && path.isAbsolute(data)) {
      try { nativeDefaultDirectory = await realpath(path.join(data, "opencode")); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    }
    let storeObservation: OpenCodeNativeIdentity["storeObservation"] = "operator_declared";
    const descriptors = await readdir(`${proc}/fd`);
    if (descriptors.length > 16_384) throw new Error();
    for (const descriptor of descriptors) {
      try {
        const file = await stat(`${proc}/fd/${descriptor}`, { bigint: true });
        if (!file.isFile()) continue;
        const matches = String(file.dev) === store.device && String(file.ino) === store.inode;
        if (database !== undefined || nativeDefaultDirectory) {
          let opened = await readlink(`${proc}/fd/${descriptor}`);
          if (opened.endsWith(" (deleted)")) {
            // Linux appends this suffix to unlinked descriptors, but it can
            // also be a literal filename. An exact current inode match proves
            // the literal case; never discard that concrete file identity.
            let literal: Awaited<ReturnType<typeof openCodeFileIdentity>> | undefined;
            try {
              const candidate = await stat(opened, { bigint: true });
              literal = { device: String(candidate.dev), inode: String(candidate.ino) };
            } catch (cause) { if (!["ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause; }
            if (!literal || literal.device !== String(file.dev) || literal.inode !== String(file.ino)) {
              opened = opened.slice(0, -" (deleted)".length);
            }
          }
          if (database !== undefined && opened === nativeStorePath && !matches) throw new Error();
          // The server API omits the compile-time channel. Observe the actual
          // default filename instead of guessing one from the release number.
          if (nativeDefaultDirectory && path.dirname(opened) === nativeDefaultDirectory && /^opencode(?:-[a-zA-Z0-9._-]+)?\.db$/u.test(path.basename(opened)) && !matches) {
            throw new Error();
          }
        }
        if (matches) storeObservation = "open_file";
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
