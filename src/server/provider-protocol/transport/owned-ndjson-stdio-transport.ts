import { StringDecoder } from "node:string_decoder";
import {
  EnvironmentProcessWriteError,
  validEnvironmentChannelScope,
  type EnvironmentOwnedProcessChannel,
  type ExecutionEnvironmentChannelProvider,
  type PreparedEnvironmentOwnedProcess,
} from "../../execution/environment-channel.js";
import {
  FrameWriteError,
  createOwnedProcessAssurance,
  revokeFramedTransportAssurance,
  type FramedMessageTransport,
  type FramedTransportClosure,
  type FramedTransportFactory,
  type FramedTransportLifecycleObserver,
  type InboundTextFrame,
  type ProviderTransportScope,
  sameProviderTransportScope,
} from "./assured-framed-transport.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "./framed-message-limits.js";

export interface OwnedNdjsonStdioLimits {
  readonly maximumFrameBytes: number;
  readonly maximumInboundQueueBytes: number;
  readonly maximumInboundQueueFrames: number;
  readonly maximumOutboundQueueBytes: number;
  readonly maximumOutboundQueueFrames: number;
  readonly maximumStderrTailBytes: number;
  readonly gracefulCloseMilliseconds: number;
  readonly terminateMilliseconds: number;
  readonly killMilliseconds: number;
}

export const DEFAULT_OWNED_NDJSON_STDIO_LIMITS: OwnedNdjsonStdioLimits =
  Object.freeze({
    maximumFrameBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
    maximumInboundQueueBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
    maximumInboundQueueFrames: 256,
    maximumOutboundQueueBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
    maximumOutboundQueueFrames: 256,
    maximumStderrTailBytes: 64 * 1024,
    gracefulCloseMilliseconds: 1_000,
    terminateMilliseconds: 2_000,
    killMilliseconds: 2_000,
  });

type WriteEntry = {
  readonly bytes: Buffer;
  readonly payloadByteLength: number;
  readonly resolve: (value: { readonly disposition: "sent" }) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
  cancelled: boolean;
  settled: boolean;
  started: boolean;
};

export interface OwnedNdjsonStdioDiagnostics {
  readonly stdoutBytesRead: number;
  readonly stderrBytesRead: number;
  readonly inboundFramesRead: number;
  readonly outboundFramesAccepted: number;
  readonly outboundFramesWritten: number;
  readonly streamsDrained: boolean;
  readonly processExitDisposition:
    | "not_observed"
    | "zero_exit"
    | "nonzero_exit"
    | "signal_exit"
    | "spawn_error"
    | "channel_failure";
  readonly stderrTail: string;
  readonly stderrTailBytes: number;
}

export class OwnedNdjsonStdioTransportFactory implements FramedTransportFactory {
  readonly #scope: ProviderTransportScope;
  readonly #channels: ExecutionEnvironmentChannelProvider;
  readonly #process: PreparedEnvironmentOwnedProcess;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #limits: OwnedNdjsonStdioLimits;
  readonly #sensitiveValues: readonly string[];
  readonly #retainStderr: boolean;
  readonly #commandArguments: readonly string[];
  readonly #assuranceDiagnosticPrefix: string;
  readonly #transportDiagnosticPrefix: string;

