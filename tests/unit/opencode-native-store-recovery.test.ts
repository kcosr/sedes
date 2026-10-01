import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, writeFile, rm, link, symlink, unlink, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOpenCodeRuntimeOwnershipLifecycle, inspectOpenCodeRuntimeOwner, recoverOpenCodeRuntimeOwner } from "../../src/server/backends/opencode/opencode-runtime-ownership.js";
import { sidecarProcessOwnership } from "../../src/server/sidecar/sidecar-process-ownership.js";

const roots: string[] = [], children: ChildProcess[] = [], descendantPids: number[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
  for (const pid of descendantPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch {} }
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(ownership: "owned" | "external" = "owned") {
  const root = await mkdtemp(path.join(os.tmpdir(), "oc-owner-recovery-")); roots.push(root);
  const authority = { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "local" };
  const lifecycle = createOpenCodeRuntimeOwnershipLifecycle({ ownershipDirectory: root, authority, label: "test", ownership, hostIncarnation: "test-incarnation" });
  return { root, authority, target: { authorityKey: lifecycle.authorityKey, ownershipDirectory: root }, lifecycle };
}
async function ownerFile(root: string) {
  return path.join(root, (await readdir(root)).find(name => name.endsWith(".lock"))!, "owner.json");
}
async function makeStale(f: Awaited<ReturnType<typeof fixture>>) {
  await f.lifecycle.acquire();
  const filename = await ownerFile(f.root), record = JSON.parse(await readFile(filename, "utf8"));
  record.process.pid = 2_000_000_000;
  await writeFile(filename, JSON.stringify(record));
  return inspectOpenCodeRuntimeOwner(f.target);
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function killedOwner(f: Awaited<ReturnType<typeof fixture>>, ownership: "owned" | "external", descendant: boolean) {
  const source = fileURLToPath(new URL("../../src/server/backends/opencode/opencode-runtime-ownership.ts", import.meta.url));
  const script = `import { createOpenCodeRuntimeOwnershipLifecycle } from ${JSON.stringify(source)};
    import { spawn } from 'node:child_process';
    const lease = await createOpenCodeRuntimeOwnershipLifecycle({ownershipDirectory:${JSON.stringify(f.root)},authority:${JSON.stringify(f.authority)},label:'killed fixture',ownership:${JSON.stringify(ownership)},hostIncarnation:'killed-service'}).acquire();
    let pid = null;
    if (${descendant}) { const child = spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {detached:true,stdio:'ignore',env:{...process.env,SEDES_OPENCODE_RUNTIME_OWNER:lease.processMarker}}); child.unref(); pid=child.pid; }
    process.stdout.write(JSON.stringify({pid})+'\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  const result = await new Promise<{ pid: number | null }>((resolve, reject) => {
    let output = "", diagnostic = "";
    child.stderr!.on("data", chunk => { diagnostic += String(chunk); });
    child.stdout!.on("data", chunk => { output += String(chunk); if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]!)); });
    child.once("exit", () => reject(new Error(`owner fixture exited: ${diagnostic}`)));
  });
  if (result.pid) descendantPids.push(result.pid);
  const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  return result.pid;
}

describe.skipIf(process.platform !== "linux")("OpenCode persisted owner recovery", () => {
  it.each(["tenantId", "principalId", "backendInstanceId", "executionEnvironmentId"] as const)(
    "leases runtime authority independently when only %s differs", async field => {
      const f = await fixture("external");
      const first = await f.lifecycle.acquire();
      const other = createOpenCodeRuntimeOwnershipLifecycle({ ownershipDirectory: f.root,
        authority: { ...f.authority, [field]: "another" }, ownership: "external", label: "other", hostIncarnation: "other-host" });
      const second = await other.acquire();
      try {
        expect(second.authorityKey).not.toBe(first.authorityKey);
        await expect(f.lifecycle.acquire()).rejects.toThrow("opencode_runtime_owner_already_owned");
        await expect(other.acquire()).rejects.toThrow("opencode_runtime_owner_already_owned");
        expect((await inspectOpenCodeRuntimeOwner(f.target)).record.authority).toEqual(f.authority);
      } finally { await first.release(); await second.release(); }
      expect(await readdir(f.root)).toEqual([]);
    });

  it("persists the exact owned marker and host incarnation before any launch", async () => {
    const f = await fixture(), lease = await f.lifecycle.acquire();
    const inspected = await inspectOpenCodeRuntimeOwner(f.target);
    expect(inspected.record).toMatchObject({ version: 1, ownership: "owned", hostIncarnation: "test-incarnation", processMarker: lease.processMarker,
      process: { pid: process.pid }, authorityKey: f.target.authorityKey, authority: f.authority });
    expect(lease.processMarker).toMatch(/^[a-f0-9]{64}$/u);
    await expect(recoverOpenCodeRuntimeOwner({ authorityKey: f.target.authorityKey, ownershipDirectory: f.root,
      expectedInspectionFingerprint: inspected.fingerprint, terminateOwnedDescendants: true })).rejects.toThrow("already_owned");
    await lease.release(); expect(await readdir(f.root)).toEqual([]);
  });

  it("releases a positively dead external attachment without native controls or signals", async () => {
    const f = await fixture("external"); await killedOwner(f, "external", false);
    const signal = vi.spyOn(process, "kill");
    const lease = await f.lifecycle.acquire();
    expect(lease.processMarker).toBeNull(); expect(signal).not.toHaveBeenCalled();
    await lease.release();
  });

  it("refuses surviving marked descendants after SIGKILL and recovers only the inspected tree", async () => {
    const f = await fixture();
    const otherLease = await createOpenCodeRuntimeOwnershipLifecycle({ authority: { ...f.authority, backendInstanceId: "other-backend" },
      ownershipDirectory: f.root, ownership: "owned", label: "unrelated runtime", hostIncarnation: "unrelated-host" }).acquire();
    const canary = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore", env: { ...process.env, SEDES_OPENCODE_RUNTIME_OWNER: otherLease.processMarker! },
    }); children.push(canary);
    const pid = (await killedOwner(f, "owned", true))!;
    const inspected = await inspectOpenCodeRuntimeOwner(f.target);
    await expect(f.lifecycle.acquire()).rejects.toThrow("opencode_runtime_owner_recovery_required");
    expect(alive(pid)).toBe(true); expect(alive(canary.pid!)).toBe(true);
    await recoverOpenCodeRuntimeOwner({ authorityKey: f.target.authorityKey, ownershipDirectory: f.root,
      expectedInspectionFingerprint: inspected.fingerprint, terminateOwnedDescendants: true });
    expect(await sidecarProcessOwnership.readProcess(pid)).toBeUndefined();
    expect(alive(canary.pid!)).toBe(true);
    const next = await f.lifecycle.acquire(); expect(next.processMarker).not.toBe(inspected.record.processMarker); await next.release();
    const exited = once(canary, "exit"); canary.kill("SIGKILL"); await exited; await otherLease.release();
  }, 20_000);

  it("reclaims a killed owned host only after proving its marker absent", async () => {
    const f = await fixture(); await killedOwner(f, "owned", false);
    const lease = await f.lifecycle.acquire(); await lease.release();
    expect(await readdir(f.root)).toEqual([]);
  });

  it("does not signal a live PID reused after the recorded external owner", async () => {
    const f = await fixture("external"); await makeStale(f);
    const filename = await ownerFile(f.root), record = JSON.parse(await readFile(filename, "utf8"));
    record.process.pid = process.pid; record.process.startTime = String(BigInt(record.process.startTime) - 1n);
    await writeFile(filename, JSON.stringify(record));
    const signal = vi.spyOn(process, "kill"); const lease = await f.lifecycle.acquire();
    expect(signal).not.toHaveBeenCalled(); expect(alive(process.pid)).toBe(true); await lease.release();
  });

  it.each(["boot", "namespace", "clock", "token", "inode"] as const)("preserves the inspected fence after %s changes", async kind => {
    const f = await fixture("external"), inspected = await makeStale(f), filename = await ownerFile(f.root);
    const record = JSON.parse(await readFile(filename, "utf8"));
    if (kind === "boot") { record.process.bootId = "different-boot"; record.lifetime.bootId = "different-boot"; }
    if (kind === "namespace") { record.process.pidNamespace = "pid:[123]"; record.lifetime.pidNamespace = "pid:[123]"; }
    if (kind === "clock") record.lifetime.boottimeOffset.seconds = "1";
    if (kind === "token") record.token = "11111111-1111-4111-8111-111111111111";
    if (kind === "inode") { await rename(filename, `${filename}.old`); await writeFile(filename, JSON.stringify(record), { mode: 0o600 }); await unlink(`${filename}.old`); }
    else await writeFile(filename, JSON.stringify(record));
    const latest = await inspectOpenCodeRuntimeOwner(f.target);
    await expect(recoverOpenCodeRuntimeOwner({ authorityKey: f.target.authorityKey, ownershipDirectory: f.root,
      expectedInspectionFingerprint: ["inode", "token"].includes(kind) ? inspected.fingerprint : latest.fingerprint,
      terminateOwnedDescendants: true })).rejects.toThrow();
    expect(await readFile(filename, "utf8")).toBe(JSON.stringify(record));
  });

  it.each(["legacy", "partial", "oversized", "hardlink", "symlink", "remnant"] as const)("preserves %s owner evidence without recovery guesses", async kind => {
    const f = await fixture("external"); await makeStale(f); const filename = await ownerFile(f.root);
    if (kind === "legacy") await writeFile(filename, JSON.stringify({ version: 1, token: "old", pid: 2_000_000_000 }));
    if (kind === "partial") await writeFile(filename, '{"version":2');
    if (kind === "oversized") await writeFile(filename, "x".repeat(8_193));
    if (kind === "hardlink") await link(filename, path.join(f.root, "linked-owner"));
    if (kind === "symlink") { await rename(filename, path.join(f.root, "real-owner")); await symlink(path.join(f.root, "real-owner"), filename); }
    if (kind === "remnant") await writeFile(path.join(path.dirname(filename), "canary"), "keep");
    await expect(f.lifecycle.acquire()).rejects.toThrow("opencode_runtime_owner_recovery_required");
    expect((await readdir(f.root)).some(name => name.endsWith(".lock"))).toBe(true);
  });

  it("preserves a stale fence when process identity inspection is ambiguous", async () => {
    const f = await fixture("external"), inspected = await makeStale(f);
    vi.spyOn(sidecarProcessOwnership, "processMatches").mockRejectedValue(new Error("procfs unavailable"));
    await expect(recoverOpenCodeRuntimeOwner({ authorityKey: f.target.authorityKey, ownershipDirectory: f.root,
      expectedInspectionFingerprint: inspected.fingerprint, terminateOwnedDescendants: true })).rejects.toThrow();
    expect((await inspectOpenCodeRuntimeOwner(f.target)).fingerprint).toBe(inspected.fingerprint);
  });
});
