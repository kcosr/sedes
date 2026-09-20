import { describe, expect, it } from "vitest";
import {
  SidecarFrameWriteError, SidecarOperationRegistry, SidecarProtocolPeer,
  controlHelloOperation, registerControlV2Operations,
  type SidecarFrame, type SidecarFrameSendOptions, type SidecarFrameTransport,
  type SidecarTransportClosure,
} from "../../src/internal/sidecar-protocol/index.js";
import { SidecarRuntimeChannel } from "../../src/server/sidecar/runtime-channel.js";
import { sidecarRuntimeBodyOffer } from "../../src/server/sidecar/runtime-body-channel.js";

const capability = { capabilityId: "runtime_bodies", majorVersion: 1 };

describe("sidecar runtime bodies", () => {
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
  await sedes.call(controlHelloOperation, { expectedBuildId: "test", expectedArtifactSha256: "a".repeat(64), authorizedSidecarCapabilities: [capability], offeredSedesCapabilities: leftRegistry.capabilities() });
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
