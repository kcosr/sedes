import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import WebSocket, { type RawData } from "ws";
import { type EnvironmentExternalByteStreamChannel } from "../../execution/environment-channel.js";
import {
  FrameWriteError,
  FramedTransportOpenError,
  type ExternalFramedConnection,
  type FramedTransportClosure,
  type InboundTextFrame,
} from "./assured-framed-transport.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "./framed-message-limits.js";

export interface WebSocketFramedLimits {
  readonly maximumFrameBytes: number;
  readonly maximumInboundQueueBytes: number;
  readonly maximumInboundQueueFrames: number;
  readonly maximumOutboundQueueBytes: number;
  readonly maximumOutboundQueueFrames: number;
  readonly handshakeTimeoutMilliseconds: number;
  readonly clientCloseTimeoutMilliseconds: number;
}

export const DEFAULT_WEBSOCKET_FRAMED_LIMITS: WebSocketFramedLimits =
  Object.freeze({
    maximumFrameBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
    maximumInboundQueueBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
    maximumInboundQueueFrames: 256,
    maximumOutboundQueueBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
    maximumOutboundQueueFrames: 256,
    handshakeTimeoutMilliseconds: 5_000,
    clientCloseTimeoutMilliseconds: 1_000,
  });

export interface WebSocketHandshakePolicy {
  /** Provider-private safe prefix; never an endpoint or credential. */
  readonly errorCodePrefix: string;
  /** Used only to construct the Upgrade request above the assured byte stream. */
  readonly requestUrl: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** Safe carrier cleanup reason; never an endpoint or credential. */
  readonly bridgeDestroyReason: string;
  classifyHandshakeError(error: Error & { readonly code?: string }): Error;
  classifyUnexpectedResponse(response: IncomingMessage): Error;
}

type OutboundEntry = {
  readonly text: string;
  readonly byteLength: number;
  readonly resolve: (value: { readonly disposition: "sent" }) => void;
  readonly reject: (error: Error) => void;
  readonly signal?: AbortSignal;
  abortListener?: () => void;
  started: boolean;
  settled: boolean;
  cancelled: boolean;
};

type ExtendedClientOptions = WebSocket.ClientOptions & {
  readonly maxBufferedChunks: number;
  readonly maxFragments: number;
};

/**
 * One shared RFC 6455 carrier for UDS, TCP, and TLS byte channels. The
 * execution environment owns stream establishment and identity; this class
 * owns only HTTP Upgrade, WebSocket messages, queues, and client cleanup.
 */
export class WebSocketFramedConnection implements ExternalFramedConnection {
  readonly maximumFrameBytes: number;
  readonly frames: AsyncIterable<InboundTextFrame>;
  readonly closed: Promise<FramedTransportClosure>;
  readonly #channel: EnvironmentExternalByteStreamChannel;
  readonly #bridge: EnvironmentChannelDuplex;
  readonly #websocket: WebSocket;
  readonly #limits: WebSocketFramedLimits;
  readonly #errorCodePrefix: string;
  readonly #classifyHandshakeError: WebSocketHandshakePolicy["classifyHandshakeError"];
  readonly #classifyUnexpectedResponse: WebSocketHandshakePolicy["classifyUnexpectedResponse"];
  readonly #inbound: InboundFrameQueue;
  readonly #resolveClosed: (closure: FramedTransportClosure) => void;
  readonly #outbound: OutboundEntry[] = [];
  readonly #outboundCapacityWaiters = new Set<() => void>();
  #queuedOutboundBytes = 0;
  #activeOutbound: OutboundEntry | undefined;
  #acceptingSends = true;
  #closedSettled = false;
  #closePromise: Promise<void> | undefined;

