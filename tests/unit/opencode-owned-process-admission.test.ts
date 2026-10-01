import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenCodeRuntimeOwnershipLifecycle } from "../../src/server/backends/opencode/opencode-runtime-ownership.js";
import { startOpenCodeOwnedProcess, OpenCodeOwnedCleanupUnprovedError } from "../../src/server/backends/opencode/opencode-owned-process.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import * as processCleanup from "../../src/server/backends/opencode/opencode-process-cleanup.js";
import { sidecarProcessOwnership } from "../../src/server/sidecar/sidecar-process-ownership.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(version = "2.0.18", stall?: "--version" | "serve") {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-launch-admission-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const nativeStorePath = path.join(root, "opencode.db");
  const lease = await createOpenCodeRuntimeOwnershipLifecycle({ authority: { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "host" }, ownershipDirectory: root, label: "test", ownership: "owned", hostIncarnation: "launcher-test" }).acquire();
  cleanups.push(() => lease.release());
  const owner = path.join(root, (await readdir(root)).find(name => name.endsWith(".lock"))!, "owner.json"), log = path.join(root, "launched.jsonl"), executablePath = path.join(root, "opencode2"), pending = path.join(root, "pending.pid");
  await writeFile(executablePath, `#!${process.execPath}\nconst fs=require('node:fs');
const persisted=JSON.parse(fs.readFileSync(${JSON.stringify(owner)},'utf8'));
if(persisted.processMarker!==process.env.SEDES_OPENCODE_RUNTIME_OWNER) process.exit(93);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({mode:process.argv[2],marker:persisted.processMarker,cwd:process.cwd(),database:process.env.OPENCODE_DB,config:process.env.OPENCODE_CONFIG_DIR})+'\\n');
if(process.argv[2]===${JSON.stringify(stall ?? "never")}) { fs.writeFileSync(${JSON.stringify(pending)},String(process.pid)); setInterval(()=>{},1000); if(process.argv[2]==='serve') { process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); } }
else if(process.argv[2]==='--version') { process.stdout.write('opencode v${version}\\n'); }
else { process.stdout.write(JSON.stringify({url:'http://127.0.0.1:47999'})+'\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); }
`); await chmod(executablePath, 0o700);
  return { lease, log, pending, input: { executablePath, workingDirectory: root, nativeStorePath, configDirectory: root,
    environment: { HOME: root }, processMarker: lease.processMarker! } };
}

describe.skipIf(process.platform !== "linux")("OpenCode owned launch admission", () => {
  it.each(["--version", "serve"] as const)("cancels the pending %s launch and proves process cleanup before rejecting", async phase => {
    const f = await fixture("2.0.18", phase), controller = new AbortController();
    const started = startOpenCodeOwnedProcess({ ...f.input, signal: controller.signal });
    const rejected = expect(started).rejects.toThrow("opencode_request_aborted");
    let pid = 0;
    await vi.waitFor(async () => { pid = Number(await readFile(f.pending, "utf8")); expect(pid).toBeGreaterThan(0); });
    controller.abort();
    await rejected;
    expect(await sidecarProcessOwnership.readProcess(pid)).toBeUndefined();
    const records = await readFile(f.log, "utf8");
    expect(records.includes('"serve"')).toBe(phase === "serve");
  }, 10_000);
  it("uses the already-persisted marker for both release probe and resident process", async () => {
    const f = await fixture(), guard = vi.fn();
    const owner = await startOpenCodeOwnedProcess({ ...f.input, assertLaunchAdmission: guard }); cleanups.push(() => owner.stop());
    const records = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records).toEqual([expect.objectContaining({ mode: "--version", marker: f.lease.processMarker }), expect.objectContaining({ mode: "serve", marker: f.lease.processMarker })]);
    expect(guard).toHaveBeenCalledTimes(2);
    await owner.stop();
  });
  it("resolves opencode2 on the host PATH and inherits cwd without adding native path overrides", async () => {
    const f = await fixture(), root = path.dirname(f.input.executablePath);
    const owner = await startOpenCodeOwnedProcess({ environment: { HOME: root, PATH: `/missing:${root}` }, processMarker: f.lease.processMarker! });
    cleanups.push(() => owner.stop());
    expect(owner.executablePath).toBe(f.input.executablePath);
    const records = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records).toEqual([
      { mode: "--version", marker: f.lease.processMarker, cwd: process.cwd() },
      { mode: "serve", marker: f.lease.processMarker, cwd: process.cwd() },
    ]);
    await owner.stop();
  });
  it.each([1, 2])("checks synchronous service admission immediately before spawn %s", async denial => {
    const f = await fixture(); let called = 0;
    const guard = () => { if (++called === denial) throw new OpenCodeRuntimeError("opencode_controller_stale"); };
    await expect(startOpenCodeOwnedProcess({ ...f.input, assertLaunchAdmission: guard })).rejects.toThrow("opencode_controller_stale");
    const records = await readFile(f.log, "utf8").catch(() => "");
    expect(records.includes('"serve"')).toBe(false);
    expect(records.includes('"--version"')).toBe(denial === 2);
  });
  it("retains the exact cleanup closure when failed startup cleanup needs another attempt", async () => {
    const f = await fixture("0.0.0");
    const create = processCleanup.createOpenCodeProcessCleanup;
    let cleanup!: ReturnType<typeof vi.fn<() => Promise<void>>>;
    vi.spyOn(processCleanup, "createOpenCodeProcessCleanup").mockImplementation(async marker => {
      const actual = await create(marker);
      cleanup = vi.fn(actual).mockRejectedValueOnce(new Error("temporary procfs denial")); return cleanup;
    });
    const failure = await startOpenCodeOwnedProcess(f.input).catch(error => error);
    expect(failure).toBeInstanceOf(OpenCodeOwnedCleanupUnprovedError);
    expect(cleanup).toHaveBeenCalledOnce(); await failure.retryCleanup(); expect(cleanup).toHaveBeenCalledTimes(2);
    expect((await readFile(f.log, "utf8")).includes('"serve"')).toBe(false);
  });
  it("rejects a missing or replacement-shape marker without generating one", async () => {
    const f = await fixture();
    await expect(startOpenCodeOwnedProcess({ ...f.input, processMarker: "" })).rejects.toThrow("opencode_owned_marker_invalid");
    await expect(readFile(f.log)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
