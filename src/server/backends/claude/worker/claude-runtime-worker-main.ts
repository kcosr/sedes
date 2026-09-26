#!/usr/bin/env node
import { supportsClaudeRuntimeHost } from "./claude-runtime-host-support.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SidecarByteStream } from "../../../../internal/sidecar-protocol/contracts.js";
import { registerControlV2Operations } from "../../../../internal/sidecar-protocol/control-v2.js";
import { LengthPrefixedSidecarFrameTransport } from "../../../../internal/sidecar-protocol/length-prefixed-frame-transport.js";
import { SidecarOperationRegistry } from "../../../../internal/sidecar-protocol/operation-registry.js";
import { SidecarProtocolPeer } from "../../../../internal/sidecar-protocol/protocol-peer.js";
import { OfficialClaudeSdkFacade } from "../claude-sdk-facade.js";
import {
  bindClaudeSupervisorToWorkerLifetime,
  ClaudeChildProcessSupervisor,
} from "./claude-child-process-supervisor.js";
import {
  CLAUDE_RUNTIME_CAPABILITY_ID,
  CLAUDE_RUNTIME_MAJOR_VERSION,
  claudeRuntimeHostOperations,
  registerClaudeRuntimeV1WorkerOperations,
} from "./claude-runtime-v1.js";
import { ClaudeRuntimeWorkerHost } from "./claude-runtime-worker-host.js";
import { TrackedClaudeSdkFacade } from "./tracked-claude-sdk-facade.js";
import {
  CLAUDE_RUNTIME_WORKER_CLEANUP_PROVEN_FAILURE_EXIT_CODE,
  ClaudeOuterProcessSupervisor,
} from "./claude-outer-process-supervisor.js";
import {
  createClaudeProcessGroupRegistrar,
  createClaudeWorkerParentToken,
  parseClaudeWorkerSupervisionMessage,
  type ClaudeWorkerSupervisionMessage,
  validParentToken,
} from "./claude-worker-supervision-ipc.js";

declare const __SEDES_CLAUDE_RUNTIME_WORKER_BUILD_ID__: string;

class ClaudeRuntimeWorkerCleanupProvenFailure extends Error {
  constructor(cause: unknown) {
    super("claude_runtime_worker_generation_failed_cleanup_proven", { cause });
    this.name = "ClaudeRuntimeWorkerCleanupProvenFailure";
  }
}

interface CommonWorkerArguments {
  readonly expectedDigest: string;
  readonly expectedBuild: string;
  readonly carrierGeneration: number;
  readonly sessionNonce: string;
}
type WorkerArguments =
  | (CommonWorkerArguments & { readonly mode: "supervise" })
  | (CommonWorkerArguments & {
      readonly mode: "internal";
      readonly parentToken: string;
    });

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void runClaudeRuntimeWorker(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(
      `${boundedDiagnostic(error instanceof Error ? error.message : "claude_runtime_worker_failed")}\n`,
    );
    process.exitCode =
      error instanceof ClaudeRuntimeWorkerCleanupProvenFailure
        ? CLAUDE_RUNTIME_WORKER_CLEANUP_PROVEN_FAILURE_EXIT_CODE
        : 1;
  });
}

export async function runClaudeRuntimeWorker(
  arguments_: readonly string[],
): Promise<void> {
  const input = parseArguments(arguments_);
  if (!supportsClaudeRuntimeHost(process.platform, process.versions.node)) {
    throw new Error("claude_runtime_worker_host_unsupported");
  }
  if (
    typeof __SEDES_CLAUDE_RUNTIME_WORKER_BUILD_ID__ !== "string" ||
    input.expectedBuild !== __SEDES_CLAUDE_RUNTIME_WORKER_BUILD_ID__
  ) {
    throw new Error("claude_runtime_worker_build_identity_mismatch");
  }
  const executablePath = process.argv[1];
  if (!executablePath) {
    throw new Error("claude_runtime_worker_executable_path_unavailable");
  }
  const artifactSha256 = createHash("sha256")
    .update(await readFile(executablePath))
    .digest("hex");
  if (artifactSha256 !== input.expectedDigest) {
    throw new Error("claude_runtime_worker_artifact_digest_mismatch");
  }

  if (input.mode === "supervise") {
    await runOuterSupervisor(input, executablePath);
    return;
  }
  await runInternalWorker(input, artifactSha256);
}