  constructor(input: {
    readonly channel: EnvironmentExternalByteStreamChannel;
    readonly limits: WebSocketFramedLimits;
    readonly policy: WebSocketHandshakePolicy;
  }) {
    const errorCodePrefix = validatedSafeCode(
      input.policy.errorCodePrefix,
      "provider_websocket_error_code_prefix_invalid",
    );
    const bridgeDestroyReason = validatedSafeCode(
      input.policy.bridgeDestroyReason,
      "provider_websocket_bridge_destroy_reason_invalid",
    );
    const limits = resolveWebSocketFramedLimits(input.limits, errorCodePrefix);
    this.#channel = input.channel;
    this.#limits = limits;
    this.maximumFrameBytes = limits.maximumFrameBytes;
    this.#errorCodePrefix = errorCodePrefix;
    this.#classifyHandshakeError = input.policy.classifyHandshakeError;
    this.#classifyUnexpectedResponse = input.policy.classifyUnexpectedResponse;
    this.#inbound = new InboundFrameQueue(limits, (paused) => {
      if (paused) this.#websocket.pause();
      else this.#websocket.resume();
    });
    this.frames = this.#inbound;
    let resolveClosed!: (closure: FramedTransportClosure) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
    this.#bridge = new EnvironmentChannelDuplex(
      input.channel,
      bridgeDestroyReason,
    );
    const options: ExtendedClientOptions = {
      createConnection: (() =>
        this.#bridge as unknown as Socket) as NonNullable<
        WebSocket.ClientOptions["createConnection"]
      >,
      followRedirects: false,
      handshakeTimeout: limits.handshakeTimeoutMilliseconds,
      perMessageDeflate: false,
      autoPong: true,
      allowSynchronousEvents: false,
      maxPayload: limits.maximumFrameBytes,
      maxBufferedChunks: limits.maximumInboundQueueFrames,
      maxFragments: 1,
      skipUTF8Validation: false,
      ...(input.policy.headers ? { headers: input.policy.headers } : {}),
    };
    this.#websocket = new WebSocket(input.policy.requestUrl, options);
    this.#websocket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.#fail(`${this.#errorCodePrefix}_binary_message`);
        return;
      }
      const bytes = rawDataBuffer(data);
      if (
        bytes.byteLength === 0 ||
        bytes.byteLength > limits.maximumFrameBytes
      ) {
        this.#fail(`${this.#errorCodePrefix}_frame_limit`);
        return;
      }
      try {
        this.#inbound.push({
          text: bytes.toString("utf8"),
          byteLength: bytes.byteLength,
        });
      } catch {
        this.#fail(`${this.#errorCodePrefix}_inbound_queue_limit`);
      }
    });
    // Keep a permanent error listener: EventEmitter treats an unhandled error
    // as fatal even after the one-shot opening listener has been removed.
    this.#websocket.on("error", () => {
      if (this.#websocket.readyState === WebSocket.OPEN) {
        this.#fail(`${this.#errorCodePrefix}_connection_error`);
      }
    });
    this.#websocket.once("close", () => {
      this.#settleClosed("external_peer_closed");
    });
    void input.channel.closed.then(
      (closure) => {
        this.#settleClosed(
          closure.reason === "client_closed"
            ? "external_client_closed"
            : "external_peer_closed",
        );
      },
      () => {
        this.#fail(`${this.#errorCodePrefix}_connection_error`);
      },
    );
  }

  async waitUntilOpen(signal: AbortSignal): Promise<void> {
    if (this.#websocket.readyState === WebSocket.OPEN) return;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const handshakeDeadline = setTimeout(() => {
        this.destroyClient(`${this.#errorCodePrefix}_handshake_timeout`);
        finish(
          new FramedTransportOpenError(
            `${this.#errorCodePrefix}_unavailable`,
            false,
          ),
        );
      }, this.#limits.handshakeTimeoutMilliseconds);
      handshakeDeadline.unref();
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(handshakeDeadline);
        signal.removeEventListener("abort", aborted);
        this.#websocket.removeListener("open", opened);
        this.#websocket.removeListener("error", failed);
        this.#websocket.removeListener("unexpected-response", rejected);
        this.#websocket.removeListener("close", closed);
        if (error) reject(error);
        else resolve();
      };
      const opened = () => finish();
      const aborted = () => {
        this.destroyClient(`${this.#errorCodePrefix}_open_aborted`);
        finish(asError(signal.reason, `${this.#errorCodePrefix}_open_aborted`));
      };
      const failed = (error: Error & { readonly code?: string }) =>
        finish(this.#classifyHandshakeError(error));
      const rejected = (_request: unknown, response: IncomingMessage) => {
        const failure = this.#classifyUnexpectedResponse(response);
        response.destroy();
        finish(failure);
      };
      const closed = () =>
        finish(
          new FramedTransportOpenError(
            `${this.#errorCodePrefix}_unavailable`,
            false,
          ),
        );
      signal.addEventListener("abort", aborted, { once: true });
      this.#websocket.once("open", opened);
      this.#websocket.once("error", failed);
      this.#websocket.once("unexpected-response", rejected);
      this.#websocket.once("close", closed);
      if (signal.aborted) aborted();
    });
  }

  send(
    text: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<{ readonly disposition: "sent" }> {
    const prefix = this.#errorCodePrefix;
    const byteLength = Buffer.byteLength(text, "utf8");
    if (
      !this.#acceptingSends ||
      this.#websocket.readyState !== WebSocket.OPEN
    ) {
      return Promise.reject(
        new FrameWriteError(`${prefix}_closed`, "not_sent"),
      );
    }
    if (byteLength === 0 || byteLength > this.#limits.maximumFrameBytes) {
      return Promise.reject(
        new FrameWriteError(`${prefix}_outbound_limit`, "not_sent"),
      );
    }
    if (options?.signal?.aborted) {
      return Promise.reject(
        new FrameWriteError(`${prefix}_send_aborted`, "not_sent"),
      );
    }
    return this.#admitOutbound(text, byteLength, options?.signal);
  }

  async #admitOutbound(
    text: string,
    byteLength: number,
    signal?: AbortSignal,
  ): Promise<{ readonly disposition: "sent" }> {
    while (
      this.#acceptingSends &&
      this.#websocket.readyState === WebSocket.OPEN &&
      (this.#outbound.length >= this.#limits.maximumOutboundQueueFrames ||
        this.#queuedOutboundBytes + byteLength >
          this.#limits.maximumOutboundQueueBytes)
    ) {
      await this.#waitForOutboundCapacity(signal);
      if (signal?.aborted) {
        throw new FrameWriteError(
          `${this.#errorCodePrefix}_send_aborted`,
          "not_sent",
        );
      }
    }
    if (
      !this.#acceptingSends ||
      this.#websocket.readyState !== WebSocket.OPEN
    ) {
      throw new FrameWriteError(`${this.#errorCodePrefix}_closed`, "not_sent");
    }
    if (signal?.aborted) {
      throw new FrameWriteError(
        `${this.#errorCodePrefix}_send_aborted`,
        "not_sent",
      );
    }
    return await new Promise((resolve, reject) => {
      const entry: OutboundEntry = {
        text,
        byteLength,
        resolve,
        reject,
        ...(signal ? { signal } : {}),
        started: false,
        settled: false,
        cancelled: false,
      };
      this.#outbound.push(entry);
      this.#queuedOutboundBytes += byteLength;
      if (entry.signal) {
        entry.abortListener = () => this.#abortOutbound(entry);
        entry.signal.addEventListener("abort", entry.abortListener, {
          once: true,
        });
        if (entry.signal.aborted) entry.abortListener();
      }
      if (!entry.cancelled) this.#pumpOutbound();
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
      if (
        signal?.aborted ||
        !this.#acceptingSends ||
        this.#websocket.readyState !== WebSocket.OPEN
      ) {
        finish();
      }
    });
  }

  #releaseOutboundCapacityWaiters(): void {
    for (const resolve of this.#outboundCapacityWaiters) resolve();
    this.#outboundCapacityWaiters.clear();
  }

  closeClient(reason: string): Promise<void> {
    this.#closePromise ??= this.#performClose(reason);
    return this.#closePromise;
  }

  destroyClient(_reason: string): void {
    this.#acceptingSends = false;
    this.#releaseOutboundCapacityWaiters();
    this.#rejectOutbound();
    if (this.#websocket.readyState !== WebSocket.CLOSED) {
      this.#websocket.terminate();
    }
    this.#bridge.destroy();
    this.#channel.destroyClient(`${this.#errorCodePrefix}_client_destroyed`);
  }

  async #performClose(_reason: string): Promise<void> {
    this.#acceptingSends = false;
    this.#releaseOutboundCapacityWaiters();
    this.#rejectOutbound();
    if (this.#websocket.readyState === WebSocket.OPEN) {
      this.#websocket.close(1000);
    } else if (this.#websocket.readyState === WebSocket.CONNECTING) {
      this.#websocket.terminate();
    }
    const graceful = await waitForPromise(
      this.closed,
      this.#limits.clientCloseTimeoutMilliseconds,
    );
    if (!graceful) {
      this.#websocket.terminate();
      this.#bridge.destroy();
      this.#channel.destroyClient(
        `${this.#errorCodePrefix}_client_close_deadline`,
      );
      if (
        !(await waitForPromise(
          this.closed,
          this.#limits.clientCloseTimeoutMilliseconds,
        ))
      ) {
        throw new Error(
          `${this.#errorCodePrefix}_client_close_deadline_exceeded`,
        );
      }
    }
    const channelClosed = await waitForPromise(
      this.#channel.closeClient(`${this.#errorCodePrefix}_client_closed`),
      this.#limits.clientCloseTimeoutMilliseconds,
    );
    if (!channelClosed) {
      this.#channel.destroyClient(
        `${this.#errorCodePrefix}_channel_close_deadline`,
      );
      throw new Error(
        `${this.#errorCodePrefix}_channel_close_deadline_exceeded`,
      );
    }
  }

  #pumpOutbound(): void {
    if (this.#activeOutbound || !this.#acceptingSends) return;
    while (this.#outbound.length > 0) {
      const entry = this.#outbound.shift()!;
      this.#releaseOutboundCapacityWaiters();
      if (entry.cancelled || entry.settled) continue;
      this.#activeOutbound = entry;
      entry.started = true;
      if (this.#websocket.readyState !== WebSocket.OPEN) {
        this.#finishOutbound(
          entry,
          new FrameWriteError(
            `${this.#errorCodePrefix}_outbound_unavailable`,
            "not_sent",
          ),
        );
        continue;
      }
      try {
        this.#websocket.send(
          entry.text,
          { binary: false, compress: false, fin: true },
          (error) => {
            if (error) {
              this.#retireAfterActiveSendFailure(
                entry,
                new FrameWriteError(
                  `${this.#errorCodePrefix}_send_failed`,
                  "sent_outcome_unknown",
                ),
                `${this.#errorCodePrefix}_send_failed`,
              );
            } else {
              this.#finishOutbound(entry);
            }
          },
        );
      } catch {
        this.#retireAfterActiveSendFailure(
          entry,
          new FrameWriteError(
            `${this.#errorCodePrefix}_send_failed`,
            "sent_outcome_unknown",
          ),
          `${this.#errorCodePrefix}_send_failed`,
        );
      }
      return;
    }
  }

  #abortOutbound(entry: OutboundEntry): void {
    if (entry.settled || entry.cancelled) return;
    entry.cancelled = true;
    const error = new FrameWriteError(
      `${this.#errorCodePrefix}_send_aborted`,
      entry.started ? "sent_outcome_unknown" : "not_sent",
    );
    if (entry.started) {
      this.#retireAfterActiveSendFailure(
        entry,
        error,
        `${this.#errorCodePrefix}_send_aborted`,
      );
    } else {
      this.#finishOutbound(entry, error);
    }
  }

  #retireAfterActiveSendFailure(
    entry: OutboundEntry,
    error: FrameWriteError,
    reason: string,
  ): void {
    this.#acceptingSends = false;
    this.#finishOutbound(entry, error);
    this.#rejectOutbound();
    this.destroyClient(reason);
  }

  #finishOutbound(entry: OutboundEntry, error?: Error): void {
    if (entry.settled) return;
    entry.settled = true;
    const queuedIndex = this.#outbound.indexOf(entry);
    if (queuedIndex >= 0) this.#outbound.splice(queuedIndex, 1);
    if (entry.abortListener) {
      entry.signal?.removeEventListener("abort", entry.abortListener);
    }
    this.#queuedOutboundBytes -= entry.byteLength;
    this.#releaseOutboundCapacityWaiters();
    if (this.#activeOutbound === entry) this.#activeOutbound = undefined;
    if (error) entry.reject(error);
    else entry.resolve({ disposition: "sent" });
    this.#pumpOutbound();
  }

  #rejectOutbound(): void {
    const active = this.#activeOutbound;
    if (active) {
      this.#finishOutbound(
        active,
        new FrameWriteError(
          `${this.#errorCodePrefix}_connection_lost`,
          "sent_outcome_unknown",
        ),
      );
    }
    for (const entry of this.#outbound.splice(0)) {
      this.#finishOutbound(
        entry,
        new FrameWriteError(
          `${this.#errorCodePrefix}_connection_lost`,
          "not_sent",
        ),
      );
    }
  }

  #fail(reason: string): void {
    if (this.#closedSettled) return;
    this.destroyClient(reason);
    this.#settleClosed(reason, new Error(reason));
  }

  #settleClosed(reason: string, cause?: Error): void {
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    this.#acceptingSends = false;
    this.#releaseOutboundCapacityWaiters();
    this.#rejectOutbound();
    if (cause) this.#inbound.discardAndEnd();
    else this.#inbound.end();
    this.#resolveClosed(Object.freeze({ reason, ...(cause ? { cause } : {}) }));
  }
}

