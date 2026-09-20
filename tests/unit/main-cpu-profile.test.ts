import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";

const inspector = vi.hoisted(() => ({ calls: [] as string[], failure: "", profile: {} as unknown, hold: "", heldReply: undefined as undefined | ((error: Error | null, result?: unknown) => void) }));
vi.mock("node:inspector", () => ({ Session: class {
  connect() { inspector.calls.push("connect"); }
  disconnect() { inspector.calls.push("disconnect"); }
  post(method: string, params: unknown, callback?: (error: Error | null, result?: unknown) => void) {
    inspector.calls.push(method);
    const reply = typeof params === "function" ? params as typeof callback : callback;
    if (method === inspector.hold) inspector.heldReply = reply;
    else if (method === inspector.failure) reply?.(new Error("private-inspector-error"));
    else reply?.(null, method === "Profiler.stop" ? { profile: inspector.profile } : {});
  }
} }));
import { startMainCpuProfile } from "../../src/server/diagnostics/main-cpu-profile.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  inspector.calls.length = 0; inspector.failure = ""; inspector.profile = {}; inspector.hold = ""; inspector.heldReply = undefined;
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-cpu-profile-"));
  await chmod(directory, 0o700);
  cleanup.push(() => rm(directory, { force: true, recursive: true }));
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const environment = { SEDES_DEBUG_DELIVERY: "1", SEDES_DEBUG_CPU_PROFILE_DIRECTORY: directory };
  return { directory, log, environment };
}

it("requires both diagnostic and profile-directory opt-ins before connecting inspector", async () => {
  await startMainCpuProfile({ SEDES_DEBUG_DELIVERY: "1" })();
  await startMainCpuProfile({ SEDES_DEBUG_CPU_PROFILE_DIRECTORY: "/unused" })();
  expect(inspector.calls).toEqual([]);
});

it.each(["0", "121", "999999", "1.5", "1e2", "", "-1"])("rejects an invalid or excessive profile duration: %s", async seconds => {
  const f = await fixture();
  await startMainCpuProfile({ ...f.environment, SEDES_DEBUG_CPU_PROFILE_SECONDS: seconds })();
  expect(inspector.calls).toEqual([]);
  expect(f.log.mock.calls[0]?.[0]).toContain('"code":"configuration_invalid"');
  expect(await readdir(f.directory)).toEqual([]);
});

it.skipIf(process.platform === "win32").each(["public", "symlink"] as const)("refuses an insecure profile directory: %s", async kind => {
  const f = await fixture();
  let directory = f.directory;
  if (kind === "public") await chmod(directory, 0o755);
  else { directory = path.join(f.directory, "link"); await symlink(f.directory, directory); }
  await startMainCpuProfile({ ...f.environment, SEDES_DEBUG_CPU_PROFILE_DIRECTORY: directory })();
  expect(inspector.calls).toEqual([]);
  expect(JSON.stringify(f.log.mock.calls)).not.toContain(f.directory);
});

it.skipIf(process.platform === "win32")("stops exactly once, disables/disconnects inspector, and writes a private bounded profile", async () => {
  const f = await fixture();
  inspector.profile = { nodes: [], samples: [], timeDeltas: [], startTime: 10, endTime: 20 };
  const stop = startMainCpuProfile(f.environment); cleanup.push(stop);
  await Promise.all([stop(), stop()]);
  expect(inspector.calls).toEqual(["connect", "Profiler.enable", "Profiler.setSamplingInterval", "Profiler.start", "Profiler.stop", "Profiler.disable", "disconnect"]);
  const [name] = await readdir(f.directory);
  expect(name).toMatch(new RegExp(`^main-${process.pid}-[0-9]+\\.cpuprofile$`));
  const file = path.join(f.directory, name!);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(inspector.profile);
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(f.log.mock.calls[0]?.[0]).toContain('"requestedDurationMs":90000');
  expect(f.log.mock.calls[0]?.[0]).toContain('"samplingIntervalUs":10000');
  expect(JSON.stringify(f.log.mock.calls)).not.toContain(f.directory);
});