async function runInternalWorker(
  input: Extract<WorkerArguments, { readonly mode: "internal" }>,
  artifactSha256: string,
): Promise<void> {
  if (
    !input.parentToken ||
    typeof process.send !== "function" ||
    !process.connected
  ) {
    throw new Error("claude_runtime_worker_parent_ipc_required");
  }
  let ipcFailure: unknown;
  const processGroupRegistrar = createClaudeProcessGroupRegistrar({
    token: input.parentToken,
    onFailure: (error) => {
      ipcFailure = error;
      process.kill(process.pid, "SIGTERM");
    },
  });
  await sendParentMessage({
    type: "ready",
    token: input.parentToken,
    expectedDigest: input.expectedDigest,
    expectedBuild: input.expectedBuild,
    carrierGeneration: input.carrierGeneration,
    sessionNonce: input.sessionNonce,
  });

  let cleanupFailure: unknown;
  let peer: SidecarProtocolPeer | undefined;
  const failForCleanup = (error: unknown) => {
    cleanupFailure ??= error;
    void peer
      ?.close("claude_runtime_worker_child_cleanup_unproven")
      .catch(() => undefined);
    process.kill(process.pid, "SIGTERM");
  };
  const supervisor = new ClaudeChildProcessSupervisor({
    processGroupRegistrar,
    onCleanupFailure: failForCleanup,
  });
  const unbindLifetime = bindClaudeSupervisorToWorkerLifetime({
    supervisor,
    carrier: process.stdin,
    onCleanupFailure: failForCleanup,
  });
  const transport = new LengthPrefixedSidecarFrameTransport({
    assurance: {
      kind: "managed_worker_stdio",
      carrierGeneration: input.carrierGeneration,
    },
    stream: stdioByteStream(),
  });
  const registry = new SidecarOperationRegistry();
  const sdk = new TrackedClaudeSdkFacade({
    delegate: new OfficialClaudeSdkFacade(),
    supervisor,
  });
  const host = new ClaudeRuntimeWorkerHost({
    sdk,
    peer: {
      call: (definition, request, options) =>
        peer!.call(definition, request, options),
      sendEvent: (event) => peer!.sendEvent(event),
      close: (reason) => peer!.close(reason),
    },
  });
  registerClaudeRuntimeV1WorkerOperations(registry, host.handlers);
  registerControlV2Operations(registry, {
    buildId: __SEDES_CLAUDE_RUNTIME_WORKER_BUILD_ID__,
    artifactSha256,
    enabledSidecarCapabilities: [
      {
        capabilityId: CLAUDE_RUNTIME_CAPABILITY_ID,
        majorVersion: CLAUDE_RUNTIME_MAJOR_VERSION,
      },
    ],
    enabledSedesCapabilities: [
      {
        capabilityId: CLAUDE_RUNTIME_CAPABILITY_ID,
        majorVersion: CLAUDE_RUNTIME_MAJOR_VERSION,
        operations: claudeRuntimeHostOperations
          .map(({ operation }) => operation)
          .sort(),
      },
    ],
    onGoAway: async () => {
      await host.close();
      await supervisor.close();
    },
  });
  peer = new SidecarProtocolPeer({
    role: "sidecar",
    transport,
    sessionNonce: input.sessionNonce,
    registry,
  });
  const stop = () => {
    void host
      .close()
      .then(() => supervisor.close())
      .then(() => peer.close("claude_runtime_worker_signal"))
      .catch(() => peer.close("claude_runtime_worker_cleanup_failed"))
      .catch(() => undefined);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    peer.start();
    await transport.closed;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    unbindLifetime();
    await host.close();
    await supervisor.close();
    await peer.close("claude_runtime_worker_exit").catch(() => undefined);
    if (cleanupFailure !== undefined) throw cleanupFailure;
    if (ipcFailure !== undefined) throw ipcFailure;
  }
}

