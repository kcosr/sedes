import { describe, expect, it, vi } from "vitest";
import {
  LengthPrefixedSidecarFrameTransport,
  SidecarTransportCleanupError,
  type SidecarByteStream,
  type SidecarByteStreamClosure,
} from "../../src/internal/sidecar-protocol/index.js";

describe("length-prefixed sidecar frame transport", () => {
  it("decodes arbitrarily fragmented frames and writes the exact stream shape", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    const iterator = transport.frames[Symbol.asyncIterator]();
    const payload = Buffer.from("frame payload", "utf8");
    const framed = encodeStreamFrame(payload);
    stream.push(framed.subarray(0, 2));
    stream.push(framed.subarray(2, 7));
    stream.push(framed.subarray(7));
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { bytes: Uint8Array.from(payload) },
    });

    await transport.send(Buffer.from("outbound"), { lane: "operation" });
    expect(stream.writes.map((value) => [...value])).toEqual([
      [...encodeStreamFrame(Buffer.from("outbound"))],
    ]);
    await transport.close("test_complete");
  });

  it("rejects invalid magic and closes instead of resynchronizing", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    stream.push(Buffer.from([0x42, 0x41, 0x44, 0x21, 0, 0, 0, 1, 0x78]));
    await expect(transport.closed).resolves.toMatchObject({
      reason: "sidecar_stream_magic_invalid",
      cause: expect.any(Error),
    });
    await expect(transport.close("after_terminal")).resolves.toBeUndefined();
    expect(stream.closeCallCount).toBe(1);
  });

  it("rejects terminal closure when protocol-failure cleanup loses ownership proof", async () => {
    const stream = new TestByteStream();
    const cleanupFailure = new Error("byte_stream_cleanup_failed");
    stream.closeFailure = cleanupFailure;
    const transport = createTransport(stream);

    stream.push(Buffer.from([0x42, 0x41, 0x44, 0x21, 0, 0, 0, 1, 0x78]));

    await expect(transport.closed).rejects.toMatchObject({
      name: SidecarTransportCleanupError.name,
      cause: cleanupFailure,
    });
    await expect(transport.close("after_terminal")).rejects.toMatchObject({
      name: SidecarTransportCleanupError.name,
      cause: cleanupFailure,
    });
    expect(stream.closeCallCount).toBe(1);
  });

  it("decodes coalesced frames in order", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    const iterator = transport.frames[Symbol.asyncIterator]();
    stream.push(
      Buffer.concat([
        encodeStreamFrame(Buffer.from("one")),
        encodeStreamFrame(Buffer.from("two")),
      ]),
    );
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { bytes: Uint8Array.from(Buffer.from("one")) },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { bytes: Uint8Array.from(Buffer.from("two")) },
    });
    await transport.close("test_complete");
  });

  it("rejects zero-length frames", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    stream.push(Buffer.from([0x48, 0x53, 0x43, 0x31, 0, 0, 0, 0]));
    await expect(transport.closed).resolves.toMatchObject({
      reason: "sidecar_stream_frame_length_invalid",
    });
  });

  it("rejects oversized lengths before buffering the body", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream, { maximumFrameBytes: 16 });
    const header = Buffer.alloc(8);
    Buffer.from("HSC1").copy(header);
    header.writeUInt32BE(17, 4);
    stream.push(header);
    await expect(transport.closed).resolves.toMatchObject({
      reason: "sidecar_stream_frame_length_invalid",
    });
  });

  it("prioritizes queued control frames ahead of queued operation frames", async () => {
    const stream = new TestByteStream();
    stream.blockWrites = true;
    const transport = createTransport(stream);
    const first = transport.send(Buffer.from("first"), { lane: "operation" });
    const second = transport.send(Buffer.from("second"), { lane: "operation" });
    const control = transport.send(Buffer.from("control"), { lane: "control" });
    await stream.waitForBlockedWrite();
    stream.releaseWrites();
    await Promise.all([first, second, control]);
    expect(stream.writes.map(decodeStreamFrame)).toEqual([
      "first",
      "control",
      "second",
    ]);
    await transport.close("test_complete");
  });

  it("applies backpressure when one read coalesces more frames than the inbound queue holds", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    const received: string[] = [];
    const consumer = (async () => {
      for await (const frame of transport.frames) {
        received.push(Buffer.from(frame.bytes).toString("utf8"));
      }
    })();
    const payloads = Array.from({ length: 300 }, (_, index) =>
      `credit-${String(index).padStart(3, "0")}`.padEnd(160, "."),
    );
    stream.push(
      Buffer.concat(payloads.map((payload) => encodeStreamFrame(Buffer.from(payload)))),
    );
    await vi.waitFor(() => expect(received).toHaveLength(300));
    expect(received).toEqual(payloads);
    await expect(settledWithin(transport.closed)).resolves.toBe("pending");
    await transport.close("test_complete");
    await consumer;
  });

  it("stops reading the byte stream while the inbound queue is full", async () => {
    const stream = new TestByteStream();
    const transport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test", carrierGeneration: 1 },
      stream,
      limits: {
        maximumFrameBytes: 16,
        maximumInboundQueueBytes: 32,
        maximumInboundQueueFrames: 1,
        maximumOutboundQueueBytes: 32,
      },
    });
    stream.push(
      Buffer.concat([
        encodeStreamFrame(Buffer.from("one")),
        encodeStreamFrame(Buffer.from("two")),
      ]),
    );
    stream.push(encodeStreamFrame(Buffer.from("three")));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stream.pulls).toBe(1);
    await expect(settledWithin(transport.closed)).resolves.toBe("pending");

    const iterator = transport.frames[Symbol.asyncIterator]();
    for (const expected of ["one", "two", "three"]) {
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { bytes: Uint8Array.from(Buffer.from(expected)) },
      });
    }
    expect(stream.pulls).toBeGreaterThanOrEqual(2);
    await expect(settledWithin(transport.closed)).resolves.toBe("pending");
    await transport.close("test_complete");
  });

  it("closes while backpressure holds frames without waiting for the consumer", async () => {
    const stream = new TestByteStream();
    const transport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test", carrierGeneration: 1 },
      stream,
      limits: {
        maximumFrameBytes: 16,
        maximumInboundQueueBytes: 32,
        maximumInboundQueueFrames: 1,
        maximumOutboundQueueBytes: 32,
      },
    });
    stream.push(
      Buffer.concat([
        encodeStreamFrame(Buffer.from("one")),
        encodeStreamFrame(Buffer.from("two")),
      ]),
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await transport.close("test_complete");
    await expect(transport.closed).resolves.toEqual({ reason: "test_complete" });
  });

  it("reassembles a large frame from small reads without re-concatenating the partial frame", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    const iterator = transport.frames[Symbol.asyncIterator]();
    const payload = Buffer.alloc(2 * 1024 * 1024);
    for (let index = 0; index < payload.byteLength; index += 1) {
      payload[index] = index % 251;
    }
    const framed = encodeStreamFrame(payload);
    // Count calls without retaining arguments: a reassembler that concatenates
    // the growing partial frame per read would retain gigabytes in a spy.
    const concat = Buffer.concat;
    let concatCalls = 0;
    Buffer.concat = ((...args: Parameters<typeof Buffer.concat>) => {
      concatCalls += 1;
      return concat.apply(Buffer, args);
    }) as typeof Buffer.concat;
    try {
      for (let offset = 0; offset < framed.byteLength; offset += 4096) {
        stream.push(framed.subarray(offset, offset + 4096));
      }
      const result = await iterator.next();
      expect(result.done).toBe(false);
      expect(Buffer.from(result.value!.bytes).equals(payload)).toBe(true);
      expect(concatCalls).toBe(0);
    } finally {
      Buffer.concat = concat;
    }
    await transport.close("test_complete");
  });

  it("rejects outbound queue overflow as not sent", async () => {
    const stream = new TestByteStream();
    stream.blockWrites = true;
    const transport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test", carrierGeneration: 1 },
      stream,
      limits: {
        maximumFrameBytes: 16,
        maximumInboundQueueBytes: 32,
        maximumOutboundQueueBytes: 64,
        maximumOutboundQueueFrames: 2,
      },
    });
    const active = transport.send(Buffer.from("first"), { lane: "operation" });
    await stream.waitForBlockedWrite();
    const queued = transport.send(Buffer.from("second"), { lane: "operation" });
    await expect(
      transport.send(Buffer.from("third"), { lane: "operation" }),
    ).rejects.toMatchObject({ delivery: "not_sent" });
    stream.releaseWrites();
    await Promise.all([active, queued]);
    await transport.close("test_complete");
  });

  it("admits a maximum-size payload when the outbound byte limit matches it", async () => {
    const stream = new TestByteStream();
    const transport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test", carrierGeneration: 1 },
      stream,
      limits: {
        maximumFrameBytes: 16,
        maximumInboundQueueBytes: 16,
        maximumOutboundQueueBytes: 16,
      },
    });
    await expect(
      transport.send(Buffer.alloc(16, 0x61), { lane: "operation" }),
    ).resolves.toEqual({ disposition: "sent" });
    expect(stream.writes).toHaveLength(1);
    await transport.close("test_complete");
  });

  it("settles active and queued sends when the remote stream closes", async () => {
    const stream = new TestByteStream();
    stream.blockWrites = true;
    const transport = createTransport(stream);
    const active = transport.send(Buffer.from("active"), { lane: "operation" });
    await stream.waitForBlockedWrite();
    const queued = transport.send(Buffer.from("queued"), { lane: "operation" });

    stream.end("remote_closed");

    await expect(transport.closed).resolves.toMatchObject({
      reason: "remote_closed",
    });
    await expect(active).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await expect(queued).rejects.toMatchObject({ delivery: "not_sent" });
    stream.releaseWrites();
  });

  it("publishes cleanup failure without an unhandled close rejection after write failure", async () => {
    const stream = new TestByteStream();
    const writeFailure = new Error("byte_stream_write_failed");
    const cleanupFailure = new Error("byte_stream_cleanup_failed");
    stream.writeFailure = writeFailure;
    stream.closeFailure = cleanupFailure;
    const transport = createTransport(stream);
    const terminal = expect(transport.closed).rejects.toMatchObject({
      name: SidecarTransportCleanupError.name,
      cause: cleanupFailure,
    });

    await expect(
      transport.send(Buffer.from("write"), { lane: "operation" }),
    ).rejects.toMatchObject({ cause: writeFailure });
    await terminal;
    expect(stream.closeCallCount).toBe(1);
  });

  it("publishes cleanup failure without an unhandled close rejection after active abort", async () => {
    const stream = new TestByteStream();
    stream.blockWrites = true;
    const cleanupFailure = new Error("byte_stream_cleanup_failed");
    stream.closeFailure = cleanupFailure;
    const transport = createTransport(stream);
    const terminal = expect(transport.closed).rejects.toMatchObject({
      name: SidecarTransportCleanupError.name,
      cause: cleanupFailure,
    });
    const controller = new AbortController();
    const active = transport.send(Buffer.from("write"), {
      lane: "operation",
      signal: controller.signal,
    });
    await stream.waitForBlockedWrite();

    controller.abort(new Error("caller_aborted"));

    await expect(active).rejects.toMatchObject({
      delivery: "sent_outcome_unknown",
    });
    await terminal;
    expect(stream.closeCallCount).toBe(1);
    stream.releaseWrites();
  });

  it("fails a partial terminal frame", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    stream.push(Buffer.from("HSC1"));
    stream.end("eof");
    await expect(transport.closed).resolves.toMatchObject({
      reason: "sidecar_stream_partial_frame",
    });
  });
});

