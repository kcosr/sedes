import { describe, expect, it, vi } from "vitest";
import { RetainedRuntimeLifecycle } from "../../src/server/backends/retained-runtime-lifecycle.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("retained backend residency", () => {
  it("waits for the last conversation and a complete multi-step history operation", async () => {
    const retire = vi.fn(async () => {});
    const runtime = new RetainedRuntimeLifecycle({ wake: () => {}, retire });
    const first = runtime.retain();
    const last = runtime.retain();
    const history = deferred();
    const operation = runtime.run(async () => { await history.promise; return "history"; });
    await first.release(true);
    expect(retire).not.toHaveBeenCalled();
    await last.release(true);
    expect(retire).not.toHaveBeenCalled();
    history.resolve();
    await expect(operation).resolves.toBe("history");
    expect(retire).toHaveBeenCalledTimes(1);
    await last.release(true);
    expect(retire).toHaveBeenCalledTimes(1);
  });

  it("does not interpret ordinary attachment release as idle eviction", async () => {
    const retire = vi.fn(async () => {});
    const runtime = new RetainedRuntimeLifecycle({ wake: () => {}, retire });
    await runtime.retain().release();
    await runtime.run(async () => {});
    expect(retire).not.toHaveBeenCalled();
  });

  it("waits for cleanup and shares one wake for racing new operations", async () => {
    const cleanup = deferred();
    const startup = deferred();
    const wake = vi.fn(() => startup.promise);
    const runtime = new RetainedRuntimeLifecycle({ wake, retire: () => cleanup.promise });
    const retired = runtime.retain().release(true);
    await Promise.resolve();
    const execute = vi.fn(async () => {});
    const first = runtime.run(execute);
    const second = runtime.run(execute);
    expect(wake).not.toHaveBeenCalled();
    cleanup.resolve();
    await retired;
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(execute).not.toHaveBeenCalled();
    startup.resolve();
    await Promise.all([first, second]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("preserves operation results while fencing an unproven cleanup", async () => {
    const history = deferred();
    const error = new Error("cleanup_unproven");
    const report = vi.fn(() => { throw new Error("diagnostic_failed"); });
    const runtime = new RetainedRuntimeLifecycle({ wake: () => {}, retire: async () => { throw error; }, onRetirementError: report });
    const conversation = runtime.retain();
    const operation = runtime.run(async () => { await history.promise; return "accepted"; });
    await conversation.release(true);
    history.resolve();
    await expect(operation).resolves.toBe("accepted");
    expect(report).toHaveBeenCalledWith(error);
    const execute = vi.fn(async () => {});
    await expect(runtime.run(execute)).rejects.toBe(error);
    expect(execute).not.toHaveBeenCalled();
  });
});