async function runOuterSupervisor(
  input: Extract<WorkerArguments, { readonly mode: "supervise" }>,
  executablePath: string,
): Promise<void> {
  const parentToken = createClaudeWorkerParentToken();
  const groups = new ClaudeOuterProcessSupervisor();
  const child = spawn(
    process.execPath,
    [
      executablePath,
      "--expected-digest",
      input.expectedDigest,
      "--expected-build",
      input.expectedBuild,
      "internal",
      "--carrier-generation",
      String(input.carrierGeneration),
      "--session-nonce",
      input.sessionNonce,
      "--parent-token",
      parentToken,
    ],
    {
      env: { ...process.env },
      detached: false,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  const closurePromise = childClosure(child);
  let stderrBytes = 0;
  let failure: unknown;
  let ready = false;
  let settleReady!: (error?: unknown) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    settleReady = (error) => (error === undefined ? resolve() : reject(error));
  });
  const fail = (error: unknown) => {
    if (failure === undefined) failure = error;
    if (!ready) settleReady(error);
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    timer.unref?.();
  };
  child.on("message", (value) => {
    try {
      const message = parseClaudeWorkerSupervisionMessage(value, parentToken);
      if (message.type === "ready") {
        if (
          ready ||
          message.expectedDigest !== input.expectedDigest ||
          message.expectedBuild !== input.expectedBuild ||
          message.carrierGeneration !== input.carrierGeneration ||
          message.sessionNonce !== input.sessionNonce
        ) {
          throw new Error("claude_runtime_worker_parent_handshake_mismatch");
        }
        ready = true;
        settleReady();
      } else {
        if (!ready)
          throw new Error("claude_runtime_worker_parent_handshake_required");
        if (message.type === "process_group_registered_ack") {
          throw new Error("claude_runtime_worker_parent_ack_direction_invalid");
        }
        groups.accept(message);
        if (message.type === "process_group_registered") {
          child.send(
            {
              type: "process_group_registered_ack",
              token: parentToken,
              processGroupId: message.processGroupId,
            } satisfies ClaudeWorkerSupervisionMessage,
            (error) => {
              if (error) {
                fail(
                  new Error("claude_runtime_worker_parent_ack_failed", {
                    cause: error,
                  }),
                );
              }
            },
          );
        }
      }
    } catch (error) {
      fail(error);
    }
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.byteLength;
    if (stderrBytes > 64 * 1_024) {
      fail(new Error("claude_runtime_worker_inner_stderr_overflow"));
    }
  });
  child.once("error", fail);
  child.once("exit", () => {
    // Orphaned Claude leaders soon see EOF and exit; record their descendants
    // while ancestry is still visible. close() reads again before signalling.
    void groups.observe().catch(() => undefined);
    if (!ready)
      settleReady(new Error("claude_runtime_worker_inner_start_failed"));
  });
  const readyTimer = setTimeout(
    () => fail(new Error("claude_runtime_worker_parent_handshake_timeout")),
    10_000,
  );
  readyTimer.unref?.();
  let proxied = false;
  let terminateTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleKill = () => {
    if (killTimer) return;
    killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    killTimer.unref?.();
  };
  const stop = () => {
    child.stdin!.end();
    child.kill("SIGTERM");
    scheduleKill();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const carrierClosed = () => {
    child.stdin!.end();
    if (terminateTimer) return;
    terminateTimer = setTimeout(() => {
      child.kill("SIGTERM");
      scheduleKill();
    }, 6_000);
    terminateTimer.unref?.();
  };
  process.stdin.once("end", carrierClosed);
  process.stdin.once("close", carrierClosed);
  process.stdin.once("error", carrierClosed);
  try {
    await readyPromise.finally(() => clearTimeout(readyTimer));
    process.stdin.pipe(child.stdin!);
    child.stdout!.pipe(process.stdout, { end: false });
    proxied = true;
    const closure = await closurePromise;
    await groups.close();
    const generationFailure =
      failure ??
      (closure.code !== 0 || closure.signal !== null
        ? new Error("claude_runtime_worker_inner_failed")
        : undefined);
    if (generationFailure !== undefined) {
      throw new ClaudeRuntimeWorkerCleanupProvenFailure(generationFailure);
    }
  } catch (error) {
    // If the outer cleanup succeeds, startup, inner-worker, and generic IPC
    // failures are safe to replace. A cleanup failure thrown here supersedes
    // that classification and retains the ordinary fail-closed exit status.
    child.stdin!.end();
    child.kill("SIGTERM");
    scheduleKill();
    // Wait for the IPC channel to close before freezing the registrar's set;
    // otherwise an in-flight registration could arrive after close() took its
    // snapshot and leave an unobserved Claude descendant group.
    await closurePromise;
    try {
      await groups.close();
    } catch (cleanupError) {
      throw cleanupError;
    }
    if (error instanceof ClaudeRuntimeWorkerCleanupProvenFailure) throw error;
    throw new ClaudeRuntimeWorkerCleanupProvenFailure(error);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    clearTimeout(readyTimer);
    if (terminateTimer) clearTimeout(terminateTimer);
    if (killTimer) clearTimeout(killTimer);
    process.stdin.removeListener("end", carrierClosed);
    process.stdin.removeListener("close", carrierClosed);
    process.stdin.removeListener("error", carrierClosed);
    if (proxied) {
      process.stdin.unpipe(child.stdin!);
      child.stdout!.unpipe(process.stdout);
    }
    child.stdin!.end();
    child.kill("SIGKILL");
    await closurePromise;
    await groups.close();
  }
}

function childClosure(child: ChildProcess): Promise<{
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
}

function sendParentMessage(
  message: ClaudeWorkerSupervisionMessage,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof process.send !== "function" || !process.connected) {
      reject(new Error("claude_runtime_worker_parent_ipc_required"));
      return;
    }
    process.send(message, (error) =>
      error
        ? reject(
            new Error("claude_runtime_worker_parent_ipc_failed", {
              cause: error,
            }),
          )
        : resolve(),
    );
  });
}

