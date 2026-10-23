import { describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { constants, zstdCompressSync } from "node:zlib";
import * as compression from "../../src/internal/sidecar-protocol/frame-compression.js";
import { asyncCodecBudget } from "../../src/internal/compression/async-codec-budget.js";
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
    stream.push(Buffer.concat([Buffer.from("BAD!"), Buffer.alloc(12)]));
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

    stream.push(Buffer.concat([Buffer.from("BAD!"), Buffer.alloc(12)]));

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
    stream.push(encodeStreamFrame(Buffer.alloc(0)));
    await expect(transport.closed).resolves.toMatchObject({
      reason: "sidecar_stream_frame_length_invalid",
    });
  });

  it("rejects oversized lengths before buffering the body", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream, { maximumFrameBytes: 16 });
    const header = Buffer.alloc(16);
    Buffer.from("HSC2").copy(header);
    header.writeUInt32BE(17, 8);
    header.writeUInt32BE(17, 12);
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

  it("releases the queue slots of aborted unstarted writes while the active write stalls", async () => {
    const stream = new TestByteStream();
    stream.blockWrites = true;
    const transport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test", carrierGeneration: 1 },
      stream,
      limits: {
        maximumFrameBytes: 16,
        maximumInboundQueueBytes: 32,
        maximumOutboundQueueBytes: 1024,
        maximumOutboundQueueFrames: 4,
      },
    });
    const active = transport.send(Buffer.from("active"), { lane: "operation" });
    await stream.waitForBlockedWrite();
    const controllers = Array.from({ length: 3 }, () => new AbortController());
    const abandoned = controllers.map((controller, index) =>
      transport.send(Buffer.from(`queued-${index}`), {
        lane: index === 0 ? "control" : "operation",
        signal: controller.signal,
      }),
    );
    for (const controller of controllers) controller.abort(new Error("caller_timeout"));
    for (const send of abandoned) {
      await expect(send).rejects.toMatchObject({
        message: "sidecar_frame_send_aborted",
        delivery: "not_sent",
      });
    }
    expect(transport.diagnosticSnapshot()).toEqual({
      queuedWriteBytes: 0,
      queuedWriteFrames: 0,
      activeWriteBytes: 6,
    });

    const next = Array.from({ length: 3 }, (_, index) =>
      transport.send(Buffer.from(`next-${index}`), { lane: "operation" }),
    );
    stream.releaseWrites();
    await expect(Promise.all([active, ...next])).resolves.toHaveLength(4);
    expect(stream.writes.map(decodeStreamFrame)).toEqual([
      "active",
      "next-0",
      "next-1",
      "next-2",
    ]);
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
    stream.push(Buffer.from("HSC2"));
    stream.end("eof");
    await expect(transport.closed).resolves.toMatchObject({
      reason: "sidecar_stream_partial_frame",
    });
  });

  it("compresses independent large operations and keeps small, random, control and settlement records plain", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    transport.commitCompression("zstd");
    const payloads = [Buffer.from("tiny"), Buffer.alloc(8192, 97), randomBytes(8192), Buffer.alloc(8192, 98), Buffer.alloc(8192, 99)];
    for (const [index, payload] of payloads.entries()) {
      await transport.send(payload, { lane: index === 3 ? "control" : "operation", ...(index === 4 ? { settlement: true } : {}) });
    }
    expect(stream.writes.map(frame => frame[4])).toEqual([0, 1, 0, 0, 0]);
    const iterator = transport.frames[Symbol.asyncIterator]();
    for (const [index, frame] of stream.writes.entries()) {
      stream.push(frame);
      const received = await iterator.next();
      expect(Buffer.from(received.value!.bytes)).toEqual(payloads[index]);
    }
    await transport.close("test_complete");
  });

  it("drains fragmented and coalesced compressed records before publishing clean EOF", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    transport.commitCompression("zstd");
    const payloads = [Buffer.alloc(8192, 97), Buffer.alloc(4096, 98)];
    const framed = Buffer.concat(payloads.map(encodeCompressedStreamFrame));
    stream.push(framed.subarray(0, 11));
    stream.push(framed.subarray(11, 27));
    stream.push(framed.subarray(27));
    stream.end("eof");
    const received: Buffer[] = [];
    let closed = false;
    void transport.closed.then(() => { closed = true; });
    for await (const frame of transport.frames) {
      expect(closed).toBe(false);
      received.push(Buffer.from(frame.bytes));
    }
    expect(received).toEqual(payloads);
    await expect(transport.closed).resolves.toEqual({ reason: "eof" });
  });

  it.each(["completes", "fails"] as const)("settles an encoder that %s after clean EOF while inbound decoding is paused", async outcome => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    transport.commitCompression("zstd");
    const encoding = deferred<Buffer | undefined>();
    const decoding = deferred<Uint8Array>();
    const compress = vi.spyOn(compression, "tryCompressSidecarFrame").mockReturnValueOnce(encoding.promise);
    const decompress = vi.spyOn(compression, "decompressSidecarFrame").mockReturnValueOnce(decoding.promise);
    const outbound = Buffer.alloc(4 * 1024 * 1024, 97);
    const inbound = Buffer.alloc(4096, 98);
    try {
      const sending = transport.send(outbound, { lane: "operation" });
      const rejected = expect(sending).rejects.toMatchObject({ message: "sidecar_transport_closed", delivery: "not_sent" });
      expect(compress.mock.calls[0]?.[0]).toBe(outbound);
      stream.push(encodeCompressedStreamFrame(inbound));
      stream.end("eof");
      const iterator = transport.frames[Symbol.asyncIterator]();
      const reading = iterator.next();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(decompress).toHaveBeenCalledOnce();
      await expect(transport.send(Buffer.from("after EOF"), { lane: "control" })).rejects.toMatchObject({ delivery: "not_sent" });
      if (outcome === "completes") encoding.resolve(undefined);
      else encoding.reject(new Error("encoder_failed_after_eof"));
      await rejected;
      expect(transport.diagnosticSnapshot()).toEqual({ queuedWriteBytes: 0, queuedWriteFrames: 0, activeWriteBytes: 0 });
      expect(stream.writes).toHaveLength(0);
      await expect(settledWithin(transport.closed)).resolves.toBe("pending");
      decoding.resolve(inbound);
      await expect(reading).resolves.toEqual({ done: false, value: { bytes: inbound } });
      await expect(iterator.next()).resolves.toMatchObject({ done: true });
      await expect(transport.closed).resolves.toEqual({ reason: "eof" });
    } finally {
      encoding.resolve(undefined);
      decoding.resolve(inbound);
      compress.mockRestore();
      decompress.mockRestore();
      await transport.close("test_complete");
    }
  });

  it.each([undefined, "none"] as const)("rejects compressed records when mode is %s", async mode => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    if (mode) transport.commitCompression(mode);
    stream.push(encodeCompressedStreamFrame(Buffer.alloc(4096, 97)));
    await expect(transport.frames[Symbol.asyncIterator]().next()).rejects.toThrow("sidecar_stream_compression_not_negotiated");
    await expect(transport.closed).resolves.toMatchObject({ reason: "sidecar_stream_compression_not_negotiated" });
  });

  it("reports a malformed final compressed record instead of clean carrier EOF", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    transport.commitCompression("zstd");
    const frame = encodeCompressedStreamFrame(Buffer.alloc(4096, 97));
    frame[frame.length - 1]! ^= 1;
    stream.push(frame);
    stream.end("eof");
    await expect(transport.frames[Symbol.asyncIterator]().next()).rejects.toThrow();
    await expect(transport.closed).resolves.toMatchObject({ cause: expect.any(Error) });
    expect((await transport.closed).reason).not.toBe("eof");
  });

  it("commits a mode once for each new carrier", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    transport.commitCompression("none");
    expect(() => transport.commitCompression("zstd")).toThrow("sidecar_transport_compression_state_invalid");
    await transport.send(Buffer.alloc(4096, 97), { lane: "operation" });
    expect(stream.writes[0]![4]).toBe(0);
    await transport.close("test_complete");
  });

  it.each(["encoding", "reserved", "decoded length", "identity mismatch", "compressed expansion"])("rejects invalid %s before buffering a body", async kind => {
    const stream = new TestByteStream();
    const transport = createTransport(stream, { maximumFrameBytes: 16 });
    const header = Buffer.from(encodeStreamFrame(Buffer.alloc(1))).subarray(0, 16);
    if (kind === "encoding") header[4] = 2;
    else if (kind === "reserved") header[6] = 1;
    else if (kind === "decoded length") header.writeUInt32BE(17, 12);
    else if (kind === "identity mismatch") header.writeUInt32BE(2, 12);
    else header[4] = 1;
    stream.push(header);
    await expect(transport.closed).resolves.toMatchObject({
      reason: kind === "encoding" || kind === "reserved" ? "sidecar_stream_encoding_invalid" : "sidecar_stream_frame_length_invalid",
    });
  });

  it("charges queued compressed records by decoded size", async () => {
    const stream = new TestByteStream();
    const transport = new LengthPrefixedSidecarFrameTransport({
      assurance: { kind: "test", carrierGeneration: 1 }, stream,
      limits: { maximumFrameBytes: 4096, maximumInboundQueueBytes: 4096, maximumOutboundQueueBytes: 4096 },
    });
    transport.commitCompression("zstd");
    const frame = encodeCompressedStreamFrame(Buffer.alloc(3072, 97));
    stream.push(Buffer.concat([frame, frame]));
    stream.push(frame);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stream.pulls).toBe(1);
    await transport.close("test_complete");
  });

  it("puts a control ahead of a prepared operation without changing operation order", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    transport.commitCompression("zstd");
    const gate = deferred<Buffer | undefined>();
    const compress = vi.spyOn(compression, "tryCompressSidecarFrame").mockReturnValueOnce(gate.promise);
    const firstPayload = Buffer.alloc(2048, 97);
    try {
      const first = transport.send(firstPayload, { lane: "operation" });
      const second = transport.send(Buffer.alloc(2048, 98), { lane: "operation" });
      const control = transport.send(Buffer.from("ping"), { lane: "control" });
      expect(transport.diagnosticSnapshot()).toMatchObject({ queuedWriteBytes: 4100, activeWriteBytes: 0 });
      gate.resolve(encodeZstd(firstPayload));
      await Promise.all([first, second, control]);
      expect(stream.writes.map(frame => frame[4])).toEqual([0, 1, 1]);
      expect(decodeStreamFrame(stream.writes[0]!)).toBe("ping");
      expect(transport.diagnosticSnapshot()).toEqual({ queuedWriteBytes: 0, queuedWriteFrames: 0, activeWriteBytes: 0 });
    } finally {
      compress.mockRestore();
      await transport.close("test_complete");
    }
  });

  it.each(["abort", "close"] as const)("settles %s during preparation as not sent and releases its charge once", async action => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    transport.commitCompression("zstd");
    const gate = deferred<Buffer | undefined>();
    const compress = vi.spyOn(compression, "tryCompressSidecarFrame").mockReturnValueOnce(gate.promise);
    const controller = new AbortController();
    const payload = Buffer.alloc(2048, 97);
    try {
      const sending = transport.send(payload, { lane: "operation", signal: controller.signal });
      const rejected = expect(sending).rejects.toMatchObject({ delivery: "not_sent" });
      if (action === "abort") controller.abort();
      else await transport.close("test_close");
      await rejected;
      expect(transport.diagnosticSnapshot()).toEqual({ queuedWriteBytes: 0, queuedWriteFrames: 0, activeWriteBytes: 0 });
      gate.resolve(encodeZstd(payload));
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stream.writes).toHaveLength(0);
      expect(transport.diagnosticSnapshot()).toEqual({ queuedWriteBytes: 0, queuedWriteFrames: 0, activeWriteBytes: 0 });
      if (action === "abort") {
        await transport.send(Buffer.from("after"), { lane: "operation" });
        expect(stream.writes.map(decodeStreamFrame)).toEqual(["after"]);
      }
    } finally {
      gate.resolve(undefined);
      compress.mockRestore();
      await transport.close("test_complete");
    }
  });

  it("cancels a prepared operation while an earlier control write is blocked", async () => {
    const stream = new TestByteStream();
    stream.blockWrites = true;
    const transport = createTransport(stream);
    transport.commitCompression("zstd");
    const gate = deferred<Buffer | undefined>();
    const compress = vi.spyOn(compression, "tryCompressSidecarFrame").mockReturnValueOnce(gate.promise);
    const controller = new AbortController();
    const payload = Buffer.alloc(2048, 97);
    try {
      const sending = transport.send(payload, { lane: "operation", signal: controller.signal });
      const rejected = expect(sending).rejects.toMatchObject({ delivery: "not_sent" });
      const control = transport.send(Buffer.from("ping"), { lane: "control" });
      gate.resolve(encodeZstd(payload));
      await stream.waitForBlockedWrite();
      expect(transport.diagnosticSnapshot()).toMatchObject({ queuedWriteBytes: 2048, activeWriteBytes: 4 });
      controller.abort();
      await rejected;
      stream.releaseWrites();
      await control;
      expect(stream.writes.map(decodeStreamFrame)).toEqual(["ping"]);
      expect(transport.diagnosticSnapshot()).toEqual({ queuedWriteBytes: 0, queuedWriteFrames: 0, activeWriteBytes: 0 });
    } finally {
      gate.resolve(undefined);
      stream.releaseWrites();
      compress.mockRestore();
      await transport.close("test_complete");
    }
  });

  it("closes promptly while compressed input waits for a consumer", async () => {
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    transport.commitCompression("zstd");
    stream.push(encodeCompressedStreamFrame(Buffer.alloc(4096, 97)));
    stream.end("eof");
    await new Promise<void>(resolve => setImmediate(resolve));
    await transport.close("explicit_close");
    await expect(transport.closed).resolves.toEqual({ reason: "explicit_close" });
  });

  it("cancels a decoder waiting for a shared codec slot during close", async () => {
    const first = asyncCodecBudget.tryAcquire()!;
    const second = asyncCodecBudget.tryAcquire()!;
    const stream = new TestByteStream();
    const transport = createTransport(stream);
    transport.commitCompression("zstd");
    try {
      stream.push(encodeCompressedStreamFrame(Buffer.alloc(4096, 97)));
      const reading = transport.frames[Symbol.asyncIterator]().next();
      const rejected = expect(reading).rejects.toThrow("explicit_close");
      await vi.waitFor(() => expect(asyncCodecBudget.waitingCount).toBe(1));
      await transport.close("explicit_close");
      await rejected;
      expect(asyncCodecBudget.waitingCount).toBe(0);
      await expect(transport.closed).resolves.toEqual({ reason: "explicit_close" });
    } finally {
      first.release(); second.release();
      await transport.close("test_complete");
    }
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
  const result = Buffer.alloc(16 + payload.byteLength);
  Buffer.from("HSC2").copy(result);
  result.writeUInt32BE(payload.byteLength, 8);
  result.writeUInt32BE(payload.byteLength, 12);
  result.set(payload, 16);
  return result;
}

function decodeStreamFrame(frame: Uint8Array): string {
  const bytes = Buffer.from(frame);
  const length = bytes.readUInt32BE(8);
  return bytes.subarray(16, 16 + length).toString("utf8");
}

function encodeZstd(payload: Uint8Array): Buffer {
  return zstdCompressSync(payload, { params: { [constants.ZSTD_c_windowLog]: 20, [constants.ZSTD_c_checksumFlag]: 1 } });
}

function encodeCompressedStreamFrame(payload: Uint8Array): Buffer {
  const encoded = encodeZstd(payload);
  const result = Buffer.from(encodeStreamFrame(encoded));
  result[4] = 1;
  result.writeUInt32BE(payload.byteLength, 12);
  return result;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