  constructor(input: {
    readonly scope: ProviderTransportScope;
    readonly channels: ExecutionEnvironmentChannelProvider;
    readonly process: PreparedEnvironmentOwnedProcess;
    readonly environment: Readonly<Record<string, string>>;
    readonly commandArguments: readonly string[];
    readonly limits?: Partial<OwnedNdjsonStdioLimits>;
    readonly sensitiveValues?: readonly string[];
    readonly retainStderr?: boolean;
    readonly assuranceDiagnosticPrefix: string;
    readonly transportDiagnosticPrefix: string;
  }) {
    const transportDiagnosticPrefix = validatedDiagnosticPrefix(
      input.transportDiagnosticPrefix,
    );
    const assuranceDiagnosticPrefix = validatedDiagnosticPrefix(
      input.assuranceDiagnosticPrefix,
    );
    if (!validEnvironmentChannelScope(input.scope)) {
      throw new Error(`${transportDiagnosticPrefix}_scope_invalid`);
    }
    this.#scope = Object.freeze({ ...input.scope });
    this.#channels = input.channels;
    this.#process = input.process;
    this.#environment = Object.freeze({ ...input.environment });
    this.#transportDiagnosticPrefix = transportDiagnosticPrefix;
    this.#assuranceDiagnosticPrefix = assuranceDiagnosticPrefix;
    this.#limits = resolvedLimits(
      input.limits,
      this.#transportDiagnosticPrefix,
    );
    this.#sensitiveValues = Object.freeze([...(input.sensitiveValues ?? [])]);
    this.#retainStderr = input.retainStderr ?? true;
    this.#commandArguments = Object.freeze([...input.commandArguments]);
  }

  async open(
    expectedScope: ProviderTransportScope,
    connectionGeneration: number,
    signal: AbortSignal,
    lifecycle?: FramedTransportLifecycleObserver,
  ): Promise<OwnedNdjsonStdioTransport> {
    if (!sameProviderTransportScope(this.#scope, expectedScope)) {
      throw new Error(`${this.#transportDiagnosticPrefix}_scope_mismatch`);
    }
    if (signal.aborted) throw signal.reason;
    const observer = lifecycle ?? NOOP_TRANSPORT_LIFECYCLE;
    observer.launchStarted();
    let channel: EnvironmentOwnedProcessChannel;
    try {
      channel = await this.#channels.openOwnedProcess(
        expectedScope,
        {
          prepared: this.#process,
          arguments: this.#commandArguments,
          environment: this.#environment,
          cleanup: {
            gracefulCloseMilliseconds: this.#limits.gracefulCloseMilliseconds,
            terminateMilliseconds: this.#limits.terminateMilliseconds,
            killMilliseconds: this.#limits.killMilliseconds,
          },
        },
        signal,
      );
    } catch (error) {
      if (isCleanupUncertainty(error)) observer.cleanupFailed(error);
      else observer.cleanupProven();
      throw error;
    }
    try {
      return new OwnedNdjsonStdioTransport({
        scope: expectedScope,
        connectionGeneration,
        channel,
        limits: this.#limits,
        sensitiveValues: this.#sensitiveValues,
        retainStderr: this.#retainStderr,
        assuranceDiagnosticPrefix: this.#assuranceDiagnosticPrefix,
        transportDiagnosticPrefix: this.#transportDiagnosticPrefix,
      });
    } catch (error) {
      try {
        await channel.close("owned_stdio_construction_failed");
        observer.cleanupProven();
      } catch (cleanupError) {
        observer.cleanupFailed(cleanupError);
        throw cleanupError;
      }
      throw error;
    }
  }
}

const NOOP_TRANSPORT_LIFECYCLE: FramedTransportLifecycleObserver =
  Object.freeze({
    launchStarted: () => undefined,
    cleanupProven: () => undefined,
    cleanupFailed: () => undefined,
  });

export class OwnedNdjsonStdioTransport implements FramedMessageTransport {
  readonly maximumFrameBytes: number;
  readonly assurance;
  readonly frames: AsyncIterable<InboundTextFrame>;
  readonly closed: Promise<FramedTransportClosure>;

  readonly #channel: EnvironmentOwnedProcessChannel;
  readonly #limits: OwnedNdjsonStdioLimits;
  readonly #frameQueue: FrameQueue;
  readonly #sensitiveValues: readonly string[];
  readonly #retainStderr: boolean;
  readonly #diagnosticPrefix: string;
  readonly #closedResolve: (closure: FramedTransportClosure) => void;
  readonly #stdoutReader: Promise<void>;
  readonly #stderrReader: Promise<void>;
  readonly #writes: WriteEntry[] = [];
  #stdoutChunks: Buffer[] = [];
  #stdoutBufferedBytes = 0;
  #stdoutBytesRead = 0;
  #stderrDecoder = new StringDecoder("utf8");
  #stderrPending = "";
  #suppressStderrUntilNewline = false;
  #stderrBytesRead = 0;
  #inboundFramesRead = 0;
  #outboundFramesAccepted = 0;
  #outboundFramesWritten = 0;
  #streamsDrained = false;
  #processExitDisposition: OwnedNdjsonStdioDiagnostics["processExitDisposition"] =
    "not_observed";
  #stderrTail = "";
  #queuedWriteBytes = 0;
  readonly #outboundCapacityWaiters = new Set<() => void>();
  #writing = false;
  #activeWrite: WriteEntry | undefined;
  #acceptingWrites = true;
  #shutdownPromise: Promise<void> | undefined;
  #finalClosure: FramedTransportClosure | undefined;

