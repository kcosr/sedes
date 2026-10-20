import * as crypto from "node:crypto";
import * as files from "node:fs/promises";
import { createServer, connect, type Socket } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
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
  it("publishes a complete private key and reuses it", async () => {
    const home = await files.mkdtemp(path.join(tmpdir(), "sedes-ipc-key-"));
    try {
      const keys = createWindowsSidecarIpc({ crypto, files, path, home, privacy: async (target, operation) => {
        if (operation === "ensure-directory") await files.mkdir(target, { recursive: true });
      } });
      const endpoint = "\\\\.\\pipe\\sedes-key-test";
      const key = await keys.prepareKey(endpoint);
      expect(key).toHaveLength(32);
      expect(await keys.prepareKey(endpoint)).toEqual(key);
      expect(await keys.readKey(endpoint)).toEqual(key);
      expect(await files.readdir(path.dirname(keys.keyPath(endpoint)))).toEqual([path.basename(keys.keyPath(endpoint))]);
    } finally { await files.rm(home, { recursive: true, force: true }); }
  });

  it("leaves no torn key when writing a new key fails", async () => {
    const home = await files.mkdtemp(path.join(tmpdir(), "sedes-ipc-key-"));
    try {
      let failSecure = true;
      const keys = createWindowsSidecarIpc({ crypto, files, path, home, privacy: async (target, operation) => {
        if (operation === "ensure-directory") await files.mkdir(target, { recursive: true });
        if (operation === "secure-file" && failSecure) throw new Error("sidecar_windows_privacy_invalid");
      } });
      const endpoint = "\\\\.\\pipe\\sedes-key-test";
      await expect(keys.prepareKey(endpoint)).rejects.toThrow("sidecar_windows_privacy_invalid");
      expect(await files.readdir(path.dirname(keys.keyPath(endpoint)))).toEqual([]);
      failSecure = false;
      await expect(keys.prepareKey(endpoint)).resolves.toHaveLength(32);
    } finally { await files.rm(home, { recursive: true, force: true }); }
  });

  it("removes a stale publish temporary that never linked the key", async () => {
    const home = await files.mkdtemp(path.join(tmpdir(), "sedes-ipc-key-"));
    try {
      const keys = createWindowsSidecarIpc({ crypto, files, path, home, privacy: async (target, operation) => {
        if (operation === "ensure-directory") await files.mkdir(target, { recursive: true });
      } });
      const endpoint = "\\\\.\\pipe\\sedes-key-test";
      const key = await keys.prepareKey(endpoint);
      const filename = keys.keyPath(endpoint);
      // A publish that crashed before linking, from an earlier start.
      const stale = `${filename}.${crypto.randomUUID()}`;
      await files.writeFile(stale, "0".repeat(64), { mode: 0o600 });
      const old = new Date(Date.now() - 120_000);
      await files.utimes(stale, old, old);
      // A temporary that a live writer may still own is left alone.
      const live = `${filename}.${crypto.randomUUID()}`;
      await files.writeFile(live, "", { mode: 0o600 });

      expect(await keys.prepareKey(endpoint)).toEqual(key);
      expect((await files.readdir(path.dirname(filename))).sort()).toEqual(
        [path.basename(filename), path.basename(live)].sort(),
      );
    } finally { await files.rm(home, { recursive: true, force: true }); }
  });

  it("lets every key reader finish a publish interrupted after linking", async () => {
    const home = await files.mkdtemp(path.join(tmpdir(), "sedes-ipc-key-"));
    try {
      const keys = createWindowsSidecarIpc({ crypto, files, path, home, privacy: async (target, operation) => {
        if (operation === "ensure-directory") await files.mkdir(target, { recursive: true });
      } });
      const endpoint = "\\\\.\\pipe\\sedes-key-test";
      const key = await keys.prepareKey(endpoint);
      const filename = keys.keyPath(endpoint);
      // Bootstrap inspection and client attach read the key before any
      // daemon publishes again; a just-linked temporary is finished at once.
      const leftover = `${filename}.${crypto.randomUUID()}`;
      await files.link(filename, leftover);
      // An unrelated temporary, or a hard link that is not a publication
      // temporary of this key, is never removed.
      const unlinked = `${filename}.${crypto.randomUUID()}`;
      await files.writeFile(unlinked, "0".repeat(64), { mode: 0o600 });

      await expect(keys.readKey(endpoint)).resolves.toEqual(key);
      expect((await files.readdir(path.dirname(filename))).sort()).toEqual(
        [path.basename(filename), path.basename(unlinked)].sort(),
      );
      expect((await files.lstat(filename)).nlink).toBe(1);

      const foreign = path.join(home, "foreign-link");
      await files.link(filename, foreign);
      await expect(keys.readKey(endpoint)).rejects.toThrow("sidecar_windows_ipc_key_invalid");
      expect((await files.lstat(foreign)).nlink).toBe(2);
    } finally { await files.rm(home, { recursive: true, force: true }); }
  });

  it("uses path.win32 key paths when finishing an interrupted publish", async () => {
    const entries = new Map<string, { identity: bigint; text: string }>();
    const links = (identity: bigint) => [...entries.values()].filter(entry => entry.identity === identity).length;
    const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
    const memory = {
      readdir: async (directory: string) => [...entries.keys()]
        .filter(name => path.win32.dirname(name) === directory).map(name => path.win32.basename(name)),
      lstat: async (name: string) => {
        const entry = entries.get(name);
        if (!entry) throw missing();
        return { isFile: () => true, size: 64n, nlink: BigInt(links(entry.identity)), dev: 7n, ino: entry.identity, mtimeMs: Date.now() };
      },
      unlink: async (name: string) => { if (!entries.delete(name)) throw missing(); },
      readFile: async (name: string) => {
        const entry = entries.get(name);
        if (!entry) throw missing();
        return entry.text;
      },
    } as unknown as typeof files;
    const keys = createWindowsSidecarIpc({ crypto, files: memory, path: path.win32, home: "C:\\Users\\sedes", privacy: async () => undefined });
    const endpoint = "\\\\.\\pipe\\sedes-key-test";
    const filename = keys.keyPath(endpoint);
    expect(path.win32.isAbsolute(filename)).toBe(true);
    const text = "ab".repeat(32);
    entries.set(filename, { identity: 1n, text });
    entries.set(`${filename}.${crypto.randomUUID()}`, { identity: 1n, text });

    await expect(keys.readKey(endpoint)).resolves.toEqual(Buffer.from(text, "hex"));
    expect([...entries.keys()]).toEqual([filename]);
  });

});
