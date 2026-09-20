import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  commandEnvironment,
  executePosixShellCommand,
} from "../../src/server/runtime/command-execution.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("execution-environment shell commands", () => {
  it("runs a shell command in the canonical workspace and bounds previews", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sedes-command-"));
    directories.push(directory);

    const execution = await executePosixShellCommand({
      command: "printf '%s' \"$PWD\" && printf error >&2",
      cwd: directory,
      timeoutMilliseconds: 2_000,
      environment: commandEnvironment({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENAI_API_KEY: "must-not-pass",
      }),
    });

    expect(execution).toMatchObject({
      kind: "exited",
      exitCode: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    });
    expect(Buffer.from(execution.stdoutPreview).toString("utf8")).toBe(
      directory,
    );
    expect(Buffer.from(execution.stderrPreview).toString("utf8")).toBe(
      "error",
    );
    expect(
      commandEnvironment({ OPENAI_API_KEY: "must-not-pass" }),
    ).not.toHaveProperty("OPENAI_API_KEY");
  });

  it("terminates a timed-out process group", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sedes-timeout-"));
    directories.push(directory);

    const execution = await executePosixShellCommand({
      command: "/bin/sh -c 'trap \"\" TERM; sleep 5' & wait",
      cwd: directory,
      timeoutMilliseconds: 30,
      environment: commandEnvironment(process.env),
    });

    expect(execution).toMatchObject({
      kind: "timed_out",
      diagnosticCode: "automation_precheck_timed_out",
    });
    expect(execution.durationMilliseconds).toBeLessThan(2_000);
  });

  it("uses browser-safe stdout and stderr preview limits", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sedes-preview-"));
    directories.push(directory);

    const execution = await executePosixShellCommand({
      command:
        "head -c 17000 /dev/zero | tr '\\0' x; " +
        "head -c 5000 /dev/zero | tr '\\0' y >&2",
      cwd: directory,
      timeoutMilliseconds: 2_000,
      environment: commandEnvironment(process.env),
    });

    expect(execution).toMatchObject({
      kind: "exited",
      exitCode: 0,
      stdoutBytes: 17_000,
      stderrBytes: 5_000,
      stdoutTruncated: true,
      stderrTruncated: true,
    });
    expect(execution.stdoutPreview).toHaveLength(16_384);
    expect(execution.stderrPreview).toHaveLength(4_096);
  });

  it("cancels immediately when the caller signal is already aborted", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "sedes-cancel-"));
    directories.push(directory);
    const controller = new AbortController();
    controller.abort();
    const marker = path.join(directory, "must-not-exist");

    const execution = await executePosixShellCommand({
      command: `printf side-effect > '${marker}'`,
      cwd: directory,
      timeoutMilliseconds: 5_000,
      environment: commandEnvironment(process.env),
      signal: controller.signal,
    });

    expect(execution).toMatchObject({
      kind: "cancelled",
      diagnosticCode: "automation_precheck_cancelled",
    });
    expect(execution.durationMilliseconds).toBeLessThan(2_000);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
