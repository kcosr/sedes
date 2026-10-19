import {
  SidecarFrameWriteError,
  SidecarTransportCleanupError,
  type SidecarByteStream,
  type SidecarFrame,
  type SidecarFrameLane,
  type SidecarFrameSendOptions,
  type SidecarFrameWriteDiagnostic,
  type SidecarFrameTransport,
  type SidecarTransportAssurance,
  type SidecarTransportClosure,
} from "./contracts.js";
import { BoundedAsyncQueue } from "./bounded-async-queue.js";
import {
  resolveSidecarProtocolLimits,
  type SidecarProtocolLimits,
} from "./limits.js";

const MAGIC = Buffer.from([0x48, 0x53, 0x43, 0x31]); // HSC1
const HEADER_BYTES = 8;

type WriteEntry = {
  readonly framed: Uint8Array;
  readonly payloadBytes: number;
  readonly signal?: AbortSignal;
  readonly settlement: boolean;
  readonly onWriteDiagnostic?: SidecarFrameSendOptions["onWriteDiagnostic"];
  readonly queuedAt?: number;
  readonly resolve: (value: { readonly disposition: "sent" }) => void;
  readonly reject: (error: Error) => void;
  abort?: () => void;
  started: boolean;
  settled: boolean;
};

/** Length-prefixed adapter for stdio, UDS, and TCP ordered byte streams. */
export class LengthPrefixedSidecarFrameTransport implements SidecarFrameTransport {
  readonly assurance: SidecarTransportAssurance;
  readonly frames: AsyncIterable<SidecarFrame>;
  readonly closed: Promise<SidecarTransportClosure>;
  readonly #stream: SidecarByteStream;
  readonly #limits: SidecarProtocolLimits;
  readonly #inbound: BoundedAsyncQueue<SidecarFrame>;
  readonly #controlWrites: WriteEntry[] = [];
  readonly #operationWrites: WriteEntry[] = [];
  readonly #resolveClosed: (closure: SidecarTransportClosure) => void;
  readonly #rejectClosed: (error: Error) => void;
  // Unparsed inbound bytes, kept as received chunks so reassembling a large
  // frame copies each byte once instead of re-concatenating per chunk.
  #pendingChunks: Buffer[] = [];
  #pendingOffset = 0;
  #pendingBytes = 0;
  #queuedWriteBytes = 0;
  #activeWrite: WriteEntry | undefined;
  #pumping = false;
  #acceptingWrites = true;
  #closePromise: Promise<void> | undefined;
  #closedSettled = false;

