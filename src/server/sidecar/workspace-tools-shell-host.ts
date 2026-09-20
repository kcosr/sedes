import { mergeResolvedEnvironment } from "../environment-variables/runtime-environment.js";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import {
  SidecarOperationError,
  workspaceToolsShellTerminalSchema,
  type SidecarOutboundStream,
  type SidecarOperationContext,
  type WorkspaceToolsShellStartRequest,
  type WorkspaceToolsShellTerminal,
  type WorkspaceToolsShellV2Handlers,
  WORKSPACE_TOOLS_SHELL_DRAIN_MILLISECONDS,
  WORKSPACE_TOOLS_SHELL_MAXIMUM_PREVIEW_BYTES,
  WORKSPACE_TOOLS_SHELL_MAXIMUM_RECEIPTS,
  WORKSPACE_TOOLS_SHELL_MAXIMUM_PROCESSES,
  WORKSPACE_TOOLS_SHELL_MAXIMUM_PROCESSES_PER_WORKSPACE,
  WORKSPACE_TOOLS_SHELL_MAXIMUM_RAW_OUTPUT_BYTES,
  WORKSPACE_TOOLS_SHELL_TERMINATION_GRACE_MILLISECONDS,
} from "../../internal/sidecar-protocol/index.js";
import { buildSanitizedSidecarEnvironment } from "./sanitized-sidecar-environment.js";
import { SidecarResourceHandoffPendingError } from "./persistent-sidecar-service-registry.js";

export interface WorkspaceToolsShellHostLimits {
  readonly maximumProcesses: number;
  readonly maximumProcessesPerWorkspace: number;
  readonly maximumRawOutputBytes: number;
  readonly terminationGraceMilliseconds: number;
  readonly drainMilliseconds: number;
}

export const DEFAULT_WORKSPACE_TOOLS_SHELL_LIMITS: WorkspaceToolsShellHostLimits =
  Object.freeze({
    maximumProcesses: WORKSPACE_TOOLS_SHELL_MAXIMUM_PROCESSES,
    maximumProcessesPerWorkspace:
      WORKSPACE_TOOLS_SHELL_MAXIMUM_PROCESSES_PER_WORKSPACE,
    maximumRawOutputBytes: WORKSPACE_TOOLS_SHELL_MAXIMUM_RAW_OUTPUT_BYTES,
    terminationGraceMilliseconds:
      WORKSPACE_TOOLS_SHELL_TERMINATION_GRACE_MILLISECONDS,
    drainMilliseconds: WORKSPACE_TOOLS_SHELL_DRAIN_MILLISECONDS,
  });

type ProcessOutcome = "cancelled" | "timed_out" | "output_limited";
type TrackedProcess = {
  readonly request: WorkspaceToolsShellStartRequest;
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly stream: SidecarOutboundStream;
  readonly releaseLease: () => void;
  readonly requestSignal: AbortSignal;
  readonly timer: NodeJS.Timeout;
  outcome?: ProcessOutcome;
  stdoutBytes: number;
  stderrBytes: number;
  emittedBytes: number;
  omittedBytes: number;
  pendingBytes: number;
  outputChain: Promise<void>;
  readonly outputAbort: Promise<void>;
  abortOutput: () => void;
  terminal: boolean;
  cleanupPromise?: Promise<void>;
  cleanupFailure?: Error;
  settlementPromise?: Promise<void>;
  abort?: () => void;
  detached: boolean;
  readonly receipt: ShellReceipt;
};

interface ShellReceipt {
  readonly operationId: string;
  readonly workspaceHandle: string;
  stdout: Buffer;
  stderr: Buffer;
  previewOmittedBytes: number;
  terminal?: WorkspaceToolsShellTerminal;
}

