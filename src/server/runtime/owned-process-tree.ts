import { readProcessTable, collectDescendants, type ProcessTable, type ProcessTableEntry } from "./process-table.js";

/** `process.kill` semantics; negative targets address process groups. */
export interface ProcessSignals {
  /** True unless the target is proven absent (ESRCH). */
  exists(target: number): boolean;
  /** False when the target is absent or refuses the signal. */
  send(target: number, signal: NodeJS.Signals): boolean;
}

export const processSignals: ProcessSignals = Object.freeze({
  exists(target: number): boolean {
    try {
      process.kill(target, 0);
      return true;
    } catch (error) {
      return !isErrno(error, "ESRCH");
    }
  },
  send(target: number, signal: NodeJS.Signals): boolean {
    try {
      process.kill(target, signal);
      return true;
    } catch {
      return false;
    }
  },
});

/**
 * One detached leader and every descendant observed through process ancestry.
 *
 * Descendants may start their own session or process group (Claude Code runs
 * each Bash tool shell with pgid = sid = pid), so the leader-group signal does
 * not reach them. When a parent exits, its children are reparented and the
 * ancestry is lost, so callers observe periodically and before every signal.
 * A descendant that is started and orphaned between two observations cannot
 * be attributed. Group IDs stay owned while the group exists: the kernel does
 * not reuse a PID that still names a process group or session.
 */
export class OwnedProcessTree {
  readonly leaderPid: number;
  readonly #signals: ProcessSignals;
  /** Tracked descendant PID -> start token. */
  readonly #processes = new Map<number, string>();
  /** Owned process group ID -> start token of the process that created it. */
  readonly #groups = new Map<number, string>();
  readonly #leaderStartTime: string;

  constructor(leader: ProcessTableEntry, signals: ProcessSignals = processSignals) {
    if (leader.exited || leader.processGroupId !== leader.pid || leader.pid <= 1) {
      throw new Error("owned_process_tree_leader_invalid");
    }
    this.leaderPid = leader.pid;
    this.#leaderStartTime = leader.startTime;
    this.#signals = signals;
    this.#groups.set(leader.pid, leader.startTime);
  }

  get observedDescendantCount(): number {
    return this.#processes.size;
  }

  /** Adds every live descendant of the live leader and of live tracked processes. */
  observe(table: ProcessTable): void {
    const roots: number[] = [];
    if (isSameLive(table.get(this.leaderPid), this.#leaderStartTime)) roots.push(this.leaderPid);
    for (const [pid, startTime] of this.#processes) {
      const entry = table.get(pid);
      if (!entry || entry.startTime !== startTime) this.#processes.delete(pid);
      else if (!entry.exited) roots.push(pid);
    }
    for (const descendant of collectDescendants(table, roots)) {
      if (descendant.exited || descendant.pid <= 1) continue;
      this.#processes.set(descendant.pid, descendant.startTime);
      if (descendant.processGroupId === descendant.pid) {
        this.#groups.set(descendant.pid, descendant.startTime);
      }
    }
    // Each Bash tool call adds a group; forget ended ones during long sessions.
    const members = groupMembership(table);
    for (const group of this.#groups.keys()) {
      if (group !== this.leaderPid && !members.has(group) && !this.#signals.exists(-group)) {
        this.#groups.delete(group);
      }
    }
  }

  /** Live tracked descendants and still-owned groups with a live member. */
  remaining(table: ProcessTable): { readonly processes: readonly number[]; readonly groups: readonly number[] } {
    const processes = [...this.#processes].filter(([pid, startTime]) => isSameLive(table.get(pid), startTime)).map(([pid]) => pid);
    const groups: number[] = [];
    const members = groupMembership(table);
    for (const [group, startTime] of this.#groups) {
      const creator = table.get(group);
      // A different process with this PID proves the owned group ended first.
      if ((creator && creator.startTime !== startTime) || !this.#signals.exists(-group)) {
        this.#groups.delete(group);
        continue;
      }
      // Unreaped zombies keep a group addressable but execute nothing. A group
      // with no visible member stays owned: absence from a snapshot is not proof.
      const membership = members.get(group);
      if (membership && membership.live === 0) continue;
      groups.push(group);
    }
    return { processes, groups };
  }

  remains(table: ProcessTable): boolean {
    const remaining = this.remaining(table);
    return remaining.processes.length > 0 || remaining.groups.length > 0;
  }

  /** Signals every owned group and every live tracked descendant. */
  signal(table: ProcessTable, signal: NodeJS.Signals): boolean {
    const remaining = this.remaining(table);
    let delivered = false;
    for (const group of remaining.groups) delivered = this.#signals.send(-group, signal) || delivered;
    for (const pid of remaining.processes) delivered = this.#signals.send(pid, signal) || delivered;
    return delivered;
  }
}

export interface OwnedProcessTreeCleanupOptions {
  readonly gracefulMilliseconds: number;
  readonly terminateMilliseconds: number;
  readonly killMilliseconds: number;
  readonly pollMilliseconds?: number;
  readonly readTable?: () => Promise<ProcessTable>;
}

/**
 * Waits for voluntary exit, then SIGTERM, then SIGKILL. Resolves true only
 * when no tracked descendant or owned group remains.
 */
export async function cleanUpOwnedProcessTrees(
  trees: readonly OwnedProcessTree[],
  options: OwnedProcessTreeCleanupOptions,
): Promise<boolean> {
  const readTable = options.readTable ?? readProcessTable;
  const poll = options.pollMilliseconds ?? 50;
  const observe = async () => {
    const table = await readTable();
    for (const tree of trees) tree.observe(table);
    return table;
  };
  const remains = (table: ProcessTable) => trees.some((tree) => tree.remains(table));
  const phase = async (milliseconds: number, signal?: NodeJS.Signals): Promise<boolean> => {
    const deadline = Date.now() + milliseconds;
    const table = await observe();
    if (signal) for (const tree of trees) tree.signal(table, signal);
    else if (!remains(table)) return true;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await delay(Math.min(poll, remaining));
      if (!remains(await observe())) return true;
    }
  };
  if (trees.length === 0) return true;
  return await phase(options.gracefulMilliseconds) ||
    await phase(options.terminateMilliseconds, "SIGTERM") ||
    await phase(options.killMilliseconds, "SIGKILL");
}

const membershipCache = new WeakMap<ProcessTable, Map<number, { live: number }>>();

function groupMembership(table: ProcessTable): Map<number, { live: number }> {
  let members = membershipCache.get(table);
  if (members) return members;
  members = new Map();
  for (const entry of table.values()) {
    const group = members.get(entry.processGroupId) ?? { live: 0 };
    if (!entry.exited) group.live++;
    members.set(entry.processGroupId, group);
  }
  membershipCache.set(table, members);
  return members;
}

function isSameLive(entry: ProcessTableEntry | undefined, startTime: string): boolean {
  return !!entry && !entry.exited && entry.startTime === startTime;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