class EnvironmentChannelDuplex extends Duplex {
  readonly #channel: EnvironmentExternalByteStreamChannel;
  readonly #iterator: AsyncIterator<Uint8Array>;
  readonly #destroyReason: string;
  #reading = false;
  #timeoutMilliseconds = 0;
  #timeout: NodeJS.Timeout | undefined;

  constructor(
    channel: EnvironmentExternalByteStreamChannel,
    destroyReason: string,
  ) {
    super({ allowHalfOpen: false });
    this.#channel = channel;
    this.#iterator = channel.bytes[Symbol.asyncIterator]();
    this.#destroyReason = destroyReason;
  }

  override _read(): void {
    if (this.#reading) return;
    this.#reading = true;
    void this.#pumpReads();
  }

  override _write(
    chunk: Buffer | string | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#resetTimeout();
    const bytes =
      typeof chunk === "string"
        ? Buffer.from(chunk, encoding)
        : Buffer.from(chunk);
    void this.#channel.write(bytes).then(
      () => callback(),
      (error) => callback(asError(error, "environment_channel_write_failed")),
    );
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = undefined;
    this.#channel.destroyClient(this.#destroyReason);
    void this.#iterator.return?.();
    callback(error);
  }

  setTimeout(milliseconds: number, callback?: () => void): this {
    if (callback) this.once("timeout", callback);
    this.#timeoutMilliseconds = Math.max(0, milliseconds);
    this.#resetTimeout();
    return this;
  }

