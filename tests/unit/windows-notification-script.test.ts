import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationPayload } from "../../src/shared/protocol/notification.js";
import { testNotificationRequestSchema } from "../../src/shared/protocol/notification.js";
import * as windowsOwnership from "../../src/server/execution/windows-owned-process.js";
import { executeNotificationScript } from "../../src/server/runtime/notification-script-executor.js";

const payload: NotificationPayload = {
  schemaVersion: 5,
  notificationId: "windows-notification",
  event: "notification.test",
  occurredAt: "2026-10-15T00:00:00.000Z",
  title: "Native fixture",
  message: "Literal 日本語; $(touch injected)",
};
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function fixture(source: string) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-win-notify-"));
  directories.push(directory);
  const script = path.join(directory, "fixture with spaces.cjs");
  await writeFile(script, source);
  return {
    directory,
    input: {
      ...testNotificationRequestSchema.parse({
        scriptPath: process.execPath,
        arguments: [script],
        timeoutSeconds: 5,
      }),
      payload,
      cwd: directory,
    },
  };
}
function expectGone(pid: number) {
  expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
}

describe.skipIf(process.platform !== "win32")("native Windows notification scripts", () => {
  it("uses a native interpreter with literal stdin/arguments and the execution account environment", async () => {
    vi.stubEnv("SEDES_NOTIFICATION_TEST_SECRET", "excluded");
    vi.stubEnv("NODE_OPTIONS", "--require C:/nonexistent-notification-loader.cjs");
    const { directory, input } = await fixture(`
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => data += chunk);
      process.stdin.on("end", () => console.log(JSON.stringify({
        payload: JSON.parse(data),
        args: process.argv.slice(2),
        systemRoot: process.env.SystemRoot,
        profile: process.env.USERPROFILE,
        temporary: process.env.TEMP,
        loader: process.env.NODE_OPTIONS ?? null,
        secret: process.env.SEDES_NOTIFICATION_TEST_SECRET ?? null
      })));
    `);
    const argument = 'literal "quotes" 日本語; $(touch injected)';
    const result = await executeNotificationScript({ ...input, arguments: [...input.arguments, argument] });
    expect(result).toMatchObject({ success: true, exitCode: 0, error: null });
    expect(JSON.parse(result.stdout)).toEqual({
      payload,
      args: [argument],
      systemRoot: process.env.SystemRoot,
      profile: process.env.USERPROFILE,
      temporary: process.env.TEMP,
      loader: null,
      secret: null,
    });
    await expect(readFile(path.join(directory, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);

  it.each(["leader-exit", "timeout"] as const)("verifies descendant cleanup after %s", async (mode) => {
    const { directory, input } = await fixture(`
      const child = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        stdio: ["ignore", "inherit", "inherit"], detached: true
      });
      require("fs").writeFileSync("pids.json", JSON.stringify({root:process.pid,child:child.pid}));
      ${mode === "leader-exit" ? "process.exit(0);" : "setInterval(() => {},1000);"}
    `);
    const result = await executeNotificationScript({ ...input, timeoutSeconds: mode === "timeout" ? 2 : 5 });
    expect(result).toMatchObject(mode === "timeout"
      ? { success: false, timedOut: true, error: "Notification script timed out." }
      : { success: true, exitCode: 0, timedOut: false, error: null });
    const pids = JSON.parse(await readFile(path.join(directory, "pids.json"), "utf8")) as { root: number; child: number };
    expectGone(pids.root);
    expectGone(pids.child);
  }, 15_000);

  it("does not report success when the owned Job cleanup proof is unavailable", async () => {
    const actualLaunch = windowsOwnership.spawnWindowsOwnedProcess;
    vi.spyOn(windowsOwnership, "spawnWindowsOwnedProcess").mockImplementation(async input => {
      const owned = await actualLaunch(input);
      return {
        ...owned,
        async close(timeoutMilliseconds) {
          await owned.close(timeoutMilliseconds);
          throw new Error("fixture_missing_cleanup_proof");
        },
      };
    });
    const { input } = await fixture('process.stdin.resume(); process.stdin.on("end", () => process.exit(0));');
    const result = await executeNotificationScript(input);
    expect(result).toMatchObject({
      success: false,
      error: "Notification script cleanup could not be confirmed.",
    });
  }, 15_000);
});
