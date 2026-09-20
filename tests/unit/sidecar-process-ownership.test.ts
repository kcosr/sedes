import * as fs from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createSidecarProcessOwnership } from "../../src/server/sidecar/sidecar-process-ownership.js";
import { REMOTE_SERVICE_MANAGEMENT_PROXY_SOURCE } from "../../src/server/sidecar/ssh-sidecar-management-proxy.js";

function stat(pid: number, startTime: string, parent: number, state = "S", threadCount = "1") {
  const fields = [state, String(parent), ...Array<string>(17).fill("0"), startTime];
  fields[17] = threadCount;
  return `${pid} (a process (name)) ${fields.join(" ")}`;
}
function fixture() {
  const entries = new Map<string, string>([
    ["/proc/sys/kernel/random/boot_id", "host-boot"],
    ["/proc/self/timens_offsets", "monotonic 0 0\nboottime 0 0\n"],
    ["/proc/self/status", `NSpid:\t${process.pid}\n`],
    ["/proc/1/stat", stat(1, "200", 0)],
  ]);
  let pidNamespace = "pid:[456]";
  const missing = () => Object.assign(new Error("missing"), { code: "ENOENT" });
  const files = {
    async readFile(file: string) { const entry = entries.get(file); if (entry === undefined) throw missing(); return entry; },
    async readlink(file: string) { if (file === "/proc/self/ns/pid") return pidNamespace; if (["/proc/self/ns/time", "/proc/self/ns/time_for_children"].includes(file)) return "time:[123]"; throw Object.assign(new Error("ptrace denied"), { code: "EACCES" }); },
    async statfs(file: string) { if (file !== "/proc") throw missing(); return { type: 0x9fa0 }; },
  } as unknown as typeof fs;
  return { entries, files, ownership: createSidecarProcessOwnership(files), replaceNamespace() { pidNamespace = "pid:[789]"; } };
}

