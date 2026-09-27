import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenCodeNativeStoreLifecycle } from "../../src/server/backends/opencode/opencode-native-store.js";
import { startOpenCodeOwnedProcess, OpenCodeOwnedCleanupUnprovedError } from "../../src/server/backends/opencode/opencode-owned-process.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import * as processCleanup from "../../src/server/backends/opencode/opencode-process-cleanup.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close(); });
async function fixture(version = "2.0.18") {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-launch-admission-")); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const nativeStorePath = path.join(root, "opencode.db");
  const lease = await createOpenCodeNativeStoreLifecycle({ canonicalStorePath: nativeStorePath, label: "test", ownership: "owned", hostIncarnation: "launcher-test" }).acquire();
  cleanups.push(() => lease.release());
  const owner = path.join(root, (await readdir(root)).find(name => name.endsWith(".lock"))!, "owner.json"), log = path.join(root, "launched.jsonl"), executablePath = path.join(root, "opencode2");
  await writeFile(executablePath, `#!${process.execPath}\nconst fs=require('node:fs');
const persisted=JSON.parse(fs.readFileSync(${JSON.stringify(owner)},'utf8'));
if(persisted.processMarker!==process.env.SEDES_OPENCODE_RUNTIME_OWNER) process.exit(93);
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({mode:process.argv[2],marker:persisted.processMarker})+'\\n');
if(process.argv[2]==='--version') { process.stdout.write('opencode v${version}\\n'); }
else { process.stdout.write(JSON.stringify({url:'http://127.0.0.1:47999'})+'\\n'); process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); }
`); await chmod(executablePath, 0o700);
  return { lease, log, input: { executablePath, workingDirectory: root, nativeStorePath, configDirectory: root,
    environment: { HOME: root }, processMarker: lease.processMarker! } };
}

describe.skipIf(process.platform !== "linux")("OpenCode owned launch admission", () => {
  it("uses the already-persisted marker for both release probe and resident process", async () => {
    const f = await fixture(), guard = vi.fn();
    const owner = await startOpenCodeOwnedProcess({ ...f.input, assertLaunchAdmission: guard }); cleanups.push(() => owner.stop());
    const records = (await readFile(f.log, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(records).toEqual([{ mode: "--version", marker: f.lease.processMarker }, { mode: "serve", marker: f.lease.processMarker }]);
    expect(guard).toHaveBeenCalledTimes(2);
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
