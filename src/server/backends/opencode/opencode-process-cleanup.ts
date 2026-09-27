import { open, readdir, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { parseLinuxProcessStat } from "../../runtime/process-table.js";
import { OPENCODE_PROCESS_MARKER } from "./opencode-release.js";
const PROCESS_MARKER_NAME = OPENCODE_PROCESS_MARKER;
const MAX_PROCESS_ENTRIES = 16_384;
const MAX_PROCESS_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
interface OpenCodeOwnedProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly startTime: string;
}

function disappeared(error: unknown): boolean {
  return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
}

class OpenCodeCleanupError extends Error {
  constructor(readonly stage: string, readonly pid?: number, readonly code?: string) {
    super(`OpenCode descendant cleanup unproven (${stage}${pid === undefined ? "" : ` pid=${pid}`}${code === undefined ? "" : ` code=${code}`}); retained native ownership lease`);
  }
}

function cleanupUnproven(stage = "verification", pid?: number, code?: string): OpenCodeCleanupError {
  return new OpenCodeCleanupError(stage, pid, code);
}

// /proc files often report size zero. Bound the actual reads, including when a
// process races an exec, and never retain/log another process's environment.
async function boundedProcessFile(file: string, maximumBytes: number): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length <= maximumBytes) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) return bytes.subarray(0, length);
      length += read.bytesRead;
    }
    throw cleanupUnproven();
  } catch (error) {
    if (disappeared(error)) return undefined;
    if (error instanceof OpenCodeCleanupError) throw error;
    const match = /^\/proc\/(\d+)\/(stat|environ)$/u.exec(file);
    const code = (error as NodeJS.ErrnoException).code;
    throw cleanupUnproven(match?.[2] ?? "process_read", match ? Number(match[1]) : undefined,
      code && /^[A-Z0-9_]{1,24}$/u.test(code) ? code : "UNKNOWN");
  } finally {
    await handle?.close();
  }
}

async function ownedProcess(pid: number): Promise<OpenCodeOwnedProcess | undefined> {
  const bytes = await boundedProcessFile(`/proc/${pid}/stat`, 4096);
  if (!bytes) return undefined;
  const observed = parseLinuxProcessStat(pid, bytes.toString("utf8"));
  if (!observed) throw cleanupUnproven("process_identity", pid);
  if (observed.exited) return undefined;
  return { pid, parentPid: observed.parentPid, startTime: observed.startTime };
}

function ownedProcessKey(process: OpenCodeOwnedProcess): string {
  return `${process.pid}:${process.startTime}`;
}

