import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { AntigravityError, type AntigravityHistory, type AntigravityIdentity, type AntigravityRuntimeConfiguration } from "./port.js";

declare const __SEDES_ANTIGRAVITY_HISTORY_WORKER_SOURCE__: string;
declare const __SEDES_ANTIGRAVITY_HISTORY_WORKER_MANIFEST__: string;
const MAXIMUM_PENDING = 128;
const MAXIMUM_CACHE_BYTES = 64 * 1024 * 1024;
export interface AntigravityNativeHistoryReader {
  read(identity: AntigravityIdentity, signal?: AbortSignal): Promise<AntigravityHistory>;
  forget(identity: AntigravityIdentity): Promise<void>;
  close(): Promise<void>;
}
export type NativeHistoryWorkerRequest = { id: number; kind: "read" | "forget"; identity: AntigravityIdentity;
  cancellation: SharedArrayBuffer; knownRevision?: string } | { id: number; kind: "close" };
export type NativeHistoryWorkerResponse = { id: number; kind: "read"; history: AntigravityHistory | null; revision: string; bytes: number }
  | { id: number; kind: "done" } | { id: number; kind: "error"; code: string };
type Pending = { resolve(value: NativeHistoryWorkerResponse): void; reject(error: unknown): void; cancellation: Int32Array; removeAbort(): void };
type ReadingKey = { generation: symbol; pending: number };

/** One worker belongs to one already-authorized backend runtime configuration.
 * No process-global cache or arbitrary filesystem path is accepted by reads. */