function parseArguments(arguments_: readonly string[]): WorkerArguments {
  if (
    (arguments_.length !== 9 && arguments_.length !== 11) ||
    arguments_[0] !== "--expected-digest" ||
    arguments_[2] !== "--expected-build" ||
    (arguments_[4] !== "supervise" && arguments_[4] !== "internal") ||
    arguments_[5] !== "--carrier-generation" ||
    arguments_[7] !== "--session-nonce" ||
    (arguments_[4] === "supervise" && arguments_.length !== 9) ||
    (arguments_[4] === "internal" &&
      (arguments_.length !== 11 || arguments_[9] !== "--parent-token"))
  ) {
    throw new Error("claude_runtime_worker_arguments_invalid");
  }
  const expectedDigest = arguments_[1]!;
  const expectedBuild = arguments_[3]!;
  const generationText = arguments_[6]!;
  const carrierGeneration = Number(generationText);
  const sessionNonce = arguments_[8]!;
  const mode = arguments_[4] as "supervise" | "internal";
  const parentToken = arguments_[10];
  if (
    !/^[0-9a-f]{64}$/u.test(expectedDigest) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/u.test(expectedBuild) ||
    !/^[1-9][0-9]*$/u.test(generationText) ||
    !Number.isSafeInteger(carrierGeneration) ||
    !/^[A-Za-z0-9_-]{32,160}$/u.test(sessionNonce) ||
    (mode === "internal" && (!parentToken || !validParentToken(parentToken)))
  ) {
    throw new Error("claude_runtime_worker_arguments_invalid");
  }
  const common = {
    expectedDigest,
    expectedBuild,
    carrierGeneration,
    sessionNonce,
  };
  return mode === "internal"
    ? { ...common, mode, parentToken: parentToken! }
    : { ...common, mode };
}


function stdioByteStream(): SidecarByteStream {
  let settled = false;
  let settle!: (closure: {
    readonly reason: string;
    readonly cause?: Error;
  }) => void;
  const closed = new Promise<{
    readonly reason: string;
    readonly cause?: Error;
  }>((resolve) => {
    settle = resolve;
  });
  const finish = (reason: string, cause?: Error) => {
    if (settled) return;
    settled = true;
    settle({ reason, ...(cause ? { cause } : {}) });
  };
  process.stdin.once("end", () => finish("stdin_eof"));
  process.stdin.once("close", () => finish("stdin_closed"));
  process.stdin.once("error", (error) => finish("stdin_error", error));
  process.stdout.once("error", (error) => finish("stdout_error", error));
  return {
    bytes: (async function* () {
      for await (const chunk of process.stdin) yield new Uint8Array(chunk);
    })(),
    closed,
    write: async (bytes, options) => {
      options?.signal?.throwIfAborted();
      if (settled || !process.stdout.writable) {
        throw new Error("claude_runtime_worker_stdout_closed");
      }
      await new Promise<void>((resolve, reject) =>
        process.stdout.write(Buffer.from(bytes), (error) =>
          error ? reject(error) : resolve(),
        ),
      );
    },
    close: async (reason) => {
      finish(reason);
      process.stdin.pause();
      await new Promise<void>((resolve) => process.stdout.end(resolve));
    },
  };
}

function boundedDiagnostic(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/gu, "_").slice(0, 240);
}
