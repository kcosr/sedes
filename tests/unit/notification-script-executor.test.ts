import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotificationPayload } from "../../src/shared/protocol/notification.js";
import { executeNotificationScript } from "../../src/server/runtime/notification-script-executor.js";

const directories: string[] = [];
const payload: NotificationPayload = {
  schemaVersion: 3,
  notificationId: "notification-1",
  event: "turn.completed",
  occurredAt: "2026-09-05T14:32:10.000Z",
  title: "Agent finished",
  message: "Text with $(touch injected), `shell` and Unicode: café",
  thread: { id: "thread-1", title: "Thread title" },
  turn: { id: "turn-1", outcome: "completed" },
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function fixture(source: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "sedes-notify-"));
  directories.push(directory);
  const script = path.join(directory, "script.cjs");
  await writeFile(script, source);
  return {
    directory,
    input: {
      scriptPath: process.execPath,
      arguments: [script],
      cwd: directory,
      timeoutSeconds: 3,
      payload,
    },
  };
}

describe("notification script execution", () => {
  it("passes literal UTF-8 JSON to stdin through EOF and allowlists the environment", async () => {
    vi.stubEnv("SEDES_NOTIFICATION_TEST_SECRET", "not-for-children");
    const { input, directory } = await fixture(`
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => console.log(JSON.stringify({
        payload: JSON.parse(input),
        args: process.argv.slice(2),
        cwd: process.cwd(),
        secret: process.env.SEDES_NOTIFICATION_TEST_SECRET ?? null,
        path: process.env.PATH
      })));
    `);
    const argument = "$(touch injected); `whoami`";
    const result = await executeNotificationScript({
      ...input,
      arguments: [...input.arguments, argument],
    });
    expect(result).toMatchObject({ success: true, exitCode: 0, error: null });
    expect(JSON.parse(result.stdout)).toEqual({
      payload,
      args: [argument],
      cwd: directory,
      secret: null,
      path: expect.any(String),
    });
    await expect(readFile(path.join(directory, "injected"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures bounded output and reports nonzero exit without parsing a receipt", async () => {
    const { input } = await fixture(`
      process.stdin.resume();
      process.stdin.on('end', () => {
        process.stdout.write('x'.repeat(30000));
        process.stderr.write('y'.repeat(10000));
        process.exitCode = 7;
      });
    `);
    const result = await executeNotificationScript(input);
    expect(result).toMatchObject({ success: false, exitCode: 7, timedOut: false });
    expect(result.stdout).toBe("x".repeat(16_384));
    expect(result.stderr).toBe("y".repeat(4_096));
  });

  it.each([0, 7])("uses exit status %s when a script closes stdin early", async (exitCode) => {
    const { input } = await fixture(`
      require('fs').closeSync(0);
      setTimeout(() => process.exit(${exitCode}), 50);
    `);
    const result = await executeNotificationScript({
      ...input,
      // Exceed the OS buffer to deterministically exercise a pending stdin
      // write when the child closes it, regardless of host pipe capacity.
      payload: { ...payload, message: "x".repeat(2 * 1024 * 1024) },
    });
    expect(result).toMatchObject({ success: exitCode === 0, exitCode, timedOut: false });
    if (exitCode === 0) expect(result.error).toBeNull();
    else expect(result.error).not.toBeNull();
  });

  it("still times out a script that closes stdin but never exits", async () => {
    const { input } = await fixture(`
      require('fs').closeSync(0);
      setInterval(() => {}, 1000);
    `);
    const result = await executeNotificationScript({
      ...input,
      timeoutSeconds: 0.2,
      payload: { ...payload, message: "x".repeat(2 * 1024 * 1024) },
    });
    expect(result).toMatchObject({ success: false, timedOut: true, error: "Notification script timed out." });
  });

  it("reports a missing executable without exposing its path", async () => {
    const result = await executeNotificationScript({
      scriptPath: "/not/a/real/secret-script",
      arguments: [],
      timeoutSeconds: 1,
      payload,
    });
    expect(result).toEqual({
      success: false,
      exitCode: null,
      timedOut: false,
      stdout: "",
      stderr: "",
      error: "Notification script could not be started.",
    });
  });

  it("bounds timeout even when the script ignores termination", async () => {
    const { input } = await fixture(`
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
    `);
    const result = await executeNotificationScript({ ...input, timeoutSeconds: 0.1 });
    expect(result).toMatchObject({ success: false, timedOut: true, error: "Notification script timed out." });
  });

  it("does not spawn when already cancelled", async () => {
    const { input, directory } = await fixture("require('fs').writeFileSync('marker', 'ran');");
    const result = await executeNotificationScript({ ...input, signal: AbortSignal.abort() });
    expect(result.error).toBe("Notification script cancelled.");
    await expect(readFile(path.join(directory, "marker"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cancels an active script", async () => {
    const { input } = await fixture("setInterval(() => {}, 1000);");
    const result = await executeNotificationScript({ ...input, signal: AbortSignal.timeout(100) });
    expect(result).toMatchObject({ success: false, timedOut: false, error: "Notification script cancelled." });
  });

  it("cleans descendants retaining pipes after a successful leader exits", async () => {
    const { input, directory } = await fixture(`
      const { spawn } = require('child_process');
      const child = spawn(process.execPath, ['-e',
        "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"
      ], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.once('data', () => {
        require('fs').writeFileSync('pid', String(child.pid));
        process.exit(0);
      });
    `);
    const result = await executeNotificationScript(input);
    expect(result).toMatchObject({ success: true, exitCode: 0, timedOut: false });
    const pid = Number(await readFile(path.join(directory, "pid"), "utf8"));
    // On Linux an orphan can briefly be a zombie before the container reaps it.
    await vi.waitFor(async () => {
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
      expect(process.platform).toBe("linux");
      const status = await readFile(`/proc/${pid}/stat`, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (status !== null) expect(status.split(") ")[1]?.charAt(0)).toBe("Z");
    });
  });
});