  setNoDelay(_enabled?: boolean): this {
    return this;
  }

  setKeepAlive(_enabled?: boolean, _initialDelay?: number): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  async #pumpReads(): Promise<void> {
    try {
      while (!this.destroyed) {
        const result = await this.#iterator.next();
        if (result.done) {
          this.push(null);
          return;
        }
        if (this.destroyed) return;
        this.#resetTimeout();
        if (!this.push(Buffer.from(result.value))) return;
      }
    } catch (error) {
      this.destroy(asError(error, "environment_channel_read_failed"));
    } finally {
      this.#reading = false;
    }
  }

  #resetTimeout(): void {
    if (this.#timeout) clearTimeout(this.#timeout);
    this.#timeout = undefined;
    if (this.#timeoutMilliseconds === 0 || this.destroyed) return;
    this.#timeout = setTimeout(() => {
      this.#timeout = undefined;
      this.emit("timeout");
    }, this.#timeoutMilliseconds);
    this.#timeout.unref();
  }
}

class InboundFrameQueue implements AsyncIterable<InboundTextFrame> {
  readonly #limits: WebSocketFramedLimits;
  readonly #frames: InboundTextFrame[] = [];
  readonly #waiters: Array<(value: IteratorResult<InboundTextFrame>) => void> =
    [];
  readonly #capacityChanged: (paused: boolean) => void;
  #queuedBytes = 0;
  #ended = false;

