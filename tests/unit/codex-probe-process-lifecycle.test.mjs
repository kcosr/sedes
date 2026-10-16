import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isProbeProcessStopped,
  waitForProbeProcessStopped,
} from "../../scripts/codex-probes/probe-process-lifecycle.mjs";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function startFixture(message) {
  const child = spawn(process.execPath, [
    "--input-type=module", "--eval",
    `process.stdout.write(${JSON.stringify(message)}); setInterval(() => {}, 1000);`,
  ], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = once(child, "exit");
  let output = "";
  child.stdout.on("data", chunk => { output += chunk; });
  await once(child.stdout, "data");
  return { child, exited, output: () => output };
}

describe("Codex isolated probe process cleanup evidence", () => {
  it("accepts forced termination without a JavaScript stop event", async () => {
    const { child, exited, output } = await startFixture('{"event":"started"}\n');
    try {
      child.kill("SIGKILL");
      await exited;
      await expect(waitForProbeProcessStopped(child.pid)).resolves.toBeUndefined();
      expect(output()).toContain('"event":"started"');
      expect(output()).not.toContain('"event":"stopped"');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("rejects a live process even after it emits a synthetic stop event", async () => {
    const { child, exited, output } = await startFixture('{"event":"stopped"}\n');
    try {
      expect(output()).toContain('"event":"stopped"');
      await expect(waitForProbeProcessStopped(child.pid, 50)).rejects.toThrow(
        "d2a_stale_mcp_process_remained_open",
      );
    } finally {
      child.kill("SIGKILL");
      await exited;
    }
  });

  it("fails closed when process inspection is denied", async () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    await expect(isProbeProcessStopped(process.pid)).rejects.toMatchObject({
      code: "EPERM",
    });
  });

  it.runIf(process.platform === "linux")(
    "recognizes Linux zombies while rejecting malformed or unreadable state",
    async () => {
      vi.spyOn(process, "kill").mockReturnValue(true);
      vi.mocked(readFile).mockResolvedValueOnce(`${process.pid} (probe ) name) Z 1 2 3`);
      await expect(isProbeProcessStopped(process.pid)).resolves.toBe(true);
      vi.mocked(readFile).mockResolvedValueOnce(`${process.pid} (probe) R 1 2 3`);
      await expect(isProbeProcessStopped(process.pid)).resolves.toBe(false);
      vi.mocked(readFile).mockResolvedValueOnce(`${process.pid + 1} (probe) Z 1 2 3`);
      await expect(isProbeProcessStopped(process.pid)).rejects.toThrow(
        "codex_probe_process_state_unknown",
      );
      vi.mocked(readFile).mockResolvedValueOnce(`${process.pid} (probe) ? 1 2 3`);
      await expect(isProbeProcessStopped(process.pid)).rejects.toThrow(
        "codex_probe_process_state_unknown",
      );
      vi.mocked(readFile).mockRejectedValueOnce(
        Object.assign(new Error("denied"), { code: "EACCES" }),
      );
      await expect(isProbeProcessStopped(process.pid)).rejects.toMatchObject({
        code: "EACCES",
      });
    },
  );

  it("never probes a process group or an invalid PID", async () => {
    for (const processId of [0, -1, Number.NaN]) {
      await expect(isProbeProcessStopped(processId)).rejects.toThrow(
        "codex_probe_process_id_invalid",
      );
    }
  });
});
