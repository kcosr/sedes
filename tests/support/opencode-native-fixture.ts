import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

// Qualification only. This deliberately does not register a production backend
// or use the operator's native account, configuration, or conversation store.
export const RUN_REAL_OPENCODE = process.env.SEDES_RUN_REAL_OPENCODE === "1";
export const OPENCODE_FIXTURE_VERSION = "2.0.18";
export const OPENCODE_FIXTURE_SOURCE = "cd9a14a6b688d4021bee381dfd39d2cef9c0f862";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

export interface OpenCodeNativeFixture {
  readonly rootDirectory: string;
  readonly workspace: string;
  readonly url: string;
  readonly pid: number;
  api(method: string, route: string, body?: unknown): Promise<{ status: number; body: any }>;
  stream(route: string, signal: AbortSignal): Promise<Response>;
  stop(): Promise<void>;
}

export async function startOpencodeNativeFixture(input: {
  config?: Record<string, unknown>;
  environment?: Record<string, string>;
} = {}): Promise<OpenCodeNativeFixture> {
  if (!RUN_REAL_OPENCODE) throw new Error("Set SEDES_RUN_REAL_OPENCODE=1 for isolated native qualification");
  if (process.platform === "win32") throw new Error("OpenCode qualification currently requires POSIX process groups");
  const executable = process.env.SEDES_REAL_OPENCODE_EXECUTABLE ?? "opencode2";
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-"));
  const workspace = path.join(rootDirectory, "workspace");
  const configDirectory = path.join(rootDirectory, "config", "opencode");
  const password = randomBytes(32).toString("hex");
  // Construct from an allowlist; in particular no provider credentials, hooks,
  // loader variables, inherited OPENCODE_* overrides, or real HOME survive.
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: "C.UTF-8",
    SHELL: "/bin/sh",
    ...input.environment,
    HOME: path.join(rootDirectory, "home"),
    XDG_CONFIG_HOME: path.join(rootDirectory, "config"),
    XDG_DATA_HOME: path.join(rootDirectory, "data"),
    XDG_CACHE_HOME: path.join(rootDirectory, "cache"),
    XDG_STATE_HOME: path.join(rootDirectory, "state"),
    OPENCODE_CONFIG_DIR: configDirectory,
    OPENCODE_CONFIG_PROJECT_DISABLE: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_MODELS_PATH: path.join(rootDirectory, "models.json"),
    OPENCODE_DISABLE_FFF: "1",
    OPENCODE_FILEWATCHER_DISABLE: "1",
    OPENCODE_PASSWORD: password,
  };
  try {
    await Promise.all([mkdir(workspace), mkdir(configDirectory, { recursive: true }), mkdir(environment.HOME!)]);
    await writeFile(environment.OPENCODE_MODELS_PATH!, "{}", { mode: 0o600 });
    await writeFile(path.join(configDirectory, "opencode.json"), JSON.stringify({ ...input.config, update: "disable" }), { mode: 0o600 });
    const version = await execFileAsync(executable, ["--version"], { env: environment, cwd: workspace, timeout: 10_000, maxBuffer: 4096 });
    if (version.stdout.trim() !== `opencode v${OPENCODE_FIXTURE_VERSION}`) {
      throw new Error(`Qualification requires opencode2 ${OPENCODE_FIXTURE_VERSION}; the selected executable is unreviewed`);
    }
  } catch (error) {
    await rm(rootDirectory, { recursive: true, force: true });
    throw error;
  }

  const child = spawn(executable, ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: workspace, env: environment, stdio: ["pipe", "pipe", "pipe"], detached: true,
  });
  child.stderr.resume(); // Native diagnostics may contain secrets; never retain.
  let exited = false;
  const exit = new Promise<void>((resolve) => {
    child.once("close", () => { exited = true; resolve(); });
    child.once("error", () => { exited = true; resolve(); });
  });
  let stopPromise: Promise<void> | undefined;
  const stop = () => stopPromise ??= (async () => {
    child.stdin.end();
    const wait = async (milliseconds: number) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([exit, new Promise<void>((resolve) => { timer = setTimeout(resolve, milliseconds); })]);
      clearTimeout(timer);
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    };
    await wait(5000);
    // A root exit alone does not own descendant cleanup. Signal the dedicated
    // group even if the root has already closed its pipes.
    signalGroup("SIGTERM");
    if (!exited) await wait(2000);
    signalGroup("SIGKILL");
    if (!exited) await wait(2000);
    if (!exited) throw new Error("OpenCode fixture cleanup unproven; retained isolated directory");
    const deadline = Date.now() + 3000;
    while (child.pid) {
      try { process.kill(-child.pid, 0); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw new Error("OpenCode fixture process-group cleanup unproven; retained isolated directory");
      }
      if (Date.now() >= deadline) throw new Error("OpenCode fixture descendants remain; retained isolated directory");
      await delay(20);
    }
    await rm(rootDirectory, { recursive: true, force: true });
  })();

  try {
    const url = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const finish = (error?: Error, value?: string) => {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        child.off("error", onError);
        child.off("exit", onExit);
        child.stdout.resume();
        if (error) reject(error); else resolve(value!);
      };
      const onError = () => finish(new Error("OpenCode fixture launch failed"));
      const onExit = () => finish(new Error("OpenCode fixture exited before readiness"));
      const onData = (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > 4096) return finish(new Error("Oversized OpenCode readiness frame"));
        if (!buffer.includes("\n")) return;
        try {
          const value = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
          const endpoint = new URL(value.url);
          if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw new Error();
          finish(undefined, endpoint.origin);
        } catch { finish(new Error("Invalid OpenCode fixture readiness frame")); }
      };
      const timer = setTimeout(() => finish(new Error("OpenCode fixture readiness timed out")), 30_000);
      child.stdout.on("data", onData);
      child.once("error", onError);
      child.once("exit", onExit);
    });
    const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    const request = (method: string, route: string, body: unknown, signal: AbortSignal) => {
      if (!route.startsWith("/api/") || route.startsWith("//")) throw new Error("Fixture route must be an API path");
      const endpoint = new URL(route, url);
      if (endpoint.origin !== url) throw new Error("Fixture request cannot leave its owned server");
      return fetch(endpoint, {
        method, redirect: "error", signal,
        headers: { authorization, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    };
    return {
      rootDirectory, workspace, url, pid: child.pid!, stop,
      stream: (route, signal) => request("GET", route, undefined, signal),
      api: async (method, route, body) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 30_000);
        try {
          const response = await request(method, route, body, controller.signal);
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          if (response.body) for await (const chunk of response.body) {
            bytes += chunk.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) throw new Error("OpenCode fixture response exceeded acquisition bound");
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString("utf8");
          return { status: response.status, body: raw ? JSON.parse(raw) : null };
        } finally { controller.abort(); clearTimeout(timer); }
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