class AsyncByteQueue implements AsyncIterable<Uint8Array> {
  readonly #values: Uint8Array[] = [];
  readonly #waiters: Array<(result: IteratorResult<Uint8Array>) => void> = [];
  #ended = false;
  pulls = 0;

  push(value: Uint8Array): void {
    const waiter = this.#waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.#values.push(value);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: async () => {
        this.pulls += 1;
        const value = this.#values.shift();
        if (value) return { value, done: false };
        if (this.#ended) return { value: undefined, done: true };
        return await new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

class TestByteStream implements SidecarByteStream {
  readonly bytes: AsyncIterable<Uint8Array>;
  readonly closed: Promise<SidecarByteStreamClosure>;
  readonly writes: Uint8Array[] = [];
  blockWrites = false;
  closeFailure: Error | undefined;
  writeFailure: Error | undefined;
  closeCallCount = 0;
  readonly #queue = new AsyncByteQueue();
  readonly #resolveClosed: (closure: SidecarByteStreamClosure) => void;
  readonly #blockedWriteStarted: Promise<void>;
  readonly #resolveBlockedWriteStarted: () => void;
  #closed = false;
  #release: (() => void) | undefined;

  constructor() {
    this.bytes = this.#queue;
    let resolveClosed!: (closure: SidecarByteStreamClosure) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
    let resolveBlockedWriteStarted!: () => void;
    this.#blockedWriteStarted = new Promise((resolve) => {
      resolveBlockedWriteStarted = resolve;
    });
    this.#resolveBlockedWriteStarted = resolveBlockedWriteStarted;
  }

  get pulls(): number {
    return this.#queue.pulls;
  }

  push(value: Uint8Array): void {
    this.#queue.push(Uint8Array.from(value));
  }

  end(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue.end();
    this.#resolveClosed({ reason });
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.writeFailure) throw this.writeFailure;
    if (this.blockWrites) {
      this.#resolveBlockedWriteStarted();
      await new Promise<void>((resolve) => {
        this.#release = resolve;
      });
    }
    this.writes.push(Uint8Array.from(bytes));
  }

