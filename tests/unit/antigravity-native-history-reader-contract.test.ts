import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { NativeHistoryWorkerRequest, NativeHistoryWorkerResponse } from "../../src/server/backends/antigravity/native-history-reader.js";

const mocks = vi.hoisted(() => ({ source: "export {};", corrupt: false, readFailure: false, workers: [] as unknown[] }));
vi.mock("node:fs/promises", async importOriginal => ({ ...await importOriginal<typeof import("node:fs/promises")>(),
  readFile: vi.fn(async (file: URL) => { if (mocks.readFailure) throw new Error("temporary artifact read failure"); return file.pathname.endsWith("manifest.json") ? JSON.stringify({ schemaVersion: 1,
    artifactId: "openai.sedes.antigravity-history-worker", filename: "sedes-antigravity-history-worker.mjs", bytes: Buffer.byteLength(mocks.source),
    sha256: mocks.corrupt ? "0".repeat(64) : createHash("sha256").update(mocks.source).digest("hex") }) : mocks.source; }) }));
vi.mock("node:worker_threads", () => ({ Worker: class extends EventEmitter {
  readonly requests: NativeHistoryWorkerRequest[] = [];
  readonly terminated = vi.fn(async () => { this.emit("exit", 0); return 0; });
  constructor(readonly source: URL, readonly options: Record<string, unknown>) { super(); mocks.workers.push(this); }
  ref() {} unref() {} terminate() { return this.terminated(); }
  postMessage(request: NativeHistoryWorkerRequest) {
    this.requests.push(request);
    if (request.kind === "close") queueMicrotask(() => this.emit("message", { id: request.id, kind: "done" }));
  }
} }));
import { createAntigravityNativeHistoryReader, type AntigravityNativeHistoryReader } from "../../src/server/backends/antigravity/native-history-reader.js";

type FakeWorker = EventEmitter & { requests: NativeHistoryWorkerRequest[]; options: Record<string, unknown>; terminated: ReturnType<typeof vi.fn> };
const configuration = { tenantId: "tenant", principalId: "principal", backendInstanceId: "backend", executionEnvironmentId: "local", geminiDirectory: "/native", initializationTimeoutMs: 1000,
  startupEnvironmentVariables: { PRIVATE_VALUE: { kind: "literal" as const, value: "must-not-enter-worker" } } };
const identity = { sessionId: "8a54e222-1000-4000-8000-000000000001", cwd: "/workspace" };
const history = { ...identity, native: { revision: "a".repeat(64), executions: [], steps: [] } };
const readers: AntigravityNativeHistoryReader[] = [];
const reader = () => { const value = createAntigravityNativeHistoryReader(configuration); readers.push(value); return value; };
afterEach(async () => { for (const value of readers.splice(0)) await value.close(); mocks.workers.length = 0; mocks.corrupt = false; mocks.readFailure = false; vi.restoreAllMocks(); });
async function worker(index = 0): Promise<FakeWorker> { await vi.waitFor(() => expect(mocks.workers).toHaveLength(index + 1)); return mocks.workers[index] as FakeWorker; }
async function request(worker: FakeWorker, index: number) { await vi.waitFor(() => expect(worker.requests.length).toBeGreaterThan(index)); return worker.requests[index]!; }
function reply(worker: FakeWorker, id: number) { worker.emit("message", { id, kind: "read", history, revision: history.native.revision, bytes: 200 } satisfies NativeHistoryWorkerResponse); }

