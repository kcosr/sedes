import { execFile, execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";

/**
 * One observed process. `startTime` is an opaque platform token that differs
 * between two processes that held the same PID: Linux clock ticks since boot,
 * or the macOS `ps` start timestamp (second resolution; PIDs are allocated
 * sequentially there, so reuse within one second is not a practical case).
 */
export interface ProcessTableEntry {
  readonly pid: number;
  readonly parentPid: number;
  readonly processGroupId: number;
  readonly startTime: string;
  /** Zombie or dead: the process cannot execute further work. */
  readonly exited: boolean;
}

export type ProcessTable = ReadonlyMap<number, ProcessTableEntry>;

const DARWIN_PS = "/bin/ps";
const DARWIN_SYSCTL = "/usr/sbin/sysctl";
const DARWIN_PS_FIELDS = "pid=,ppid=,pgid=,stat=,lstart=";
const MAXIMUM_PS_OUTPUT_BYTES = 32 * 1_024 * 1_024;
// Fixed locale and zone keep the opaque start token stable between reads.
const DARWIN_PS_ENVIRONMENT = Object.freeze({ LC_ALL: "C", TZ: "UTC" });

export function processTableSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux" || platform === "darwin";
}

/** Parses one Linux `/proc/<pid>/stat` record; the command name may contain spaces or parentheses. */
export function parseLinuxProcessStat(pid: number, text: string): ProcessTableEntry | undefined {
  const close = text.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = text.slice(close + 2).split(" ");
  const state = fields[0];
  const [parentPid, processGroupId] = [fields[1], fields[2]].map((value) =>
    /^[0-9]+$/u.test(value ?? "") ? Number(value) : Number.NaN,
  );
  const startTime = fields[19];
  if (!state || !Number.isSafeInteger(parentPid) || !Number.isSafeInteger(processGroupId) ||
      !startTime || !/^[0-9]+$/u.test(startTime)) {
    return undefined;
  }
  return Object.freeze({
    pid,
    parentPid: parentPid!,
    processGroupId: processGroupId!,
    startTime,
    exited: state === "Z" || state === "X",
  });
}

/** Parses `ps -o pid=,ppid=,pgid=,stat=,lstart=` output from macOS. */
export function parseDarwinProcessTable(text: string): Map<number, ProcessTableEntry> {
  const table = new Map<number, ProcessTableEntry>();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(\S+)\s+(\S.*?)\s*$/u.exec(line);
    if (!match) throw new Error("process_table_output_invalid");
    const pid = Number(match[1]);
    table.set(pid, Object.freeze({
      pid,
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      startTime: match[5]!.replace(/\s+/gu, " "),
      exited: match[4]!.startsWith("Z"),
    }));
  }
  return table;
}

/** Reads every visible process. Throws when the platform facility is unavailable. */
export async function readProcessTable(): Promise<Map<number, ProcessTableEntry>> {
  if (process.platform === "linux") {
    const pids = (await readdir("/proc")).filter((name) => /^[0-9]+$/u.test(name)).map(Number);
    return await readLinuxEntries(pids);
  }
  if (process.platform === "darwin") {
    return parseDarwinProcessTable(await runDarwinPs(["-A", "-o", DARWIN_PS_FIELDS]));
  }
  throw new Error("process_table_unsupported");
}

export function readProcessTableSync(): Map<number, ProcessTableEntry> {
  if (process.platform === "linux") {
    const table = new Map<number, ProcessTableEntry>();
    for (const name of readdirSync("/proc")) {
      if (!/^[0-9]+$/u.test(name)) continue;
      const entry = readLinuxEntrySync(Number(name));
      if (entry) table.set(entry.pid, entry);
    }
    return table;
  }
  if (process.platform === "darwin") {
    return parseDarwinProcessTable(execFileSync(DARWIN_PS, ["-A", "-o", DARWIN_PS_FIELDS], {
      encoding: "utf8", env: DARWIN_PS_ENVIRONMENT, maxBuffer: MAXIMUM_PS_OUTPUT_BYTES,
      timeout: 5_000, windowsHide: true,
    }));
  }
  throw new Error("process_table_unsupported");
}

/** Reads only the requested PIDs; absent PIDs are omitted from the result. */
export async function readProcessEntries(pids: Iterable<number>): Promise<Map<number, ProcessTableEntry>> {
  const unique = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  if (unique.length === 0) return new Map();
  if (process.platform === "linux") return await readLinuxEntries(unique);
  if (process.platform === "darwin") {
    return parseDarwinProcessTable(await runDarwinPs(["-o", DARWIN_PS_FIELDS, "-p", unique.join(",")]));
  }
  throw new Error("process_table_unsupported");
}

