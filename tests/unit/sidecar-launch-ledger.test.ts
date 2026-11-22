import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSidecarLaunchesRetired, cleanupStoppedSidecarLaunchLedger, createSidecarLaunchLedger, createSidecarLaunchProof, sidecarLaunchLedgerDirectory } from "../../src/server/sidecar/sidecar-launch-ledger.js";
import { sidecarProcessOwnership } from "../../src/server/sidecar/sidecar-process-ownership.js";

const scope = { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "environment", installationId: "installation" };
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function fixture() {
  const service = await fs.mkdtemp(path.join(tmpdir(), "sedes-launches-"));
  roots.push(service);
  const identity = await sidecarProcessOwnership.readProcess(process.pid);
  if (!identity) throw new Error("fixture PID unavailable");
  const owner = { scope, serviceIncarnation: randomUUID(), process: identity, lifetime: await sidecarProcessOwnership.readTargetLifetime() };
  const ledger = await createSidecarLaunchLedger(service, owner);
  const directory = sidecarLaunchLedgerDirectory(service, owner.serviceIncarnation);
  const records = path.join(directory, "launches");
  // Model only the daemon's loss. Observe real children through the deployed platform adapter.
  const inspect = createSidecarLaunchProof(fs, path, createHash, {
    ...sidecarProcessOwnership,
    processMatches: p => p.pid === process.pid ? Promise.resolve(false) : sidecarProcessOwnership.processMatches(p),
  });
  return { ledger, service, owner, directory, records, inspect: () => inspect.assertRetired(service, owner) };
}

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("persistent sidecar launch proof", () => {
  it("loses the positive unused witness before exposing armed launch intent", async () => {
    const { ledger, records, directory, inspect } = await fixture();
    await ledger.armOwnedProcess();
    await expect(fs.stat(path.join(directory, "unused.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(inspect()).rejects.toThrow("sidecar_service_launch_identity_unrecorded");
    // Loss of individual launch records must never turn 'used' back into zero.
    for (const name of await fs.readdir(records)) await fs.unlink(path.join(records, name));
    await expect(inspect()).rejects.toThrow("sidecar_service_launch_evidence_invalid");
  });

  it("rejects missing, malformed, or cross-incarnation evidence and read failures", async () => {
    const { service, owner, directory, inspect } = await fixture();
    await expect(createSidecarLaunchLedger(service, owner)).rejects.toMatchObject({ code: "EEXIST" });
    await fs.writeFile(path.join(directory, "unused.json"), "{}");
    await expect(inspect()).rejects.toThrow("sidecar_service_launch_evidence_invalid");
    await fs.unlink(path.join(directory, "unused.json"));
    await expect(inspect()).rejects.toThrow("sidecar_service_launch_evidence_invalid");
    const failed = createSidecarLaunchProof(fs, path, createHash, { ...sidecarProcessOwnership,
      processMatches: async () => { throw new Error("permission denied"); } });
    await expect(failed.assertRetired(service, owner)).rejects.toThrow("sidecar_service_inspection_failed");
  });

  it("refuses spawn admission if the durable arm cannot be written", async () => {
    const { ledger, records } = await fixture();
    await fs.rmdir(records);
    await expect(ledger.armOwnedProcess()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps one permanent fence per unsupported operation kind under concurrency", async () => {
    const { ledger, records, inspect } = await fixture();
    await Promise.all(Array.from({ length: 24 }, () => ledger.markUnsupported("workspace_shell")));
    expect(await fs.readdir(records)).toHaveLength(1);
    await expect(inspect()).rejects.toThrow("sidecar_service_unsupported_launch_kind");
  });

  it("cleans a stopped daemon's own records only when no native-store claim remains", async () => {
    const { ledger, owner, service, directory } = await fixture();
    await ledger.markUnsupported("workspace_shell");
    const claim = path.join(directory, "codex-claim-preserved.json");
    await fs.writeFile(claim, "claim", { mode: 0o600 });
    await cleanupStoppedSidecarLaunchLedger(service, owner);
    expect(await fs.readFile(claim, "utf8")).toBe("claim");
    await fs.unlink(claim);
    await cleanupStoppedSidecarLaunchLedger(service, { ...owner, scope: { ...owner.scope, installationId: "foreign" } });
    expect((await fs.lstat(directory)).isDirectory()).toBe(true);
    await cleanupStoppedSidecarLaunchLedger(service, owner);
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains bounded detail and permanently fences overflow before more launches", async () => {
    const { ledger, records, inspect } = await fixture();
    await Promise.all(Array.from({ length: 134 }, () => ledger.armOwnedProcess()));
    const entries = await fs.readdir(records);
    expect(entries).toHaveLength(129);
    const details = await Promise.all(entries.map(async file => JSON.parse(await fs.readFile(path.join(records, file), "utf8"))));
    expect(details.filter(r => r.kind === "launch_record_limit")).toHaveLength(1);
    await expect(inspect()).rejects.toThrow("sidecar_service_unsupported_launch_kind");
  });

  it("records an exact detached leader before returning and retains the refusal when its session vacates", async () => {
    const { ledger, records, inspect } = await fixture();
    const admission = await ledger.armOwnedProcess();
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { detached: true, stdio: "ignore" });
    const exited = once(child, "exit");
    try {
      await admission.recordSpawn(child.pid!);
      const entry = JSON.parse(await fs.readFile(path.join(records, (await fs.readdir(records))[0]!), "utf8"));
      expect(entry).toMatchObject({ state: "identified", process: await sidecarProcessOwnership.readProcess(child.pid!),
        groupId: child.pid, sessionId: child.pid });
      await expect(inspect()).rejects.toThrow("sidecar_service_live_child");
    } finally { child.kill("SIGTERM"); await exited; }
    await expect(inspect()).rejects.toThrow("sidecar_service_containment_unproven");
  });

  it("can persist a short probe's exact birth identity after exit and before its PID is reaped", async () => {
    const { ledger, records } = await fixture();
    const admission = await ledger.armOwnedProcess();
    const child = spawn("/bin/true", [], { detached: true, stdio: "ignore" });
    const exited = once(child, "exit");
    // Hold libuv on this turn, allowing even a very short probe to become a zombie.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    await admission.recordSpawn(child.pid!);
    await exited;
    const entry = JSON.parse(await fs.readFile(path.join(records, (await fs.readdir(records))[0]!), "utf8"));
    expect(entry.process).toMatchObject({ pid: child.pid, startTime: expect.stringMatching(/^\d+$/u) });
  });

  it.skipIf(process.platform !== "linux")("accepts a final-thread zombie with zero launches even while its process group remains", async () => {
    const service = await fs.mkdtemp(path.join(tmpdir(), "sedes-launches-"));
    roots.push(service);
    // Keep the actual parent blocked until this test permits a waitpid.
    const parent = spawn(process.execPath, ["-e", [
      "const child=require('node:child_process').spawn('/bin/sleep',['20'],{detached:true,stdio:'ignore'});",
      "require('fs').writeSync(1,String(child.pid)); require('fs').readSync(0,Buffer.alloc(1),0,1,null);",
      "child.kill('SIGTERM');",
    ].join("")], { stdio: ["pipe", "pipe", "inherit"] });
    const released = once(parent, "exit");
    try {
      const [bytes] = await once(parent.stdout, "data");
      const pid = Number(bytes.toString());
      const identity = await sidecarProcessOwnership.readProcess(pid);
      if (!identity) throw new Error("fixture PID unavailable");
      const owner = { scope, serviceIncarnation: randomUUID(), process: identity, lifetime: await sidecarProcessOwnership.readTargetLifetime() };
      await createSidecarLaunchLedger(service, owner);
      process.kill(pid, "SIGTERM");
      await vi.waitFor(async () => expect(await fs.readFile("/proc/" + pid + "/stat", "utf8")).toMatch(/\) Z /u));
      expect(process.kill(-pid, 0)).toBe(true);
      await expect(assertSidecarLaunchesRetired(service, owner)).resolves.toBeUndefined();
    } finally { parent.stdin.end("x"); await released; }
  });

  it.skipIf(process.platform !== "linux")("reports a surviving member of the original session after leader exit", async () => {
    const { ledger, inspect } = await fixture();
    const admission = await ledger.armOwnedProcess();
    const leader = spawn(process.execPath, ["-e", "require('child_process').spawn('/bin/sleep',['15'],{stdio:'ignore'}).unref()"],
      { detached: true, stdio: "ignore" });
    const exited = once(leader, "exit");
    try {
      await admission.recordSpawn(leader.pid!);
      await exited;
      await expect(inspect()).rejects.toThrow("sidecar_service_live_child");
    } finally { try { process.kill(-leader.pid!, "SIGTERM"); } catch { /* Already exited. */ } }
    await vi.waitFor(async () => { await expect(inspect()).rejects.toThrow("sidecar_service_containment_unproven"); });
  });
});