describe("native history worker isolation and publication", () => {
  it("rejects a mismatched artifact before starting any worker", async () => {
    mocks.corrupt = true;
    await expect(reader().read(identity)).rejects.toThrow("artifact_invalid");
    expect(mocks.workers).toHaveLength(0);
  });
  it("passes only pinned directory/scope with no inherited environment or runtime arguments", async () => {
    const value = reader(), pending = value.read(identity), running = await worker(), first = await request(running, 0);
    expect(running.options).toMatchObject({ env: {}, execArgv: [], workerData: { geminiDirectory: "/native", tenantId: "tenant", principalId: "principal" } });
    expect(running.options.workerData).not.toHaveProperty("startupEnvironmentVariables");
    reply(running, first.id); await pending;
  });
  it("does not republish a read cache after concurrent forget", async () => {
    const value = reader(), pending = value.read(identity), running = await worker(), first = await request(running, 0);
    const forgotten = value.forget(identity), forget = await request(running, 1);
    reply(running, first.id); await pending;
    running.emit("message", { id: forget.id, kind: "done" }); await forgotten;
    const next = value.read(identity), second = await request(running, 2);
    expect(second).not.toHaveProperty("knownRevision"); reply(running, second.id); await next;
  });
  it("fences a response already delivered when close wins before its continuation", async () => {
    const value = reader(), pending = value.read(identity), rejected = expect(pending).rejects.toThrow("reader_closed");
    const running = await worker(), first = await request(running, 0);
    reply(running, first.id); await value.close(); await rejected;
    expect(running.terminated).toHaveBeenCalledOnce(); await value.forget(identity);
  });
  it("signals abort through shared memory without freeing the worker queue slot early", async () => {
    const value = reader(), controller = new AbortController();
    const pending = value.read(identity, controller.signal), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const running = await worker(), first = await request(running, 0);
    if (first.kind === "close") throw new Error();
    controller.abort(); await rejected; expect(Atomics.load(new Int32Array(first.cancellation), 0)).toBe(1);
    running.emit("message", { id: first.id, kind: "error", code: "antigravity_history_read_failed" });
    const next = value.read(identity), second = await request(running, 1); reply(running, second.id); await next;
  });
  it("recovers from a start failure on a later read after backoff", async () => {
    let now = 10_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const value = reader(); mocks.readFailure = true;
    await expect(value.read(identity)).rejects.toThrow("temporary artifact read failure");
    mocks.readFailure = false;
    await expect(value.read(identity)).rejects.toThrow("worker_backoff"); expect(mocks.workers).toHaveLength(0);
    now += 250;
    const pending = value.read(identity), running = await worker(), first = await request(running, 0);
    reply(running, first.id); await expect(pending).resolves.toEqual(history);
  });
  it("clears old generation caches and ignores an old worker exit after replacement", async () => {
    let now = 10_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const value = reader(), firstRead = value.read(identity), firstWorker = await worker(), first = await request(firstWorker, 0);
    reply(firstWorker, first.id); await firstRead;
    const pending = value.read(identity), rejected = expect(pending).rejects.toThrow("worker_unavailable");
    await request(firstWorker, 1); firstWorker.emit("error", new Error("injected worker failure")); await rejected;
    expect(firstWorker.terminated).toHaveBeenCalledOnce();
    await expect(value.read(identity)).rejects.toThrow("worker_backoff");
    now += 250;
    const replacementRead = value.read(identity), replacement = await worker(1), replacementRequest = await request(replacement, 0);
    expect(replacementRequest).not.toHaveProperty("knownRevision");
    firstWorker.emit("exit", 1); reply(replacement, replacementRequest.id);
    await expect(replacementRead).resolves.toEqual(history); expect(replacement.terminated).not.toHaveBeenCalled();
  });
  it("increases restart backoff across repeated crashes and keeps explicit close terminal", async () => {
    let now = 10_000; vi.spyOn(Date, "now").mockImplementation(() => now);
    const value = reader(), firstRead = value.read(identity), firstRejected = expect(firstRead).rejects.toThrow("worker_unavailable");
    const firstWorker = await worker(); await request(firstWorker, 0); firstWorker.emit("exit", 1); await firstRejected;
    now += 250;
    const next = value.read(identity), rejected = expect(next).rejects.toThrow("worker_unavailable");
    const secondWorker = await worker(1); await request(secondWorker, 0); secondWorker.emit("exit", 1); await rejected;
    now += 250;
    await expect(value.read(identity)).rejects.toThrow("worker_backoff"); expect(mocks.workers).toHaveLength(2);
    await value.close(); now += 60_000;
    await expect(value.read(identity)).rejects.toThrow("reader_closed"); expect(mocks.workers).toHaveLength(2);
  });
});
