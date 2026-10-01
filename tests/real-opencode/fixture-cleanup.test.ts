import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";

async function alive(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// The machine-wide ownership scan is deliberately opt-in with the native
// fixtures, never part of ordinary npm test. An unreadable same-account process
// whose ownership cannot be excluded makes this qualification unavailable.
it.skipIf(process.platform !== "linux" || process.env.SEDES_RUN_REAL_OPENCODE !== "1")("native fixture kills a marked detached child after root exit, allows its cleanup grace, and leaves unrelated children alive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-cleanup-test-"));
  const executable = path.join(directory, "fake-opencode.cjs");
  const childEvidence = path.join(directory, "child.json");
  const termEvidence = path.join(directory, "term.json");
  let unrelated: ChildProcess | undefined;
  let fixture: Awaited<ReturnType<typeof import("../support/opencode-native-fixture.js")["startOpencodeNativeFixture"]>> | undefined;
  let detachedPid: number | undefined;
  try {
    // This fake CLI uses no network/model service. Its detached child changes
    // cwd outside the fixture tree, closes stdio, and deliberately survives
    // SIGTERM. Only the inherited synthetic environment identifies ownership.
    await writeFile(executable, `#!${process.execPath}
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
if (process.argv.includes("--version")) { console.log("opencode v2.0.18"); process.exit(0); }
const code = ${JSON.stringify(`const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => writeFileSync(process.env.CLEANUP_TERM_EVIDENCE, JSON.stringify({ at: Date.now() })));
writeFileSync(process.env.CLEANUP_CHILD_EVIDENCE, JSON.stringify({ pid: process.pid, root: process.ppid }));
process.send("ready");
process.disconnect();
setInterval(() => {}, 1000);`)};
const child = spawn(process.execPath, ["-e", code], { cwd: "/", env: process.env, detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
child.on("message", () => { console.log(JSON.stringify({ url: "http://127.0.0.1:4096" })); });
child.unref();
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`);
    await chmod(executable, 0o700);
    vi.stubEnv("SEDES_RUN_REAL_OPENCODE", "1");
    vi.stubEnv("SEDES_REAL_OPENCODE_EXECUTABLE", executable);
    vi.resetModules();
    const { startOpencodeNativeFixture } = await import("../support/opencode-native-fixture.js");
    fixture = await startOpencodeNativeFixture({ environment: {
      CLEANUP_CHILD_EVIDENCE: childEvidence,
      CLEANUP_TERM_EVIDENCE: termEvidence,
    } });
    detachedPid = JSON.parse(await readFile(childEvidence, "utf8")).pid as number;
    expect(await alive(detachedPid)).toBe(true);
    const detachedStat = await readFile(`/proc/${detachedPid}/stat`, "utf8");
    expect(Number(detachedStat.slice(detachedStat.lastIndexOf(")") + 2).split(" ")[2])).toBe(detachedPid);

    unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: "/", detached: true, stdio: "ignore",
      env: { PATH: process.env.PATH, SEDES_OPENCODE_FIXTURE_OWNER: "unrelated-fixture-marker" },
    });
    process.kill(fixture.pid, "SIGKILL");
    const deadline = Date.now() + 3000;
    while (await alive(fixture.pid)) {
      if (Date.now() >= deadline) throw new Error("fake root did not exit");
      await delay(10);
    }
    expect(await alive(detachedPid)).toBe(true);

    const stopStartedAt = Date.now();
    await fixture.stop();
    const signaled = JSON.parse(await readFile(termEvidence, "utf8")) as { at: number };
    expect(signaled.at).toBeGreaterThanOrEqual(stopStartedAt);
    expect(Date.now() - stopStartedAt).toBeGreaterThanOrEqual(5000);
    expect(await alive(detachedPid)).toBe(false);
    expect(await alive(unrelated.pid!)).toBe(true);
    await expect(access(fixture.rootDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    vi.unstubAllEnvs();
    // Failure cleanup uses only children started by this test, not a broad
    // command-name/group scan. The native helper retains uncertain directories.
    if (detachedPid && await alive(detachedPid)) process.kill(detachedPid, "SIGKILL");
    if (unrelated?.pid && await alive(unrelated.pid)) unrelated.kill("SIGKILL");
    try {
      if (fixture) await fixture.stop();
    } finally {
      // The helper intentionally retains its native root on uncertain cleanup;
      // this separate fake-CLI/evidence directory has no running dependants.
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