  constructor(
    limits: WebSocketFramedLimits,
    capacityChanged: (paused: boolean) => void,
  ) {
    this.#limits = limits;
    this.#capacityChanged = capacityChanged;
  }

  push(frame: InboundTextFrame): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ done: false, value: frame });
      return;
    }
    if (
      this.#frames.length >= this.#limits.maximumInboundQueueFrames ||
      this.#queuedBytes + frame.byteLength >
        this.#limits.maximumInboundQueueBytes
    ) {
      throw new Error("provider_websocket_inbound_queue_overflow");
    }
    this.#frames.push(frame);
    this.#queuedBytes += frame.byteLength;
    this.#capacityChanged(this.#atCapacity());
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#capacityChanged(false);
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  discardAndEnd(): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#capacityChanged(false);
    this.#frames.splice(0);
    this.#queuedBytes = 0;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<InboundTextFrame> {
    return {
      next: async () => {
        const frame = this.#frames.shift();
        if (frame) {
          this.#queuedBytes -= frame.byteLength;
          this.#capacityChanged(this.#atCapacity());
          return { done: false, value: frame };
        }
        if (this.#ended) return { done: true, value: undefined };
        return await new Promise<IteratorResult<InboundTextFrame>>(
          (resolve) => {
            this.#waiters.push(resolve);
          },
        );
      },
    };
  }

  #atCapacity(): boolean {
    return (
      this.#frames.length >= this.#limits.maximumInboundQueueFrames ||
      this.#queuedBytes >= this.#limits.maximumInboundQueueBytes
    );
  }
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
}

export function resolveWebSocketFramedLimits(
  limits: Partial<WebSocketFramedLimits> | undefined,
  diagnosticPrefix: string,
): WebSocketFramedLimits {
  const prefix = validatedSafeCode(
    diagnosticPrefix,
    "provider_websocket_error_code_prefix_invalid",
  );
  const resolved = Object.freeze({
    ...DEFAULT_WEBSOCKET_FRAMED_LIMITS,
    ...limits,
  });
  if (
    Object.values(resolved).some(
      (value) => !Number.isSafeInteger(value) || value <= 0,
    )
  ) {
    throw new Error(`${prefix}_limits_invalid`);
  }
  if (
    resolved.maximumInboundQueueBytes < resolved.maximumFrameBytes ||
    resolved.maximumOutboundQueueBytes < resolved.maximumFrameBytes
  ) {
    throw new Error(`${prefix}_limits_invalid`);
  }
  return resolved;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

async function waitForPromise(
  promise: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), milliseconds);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validatedSafeCode(value: string, invalidCode: string): string {
  if (!/^[a-z][a-z0-9_]{0,127}$/u.test(value)) throw new Error(invalidCode);
  return value;
}