export function createAntigravityNativeHistoryReader(configuration: AntigravityRuntimeConfiguration): AntigravityNativeHistoryReader {
  return new NativeHistoryReader(configuration);
}
class NativeHistoryReader implements AntigravityNativeHistoryReader {
  readonly #pending = new Map<number, Pending>();
  readonly #cache = new Map<string, { history: AntigravityHistory; bytes: number }>();
  // Retained only while reads are in flight; forget never accumulates per-key tombstones.
  readonly #readingKeys = new Map<string, ReadingKey>();
  #cacheGeneration = Symbol();
  #cacheBytes = 0;
  #sequence = 0;
  #starting = 0;
  readonly #lifetime = new AbortController();
  #worker?: Promise<Worker>;
  #activeWorker?: Worker;
  #workerGeneration = Symbol();
  readonly #retiring = new Map<Worker, Promise<number> | undefined>();
  #failures = 0;
  #retryAt = 0;
  #closed = false;
  #closing?: Promise<void>;
  constructor(readonly configuration: AntigravityRuntimeConfiguration) {}
  #key(identity: AntigravityIdentity) { return JSON.stringify([identity.sessionId, identity.cwd]); }
  async #start(): Promise<Worker> {
    if (this.#closed) throw new AntigravityError("antigravity_history_reader_closed");
    if (this.#worker) return this.#worker;
    if (Date.now() < this.#retryAt) throw new AntigravityError("antigravity_history_worker_backoff");
    const generation = this.#workerGeneration = Symbol();
    const work = (async () => {
      // Passive worker replacement never overlaps an owned failed worker.
      await Promise.all([...this.#retiring.keys()].map(worker => this.#terminate(worker)));
      if (this.#closed) throw new AntigravityError("antigravity_history_reader_closed");
      const embedded = typeof __SEDES_ANTIGRAVITY_HISTORY_WORKER_SOURCE__ === "string";
      const directory = new URL("../../../../dist/antigravity-history-worker/", import.meta.url);
      const source = embedded ? __SEDES_ANTIGRAVITY_HISTORY_WORKER_SOURCE__ : await readFile(new URL("sedes-antigravity-history-worker.mjs", directory), { encoding: "utf8", signal: this.#lifetime.signal });
      const manifest = JSON.parse(embedded ? __SEDES_ANTIGRAVITY_HISTORY_WORKER_MANIFEST__ : await readFile(new URL("manifest.json", directory), { encoding: "utf8", signal: this.#lifetime.signal })) as Record<string, unknown>;
      if (manifest.schemaVersion !== 1 || manifest.artifactId !== "openai.sedes.antigravity-history-worker" ||
          manifest.filename !== "sedes-antigravity-history-worker.mjs" || typeof manifest.bytes !== "number" || manifest.bytes !== Buffer.byteLength(source) ||
          manifest.bytes > 4 * 1024 * 1024 || manifest.sha256 !== createHash("sha256").update(source).digest("hex"))
        throw new AntigravityError("antigravity_history_worker_artifact_invalid");
      if (this.#closed) throw new AntigravityError("antigravity_history_reader_closed");
      // Native-directory authority only. Provider credentials, environment
      // overrides, and executable configuration never enter this worker.
      const { tenantId, principalId, backendInstanceId, executionEnvironmentId } = this.configuration;
      const geminiDirectory = this.configuration.geminiDirectory ?? path.join(homedir(), ".gemini");
      const worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`), {
        workerData: { tenantId, principalId, backendInstanceId, executionEnvironmentId, geminiDirectory, initializationTimeoutMs: 1000 },
        env: {}, execArgv: [],
      });
      this.#activeWorker = worker;
      worker.on("message", (response: NativeHistoryWorkerResponse) => {
        if (this.#closed || generation !== this.#workerGeneration) return;
        const pending = this.#pending.get(response.id); if (!pending) return;
        this.#pending.delete(response.id); pending.removeAbort();
        if (!this.#pending.size) worker.unref();
        if (response.kind === "error") pending.reject(new AntigravityError(response.code));
        else { if (response.kind === "read") { this.#failures = 0; this.#retryAt = 0; } pending.resolve(response); }
      });
      const failed = () => this.#workerFailed(generation, worker);
      worker.on("error", failed); worker.on("exit", failed); worker.unref(); return worker;
    })();
    this.#worker = work;
    void work.catch(() => this.#workerFailed(generation));
    return work;
  }
  #workerFailed(generation: symbol, worker?: Worker): void {
    if (this.#closed || generation !== this.#workerGeneration) return;
    this.#workerGeneration = Symbol(); this.#worker = undefined; this.#activeWorker = undefined;
    this.#rejectPending(new AntigravityError("antigravity_history_worker_unavailable"));
    this.#cache.clear(); this.#cacheBytes = 0; this.#cacheGeneration = Symbol();
    // Retry only on a later read, once per bounded exponential backoff. No
    // provider requests are replayed; this worker only passively reads SQLite.
    this.#failures = Math.min(this.#failures + 1, 8);
    this.#retryAt = Date.now() + Math.min(250 * 2 ** (this.#failures - 1), 30_000);
    if (worker) {
      void this.#terminate(worker).catch(() => undefined);
    }
  }
  #terminate(worker: Worker): Promise<number> {
    const existing = this.#retiring.get(worker);
    if (existing) return existing;
    const terminating = Promise.resolve().then(() => worker.terminate());
    this.#retiring.set(worker, terminating);
    void terminating.then(() => this.#retiring.delete(worker), () => {
      // Keep ownership after a failed termination so replacement/close must
      // retry it before considering cleanup proven.
      if (this.#retiring.get(worker) === terminating) this.#retiring.set(worker, undefined);
    });
    return terminating;
  }
  async #request(kind: "read" | "forget", identity: AntigravityIdentity, signal?: AbortSignal, knownRevision?: string): Promise<NativeHistoryWorkerResponse> {
    signal?.throwIfAborted();
    if (this.#pending.size + this.#starting >= MAXIMUM_PENDING) throw new AntigravityError("antigravity_history_reader_capacity");
    this.#starting++;
    let worker: Worker;
    try { worker = await this.#start(); }
    catch (error) { if (this.#closed) throw new AntigravityError("antigravity_history_reader_closed"); throw error; }
    finally { this.#starting--; }
    signal?.throwIfAborted();
    if (this.#closed) throw new AntigravityError("antigravity_history_reader_closed");
    if (worker !== this.#activeWorker) throw new AntigravityError("antigravity_history_worker_unavailable");
    if (this.#pending.size >= MAXIMUM_PENDING) throw new AntigravityError("antigravity_history_reader_capacity");
    const id = ++this.#sequence, cancellation = new Int32Array(new SharedArrayBuffer(4));
    return new Promise((resolve, reject) => {
      const abort = () => {
        // Keep the bounded admission slot until the worker consumes this job.
        Atomics.store(cancellation, 0, 1); signal?.removeEventListener("abort", abort);
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
      };
      this.#pending.set(id, { resolve, reject, cancellation, removeAbort: () => signal?.removeEventListener("abort", abort) });
      signal?.addEventListener("abort", abort, { once: true }); worker.ref();
      try { worker.postMessage({ id, kind, identity, cancellation: cancellation.buffer, ...(knownRevision ? { knownRevision } : {}) } satisfies NativeHistoryWorkerRequest); }
      catch (error) { this.#pending.delete(id); signal?.removeEventListener("abort", abort); if (!this.#pending.size) worker.unref(); reject(error); }
    });
  }
  async read(identity: AntigravityIdentity, signal?: AbortSignal): Promise<AntigravityHistory> {
    const key = this.#key(identity), previous = this.#cache.get(key), generation = this.#cacheGeneration;
    const reading = this.#readingKeys.get(key) ?? { generation: Symbol(), pending: 0 };
    const keyGeneration = reading.generation;
    reading.pending++; this.#readingKeys.set(key, reading);
    try {
      const response = await this.#request("read", identity, signal, previous?.history.native.revision);
      signal?.throwIfAborted();
      if (this.#closed) throw new AntigravityError("antigravity_history_reader_closed");
      if (response.kind !== "read") throw new AntigravityError("antigravity_history_worker_response_invalid");
      if (response.history === null) {
        if (!previous || previous.history.native.revision !== response.revision) throw new AntigravityError("antigravity_history_worker_response_invalid");
        if (generation === this.#cacheGeneration && keyGeneration === reading.generation && this.#cache.get(key) === previous) {
          this.#cache.delete(key); this.#cache.set(key, previous);
        }
        return previous.history;
      }
      if (generation !== this.#cacheGeneration || keyGeneration !== reading.generation) return response.history;
      const current = this.#cache.get(key); this.#cacheBytes -= current?.bytes ?? 0; this.#cache.delete(key);
      if (response.bytes <= MAXIMUM_CACHE_BYTES) {
        while (this.#cache.size >= 64 || this.#cacheBytes + response.bytes > MAXIMUM_CACHE_BYTES) {
          const oldest = this.#cache.entries().next().value; if (!oldest) break;
          this.#cache.delete(oldest[0]); this.#cacheBytes -= oldest[1].bytes;
        }
        this.#cache.set(key, { history: response.history, bytes: response.bytes }); this.#cacheBytes += response.bytes;
      }
      return response.history;
    } finally {
      if (--reading.pending === 0 && this.#readingKeys.get(key) === reading) this.#readingKeys.delete(key);
    }
  }
  #forgetCache(key: string): void {
    const reading = this.#readingKeys.get(key);
    if (reading) reading.generation = Symbol();
    const previous = this.#cache.get(key);
    this.#cache.delete(key); this.#cacheBytes -= previous?.bytes ?? 0;
  }
  async forget(identity: AntigravityIdentity): Promise<void> {
    const key = this.#key(identity);
    this.#forgetCache(key);
    if (this.#closed || !this.#worker) return;
    try { await this.#request("forget", identity); }
    catch (error) { if (!this.#closed) throw error; }
    this.#forgetCache(key);
  }
  #rejectPending(error: unknown) {
    for (const pending of this.#pending.values()) {
      Atomics.store(pending.cancellation, 0, 1); pending.removeAbort(); pending.reject(error);
    }
    this.#pending.clear();
  }
  close(): Promise<void> {
    this.#closed = true;
    this.#workerGeneration = Symbol();
    this.#lifetime.abort();
    this.#rejectPending(new AntigravityError("antigravity_history_reader_closed"));
    this.#cache.clear(); this.#cacheBytes = 0;
    this.#cacheGeneration = Symbol();
    if (this.#closing) return this.#closing;
    const closing = (async () => {
      const worker = await this.#worker?.catch(() => undefined);
      await Promise.all([...this.#retiring.keys()].filter(retiring => retiring !== worker).map(retiring => this.#terminate(retiring)));
      if (!worker) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let listener: ((response: NativeHistoryWorkerResponse) => void) | undefined;
      let exited: (() => void) | undefined;
      try {
        await Promise.race([new Promise<void>(resolve => {
          const id = ++this.#sequence;
          listener = response => { if (response.id === id) resolve(); };
          exited = resolve;
          worker.on("message", listener); worker.once("exit", exited); worker.ref();
          worker.postMessage({ id, kind: "close" } satisfies NativeHistoryWorkerRequest);
        }), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
      } finally {
        if (timer) clearTimeout(timer);
        if (listener) worker.off("message", listener);
        if (exited) worker.off("exit", exited);
        await this.#terminate(worker);
        this.#worker = undefined; this.#activeWorker = undefined;
      }
    })();
    this.#closing = closing;
    void closing.catch(() => { if (this.#closing === closing) this.#closing = undefined; });
    return closing;
  }
}
