import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWindowsSidecarPlatform } from "../../src/server/sidecar/sidecar-windows-platform.js";
import { verifyWindowsSidecarPrivacyBatch } from "../helpers/windows-sidecar-privacy-contract.js";

const sid = "S-1-5-21-100-200-300-1001";
const directoryAcl = { sid, owner: sid, directory: true, protected: true, readOnly: false,
  rules: [{ sid, allow: true, rights: 2032127, inheritance: 3, propagation: 0 }] };
const bootId = "windows-142d90b9-bfbe-4533-a919-15472ff10309";
const startTicks = "639301234567890123";

describe("Windows sidecar platform", () => {
  it.skipIf(process.platform !== "win32")(
    "preserves native empty, singleton and mixed ACL batches and rejects a foreign owner",
    async () => {
      await verifyWindowsSidecarPrivacyBatch();
    },
    180_000,
  );
  it("retains kernel creation timestamp precision and treats only confirmed absence as dead", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ bootId, startTicks, pid: 42 }) });
    const platform = createWindowsSidecarPlatform(run, "C:\\Windows");
    await expect(platform.readProcess(42)).resolves.toEqual({ pid: 42, startTime: startTicks, bootId: bootId, pidNamespace: "windows" });
    run.mockResolvedValue({ stdout: JSON.stringify({ bootId, startTicks: null, pid: 42 }) });
    await expect(platform.readProcess(42)).resolves.toBeUndefined();
    run.mockRejectedValue(new Error("access_denied"));
    await expect(platform.readProcess(42)).rejects.toThrow("access_denied");
  });
  it("reads boot-scoped lifetime and rejects incomplete or rounded native identity", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ bootId, startTicks: null, pid: 0 }) });
    const platform = createWindowsSidecarPlatform(run, "C:\\Windows");
    await expect(platform.readTargetLifetime()).resolves.toEqual({ bootId: bootId, pidNamespace: "windows", namespaceInitStartTime: "0", boottimeOffset: { seconds: "0", nanoseconds: 0 } });
    for (const value of [{ bootId, pid: 42 }, { bootId, startTicks: 639301234567890123, pid: 42 }, { bootId: "", startTicks, pid: 42 }, { bootId: "windows-00000000-0000-0000-0000-000000000000", startTicks, pid: 42 }, { bootId: "windows-639300000000000000", startTicks, pid: 42 }, { bootId, startTicks, pid: 41 }]) {
      run.mockResolvedValue({ stdout: JSON.stringify(value) });
      await expect(platform.readProcess(42)).rejects.toThrow("sidecar_service_target_identity_unavailable");
    }
  });
  it("passes hostile paths as data and requires exact current-owner ACL evidence", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify(directoryAcl) });
    const platform = createWindowsSidecarPlatform(run, "C:\\Windows");
    const filename = "C:\\private\\'; throw 'injected'";
    await platform.privacy(filename, "ensure-directory");
    const [executable, args, options] = run.mock.calls[0]!;
    expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(Buffer.from(args.at(-1), "base64").toString("utf16le")).not.toContain(filename);
    expect(options).toMatchObject({ timeout: 15000, maxBuffer: 65536, windowsHide: true, env: { SEDES_SIDECAR_PRIVATE_PATH: path.win32.toNamespacedPath(filename) } });
    for (const value of [{ ...directoryAcl, owner: "S-1-5-18" }, { ...directoryAcl, protected: false }, { ...directoryAcl, rules: [] }, { ...directoryAcl, rules: [...directoryAcl.rules, { sid: "S-1-1-0", allow: true, rights: 2032127 }] }]) {
      run.mockResolvedValue({ stdout: JSON.stringify(value) });
      await expect(platform.privacy(filename, "assert-directory")).rejects.toThrow("sidecar_windows_privacy_invalid");
    }
  });
  it("accepts sealed executable ACL only when writes are excluded and readonly set", async () => {
    const executable = { ...directoryAcl, directory: false, readOnly: true, rules: [{ sid, allow: true, rights: 1245609, inheritance: 0, propagation: 0 }] };
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify(executable) });
    const platform = createWindowsSidecarPlatform(run, "C:\\Windows");
    await expect(platform.privacy("C:\\private\\sidecar.exe", "secure-executable")).resolves.toBeUndefined();
    run.mockResolvedValue({ stdout: JSON.stringify({ ...executable, readOnly: false }) });
    await expect(platform.privacy("C:\\private\\sidecar.exe", "assert-executable")).rejects.toThrow("sidecar_windows_privacy_invalid");
  });
  it("batches path-scoped ACL evidence in one process and reinspects it on every call", async () => {
    let invalidOwner = false;
    const run = vi.fn().mockImplementation(async (_executable, _args, options) => {
      const requests = JSON.parse(options.env.SEDES_SIDECAR_PRIVATE_BATCH);
      return { stdout: JSON.stringify(requests.map((entry: { filename: string; operation: string }, index: number) => ({
        index, ...entry, evidence: { ...directoryAcl, ...(invalidOwner && index === 1 ? { owner: "S-1-5-18" } : {}) },
      }))) };
    });
    const platform = createWindowsSidecarPlatform(run, "C:\\Windows");
    const entries = Array.from({ length: 16 }, (_, index) => ({ filename: `C:\\private\\entry-${index}`, operation: "assert-directory" as const }));
    entries[0]!.filename = "C:\\private\\'; throw 'injected'";
    await platform.privacyBatch(entries);
    expect(run).toHaveBeenCalledTimes(1);
    const [, args, options] = run.mock.calls[0]!;
    expect(Buffer.from(args.at(-1), "base64").toString("utf16le")).not.toContain(entries[0]!.filename);
    expect(JSON.parse(options.env.SEDES_SIDECAR_PRIVATE_BATCH)[0].filename).toBe(path.win32.toNamespacedPath(entries[0]!.filename));
    invalidOwner = true;
    await expect(platform.privacyBatch(entries)).rejects.toThrow("sidecar_windows_privacy_invalid");
    expect(run).toHaveBeenCalledTimes(2);
  });
  it("rejects missing, truncated, or reordered batched evidence", async () => {
    const entry = { filename: "C:\\private", operation: "assert-directory" as const };
    const valid = { index: 0, filename: path.win32.toNamespacedPath(entry.filename), operation: entry.operation, evidence: directoryAcl };
    const run = vi.fn();
    const platform = createWindowsSidecarPlatform(run, "C:\\Windows");
    for (const result of [[], [valid, valid], [{ ...valid, index: 1 }], [{ ...valid, filename: "C:\\elsewhere" }], [{ ...valid, operation: "ensure-directory" }]]) {
      run.mockResolvedValue({ stdout: JSON.stringify(result) });
      await expect(platform.privacyBatch([entry])).rejects.toThrow("sidecar_windows_privacy_invalid");
    }
    run.mockResolvedValue({ stdout: JSON.stringify([{ ...valid, evidence: { missing: true } }]) });
    await expect(platform.privacyBatch([entry])).rejects.toMatchObject({ code: "ENOENT" });
    await expect(platform.privacyBatch(Array(65).fill(entry))).rejects.toThrow("sidecar_windows_privacy_batch_invalid");
  });
  it("splits large batches before exceeding bounded native transport bytes", async () => {
    const run = vi.fn().mockImplementation(async (_executable, _args, options) => {
      const json = options.env.SEDES_SIDECAR_PRIVATE_BATCH;
      expect(Buffer.byteLength(json, "utf8")).toBeLessThanOrEqual(24_000);
      return { stdout: JSON.stringify(JSON.parse(json).map((entry: { filename: string; operation: string }, index: number) => ({ index, ...entry, evidence: directoryAcl }))) };
    });
    const platform = createWindowsSidecarPlatform(run, "C:\\Windows");
    await platform.privacyBatch(Array.from({ length: 4 }, (_, index) => ({ filename: `C:\\${"long-name".repeat(1_200)}-${index}`, operation: "assert-directory" })));
    expect(run).toHaveBeenCalledTimes(2);
  });
  it.skipIf(process.platform !== "win32")("verifies native identity, private files, and pinned lock retirement", async () => {
    const platform = createWindowsSidecarPlatform(promisify(execFile));
    const identity = await platform.readProcess(process.pid);
    expect(identity?.startTime).toMatch(/^[0-9]{18}$/u);
    expect(identity?.bootId).toBe((await platform.readTargetLifetime()).bootId);
    const root = await mkdtemp(path.join(tmpdir(), "sedes-platform-"));
    try {
      const lock = path.join(root, "startup.lock");
      await platform.privacy(lock, "ensure-directory");
      const owner = path.join(lock, "owner.json");
      await writeFile(owner, '{"pid":42}');
      await platform.privacy(owner, "secure-file");
      await platform.privacyBatch([{ filename: lock, operation: "assert-directory" }, { filename: owner, operation: "assert-file" }]);
      await expect(platform.retireStartupLock(lock, '{"pid":41}')).rejects.toThrow();
      expect(await readFile(owner, "utf8")).toBe('{"pid":42}');
      await expect(platform.retireStartupLock(lock, '{"pid":42}')).resolves.toBe(true);
      await expect(readFile(owner)).rejects.toMatchObject({ code: "ENOENT" });
      const filename = path.join(root, "executable.bin");
      await platform.privacy(root, "ensure-directory");
      await writeFile(filename, "executable");
      await platform.privacy(filename, "secure-executable");
      await platform.privacy(filename, "assert-executable");
      await expect(writeFile(filename, "overwrite")).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 180_000);
});
