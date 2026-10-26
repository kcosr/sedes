import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { connect, type Socket } from "node:net";
import { PiManagedBridge } from "../../src/server/backends/pi/native/rpc/pi-managed-bridge.js";
import { PI_MANAGED_PROTOCOL_VERSION } from "../../src/server/backends/pi/native/rpc/pi-managed-protocol.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const action of cleanup.splice(0).reverse()) await action();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-diag-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const bridge = await PiManagedBridge.listen(directory, Buffer.alloc(32, 9), {
    attachmentId: "attachment", runtimeId: "runtime", handleId: "handle", handleGeneration: "generation",
    backendInstanceId: "backend", executionEnvironmentId: "environment",
  });
  cleanup.push(() => bridge.close());
  let socket!: Socket;
  await new Promise<void>((resolve, reject) => { socket = connect(bridge.socketPath, resolve); socket.once("error", reject); });
  cleanup.push(async () => { socket.destroy(); });
  return { bridge, socket, directory };
}

describe("native Pi companion diagnostics", () => {
  it.each([
    ["json_decode", "private invalid JSON\n"],
    ["schema_validation", JSON.stringify({ type: "hello", version: PI_MANAGED_PROTOCOL_VERSION, token: "private token", secret: "private payload" }) + "\n"],
    ["authentication", JSON.stringify({ type: "hello", version: PI_MANAGED_PROTOCOL_VERSION, token: "private token" }) + "\n"],
  ])("retains %s classification without logging credentials or payloads", async (stage, data) => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = await fixture();
    f.socket.write(data);
    await expect(f.bridge.closed).resolves.toEqual({ reason: "pi_managed_protocol_failed" });
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line).replace("[delivery-attachment] ", "")));
    expect(records).toContainEqual(expect.objectContaining({ event: "pi_companion_protocol_failed", stage,
      attachmentId: "attachment", runtimeId: "runtime", handleId: "handle", handleGeneration: "generation" }));
    expect(records).toContainEqual(expect.objectContaining({ event: "pi_companion_closed", reason: "pi_managed_protocol_failed", requestedClose: false }));
    expect(JSON.stringify(records)).not.toContain("private");
    expect(JSON.stringify(records)).not.toContain(f.directory);
  });

  it("distinguishes peer disconnect from a requested close", async () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = await fixture();
    f.socket.end();
    await f.bridge.closed;
    const g = await fixture();
    await g.bridge.close("pi_native_session_closed");
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line).replace("[delivery-attachment] ", "")));
    expect(records).toContainEqual(expect.objectContaining({ event: "pi_companion_closed", reason: "pi_managed_socket_closed", requestedClose: false }));
    expect(records).toContainEqual(expect.objectContaining({ event: "pi_companion_closed", reason: "pi_native_session_closed", requestedClose: true }));
  });

  it("keeps logging opt-in and preserves shutdown when the sink fails", async () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const f = await fixture();
    await f.bridge.close();
    expect(log).not.toHaveBeenCalled();
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    log.mockImplementation(() => { throw new Error("sink unavailable"); });
    const g = await fixture();
    g.socket.write("private invalid JSON\n");
    await expect(g.bridge.closed).resolves.toEqual({ reason: "pi_managed_protocol_failed" });
    await expect(g.bridge.close()).resolves.toBeUndefined();
  });
});
