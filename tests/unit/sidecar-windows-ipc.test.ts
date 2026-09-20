import * as crypto from "node:crypto";
import * as files from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWindowsSidecarIpc } from "../../src/server/sidecar/sidecar-windows-ipc.js";

const ipc = createWindowsSidecarIpc({ crypto, files, path, home: "/unused", privacy: async () => undefined });
async function sockets() {
  let accept!: (socket: Socket) => void;
  const accepted = new Promise<Socket>(resolve => { accept = resolve; });
  const server = createServer(accept);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing port");
  const client = connect(address.port, "127.0.0.1");
  const remote = await accepted;
  client.on("error", () => undefined);
  remote.on("error", () => undefined);
  return { client, remote, close: async () => {
    client.destroy(); remote.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

describe("Windows sidecar local IPC", () => {
  it("mutually authenticates and preserves queued runtime bytes", async () => {
    const pair = await sockets();
    const key = crypto.randomBytes(32);
    try {
      const server = ipc.authenticate(pair.remote, key, "server").then(() => pair.remote.write("runtime bytes"));
      await ipc.authenticate(pair.client, key, "client");
      await server;
      const next = await pair.client[Symbol.asyncIterator]().next();
      expect(Buffer.from(next.value).toString()).toBe("runtime bytes");
    } finally { await pair.close(); }
  });
  it("rejects a client with a different private key", async () => {
    const pair = await sockets();
    try {
      const result = await Promise.allSettled([
        ipc.authenticate(pair.remote, crypto.randomBytes(32), "server"),
        ipc.authenticate(pair.client, crypto.randomBytes(32), "client"),
      ]);
      expect(result.map(value => value.status)).toEqual(["rejected", "rejected"]);
      expect(pair.remote.destroyed).toBe(true);
      expect(pair.client.destroyed).toBe(true);
    } finally { await pair.close(); }
  });
  it("rejects a squatted pipe that cannot produce the server proof", async () => {
    const pair = await sockets();
    try {
      pair.remote.write(crypto.randomBytes(32));
      pair.remote.once("data", () => pair.remote.write(Buffer.alloc(32)));
      await expect(ipc.authenticate(pair.client, crypto.randomBytes(32), "client")).rejects.toThrow("sidecar_windows_ipc_authentication_failed");
    } finally { await pair.close(); }
  });
  it("bounds unauthenticated connection lifetime", async () => {
    const pair = await sockets();
    try {
      await expect(ipc.authenticate(pair.client, crypto.randomBytes(32), "client", 20)).rejects.toThrow("sidecar_windows_ipc_authentication_timeout");
      expect(pair.client.destroyed).toBe(true);
    } finally { await pair.close(); }
  });
  it("rejects endpoint path traversal before accessing private keys", async () => {
    expect(() => ipc.keyPath("\\\\.\\pipe\\sedes-abc123")).not.toThrow();
    expect(() => ipc.keyPath("\\\\.\\pipe\\sedes-abc\\..\\outside")).toThrow("sidecar_windows_endpoint_invalid");
    expect(() => ipc.keyPath("/tmp/other.sock")).toThrow("sidecar_windows_endpoint_invalid");
  });
});
