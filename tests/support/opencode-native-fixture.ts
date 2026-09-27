import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, rm, stat, writeFile } from "node:fs/promises";
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
const PROCESS_MARKER_NAME = "SEDES_OPENCODE_FIXTURE_OWNER";
const MAX_PROCESS_ENTRIES = 16_384;
const MAX_PROCESS_ENVIRONMENT_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 64 * 1024 * 1024;
const execFileAsync = promisify(execFile);

interface FixtureProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly startTime: string;
}

function disappeared(error: unknown): boolean {
  return ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "");
}

class FixtureCleanupError extends Error {
  constructor(readonly stage: string, readonly pid?: number, readonly code?: string) {
    super(`OpenCode fixture descendant cleanup unproven (${stage}${pid === undefined ? "" : ` pid=${pid}`}${code === undefined ? "" : ` code=${code}`}); retained isolated directory`);
  }
}

function cleanupUnproven(stage = "verification", pid?: number, code?: string): FixtureCleanupError {
  return new FixtureCleanupError(stage, pid, code);
}

// /proc files often report size zero. Bound the actual reads, including when a
// process races an exec, and never retain/log another process's environment.
async function boundedProcessFile(file: string, maximumBytes: number): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(file, "r");
    const bytes = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length <= maximumBytes) {
      const read = await handle.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) return bytes.subarray(0, length);
      length += read.bytesRead;
    }
    throw cleanupUnproven();
  } catch (error) {
    if (disappeared(error)) return undefined;
    if (error instanceof FixtureCleanupError) throw error;
    const match = /^\/proc\/(\d+)\/(stat|environ)$/u.exec(file);
    const code = (error as NodeJS.ErrnoException).code;
    throw cleanupUnproven(match?.[2] ?? "process_read", match ? Number(match[1]) : undefined,
      code && /^[A-Z0-9_]{1,24}$/u.test(code) ? code : "UNKNOWN");
  } finally {
    await handle?.close();
  }
}

async function fixtureProcess(pid: number): Promise<FixtureProcess | undefined> {
  const bytes = await boundedProcessFile(`/proc/${pid}/stat`, 4096);
  if (!bytes) return undefined;
  const value = bytes.toString("utf8");
  // comm can contain whitespace and parentheses; fields start after its final ).
  const fields = value.slice(value.lastIndexOf(")") + 2).trim().split(/\s+/u);
  if (!/^\d+$/u.test(fields[19] ?? "") || !/^\d+$/u.test(fields[1] ?? "") || !/^[A-Z]$/u.test(fields[0] ?? "")) throw cleanupUnproven();
  // Zombies have closed their descriptors and cannot execute or spawn work.
  if (fields[0] === "Z" || fields[0] === "X") return undefined;
  return { pid, parentPid: Number(fields[1]), startTime: fields[19]! };
}

function fixtureProcessKey(process: FixtureProcess): string {
  return `${process.pid}:${process.startTime}`;
}

