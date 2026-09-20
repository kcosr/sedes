import { spawn } from "node:child_process";
import type {
  NotificationPayload,
  NotificationTestResult,
} from "../../shared/protocol/notification.js";
import { commandEnvironment } from "./command-execution.js";

const TERMINATION_GRACE_MS = 250;

/** One local, best-effort invocation. Results are ephemeral, never receipts. */
export async function executeNotificationScript(input: {
  readonly scriptPath: string;
  readonly arguments: readonly string[];
  readonly timeoutSeconds: number;
  readonly payload: NotificationPayload;
  readonly signal?: AbortSignal;
  readonly cwd?: string;
}): Promise<NotificationTestResult> {
  const failure = (error: string): NotificationTestResult => ({
    success: false,
    exitCode: null,
    timedOut: false,
    stdout: "",
    stderr: "",
    error,
  });
  if (input.signal?.aborted) return failure("Notification script cancelled.");

  return await new Promise<NotificationTestResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    let json: string;
    try {
      json = JSON.stringify(input.payload) + "\n";
      child = spawn(input.scriptPath, [...input.arguments], {
        cwd: input.cwd ?? process.cwd(),
        env: commandEnvironment(process.env),
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve(failure("Notification script could not be started."));
      return;
    }

    let settled = false;
    let timedOut = false;
    let cancelled = false;
    let error: string | null = null;
    let stdinError: string | null = null;
    let exitCode: number | null = null;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupStarted = false;
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 16_384) {
        stdout = Buffer.concat([
          stdout,
          chunk.subarray(0, 16_384 - stdout.length),
        ]);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 4_096) {
        stderr = Buffer.concat([
          stderr,
          chunk.subarray(0, 4_096 - stderr.length),
        ]);
      }
    });

    const signalGroup = (signal: NodeJS.Signals): boolean => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        return child.exitCode === null && child.signalCode === null
          ? child.kill(signal)
          : false;
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(cleanupTimer);
      input.signal?.removeEventListener("abort", onAbort);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        success: !cancelled && !timedOut && error === null && exitCode === 0,
        exitCode,
        timedOut,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        error: cancelled
          ? "Notification script cancelled."
          : timedOut
            ? "Notification script timed out."
            : (error ??
              (exitCode === 0
                ? null
                : (stdinError ?? "Notification script failed."))),
      });
    };

    const cleanup = () => {
      if (cleanupStarted || settled) return;
      cleanupStarted = true;
      // A leader can exit while descendants retain its pipes. Always clean up
      // the detached process group, even after a successful leader exit.
      if (signalGroup("SIGTERM")) {
        cleanupTimer = setTimeout(() => {
          signalGroup("SIGKILL");
          finish();
        }, TERMINATION_GRACE_MS);
      } else if (!child.pid) {
        finish();
      } else {
        // Let the close event drain remaining output after a normal exit, with
        // a bound in case an escaped descendant still holds the pipe open.
        cleanupTimer = setTimeout(finish, TERMINATION_GRACE_MS);
      }
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      cleanup();
    }, input.timeoutSeconds * 1_000);
    const onAbort = () => {
      cancelled = true;
      cleanup();
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    if (input.signal?.aborted) onAbort();

    child.once("error", () => {
      error = "Notification script could not be started.";
      cleanup();
    });
    child.once("exit", (code) => {
      exitCode = code;
      clearTimeout(timeout);
      cleanup();
    });
    child.once("close", () => {
      if (!cleanupStarted) cleanup();
      // Retain a pending escalation when descendants survived their leader.
      if (cleanupStarted && !signalGroup("SIGTERM")) finish();
    });
    child.stdin?.on("error", () => {
      if (settled) return;
      // A script may intentionally ignore or stop reading stdin. Let its exit
      // status decide success; timeout/abort still bound a script that hangs.
      stdinError = "Notification script could not read its input.";
    });
    child.stdin?.end(json, "utf8");
  });
}
