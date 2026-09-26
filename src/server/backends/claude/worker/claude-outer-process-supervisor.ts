import { cleanUpOwnedProcessTrees, OwnedProcessTree } from "../../../runtime/owned-process-tree.js";
import { readProcessEntrySync, readProcessTable } from "../../../runtime/process-table.js";
import type { ClaudeWorkerSupervisionMessage } from "./claude-worker-supervision-ipc.js";

/** Outer status proving an abnormal worker generation left no Claude groups. */
export const CLAUDE_RUNTIME_WORKER_CLEANUP_PROVEN_FAILURE_EXIT_CODE = 72;

/**
 * Fallback owner of every registered Claude process tree when the inner worker
 * cannot prove cleanup itself. Descendants in other sessions are attributed
 * through ancestry while their leader or a recorded descendant is still alive.
 */
export class ClaudeOuterProcessSupervisor {
  /** Registered group -> its tree, or undefined when the gate exited before registration. */
  readonly #processGroups = new Map<number, OwnedProcessTree | undefined>();
  readonly #gracefulMilliseconds: number;
  readonly #terminateMilliseconds: number;
  readonly #killMilliseconds: number;
  #closePromise: Promise<void> | undefined;

  constructor(options: {
    readonly gracefulMilliseconds?: number;
    readonly terminateMilliseconds?: number;
    readonly killMilliseconds?: number;
  } = {}) {
    this.#gracefulMilliseconds = duration(options.gracefulMilliseconds, 2_500);
    this.#terminateMilliseconds = duration(options.terminateMilliseconds, 1_000);
    this.#killMilliseconds = duration(options.killMilliseconds, 1_000);
  }

  get registeredProcessGroupCount(): number {
    return this.#processGroups.size;
  }

  accept(message: ClaudeWorkerSupervisionMessage): void {
    if (message.type === "process_group_registered") {
      if (this.#closePromise || this.#processGroups.has(message.processGroupId)) {
        throw new Error("claude_runtime_worker_process_group_registration_invalid");
      }
      // The inner worker registers a stopped, detached gate before it may exec.
      // A gate killed before this message arrived never ran Claude and left no
      // group; a live process that does not lead its own group is not a gate.
      const leader = readProcessEntrySync(message.processGroupId);
      const live = leader !== undefined && !leader.exited;
      if (live && leader.processGroupId !== leader.pid) {
        throw new Error("claude_runtime_worker_process_group_registration_invalid");
      }
      this.#processGroups.set(message.processGroupId, live ? new OwnedProcessTree(leader) : undefined);
    } else if (message.type === "process_group_unregistered") {
      if (!this.#processGroups.has(message.processGroupId) || groupExists(message.processGroupId)) {
        throw new Error("claude_runtime_worker_process_group_unregistration_invalid");
      }
      this.#processGroups.delete(message.processGroupId);
    }
  }

  /** Records descendants of every registered tree while ancestry is visible. */
  async observe(): Promise<void> {
    if (this.#processGroups.size === 0) return;
    const table = await readProcessTable();
    for (const tree of this.#processGroups.values()) tree?.observe(table);
  }

  close(): Promise<void> {
    return (this.#closePromise ??= this.#closeAll());
  }

  async #closeAll(): Promise<void> {
    const trees = [...this.#processGroups.values()].filter((tree) => tree !== undefined);
    // The inner worker already had a graceful EOF opportunity before the
    // outer close path. Preserve one short observation phase for an in-flight
    // unregister before taking authority away from it.
    let proven: boolean;
    try {
      proven = await cleanUpOwnedProcessTrees(trees, {
        gracefulMilliseconds: this.#gracefulMilliseconds,
        terminateMilliseconds: this.#terminateMilliseconds,
        killMilliseconds: this.#killMilliseconds,
      });
    } catch (error) {
      throw new Error("claude_runtime_outer_child_cleanup_unproven", { cause: error });
    } finally {
      this.#processGroups.clear();
    }
    if (!proven) {
      throw new Error("claude_runtime_outer_child_cleanup_unproven");
    }
  }
}

function duration(value: number | undefined, fallback: number): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > 60_000) {
    throw new Error("claude_runtime_outer_cleanup_duration_invalid");
  }
  return result;
}

function groupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
