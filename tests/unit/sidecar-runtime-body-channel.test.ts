import { createHash } from "node:crypto";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  SidecarFrameWriteError, SidecarOperationRegistry, SidecarProtocolPeer,
  controlHelloOperation, controlPingOperation, registerControlV2Operations,
  type SidecarFrame, type SidecarFrameSendOptions, type SidecarFrameTransport,
  type SidecarTransportClosure,
} from "../../src/internal/sidecar-protocol/index.js";
import { SidecarRuntimeChannel } from "../../src/server/sidecar/runtime-channel.js";
import { sidecarRuntimeBodyOffer } from "../../src/server/sidecar/runtime-body-channel.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../src/server/provider-protocol/transport/framed-message-limits.js";
import { createSidecarFramedCarrier } from "../helpers/persistent-sidecar-framed-fixture.js";

const capability = { capabilityId: "runtime_bodies", majorVersion: 1 };
const terminalSchema = z.strictObject({ size: z.number().int().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/u) });
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

describe("sidecar runtime bodies", () => {
  it("preserves body digests and raw credit across zstd socket records in both directions", async () => {
    const fixture = await createSidecarFramedCarrier("zstd");
    const mainSend = vi.spyOn(fixture.mainTransport, "send");
    const hostSend = vi.spyOn(fixture.hostTransport, "send");
    const value = { data: "λ🙂".repeat(256 * 1024), nested: [true, 1, null] };
    try {
      await fixture.start();
      const body = await fixture.mainChannel.encodeBody(value);
      expect(body.type).toBe("stream");
      await expect(fixture.hostChannel.decodeBody(body)).resolves.toEqual(value);
      const reverse = await fixture.hostChannel.encodeBody(value);
      await expect(fixture.mainChannel.decodeBody(reverse)).resolves.toEqual(value);
      const frames = [...mainSend.mock.calls, ...hostSend.mock.calls];
      const decodedBytes = frames.reduce((total, [bytes]) => total + bytes.byteLength, 0);
      expect(decodedBytes).toBeGreaterThan(3 * 1024 * 1024);
      expect(Math.max(...frames.map(([bytes]) => bytes.byteLength))).toBeLessThan(70 * 1024);
      expect(fixture.wireBytes()).toBeLessThan(decodedBytes / 10);
    } finally { await fixture.close(); }
  });

  it("transfers large native-shaped JSON in both directions with bounded credit chunks", async () => {
    const fixture = await bodyFixture();
    const value = { data: "λ".repeat(2 * 1024 * 1024), nested: [1, false, null] };
    try {
      const body = await fixture.left.encodeBody(value);
      expect(body.type).toBe("stream");
      await expect(fixture.right.decodeBody(body)).resolves.toEqual(value);
      await expect(fixture.right.decodeBody(body)).rejects.toThrow("sidecar_runtime_body_unknown");
      const reverse = await fixture.right.encodeBody(value);
      await expect(fixture.left.decodeBody(reverse)).resolves.toEqual(value);
      expect(Math.max(...fixture.pair.left.sizes, ...fixture.pair.right.sizes)).toBeLessThan(70 * 1024);
    } finally { await fixture.close(); }
  });

  it("keeps small values inline and rejects unknown transfers", async () => {
    const fixture = await bodyFixture();
    try {
      await expect(fixture.left.encodeBody({ ready: true })).resolves.toEqual({ type: "inline", value: { ready: true } });
      await expect(fixture.right.decodeBody({ type: "stream", id: "missing" })).rejects.toThrow("sidecar_runtime_body_unknown");
    } finally { await fixture.close(); }
  });

  it("rejects unfinished bodies on attachment loss and frees their reservations", async () => {
    const fixture = await bodyFixture();
    const id = "12345678-1234-4234-8234-123456789abc";
    try {
      await fixture.sedes.call(sidecarRuntimeBodyOffer, { id, size: 1024, sha256: "a".repeat(64) });
      const waiting = fixture.right.decodeBody({ type: "stream", id });
      const assertion = expect(waiting).rejects.toThrow("sidecar_runtime_body_channel_closed");
      fixture.right.close();
      await assertion;
      await expect(fixture.right.decodeBody({ type: "stream", id })).rejects.toThrow("sidecar_runtime_body_unknown");
    } finally { await fixture.close(); }
  });

  it("keeps a slow transfer that is still progressing", async () => {
    const fixture = await bodyFixture();
    const id = "12345678-1234-4234-8234-123456789abd";
    const bytes = Buffer.from(JSON.stringify({ data: "x".repeat(3 * 1024) }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await fixture.sedes.call(sidecarRuntimeBodyOffer, { id, size: bytes.byteLength, sha256: sha256(bytes) });
      const decoded = fixture.right.decodeBody({ type: "stream", id });
      const stream = fixture.sedes.openOutgoingStream({ ...capability, streamId: id, initialCreditBytes: 1024 * 1024 });
      for (let offset = 0; offset < bytes.byteLength; offset += 1024) {
        await stream.send("stdout", bytes.subarray(offset, offset + 1024));
        await vi.advanceTimersByTimeAsync(45_000);
      }
      await stream.terminal({ size: bytes.byteLength, sha256: sha256(bytes) }, terminalSchema);
      await expect(decoded).resolves.toEqual({ data: "x".repeat(3 * 1024) });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  it("fails only a stalled body and discards its late frames without closing the session", async () => {
    const fixture = await bodyFixture();
    const id = "12345678-1234-4234-8234-123456789abe";
    const bytes = Buffer.from(JSON.stringify({ data: "y".repeat(4 * 1024) }));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await fixture.sedes.call(sidecarRuntimeBodyOffer, { id, size: bytes.byteLength, sha256: sha256(bytes) });
      const decoded = fixture.right.decodeBody({ type: "stream", id });
      const assertion = expect(decoded).rejects.toThrow("sidecar_runtime_body_expired");
      const stream = fixture.sedes.openOutgoingStream({ ...capability, streamId: id, initialCreditBytes: 1024 * 1024 });
      await stream.send("stdout", bytes.subarray(0, 1024));
      await vi.advanceTimersByTimeAsync(60_000);
      await assertion;

      await stream.send("stdout", bytes.subarray(1024));
      await stream.terminal({ size: bytes.byteLength, sha256: sha256(bytes) }, terminalSchema);
      await expect(fixture.right.decodeBody({ type: "stream", id })).rejects.toThrow("sidecar_runtime_body_unknown");
      const pingId = "12345678-1234-4234-8234-123456789abf";
      await expect(fixture.sedes.call(controlPingOperation, { pingId })).resolves.toEqual({ pingId });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  it("frees an expired body's reservation at once and drains its sender after any idle period", async () => {
    const fixture = await bodyFixture();
    const id = "12345678-1234-4234-8234-123456789ac0";
    const largest = { size: MAXIMUM_PROVIDER_FRAME_BYTES + 1024 * 1024, sha256: "c".repeat(64) };
    const offerId = (index: number) => `12345678-1234-4234-8234-${index.toString().padStart(12, "0")}`;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await fixture.sedes.call(sidecarRuntimeBodyOffer, { id, ...largest });
      const decoded = fixture.right.decodeBody({ type: "stream", id });
      const assertion = expect(decoded).rejects.toThrow("sidecar_runtime_body_expired");
      const stream = fixture.sedes.openOutgoingStream({ ...capability, streamId: id, initialCreditBytes: 1024 * 1024 });
      await stream.send("stdout", Buffer.alloc(1024, 0x7b));
      await vi.advanceTimersByTimeAsync(30_000);
      // Three more of the largest bodies fill the reservation.
      for (const index of [1, 2, 3]) {
        await fixture.sedes.call(sidecarRuntimeBodyOffer, { id: offerId(index), ...largest });
      }
      await expect(fixture.sedes.call(sidecarRuntimeBodyOffer, { id: offerId(4), ...largest })).rejects.toThrow("sidecar_operation_failed");

      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      // The expired body holds no reservation or capacity, while its stream
      // id stays owned by the sender that may still finish it.
      await expect(fixture.sedes.call(sidecarRuntimeBodyOffer, { id: offerId(4), ...largest })).resolves.toEqual({ accepted: true });
      await expect(fixture.sedes.call(sidecarRuntimeBodyOffer, { id, ...largest })).rejects.toThrow("sidecar_operation_failed");

      // However long the sender stalls, its remaining frames are drained,
      // beyond the original credit window, without closing the session.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      for (let sent = 0; sent < 2 * 1024 * 1024; sent += 64 * 1024) {
        await stream.send("stdout", Buffer.alloc(64 * 1024, 0x20));
      }
      await stream.terminal(largest, terminalSchema);
      const pingId = "12345678-1234-4234-8234-123456789ac1";
      await expect(fixture.sedes.call(controlPingOperation, { pingId })).resolves.toEqual({ pingId });
      await expect(fixture.right.decodeBody({ type: "stream", id })).rejects.toThrow("sidecar_runtime_body_unknown");
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });
});

describe("sidecar runtime body draining", () => {
  it("refuses offers while too many expired bodies still wait for their senders", async () => {
    const fixture = await bodyFixture();
    const offer = (index: number) => ({ id: `12345678-1234-4234-8234-${index.toString().padStart(12, "0")}`, size: 16, sha256: "d".repeat(64) });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      for (let batch = 0; batch < 4; batch += 1) {
        for (let index = batch * 16; index < batch * 16 + 16; index += 1) {
          await fixture.sedes.call(sidecarRuntimeBodyOffer, offer(index));
        }
        await vi.advanceTimersByTimeAsync(60_000);
      }
      // Sixty-four expired bodies are draining; a refusal is not fatal.
      await expect(fixture.sedes.call(sidecarRuntimeBodyOffer, offer(64))).rejects.toThrow("sidecar_operation_failed");
      const pingId = "12345678-1234-4234-8234-123456789ac2";
      await expect(fixture.sedes.call(controlPingOperation, { pingId })).resolves.toEqual({ pingId });

      // One sender finishes its expired body; its drain slot is free again.
      const finished = fixture.sedes.openOutgoingStream({ ...capability, streamId: offer(0).id, initialCreditBytes: 1024 * 1024 });
      await finished.terminal({ size: 16, sha256: "d".repeat(64) }, terminalSchema);
      await vi.waitFor(async () => {
        await expect(fixture.sedes.call(sidecarRuntimeBodyOffer, offer(64))).resolves.toEqual({ accepted: true });
      });
    } finally {
      vi.useRealTimers();
      await fixture.close();
    }
  });

  it("ends the stream of a body whose sender fails mid-transfer", async () => {
    const fixture = await bodyFixture();
    const value = { data: "s".repeat(512 * 1024) };
    const send = fixture.pair.left.send.bind(fixture.pair.left);
    let dataFrames = 0;
    let settlements = 0;
    vi.spyOn(fixture.pair.left, "send").mockImplementation(async (bytes, options) => {
      // The third body chunk meets a congested outbound queue, and its
      // settling terminal finds the reserved capacity exhausted twice.
      const refused = options.settlement
        ? (settlements += 1) <= 2
        : options.lane === "operation" && (dataFrames += 1) === 3;
      if (refused) throw new SidecarFrameWriteError("sidecar_outbound_queue_limit", "not_sent");
      return await send(bytes, options);
    });
    const offered = vi.spyOn(fixture.sedes, "call");
    try {
      await expect(fixture.left.encodeBody(value)).rejects.toThrow("sidecar_outbound_queue_limit");
      const id = (offered.mock.calls[0]![1] as { id: string }).id;
      // The receiver learns once congestion clears, instead of holding the
      // body until expiry and its drain slot until the session closes.
      await expect(fixture.right.decodeBody({ type: "stream", id })).rejects.toThrow("sidecar_runtime_body_digest_invalid");
      expect(settlements).toBe(3);
      const pingId = "12345678-1234-4234-8234-123456789ac3";
      await expect(fixture.sedes.call(controlPingOperation, { pingId })).resolves.toEqual({ pingId });
    } finally { await fixture.close(); }
  });
});

async function bodyFixture() {
  const pair = transportPair();
  const leftRegistry = new SidecarOperationRegistry();
  const rightRegistry = new SidecarOperationRegistry();
  const sedes = new SidecarProtocolPeer({ role: "sedes", transport: pair.left, sessionNonce: "n".repeat(48), registry: leftRegistry });
  const sidecar = new SidecarProtocolPeer({ role: "sidecar", transport: pair.right, sessionNonce: "n".repeat(48), registry: rightRegistry });
  const left = new SidecarRuntimeChannel(sedes, leftRegistry);
  const right = new SidecarRuntimeChannel(sidecar, rightRegistry);
  registerControlV2Operations(rightRegistry, {
    buildId: "test", artifactSha256: "a".repeat(64), enabledSidecarCapabilities: [capability],
    enabledSedesCapabilities: leftRegistry.capabilities(),
  });
  sedes.start(); sidecar.start();
  await sedes.call(controlHelloOperation, { compression: "none", expectedBuildId: "test", expectedArtifactSha256: "a".repeat(64), authorizedSidecarCapabilities: [capability], offeredSedesCapabilities: leftRegistry.capabilities() });
  return { pair, sedes, left, right, close: async () => { left.close(); right.close(); await sedes.close("test_complete"); } };
}
class Queue implements AsyncIterable<SidecarFrame> {
  readonly values: SidecarFrame[] = [];
  readonly waiters: ((result: IteratorResult<SidecarFrame>) => void)[] = [];
  ended = false;
  push(value: SidecarFrame) {
    const waiter = this.waiters.shift();
    waiter ? waiter({ value, done: false }) : this.values.push(value);
  }
  end() {
    this.ended = true;
    for (const waiter of this.waiters.splice(0))
      waiter({ value: undefined, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SidecarFrame> {
    return {
      next: async () => {
        const value = this.values.shift();
        return value
          ? { value, done: false }
          : this.ended
            ? { value: undefined, done: true }
            : await new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

class Transport implements SidecarFrameTransport {
  commitCompression(_mode: "none" | "zstd"): void {}
  readonly sizes: number[] = [];
  readonly assurance = { kind: "memory", carrierGeneration: 1 };
  readonly queue = new Queue();
  readonly frames = this.queue;
  readonly closed: Promise<SidecarTransportClosure>;
  resolve!: (closure: SidecarTransportClosure) => void;
  peer?: Transport;
  constructor() {
    this.closed = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
  async send(bytes: Uint8Array, _options: SidecarFrameSendOptions) {
    if (!this.peer) throw new SidecarFrameWriteError("closed", "not_sent");
    this.sizes.push(bytes.byteLength);
    this.peer.queue.push({ bytes: Uint8Array.from(bytes) });
    return { disposition: "sent" as const };
  }
  async close(reason: string) {
    this.queue.end();
    this.resolve({ reason });
    if (this.peer) {
      this.peer.queue.end();
      this.peer.resolve({ reason });
    }
  }
}
function transportPair() {
  const left = new Transport();
  const right = new Transport();
  left.peer = right;
  right.peer = left;
  return { left, right };
}
