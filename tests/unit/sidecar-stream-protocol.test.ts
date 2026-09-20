import { randomUUID } from "node:crypto";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import {
  SIDECAR_WIRE_VERSION,
  SIDECAR_JSON_FRAME_TAG,
  SIDECAR_STREAM_DATA_FRAME_TAG,
  SidecarFrameWriteError,
  SidecarOperationRegistry,
  SidecarProtocolPeer,
  controlHelloOperation,
  decodeSidecarFrame,
  encodeSidecarEnvelope,
  encodeSidecarStreamDataFrame,
  registerControlV2Operations,
  workspaceToolsShellStartOperation,
  workspaceToolsShellTerminalSchema,
  WORKSPACE_TOOLS_V2_LIMITS,
  WORKSPACE_TOOLS_SHELL_V2_LIMITS,
  WORKSPACE_CONTEXT_V1_LIMITS,
  workspaceContextReadOperation,
  type SidecarFrame,
  type SidecarFrameSendOptions,
  type SidecarFrameTransport,
  type SidecarTransportClosure,
} from "../../src/internal/sidecar-protocol/index.js";

const nonce = "s".repeat(48);
const capability = {
  capabilityId: "workspace_tools",
  majorVersion: 2,
} as const;
const contextCapability = {
  capabilityId: "workspace_context",
  majorVersion: 1,
} as const;

