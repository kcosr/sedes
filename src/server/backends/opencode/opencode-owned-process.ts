import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { createOpenCodeProcessCleanup } from "./opencode-process-cleanup.js";
import { OpenCodeHttpClient, openCodeEndpoint } from "./opencode-http-client.js";
import { admitOpenCodeExecutable, openCodeOwnedEnvironment, probeOpenCodeRelease, OpenCodeRuntimeError } from "./opencode-release.js";

export interface OpenCodeOwnedProcess {
  readonly pid: number;
  readonly executablePath: string;
  readonly endpoint: string;
  readonly client: OpenCodeHttpClient;
  readonly exited: Promise<void>;
  /** Exact applied launch baseline after native CLI credential removal; never a public snapshot. */
  readonly shellEnvironment: Readonly<Record<string, string>>;
  stop(): Promise<void>;
}

/** Host-private cleanup authority survives a failed launch. Never serialize the
 * callback or replace its already-admitted process identities with a new scan. */
export class OpenCodeOwnedCleanupUnprovedError extends OpenCodeRuntimeError {
  constructor(readonly retryCleanup: () => Promise<void>) { super("opencode_owned_cleanup_unproved"); }
}

function waitBounded(exit: Promise<void>, milliseconds: number): Promise<void> {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, milliseconds);
    void exit.then(() => { clearTimeout(timer); resolve(); });
  });
}

export async function startOpenCodeOwnedProcess(input: {
  readonly executablePath: string;
  readonly workingDirectory: string;
  readonly nativeStorePath: string;
  readonly configDirectory: string;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly processMarker: string;
  readonly assertLaunchAdmission?: () => void;
}): Promise<OpenCodeOwnedProcess> {
  if (process.platform !== "linux" || !path.isAbsolute(input.workingDirectory)) throw new OpenCodeRuntimeError("opencode_owned_platform_unavailable");
  const executablePath = await admitOpenCodeExecutable(input.executablePath);
  const workingDirectory = await realpath(input.workingDirectory);
  const marker = input.processMarker;
  if (!/^[a-f0-9]{64}$/u.test(marker)) throw new OpenCodeRuntimeError("opencode_owned_marker_invalid");
  const password = randomBytes(32).toString("base64url");
  const environment = openCodeOwnedEnvironment({ ...input, marker, password });
  const shellEnvironment = Object.freeze(Object.fromEntries(Object.entries(environment)
    .filter((entry): entry is [string, string] => entry[1] !== undefined && !["OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD"].includes(entry[0]))));
  const cleanup = await createOpenCodeProcessCleanup(marker);
  let child: ChildProcessWithoutNullStreams | undefined;
  let exit: Promise<void> = Promise.resolve();
  let exited = false;
  let stopping: Promise<void> | undefined;
  let client: OpenCodeHttpClient | undefined;
  const stop = () => stopping ??= (async () => {
    client?.close();
    child?.stdin.end();
    if (child) await waitBounded(exit, 5_000);
    await cleanup();
    if (child && !exited) await waitBounded(exit, 3_000);
    if (child && !exited) throw new OpenCodeRuntimeError("opencode_owned_cleanup_unproved");
  })().catch(cause => {
    // The same retained ownership evidence can be checked again after a
    // transient procfs ambiguity resolves. Never create a replacement owner.
    stopping = undefined;
    throw cause;
  });
  try {
    input.assertLaunchAdmission?.();
    await probeOpenCodeRelease(executablePath, environment);
    input.assertLaunchAdmission?.();
    child = spawn(executablePath, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: workingDirectory, env: environment, detached: true, stdio: ["pipe", "pipe", "pipe"],
    });
    const launched = child;
    launched.stderr.resume();
    exit = new Promise(resolve => {
      const finished = () => { exited = true; resolve(); };
      launched.once("close", finished);
      launched.once("error", finished);
    });
    const endpoint = await new Promise<string>((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      let settled = false;
      const finish = (error?: OpenCodeRuntimeError, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        launched.stdout.off("data", data);
        launched.stdout.off("end", ended);
        launched.off("error", ended);
        launched.off("exit", ended);
        buffer = Buffer.alloc(0);
        launched.stdout.resume();
        if (error) reject(error); else resolve(value!);
      };
      const ended = () => finish(new OpenCodeRuntimeError("opencode_startup_exited"));
      const data = (chunk: Buffer) => {
        if (buffer.length + chunk.length > 4_096) return finish(new OpenCodeRuntimeError("opencode_startup_frame_too_large"));
        buffer = Buffer.concat([buffer, chunk]);
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        try {
          const frame: unknown = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
          if (!frame || typeof frame !== "object" || Array.isArray(frame) || Object.keys(frame).length !== 1 || !("url" in frame) || typeof frame.url !== "string") throw new Error();
          const url = openCodeEndpoint(frame.url);
          if (!url.startsWith("http://127.0.0.1:")) throw new Error();
          finish(undefined, url);
        } catch { finish(new OpenCodeRuntimeError("opencode_startup_frame_invalid")); }
      };
      const timer = setTimeout(() => finish(new OpenCodeRuntimeError("opencode_startup_timeout")), 30_000);
      launched.stdout.on("data", data);
      launched.stdout.once("end", ended);
      launched.once("error", ended);
      launched.once("exit", ended);
    });
    if (!launched.pid || exited) throw new OpenCodeRuntimeError("opencode_startup_exited");
    client = new OpenCodeHttpClient({ endpoint, password });
    return Object.freeze({ pid: launched.pid, executablePath, endpoint, client, exited: exit, shellEnvironment, stop });
  } catch (cause) {
    try { await stop(); }
    catch { throw new OpenCodeOwnedCleanupUnprovedError(stop); }
    throw cause instanceof OpenCodeRuntimeError ? cause : new OpenCodeRuntimeError("opencode_owned_start_failed");
  }
}
