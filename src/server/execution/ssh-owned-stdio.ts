import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EnvironmentProcessWriteDelivery } from "./environment-channel.js";
import {
  OPEN_SSH_BASE_ARGUMENTS,
  safeSshHostAlias,
  terminateExactSshChild,
  type SshProcessSpawner,
} from "./ssh-open-ssh.js";

const DEFAULT_START_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_STOP_TIMEOUT_MILLISECONDS = 1_000;
const DEFAULT_MAXIMUM_STDERR_BYTES = 16 * 1_024;
const MAXIMUM_EFFECTIVE_CONFIGURATION_BYTES = 256 * 1_024;

/**
 * Sidecar command carriers must not inherit forwarding or client environment
 * directives from an operator's Host alias. Keep these options separate from
 * OPEN_SSH_BASE_ARGUMENTS: the independent Codex StreamLocal carrier has its
 * own forwarding contract.
 */
export const SIDECAR_SSH_ARGUMENTS = Object.freeze([
  "-o",
  "ClearAllForwardings=yes",
  // OpenSSH does not reliably let a command-line negation erase SendEnv
  // accumulated later from Host configuration. The authoritative control is
  // assertManagedSidecarSshConfiguration plus the minimal client environment;
  // retain this as defense in depth for implementations that apply it.
  "-o",
  "SendEnv=-*",
]);

const SIDECAR_SSH_CLIENT_ENVIRONMENT_NAMES = Object.freeze([
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SSH_AUTH_SOCK",
] as const);

export class SshOwnedStdioWriteError extends Error {
  readonly delivery: EnvironmentProcessWriteDelivery;

  constructor(
    message: string,
    delivery: EnvironmentProcessWriteDelivery,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SshOwnedStdioWriteError";
    this.delivery = delivery;
  }
}

export class SshOwnedStdioCleanupError extends Error {
  readonly diagnosticCode = "ssh_owned_stdio_cleanup_failed" as const;

  constructor(options: ErrorOptions) {
    super("ssh_owned_stdio_cleanup_failed", options);
    this.name = "SshOwnedStdioCleanupError";
  }
}

export interface SshOwnedStdioClosure {
  readonly reason: "exit" | "spawn_error" | "stderr_overflow";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly cause?: Error;
  /** The remote program's final stderr line when it is a bare diagnostic code. */
  readonly diagnostic?: string;
}

