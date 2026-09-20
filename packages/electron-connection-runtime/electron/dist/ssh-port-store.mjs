import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { reserveLoopbackPort, SshTunnelError, validateConnectInput } from "./ssh-tunnel-manager.mjs";

// Installation-owned native state. Retain old bindings so another SSH target
// can never inherit an origin to which the renderer bound a credential.
export class SshPortStore {
  constructor(directory, reservePort = reserveLoopbackPort) {
    this.directory = directory;
    this.reservePort = reservePort;
  }

  async portFor(rawInput) {
    const input = validateConnectInput(rawInput);
    const binding = JSON.stringify([input.profileId, input.hostAlias, input.remotePort]);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Invalid SSH port storage directory.");
    await chmod(this.directory, 0o700);
    const filename = path.join(this.directory, "ports.json");
    let entries = [];
    try {
      const file = await lstat(filename);
      if (!file.isFile() || file.isSymbolicLink()) throw new Error("Invalid SSH port storage file.");
      entries = JSON.parse(await readFile(filename, "utf8"));
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!Array.isArray(entries) || entries.some(entry => !entry || typeof entry.binding !== "string" ||
        !Number.isSafeInteger(entry.port) || entry.port < 1 || entry.port > 65535) ||
        new Set(entries.map(entry => entry.binding)).size !== entries.length ||
        new Set(entries.map(entry => entry.port)).size !== entries.length) throw new Error("Invalid SSH port storage data.");
    const existing = entries.find(entry => entry.binding === binding);
    if (existing) {
      try { await this.reservePort(existing.port); }
      catch { throw new SshTunnelError("ssh_forward_unavailable", "The saved SSH forwarding port is occupied. Stop the process using it and reconnect."); }
      return existing.port;
    }
    const used = new Set(entries.map(entry => entry.port));
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const port = await this.reservePort(0);
      if (used.has(port)) continue;
      entries.push({ binding, port });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(entries), { mode: 0o600, flag: "wx" });
        await rename(temporary, filename);
      } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
      return port;
    }
    throw new SshTunnelError("ssh_local_port_unavailable", "A distinct local forwarding port could not be allocated.");
  }
}
