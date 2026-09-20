import type {
  SpawnedProcess,
  SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ClaudeProcessGroupRegistrar } from "./claude-worker-supervision-ipc.js";

const DEFAULT_GRACEFUL_CLOSE_MILLISECONDS = 2_250;
const DEFAULT_TERMINATE_MILLISECONDS = 1_000;
const DEFAULT_KILL_MILLISECONDS = 1_000;
const MAXIMUM_PROBE_OUTPUT_BYTES = 4_096;
const CLAUDE_GATE_STOP_TIMEOUT_MILLISECONDS = 2_000;
const CLAUDE_GATE_SOURCE = 'kill -STOP $$; exec "$@"';

interface TrackedClaudeProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly processGroupId: number;
  readonly exited: Promise<void>;
  readonly removeAbortListener: () => void;
  killRequested: boolean;
  registeredWithParent: boolean;
  registrationSettled: Promise<void>;
  cleanupPromise?: Promise<void>;
}

export interface ClaudeChildProcessSupervisorOptions {
  readonly gracefulCloseMilliseconds?: number;
  readonly terminateMilliseconds?: number;
  readonly killMilliseconds?: number;
  readonly processGroupRegistrar: ClaudeProcessGroupRegistrar;
  /** Automatic record cleanup uncertainty is fatal to the worker generation. */
  readonly onCleanupFailure?: (error: unknown) => void;
}

/**
 * Owns every Claude CLI process group in one runtime worker generation.
 *
 * The SDK gets ordinary Node streams and events, while signals always target
 * the detached process group so tool and subagent descendants cannot survive
 * query or worker teardown.
 */
