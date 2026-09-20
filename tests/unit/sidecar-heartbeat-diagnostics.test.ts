import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import {
  LengthPrefixedSidecarFrameTransport, SidecarOperationRegistry, SidecarProtocolPeer,
  controlHelloOperation, controlPingOperation, registerControlV2Operations,
  type SidecarByteStream, type SidecarByteStreamClosure, type SidecarHeartbeatDiagnostic,
} from "../../src/internal/sidecar-protocol/index.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it.each([{ enabled: false, throws: false }, { enabled: true, throws: false }, { enabled: true, throws: true }])(
  "traces the complete heartbeat path on both peers without payloads (enabled=$enabled, throws=$throws)",
  async ({ enabled, throws }) => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", enabled ? "1" : "");
    const f = await fixture(throws);
    try {
      expect(f.records).toEqual([]); // The authenticated handshake is never traced.
      await expect(f.main.call(controlPingOperation, { pingId: "6fd47adc-953a-4c4e-9153-cd67ff3a1b9c" })).resolves.toEqual({ pingId: "6fd47adc-953a-4c4e-9153-cd67ff3a1b9c" });
      if (!enabled) { expect(f.records).toEqual([]); return; }
      expect(new Set(f.records.map(record => record.requestId)).size).toBe(1);
      for (const [role, stages] of [
        ["sedes", ["request_queued", "request_frame_queued", "request_frame_write_start", "request_frame_write_complete", "response_parsed"]],
        ["sidecar", ["request_received", "handler_start", "handler_complete", "response_queued", "response_frame_queued", "response_frame_write_start", "response_frame_write_complete"]],
      ] as const) {
        const observed = f.records.filter(record => record.role === role).map(record => record.stage);
        expect(observed).toEqual(expect.arrayContaining([...stages]));
        for (let index = 1; index < stages.length; index++) expect(observed.indexOf(stages[index]!)).toBeGreaterThan(observed.indexOf(stages[index - 1]!));
      }
      expect(f.records).toEqual(expect.arrayContaining([
        expect.objectContaining({ stage: "request_frame_write_start", carrierGeneration: 7, activeWriteBytes: expect.any(Number) }),
        expect.objectContaining({ stage: "response_parsed", outcome: "ok", durationMs: expect.any(Number) }),
      ]));
      expect(JSON.stringify(f.records)).not.toMatch(/private-|sessionNonce|payload|6fd47adc-953a-4c4e-9153-cd67ff3a1b9c/u);
    } finally { await f.close(); }
  },
);

it("distinguishes a queued ping from a ping whose byte-stream write has started", async () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
  const f = await fixture();
  const release = f.streams.left.block();
  try {
    const first = f.main.call(controlPingOperation, { pingId: "ee1e9cb7-2271-41cc-8c2b-5139b7a8cf40" });
    const second = f.main.call(controlPingOperation, { pingId: "0d46fa3f-e4aa-418a-be50-532fba3958b0" });
    const queued = f.records.filter(record => record.role === "sedes" && record.stage === "request_queued");
    expect(queued).toHaveLength(2);
    const secondId = queued[1]!.requestId;
    expect(f.records.filter(record => record.requestId === secondId).map(record => record.stage)).toEqual(["request_queued", "request_frame_queued"]);
    expect(f.records.find(record => record.requestId === secondId && record.stage === "request_frame_queued")).toMatchObject({
      queuedWriteBytes: expect.any(Number), queuedWriteFrames: 1, activeWriteBytes: expect.any(Number),
    });
    release();
    await expect(first).resolves.toEqual({ pingId: "ee1e9cb7-2271-41cc-8c2b-5139b7a8cf40" });
    await expect(second).resolves.toEqual({ pingId: "0d46fa3f-e4aa-418a-be50-532fba3958b0" });
    expect(f.records).toEqual(expect.arrayContaining([expect.objectContaining({ requestId: secondId, stage: "request_frame_write_start" })]));
  } finally { release(); await f.close(); }
});

