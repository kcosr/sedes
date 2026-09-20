import { constants } from "node:fs";
import { lstat, open, unlink } from "node:fs/promises";
import { Session, type Profiler } from "node:inspector";
import path from "node:path";

const MAX_PROFILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_SECONDS = 90;
const MAX_SECONDS = 120;
const SAMPLE_MICROSECONDS = 10_000;

/** One operator-requested main-process CPU profile. An in-process inspector
 * session never opens a network listener, evaluates code, or captures a heap. */
export function startMainCpuProfile(environment: NodeJS.ProcessEnv = process.env): () => Promise<void> {
  const directory = environment.SEDES_DEBUG_CPU_PROFILE_DIRECTORY;
  if (!environment.SEDES_DEBUG_DELIVERY || !directory) return async () => {};
  const configured = environment.SEDES_DEBUG_CPU_PROFILE_SECONDS;
  const seconds = configured === undefined ? DEFAULT_SECONDS : Number(configured);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > MAX_SECONDS ||
    (configured !== undefined && !/^[1-9][0-9]*$/u.test(configured)) || !path.isAbsolute(directory) || process.platform === "win32") {
    report("failed", { code: "configuration_invalid" });
    return async () => {};
  }
  try {
    const capture = new MainCpuProfile(directory, seconds);
    return () => capture.stop();
  } catch {
    report("failed", { code: "inspector_unavailable" });
    return async () => {};
  }
}

class MainCpuProfile {
  readonly #session = new Session();
  readonly #directory: string;
  readonly #seconds: number;
  readonly #ready: Promise<void>;
  readonly #controller = new AbortController();
  #started = 0;
  #connected = false;
  #recording = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopping: Promise<void> | undefined;
  #completion: Promise<void> | undefined;

  constructor(directory: string, seconds: number) {
    this.#directory = directory;
    this.#seconds = seconds;
    this.#ready = this.#start().catch(() => {
      report("failed", { code: this.#connected ? "inspector_start_failed" : "directory_or_inspector_unavailable" });
      this.#disconnect();
    });
  }

  async #start(): Promise<void> {
    await assertPrivateDirectory(this.#directory);
    this.#controller.signal.throwIfAborted();
    this.#session.connect(); this.#connected = true;
    await this.#post("Profiler.enable");
    this.#controller.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => this.#session.post("Profiler.setSamplingInterval", { interval: SAMPLE_MICROSECONDS }, error => error ? reject(error) : resolve()));
    this.#controller.signal.throwIfAborted();
    await this.#post("Profiler.start");
    this.#controller.signal.throwIfAborted();
    this.#recording = true;
    this.#started = performance.now();
    report("started", { requestedDurationMs: this.#seconds * 1000, samplingIntervalUs: SAMPLE_MICROSECONDS });
    this.#timer = setTimeout(() => { void this.#complete(); }, this.#seconds * 1000);
    this.#timer.unref();
  }

  stop(): Promise<void> {
    this.#stopping ??= this.#boundedFinish();
    return this.#stopping;
  }

  #complete(): Promise<void> {
    this.#completion ??= this.#finish();
    return this.#completion;
  }

  async #boundedFinish(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.#complete(), new Promise<void>(resolve => {
        timeout = setTimeout(() => {
          this.#controller.abort();
          if (this.#timer) clearTimeout(this.#timer);
          this.#recording = false;
          this.#disconnect();
          report("failed", { code: "profile_stop_timeout" });
          resolve();
        }, 500);
        timeout.unref();
      })]);
    } finally { if (timeout) clearTimeout(timeout); }
  }

  async #finish(): Promise<void> {
    await this.#ready;
    if (this.#timer) clearTimeout(this.#timer);
    if (!this.#recording) { this.#disconnect(); return; }
    this.#recording = false;
    let stage = "inspector_stop_failed";
    let created: string | undefined;
    try {
      const { profile } = await new Promise<Profiler.StopReturnType>((resolve, reject) => this.#session.post("Profiler.stop", (error, result) => error ? reject(error) : resolve(result)));
      this.#controller.signal.throwIfAborted();
      const durationMs = Math.round(performance.now() - this.#started);
      await this.#post("Profiler.disable");
      this.#disconnect();
      stage = "profile_serialization_failed";
      const serialized = JSON.stringify(profile);
      const bytes = Buffer.byteLength(serialized);
      if (bytes > MAX_PROFILE_BYTES) { report("failed", { code: "profile_size_limit", durationMs, bytes }); return; }
      stage = "profile_write_failed";
      await assertPrivateDirectory(this.#directory);
      this.#controller.signal.throwIfAborted();
      const filePath = path.join(this.#directory, `main-${process.pid}-${Date.now()}.cpuprofile`);
      const file = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
      created = filePath;
      try {
        this.#controller.signal.throwIfAborted();
        await file.chmod(0o600);
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw new Error("profile_file_invalid");
        await file.writeFile(serialized, { signal: this.#controller.signal });
      } finally { await file.close(); }
      this.#controller.signal.throwIfAborted();
      report("complete", { durationMs, bytes });
    } catch {
      if (created) await unlink(created).catch(() => {});
      report("failed", { code: stage, durationMs: Math.round(performance.now() - this.#started) });
    } finally { this.#disconnect(); }
  }

  #post(method: "Profiler.enable" | "Profiler.start" | "Profiler.disable"): Promise<void> {
    return new Promise((resolve, reject) => this.#session.post(method, error => error ? reject(error) : resolve()));
  }

  #disconnect(): void {
    if (!this.#connected) return;
    this.#connected = false;
    try { this.#session.disconnect(); } catch { /* Diagnostics cannot affect main startup/shutdown. */ }
  }
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("profile_directory_not_private");
}

function report(event: "started" | "complete" | "failed", fields: { code?: string; durationMs?: number; bytes?: number; requestedDurationMs?: number; samplingIntervalUs?: number }): void {
  try { console.error(`[delivery-cpu-profile] ${JSON.stringify({ event, timestamp: new Date().toISOString(), role: "main", pid: process.pid, ...fields })}`); }
  catch { /* Never emit profile content or arbitrary exception properties. */ }
}