export class ClaudeChildProcessSupervisor {
  readonly #gracefulCloseMilliseconds: number;
  readonly #terminateMilliseconds: number;
  readonly #killMilliseconds: number;
  readonly #tracked = new Set<TrackedClaudeProcess>();
  readonly #processGroupRegistrar: ClaudeProcessGroupRegistrar;
  readonly #onCleanupFailure: (error: unknown) => void;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: ClaudeChildProcessSupervisorOptions) {
    this.#gracefulCloseMilliseconds = boundedDuration(
      options.gracefulCloseMilliseconds,
      DEFAULT_GRACEFUL_CLOSE_MILLISECONDS,
    );
    this.#terminateMilliseconds = boundedDuration(
      options.terminateMilliseconds,
      DEFAULT_TERMINATE_MILLISECONDS,
    );
    this.#killMilliseconds = boundedDuration(
      options.killMilliseconds,
      DEFAULT_KILL_MILLISECONDS,
    );
    this.#processGroupRegistrar = options.processGroupRegistrar;
    this.#onCleanupFailure = options.onCleanupFailure ?? (() => undefined);
    if (process.platform === "win32") {
      throw new Error("claude_worker_process_groups_unsupported");
    }
  }

  get trackedProcessCount(): number {
    return this.#tracked.size;
  }

  spawnClaudeCodeProcess = (options: SpawnOptions): SpawnedProcess => {
    return this.spawn(options);
  };

  spawn(options: SpawnOptions): SpawnedProcess {
    if (this.#closed) throw new Error("claude_worker_supervisor_closed");
    validateSpawnOptions(options);
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        CLAUDE_GATE_SOURCE,
        "sedes-claude-process-gate",
        options.command,
        ...options.args,
      ],
      {
        cwd: options.cwd,
        env: { ...options.env },
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    if (!child.pid) {
      child.kill("SIGKILL");
      throw new Error("claude_worker_child_pid_unavailable");
    }
    // The SDK custom-spawn contract has no stderr stream. Always drain it so
    // a verbose provider cannot deadlock; never retain its secret-bearing text.
    child.stderr.resume();
    const events = new EventEmitter();
    let abort = () => undefined;
    const record: TrackedClaudeProcess = {
      child,
      processGroupId: child.pid,
      exited: new Promise<void>((resolve) =>
        child.once("close", () => resolve()),
      ),
      removeAbortListener: () =>
        options.signal.removeEventListener("abort", abort),
      killRequested: false,
      registeredWithParent: false,
      registrationSettled: Promise.resolve(),
    };
    abort = () => {
      record.killRequested = true;
      signalProcessGroup(record, "SIGTERM");
    };
    try {
      waitForStoppedGate(record.processGroupId);
    } catch (error) {
      child.once("error", () => undefined);
      signalProcessGroup(record, "SIGKILL");
      throw new Error("claude_worker_process_gate_stop_unproven", {
        cause: error,
      });
    }
    child.on("error", (error) => events.emit("error", error));
    child.on("exit", (code, signal) => events.emit("exit", code, signal));
    child.once("close", () => {
      record.removeAbortListener();
      void this.#cleanupRecord(record).catch((error) => {
        const failure = new Error(
          "claude_worker_closed_leader_cleanup_failed",
          { cause: error },
        );
        try {
          this.#onCleanupFailure(failure);
        } catch {
          // A fatal observer cannot restore cleanup proof.
        }
        events.emit("error", failure);
      });
    });
    options.signal.addEventListener("abort", abort, { once: true });
    this.#tracked.add(record);
    if (options.signal.aborted) abort();
    const registration = this.#processGroupRegistrar
      .register(record.processGroupId)
      .then(() => {
        record.registeredWithParent = true;
        if (this.#closed || record.killRequested) {
          signalProcessGroup(record, "SIGKILL");
          return;
        }
        if (!signalProcessGroup(record, "SIGCONT")) {
          throw new Error("claude_worker_process_gate_disappeared");
        }
      })
      .catch((error) => {
        record.killRequested = true;
        signalProcessGroup(record, "SIGKILL");
        queueMicrotask(() =>
          events.emit(
            "error",
            new Error("claude_worker_process_group_registration_failed", {
              cause: error,
            }),
          ),
        );
      });
    record.registrationSettled = registration.then(
      () => undefined,
      () => undefined,
    );

    return {
      stdin: child.stdin,
      stdout: child.stdout,
      get killed() {
        return record.killRequested || child.killed;
      },
      get exitCode() {
        return child.exitCode;
      },
      get signalCode() {
        return child.signalCode;
      },
      kill: (signal) => {
        record.killRequested = true;
        return signalProcessGroup(record, signal);
      },
      on: (event, listener) => {
        events.on(event, listener);
      },
      once: (event, listener) => {
        events.once(event, listener);
      },
      off: (event, listener) => {
        events.off(event, listener);
      },
    };
  }

  async executeProbe(input: {
    readonly executablePath: string;
    readonly arguments: readonly string[];
    readonly cwd?: string;
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMilliseconds: number;
    readonly signal?: AbortSignal;
  }): Promise<string> {
    if (
      !path.isAbsolute(input.executablePath) ||
      input.arguments.length > 16 ||
      input.arguments.some(
        (value) =>
          value.length === 0 ||
          value.length > 512 ||
          /[\u0000-\u001f\u007f]/u.test(value),
      )
    ) {
      throw new Error("claude_worker_probe_invalid");
    }
    input.signal?.throwIfAborted();
    const abortController = new AbortController();
    const abortFromCaller = () => abortController.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (input.signal?.aborted) abortFromCaller();
    let process: SpawnedProcess;
    try {
      process = this.spawn({
        command: input.executablePath,
        args: [...input.arguments],
        ...(input.cwd ? { cwd: input.cwd } : {}),
        env: { ...(input.environment ?? {}) },
        signal: abortController.signal,
      });
    } catch (error) {
      input.signal?.removeEventListener("abort", abortFromCaller);
      throw error;
    }
    let output = Buffer.alloc(0);
    let outputTooLarge = false;
    process.stdout.on("data", (chunk: Buffer) => {
      if (outputTooLarge) return;
      if (output.byteLength + chunk.byteLength > MAXIMUM_PROBE_OUTPUT_BYTES) {
        outputTooLarge = true;
        abortController.abort(
          new Error("claude_worker_probe_output_too_large"),
        );
        return;
      }
      output = Buffer.concat([output, chunk]);
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const escalateAbort = () => {
      if (killTimer) return;
      killTimer = setTimeout(
        () => process.kill("SIGKILL"),
        this.#terminateMilliseconds,
      );
      killTimer.unref?.();
    };
    abortController.signal.addEventListener("abort", escalateAbort, {
      once: true,
    });
    if (abortController.signal.aborted) escalateAbort();
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(
        () => {
          abortController.abort(new Error("claude_worker_probe_timeout"));
        },
        boundedDuration(input.timeoutMilliseconds, input.timeoutMilliseconds),
      );
      timer.unref?.();
      process.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        abortController.abort(error);
        reject(new Error("claude_worker_probe_failed", { cause: error }));
      });
      process.once("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (outputTooLarge) {
          reject(new Error("claude_worker_probe_output_too_large"));
        } else if (abortController.signal.aborted) {
          reject(abortController.signal.reason);
        } else if (code !== 0 || signal !== null) {
          reject(new Error("claude_worker_probe_failed"));
        } else {
          resolve(output.toString("utf8"));
        }
      });
    }).finally(() => {
      input.signal?.removeEventListener("abort", abortFromCaller);
      abortController.signal.removeEventListener("abort", escalateAbort);
      if (killTimer) clearTimeout(killTimer);
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return (this.#closePromise ??= this.#closeAll());
  }

  async #closeAll(): Promise<void> {
    const records = [...this.#tracked];
    for (const record of records) record.child.stdin.end();
    const results = await Promise.allSettled(
      records.map(async (record) => await this.#cleanupRecord(record)),
    );
    this.#processGroupRegistrar.close();
    this.#tracked.clear();
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed) {
      throw new Error("claude_worker_child_cleanup_unproven", {
        cause: failed.reason,
      });
    }
  }

  #cleanupRecord(record: TrackedClaudeProcess): Promise<void> {
    return (record.cleanupPromise ??= this.#performRecordCleanup(record));
  }

  async #performRecordCleanup(record: TrackedClaudeProcess): Promise<void> {
    record.removeAbortListener();
    await waitForGroupsToExit([record], this.#gracefulCloseMilliseconds);
    if (processGroupExists(record.processGroupId)) {
      signalProcessGroup(record, "SIGTERM");
      await waitForGroupsToExit([record], this.#terminateMilliseconds);
    }
    if (processGroupExists(record.processGroupId)) {
      signalProcessGroup(record, "SIGKILL");
      await waitForGroupsToExit([record], this.#killMilliseconds);
    }
    if (processGroupExists(record.processGroupId)) {
      throw new Error("claude_worker_child_cleanup_unproven");
    }
    // Registration may still be awaiting the outer ACK when the leader exits.
    // Do not unregister or let supervisor.close() close the registrar until
    // that bounded registration handshake has settled.
    await record.registrationSettled;
    this.#unregister(record);
    this.#tracked.delete(record);
  }

  #unregister(record: TrackedClaudeProcess): void {
    if (!record.registeredWithParent) return;
    record.registeredWithParent = false;
    this.#processGroupRegistrar.unregister(record.processGroupId);
  }
}

function waitForStoppedGate(processGroupId: number): void {
  const deadline = Date.now() + CLAUDE_GATE_STOP_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    if (gateState(processGroupId) === "T") return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  throw new Error("claude_worker_process_gate_stop_timeout");
}

function gateState(processGroupId: number): string | undefined {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${processGroupId}/stat`, "utf8");
      const suffix = stat.slice(stat.lastIndexOf(")") + 2);
      return suffix[0];
    }
    if (process.platform === "darwin") {
      return execFileSync(
        "/bin/ps",
        ["-o", "state=", "-p", String(processGroupId)],
        {
          encoding: "utf8",
          timeout: 250,
          maxBuffer: 128,
          windowsHide: true,
        },
      )
        .trim()
        .slice(0, 1);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Initiates bounded child cleanup whenever the owning carrier disappears. */
export function bindClaudeSupervisorToWorkerLifetime(input: {
  readonly supervisor: ClaudeChildProcessSupervisor;
  readonly carrier: NodeJS.ReadableStream;
  readonly onCleanupFailure?: (error: unknown) => void;
}): () => void {
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    void input.supervisor
      .close()
      .catch((error) => input.onCleanupFailure?.(error));
  };
  input.carrier.once("end", stop);
  input.carrier.once("close", stop);
  input.carrier.once("error", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return () => {
    input.carrier.removeListener("end", stop);
    input.carrier.removeListener("close", stop);
    input.carrier.removeListener("error", stop);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  };
}

function validateSpawnOptions(options: SpawnOptions): void {
  if (
    !path.isAbsolute(options.command) ||
    (options.cwd !== undefined && !path.isAbsolute(options.cwd)) ||
    options.args.length > 512 ||
    options.args.some(
      (value) => value.length > 32_768 || /[\u0000\r\n]/u.test(value),
    ) ||
    Object.entries(options.env).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
        (value !== undefined &&
          (value.length > 131_072 || /\u0000/u.test(value))),
    )
  ) {
    throw new Error("claude_worker_spawn_options_invalid");
  }
}

function boundedDuration(value: number | undefined, fallback: number): number {
  const duration = value ?? fallback;
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 60_000) {
    throw new Error("claude_worker_cleanup_duration_invalid");
  }
  return duration;
}

function signalProcessGroup(
  record: TrackedClaudeProcess,
  signal: NodeJS.Signals,
): boolean {
  try {
    globalThis.process.kill(-record.processGroupId, signal);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    try {
      return record.child.kill(signal);
    } catch {
      return false;
    }
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return !isErrno(error, "ESRCH");
  }
}

async function waitForGroupsToExit(
  records: readonly TrackedClaudeProcess[],
  timeoutMilliseconds: number,
): Promise<void> {
  if (records.every((record) => !processGroupExists(record.processGroupId))) {
    return;
  }
  const deadline = Date.now() + timeoutMilliseconds;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(25, deadline - Date.now()));
      timer.unref?.();
    });
    if (records.every((record) => !processGroupExists(record.processGroupId))) {
      return;
    }
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
