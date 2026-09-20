import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDarwinSidecarPlatform, darwinSidecarPlatform } from "../../src/server/sidecar/sidecar-darwin-platform.js";
import { createSidecarProcessOwnership } from "../../src/server/sidecar/sidecar-process-ownership.js";
import { persistentSidecarPaths } from "../../src/server/sidecar/persistent-sidecar-paths.js";

function fixture() {
  let boot = "5C8E09AC-8B85-4DC9-B85D-9809CA645839";
  let start = "1752344567000042";
  const run = vi.fn(async (args: readonly string[]) => args[0] === "boot" ? boot : args[0] === "process" ? start : "");
  const platform = createDarwinSidecarPlatform(run);
  return { run, platform, ownership: createSidecarProcessOwnership(fs, platform), setBoot(value: string) { boot = value; }, setStart(value: string) { start = value; } };
}

describe("macOS persistent sidecar ownership", () => {
  it("preserves microsecond identity and boot UUID without ps truncation", async () => {
    const { ownership } = fixture();
    const identity = await ownership.readProcess(77);
    expect(identity).toEqual({ pid: 77, startTime: "1752344567000042", bootId: "5C8E09AC-8B85-4DC9-B85D-9809CA645839", pidNamespace: "macos" });
    expect(ownership.validProcess(identity)).toBe(true);
    const lifetime = await ownership.readTargetLifetime();
    expect(ownership.validLifetime(lifetime)).toBe(true);
    expect(ownership.lifetimeMatchesProcess(lifetime, identity!)).toBe(true);
    expect(await ownership.processMatches(identity!)).toBe(true);
  });
  it("rejects PID reuse within the same second", async () => {
    const { ownership, setStart } = fixture();
    const identity = await ownership.readProcess(77);
    setStart("1752344567000043");
    expect(await ownership.processMatches(identity!)).toBe(false);
  });
  it("requires host reboot before retiring unproven surviving children", async () => {
    const { ownership, setStart, setBoot } = fixture();
    const lifetime = await ownership.readTargetLifetime();
    setStart("null");
    expect(await ownership.readProcess(77)).toBeUndefined();
    expect(await ownership.lifetimeEnded(lifetime)).toBe(false);
    setBoot("6C8E09AC-8B85-4DC9-B85D-9809CA645839");
    expect(await ownership.lifetimeEnded(lifetime)).toBe(true);
  });
  it("keeps inspection errors fenced and rejects malformed native output", async () => {
    const { ownership, run } = fixture();
    const identity = await ownership.readProcess(77);
    run.mockRejectedValue(new Error("permission denied"));
    await expect(ownership.processMatches(identity!)).rejects.toThrow("sidecar_service_recovery_required");
    run.mockResolvedValue("partial native output");
    await expect(ownership.readTargetLifetime()).rejects.toThrow("sidecar_service_target_identity_unavailable");
  });
  it("rejects wall-clock or malformed boot evidence before retirement", async () => {
    const { ownership } = fixture();
    const lifetime = await ownership.readTargetLifetime();
    for (const pidNamespace of ["macos", "windows"]) {
      expect(ownership.validLifetime({ ...lifetime, pidNamespace, bootId: "638000000000000000" })).toBe(false);
      await expect(ownership.lifetimeEnded({ ...lifetime, pidNamespace, bootId: "old-boot" })).rejects.toThrow("sidecar_service_recovery_required");
    }
  });
  it("checks boot before and after reading a process", async () => {
    const { platform, run } = fixture();
    run.mockResolvedValueOnce("5C8E09AC-8B85-4DC9-B85D-9809CA645839").mockResolvedValueOnce("1752344567000042").mockResolvedValueOnce("6C8E09AC-8B85-4DC9-B85D-9809CA645839");
    await expect(platform.readProcess(77)).rejects.toThrow("sidecar_service_target_identity_unavailable");
  });
  it("passes the exact compared owner bytes to inode-pinned native retirement", async () => {
    const { platform, run } = fixture();
    await platform.retireStartupLock("/Users/example/private/startup.lock", '{"lockId":"abc"}');
    expect(run).toHaveBeenCalledWith(["retire-lock", "/Users/example/private/startup.lock", '{"lockId":"abc"}']);
  });
  it.runIf(process.platform === "darwin")("builds the native helper and reads this process on macOS", async () => {
    const identity = await darwinSidecarPlatform.readProcess(process.pid);
    expect(identity?.pid).toBe(process.pid);
    expect(identity?.pidNamespace).toBe("macos");
    expect((await darwinSidecarPlatform.readTargetLifetime()).bootId).toBe(identity?.bootId);
    const directory = await fs.mkdtemp(path.join(tmpdir(), "sedes-darwin-lock-"));
    try {
      const lock = path.join(directory, "startup.lock");
      await fs.mkdir(lock, { mode: 0o700 });
      const owner = path.join(lock, "owner.json");
      await fs.writeFile(owner, '{"lockId":"current"}', { flag: "wx", mode: 0o600 });
      await darwinSidecarPlatform.retireStartupLock(lock, '{"lockId":"old"}');
      expect(await fs.readFile(owner, "utf8")).toBe('{"lockId":"current"}');
      await darwinSidecarPlatform.retireStartupLock(lock, '{"lockId":"current"}');
      await expect(fs.lstat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    } finally { await fs.rm(directory, { recursive: true, force: true }); }
  }, 90_000);
});

describe("native persistent sidecar paths", () => {
  const scope = { installationId: "installation", tenantId: "tenant", principalId: "principal", executionEnvironmentId: "environment" };
  it("keeps macOS sockets short independently of home length", () => {
    const paths = persistentSidecarPaths(`/Users/${"long-account".repeat(20)}`, 501, scope, "darwin");
    expect(paths.endpointPath.length).toBeLessThan(100);
    expect(paths.endpointPath).toMatch(/^\/tmp\/sedes-501-/u);
  });
  it("uses a scoped Windows named pipe and native state paths", () => {
    const paths = persistentSidecarPaths("C:\\Users\\example", 0, scope, "win32");
    expect(paths.stateRoot).toBe("C:\\Users\\example\\.local\\state\\sedes\\sidecar");
    expect(paths.endpointPath).toMatch(/^\\\\\.\\pipe\\sedes-[a-f0-9]{64}$/u);
    expect(paths.serviceDirectory).toContain("\\services\\");
  });
});
