import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { requestE2EChildShutdown, stopE2EChild } from "../../scripts/e2e-child-cleanup.mjs";

async function fixture(mode) {
  const child = fork(fileURLToPath(new URL("../fixtures/e2e-child-cleanup.mjs", import.meta.url)), [mode], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes.toString(); });
  child.stderr.on("data", (bytes) => { stderr += bytes.toString(); });
  const closed = once(child, "exit").then(([code, signal]) => ({ code, signal }));
  let timer;
  try {
    await Promise.race([
      once(child, "message"),
      closed.then((result) => { throw new Error(`fixture_exited:${JSON.stringify(result)}:${stderr}`); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`fixture_readiness_timeout:${stderr}`)), 3_000); }),
    ]);
  } catch (error) {
    child.kill("SIGKILL");
    await closed;
    throw error;
  } finally {
    clearTimeout(timer);
  }
  return { child, closed, stdout: () => stdout };
}

it("closes a forked Windows server through IPC during repeated shutdown requests", async () => {
  const current = await fixture("graceful");
  try {
    requestE2EChildShutdown(current.child, "SIGTERM", { server: true, platform: "win32" });
    requestE2EChildShutdown(current.child, "SIGINT", { server: true, platform: "win32" });
    await expect(stopE2EChild(current.child, current.closed, {
      server: true, platform: "win32", gracefulMilliseconds: 2_000,
    })).resolves.toEqual({ code: 0, signal: null });
    expect(current.stdout()).toBe("cleanup started\ncleanup complete\n");
  } finally {
    if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill("SIGKILL");
    await current.closed;
  }
}, 10_000);

it("bounds a Windows server's stuck IPC cleanup with forced termination", async () => {
  const current = await fixture("stuck");
  try {
    await expect(stopE2EChild(current.child, current.closed, {
      server: true, platform: "win32", gracefulMilliseconds: 100, forcedMilliseconds: 2_000,
    })).resolves.toEqual({ code: null, signal: "SIGKILL" });
    expect(current.stdout()).toBe("cleanup started\n");
  } finally {
    if (current.child.exitCode === null && current.child.signalCode === null) current.child.kill("SIGKILL");
    await current.closed;
  }
}, 10_000);