it.skipIf(process.platform === "win32")("does not publish oversized profiles or log their content", async () => {
  const f = await fixture();
  inspector.profile = { nodes: [{ callFrame: { functionName: `private-${"x".repeat(8 * 1024 * 1024)}` } }] };
  await startMainCpuProfile(f.environment)();
  expect(await readdir(f.directory)).toEqual([]);
  expect(f.log.mock.calls.some(([line]) => String(line).includes('"code":"profile_size_limit"'))).toBe(true);
  expect(JSON.stringify(f.log.mock.calls)).not.toContain("private-");
  expect(inspector.calls.at(-1)).toBe("disconnect");
});

it.skipIf(process.platform === "win32").each(["Profiler.start", "Profiler.stop"])("sanitizes inspector failure and always disconnects: %s", async method => {
  const f = await fixture(); inspector.failure = method;
  await expect(startMainCpuProfile(f.environment)()).resolves.toBeUndefined();
  expect(inspector.calls.at(-1)).toBe("disconnect");
  expect(await readdir(f.directory)).toEqual([]);
  expect(JSON.stringify(f.log.mock.calls)).not.toContain("private-inspector-error");
});

it.skipIf(process.platform === "win32")("bounds shutdown waiting and prevents a delayed inspector startup after cancellation", async () => {
  const f = await fixture(); inspector.hold = "Profiler.enable";
  const stop = startMainCpuProfile(f.environment); cleanup.push(stop);
  await vi.waitFor(() => expect(inspector.calls).toContain("Profiler.enable"));
  vi.useFakeTimers();
  const stopping = stop();
  await vi.advanceTimersByTimeAsync(500);
  await expect(stopping).resolves.toBeUndefined();
  expect(inspector.calls.at(-1)).toBe("disconnect");
  inspector.heldReply?.(null, {});
  await vi.advanceTimersByTimeAsync(0);
  expect(inspector.calls).not.toContain("Profiler.start");
  expect(await readdir(f.directory)).toEqual([]);
  expect(f.log.mock.calls.some(([line]) => String(line).includes('"code":"profile_stop_timeout"'))).toBe(true);
});

it.skipIf(process.platform === "win32")("captures a real named CPU hotspot without opening a debug listener", async () => {
  const f = await fixture();
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { url } from 'node:inspector';
    import { setTimeout as delay } from 'node:timers/promises';
    import { startMainCpuProfile } from './src/server/diagnostics/main-cpu-profile.ts';
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const stderr = console.error;
    console.error = (...args) => { stderr(...args); if (String(args[0]).includes('"event":"started"')) ready(); };
    const stop = startMainCpuProfile();
    await started;
    function capturedCpuHotspot() { const end = performance.now() + 250; let value = 0; while (performance.now() < end) value += Math.sqrt(value + 1); return value; }
    capturedCpuHotspot();
    await delay(1000);
    await stop();
    console.log(JSON.stringify({ listener: url() ?? null }));
  `], { env: { ...process.env, ...f.environment, SEDES_DEBUG_CPU_PROFILE_SECONDS: "1" }, timeout: 5000 });
  expect(JSON.parse(result.stdout)).toEqual({ listener: null });
  expect(result.stderr).toContain('"event":"complete"');
  const files = await readdir(f.directory);
  expect(files).toHaveLength(1);
  const profile = JSON.parse(await readFile(path.join(f.directory, files[0]!), "utf8"));
  expect(profile.nodes.some((node: { callFrame: { functionName: string } }) => node.callFrame.functionName === "capturedCpuHotspot")).toBe(true);
  expect(profile.samples.length).toBeGreaterThan(0);
  expect((await stat(path.join(f.directory, files[0]!))).size).toBeLessThanOrEqual(8 * 1024 * 1024);
});

it.skipIf(process.platform === "win32")("an active in-process capture does not keep an otherwise idle process alive", async () => {
  const f = await fixture();
  const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { startMainCpuProfile } from './src/server/diagnostics/main-cpu-profile.ts';
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const stderr = console.error;
    console.error = (...args) => { stderr(...args); if (String(args[0]).includes('"event":"started"')) ready(); };
    startMainCpuProfile();
    await started;
  `], { env: { ...process.env, ...f.environment }, timeout: 3000 });
  expect(result.stderr).toContain('"event":"started"');
});
