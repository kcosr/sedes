import { readdir, readlink } from "node:fs/promises";
import path from "node:path";
import {
  processTableSupported,
  readProcessCommandLines,
} from "../../src/server/runtime/process-table.js";

/**
 * Terminates every visible process whose command line references a
 * test-owned directory, such as a detached `sedes service daemon` started from
 * a fixture home, and on Linux every process working inside it (PTY shells).
 * Processes first get `graceMilliseconds` to exit on their own, then SIGTERM,
 * then SIGKILL. Pass only a unique temporary directory.
 */
export async function terminateProcessesReferencing(
  directory: string,
  graceMilliseconds = 3_000,
): Promise<readonly number[]> {
  if (!processTableSupported() || !path.isAbsolute(directory) || directory.split(path.sep).length < 3) {
    return [];
  }
  const referencing = async () => {
    const pids = new Set<number>();
    for (const [pid, commandLine] of await readProcessCommandLines()) {
      if (commandLine.includes(`${directory}${path.sep}`) || commandLine.endsWith(directory) ||
          commandLine.includes(`${directory} `)) {
        pids.add(pid);
      }
    }
    if (process.platform === "linux") {
      for (const name of await readdir("/proc")) {
        if (!/^[0-9]+$/u.test(name)) continue;
        const cwd = await readlink(`/proc/${name}/cwd`).catch(() => undefined);
        if (cwd === directory || cwd?.startsWith(`${directory}${path.sep}`)) pids.add(Number(name));
      }
    }
    pids.delete(process.pid);
    return [...pids];
  };
  const waitForExit = async (milliseconds: number) => {
    const deadline = Date.now() + milliseconds;
    let remaining = await referencing();
    while (remaining.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      remaining = await referencing();
    }
    return remaining;
  };
  const signalled = new Set<number>();
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const remaining = await waitForExit(signal === "SIGTERM" ? graceMilliseconds : 2_000);
    if (remaining.length === 0) return [...signalled];
    for (const pid of remaining) {
      try {
        process.kill(pid, signal);
        signalled.add(pid);
      } catch {
        // Already exited.
      }
    }
  }
  const survivors = await waitForExit(2_000);
  if (survivors.length > 0) {
    throw new Error(`test_processes_survived_cleanup:${survivors.join(",")}`);
  }
  return [...signalled];
}