export async function createOpenCodeProcessCleanup(marker: string) {
  const owned = new Map<string, OpenCodeOwnedProcess>();
  const expected = Buffer.from(`${PROCESS_MARKER_NAME}=${marker}\0`);
  // Capture before the first owned runtime process is spawned. Existing processes
  // cannot have inherited this new marker; some same-account services make
  // their environments unreadable. PID + start time keeps reuse distinguishable.
  const preexisting = new Set<string>();
  const initialEntries = (await readdir("/proc")).filter(entry => /^[1-9]\d*$/u.test(entry));
  if (initialEntries.length > MAX_PROCESS_ENTRIES) throw cleanupUnproven();
  const initialDeadline = Date.now() + 5000;
  for (const entry of initialEntries) {
    if (Date.now() >= initialDeadline) throw cleanupUnproven();
    const identity = await ownedProcess(Number(entry));
    if (identity) preexisting.add(ownedProcessKey(identity));
  }
  const launchAncestors = new Set<string>();
  let ancestorPid = process.pid;
  while (ancestorPid !== 0) {
    if (launchAncestors.size >= 128) throw cleanupUnproven("launch_ancestry");
    const ancestor = await ownedProcess(ancestorPid);
    if (!ancestor || launchAncestors.has(ownedProcessKey(ancestor))) throw cleanupUnproven("launch_ancestry");
    launchAncestors.add(ownedProcessKey(ancestor));
    ancestorPid = ancestor.parentPid;
  }
  const unrelatedAncestry = async (candidate: OpenCodeOwnedProcess): Promise<boolean> => {
    const chain: OpenCodeOwnedProcess[] = [];
    let current: OpenCodeOwnedProcess | undefined = candidate;
    while (current && chain.length < 128) {
      const key = ownedProcessKey(current);
      // An owned runtime orphan may be reparented to one of our launch ancestors or
      // its subreapers. Reaching one of those never proves unrelated ownership.
      if (launchAncestors.has(key) || owned.has(key)) return false;
      chain.push(current);
      if (preexisting.has(key)) {
        // A different pre-existing branch cannot have inherited our marker.
        // Recheck every observed parent link so exit/reparent/PID-reuse races
        // cannot turn a speculative process-tree snapshot into that proof.
        for (const observed of chain) {
          const fresh = await ownedProcess(observed.pid);
          if (!fresh || fresh.startTime !== observed.startTime || fresh.parentPid !== observed.parentPid) return false;
        }
        return true;
      }
      const parent: OpenCodeOwnedProcess | undefined = current.parentPid === 0 ? undefined : await ownedProcess(current.parentPid);
      if (parent && BigInt(parent.startTime) > BigInt(current.startTime)) return false;
      current = parent;
    }
    return false;
  };
  const scan = async () => {
    const entries = (await readdir("/proc")).filter(entry => /^[1-9]\d*$/u.test(entry));
    if (entries.length > MAX_PROCESS_ENTRIES) throw cleanupUnproven();
    const deadline = Date.now() + 5000;
    let bytesRead = 0;
    for (const entry of entries) {
      if (Date.now() >= deadline || bytesRead > MAX_SCAN_BYTES) throw cleanupUnproven();
      const pid = Number(entry);
      if (pid === process.pid) continue;
      try {
        // Other accounts cannot be descendants of this unprivileged owned runtime.
        if ((await stat(`/proc/${pid}`)).uid !== process.getuid!()) continue;
        const before = await ownedProcess(pid);
        if (!before || preexisting.has(ownedProcessKey(before))) continue;
        if (owned.has(ownedProcessKey(before))) continue;
        const environment = await boundedProcessFile(`/proc/${pid}/environ`, MAX_PROCESS_ENVIRONMENT_BYTES).catch(async (error: unknown) => {
          // Linux can deny environ reads while a process exits, after the
          // earlier live stat read, or during exec credential transitions.
          // Retry briefly with identity checks; never waive a persistent denial.
          if (error instanceof OpenCodeCleanupError && (error.code === "EACCES" || error.code === "EPERM")) {
            const retryDeadline = Date.now() + 250;
            do {
              const current = await ownedProcess(pid);
              if (!current || current.startTime !== before.startTime) return undefined;
              if (await unrelatedAncestry(current)) return undefined;
              await delay(10);
              try { return await boundedProcessFile(`/proc/${pid}/environ`, MAX_PROCESS_ENVIRONMENT_BYTES); }
              catch (retryError) {
                if (!(retryError instanceof OpenCodeCleanupError) || !["EACCES", "EPERM"].includes(retryError.code ?? "")) throw retryError;
              }
            } while (Date.now() < retryDeadline);
            const current = await ownedProcess(pid);
            if (!current || current.startTime !== before.startTime) return undefined;
            throw cleanupUnproven(`environ parent=${current.parentPid}`, pid, error.code);
          }
          throw error;
        });
        if (!environment) continue;
        bytesRead += environment.length;
        const offset = environment.indexOf(expected);
        if (offset < 0 || (offset > 0 && environment[offset - 1] !== 0)) continue;
        const after = await ownedProcess(pid);
        if (after?.startTime === before.startTime) owned.set(ownedProcessKey(after), after);
      } catch (error) {
        if (!disappeared(error)) throw error instanceof OpenCodeCleanupError ? error : cleanupUnproven("process_scan", pid);
      }
    }
    if (bytesRead > MAX_SCAN_BYTES) throw cleanupUnproven();
    // Remember identified descendants even if they later replace their env.
    for (const [key, previous] of owned) {
      const current = await ownedProcess(previous.pid);
      if (current?.startTime !== previous.startTime) owned.delete(key);
    }
    return [...owned.values()];
  };
  const signal = async (target: OpenCodeOwnedProcess, value: NodeJS.Signals) => {
    // Revalidate start time immediately before signaling, never signal a bare
    // reused PID or group after its original process has exited.
    const current = await ownedProcess(target.pid);
    if (current?.startTime !== target.startTime) return;
    try { process.kill(target.pid, value); }
    catch (error) { if (!disappeared(error)) throw cleanupUnproven(); }
  };
  return async () => {
    const deadline = Date.now() + 15_000;
    const terminatedAt = new Map<string, number>();
    const killed = new Set<string>();
    let emptyScans = 0;
    do {
      const remaining = await scan();
      if (remaining.length === 0) {
        // A second scan covers a child forked while the prior process list
        // was being read, including children reparented when the root exits.
        if (++emptyScans === 2) return;
      } else {
        emptyScans = 0;
        for (const target of remaining) {
          const key = ownedProcessKey(target);
          const terminated = terminatedAt.get(key);
          if (terminated === undefined) {
            await signal(target, "SIGTERM");
            terminatedAt.set(key, Date.now());
          } else if (Date.now() - terminated >= 5000 && !killed.has(key)) {
            await signal(target, "SIGKILL");
            killed.add(key);
          }
        }
      }
      await delay(25);
    } while (Date.now() < deadline);
    // Keep the directory if repeated late forks prevent bounded extinction.
    // Each discovered process gets a full five seconds after its own SIGTERM.
    if ((await scan()).length !== 0) throw cleanupUnproven();
  };
}