it("locates a blocked response write without changing the existing heartbeat timeout", async () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
  const f = await fixture();
  const release = f.streams.right.block();
  vi.useFakeTimers();
  try {
    const pending = f.main.call(controlPingOperation, { pingId: "6fd47adc-953a-4c4e-9153-cd67ff3a1b9c" }, { deadlineMilliseconds: 1000 });
    const result = expect(pending).rejects.toMatchObject({ message: "sidecar_request_timeout", delivery: "sent_outcome_unknown" });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "sidecar", stage: "handler_complete", outcome: "ok" }),
      expect.objectContaining({ role: "sidecar", stage: "response_frame_write_start" }),
    ]));
    expect(f.records.some(record => record.stage === "response_parsed")).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await result;
    expect(f.records).toEqual(expect.arrayContaining([expect.objectContaining({ role: "sedes", stage: "request_cancelled" })]));
    expect(new Set(f.records.map(record => record.requestId)).size).toBe(1);
  } finally { release(); await f.close(); }
});

it.each([false, true])("supports a private operator gate and isolates its failures (throws=%s)", async throws => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "");
  const f = await fixture(false, () => { if (throws) throw new Error("gate_failed"); return true; });
  try {
    await expect(f.main.call(controlPingOperation, { pingId: "6fd47adc-953a-4c4e-9153-cd67ff3a1b9c" })).resolves.toBeDefined();
    expect(f.records.length > 0).toBe(!throws);
    if (!throws) expect(new Set(f.records.map(record => record.role))).toEqual(new Set(["sedes", "sidecar"]));
  } finally { await f.close(); }
});

async function fixture(throwObserver = false, diagnosticsEnabled?: () => boolean) {
  const records: SidecarHeartbeatDiagnostic[] = [];
  const streams = streamPair();
  const mainRegistry = new SidecarOperationRegistry();
  const sidecarRegistry = new SidecarOperationRegistry();
  registerControlV2Operations(sidecarRegistry, { buildId: "test", artifactSha256: "a".repeat(64), enabledSidecarCapabilities: [], enabledSedesCapabilities: [] });
  const observe = (record: SidecarHeartbeatDiagnostic) => { records.push(record); if (throwObserver) throw new Error("private-observer-error"); };
  const main = new SidecarProtocolPeer({ role: "sedes", registry: mainRegistry, sessionNonce: "private-authentication-nonce-000000000000000000000",
    transport: new LengthPrefixedSidecarFrameTransport({ assurance: { kind: "test", carrierGeneration: 7 }, stream: streams.left }), onDiagnostic: observe, diagnosticsEnabled });
  const sidecar = new SidecarProtocolPeer({ role: "sidecar", registry: sidecarRegistry, sessionNonce: "private-authentication-nonce-000000000000000000000",
    transport: new LengthPrefixedSidecarFrameTransport({ assurance: { kind: "test", carrierGeneration: 7 }, stream: streams.right }), onDiagnostic: observe, diagnosticsEnabled });
  main.start(); sidecar.start();
  await main.call(controlHelloOperation, { expectedBuildId: "test", expectedArtifactSha256: "a".repeat(64), authorizedSidecarCapabilities: [], offeredSedesCapabilities: [] });
  return { main, sidecar, records, streams, close: async () => { await main.close("test_complete"); await sidecar.close("test_complete"); } };
}

function streamPair() {
  const leftBytes = new PassThrough();
  const rightBytes = new PassThrough();
  let resolveClosed!: (closure: SidecarByteStreamClosure) => void;
  const closed = new Promise<SidecarByteStreamClosure>(resolve => { resolveClosed = resolve; });
  const make = (bytes: PassThrough, target: PassThrough): SidecarByteStream & { block(): () => void } => {
    let blocked: Promise<void> | undefined;
    return { bytes, closed,
      block() { let release!: () => void; blocked = new Promise<void>(resolve => { release = resolve; }); return () => { blocked = undefined; release(); }; },
      async write(value) { if (blocked) await blocked; if (!target.writableEnded) target.write(value); },
      async close(reason) { leftBytes.end(); rightBytes.end(); resolveClosed({ reason }); },
    };
  };
  return { left: make(leftBytes, rightBytes), right: make(rightBytes, leftBytes) };
}
