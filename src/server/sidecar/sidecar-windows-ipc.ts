import * as crypto from "node:crypto";
import * as files from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Socket } from "node:net";
import { windowsSidecarPlatform } from "./sidecar-windows-platform.js";

/** The factory is serialized into the artifact-independent management carrier. */
export function createWindowsSidecarIpc(dependencies: {
  crypto: typeof crypto;
  files: typeof files;
  path: typeof path;
  home: string;
  privacy: typeof windowsSidecarPlatform.privacy;
}) {
  const { crypto, files, path, home, privacy } = dependencies;
  const keyPath = (endpoint: string) => {
    if (!/^\\\\\.\\pipe\\sedes-[a-zA-Z0-9-]+$/u.test(endpoint)) throw new Error("sidecar_windows_endpoint_invalid");
    const key = crypto.createHash("sha256").update(endpoint).digest("hex");
    return path.join(home, ".local", "state", "sedes", "sidecar", "ipc", `${key}.key`);
  };
  const readKey = async (endpoint: string) => {
    const filename = keyPath(endpoint);
    await privacy(path.dirname(filename), "assert-directory");
    await privacy(filename, "assert-file");
    const metadata = await files.lstat(filename);
    if (!metadata.isFile() || metadata.size !== 64 || metadata.nlink !== 1) throw new Error("sidecar_windows_ipc_key_invalid");
    const key = await files.readFile(filename, "utf8");
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error("sidecar_windows_ipc_key_invalid");
    return Buffer.from(key, "hex");
  };
  const prepareKey = async (endpoint: string) => {
    const filename = keyPath(endpoint);
    await privacy(path.dirname(filename), "ensure-directory");
    try {
      const handle = await files.open(filename, "wx", 0o600);
      try {
        await privacy(filename, "secure-file");
        await handle.writeFile(crypto.randomBytes(32).toString("hex"), "utf8");
        await handle.sync();
      } finally { await handle.close(); }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error;
    }
    return readKey(endpoint);
  };
  // Mutual, nonce-bound proofs protect clients against a squatted pipe as well
  // as protecting the daemon from another local account. No secret crosses IPC.
  const authenticate = async (socket: Socket, key: Buffer, role: "client" | "server", timeoutMilliseconds = 5_000) => {
    if (key.length !== 32) throw new Error("sidecar_windows_ipc_key_invalid");
    socket.pause();
    let activeReject: ((error: Error) => void) | undefined;
    let failed: Error | undefined;
    const fail = (error: Error) => {
      failed ??= error;
      activeReject?.(failed);
      socket.destroy();
    };
    const closed = () => fail(new Error("sidecar_windows_ipc_closed"));
    socket.on("error", fail);
    socket.on("close", closed);
    const timer = setTimeout(() => fail(new Error("sidecar_windows_ipc_authentication_timeout")), timeoutMilliseconds);
    const read = (size: number) => new Promise<Buffer>((resolve, reject) => {
      const cleanup = () => { socket.removeListener("readable", consume); activeReject = undefined; };
      const rejectRead = (error: Error) => { cleanup(); reject(error); };
      const consume = () => {
        const value = socket.read(size) as Buffer | null;
        if (value) { cleanup(); resolve(value); }
        else if (socket.readableEnded || socket.destroyed) rejectRead(new Error("sidecar_windows_ipc_closed"));
      };
      activeReject = rejectRead;
      if (failed) { rejectRead(failed); return; }
      socket.on("readable", consume);
      consume();
    });
    const proof = (label: string, serverNonce: Buffer, clientNonce: Buffer) => crypto.createHmac("sha256", key)
      .update(`sedes-local-ipc-v1:${label}:`).update(serverNonce).update(clientNonce).digest();
    try {
      if (role === "server") {
        const serverNonce = crypto.randomBytes(32);
        socket.write(serverNonce);
        const response = await read(64);
        const clientNonce = response.subarray(0, 32);
        if (!crypto.timingSafeEqual(response.subarray(32), proof("client", serverNonce, clientNonce))) throw new Error("sidecar_windows_ipc_authentication_failed");
        socket.write(proof("server", serverNonce, clientNonce));
      } else {
        const serverNonce = await read(32);
        const clientNonce = crypto.randomBytes(32);
        socket.write(Buffer.concat([clientNonce, proof("client", serverNonce, clientNonce)]));
        if (!crypto.timingSafeEqual(await read(32), proof("server", serverNonce, clientNonce))) throw new Error("sidecar_windows_ipc_authentication_failed");
      }
      if (failed) throw failed;
    } catch (error) {
      socket.destroy();
      throw error;
    } finally {
      clearTimeout(timer);
      socket.removeListener("error", fail);
      socket.removeListener("close", closed);
    }
  };
  return { keyPath, prepareKey, readKey, authenticate };
}

export const windowsSidecarIpc = createWindowsSidecarIpc({ crypto, files, path, home: homedir(), privacy: windowsSidecarPlatform.privacy });