async function createFixtureProcessCleanup(marker: string) {
  const owned = new Map<string, FixtureProcess>();
  const expected = Buffer.from(`${PROCESS_MARKER_NAME}=${marker}\0`);
  // Capture before the first fixture process is spawned. Existing processes
  // cannot have inherited this new marker; some same-account services make
  // their environments unreadable. PID + start time keeps reuse distinguishable.
  const preexisting = new Set<string>();
  const initialEntries = (await readdir("/proc")).filter(entry => /^[1-9]\d*$/u.test(entry));
  if (initialEntries.length > MAX_PROCESS_ENTRIES) throw cleanupUnproven();
  const initialDeadline = Date.now() + 5000;
  for (const entry of initialEntries) {
    if (Date.now() >= initialDeadline) throw cleanupUnproven();
    const identity = await fixtureProcess(Number(entry));
    if (identity) preexisting.add(fixtureProcessKey(identity));
  }
  const launchAncestors = new Set<string>();
  let ancestorPid = process.pid;
  while (ancestorPid !== 0) {
    if (launchAncestors.size >= 128) throw cleanupUnproven("launch_ancestry");
    const ancestor = await fixtureProcess(ancestorPid);
    if (!ancestor || launchAncestors.has(fixtureProcessKey(ancestor))) throw cleanupUnproven("launch_ancestry");
    launchAncestors.add(fixtureProcessKey(ancestor));
    ancestorPid = ancestor.parentPid;
  }
  const unrelatedAncestry = async (candidate: FixtureProcess): Promise<boolean> => {
    const chain: FixtureProcess[] = [];
    let current: FixtureProcess | undefined = candidate;
    while (current && chain.length < 128) {
      const key = fixtureProcessKey(current);
      // A fixture orphan may be reparented to one of our launch ancestors or
      // its subreapers. Reaching one of those never proves unrelated ownership.
      if (launchAncestors.has(key) || owned.has(key)) return false;
      chain.push(current);
      if (preexisting.has(key)) {
        // A different pre-existing branch cannot have inherited our marker.
        // Recheck every observed parent link so exit/reparent/PID-reuse races
        // cannot turn a speculative process-tree snapshot into that proof.
        for (const observed of chain) {
          const fresh = await fixtureProcess(observed.pid);
          if (!fresh || fresh.startTime !== observed.startTime || fresh.parentPid !== observed.parentPid) return false;
        }
        return true;
      }
      const parent: FixtureProcess | undefined = current.parentPid === 0 ? undefined : await fixtureProcess(current.parentPid);
      if (parent && BigInt(parent.startTime) > BigInt(current.startTime)) return false;
      current = parent;
    }
    return false;
  };
  const scan = async () => {
    const entries = (await readdir("/proc")).filter(entry => /^[1-9]\d*$/u.test(entry));
    if (entries.length > MAX_PROCESS_ENTRIES) throw cleanupUnproven();
    const deadline = Date.now() + 5000;
    let bytesRead = 0;
    for (const entry of entries) {
      if (Date.now() >= deadline || bytesRead > MAX_SCAN_BYTES) throw cleanupUnproven();
      const pid = Number(entry);
      if (pid === process.pid) continue;
      try {
        // Other accounts cannot be descendants of this unprivileged fixture.
        if ((await stat(`/proc/${pid}`)).uid !== process.getuid!()) continue;
        const before = await fixtureProcess(pid);
        if (!before || preexisting.has(fixtureProcessKey(before))) continue;
        if (owned.has(fixtureProcessKey(before))) continue;
        const environment = await boundedProcessFile(`/proc/${pid}/environ`, MAX_PROCESS_ENVIRONMENT_BYTES).catch(async (error: unknown) => {
          // Linux can deny environ reads while a process exits, after the
          // earlier live stat read, or during exec credential transitions.
          // Retry briefly with identity checks; never waive a persistent denial.
          if (error instanceof FixtureCleanupError && (error.code === "EACCES" || error.code === "EPERM")) {
            const retryDeadline = Date.now() + 250;
            do {
              const current = await fixtureProcess(pid);
              if (!current || current.startTime !== before.startTime) return undefined;
              if (await unrelatedAncestry(current)) return undefined;
              await delay(10);
              try { return await boundedProcessFile(`/proc/${pid}/environ`, MAX_PROCESS_ENVIRONMENT_BYTES); }
              catch (retryError) {
                if (!(retryError instanceof FixtureCleanupError) || !["EACCES", "EPERM"].includes(retryError.code ?? "")) throw retryError;
              }
            } while (Date.now() < retryDeadline);
            const current = await fixtureProcess(pid);
            if (!current || current.startTime !== before.startTime) return undefined;
            throw cleanupUnproven(`environ parent=${current.parentPid}`, pid, error.code);
          }
          throw error;
        });
        if (!environment) continue;
        bytesRead += environment.length;
        const offset = environment.indexOf(expected);
        if (offset < 0 || (offset > 0 && environment[offset - 1] !== 0)) continue;
        const after = await fixtureProcess(pid);
        if (after?.startTime === before.startTime) owned.set(fixtureProcessKey(after), after);
      } catch (error) {
        if (!disappeared(error)) throw error instanceof FixtureCleanupError ? error : cleanupUnproven("process_scan", pid);
      }
    }
    if (bytesRead > MAX_SCAN_BYTES) throw cleanupUnproven();
    // Remember identified descendants even if they later replace their env.
    for (const [key, previous] of owned) {
      const current = await fixtureProcess(previous.pid);
      if (current?.startTime !== previous.startTime) owned.delete(key);
    }
    return [...owned.values()];
  };
  const signal = async (target: FixtureProcess, value: NodeJS.Signals) => {
    // Revalidate start time immediately before signaling, never signal a bare
    // reused PID or group after its original process has exited.
    const current = await fixtureProcess(target.pid);
    if (current?.startTime !== target.startTime) return;
    try { process.kill(target.pid, value); }
    catch (error) { if (!disappeared(error)) throw cleanupUnproven(); }
  };
  return async () => {
    const deadline = Date.now() + 15_000;
    const terminatedAt = new Map<string, number>();
    const killed = new Set<string>();
    let emptyScans = 0;
    do {
      const remaining = await scan();
      if (remaining.length === 0) {
        // A second scan covers a child forked while the prior process list
        // was being read, including children reparented when the root exits.
        if (++emptyScans === 2) return;
      } else {
        emptyScans = 0;
        for (const target of remaining) {
          const key = fixtureProcessKey(target);
          const terminated = terminatedAt.get(key);
          if (terminated === undefined) {
            await signal(target, "SIGTERM");
            terminatedAt.set(key, Date.now());
          } else if (Date.now() - terminated >= 5000 && !killed.has(key)) {
            await signal(target, "SIGKILL");
            killed.add(key);
          }
        }
      }
      await delay(25);
    } while (Date.now() < deadline);
    // Keep the directory if repeated late forks prevent bounded extinction.
    // Each discovered process gets a full five seconds after its own SIGTERM.
    if ((await scan()).length !== 0) throw cleanupUnproven();
  };
}

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
  if (process.platform !== "linux") throw new Error("OpenCode qualification cleanup currently requires Linux /proc");
  const executable = process.env.SEDES_REAL_OPENCODE_EXECUTABLE ?? "opencode2";
  const marker = randomBytes(32).toString("hex");
  const cleanupProcesses = await createFixtureProcessCleanup(marker);
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
    [PROCESS_MARKER_NAME]: marker,
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
    await cleanupProcesses();
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
    await wait(5000);
    // Native MCP and shell children can start detached process groups. The
    // synthetic marker follows them even after the root exits and native CLI
    // strips its own OPENCODE_PASSWORD before starting child processes.
    await cleanupProcesses();
    if (!exited) await wait(3000);
    if (!exited) throw cleanupUnproven();
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
