import { spawn } from "node:child_process";
import process from "node:process";
import type { ExecutionCommandResult } from "../execution/contracts.js";

const STDOUT_PREVIEW_LIMIT = 16_384;
const STDERR_PREVIEW_LIMIT = 4_096;
const TERMINATION_GRACE_MS = 250;

export function commandEnvironment(
  source: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "LOGNAME",
    "PATH",
    "SHELL",
    "TMPDIR",
    "TZ",
    "USER",
  ]) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.PATH ??= "/usr/local/bin:/usr/bin:/bin";
  return environment;
}

export async function executePosixShellCommand(input: {
  readonly command: string;
  readonly cwd: string;
  readonly timeoutMilliseconds: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}): Promise<ExecutionCommandResult> {
  const startedAt = Date.now();
  if (input.signal?.aborted) {
    return {
      kind: "cancelled",
      diagnosticCode: "automation_precheck_cancelled",
      stdoutPreview: new Uint8Array(),
      stderrPreview: new Uint8Array(),
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMilliseconds: 0,
    };
  }
  return await new Promise<ExecutionCommandResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutRetained = 0;
    let stderrRetained = 0;

    const child = spawn("/bin/sh", ["-lc", input.command], {
      cwd: input.cwd,
      env: input.environment,
      detached: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const retain = (
      chunk: Buffer,
      destination: Buffer[],
      retained: number,
      limit: number,
    ): number => {
      if (retained >= limit) return retained;
      const slice = chunk.subarray(0, limit - retained);
      destination.push(slice);
      return retained + slice.byteLength;
    };

    child.stdout.on("data", (value: Buffer) => {
      stdoutBytes += value.byteLength;
      stdoutRetained = retain(
        value,
        stdout,
        stdoutRetained,
        STDOUT_PREVIEW_LIMIT,
      );
    });
    child.stderr.on("data", (value: Buffer) => {
      stderrBytes += value.byteLength;
      stderrRetained = retain(
        value,
        stderr,
        stderrRetained,
        STDERR_PREVIEW_LIMIT,
      );
    });

    const terminate = () => {
      if (!child.pid) return;
      const processGroupId = child.pid;
      try {
        process.kill(-processGroupId, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
      const killTimer = setTimeout(() => {
        try {
          process.kill(-processGroupId, "SIGKILL");
        } catch {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }
      }, TERMINATION_GRACE_MS);
      killTimer.unref();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, input.timeoutMilliseconds);
    timeout.unref();
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    if (input.signal?.aborted) {
      onAbort();
    } else {
      input.signal?.addEventListener("abort", onAbort, { once: true });
    }

    const finish = (
      result:
        | { readonly exitCode: number }
        | { readonly diagnosticCode: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", onAbort);
      const common = {
        stdoutPreview: Buffer.concat(stdout),
        stderrPreview: Buffer.concat(stderr),
        stdoutBytes,
        stderrBytes,
        stdoutTruncated: stdoutBytes > stdoutRetained,
        stderrTruncated: stderrBytes > stderrRetained,
        durationMilliseconds: Math.max(0, Date.now() - startedAt),
      };
      if ("exitCode" in result && !timedOut && !cancelled) {
        resolve({ kind: "exited", exitCode: result.exitCode, ...common });
      } else {
        resolve({
          kind: cancelled ? "cancelled" : timedOut ? "timed_out" : "unavailable",
          diagnosticCode:
            "diagnosticCode" in result
              ? result.diagnosticCode
              : cancelled
                ? "automation_precheck_cancelled"
                : "automation_precheck_timed_out",
          ...common,
        });
      }
    };

    child.once("error", () => {
      finish({ diagnosticCode: "automation_precheck_unavailable" });
    });
    child.once("close", (code) => {
      finish({
        ...(code === null
          ? {
              diagnosticCode: timedOut
                ? "automation_precheck_timed_out"
                : cancelled
                  ? "automation_precheck_cancelled"
                  : "automation_precheck_signalled",
            }
          : { exitCode: code }),
      });
    });
  });
}