describe("persistent SSH target lifetime", () => {
  it("captures the ordinary target without PID1 namespace permissions or host mounts", async () => {
    const { ownership, files } = fixture();
    const readlink = vi.spyOn(files, "readlink");
    expect(await ownership.readTargetLifetime()).toEqual({ bootId: "host-boot", pidNamespace: "pid:[456]", namespaceInitStartTime: "200", boottimeOffset: { seconds: "0", nanoseconds: 0 } });
    expect(readlink.mock.calls.every(([file]) => String(file).startsWith("/proc/self/ns/"))).toBe(true);
  });

  it("accepts an injected SSH process without requiring parent ancestry", async () => {
    const { ownership, entries } = fixture();
    entries.set(`/proc/${process.pid}/stat`, stat(process.pid, "300", 0));
    expect(await ownership.readTargetLifetime()).toMatchObject({ pidNamespace: "pid:[456]" });
  });

  it("recognizes target restart in a new PID namespace on the same host boot", async () => {
    const { ownership, replaceNamespace, entries } = fixture();
    const lifetime = await ownership.readTargetLifetime();
    replaceNamespace();
    entries.set("/proc/1/stat", stat(1, "900", 0));
    expect(await ownership.lifetimeEnded(lifetime)).toBe(true);
  });

  it("recognizes a reboot of a bare SSH host", async () => {
    const { ownership, entries } = fixture();
    const lifetime = await ownership.readTargetLifetime();
    entries.set("/proc/sys/kernel/random/boot_id", "new-host-boot");
    expect(await ownership.lifetimeEnded(lifetime)).toBe(true);
  });

  it("keeps unchanged-target ownership blocked after supervisor-only death", async () => {
    const { ownership, entries } = fixture();
    const lifetime = await ownership.readTargetLifetime();
    entries.delete(`/proc/${process.pid}/stat`);
    expect(await ownership.lifetimeEnded(lifetime)).toBe(false);
  });

  it("does not describe unavailable process identity as a dead daemon", async () => {
    const { ownership, entries } = fixture();
    entries.set("/proc/123/stat", stat(123, "300", 1));
    await expect(ownership.unavailableServiceCode({ pid: 123, startTime: "300", bootId: "host-boot", pidNamespace: "pid:[456]" }))
      .rejects.toThrow("sidecar_service_recovery_required");
  });

  it.each(["macos", "windows"])("classifies native %s ownership without assuming Linux process paths", async platformName => {
    const { files } = fixture();
    const identity = { pid: 123, startTime: "300", bootId: "platform-boot", pidNamespace: platformName };
    const readProcess = vi.fn().mockResolvedValue(identity);
    const ownership = createSidecarProcessOwnership(files, { readProcess, readTargetLifetime: vi.fn() });
    expect(await ownership.unavailableServiceCode(identity)).toBe("sidecar_service_owner_unreachable");
    readProcess.mockResolvedValue(undefined);
    expect(await ownership.unavailableServiceCode(identity)).toBe("sidecar_service_orphan_cleanup_unproven");
    readProcess.mockRejectedValue(new Error("native_identity_access_denied"));
    await expect(ownership.unavailableServiceCode(identity)).rejects.toThrow("sidecar_service_recovery_required");
  });

  it("does not treat a zombie namespace-init leader as target retirement", async () => {
    const { ownership, entries } = fixture();
    const lifetime = await ownership.readTargetLifetime();
    entries.set("/proc/1/stat", stat(1, "200", 0, "Z"));
    expect(await ownership.lifetimeEnded(lifetime)).toBe(false);
  });

  it("recognizes restart when the PID namespace inode is reused with a new init and equal clock offset", async () => {
    const { ownership, entries } = fixture();
    const lifetime = await ownership.readTargetLifetime();
    entries.set("/proc/1/stat", stat(1, "201", 0));
    expect(await ownership.lifetimeEnded(lifetime)).toBe(true);
  });

  it.each(["same init tick", "different init tick"])("fences an exact offset change with %s before timestamp comparisons", async timing => {
    const { ownership, entries } = fixture();
    const lifetime = await ownership.readTargetLifetime();
    entries.set("/proc/self/timens_offsets", "monotonic 0 0\nboottime 0 1\n");
    if (timing === "different init tick") entries.set("/proc/1/stat", stat(1, "201", 0));
    await expect(ownership.lifetimeEnded(lifetime)).rejects.toThrow("sidecar_service_recovery_required");
  });

  it("preserves a normalized negative offset exactly without floating-point conversion", async () => {
    const { ownership, entries } = fixture();
    entries.set("/proc/self/timens_offsets", "monotonic 0 0\nboottime -1 999999999\n");
    expect((await ownership.readTargetLifetime()).boottimeOffset).toEqual({ seconds: "-1", nanoseconds: 999999999 });
  });

  it.each([
    "monotonic 0 0\n", "boottime 0 0\nboottime 0 0\n", "boottime 0 1000000000\n", "boottime 0 -1\n",
    "boottime -0 0\n", "boottime 9223372036854775808 0\n", "boottime 1.5 0\n", "boottime 0 0 extra\n",
  ])("rejects malformed offset data %j", async offsets => {
    const { ownership, entries } = fixture();
    entries.set("/proc/self/timens_offsets", offsets);
    await expect(ownership.readTargetLifetime()).rejects.toThrow("sidecar_service_target_identity_unavailable");
  });

  it("records actual zero offset when the kernel exposes none of the time-namespace features", async () => {
    const { ownership, files, entries } = fixture();
    entries.delete("/proc/self/timens_offsets");
    const readlink = files.readlink.bind(files);
    vi.spyOn(files, "readlink").mockImplementation(async (file, ...options) => {
      if (["/proc/self/ns/time", "/proc/self/ns/time_for_children"].includes(String(file))) throw Object.assign(new Error("unsupported"), { code: "ENOENT" });
      return readlink(file, ...options);
    });
    expect((await ownership.readTargetLifetime()).boottimeOffset).toEqual({ seconds: "0", nanoseconds: 0 });
  });

  it.each(["offset missing", "active missing", "children missing", "permission denied", "different namespaces"])("rejects a partial or uninspectable time view: %s", async kind => {
    const { ownership, files, entries } = fixture();
    if (kind === "offset missing") entries.delete("/proc/self/timens_offsets");
    else {
      const readlink = files.readlink.bind(files);
      vi.spyOn(files, "readlink").mockImplementation(async (file, ...options) => {
        if ((kind === "active missing" && file === "/proc/self/ns/time") || (kind === "children missing" && file === "/proc/self/ns/time_for_children"))
          throw Object.assign(new Error("partial"), { code: "ENOENT" });
        if (kind === "permission denied" && file === "/proc/self/ns/time") throw Object.assign(new Error("denied"), { code: "EPERM" });
        if (kind === "different namespaces" && file === "/proc/self/ns/time_for_children") return "time:[456]";
        return readlink(file, ...options);
      });
    }
    await expect(ownership.readTargetLifetime()).rejects.toThrow("sidecar_service_target_identity_unavailable");
  });

  it.each(["ancestor", "wrong-pid", "missing-field", "missing-init", "not-proc"])("rejects a malformed %s proc view", async kind => {
    const { ownership, files, entries } = fixture();
    if (kind === "ancestor") entries.set("/proc/self/status", `NSpid:\t12345\t${process.pid}\n`);
    else if (kind === "wrong-pid") entries.set("/proc/self/status", `NSpid:\t${process.pid + 1}\n`);
    else if (kind === "missing-field") entries.set("/proc/self/status", "Name:\tnode\n");
    else if (kind === "missing-init") entries.delete("/proc/1/stat");
    else vi.spyOn(files, "statfs").mockResolvedValue({ type: 0xef53 } as Awaited<ReturnType<typeof fs.statfs>>);
    await expect(ownership.readTargetLifetime()).rejects.toThrow("sidecar_service_target_identity_unavailable");
  });

  it("rejects a target identity changing while it is captured", async () => {
    const { ownership, files } = fixture();
    const readlink = files.readlink.bind(files);
    let reads = 0;
    vi.spyOn(files, "readlink").mockImplementation(async (file, ...options) => file === "/proc/self/ns/pid" ? `pid:[${++reads === 1 ? 456 : 789}]` : readlink(file, ...options));
    await expect(ownership.readTargetLifetime()).rejects.toThrow("sidecar_service_target_identity_unavailable");
  });

  it.each(["EACCES", "EPERM"])("recognizes a reused other-account PID before its namespace rejects %s", async permission => {
    const { ownership, files, entries } = fixture();
    entries.set("/proc/77/stat", stat(77, "900", 1));
    const readlink = vi.spyOn(files, "readlink").mockRejectedValue(Object.assign(new Error("denied"), { code: permission }));
    expect(await ownership.processMatches({ pid: 77, startTime: "200", bootId: "host-boot", pidNamespace: "pid:[456]" })).toBe(false);
    expect(readlink).not.toHaveBeenCalled();
  });

  it.each(["Z", "X"])("retires an unreaped %s process only when its thread group has one thread", async state => {
    const { ownership, files, entries } = fixture();
    entries.set("/proc/77/stat", stat(77, "200", 1, state));
    const readlink = vi.spyOn(files, "readlink");
    expect(await ownership.processMatches({ pid: 77, startTime: "200", bootId: "host-boot", pidNamespace: "pid:[456]" })).toBe(false);
    expect(readlink).not.toHaveBeenCalled();
  });

  it.each(["2", "0", "invalid", ""])("keeps a zombie leader fenced when thread count is %j", async threadCount => {
    const { ownership, entries } = fixture();
    entries.set("/proc/77/stat", stat(77, "200", 1, "Z", threadCount));
    await expect(ownership.processMatches({ pid: 77, startTime: "200", bootId: "host-boot", pidNamespace: "pid:[456]" }))
      .rejects.toThrow("sidecar_service_recovery_required");
  });

  it("recognizes a previous boot before inspecting a recycled PID", async () => {
    const { ownership, files } = fixture();
    const readlink = vi.spyOn(files, "readlink");
    expect(await ownership.processMatches({ pid: 77, startTime: "200", bootId: "old-boot", pidNamespace: "pid:[456]" })).toBe(false);
    expect(readlink).not.toHaveBeenCalled();
  });

  it.each(["EACCES", "EPERM", "ENOENT"])("keeps a matching but uninspectable process fenced after namespace %s", async permission => {
    const { ownership, files, entries } = fixture();
    entries.set("/proc/77/stat", stat(77, "200", 1));
    vi.spyOn(files, "readlink").mockRejectedValue(Object.assign(new Error("denied"), { code: permission }));
    await expect(ownership.processMatches({ pid: 77, startTime: "200", bootId: "host-boot", pidNamespace: "pid:[456]" }))
      .rejects.toThrow("sidecar_service_recovery_required");
  });

  it("recognizes exit racing with the namespace lookup after rechecking stat", async () => {
    const { ownership, files, entries } = fixture();
    entries.set("/proc/77/stat", stat(77, "200", 1));
    vi.spyOn(files, "readlink").mockImplementation(async () => {
      entries.delete("/proc/77/stat");
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    });
    expect(await ownership.processMatches({ pid: 77, startTime: "200", bootId: "host-boot", pidNamespace: "pid:[456]" })).toBe(false);
  });

  it("rejects malformed and obsolete lifetime shapes without a compatibility parser", async () => {
    const { ownership } = fixture();
    expect(ownership.validLifetime({ observer: {}, namespaceInit: {} })).toBe(false);
    expect(ownership.validLifetime(null)).toBe(false);
    expect(ownership.validLifetime({ bootId: "host-boot", pidNamespace: "pid:[456]", namespaceInitStartTime: "200" })).toBe(false);
    expect(ownership.validProcess({ pid: 100, startTime: "200", bootId: "host-boot" })).toBe(false);
    await expect(ownership.lifetimeEnded({} as never)).rejects.toThrow("sidecar_service_recovery_required");
  });

  it("serializes the same target lifetime helper for the fixed remote management carrier", async () => {
    const { files } = fixture();
    const source = REMOTE_SERVICE_MANAGEMENT_PROXY_SOURCE;
    const begin = source.indexOf("const ownership=(") + "const ownership=".length;
    const end = source.indexOf(";const arg=", begin);
    const ownership = runInNewContext(source.slice(begin, end), { p: files, process: { ...process, platform: "linux" } });
    expect(await ownership.readTargetLifetime()).toMatchObject({ pidNamespace: "pid:[456]", namespaceInitStartTime: "200" });
  });
});
