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
  decompressSidecarFrame,
  SIDECAR_COMPRESSION_MINIMUM_BYTES,
  tryCompressSidecarFrame,
  type SidecarFrameCompression,
} from "./frame-compression.js";
import {
  resolveSidecarProtocolLimits,
  type SidecarProtocolLimits,
} from "./limits.js";

const MAGIC = Buffer.from("HSC2");
const HEADER_BYTES = 16;

type EncodedFrame = {
  readonly bytes: Uint8Array;
  readonly encoding: 0 | 1;
  readonly decodedLength: number;
};

type WriteEntry = {
  payload: Uint8Array | undefined;
  readonly payloadBytes: number;
  readonly lane: SidecarFrameLane;
  readonly signal?: AbortSignal;
  readonly settlement: boolean;
  readonly onWriteDiagnostic?: SidecarFrameSendOptions["onWriteDiagnostic"];
  readonly queuedAt?: number;
  readonly resolve: (value: { readonly disposition: "sent" }) => void;
  readonly reject: (error: Error) => void;
  abort?: () => void;
  framed?: Uint8Array;
  state: "queued" | "preparing" | "prepared" | "writing";
  charged: boolean;
  settled: boolean;
};

/** Length-prefixed adapter for stdio, UDS, and TCP ordered byte streams. */
export class LengthPrefixedSidecarFrameTransport implements SidecarFrameTransport {
  readonly assurance: SidecarTransportAssurance;
  readonly frames: AsyncIterable<SidecarFrame>;
  readonly closed: Promise<SidecarTransportClosure>;
  readonly #stream: SidecarByteStream;
  readonly #limits: SidecarProtocolLimits;
  readonly #inbound: BoundedAsyncQueue<EncodedFrame>;
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
  #preparingWrite: WriteEntry | undefined;
  #preparedWrite: WriteEntry | undefined;
  #pumping = false;
  #acceptingWrites = true;
  #closePromise: Promise<void> | undefined;
  #closedSettled = false;
  #compression: SidecarFrameCompression | undefined;
  readonly #decodeAbort = new AbortController();
  #unconsumedFrames = 0;
  #cleanEOF: SidecarTransportClosure | undefined;

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
      sizeOf: (frame: EncodedFrame) => frame.decodedLength,
    });
    let consumerClaimed = false;
    this.frames = {
      [Symbol.asyncIterator]: () => {
        if (consumerClaimed) throw new Error("sidecar_queue_already_consumed");
        consumerClaimed = true;
        return this.#decodeFrames();
      },
    };
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

  commitCompression(mode: SidecarFrameCompression): void {
    if (this.#compression !== undefined || this.#decodeAbort.signal.aborted || this.#closedSettled || (mode !== "none" && mode !== "zstd")) {
      throw new Error("sidecar_transport_compression_state_invalid");
    }
    this.#compression = mode;
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
      (this.#preparingWrite && !this.#preparingWrite.settled ? 1 : 0) +
      (this.#preparedWrite ? 1 : 0) +
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
    return new Promise((resolve, reject) => {
      const entry: WriteEntry = {
        payload: bytes,
        payloadBytes: bytes.byteLength,
        lane: options.lane,
        ...(options.signal ? { signal: options.signal } : {}),
        settlement: options.settlement === true,
        ...(options.onWriteDiagnostic ? { onWriteDiagnostic: options.onWriteDiagnostic, queuedAt: performance.now() } : {}),
        resolve,
        reject,
        state: "queued",
        charged: true,
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
      queuedWriteFrames: this.#controlWrites.filter(entry => !entry.settled).length + this.#operationWrites.filter(entry => !entry.settled).length +
        (this.#preparingWrite && !this.#preparingWrite.settled ? 1 : 0) + (this.#preparedWrite ? 1 : 0),
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
          this.#unconsumedFrames += 1;
          await this.#inbound.push(frame);
        }
      }
      if (this.#decodeAbort.signal.aborted || this.#closedSettled) return;
      if (this.#pendingBytes !== 0) {
        throw new Error("sidecar_stream_partial_frame");
      }
      const closure = await this.#stream.closed;
      this.#cleanEOF = {
        reason: closure.reason,
        ...(closure.cause ? { cause: closure.cause } : {}),
      };
      if (closure.cause) {
        this.#settleClosed(this.#cleanEOF);
      } else {
        // Deliver buffered responses before rejecting their pending writes.
        this.#acceptingWrites = false;
        this.#inbound.close();
        this.#finishCleanEOF();
      }
    } catch (error) {
      const failure = asError(error, "sidecar_stream_read_failed");
      this.#closePromise ??= this.#performAutonomousClose(failure);
      await this.#closePromise.catch(() => undefined);
    }
  }

  async *#decodeFrames(): AsyncGenerator<SidecarFrame> {
    let drained = false;
    try {
      for await (const frame of this.#inbound) {
        let consumed = false;
        try {
          if (this.#closedSettled || this.#decodeAbort.signal.aborted) return;
          if (frame.encoding === 1 && this.#compression !== "zstd") {
            throw new Error("sidecar_stream_compression_not_negotiated");
          }
          const bytes = frame.encoding === 0 ? frame.bytes : await decompressSidecarFrame(
            frame.bytes, frame.decodedLength, this.#decodeAbort.signal,
          );
          if (this.#closedSettled || this.#decodeAbort.signal.aborted) return;
          yield { bytes };
          consumed = true;
        } finally {
          this.#unconsumedFrames -= 1;
          if (consumed) this.#finishCleanEOF();
        }
      }
      drained = true;
    } catch (error) {
      const failure = asError(error, "sidecar_stream_decode_failed");
      if (!this.#closedSettled) {
        this.#closePromise ??= this.#performAutonomousClose(failure);
        await this.#closePromise.catch(() => undefined);
      }
      throw failure;
    } finally {
      if (!drained && !this.#closedSettled) {
        await this.close("sidecar_frame_consumer_closed");
      }
    }
  }

  #finishCleanEOF(): void {
    if (this.#cleanEOF && this.#unconsumedFrames === 0) this.#settleClosed(this.#cleanEOF);
  }

  async #performAutonomousClose(failure: Error): Promise<void> {
    this.#stopWrites();
    this.#decodeAbort.abort(failure);
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
  #takeFrame(): EncodedFrame | undefined {
    if (this.#closedSettled || this.#pendingBytes < HEADER_BYTES) {
      return undefined;
    }
    const header = this.#peekHeader();
    if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
      throw new Error("sidecar_stream_magic_invalid");
    }
    const encoding = header[4];
    if ((encoding !== 0 && encoding !== 1) || header[5] !== 0 || header[6] !== 0 || header[7] !== 0) {
      throw new Error("sidecar_stream_encoding_invalid");
    }
    const length = header.readUInt32BE(8);
    const decodedLength = header.readUInt32BE(12);
    if (length === 0 || length > this.#limits.maximumFrameBytes || decodedLength === 0 || decodedLength > this.#limits.maximumFrameBytes ||
        (encoding === 0 ? length !== decodedLength : length >= decodedLength)) {
      throw new Error("sidecar_stream_frame_length_invalid");
    }
    if (this.#pendingBytes < HEADER_BYTES + length) return undefined;
    this.#consume(HEADER_BYTES);
    const frame = new Uint8Array(length);
    this.#consume(length, frame);
    return { bytes: frame, encoding, decodedLength };
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
          this.#controlWrites.shift() ?? this.#preparedWrite ?? this.#operationWrites.shift();
        if (!entry) break;
        if (this.#preparedWrite === entry) this.#preparedWrite = undefined;
        if (entry.settled) continue;
        if (!entry.framed && (this.#compression !== "zstd" || entry.lane === "control" ||
            entry.settlement || entry.payloadBytes < SIDECAR_COMPRESSION_MINIMUM_BYTES)) {
          entry.framed = frameBytes(entry.payload!, 0, entry.payloadBytes);
          entry.payload = undefined;
        }
        if (!entry.framed) {
          entry.state = "preparing";
          this.#preparingWrite = entry;
          try {
            const compressed = await tryCompressSidecarFrame(entry.payload!);
            if (entry.settled || !this.#acceptingWrites) continue;
            const useCompressed = compressed !== undefined && compressed.byteLength < entry.payloadBytes;
            entry.framed = frameBytes(useCompressed ? compressed : entry.payload!, useCompressed ? 1 : 0, entry.payloadBytes);
            entry.payload = undefined;
            entry.state = "prepared";
            // A control write queued during encoding gets the next carrier write.
            this.#preparedWrite = entry;
          } catch (error) {
            if (entry.settled || !this.#acceptingWrites) continue;
            this.#releaseCharge(entry);
            rejectWrite(entry, new SidecarFrameWriteError("sidecar_frame_compression_failed", "not_sent", { cause: error }));
            void this.close("sidecar_frame_compression_failed").catch(() => undefined);
          } finally {
            // Clean EOF can stop admission while inbound frames are still being
            // decoded. Do not orphan this entry when clearing the preparation slot.
            if (!entry.settled && !this.#acceptingWrites) {
              this.#releaseCharge(entry);
              rejectWrite(entry, new SidecarFrameWriteError("sidecar_transport_closed", "not_sent"));
            }
            if (this.#preparingWrite === entry) this.#preparingWrite = undefined;
          }
          continue;
        }
        entry.state = "writing";
        this.#activeWrite = entry;
        this.#releaseCharge(entry);
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
    const writing = entry.state === "writing";
    const delivery = writing ? "sent_outcome_unknown" : "not_sent";
    if (!writing) {
      // Free the queue slot now; a stalled active write must not let
      // abandoned frames exhaust the outbound frame limit.
      this.#releaseCharge(entry);
      if (this.#preparedWrite === entry) this.#preparedWrite = undefined;
      if (!removeQueued(this.#controlWrites, entry)) {
        removeQueued(this.#operationWrites, entry);
      }
    }
    rejectWrite(
      entry,
      new SidecarFrameWriteError("sidecar_frame_send_aborted", delivery, {
        cause: entry.signal?.reason,
      }),
    );
    if (writing) {
      void this.close("sidecar_active_write_aborted").catch(() => undefined);
    }
  }

  #releaseCharge(entry: WriteEntry): void {
    if (!entry.charged) return;
    entry.charged = false;
    this.#queuedWriteBytes -= entry.payloadBytes;
  }

  #stopWrites(): void {
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
      ...(this.#preparingWrite ? [this.#preparingWrite] : []),
      ...(this.#preparedWrite ? [this.#preparedWrite] : []),
    ]) {
      this.#releaseCharge(entry);
      rejectWrite(
        entry,
        new SidecarFrameWriteError("sidecar_transport_closed", "not_sent"),
      );
    }
    this.#preparedWrite = undefined;
  }

  async #performClose(reason: string): Promise<void> {
    this.#stopWrites();
    this.#decodeAbort.abort(new Error(reason));
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
    this.#stopWrites();
    this.#decodeAbort.abort(closure.cause ?? new Error(closure.reason));
    this.#inbound.close(closure.cause);
    this.#resolveClosed(closure);
  }

  #settleCleanupFailure(error: SidecarTransportCleanupError): void {
    if (this.#closedSettled) return;
    this.#closedSettled = true;
    this.#stopWrites();
    this.#decodeAbort.abort(error);
    this.#inbound.close(error);
    this.#rejectClosed(error);
  }
}

function frameBytes(payload: Uint8Array, encoding: 0 | 1, decodedLength: number): Uint8Array {
  const result = Buffer.allocUnsafe(HEADER_BYTES + payload.byteLength);
  MAGIC.copy(result, 0);
  result[4] = encoding;
  result.fill(0, 5, 8);
  result.writeUInt32BE(payload.byteLength, 8);
  result.writeUInt32BE(decodedLength, 12);
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

function removeQueued(lane: WriteEntry[], entry: WriteEntry): boolean {
  const index = lane.indexOf(entry);
  if (index < 0) return false;
  lane.splice(index, 1);
  return true;
}

function settleWrite(entry: WriteEntry): void {
  if (entry.settled) return;
  entry.settled = true;
  entry.payload = undefined;
  entry.framed = undefined;
  entry.resolve({ disposition: "sent" });
}

function rejectWrite(entry: WriteEntry, error: Error): void {
  if (entry.settled) return;
  entry.settled = true;
  entry.payload = undefined;
  entry.framed = undefined;
  if (entry.abort) entry.signal!.removeEventListener("abort", entry.abort);
  entry.reject(error);
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