  constructor(input: {
    readonly scope: ProviderTransportScope;
    readonly connectionGeneration: number;
    readonly channel: EnvironmentOwnedProcessChannel;
    readonly limits: OwnedNdjsonStdioLimits;
    readonly sensitiveValues: readonly string[];
    readonly retainStderr?: boolean;
    readonly assuranceDiagnosticPrefix: string;
    readonly transportDiagnosticPrefix: string;
  }) {
    this.#channel = input.channel;
    const assuranceDiagnosticPrefix = validatedDiagnosticPrefix(
      input.assuranceDiagnosticPrefix,
    );
    this.#diagnosticPrefix = validatedDiagnosticPrefix(
      input.transportDiagnosticPrefix,
    );
    this.#limits = resolvedLimits(input.limits, this.#diagnosticPrefix);
    this.maximumFrameBytes = this.#limits.maximumFrameBytes;
    this.#sensitiveValues = Object.freeze([...input.sensitiveValues]);
    this.#retainStderr = input.retainStderr ?? true;
    this.assurance = createOwnedProcessAssurance(
      input.scope,
      input.connectionGeneration,
      input.channel.identity,
      assuranceDiagnosticPrefix,
    );
    this.#frameQueue = new FrameQueue(
      this.#limits,
      `${assuranceDiagnosticPrefix}_transport_frames_already_consumed`,
    );
    this.frames = this.#frameQueue;
    let closedResolve!: (closure: FramedTransportClosure) => void;
    this.closed = new Promise((resolve) => {
      closedResolve = resolve;
    });
    this.#closedResolve = closedResolve;
    this.#stdoutReader = Promise.resolve().then(async () => this.#readStdout());
    this.#stderrReader = Promise.resolve().then(async () => this.#readStderr());
    void input.channel.closed.then(
      (closure) => {
        this.#processExitDisposition =
          closure.reason === "spawn_error"
            ? "spawn_error"
            : closure.signal !== null
              ? "signal_exit"
              : closure.exitCode === 0
                ? "zero_exit"
                : "nonzero_exit";
        if (!this.#shutdownPromise) {
          void this.#shutdown(
            "process_exit",
            closure.cause ??
              new Error(
                `${this.#diagnosticPrefix}_process_exit:${String(closure.exitCode)}:${String(closure.signal)}`,
              ),
          );
        }
      },
      (error: unknown) => {
        this.#processExitDisposition = "channel_failure";
        if (!this.#shutdownPromise) {
          void this.#shutdown(
            "process_exit",
            asError(error, this.#diagnosticPrefix),
          );
        }
      },
    );
  }

  diagnostics(): OwnedNdjsonStdioDiagnostics {
    return Object.freeze({
      stdoutBytesRead: this.#stdoutBytesRead,
      stderrBytesRead: this.#stderrBytesRead,
      inboundFramesRead: this.#inboundFramesRead,
      outboundFramesAccepted: this.#outboundFramesAccepted,
      outboundFramesWritten: this.#outboundFramesWritten,
      streamsDrained: this.#streamsDrained,
      processExitDisposition: this.#processExitDisposition,
      stderrTail: this.#stderrTail,
      stderrTailBytes: Buffer.byteLength(this.#stderrTail),
    });
  }

  send(
    text: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly disposition: "sent" }> {
    if (!this.#acceptingWrites) {
      return Promise.reject(
        new FrameWriteError(`${this.#diagnosticPrefix}_closed`, "not_sent"),
      );
    }
    if (text.length === 0 || text.includes("\n") || text.includes("\r")) {
      return Promise.reject(
        new FrameWriteError(
          `${this.#diagnosticPrefix}_frame_invalid`,
          "not_sent",
        ),
      );
    }
    const payloadByteLength = Buffer.byteLength(text, "utf8");
    if (payloadByteLength > this.#limits.maximumFrameBytes) {
      return Promise.reject(
        new FrameWriteError(
          `${this.#diagnosticPrefix}_outbound_limit`,
          "not_sent",
        ),
      );
    }
    if (options?.signal?.aborted) {
      return Promise.reject(
        new FrameWriteError(
          `${this.#diagnosticPrefix}_send_aborted`,
          "not_sent",
          {
            cause: options.signal.reason,
          },
        ),
      );
    }
    return this.#admitWrite(text, payloadByteLength, options?.signal);
  }

  async #admitWrite(
    text: string,
    payloadByteLength: number,
    signal?: AbortSignal,
  ): Promise<{ readonly disposition: "sent" }> {
    while (
      this.#acceptingWrites &&
      (this.#writes.length >= this.#limits.maximumOutboundQueueFrames ||
        this.#queuedWriteBytes + payloadByteLength >
          this.#limits.maximumOutboundQueueBytes)
    ) {
      await this.#waitForOutboundCapacity(signal);
      if (signal?.aborted) {
        throw new FrameWriteError(
          `${this.#diagnosticPrefix}_send_aborted`,
          "not_sent",
          { cause: signal.reason },
        );
      }
    }
    if (!this.#acceptingWrites) {
      throw new FrameWriteError(`${this.#diagnosticPrefix}_closed`, "not_sent");
    }
    if (signal?.aborted) {
      throw new FrameWriteError(
        `${this.#diagnosticPrefix}_send_aborted`,
        "not_sent",
        { cause: signal.reason },
      );
    }
    const bytes = Buffer.from(`${text}\n`, "utf8");
    return await new Promise((resolve, reject) => {
      this.#outboundFramesAccepted = saturatingAdd(
        this.#outboundFramesAccepted,
        1,
      );
      const entry: WriteEntry = {
        bytes,
        payloadByteLength,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        cancelled: false,
        settled: false,
        started: false,
      };
      this.#queuedWriteBytes += payloadByteLength;
      this.#writes.push(entry);
      if (entry.signal) {
        entry.abortListener = () => {
          if (entry.cancelled || entry.settled) return;
          if (entry.started) {
            const error = new FrameWriteError(
              `${this.#diagnosticPrefix}_send_aborted_during_write`,
              "sent_outcome_unknown",
              { cause: entry.signal?.reason },
            );
            settleWriteReject(entry, error);
            void this.#shutdown("active_write_aborted", error);
            return;
          }
          entry.cancelled = true;
          const queuedIndex = this.#writes.indexOf(entry);
          if (queuedIndex >= 0) this.#writes.splice(queuedIndex, 1);
          this.#queuedWriteBytes -= entry.payloadByteLength;
          this.#releaseOutboundCapacityWaiters();
          if (entry.abortListener) {
            entry.signal?.removeEventListener("abort", entry.abortListener);
          }
          settleWriteReject(
            entry,
            new FrameWriteError(
              `${this.#diagnosticPrefix}_send_aborted`,
              "not_sent",
              {
                cause: entry.signal?.reason,
              },
            ),
          );
        };
        entry.signal.addEventListener("abort", entry.abortListener, {
          once: true,
        });
        if (entry.signal.aborted) entry.abortListener();
      }
      if (!entry.cancelled) void this.#pumpWrites();
    });
  }

  async #waitForOutboundCapacity(signal?: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const finish = () => {
        signal?.removeEventListener("abort", finish);
        this.#outboundCapacityWaiters.delete(finish);
        resolve();
      };
      this.#outboundCapacityWaiters.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
      if (signal?.aborted || !this.#acceptingWrites) finish();
    });
  }

  #releaseOutboundCapacityWaiters(): void {
    for (const resolve of this.#outboundCapacityWaiters) resolve();
    this.#outboundCapacityWaiters.clear();
  }

  async close(reason: string): Promise<void> {
    await this.#shutdown(reason);
    const closure = this.#finalClosure ?? (await this.closed);
    if (
      closure.reason === "orphaned_process_group" ||
      closure.reason === "process_cleanup_failed"
    ) {
      throw new Error(closure.reason, {
        ...(closure.cause ? { cause: closure.cause } : {}),
      });
    }
  }

  async #readStdout(): Promise<void> {
    try {
      for await (const chunk of this.#channel.stdout) {
        this.#stdoutBytesRead = saturatingAdd(
          this.#stdoutBytesRead,
          chunk.byteLength,
        );
        await this.#receiveStdout(Buffer.from(chunk));
      }
      if (this.#stdoutBufferedBytes > 0) {
        void this.#shutdown(
          "stdout_partial_frame",
          new Error(`${this.#diagnosticPrefix}_partial_frame`),
        );
      }
    } catch (error) {
      void this.#shutdown(
        "stdout_error",
        asError(error, this.#diagnosticPrefix),
      );
    }
  }

  async #readStderr(): Promise<void> {
    try {
      for await (const chunk of this.#channel.stderr) {
        this.#stderrBytesRead = saturatingAdd(
          this.#stderrBytesRead,
          chunk.byteLength,
        );
        this.#receiveStderr(this.#stderrDecoder.write(Buffer.from(chunk)));
      }
      this.#receiveStderr(this.#stderrDecoder.end(), true);
    } catch (error) {
      void this.#shutdown(
        "stderr_error",
        asError(error, this.#diagnosticPrefix),
      );
    }
  }

  async #receiveStdout(chunk: Buffer): Promise<void> {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline < 0 ? chunk.byteLength : newline;
      if (end > offset) {
        const part = chunk.subarray(offset, end);
        this.#stdoutChunks.push(part);
        this.#stdoutBufferedBytes += part.byteLength;
      }
      if (newline < 0) break;
      let frame =
        this.#stdoutChunks.length === 1
          ? this.#stdoutChunks[0]!
          : Buffer.concat(this.#stdoutChunks, this.#stdoutBufferedBytes);
      this.#stdoutChunks = [];
      this.#stdoutBufferedBytes = 0;
      offset = newline + 1;
      this.#inboundFramesRead = saturatingAdd(this.#inboundFramesRead, 1);
      if (frame.at(-1) === 0x0d) frame = frame.subarray(0, -1);
      if (
        frame.byteLength === 0 ||
        frame.byteLength > this.#limits.maximumFrameBytes
      ) {
        void this.#shutdown(
          "invalid_stdout_frame",
          new Error(`${this.#diagnosticPrefix}_invalid_frame_size`),
        );
        return;
      }
      try {
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(frame);
        await this.#frameQueue.push({
          text: decoded,
          byteLength: frame.byteLength,
        });
      } catch (error) {
        void this.#shutdown(
          "invalid_inbound_frame",
          asError(error, this.#diagnosticPrefix),
        );
        return;
      }
    }
    if (this.#stdoutBufferedBytes > this.#limits.maximumFrameBytes) {
      void this.#shutdown(
        "oversized_stdout_frame",
        new Error(`${this.#diagnosticPrefix}_inbound_frame_too_large`),
      );
    }
  }

  async #pumpWrites(): Promise<void> {
    if (this.#writing) return;
    this.#writing = true;
    try {
      while (this.#acceptingWrites) {
        const entry = this.#writes.shift();
        if (!entry) break;
        this.#releaseOutboundCapacityWaiters();
        if (entry.cancelled) continue;
        entry.started = true;
        this.#activeWrite = entry;
        this.#queuedWriteBytes -= entry.payloadByteLength;
        try {
          await this.#channel.writeStdin(entry.bytes, {
            ...(entry.signal ? { signal: entry.signal } : {}),
          });
          this.#outboundFramesWritten = saturatingAdd(
            this.#outboundFramesWritten,
            1,
          );
          settleWriteResolve(entry);
        } catch (error) {
          const delivery =
            error instanceof EnvironmentProcessWriteError
              ? error.delivery
              : "sent_outcome_unknown";
          const writeError = new FrameWriteError(
            `${this.#diagnosticPrefix}_write_failed`,
            delivery,
            { cause: error },
          );
          settleWriteReject(entry, writeError);
          void this.#shutdown("stdin_error", writeError);
          break;
        } finally {
          if (entry.abortListener) {
            entry.signal!.removeEventListener("abort", entry.abortListener);
          }
          if (this.#activeWrite === entry) this.#activeWrite = undefined;
        }
      }
    } finally {
      this.#writing = false;
    }
  }

  #appendStderr(value: string): void {
    if (!value) return;
    const redacted = redact(value, this.#sensitiveValues);
    const combined = Buffer.from(`${this.#stderrTail}${redacted}`, "utf8");
    const bounded =
      combined.byteLength <= this.#limits.maximumStderrTailBytes
        ? combined
        : combined.subarray(
            combined.byteLength - this.#limits.maximumStderrTailBytes,
          );
    this.#stderrTail = bounded.toString("utf8");
  }

  #receiveStderr(value: string, ended = false): void {
    if (!this.#retainStderr) return;
    if (this.#suppressStderrUntilNewline) {
      const newline = value.indexOf("\n");
      if (newline < 0) return;
      this.#suppressStderrUntilNewline = false;
      value = value.slice(newline + 1);
    }
    this.#stderrPending += value;
    while (true) {
      const newline = this.#stderrPending.indexOf("\n");
      if (newline < 0) break;
      const completeLine = this.#stderrPending.slice(0, newline + 1);
      this.#stderrPending = this.#stderrPending.slice(newline + 1);
      this.#appendStderr(completeLine);
    }
    if (
      Buffer.byteLength(this.#stderrPending, "utf8") >
      this.#limits.maximumStderrTailBytes
    ) {
      this.#appendStderr("[REDACTED]\n");
      this.#stderrPending = "";
      this.#suppressStderrUntilNewline = true;
    } else if (ended && this.#stderrPending) {
      this.#appendStderr(this.#stderrPending);
      this.#stderrPending = "";
    }
  }

  #shutdown(reason: string, cause?: Error): Promise<void> {
    this.#shutdownPromise ??= this.#performShutdown(reason, cause);
    return this.#shutdownPromise;
  }

  async #performShutdown(reason: string, cause?: Error): Promise<void> {
    try {
      this.#acceptingWrites = false;
      this.#releaseOutboundCapacityWaiters();
      if (this.#activeWrite) {
        settleWriteReject(
          this.#activeWrite,
          new FrameWriteError(
            `${this.#diagnosticPrefix}_closed_during_write`,
            "sent_outcome_unknown",
          ),
        );
      }
      this.#rejectQueuedWrites();
      // Release a stdout reader paused at the inbound queue watermark before
      // joining it. During bounded shutdown the process may still emit final
      // protocol frames, so retain those frames instead of closing the queue
      // until both stream readers have drained.
      this.#frameQueue.beginProducerShutdown();
      await this.#channel.close(reason);
      await Promise.all([this.#stdoutReader, this.#stderrReader]);
      this.#streamsDrained = true;
    } catch (error) {
      cause ??= asError(error, this.#diagnosticPrefix);
      reason = isCleanupUncertainty(error)
        ? "orphaned_process_group"
        : "process_cleanup_failed";
    } finally {
      this.#frameQueue.close(cause);
      revokeFramedTransportAssurance(this.assurance);
      const closure = { reason, ...(cause ? { cause } : {}) };
      this.#finalClosure = closure;
      this.#closedResolve(closure);
    }
  }

  #rejectQueuedWrites(): void {
    for (const entry of this.#writes.splice(0)) {
      if (entry.cancelled) continue;
      entry.cancelled = true;
      if (entry.abortListener) {
        entry.signal!.removeEventListener("abort", entry.abortListener);
      }
      settleWriteReject(
        entry,
        new FrameWriteError(`${this.#diagnosticPrefix}_closed`, "not_sent"),
      );
    }
    this.#queuedWriteBytes = 0;
    this.#releaseOutboundCapacityWaiters();
  }
}

