import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createEnvironmentOwnedProcessIdentity } from "../../src/server/execution/environment-channel.js";
import { createOwnedProcessAssurance, FrameWriteError, type FramedMessageTransport, type FramedTransportClosure } from "../../src/server/provider-protocol/transport/assured-framed-transport.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../src/server/provider-protocol/transport/framed-message-limits.js";
import { PiRpcClient } from "../../src/server/backends/pi/native/rpc/pi-rpc-client.js";
import { parsePiNativeEntry, parsePiRpcCommand, parsePiRpcRecord, PI_RPC_MAXIMUM_BYTES } from "../../src/server/backends/pi/native/rpc/pi-rpc-wire.js";

const scope = { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "environment" };
function fixture() {
  const frames = new Readable({ objectMode: true, read() {} });
  const writes: string[] = [];
  let resolveClosed!: (closure: FramedTransportClosure) => void;
  const closed = new Promise<FramedTransportClosure>((resolve) => { resolveClosed = resolve; });
  const transport: FramedMessageTransport = {
    maximumFrameBytes: MAXIMUM_PROVIDER_FRAME_BYTES,
    assurance: createOwnedProcessAssurance(scope, 1, createEnvironmentOwnedProcessIdentity({ kind: "owned_process", scope, channelId: "channel", executable: { kind: "executable", canonicalPath: "/usr/bin/pi" }, providerProcessIdentity: { type: "local_process_group", processId: 1234, processGroupId: 1234 } }), "pi"),
    frames, closed, async send(text) { writes.push(text); return { disposition: "sent" }; },
    async close(reason) { frames.push(null); resolveClosed({ reason }); },
  };
  const client = new PiRpcClient({ transport, scope, connectionGeneration: 1 });
  function emit(value: unknown) { const text = JSON.stringify(value); frames.push({ text, byteLength: Buffer.byteLength(text) }); }
  return { client, transport, writes, emit };
}

describe("Pi native RPC client", () => {
  it("correlates interleaved events and responses and drains final responses before process exit", async () => {
    const f = fixture(); const events: unknown[] = []; f.client.subscribe((event) => events.push(event));
    const first = f.client.request({ type: "get_available_thinking_levels" });
    const second = f.client.request({ type: "prompt", message: "private input" });
    const commands = f.writes.map((line) => JSON.parse(line));
    f.emit({ type: "agent_start" });
    f.emit({ type: "response", id: commands[1].id, command: "prompt", success: true, data: { disposition: "started" } });
    f.emit({ type: "response", id: commands[0].id, command: "get_available_thinking_levels", success: true, data: { levels: ["off", "low"] } });
    await f.transport.close("exit");
    expect(await first).toEqual({ levels: ["off", "low"] });
    expect(await second).toEqual({ disposition: "started" });
    expect(events).toEqual([{ type: "agent_start" }]);
  });

  it("retires timed-out calls without resending and accepts their later response", async () => {
    const f = fixture();
    await expect(f.client.request({ type: "prompt", message: "input" }, { deadlineAt: Date.now() + 15 })).rejects.toMatchObject({ delivery: "sent_outcome_unknown" });
    expect(f.writes).toHaveLength(1);
    const id = JSON.parse(f.writes[0]!).id;
    f.emit({ type: "response", id, command: "prompt", success: true, data: { disposition: "started" } });
    const other = f.client.request({ type: "abort" }, { deadlineAt: null });
    f.emit({ type: "response", id: JSON.parse(f.writes[1]!).id, command: "abort", success: true });
    expect(await other).toBeUndefined();
    await f.client.close();
  });

  it("preserves proven non-delivery and fails closed on malformed or mismatched responses", async () => {
    const f = fixture();
    f.transport.send = async () => { throw new FrameWriteError("blocked", "not_sent"); };
    await expect(f.client.request({ type: "abort" })).rejects.toMatchObject({ delivery: "not_sent" });
    await f.client.close();
    const g = fixture();
    const pending = g.client.request({ type: "abort" });
    g.emit({ type: "response", id: JSON.parse(g.writes[0]!).id, command: "get_available_models", success: true, data: { models: [] } });
    await expect(pending).rejects.toMatchObject({ code: "pi_rpc_protocol_failed", delivery: "sent_outcome_unknown" });
    await g.client.close();
  });

  it("rejects wrong-scope carriers and closes unsafe wire envelopes", () => {
    const f = fixture();
    expect(() => new PiRpcClient({ transport: f.transport, scope: { ...scope, principalId: "other" }, connectionGeneration: 1 })).toThrow("pi_rpc_transport_assurance_invalid");
    expect(() => parsePiRpcRecord('{"type":"agent_start","unexpected":1}')).toThrow();
    expect(() => parsePiRpcRecord('{"type":"response","id":"r","command":"prompt","success":true,"data":{"disposition":"maybe"}}')).toThrow();
    expect(() => parsePiRpcCommand({ type: "prompt", message: "safe", id: "caller-controlled" })).toThrow();
    expect(PI_RPC_MAXIMUM_BYTES).toBe(MAXIMUM_PROVIDER_FRAME_BYTES);
    void f.client.close();
  });

  it("accepts the pinned native durable message shapes including system arrays and deferred completion", () => {
    const base = { type: "message", id: "entry", parentId: null, timestamp: "2026-10-26T00:00:00.000Z" };
    expect(parsePiNativeEntry({ ...base, message: { role: "system", timestamp: 1, content: [{ type: "text", text: "instruction" }], toolsAdded: [] } })).toMatchObject({ message: { role: "system" } });
    expect(parsePiNativeEntry({ ...base, message: { role: "assistant", timestamp: 1, content: [], stopReason: "deferred", api: "a", provider: "p", model: "m", usage: {} } })).toMatchObject({ message: { stopReason: "deferred" } });
    expect(parsePiNativeEntry({ ...base, type: "compaction", summary: "Complete summary", firstKeptEntryId: null, tokensBefore: 100 })).toMatchObject({ firstKeptEntryId: null });
  });

  it("allows explicit cleanup retries after a failure without reopening command admission", async () => {
    const f = fixture();
    const originalClose = f.transport.close.bind(f.transport);
    let attempts = 0;
    f.transport.close = async (reason) => { if (++attempts === 1) throw new Error("cleanup failed"); await originalClose(reason); };
    await expect(f.client.close()).rejects.toThrow("cleanup failed");
    await expect(f.client.request({ type: "abort" })).rejects.toMatchObject({ delivery: "not_sent" });
    await f.client.close();
    expect(attempts).toBe(2);
  });
});