describe("sidecar retained streams", () => {
  it.each([5, 8, 9, 10])("uses exact wire v11 and rejects a tagged wire-v%s control envelope", async wireVersion => {
    expect(SIDECAR_WIRE_VERSION).toBe(11);
    const fixture = await streamFixture();
    await fixture.pair.right.send(
      Buffer.concat([
        Buffer.from([SIDECAR_JSON_FRAME_TAG]),
        Buffer.from(
          JSON.stringify({
            wireVersion,
            sessionNonce: nonce,
            type: "stream_credit",
            origin: "sidecar",
            streamId: randomUUID(),
            bytes: 1,
          }),
        ),
      ]),
      { lane: "control" },
    );
    await expect(fixture.pair.left.closed).resolves.toMatchObject({
      reason: "sidecar_protocol_envelope_invalid",
    });
  });

  it("tags JSON controls and encodes stream data as strict raw binary", () => {
    const streamId = randomUUID();
    const control = encodeSidecarEnvelope({
      wireVersion: SIDECAR_WIRE_VERSION,
      sessionNonce: nonce,
      type: "stream_credit",
      origin: "sedes",
      streamId,
      bytes: 3,
    });
    expect(control[0]).toBe(SIDECAR_JSON_FRAME_TAG);
    expect(
      JSON.parse(Buffer.from(control.subarray(1)).toString("utf8")),
    ).toEqual(
      expect.objectContaining({ type: "stream_credit", wireVersion: SIDECAR_WIRE_VERSION }),
    );

    for (const [channel, code] of [
      ["stdout", 0],
      ["stderr", 1],
      ["data", 2],
    ] as const) {
      const payload = Uint8Array.from([0x00, 0xff, 0x7b, 0x22]);
      const encoded = encodeSidecarStreamDataFrame({
        sessionNonce: nonce,
        origin: "sidecar",
        streamId,
        sequence: 17,
        channel,
        bytes: payload,
      });
      expect(encoded[0]).toBe(SIDECAR_STREAM_DATA_FRAME_TAG);
      expect(Buffer.from(encoded).readUInt16BE(1)).toBe(SIDECAR_WIRE_VERSION);
      expect(encoded[19]).toBe(1);
      expect(encoded[20]).toBe(code);
      expect(encoded.byteLength).toBe(45 + payload.byteLength);
      expect(Buffer.from(encoded.subarray(45))).toEqual(Buffer.from(payload));
      expect(decodeSidecarFrame(encoded, nonce)).toEqual({
        kind: "stream_data",
        frame: {
          sessionNonce: nonce,
          origin: "sidecar",
          streamId,
          sequence: 17,
          channel,
          bytes: payload,
        },
      });
    }
  });

  it("rejects unknown tags and malformed binary stream headers", () => {
    const streamId = randomUUID();
    const valid = Buffer.from(
      encodeSidecarStreamDataFrame({
        sessionNonce: nonce,
        origin: "sidecar",
        streamId,
        sequence: 0,
        channel: "data",
        bytes: Uint8Array.of(1),
      }),
    );
    expect(() => decodeSidecarFrame(Uint8Array.of(0x03), nonce)).toThrow(
      "sidecar_protocol_frame_tag_invalid",
    );
    const wrongVersion = Buffer.from(valid);
    wrongVersion.writeUInt16BE(5, 1);
    expect(() => decodeSidecarFrame(wrongVersion, nonce)).toThrow(
      "sidecar_protocol_stream_wire_version_invalid",
    );
    expect(() =>
      decodeSidecarFrame(valid, "other-session".padEnd(48, "x")),
    ).toThrow("sidecar_protocol_session_nonce_mismatch");
    const unknownChannel = Buffer.from(valid);
    unknownChannel[20] = 3;
    expect(() => decodeSidecarFrame(unknownChannel, nonce)).toThrow(
      "sidecar_protocol_stream_channel_invalid",
    );
    expect(() => decodeSidecarFrame(valid.subarray(0, 45), nonce)).toThrow(
      "sidecar_protocol_stream_data_invalid",
    );
    expect(() =>
      encodeSidecarStreamDataFrame({
        sessionNonce: nonce,
        origin: "sidecar",
        streamId,
        sequence: Number.MAX_SAFE_INTEGER + 1,
        channel: "data",
        bytes: Uint8Array.of(1),
      }),
    ).toThrow("sidecar_protocol_stream_sequence_invalid");
  });

  it("registers before start, preserves raw bytes and pauses until credit", async () => {
    const streamId = randomUUID();
    const first = Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0xe2]);
    const second = Buffer.from([0x82, 0xac, 0xff]);
    let producer!: ReturnType<SidecarProtocolPeer["openOutgoingStream"]>;
    const fixture = await streamFixture(async (sidecar, request) => {
      producer = sidecar.openOutgoingStream({
        streamId: request.streamId,
        capabilityId: capability.capabilityId,
        majorVersion: capability.majorVersion,
        initialCreditBytes: request.initialCreditBytes,
      });
      await producer.send("stdout", first);
      return { streamId: request.streamId, admitted: true as const };
    });
    const records: Uint8Array[] = [];
    const terminal = vi.fn();
    const incoming = fixture.sedes.registerIncomingStream({
      streamId,
      ...capability,
      initialCreditBytes: first.byteLength,
      terminalSchema: workspaceToolsShellTerminalSchema,
      onData: ({ bytes }) => records.push(bytes),
      onTerminal: terminal,
    });
    await fixture.sedes.call(workspaceToolsShellStartOperation, {
      workspaceHandle: randomUUID(),
      operationId: randomUUID(),
      streamId,
      command: "printf test",
      initialCreditBytes: first.byteLength,
      timeoutMilliseconds: 1_000,
    });
    let secondSettled = false;
    const pending = producer.send("stderr", second).then(() => {
      secondSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    await incoming.addCredit(second.byteLength);
    await pending;
    await producer.terminal(
      {
        outcome: "exited",
        exitCode: 0,
        signal: null,
        stdoutBytes: first.byteLength,
        stderrBytes: second.byteLength,
        emittedBytes: first.byteLength + second.byteLength,
        omittedBytes: 0,
        truncated: false,
      },
      workspaceToolsShellTerminalSchema,
    );
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());
    expect(Buffer.concat(records.map(Buffer.from))).toEqual(
      Buffer.concat([first, second]),
    );
    await fixture.sedes.close("done");
  });

  it("settles terminal after queued data even when the next chunk lacks credit", async () => {
    const streamId = randomUUID();
    let producer!: ReturnType<SidecarProtocolPeer["openOutgoingStream"]>;
    const fixture = await streamFixture(async (sidecar, request) => {
      producer = sidecar.openOutgoingStream({
        streamId: request.streamId,
        ...capability,
        initialCreditBytes: request.initialCreditBytes,
      });
      return { streamId: request.streamId, admitted: true as const };
    });
    const order: string[] = [];
    fixture.sedes.registerIncomingStream({
      streamId,
      ...capability,
      initialCreditBytes: 1,
      terminalSchema: workspaceToolsShellTerminalSchema,
      onData: () => order.push("data"),
      onTerminal: () => order.push("terminal"),
    });
    await fixture.sedes.call(workspaceToolsShellStartOperation, {
      workspaceHandle: randomUUID(),
      operationId: randomUUID(),
      streamId,
      command: "x",
      initialCreditBytes: 1,
      timeoutMilliseconds: 1_000,
    });
    await producer.send("stdout", Buffer.from("a"));
    const blocked = producer.send("stdout", Buffer.from("b"));
    await producer.terminal(
      {
        outcome: "cancelled",
        exitCode: null,
        signal: "SIGTERM",
        stdoutBytes: 2,
        stderrBytes: 0,
        emittedBytes: 1,
        omittedBytes: 1,
        truncated: true,
      },
      workspaceToolsShellTerminalSchema,
    );
    await expect(blocked).rejects.toThrow("sidecar_stream_already_terminal");
    await vi.waitFor(() => expect(order).toEqual(["data", "terminal"]));
    await fixture.sedes.close("done");
  });

  it("cancels a producer blocked waiting for receive credit", async () => {
    const streamId = randomUUID();
    let producer!: ReturnType<SidecarProtocolPeer["openOutgoingStream"]>;
    const fixture = await streamFixture(async (sidecar, request) => {
      producer = sidecar.openOutgoingStream({
        streamId: request.streamId,
        ...capability,
        initialCreditBytes: request.initialCreditBytes,
      });
      return { streamId: request.streamId, admitted: true as const };
    });
    fixture.sedes.registerIncomingStream({
      streamId,
      ...capability,
      initialCreditBytes: 1,
      terminalSchema: workspaceToolsShellTerminalSchema,
      onData: () => undefined,
      onTerminal: () => undefined,
    });
    await fixture.sedes.call(workspaceToolsShellStartOperation, {
      workspaceHandle: randomUUID(),
      operationId: randomUUID(),
      streamId,
      command: "x",
      initialCreditBytes: 1,
      timeoutMilliseconds: 1_000,
    });
    await producer.send("data", Buffer.from("a"));
    const controller = new AbortController();
    const blocked = producer.send("data", Buffer.from("b"), {
      signal: controller.signal,
    });
    controller.abort(new Error("download_cancelled"));
    await expect(blocked).rejects.toThrow("download_cancelled");
    await fixture.sedes.close("done");
  });

  it("ignores crossed credit for a terminal stream without closing later operations", async () => {
    const streamId = randomUUID();
    let producer!: ReturnType<SidecarProtocolPeer["openOutgoingStream"]>;
    const fixture = await streamFixture(async (sidecar, request) => {
      producer = sidecar.openOutgoingStream({
        streamId: request.streamId,
        ...capability,
        initialCreditBytes: request.initialCreditBytes,
      });
      return { streamId: request.streamId, admitted: true as const };
    });
    const terminal = vi.fn();
    fixture.sedes.registerIncomingStream({
      streamId,
      ...capability,
      initialCreditBytes: 1,
      terminalSchema: workspaceToolsShellTerminalSchema,
      onData: () => undefined,
      onTerminal: terminal,
    });
    await fixture.sedes.call(workspaceToolsShellStartOperation, {
      workspaceHandle: randomUUID(),
      operationId: randomUUID(),
      streamId,
      command: "printf test",
      initialCreditBytes: 1,
      timeoutMilliseconds: 1_000,
    });
    await producer.send("stdout", Buffer.from("a"));
    await producer.terminal(
      {
        outcome: "exited",
        exitCode: 0,
        signal: null,
        stdoutBytes: 1,
        stderrBytes: 0,
        emittedBytes: 1,
        omittedBytes: 0,
        truncated: false,
      },
      workspaceToolsShellTerminalSchema,
    );
    await vi.waitFor(() => expect(terminal).toHaveBeenCalledOnce());

    await fixture.pair.left.send(
      encodeSidecarEnvelope({
        wireVersion: SIDECAR_WIRE_VERSION,
        sessionNonce: nonce,
        type: "stream_credit",
        origin: "sedes",
        streamId,
        bytes: 1,
      }),
      { lane: "control" },
    );
    await expect(
      fixture.sedes.call(workspaceContextReadOperation, {
        admissionId: randomUUID(),
        declaredPath: "/workspace",
        policyRootPath: "/workspace",
      }),
    ).resolves.toMatchObject({ fingerprint: "a".repeat(64) });
    await fixture.sedes.close("done");
  });
});