export function readProcessEntrySync(pid: number): ProcessTableEntry | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") return readLinuxEntrySync(pid);
  if (process.platform === "darwin") {
    try {
      return parseDarwinProcessTable(execFileSync(DARWIN_PS, ["-o", DARWIN_PS_FIELDS, "-p", String(pid)], {
        encoding: "utf8", env: DARWIN_PS_ENVIRONMENT, maxBuffer: 4_096, timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"], windowsHide: true,
      })).get(pid);
    } catch (error) {
      // ps exits 1 with empty output when the PID does not exist.
      if (isRecord(error) && error.status === 1 && String(error.stdout ?? "").trim() === "") return undefined;
      throw error;
    }
  }
  throw new Error("process_table_unsupported");
}

/** Every process whose ancestry reaches one of the roots, excluding the roots. */
export function collectDescendants(table: ProcessTable, roots: Iterable<number>): ProcessTableEntry[] {
  const children = new Map<number, ProcessTableEntry[]>();
  for (const entry of table.values()) {
    if (entry.pid === entry.parentPid) continue;
    const siblings = children.get(entry.parentPid);
    if (siblings) siblings.push(entry);
    else children.set(entry.parentPid, [entry]);
  }
  const seen = new Set<number>(roots);
  const pending = [...seen];
  const descendants: ProcessTableEntry[] = [];
  for (let parent = pending.pop(); parent !== undefined; parent = pending.pop()) {
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      descendants.push(child);
      pending.push(child.pid);
    }
  }
  return descendants;
}

/**
 * Command lines of visible processes, for ownership checks by path. Linux joins
 * argv with spaces; macOS reports the kernel's space-joined argument string.
 */
export async function readProcessCommandLines(): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  if (process.platform === "linux") {
    for (const name of await readdir("/proc")) {
      if (!/^[0-9]+$/u.test(name)) continue;
      try {
        const bytes = await readFile(`/proc/${name}/cmdline`);
        if (bytes.length > 0) result.set(Number(name), bytes.toString("utf8").replace(/\0+$/u, "").replaceAll("\0", " "));
      } catch (error) {
        if (!isErrno(error, "ENOENT") && !isErrno(error, "ESRCH") && !isErrno(error, "EACCES")) throw error;
      }
    }
    return result;
  }
  if (process.platform === "darwin") {
    for (const line of (await runDarwinPs(["-A", "-ww", "-o", "pid=,args="])).split("\n")) {
      const match = /^\s*([0-9]+)\s+(.*)$/u.exec(line);
      if (match) result.set(Number(match[1]), match[2]!);
    }
    return result;
  }
  throw new Error("process_table_unsupported");
}

/** Boot session identity where the platform exposes one cheaply. */
export async function readBootIdentity(): Promise<string | undefined> {
  try {
    const value = process.platform === "linux"
      ? (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim()
      : process.platform === "darwin"
        ? (await execFileText(DARWIN_SYSCTL, ["-n", "kern.bootsessionuuid"], 4_096)).trim()
        : undefined;
    return value && /^[A-Za-z0-9-]{1,80}$/u.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function readLinuxEntries(pids: readonly number[]): Promise<Map<number, ProcessTableEntry>> {
  const table = new Map<number, ProcessTableEntry>();
  // Bounded fan-out keeps a large process table from exhausting descriptors.
  for (let index = 0; index < pids.length; index += 64) {
    const entries = await Promise.all(pids.slice(index, index + 64).map(async (pid) => {
      try {
        return parseLinuxProcessStat(pid, await readFile(`/proc/${pid}/stat`, "utf8"));
      } catch (error) {
        if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) return undefined;
        throw error;
      }
    }));
    for (const entry of entries) if (entry) table.set(entry.pid, entry);
  }
  return table;
}

function readLinuxEntrySync(pid: number): ProcessTableEntry | undefined {
  try {
    return parseLinuxProcessStat(pid, readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch (error) {
    if (isErrno(error, "ENOENT") || isErrno(error, "ESRCH")) return undefined;
    throw error;
  }
}

async function runDarwinPs(args: readonly string[]): Promise<string> {
  try {
    return await execFileText(DARWIN_PS, args, MAXIMUM_PS_OUTPUT_BYTES, DARWIN_PS_ENVIRONMENT);
  } catch (error) {
    // ps exits 1 with empty output when a -p selection matches nothing.
    if (args.includes("-p") && isRecord(error) && error.code === 1 && String(error.stdout ?? "").trim() === "") return "";
    throw error;
  }
}

function execFileText(
  file: string,
  args: readonly string[],
  maxBuffer: number,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: "utf8", maxBuffer, timeout: 5_000, windowsHide: true, ...(env ? { env } : {}) },
      (error, stdout) => {
        if (error) reject(Object.assign(error, { stdout }));
        else resolve(stdout);
      });
  });
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
