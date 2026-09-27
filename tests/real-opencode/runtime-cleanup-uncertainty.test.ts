import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { OpenCodeRuntime } from "../../src/server/backends/opencode/opencode-runtime.js";
import { boundedOpenCodeProcessFile } from "../../src/server/backends/opencode/opencode-native-identity.js";

import * as ownedProcesses from "../../src/server/backends/opencode/opencode-owned-process.js";
import { OpenCodeNativeApi } from "../../src/server/backends/opencode/opencode-native-api.js";
afterEach(() => vi.restoreAllMocks());

const enabled = process.platform === "linux" && process.env.SEDES_RUN_REAL_OPENCODE === "1";
async function state(pid: number): Promise<{ live: boolean; parent: number }> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(" ");
    return { live: !["Z", "X"].includes(fields[0]!), parent: Number(fields[1]) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { live: false, parent: 0 };
    throw error;
  }
}
async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!await check()) {
    if (Date.now() >= deadline) throw new Error("fixture condition did not settle");
    await delay(10);
  }
}
async function pidFile(file: string): Promise<number> {
  let pid = 0;
  await until(async () => {
    try { pid = Number(await readFile(file, "utf8")); return Number.isSafeInteger(pid) && pid > 1; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  });
  return pid;
}

it.skipIf(!enabled)("cleans confirmed detached native children despite an unrelated non-dumpable orphan, then permits explicit cleanup retry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-uncertain-cleanup-"));
  const configDirectory = path.join(root, "config");
  const nativeStorePath = path.join(root, "opencode.db");
  const childEvidence = path.join(root, "child");
  const termEvidence = path.join(root, "term");
  const unrelatedEvidence = path.join(root, "unrelated");
  let runtime: OpenCodeRuntime | undefined;
  const launched = vi.spyOn(ownedProcesses, "startOpenCodeOwnedProcess");
  let childPid: number | undefined;
  let unrelatedPid: number | undefined;
  let proved = false;
  try {
    await mkdir(configDirectory);
    await writeFile(path.join(root, "models.json"), "{}");
    await writeFile(path.join(configDirectory, "opencode.json"), JSON.stringify({ update: "disable" }));
    runtime = new OpenCodeRuntime({ hostIncarnation: "fixture-host",
      authority: { tenantId: "qualification", principalId: "qualification", backendInstanceId: "uncertainty", executionEnvironmentId: "local" },
      nativeStorePath, configDirectory,
      environment: { HOME: root, PATH: process.env.PATH, SHELL: "/bin/sh",
        XDG_DATA_HOME: path.join(root, "data"), XDG_STATE_HOME: path.join(root, "state"), XDG_CACHE_HOME: path.join(root, "cache"),
        OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_MODELS_PATH: path.join(root, "models.json"), OPENCODE_DISABLE_FFF: "1", OPENCODE_FILEWATCHER_DISABLE: "1" },
      connection: { ownership: "owned", channel: { type: "process_stdio",
        executablePath: process.env.SEDES_REAL_OPENCODE_EXECUTABLE ?? "/home/kevin/.local/bin/opencode2", workingDirectory: root } },
    });
    await runtime.start();
    const lease = runtime.acquire({ directory: root });
    expect((await new OpenCodeNativeApi(lease.client).listSessions({ directory: root })).data).toEqual([]);
    const nativeClient = (await (launched.mock.results.at(-1)!.value as ReturnType<typeof ownedProcesses.startOpenCodeOwnedProcess>)).client;
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const childCode = `const fs=require("node:fs");process.on("SIGTERM",()=>fs.writeFileSync(${JSON.stringify(termEvidence)},"received"));fs.writeFileSync(${JSON.stringify(childEvidence)},String(process.pid));setInterval(()=>{},1000)`;
    await nativeClient.call((client, signal) => client.shell.create({ location: { directory: root }, cwd: root,
      command: `${quote(process.execPath)} -e ${quote(childCode)}` }, { signal }), value => value);
    lease.release(); childPid = await pidFile(childEvidence);
    const nativePid = runtime.snapshot().identity!.pid;
    process.kill(nativePid, "SIGKILL");
    await until(async () => runtime!.snapshot().state === "disconnected");
    expect((await state(childPid)).live).toBe(true);

    // The orphan has no fixture marker and is created after the launch snapshot.
    // PR_SET_DUMPABLE=0 makes environ unreadable to the same account on Linux.
    const python = spawn("/usr/bin/python3", ["-c", [
      "import ctypes, os, time", "pid = os.fork()", "if pid: os._exit(0)", "os.setsid()",
      `open(${JSON.stringify(unrelatedEvidence)}, 'w').write(str(os.getpid()))`,
      "assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0", "time.sleep(120)",
    ].join("\n")], { env: { PATH: process.env.PATH }, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { python.once("error", reject); python.once("exit", code => code === 0 ? resolve() : reject(new Error("fixture launcher failed"))); });
    unrelatedPid = await pidFile(unrelatedEvidence);
    await until(async () => (await state(unrelatedPid!)).parent === 1);
    await expect(boundedOpenCodeProcessFile(`/proc/${unrelatedPid}/environ`, 1_048_576)).rejects.toMatchObject({ code: "EACCES" });

    const started = Date.now();
    await expect(runtime.stop()).rejects.toThrow("opencode_owned_cleanup_unproved");
    expect(Date.now() - started).toBeGreaterThanOrEqual(5_000);
    expect(await readFile(termEvidence, "utf8")).toBe("received");
    expect((await state(childPid)).live).toBe(false);
    expect((await state(unrelatedPid)).live).toBe(true);
    expect(runtime.snapshot().state).toBe("cleanup_unproved");
    expect((await readdir(root)).some(name => name.endsWith(".lock"))).toBe(true);
    await expect(runtime.start()).rejects.toThrow("opencode_runtime_requires_explicit_cleanup");

    process.kill(unrelatedPid, "SIGKILL");
    await until(async () => !(await state(unrelatedPid!)).live);
    await expect(runtime.stop()).resolves.toEqual({ cleanup: "proved", nativeInterrupts: "incomplete" });
    proved = true;
    expect((await readdir(root)).some(name => name.endsWith(".lock"))).toBe(false);
    await runtime.start(); proved = false;
    await expect(runtime.stop()).resolves.toEqual({ cleanup: "proved", nativeInterrupts: "complete" });
    proved = true;
  } finally {
    // Cleanup only explicitly created fixture PIDs; never search by command.
    for (const pid of [unrelatedPid, childPid]) {
      if (pid && (await state(pid)).live) { process.kill(pid, "SIGKILL"); await until(async () => !(await state(pid)).live); }
    }
    if (runtime && !proved) { await runtime.stop(); proved = true; }
    if (proved || !runtime) await rm(root, { recursive: true, force: true });
  }
});