  async close(reason: string): Promise<void> {
    this.closeCallCount += 1;
    if (this.closeFailure) throw this.closeFailure;
    this.end(reason);
  }

  async waitForBlockedWrite(): Promise<void> {
    await this.#blockedWriteStarted;
  }

  releaseWrites(): void {
    this.blockWrites = false;
    this.#release?.();
  }
}

function createTransport(
  stream: TestByteStream,
  limits?: { readonly maximumFrameBytes: number },
): LengthPrefixedSidecarFrameTransport {
  return new LengthPrefixedSidecarFrameTransport({
    assurance: { kind: "test", carrierGeneration: 1 },
    stream,
    ...(limits
      ? {
          limits: {
            maximumFrameBytes: limits.maximumFrameBytes,
            maximumInboundQueueBytes: limits.maximumFrameBytes * 2,
            maximumOutboundQueueBytes: limits.maximumFrameBytes * 2,
          },
        }
      : {}),
  });
}

async function settledWithin(
  promise: Promise<unknown>,
): Promise<"settled" | "pending"> {
  return await Promise.race([
    promise.then(
      () => "settled" as const,
      () => "settled" as const,
    ),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 20)),
  ]);
}

function encodeStreamFrame(payload: Uint8Array): Uint8Array {
  const result = Buffer.alloc(8 + payload.byteLength);
  Buffer.from("HSC1").copy(result);
  result.writeUInt32BE(payload.byteLength, 4);
  result.set(payload, 8);
  return result;
}

function decodeStreamFrame(frame: Uint8Array): string {
  const bytes = Buffer.from(frame);
  const length = bytes.readUInt32BE(4);
  return bytes.subarray(8, 8 + length).toString("utf8");
}
