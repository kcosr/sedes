import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readProcessEntrySync } from "../../src/server/runtime/process-table.js";
import { terminateProcessesReferencing } from "../support/process-cleanup.js";

const directories: string[] = [];
const spawned: number[] = [];
afterEach(async () => {
  for (const pid of spawned.splice(0)) {
    try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  const entry = readProcessEntrySync(pid);
  return entry !== undefined && !entry.exited;
}

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("test process cleanup", () => {
  it("terminates a detached SIGTERM-ignoring daemon started from a fixture directory only", async () => {
    const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "sedes-process-cleanup-")));
    const unrelated = await realpath(await mkdtemp(path.join(tmpdir(), "sedes-process-cleanup-other-")));
    directories.push(fixture, unrelated);
    const script = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
    await writeFile(path.join(fixture, "daemon.js"), script);
    await writeFile(path.join(unrelated, "daemon.js"), script);
    const start = (file: string) => {
      const child = spawn(process.execPath, [file], { detached: true, stdio: "ignore" });
      child.unref();
      spawned.push(child.pid!);
      return child.pid!;
    };
    const leaked = start(path.join(fixture, "daemon.js"));
    const other = start(path.join(unrelated, "daemon.js"));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(await terminateProcessesReferencing(fixture, 100)).toEqual([leaked]);
    expect(alive(leaked)).toBe(false);
    expect(alive(other)).toBe(true);
  });
});
