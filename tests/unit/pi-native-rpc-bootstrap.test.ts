import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { chmod, lstat, mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PiManagedBridge } from "../../src/server/backends/pi/native/rpc/pi-managed-bridge.js";
import { piManagedExtension } from "../../src/server/backends/pi/native/rpc/pi-managed-extension.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); vi.unstubAllEnvs(); });
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "sp-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const key = randomBytes(32);
  const bridge = await PiManagedBridge.listen(directory, key);
  cleanup.push(() => bridge.close());
  const bootstrap = JSON.parse(await readFile(bridge.bootstrapPath, "utf8")) as { version: number; socketPath: string; token: string };
  const socket = connect(bridge.socketPath);
  cleanup.push(async () => { socket.destroy(); });
  const frames: Record<string, unknown>[] = [];
  let buffered = "";
  socket.on("data", data => {
    buffered += data.toString("utf8");
    let index: number;
    while ((index = buffered.indexOf("\n")) >= 0) { frames.push(JSON.parse(buffered.slice(0, index))); buffered = buffered.slice(index + 1); }
  });
  await once(socket, "connect");
  return { bridge, key, bootstrap, socket, frames };
}
const state = { sessionId: "session", entries: [], leafId: null, operations: [], toolCalls: [], toolResults: [], tools: [], activeTools: [], isIdle: true };

describe.skipIf(process.platform === "win32")("native Pi private bootstrap", () => {
  it("keeps only a one-use capability on disk and transfers the key after authentication", async () => {
    const f = await fixture();
    expect((await lstat(f.bridge.bootstrapPath)).mode & 0o777).toBe(0o600);
    expect(Object.keys(f.bootstrap).sort()).toEqual(["socketPath", "token", "version"]);
    expect(JSON.stringify(f.bootstrap)).not.toContain(f.key.toString("base64url"));
    await unlink(f.bridge.bootstrapPath);
    f.socket.write(JSON.stringify({ type: "hello", version: 2, token: f.bootstrap.token }) + "\n");
    await vi.waitFor(() => expect(f.frames).toHaveLength(1));
    expect(f.frames[0]).toEqual({ type: "initialize", version: 2, authenticationKey: f.key.toString("base64url") });
    await expect(f.bridge.request({ type: "snapshot" })).rejects.toMatchObject({ delivery: "not_sent" });
    f.socket.write(JSON.stringify({ type: "ready", state }) + "\n");
    await expect(f.bridge.ready).resolves.toEqual(state);
    await expect(readFile(f.bridge.bootstrapPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["wrong_token", "unconsumed_bootstrap", "missing_hello"] as const)("never sends the key for %s", async failure => {
    const f = await fixture();
    if (failure !== "unconsumed_bootstrap") await unlink(f.bridge.bootstrapPath);
    f.socket.write(JSON.stringify(failure === "missing_hello" ? { type: "ready", state }
      : { type: "hello", version: 2, token: failure === "wrong_token" ? randomBytes(32).toString("base64url") : f.bootstrap.token }) + "\n");
    await f.bridge.closed;
    expect(f.frames).toEqual([]);
    await expect(f.bridge.ready).rejects.toThrow();
  });

  it("rejects a bootstrap readable by other accounts before installing any native factory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sp-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const bridge = await PiManagedBridge.listen(directory, randomBytes(32));
    cleanup.push(() => bridge.close());
    await chmod(bridge.bootstrapPath, 0o640);
    vi.stubEnv("SEDES_PI_BOOTSTRAP_FILE", bridge.bootstrapPath);
    const factory = vi.fn();
    await expect(piManagedExtension({} as Parameters<typeof piManagedExtension>[0], factory, factory, factory, { net, crypto, fs }))
      .rejects.toThrow("pi_managed_bootstrap_invalid");
    expect(factory).not.toHaveBeenCalled();
  });
});