async function streamFixture(
  start?: (
    peer: SidecarProtocolPeer,
    request: z.infer<typeof workspaceToolsShellStartOperation.requestSchema>,
  ) => Promise<
    z.infer<typeof workspaceToolsShellStartOperation.responseSchema>
  >,
) {
  const pair = transportPair();
  const sedesRegistry = new SidecarOperationRegistry();
  const sidecarRegistry = new SidecarOperationRegistry();
  let sidecar!: SidecarProtocolPeer;
  sidecarRegistry.register(
    workspaceToolsShellStartOperation,
    async (request) =>
      start
        ? await start(sidecar, request)
        : { streamId: request.streamId, admitted: true },
  );
  sidecarRegistry.register(workspaceContextReadOperation, () => ({
    files: [],
    fingerprint: "a".repeat(64),
  }));
  registerControlV2Operations(sidecarRegistry, {
    buildId: "test",
    artifactSha256: "a".repeat(64),
    enabledSidecarCapabilities: [capability, contextCapability],
    enabledSedesCapabilities: [],
    capabilityEvidence: [
      {
        ...capability,
        limits: WORKSPACE_TOOLS_V2_LIMITS,
        ...WORKSPACE_TOOLS_SHELL_V2_LIMITS,
      },
      { ...contextCapability, limits: WORKSPACE_CONTEXT_V1_LIMITS },
    ],
  });
  const sedes = new SidecarProtocolPeer({
    role: "sedes",
    transport: pair.left,
    sessionNonce: nonce,
    registry: sedesRegistry,
  });
  sidecar = new SidecarProtocolPeer({
    role: "sidecar",
    transport: pair.right,
    sessionNonce: nonce,
    registry: sidecarRegistry,
  });
  sedes.start();
  sidecar.start();
  await sedes.call(controlHelloOperation, {
    expectedBuildId: "test",
    expectedArtifactSha256: "a".repeat(64),
    authorizedSidecarCapabilities: [capability, contextCapability],
    offeredSedesCapabilities: [],
  });
  return { pair, sedes, sidecar };
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
