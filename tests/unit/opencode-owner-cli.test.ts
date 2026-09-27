import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runSedesCli } from "../../src/cli/sedes-cli.js";
import { createOpenCodeNativeStoreLifecycle, inspectOpenCodeNativeStoreOwner } from "../../src/server/backends/opencode/opencode-native-store.js";
import { sidecarProcessOwnership } from "../../src/server/sidecar/sidecar-process-ownership.js";

const roots: string[] = [], children: ChildProcess[] = [], descendants: number[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const pid of descendants.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function run(args: string[]) {
  let stdout = "", stderr = "";
  const code = await runSedesCli(["opencode-owner", ...args], {
    // Recovery must be usable in an ordinary host shell, without agent-tool configuration.
    environment: { SEDES_AGENT_TOOL_CLI_MODE: "invalid", SEDES_AGENT_TOOL_ENDPOINT: "invalid" },
    io: { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } },
  });
  return { code, stdout, stderr };
}
async function fixture(ownership: "owned" | "external" = "external") {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-owner-cli-")); roots.push(root);
  const store = path.join(root, "opencode.db");
  const lifecycle = createOpenCodeNativeStoreLifecycle({ canonicalStorePath: store, label: "CLI test", ownership, hostIncarnation: "cli-test" });
  return { root, store, lifecycle };
}
async function staleOwner(f: Awaited<ReturnType<typeof fixture>>) {
  await f.lifecycle.acquire();
  const owner = path.join(f.root, (await readdir(f.root)).find(name => name.endsWith(".lock"))!, "owner.json");
  const record = JSON.parse(await readFile(owner, "utf8")); record.process.pid = 2_000_000_000;
  await writeFile(owner, JSON.stringify(record));
  return { owner, fingerprint: (await inspectOpenCodeNativeStoreOwner(f.store)).fingerprint };
}
async function killedOwner(f: Awaited<ReturnType<typeof fixture>>) {
  const source = fileURLToPath(new URL("../../src/server/backends/opencode/opencode-native-store.ts", import.meta.url));
  const script = `import { createOpenCodeNativeStoreLifecycle } from ${JSON.stringify(source)};
    import { spawn } from 'node:child_process';
    const lease = await createOpenCodeNativeStoreLifecycle({canonicalStorePath:${JSON.stringify(f.store)},label:'CLI test',ownership:'owned',hostIncarnation:'killed-cli-test'}).acquire();
    const child = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {detached:true,stdio:'ignore',env:{...process.env,SEDES_OPENCODE_RUNTIME_OWNER:lease.processMarker}});
    child.unref(); process.stdout.write(JSON.stringify({pid:child.pid})+'\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  const pid = await new Promise<number>((resolve, reject) => {
    let output = "", stderr = "";
    child.stderr!.on("data", chunk => { stderr += String(chunk); });
    child.stdout!.on("data", chunk => { output += String(chunk); if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]!).pid); });
    child.once("exit", () => reject(new Error(stderr)));
  });
  descendants.push(pid); const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  return pid;
}

describe("OpenCode host owner command grammar", () => {
  it("provides help without configuring agent tools", async () => {
    const result = await run(["--help"]); expect(result.code).toBe(0); expect(result.stdout).toContain("--expected-inspection");
  });
  it.each([
    [], ["delete", "--store", "/store"], ["inspect"], ["inspect", "--store"],
    ["inspect", "--store", "relative"], ["inspect", "--store", "/store/../db"],
    ["inspect", "--store", "/db", "--store", "/db"], ["inspect", "--store", "/db", "--terminate-owned-descendants"],
    ["recover", "--store", "/db"], ["recover", "--store", "/db", "--expected-inspection", "latest"],
    ["recover", "--store", "/db", "--expected-inspection", "a".repeat(64), "--expected-inspection", "a".repeat(64)],
    ["recover", "--store", "/db", "--expected-inspection", "a".repeat(64), "--pid", "123"],
  ])("refuses malformed arguments %j", async (...args) => { expect((await run(args as string[])).code).toBe(2); });
});

describe.skipIf(process.platform !== "linux")("OpenCode host owner recovery", () => {
  it("inspects without exposing private tokens and refuses a live owner", async () => {
    const f = await fixture(), lease = await f.lifecycle.acquire();
    try {
      const result = await run(["inspect", "--store", f.store]); expect(result.code).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value).toEqual({ store: f.store, ownership: "external", hostIncarnation: "cli-test", ownerPid: process.pid, inspectionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      const refused = await run(["recover", "--store", f.store, "--expected-inspection", value.inspectionFingerprint]);
      expect(refused.code).toBe(1); expect(refused.stderr).toContain("already_owned");
      expect((await inspectOpenCodeNativeStoreOwner(f.store)).fingerprint).toBe(value.inspectionFingerprint);
    } finally { await lease.release(); }
  });
  it("requires a current fingerprint and preserves malformed records", async () => {
    const f = await fixture(), { owner, fingerprint } = await staleOwner(f);
    const record = JSON.parse(await readFile(owner, "utf8")); record.hostIncarnation = "changed";
    await writeFile(owner, JSON.stringify(record));
    const stale = await run(["recover", "--store", f.store, "--expected-inspection", fingerprint]);
    expect(stale.code).toBe(1); expect(stale.stderr).toContain("recovery_changed");
    await writeFile(owner, '{"partial":');
    expect((await run(["inspect", "--store", f.store])).code).toBe(1);
    expect((await run(["recover", "--store", f.store, "--expected-inspection", fingerprint])).code).toBe(1);
    expect(await readFile(owner, "utf8")).toBe('{"partial":');
  });
  it("retires only the external attachment record and leaves the independent daemon alive", async () => {
    const f = await fixture(), { fingerprint } = await staleOwner(f);
    const daemon = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" }); children.push(daemon);
    const result = await run(["recover", "--store", f.store, "--expected-inspection", fingerprint, "--terminate-owned-descendants"]);
    expect(result.code).toBe(0); expect(JSON.parse(result.stdout)).toEqual({ store: f.store, recovered: true });
    expect(await readdir(f.root)).toEqual([]); expect(await sidecarProcessOwnership.readProcess(daemon.pid!)).toBeDefined();
  });
  it("requires explicit termination before recovering a killed owner's surviving marked children", async () => {
    const f = await fixture("owned"), pid = await killedOwner(f);
    const { inspectionFingerprint } = JSON.parse((await run(["inspect", "--store", f.store])).stdout);
    const args = ["recover", "--store", f.store, "--expected-inspection", inspectionFingerprint];
    expect((await run(args)).code).toBe(1); expect(await sidecarProcessOwnership.readProcess(pid)).toBeDefined();
    expect((await run([...args, "--terminate-owned-descendants"])).code).toBe(0);
    expect(await sidecarProcessOwnership.readProcess(pid)).toBeUndefined(); expect(await readdir(f.root)).toEqual([]);
  }, 20_000);
});
