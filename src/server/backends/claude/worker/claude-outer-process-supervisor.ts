import type { ClaudeWorkerSupervisionMessage } from "./claude-worker-supervision-ipc.js";

/** Outer status proving an abnormal worker generation left no Claude groups. */
export const CLAUDE_RUNTIME_WORKER_CLEANUP_PROVEN_FAILURE_EXIT_CODE = 72;

export class ClaudeOuterProcessSupervisor {
  readonly #processGroups = new Set<number>();
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
      this.#processGroups.add(message.processGroupId);
    } else if (message.type === "process_group_unregistered") {
      if (!this.#processGroups.has(message.processGroupId) || groupExists(message.processGroupId)) {
        throw new Error("claude_runtime_worker_process_group_unregistration_invalid");
      }
      this.#processGroups.delete(message.processGroupId);
    }
  }

  close(): Promise<void> {
    return (this.#closePromise ??= this.#closeAll());
  }

  async #closeAll(): Promise<void> {
    const groups = [...this.#processGroups];
    // The inner worker already had a graceful EOF opportunity before the
    // outer close path. Preserve one short observation phase for an in-flight
    // unregister before taking authority away from it.
    await waitForGroups(groups, this.#gracefulMilliseconds);
    const afterGrace = groups.filter(groupExists);
    for (const group of afterGrace) signalGroup(group, "SIGTERM");
    await waitForGroups(afterGrace, this.#terminateMilliseconds);
    const afterTerminate = afterGrace.filter(groupExists);
    for (const group of afterTerminate) signalGroup(group, "SIGKILL");
    await waitForGroups(afterTerminate, this.#killMilliseconds);
    const unproven = afterTerminate.filter(groupExists);
    this.#processGroups.clear();
    if (unproven.length > 0) {
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

function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch (error) {
    if (!isErrno(error, "ESRCH")) throw error;
  }
}

function groupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function waitForGroups(groups: readonly number[], milliseconds: number): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (groups.some(groupExists) && Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
