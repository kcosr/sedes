import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOpenCodeNativeIdentity } from "../../src/server/backends/opencode/opencode-native-identity.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: { database?: string; files?: readonly string[]; relativeData?: boolean } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-native-identity-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "data", "opencode");
  await mkdir(directory, { recursive: true });
  const files = options.files ?? ["opencode-stock-channel.db"];
  for (const file of files) await writeFile(path.resolve(directory, file), "native database");
  const child = spawn(process.execPath, ["-e", `
    const fs = require('node:fs');
    for (const file of ${JSON.stringify(files.map(file => path.resolve(directory, file)))}) fs.openSync(file, 'r');
    process.stdout.write('ready\\n');
    process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
  `], { cwd: root, env: { HOME: root, XDG_DATA_HOME: options.relativeData ? "data" : path.join(root, "data"),
    ...(options.database === undefined ? {} : { OPENCODE_DB: options.database }) }, stdio: ["pipe", "pipe", "pipe"] });
  cleanups.push(() => stop(child));
  await new Promise<void>((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("error", reject);
    child.once("exit", () => reject(new Error("identity fixture exited before readiness")));
  });
  return { root, directory, pid: child.pid!, store: path.resolve(directory, files[0] ?? "opencode.db") };
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  child.stdin?.end();
  await closed;
}

describe.skipIf(process.platform !== "linux")("OpenCode observed native database discovery", () => {
  it("discovers the actual open channel database without a configured path", async () => {
    const f = await fixture();
    await expect(readOpenCodeNativeIdentity({ pid: f.pid })).resolves.toMatchObject({
      nativeStorePath: f.store, storeObservation: "open_file", pid: f.pid,
    });
  });

  it("honors the process's relative native DB and XDG roots instead of the observing process environment", async () => {
    const f = await fixture({ database: "../chosen.db", files: ["../chosen.db"], relativeData: true });
    await expect(readOpenCodeNativeIdentity({ pid: f.pid })).resolves.toMatchObject({
      nativeStorePath: f.store, storeObservation: "open_file",
    });
  });

  it.each([{ files: [] }, { files: ["opencode-first.db", "opencode-second.db"] }])("rejects missing or ambiguous native evidence: $files", async ({ files }) => {
    const f = await fixture({ files });
    await expect(readOpenCodeNativeIdentity({ pid: f.pid })).rejects.toThrow("opencode_local_process_identity_unproved");
  });

  it("rejects explicit configuration that contradicts the native process", async () => {
    const f = await fixture({ database: "chosen.db", files: ["chosen.db"] });
    const other = path.join(f.root, "other.db"); await writeFile(other, "other database");
    await expect(readOpenCodeNativeIdentity({ pid: f.pid, nativeStorePath: other })).rejects.toThrow("opencode_local_process_identity_unproved");
  });

  it("rejects a replacement path while the process retains the original database inode", async () => {
    const f = await fixture();
    await readOpenCodeNativeIdentity({ pid: f.pid });
    await rm(f.store); await writeFile(f.store, "replacement database");
    await expect(readOpenCodeNativeIdentity({ pid: f.pid })).rejects.toThrow("opencode_local_process_identity_unproved");
    await expect(readOpenCodeNativeIdentity({ pid: f.pid, nativeStorePath: f.store })).rejects.toThrow("opencode_local_process_identity_unproved");
  });
});