class FrameQueue implements AsyncIterable<InboundTextFrame> {
  readonly #limits: OwnedNdjsonStdioLimits;
  readonly #alreadyConsumedCode: string;
  readonly #values: InboundTextFrame[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<InboundTextFrame>) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  readonly #capacityWaiters = new Set<() => void>();
  #queuedBytes = 0;
  #producerShuttingDown = false;
  #closed = false;
  #error: Error | undefined;
  #iteratorCreated = false;

  constructor(limits: OwnedNdjsonStdioLimits, alreadyConsumedCode: string) {
    this.#limits = limits;
    this.#alreadyConsumedCode = alreadyConsumedCode;
  }

  async push(frame: InboundTextFrame): Promise<void> {
    while (
      !this.#closed &&
      !this.#producerShuttingDown &&
      this.#atCapacity(frame)
    ) {
      await new Promise<void>((resolve) => {
        this.#capacityWaiters.add(resolve);
      });
    }
    if (this.#closed) return;
    // Cleanup must not deadlock behind a consumer that has already stopped,
    // but it also must not turn shutdown into an unbounded retention window.
    // Drop only a frame that still cannot fit after shutdown releases the
    // producer; final frames that fit remain drainable through the iterator.
    if (this.#producerShuttingDown && this.#atCapacity(frame)) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ value: frame, done: false });
      return;
    }
    this.#values.push(frame);
    this.#queuedBytes += frame.byteLength;
  }

  close(error?: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    this.#releaseCapacityWaiters();
    if (error) {
      this.#values.splice(0);
      this.#queuedBytes = 0;
    }
    for (const waiter of this.#waiters.splice(0)) {
      if (error) waiter.reject(error);
      else waiter.resolve({ value: undefined, done: true });
    }
  }

  beginProducerShutdown(): void {
    this.#producerShuttingDown = true;
    this.#releaseCapacityWaiters();
  }

  [Symbol.asyncIterator](): AsyncIterator<InboundTextFrame> {
    if (this.#iteratorCreated) {
      throw new Error(this.#alreadyConsumedCode);
    }
    this.#iteratorCreated = true;
    return {
      next: async () => {
        const value = this.#values.shift();
        if (value) {
          this.#queuedBytes -= value.byteLength;
          this.#releaseCapacityWaiters();
          return { value, done: false };
        }
        if (this.#closed) {
          if (this.#error) throw this.#error;
          return { value: undefined, done: true };
        }
        return await new Promise((resolve, reject) => {
          this.#waiters.push({ resolve, reject });
        });
      },
    };
  }

  #atCapacity(frame: InboundTextFrame): boolean {
    return (
      this.#values.length >= this.#limits.maximumInboundQueueFrames ||
      this.#queuedBytes + frame.byteLength >
        this.#limits.maximumInboundQueueBytes
    );
  }

  #releaseCapacityWaiters(): void {
    for (const resolve of this.#capacityWaiters) resolve();
    this.#capacityWaiters.clear();
  }
}

function resolvedLimits(
  overrides: Partial<OwnedNdjsonStdioLimits> | undefined,
  diagnosticPrefix: string,
): OwnedNdjsonStdioLimits {
  const limits = Object.freeze({
    ...DEFAULT_OWNED_NDJSON_STDIO_LIMITS,
    ...overrides,
  });
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${diagnosticPrefix}_limits_invalid`);
    }
  }
  if (
    limits.maximumInboundQueueBytes < limits.maximumFrameBytes ||
    limits.maximumOutboundQueueBytes < limits.maximumFrameBytes
  ) {
    throw new Error(`${diagnosticPrefix}_limits_invalid`);
  }
  return limits;
}

function saturatingAdd(current: number, increment: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

function redact(value: string, sensitiveValues: readonly string[]): string {
  let redacted = value;
  for (const sensitive of sensitiveValues) {
    if (sensitive) redacted = redacted.replaceAll(sensitive, "[REDACTED]");
  }
  return redacted
    .replace(/Bearer\s+[^\s"',}]+/giu, "Bearer [REDACTED]")
    .replace(
      /((?:access|auth)[_-]?token|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"',}]+/giu,
      "$1$2[REDACTED]",
    );
}

function isCleanupUncertainty(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "environment_owned_process_group_survived" ||
      error.message === "orphaned_process_group" ||
      error.message === "windows_job_open_cleanup_unconfirmed" ||
      error.message === "windows_job_cleanup_unconfirmed" ||
      error.message === "windows_job_close_deadline_exceeded")
  );
}

function asError(error: unknown, diagnosticPrefix: string): Error {
  return error instanceof Error
    ? error
    : new Error(`${diagnosticPrefix}_error`);
}

function validatedDiagnosticPrefix(prefix: string): string {
  if (!/^[a-z][a-z0-9_]{0,63}$/u.test(prefix)) {
    throw new Error("provider_transport_diagnostic_prefix_invalid");
  }
  return prefix;
}

function settleWriteResolve(entry: WriteEntry): void {
  if (entry.settled) return;
  entry.settled = true;
  entry.resolve({ disposition: "sent" });
}

function settleWriteReject(entry: WriteEntry, error: Error): void {
  if (entry.settled) return;
  entry.settled = true;
  entry.reject(error);
}