export interface SshOwnedStdioChannel {
  readonly channelId: string;
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly closed: Promise<SshOwnedStdioClosure>;
  writeStdin(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
  closeStdin(): void;
  close(reason: string): Promise<void>;
}

export type SshBidirectionalProcessSpawner = (
  executable: string,
  arguments_: readonly string[],
) => ChildProcess;

export const defaultSshBidirectionalProcessSpawner: SshBidirectionalProcessSpawner =
  (executable, arguments_) =>
    spawn(executable, [...arguments_], {
      env: managedSidecarSshClientEnvironment(process.env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

/**
 * Opens one foreground OpenSSH command with bidirectional stdio. The command is
 * a complete, internally rendered remote-shell program; callers must never pass
 * browser- or model-authored text here.
 */
export async function openOwnedSshStdio(input: {
  readonly host: string;
  readonly remoteCommand: string;
  readonly signal: AbortSignal;
  readonly sshExecutable?: string;
  readonly spawnProcess?: SshProcessSpawner;
  readonly startTimeoutMilliseconds?: number;
  readonly stopTimeoutMilliseconds?: number;
  readonly maximumStderrBytes?: number;
}): Promise<SshOwnedStdioChannel> {
  if (
    !safeSshHostAlias(input.host) ||
    input.remoteCommand.length === 0 ||
    input.remoteCommand.length > 256 * 1_024 ||
    input.remoteCommand.includes("\0") ||
    input.remoteCommand.includes("\r") ||
    input.remoteCommand.includes("\n")
  ) {
    throw new Error("ssh_owned_stdio_configuration_invalid");
  }
  const startTimeout = positiveMilliseconds(
    input.startTimeoutMilliseconds ?? DEFAULT_START_TIMEOUT_MILLISECONDS,
    "ssh_owned_stdio_start_timeout_invalid",
  );
  const stopTimeout = positiveMilliseconds(
    input.stopTimeoutMilliseconds ?? DEFAULT_STOP_TIMEOUT_MILLISECONDS,
    "ssh_owned_stdio_stop_timeout_invalid",
  );
  const maximumStderrBytes = positiveMilliseconds(
    input.maximumStderrBytes ?? DEFAULT_MAXIMUM_STDERR_BYTES,
    "ssh_owned_stdio_stderr_limit_invalid",
  );
  if (input.signal.aborted) throw input.signal.reason;
  const spawnProcess =
    input.spawnProcess ?? defaultSshBidirectionalProcessSpawner;
  const child = spawnProcess(input.sshExecutable ?? "ssh", [
    ...OPEN_SSH_BASE_ARGUMENTS,
    ...SIDECAR_SSH_ARGUMENTS,
    input.host,
    input.remoteCommand,
  ]);
  if (!isBidirectionalChild(child)) {
    try {
      await terminateExactSshChild(child, stopTimeout);
    } catch (error) {
      throw new SshOwnedStdioCleanupError({ cause: error });
    }
    throw new Error("ssh_owned_stdio_streams_unavailable");
  }
  // Install lifecycle and stderr ownership before `spawn` can be observed.
  // A short-lived remote command may exit in the same turn as its spawn event.
  const channel = new OwnedSshStdioChannel({
    child,
    stopTimeoutMilliseconds: stopTimeout,
    maximumStderrBytes,
  });
  try {
    await waitForSpawn(child, input.signal, startTimeout);
  } catch (error) {
    try {
      await terminateExactSshChild(child, stopTimeout);
    } catch (cleanupError) {
      throw new SshOwnedStdioCleanupError({ cause: cleanupError });
    }
    throw error;
  }
  if (input.signal.aborted) {
    try {
      await terminateExactSshChild(child, stopTimeout);
    } catch (error) {
      throw new SshOwnedStdioCleanupError({ cause: error });
    }
    throw input.signal.reason;
  }
  return channel;
}

/**
 * Resolves the complete OpenSSH Host alias before starting a managed sidecar.
 * Forwarding is forcibly cleared. The SSH client receives only a minimal local
 * environment, and aliases whose SendEnv patterns could expose one of those
 * retained values are rejected. SetEnv has no safe wildcard reset, so any
 * effective value makes the alias ineligible.
 */
export async function assertManagedSidecarSshConfiguration(input: {
  readonly host: string;
  readonly signal: AbortSignal;
  readonly sshExecutable?: string;
  readonly spawnProcess?: SshProcessSpawner;
  readonly stopTimeoutMilliseconds?: number;
  /** Trusted, complete SSH argument family used by the admitted carrier. */
  readonly sshArguments?: readonly string[];
}): Promise<void> {
  if (!safeSshHostAlias(input.host)) {
    throw new Error("ssh_owned_stdio_configuration_invalid");
  }
  if (input.signal.aborted) throw input.signal.reason;
  const stopTimeout = positiveMilliseconds(
    input.stopTimeoutMilliseconds ?? DEFAULT_STOP_TIMEOUT_MILLISECONDS,
    "ssh_owned_stdio_stop_timeout_invalid",
  );
  const spawnProcess =
    input.spawnProcess ?? defaultSshBidirectionalProcessSpawner;
  const sshArguments = input.sshArguments ?? [
    ...OPEN_SSH_BASE_ARGUMENTS,
    ...SIDECAR_SSH_ARGUMENTS,
  ];
  const child = spawnProcess(input.sshExecutable ?? "ssh", [
    ...sshArguments,
    "-G",
    input.host,
  ]);
  if (!child.stdout || !child.stderr) {
    await terminateExactSshChild(child, stopTimeout);
    throw new Error("ssh_sidecar_effective_configuration_unavailable");
  }
  let stdout = Buffer.alloc(0);
  let observedBytes = 0;
  let overflow = false;
  const observe = (chunk: Buffer, retain: boolean) => {
    observedBytes += chunk.byteLength;
    if (observedBytes > MAXIMUM_EFFECTIVE_CONFIGURATION_BYTES) {
      overflow = true;
      child.kill("SIGTERM");
      return;
    }
    if (retain) stdout = Buffer.concat([stdout, chunk]);
  };
  child.stdout.on("data", (chunk: Buffer) => observe(chunk, true));
  child.stderr.on("data", (chunk: Buffer) => observe(chunk, false));
  let abort: (() => void) | undefined;
  try {
    const closurePromise = new Promise<{
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      child.once("error", reject);
      // `exit` only means the process stopped; its final stdout may still be
      // draining. Validate only after `close` confirms all stdio has closed.
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abort = () => reject(input.signal.reason);
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
    });
    const closure = await Promise.race([closurePromise, abortPromise]);
    if (input.signal.aborted) throw input.signal.reason;
    if (overflow)
      throw new Error("ssh_sidecar_effective_configuration_overflow");
    if (closure.exitCode !== 0 || closure.signal !== null) {
      throw new Error("ssh_sidecar_effective_configuration_unavailable");
    }
    const output = stdout.toString("utf8");
    if (Buffer.from(output, "utf8").byteLength !== stdout.byteLength) {
      throw new Error("ssh_sidecar_effective_configuration_invalid");
    }
    const lines = output.split("\n").map((line) => line.trimStart());
    if (lines.some((line) => /^setenv(?:\s|$)/u.test(line.trimStart()))) {
      throw new Error("ssh_sidecar_setenv_unsupported");
    }
    if (
      !lines.includes("clearallforwardings yes") ||
      lines.some(effectiveSendEnvExposesRetainedClientValue) ||
      lines.includes("forwardagent yes") ||
      lines.includes("forwardx11 yes")
    ) {
      throw new Error("ssh_sidecar_effective_configuration_unsafe");
    }
  } finally {
    if (abort) input.signal.removeEventListener("abort", abort);
    if (child.exitCode === null && child.signalCode === null) {
      await terminateExactSshChild(child, stopTimeout);
    }
  }
}

export function managedSidecarSshClientEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = Object.create(
    null,
  ) as NodeJS.ProcessEnv;
  for (const name of SIDECAR_SSH_CLIENT_ENVIRONMENT_NAMES) {
    const value = source[name];
    if (value !== undefined && !/[\u0000\r\n]/u.test(value)) {
      environment[name] = value;
    }
  }
  return environment;
}

function effectiveSendEnvExposesRetainedClientValue(line: string): boolean {
  if (!line.startsWith("sendenv ")) return false;
  return line
    .slice("sendenv ".length)
    .split(/\s+/u)
    .filter((pattern) => pattern.length > 0 && !pattern.startsWith("-"))
    .some((pattern) =>
      SIDECAR_SSH_CLIENT_ENVIRONMENT_NAMES.some((name) =>
        openSshPatternMatches(pattern, name),
      ),
    );
}

function openSshPatternMatches(pattern: string, value: string): boolean {
  const source = [...pattern]
    .map((character) =>
      character === "*"
        ? ".*"
        : character === "?"
          ? "."
          : character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
    )
    .join("");
  return new RegExp(`^${source}$`, "u").test(value);
}

const STDERR_DIAGNOSTIC_TAIL_BYTES = 512;

/** Bootstrap and service entrypoints print one bounded code as their last line. */
function stderrDiagnostic(tail: Buffer): string | undefined {
  const lines = tail.toString("utf8").split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  const last = lines.at(-1);
  return last !== undefined && /^[a-z][a-z0-9_]{0,119}$/u.test(last) ? last : undefined;
}

class OwnedSshStdioChannel implements SshOwnedStdioChannel {
  readonly channelId = randomUUID();
  readonly stdout: AsyncIterable<Uint8Array>;
  readonly closed: Promise<SshOwnedStdioClosure>;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #stopTimeoutMilliseconds: number;
  #acceptingWrites = true;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly child: ChildProcessWithoutNullStreams;
    readonly stopTimeoutMilliseconds: number;
    readonly maximumStderrBytes: number;
  }) {
    this.#child = input.child;
    this.#stopTimeoutMilliseconds = input.stopTimeoutMilliseconds;
    this.stdout = byteIterable(input.child.stdout);
    input.child.stdin.on("error", () => undefined);
    let stderrBytes = 0;
    let stderrOverflow = false;
    let stderrTail = Buffer.alloc(0);
    input.child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > input.maximumStderrBytes && !stderrOverflow) {
        stderrOverflow = true;
        input.child.kill("SIGTERM");
      }
      stderrTail = Buffer.concat([stderrTail, chunk]).subarray(-STDERR_DIAGNOSTIC_TAIL_BYTES);
    });
    this.closed = new Promise((resolve) => {
      let settled = false;
      const finish = (closure: SshOwnedStdioClosure) => {
        if (settled) return;
        settled = true;
        this.#acceptingWrites = false;
        const diagnostic = stderrDiagnostic(stderrTail);
        resolve(Object.freeze(diagnostic ? { ...closure, diagnostic } : closure));
      };
      input.child.once("error", (cause) =>
        finish({
          reason: stderrOverflow ? "stderr_overflow" : "spawn_error",
          exitCode: input.child.exitCode,
          signal: input.child.signalCode,
          cause,
        }),
      );
      input.child.once("exit", (exitCode, signal) =>
        finish({
          reason: stderrOverflow ? "stderr_overflow" : "exit",
          exitCode,
          signal,
        }),
      );
    });
  }

  async writeStdin(
    bytes: Uint8Array,
    options?: { readonly signal?: AbortSignal },
  ): Promise<void> {
    if (!this.#acceptingWrites || !this.#child.stdin.writable) {
      throw new SshOwnedStdioWriteError(
        "ssh_owned_stdio_stdin_closed",
        "not_sent",
      );
    }
    if (options?.signal?.aborted) {
      throw new SshOwnedStdioWriteError(
        "ssh_owned_stdio_write_aborted",
        "not_sent",
        { cause: options.signal.reason },
      );
    }
    if (bytes.byteLength === 0) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        options?.signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      const abort = () =>
        finish(
          new SshOwnedStdioWriteError(
            "ssh_owned_stdio_write_aborted_during_write",
            "sent_outcome_unknown",
            { cause: options?.signal?.reason },
          ),
        );
      options?.signal?.addEventListener("abort", abort, { once: true });
      this.#child.stdin.write(Buffer.from(bytes), (cause) =>
        finish(
          cause
            ? new SshOwnedStdioWriteError(
                "ssh_owned_stdio_write_failed",
                "sent_outcome_unknown",
                { cause },
              )
            : undefined,
        ),
      );
      if (options?.signal?.aborted) abort();
    });
  }

  closeStdin(): void {
    if (!this.#acceptingWrites) return;
    this.#acceptingWrites = false;
    this.#child.stdin.end();
  }

  close(_reason: string): Promise<void> {
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.closeStdin();
    await Promise.race([this.closed, delay(this.#stopTimeoutMilliseconds)]);
    await terminateExactSshChild(this.#child, this.#stopTimeoutMilliseconds);
  }
}

function isBidirectionalChild(
  child: ChildProcess,
): child is ChildProcessWithoutNullStreams {
  return Boolean(child.stdin && child.stdout && child.stderr);
}

async function waitForSpawn(
  child: ChildProcess,
  signal: AbortSignal,
  timeoutMilliseconds: number,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("ssh_owned_stdio_start_timeout")),
      timeoutMilliseconds,
    );
    timer.unref();
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      child.removeListener("spawn", spawned);
      child.removeListener("error", failed);
      if (error) reject(error);
      else resolve();
    };
    const aborted = () => finish(signal.reason);
    const spawned = () => finish();
    const failed = (error: Error) => finish(error);
    signal.addEventListener("abort", aborted, { once: true });
    child.once("spawn", spawned);
    child.once("error", failed);
    if (signal.aborted) aborted();
  });
}

async function* byteIterable(
  stream: NodeJS.ReadableStream,
): AsyncIterable<Uint8Array> {
  for await (const chunk of stream) {
    yield typeof chunk === "string"
      ? Buffer.from(chunk, "utf8")
      : new Uint8Array(chunk as Uint8Array);
  }
}

function positiveMilliseconds(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}
