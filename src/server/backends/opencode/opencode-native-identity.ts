import { open, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { userInfo } from "node:os";
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
  readonly nativeStorePath?: string;
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
    // Read the process's own launch environment, not the Sedes account's
    // selected defaults. OPENCODE_DB's relative-path rule is pinned in CLI
    // database-path.ts and util/global-roots.ts.
    const environment = new Map((await boundedOpenCodeProcessFile(`${proc}/environ`, 1_048_576))
      .toString("utf8").split("\0").filter(entry => entry.includes("=")).map(entry => {
        const equals = entry.indexOf("=");
        return [entry.slice(0, equals), entry.slice(equals + 1)] as const;
      }));
    const database = environment.get("OPENCODE_DB");
    if (database === ":memory:") throw new Error();
    const home = environment.get("HOME") || userInfo().homedir;
    const data = environment.get("XDG_DATA_HOME") || path.join(home, ".local", "share");
    const nativeDataDirectory = path.resolve(await readlink(`${proc}/cwd`), data, "opencode");
    const configuredStore = database === undefined ? undefined
      : await realpath(path.resolve(nativeDataDirectory, database));
    let nativeDefaultDirectory: string | undefined;
    if (database === undefined) {
      try { nativeDefaultDirectory = await realpath(nativeDataDirectory); }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
    }
    const descriptors = await readdir(`${proc}/fd`);
    if (descriptors.length > 16_384) throw new Error();
    const openFiles: { readonly path: string; readonly identity: OpenCodeFileIdentity }[] = [];
    for (const descriptor of descriptors) {
      try {
        const file = await stat(`${proc}/fd/${descriptor}`, { bigint: true });
        if (!file.isFile()) continue;
        let opened = await readlink(`${proc}/fd/${descriptor}`);
        if (opened.endsWith(" (deleted)")) {
          // The suffix can also be a literal filename. Only a matching inode
          // proves that case; otherwise retain the pre-unlink path as evidence
          // so a replaced database cannot be admitted as the still-open file.
          let literal: OpenCodeFileIdentity | undefined;
          try {
            const candidate = await stat(opened, { bigint: true });
            literal = { device: String(candidate.dev), inode: String(candidate.ino) };
          } catch (cause) { if (!["ENOENT", "ENOTDIR"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause; }
          if (!literal || literal.device !== String(file.dev) || literal.inode !== String(file.ino)) {
            opened = opened.slice(0, -" (deleted)".length);
          }
        }
        openFiles.push({ path: opened, identity: { device: String(file.dev), inode: String(file.ino) } });
      } catch (cause) { if (!["ENOENT", "ESRCH"].includes((cause as NodeJS.ErrnoException).code ?? "")) throw cause; }
    }
    const defaults = openFiles.filter(file => nativeDefaultDirectory && path.dirname(file.path) === nativeDefaultDirectory &&
      /^opencode(?:-[a-zA-Z0-9._-]+)?\.db$/u.test(path.basename(file.path)));
    // A selected path is an assertion, never a substitute for contradictory
    // native evidence. Without it, discover the native process's configured
    // store or its one open default database (including compile-time channels).
    const discovered = configuredStore ?? (new Set(defaults.map(file => file.path)).size === 1 ? defaults[0]?.path : undefined);
    if (input.nativeStorePath === undefined && !discovered) throw new Error();
    const nativeStorePath = await canonicalOpenCodeStore(input.nativeStorePath ?? discovered!, false);
    if (configuredStore && configuredStore !== nativeStorePath) throw new Error();
    const store = await openCodeFileIdentity(nativeStorePath);
    let storeObservation: OpenCodeNativeIdentity["storeObservation"] = "operator_declared";
    for (const file of openFiles) {
      const matches = sameOpenCodeFileIdentity(file.identity, store);
      if ((file.path === nativeStorePath || defaults.includes(file)) && !matches) throw new Error();
      if (matches) storeObservation = "open_file";
    }
    if (input.nativeStorePath === undefined && storeObservation !== "open_file") throw new Error();
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