  constructor(input: {
    readonly assurance: SidecarTransportAssurance;
    readonly stream: SidecarByteStream;
    readonly limits?: Partial<SidecarProtocolLimits>;
  }) {
    if (
      !input.assurance.kind ||
      !Number.isSafeInteger(input.assurance.carrierGeneration) ||
      input.assurance.carrierGeneration <= 0
    ) {
      throw new Error("sidecar_transport_assurance_invalid");
    }
    this.assurance = Object.freeze({ ...input.assurance });
    this.#stream = input.stream;
    this.#limits = resolveSidecarProtocolLimits(input.limits);
    this.#inbound = new BoundedAsyncQueue({
      maximumItems: this.#limits.maximumInboundQueueFrames,
      maximumBytes: this.#limits.maximumInboundQueueBytes,
      sizeOf: (frame: SidecarFrame) => frame.bytes.byteLength,
    });
    this.frames = this.#inbound;
    let resolveClosed!: (closure: SidecarTransportClosure) => void;
    let rejectClosed!: (error: Error) => void;
    this.closed = new Promise((resolve, reject) => {
      resolveClosed = resolve;
      rejectClosed = reject;
    });
    this.#resolveClosed = resolveClosed;
    this.#rejectClosed = rejectClosed;
    void this.#read();
  }

  send(
    bytes: Uint8Array,
    options: SidecarFrameSendOptions,
  ): Promise<{ readonly disposition: "sent" }> {
    if (
      bytes.byteLength === 0 ||
      bytes.byteLength > this.#limits.maximumFrameBytes
    ) {
      return Promise.reject(
        new SidecarFrameWriteError("sidecar_frame_size_invalid", "not_sent"),
      );
    }
    if (!this.#acceptingWrites) {
      return Promise.reject(
        new SidecarFrameWriteError("sidecar_transport_closed", "not_sent"),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(
        new SidecarFrameWriteError("sidecar_frame_send_aborted", "not_sent", {
          cause: options.signal.reason,
        }),
      );
    }
    const queuedCount =
      this.#controlWrites.length +
      this.#operationWrites.length +
      (this.#activeWrite ? 1 : 0);
    const maximumFrames = options.settlement
      ? this.#limits.maximumOutboundQueueFrames +
        this.#limits.reservedSettlementQueueFrames
      : this.#limits.maximumOutboundQueueFrames;
    const maximumBytes = options.settlement
      ? this.#limits.maximumOutboundQueueBytes +
        this.#limits.reservedSettlementQueueBytes
      : this.#limits.maximumOutboundQueueBytes;
    if (
      queuedCount >= maximumFrames ||
      this.#queuedWriteBytes + bytes.byteLength > maximumBytes
    ) {
      return Promise.reject(
        new SidecarFrameWriteError("sidecar_outbound_queue_limit", "not_sent"),
      );
    }
    const framed = frameBytes(bytes);
    return new Promise((resolve, reject) => {
      const entry: WriteEntry = {
        framed,
        payloadBytes: bytes.byteLength,
        ...(options.signal ? { signal: options.signal } : {}),
        settlement: options.settlement === true,
        ...(options.onWriteDiagnostic ? { onWriteDiagnostic: options.onWriteDiagnostic, queuedAt: performance.now() } : {}),
        resolve,
        reject,
        started: false,
        settled: false,
      };
      if (entry.signal) {
        entry.abort = () => this.#abortWrite(entry);
        entry.signal.addEventListener("abort", entry.abort, { once: true });
      }
      this.#queuedWriteBytes += entry.payloadBytes;
      (options.lane === "control"
        ? this.#controlWrites
        : this.#operationWrites
      ).push(entry);
      this.#diagnoseWrite(entry, "queued", 0);
      void this.#pumpWrites();
    });
  }

  close(reason: string): Promise<void> {
    if (!this.#closePromise && this.#closedSettled) {
      this.#closePromise = this.closed.then(() => undefined);
    }
    this.#closePromise ??= this.#performClose(reason);
    return this.#closePromise;
  }

  diagnosticSnapshot(): Readonly<{ queuedWriteBytes: number; queuedWriteFrames: number; activeWriteBytes: number }> {
    return { queuedWriteBytes: this.#queuedWriteBytes,
      queuedWriteFrames: this.#controlWrites.filter(entry => !entry.settled).length + this.#operationWrites.filter(entry => !entry.settled).length,
      activeWriteBytes: this.#activeWrite?.payloadBytes ?? 0 };
  }

  #diagnoseWrite(entry: WriteEntry, stage: SidecarFrameWriteDiagnostic["stage"], durationMs: number): void {
    if (!entry.onWriteDiagnostic) return;
    try { entry.onWriteDiagnostic({ stage, ...this.diagnosticSnapshot(), frameBytes: entry.payloadBytes, durationMs }); }
    catch { /* Observations cannot affect frame ordering, cancellation or cleanup. */ }
  }

  async #read(): Promise<void> {
    try {
      for await (const chunk of this.#stream.bytes) {
        if (this.#closedSettled) continue;
        this.#appendChunk(chunk);
        // Frames are handed over one at a time and the byte stream is not read
        // again until every complete frame fits the inbound queue, so a carrier
        // read that coalesces many small frames applies backpressure instead of
        // overflowing the queue.
        for (let frame = this.#takeFrame(); frame; frame = this.#takeFrame()) {
          await this.#inbound.push({ bytes: frame });
        }
      }
      if (this.#pendingBytes !== 0) {
        throw new Error("sidecar_stream_partial_frame");
      }
      const closure = await this.#stream.closed;
      this.#settleClosed({
        reason: closure.reason,
        ...(closure.cause ? { cause: closure.cause } : {}),
      });
    } catch (error) {
      const failure = asError(error, "sidecar_stream_read_failed");
      this.#closePromise ??= this.#performAutonomousClose(failure);
      await this.#closePromise.catch(() => undefined);
    }
  }

  async #performAutonomousClose(failure: Error): Promise<void> {
    try {
      await this.#stream.close(failure.message);
      this.#settleClosed({ reason: failure.message, cause: failure });
    } catch (cleanupError) {
      const cleanupFailure = new SidecarTransportCleanupError({
        cause: cleanupError,
      });
      this.#settleCleanupFailure(cleanupFailure);
      throw cleanupFailure;
    }
  }

  #appendChunk(chunk: Uint8Array): void {
    if (
      this.#pendingBytes + chunk.byteLength >
      this.#limits.maximumInboundQueueBytes + HEADER_BYTES
    ) {
      throw new Error("sidecar_stream_buffer_limit");
    }
    if (chunk.byteLength === 0) return;
    // Copy: the byte stream does not transfer ownership of its chunks.
    this.#pendingChunks.push(Buffer.from(chunk));
    this.#pendingBytes += chunk.byteLength;
  }

  /** Removes and returns the next complete frame payload, if one is buffered. */
  #takeFrame(): Uint8Array | undefined {
    if (this.#closedSettled || this.#pendingBytes < HEADER_BYTES) {
      return undefined;
    }
    const header = this.#peekHeader();
    if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
      throw new Error("sidecar_stream_magic_invalid");
    }
    const length = header.readUInt32BE(MAGIC.byteLength);
    if (length === 0 || length > this.#limits.maximumFrameBytes) {
      throw new Error("sidecar_stream_frame_length_invalid");
    }
    if (this.#pendingBytes < HEADER_BYTES + length) return undefined;
    this.#consume(HEADER_BYTES);
    const frame = new Uint8Array(length);
    this.#consume(length, frame);
    return frame;
  }

  #peekHeader(): Buffer {
    const first = this.#pendingChunks[0]!;
    if (first.byteLength - this.#pendingOffset >= HEADER_BYTES) {
      return first.subarray(this.#pendingOffset, this.#pendingOffset + HEADER_BYTES);
    }
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    let written = 0;
    let offset = this.#pendingOffset;
    for (const chunk of this.#pendingChunks) {
      written += chunk.copy(header, written, offset, Math.min(chunk.byteLength, offset + HEADER_BYTES - written));
      offset = 0;
      if (written === HEADER_BYTES) break;
    }
    return header;
  }

  /** Discards `length` pending bytes, copying them into `target` when given. */
  #consume(length: number, target?: Uint8Array): void {
    let copied = 0;
    let finishedChunks = 0;
    while (copied < length) {
      const chunk = this.#pendingChunks[finishedChunks]!;
      const take = Math.min(chunk.byteLength - this.#pendingOffset, length - copied);
      target?.set(chunk.subarray(this.#pendingOffset, this.#pendingOffset + take), copied);
      copied += take;
      this.#pendingOffset += take;
      if (this.#pendingOffset === chunk.byteLength) {
        finishedChunks += 1;
        this.#pendingOffset = 0;
      }
    }
    if (finishedChunks !== 0) this.#pendingChunks.splice(0, finishedChunks);
    this.#pendingBytes -= length;
  }

  async #pumpWrites(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#acceptingWrites) {
        const entry =
          this.#controlWrites.shift() ?? this.#operationWrites.shift();
        if (!entry) break;
        if (entry.settled) continue;
        entry.started = true;
        this.#activeWrite = entry;
        this.#queuedWriteBytes -= entry.payloadBytes;
        const started = entry.onWriteDiagnostic ? performance.now() : 0;
        this.#diagnoseWrite(entry, "write_start", entry.queuedAt === undefined ? 0 : started - entry.queuedAt);
        try {
          await this.#stream.write(entry.framed, {
            ...(entry.signal ? { signal: entry.signal } : {}),
          });
          this.#diagnoseWrite(entry, "write_complete", entry.onWriteDiagnostic ? performance.now() - started : 0);
          settleWrite(entry);
        } catch (error) {
          this.#diagnoseWrite(entry, "write_failed", entry.onWriteDiagnostic ? performance.now() - started : 0);
          const failure = new SidecarFrameWriteError(
            "sidecar_stream_write_failed",
            writeDelivery(error),
            { cause: error },
          );
          rejectWrite(entry, failure);
          void this.close("sidecar_stream_write_failed").catch(() => undefined);
          break;
        } finally {
          if (entry.abort)
            entry.signal!.removeEventListener("abort", entry.abort);
          if (this.#activeWrite === entry) this.#activeWrite = undefined;
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  #abortWrite(entry: WriteEntry): void {
    if (entry.settled) return;
    const delivery = entry.started ? "sent_outcome_unknown" : "not_sent";
    if (!entry.started) this.#queuedWriteBytes -= entry.payloadBytes;
    rejectWrite(
      entry,
      new SidecarFrameWriteError("sidecar_frame_send_aborted", delivery, {
        cause: entry.signal?.reason,
      }),
    );
    if (entry.started) {
      void this.close("sidecar_active_write_aborted").catch(() => undefined);
    }
  }

  async #performClose(reason: string): Promise<void> {
    this.#acceptingWrites = false;
    if (this.#activeWrite) {
      rejectWrite(
        this.#activeWrite,
        new SidecarFrameWriteError(
          "sidecar_transport_closed_during_write",
          "sent_outcome_unknown",
        ),
      );
    }
    for (const entry of [
      ...this.#controlWrites.splice(0),
      ...this.#operationWrites.splice(0),
    ]) {
      rejectWrite(
        entry,
        new SidecarFrameWriteError("sidecar_transport_closed", "not_sent"),
      );
    }
    this.#queuedWriteBytes = 0;
    try {
      await this.#stream.close(reason);
      this.#settleClosed({ reason });
    } catch (error) {
      const failure = new SidecarTransportCleanupError({ cause: error });
      this.#settleCleanupFailure(failure);
      throw failure;
    }
  }

  #settleClosed(closure: SidecarTransportClosure): void {
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    this.#acceptingWrites = false;
    if (this.#activeWrite) {
      rejectWrite(
        this.#activeWrite,
        new SidecarFrameWriteError(
          "sidecar_transport_closed_during_write",
          "sent_outcome_unknown",
        ),
      );
    }
    for (const entry of [
      ...this.#controlWrites.splice(0),
      ...this.#operationWrites.splice(0),
    ]) {
      rejectWrite(
        entry,
        new SidecarFrameWriteError("sidecar_transport_closed", "not_sent"),
      );
    }
    this.#queuedWriteBytes = 0;
    this.#inbound.close(closure.cause);
    this.#resolveClosed(closure);
  }

  #settleCleanupFailure(error: SidecarTransportCleanupError): void {
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    this.#acceptingWrites = false;
    if (this.#activeWrite) {
      rejectWrite(
        this.#activeWrite,
        new SidecarFrameWriteError(
          "sidecar_transport_closed_during_write",
          "sent_outcome_unknown",
        ),
      );
    }
    for (const entry of [
      ...this.#controlWrites.splice(0),
      ...this.#operationWrites.splice(0),
    ]) {
      rejectWrite(
        entry,
        new SidecarFrameWriteError("sidecar_transport_closed", "not_sent"),
      );
    }
    this.#queuedWriteBytes = 0;
    this.#inbound.close(error);
    this.#rejectClosed(error);
  }
}

function frameBytes(payload: Uint8Array): Uint8Array {
  const result = Buffer.allocUnsafe(HEADER_BYTES + payload.byteLength);
  MAGIC.copy(result, 0);
  result.writeUInt32BE(payload.byteLength, MAGIC.byteLength);
  result.set(payload, HEADER_BYTES);
  return result;
}

function writeDelivery(error: unknown): "not_sent" | "sent_outcome_unknown" {
  if (
    typeof error === "object" &&
    error !== null &&
    "delivery" in error &&
    (error.delivery === "not_sent" || error.delivery === "sent_outcome_unknown")
  ) {
    return error.delivery;
  }
  return "sent_outcome_unknown";
}

function settleWrite(entry: WriteEntry): void {
  if (entry.settled) return;
  entry.settled = true;
  entry.resolve({ disposition: "sent" });
}

function rejectWrite(entry: WriteEntry, error: Error): void {
  if (entry.settled) return;
  entry.settled = true;
  if (entry.abort) entry.signal!.removeEventListener("abort", entry.abort);
  entry.reject(error);
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