/** Sidecar-local non-PTY Bash owner. No command or output is logged. */
export class WorkspaceToolsShellHost {
  readonly handlers: WorkspaceToolsShellV2Handlers;
  readonly #resolveWorkspace: (handle: string) => Promise<string> | string;
  readonly #openStream: (input: {
    readonly streamId: string;
    readonly initialCreditBytes: number;
  }) => SidecarOutboundStream;
  readonly #acknowledgeOperation: (operationId: string) => void;
  readonly #retainLease: () => () => void;
  readonly #admitOperation: <T>(
    workspaceHandle: string,
    operationId: string,
    payload: unknown,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #limits: WorkspaceToolsShellHostLimits;
  readonly #onCleanupFailure: (error: Error) => void;
  readonly #processGroupExited: (
    pid: number | undefined,
    maximumMilliseconds: number,
  ) => Promise<boolean>;
  readonly #processes = new Map<string, TrackedProcess>();
  readonly #receipts = new Map<string, ShellReceipt>();
  readonly #captureAdmission: () => () => void;
  #attachmentEpoch = 0;
  #revision = 0;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  #admission(): () => void {
    const epoch = this.#attachmentEpoch;
    const assertExternal = this.#captureAdmission();
    return () => {
      if (epoch !== this.#attachmentEpoch)
        throw new SidecarOperationError("sidecar_controller_stale");
      assertExternal();
    };
  }

  constructor(input: {
    readonly resolveWorkspace: (handle: string) => Promise<string> | string;
    readonly openStream: (input: {
      readonly streamId: string;
      readonly initialCreditBytes: number;
    }) => SidecarOutboundStream;
    readonly acknowledgeOperation?: (operationId: string) => void;
    readonly captureAdmission?: () => () => void;
    readonly retainLease?: () => () => void;
    readonly admitOperation: <T>(
      workspaceHandle: string,
      operationId: string,
      payload: unknown,
      operation: () => Promise<T>,
    ) => Promise<T>;
    readonly environment?: NodeJS.ProcessEnv;
    readonly limits?: Partial<WorkspaceToolsShellHostLimits>;
    readonly onCleanupFailure?: (error: Error) => void;
    readonly processGroupExited?: (
      pid: number | undefined,
      maximumMilliseconds: number,
    ) => Promise<boolean>;
  }) {
    this.#resolveWorkspace = input.resolveWorkspace;
    this.#captureAdmission = input.captureAdmission ?? (() => () => undefined);
    this.#openStream = input.openStream;
    this.#acknowledgeOperation =
      input.acknowledgeOperation ?? (() => undefined);
    this.#retainLease = input.retainLease ?? (() => () => undefined);
    this.#admitOperation = input.admitOperation;
    this.#environment = buildSanitizedSidecarEnvironment(
      input.environment ?? process.env,
    );
    this.#limits = validateLimits({
      ...DEFAULT_WORKSPACE_TOOLS_SHELL_LIMITS,
      ...input.limits,
    });
    this.#onCleanupFailure = input.onCleanupFailure ?? (() => undefined);
    this.#processGroupExited =
      input.processGroupExited ?? waitForProcessGroupExit;
    this.handlers = Object.freeze({
      list: async () => ({ streamIds: [...this.#receipts.keys()] }),
      inspect: async ({ streamId }: { readonly streamId: string }) => {
        const receipt = this.#receipts.get(streamId);
        return {
          state: this.#processes.get(streamId)?.cleanupFailure
            ? ("unknown" as const)
            : receipt?.terminal
              ? ("completed" as const)
              : this.#processes.has(streamId)
                ? ("running" as const)
                : ("unknown" as const),
          terminal: receipt?.terminal ?? null,
          stdoutBase64: receipt?.stdout.toString("base64") ?? "",
          stderrBase64: receipt?.stderr.toString("base64") ?? "",
          previewOmittedBytes: receipt?.previewOmittedBytes ?? 0,
        };
      },
      acknowledge: async ({ streamId }: { readonly streamId: string }) => {
        if (!this.#receipts.get(streamId)?.terminal)
          return { acknowledged: false };
        this.#acknowledgeOperation(this.#receipts.get(streamId)!.operationId);
        this.#receipts.delete(streamId);
        this.#revision += 1;
        return { acknowledged: true };
      },
      start: async (
        request: WorkspaceToolsShellStartRequest,
        context: SidecarOperationContext,
      ) => await this.#start(request, context.signal),
      cancel: async ({ streamId }: { readonly streamId: string }) => {
        const tracked = this.#processes.get(streamId);
        if (!tracked || tracked.terminal) return { accepted: false };
        this.#terminate(tracked, "cancelled");
        return { accepted: true };
      },
    });
  }

  activeProcessCount(): number {
    return this.#processes.size;
  }

  unsettledReceiptCount(): number {
    return this.#receipts.size;
  }

  snapshot(): {
    revision: string;
    state: "idle" | "active" | "unknown";
    blockers: ("active_work" | "unsettled_outcome" | "cleanup_unproven")[];
  } {
    if ([...this.#processes.values()].some((process) => process.cleanupFailure))
      return {
        revision: String(this.#revision),
        state: "unknown",
        blockers: ["cleanup_unproven"],
      };
    return {
      revision: String(this.#revision),
      state: this.#processes.size ? "active" : "idle",
      blockers: [
        ...(this.#processes.size ? ["active_work" as const] : []),
        ...(this.#receipts.size ? ["unsettled_outcome" as const] : []),
      ],
    };
  }

  abandonmentEvidence() { return { ...this.snapshot(), operations: [...this.#receipts].map(([streamId, receipt]) => ({ streamId, operationId: receipt.operationId,
    terminal: receipt.terminal ? { outcome: receipt.terminal.outcome, exitCode: receipt.terminal.exitCode } : undefined })) }; }
  async stop(force = false): Promise<void> {
    await this.close();
    if (!force && this.#receipts.size) throw new SidecarResourceHandoffPendingError();
  }

  /** Carrier loss detaches delivery; explicit cancel and deadlines still stop work. */
  detach(): void {
    this.#attachmentEpoch += 1;
    for (const tracked of this.#processes.values()) {
      tracked.detached = true;
      if (tracked.abort)
        tracked.requestSignal.removeEventListener("abort", tracked.abort);
      tracked.abortOutput();
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return await this.#closePromise;
    this.#closing = true;
    this.#closePromise = (async () => {
      const settlements = [...this.#processes.values()].map(async (tracked) => {
        this.#terminate(tracked, "cancelled");
        await this.#waitForTerminal(tracked);
      });
      await Promise.all(settlements);
    })();
    return await this.#closePromise;
  }

  async #start(
    request: WorkspaceToolsShellStartRequest,
    signal: AbortSignal,
  ): Promise<{ readonly streamId: string; readonly admitted: true }> {
    const { operationId, workspaceHandle, environmentVariables, ...payload } = request;
    if (environmentVariables && !request.environmentIdentity) throw new SidecarOperationError("shell_environment_identity_missing");
    return await this.#admitOperation(
      workspaceHandle,
      operationId,
      { ...payload, ...(environmentVariables ? { environmentNames: Object.keys(environmentVariables).sort() } : {}) },
      async () => await this.#startAdmitted(request, signal),
    );
  }

  async #startAdmitted(
    request: WorkspaceToolsShellStartRequest,
    signal: AbortSignal,
  ): Promise<{ readonly streamId: string; readonly admitted: true }> {
    signal.throwIfAborted();
    const assertAdmission = this.#admission();
    assertAdmission();
    if (this.#closing)
      throw new SidecarOperationError("shell_admission_closed");
    if (
      this.#processes.has(request.streamId) ||
      this.#receipts.has(request.streamId)
    ) {
      throw new SidecarOperationError("shell_stream_duplicate");
    }
    if (this.#processes.size >= this.#limits.maximumProcesses) {
      throw new SidecarOperationError("shell_process_capacity", true);
    }
    if (this.#receipts.size >= WORKSPACE_TOOLS_SHELL_MAXIMUM_RECEIPTS) {
      throw new SidecarOperationError("shell_receipt_capacity", true);
    }
    let workspaceCount = 0;
    for (const process of this.#processes.values()) {
      if (process.request.workspaceHandle === request.workspaceHandle) {
        workspaceCount += 1;
      }
    }
    if (workspaceCount >= this.#limits.maximumProcessesPerWorkspace) {
      throw new SidecarOperationError("shell_workspace_process_capacity", true);
    }
    const cwd = await this.#resolveWorkspace(request.workspaceHandle);
    signal.throwIfAborted();
    assertAdmission();
    const stream = this.#openStream({
      streamId: request.streamId,
      initialCreditBytes: request.initialCreditBytes,
    });
    const releaseLease = this.#retainLease();
    const receipt: ShellReceipt = {
      operationId: request.operationId,
      workspaceHandle: request.workspaceHandle,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      previewOmittedBytes: 0,
    };
    this.#receipts.set(request.streamId, receipt);
    this.#revision += 1;
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn("/bin/bash", ["-c", request.command], {
        cwd,
        env: mergeResolvedEnvironment(this.#environment, request.environmentVariables ?? {}),
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      releaseLease();
      receipt.terminal = terminal("spawn_failed", null, null, 0, 0, 0, 0);
      this.#revision += 1;
      await stream.terminal(
        receipt.terminal,
        workspaceToolsShellTerminalSchema,
      );
      return { streamId: request.streamId, admitted: true };
    }
    const timer = setTimeout(
      () => this.#terminate(tracked, "timed_out"),
      request.timeoutMilliseconds,
    );
    timer.unref();
    let abortOutput!: () => void;
    const outputAbort = new Promise<void>((resolve) => {
      abortOutput = resolve;
    });
    const { environmentVariables: _environmentVariables, ...retainedRequest } = request;
    const tracked: TrackedProcess = {
      request: retainedRequest,
      child,
      stream,
      releaseLease,
      requestSignal: signal,
      timer,
      stdoutBytes: 0,
      stderrBytes: 0,
      emittedBytes: 0,
      omittedBytes: 0,
      pendingBytes: 0,
      outputChain: Promise.resolve(),
      outputAbort,
      abortOutput,
      terminal: false,
      detached: false,
      receipt,
    };
    this.#processes.set(request.streamId, tracked);
    tracked.abort = () => {
      if (
        signal.reason instanceof Error &&
        signal.reason.message === "sidecar_protocol_peer_closed"
      ) {
        tracked.detached = true;
        tracked.abortOutput();
        return;
      }
      this.#terminate(tracked, "cancelled");
    };
    signal.addEventListener("abort", tracked.abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) =>
      this.#output(tracked, "stdout", chunk),
    );
    child.stderr.on("data", (chunk: Buffer) =>
      this.#output(tracked, "stderr", chunk),
    );
    child.once(
      "error",
      () => void this.#settle(tracked, "spawn_failed", null, null),
    );
    child.once("close", (code, processSignal) => {
      // A leader exit is not permission for background group members to persist.
      void this.#cleanupGroup(tracked)
        .then(() =>
          this.#settle(
            tracked,
            tracked.outcome ?? "exited",
            code,
            processSignal,
          ),
        )
        .catch((error: unknown) => this.#cleanupFailed(tracked, error));
    });
    if (signal.aborted) tracked.abort();
    return { streamId: request.streamId, admitted: true };
  }

  #output(
    tracked: TrackedProcess,
    channel: "stdout" | "stderr",
    chunk: Buffer,
  ): void {
    if (tracked.terminal || chunk.byteLength === 0) return;
    if (channel === "stdout") tracked.stdoutBytes += chunk.byteLength;
    else tracked.stderrBytes += chunk.byteLength;
    const remaining =
      WORKSPACE_TOOLS_SHELL_MAXIMUM_PREVIEW_BYTES -
      tracked.receipt.stdout.byteLength -
      tracked.receipt.stderr.byteLength;
    const retained = chunk.subarray(0, Math.max(0, remaining));
    tracked.receipt[channel] = Buffer.concat([
      tracked.receipt[channel],
      retained,
    ]);
    tracked.receipt.previewOmittedBytes +=
      chunk.byteLength - retained.byteLength;
    if (tracked.detached) {
      tracked.omittedBytes += chunk.byteLength;
      if (
        tracked.stdoutBytes + tracked.stderrBytes >
        this.#limits.maximumRawOutputBytes
      )
        this.#terminate(tracked, "output_limited");
      return;
    }
    const total = tracked.stdoutBytes + tracked.stderrBytes;
    if (total > this.#limits.maximumRawOutputBytes) {
      tracked.omittedBytes += chunk.byteLength;
      this.#terminate(tracked, "output_limited");
      return;
    }
    const bytes = Uint8Array.from(chunk);
    tracked.pendingBytes += bytes.byteLength;
    const next = tracked.outputChain.then(async () => {
      if (tracked.terminal || tracked.detached) {
        tracked.pendingBytes -= bytes.byteLength;
        tracked.omittedBytes += bytes.byteLength;
        return;
      }
      try {
        const sent = await Promise.race([
          tracked.stream.send(channel, bytes).then(() => true),
          tracked.outputAbort.then(() => false),
        ]);
        tracked.pendingBytes -= bytes.byteLength;
        if (sent) tracked.emittedBytes += bytes.byteLength;
        else tracked.omittedBytes += bytes.byteLength;
      } catch {
        tracked.pendingBytes -= bytes.byteLength;
        tracked.omittedBytes += bytes.byteLength;
      }
    });
    tracked.outputChain = next.catch(() => undefined);
  }

  #terminate(tracked: TrackedProcess, outcome: ProcessOutcome): void {
    if (tracked.terminal || tracked.outcome) return;
    tracked.outcome = outcome;
    tracked.abortOutput();
    void this.#cleanupGroup(tracked);
  }

  #cleanupGroup(tracked: TrackedProcess): Promise<void> {
    if (tracked.cleanupPromise) return tracked.cleanupPromise;
    tracked.cleanupPromise = (async () => {
      killGroup(tracked.child.pid, "SIGTERM");
      if (
        await this.#processGroupExited(
          tracked.child.pid,
          this.#limits.terminationGraceMilliseconds,
        )
      ) {
        return;
      }
      killGroup(tracked.child.pid, "SIGKILL");
      if (
        !(await this.#processGroupExited(
          tracked.child.pid,
          this.#limits.drainMilliseconds,
        ))
      ) {
        throw new Error("workspace_tools_shell_cleanup_unproven");
      }
    })();
    // Observe the one shared promise at creation. Callers may independently
    // await/rethrow it, while fire-and-forget termination can never leak an
    // unhandled rejection.
    void tracked.cleanupPromise.catch((error: unknown) =>
      this.#cleanupFailed(tracked, error),
    );
    return tracked.cleanupPromise;
  }

  #cleanupFailed(tracked: TrackedProcess, error: unknown): void {
    if (tracked.cleanupFailure) return;
    tracked.cleanupFailure =
      error instanceof Error
        ? error
        : new Error("workspace_tools_shell_cleanup_unproven");
    this.#revision += 1;
    clearTimeout(tracked.timer);
    if (tracked.abort) {
      tracked.requestSignal.removeEventListener("abort", tracked.abort);
      tracked.abort = undefined;
    }
    this.#onCleanupFailure(tracked.cleanupFailure);
  }

  async #settle(
    tracked: TrackedProcess,
    outcome: WorkspaceToolsShellTerminal["outcome"],
    code: number | null,
    processSignal: NodeJS.Signals | null,
  ): Promise<void> {
    if (tracked.settlementPromise) return await tracked.settlementPromise;
    tracked.settlementPromise = (async () => {
      if (outcome === "exited" && tracked.outcome === undefined) {
        // Preserve stream order: a normal process exit is not permission for
        // terminal to overtake output that is waiting for consumer credit.
        // Cancellation/timeout/close resolves outputAbort so forced cleanup
        // can discard the bounded pending bytes and settle without credit.
        await Promise.race([tracked.outputChain, tracked.outputAbort]);
      }
      const effectiveOutcome = tracked.outcome ?? outcome;
      tracked.terminal = true;
      clearTimeout(tracked.timer);
      if (tracked.abort) {
        tracked.requestSignal.removeEventListener("abort", tracked.abort);
        tracked.abort = undefined;
      }
      const drain = setTimeout(() => {
        tracked.child.stdout.destroy();
        tracked.child.stderr.destroy();
      }, this.#limits.drainMilliseconds);
      drain.unref();
      try {
        tracked.receipt.terminal = terminal(
          effectiveOutcome,
          code,
          processSignal,
          tracked.stdoutBytes,
          tracked.stderrBytes,
          tracked.emittedBytes,
          tracked.omittedBytes + tracked.pendingBytes,
        );
        this.#revision += 1;
        if (!tracked.detached)
          await tracked.stream
            .terminal(
              tracked.receipt.terminal,
              workspaceToolsShellTerminalSchema,
            )
            .catch(() => undefined);
      } finally {
        clearTimeout(drain);
        this.#processes.delete(tracked.request.streamId);
        tracked.releaseLease();
      }
    })();
    return await tracked.settlementPromise;
  }

  async #waitForTerminal(tracked: TrackedProcess): Promise<void> {
    const deadline =
      Date.now() +
      this.#limits.terminationGraceMilliseconds +
      this.#limits.drainMilliseconds +
      250;
    while (
      this.#processes.has(tracked.request.streamId) &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    if (tracked.cleanupFailure) throw tracked.cleanupFailure;
    if (this.#processes.has(tracked.request.streamId)) {
      throw new Error("workspace_tools_shell_cleanup_unproven");
    }
    await tracked.settlementPromise;
  }
}

function terminal(
  outcome: WorkspaceToolsShellTerminal["outcome"],
  exitCode: number | null,
  signal: string | null,
  stdoutBytes: number,
  stderrBytes: number,
  emittedBytes: number,
  omittedBytes: number,
): WorkspaceToolsShellTerminal {
  return {
    outcome,
    exitCode,
    signal,
    stdoutBytes,
    stderrBytes,
    emittedBytes,
    omittedBytes,
    truncated: omittedBytes > 0,
  };
}

function killGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH is expected once cleanup has already completed.
  }
}

async function waitForProcessGroupExit(
  pid: number | undefined,
  maximumMilliseconds: number,
): Promise<boolean> {
  if (!pid) return true;
  const deadline = Date.now() + maximumMilliseconds;
  do {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return true;
      }
      throw error;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  return false;
}

function validateLimits(
  limits: WorkspaceToolsShellHostLimits,
): WorkspaceToolsShellHostLimits {
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new Error("workspace_tools_shell_limits_invalid");
  }
  return Object.freeze(limits);
}
