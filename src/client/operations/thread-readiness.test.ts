// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import {
  getBlockingOperation,
  runBlockingOperation,
} from "./blocking-operation.js";
import {
  setOperationThreadRegistry,
  waitForOperationThreadReady,
} from "./thread-readiness.js";

function fixture() {
  let state = { status: "loading", snapshot: undefined, error: undefined } as {
    status: string;
    snapshot?: object;
    error?: string;
  };
  const listeners = new Set<() => void>();
  const store = {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const registry = { retain: vi.fn(() => store), release: vi.fn() };
  setOperationThreadRegistry(registry as unknown as ThreadStoreRegistry);
  return {
    registry,
    listeners,
    update: (next: typeof state) => {
      state = next;
      for (const listener of listeners) listener();
    },
  };
}
afterEach(() => {
  getBlockingOperation()?.cancel();
  setOperationThreadRegistry(undefined);
  vi.useRealTimers();
});

describe("destination readiness", () => {
  it("retains the destination until its snapshot is ready", async () => {
    const f = fixture();
    const waiting = waitForOperationThreadReady("child", {
      isActive: () => true,
      setMessage: vi.fn(),
    });
    expect(f.registry.release).not.toHaveBeenCalled();
    f.update({ status: "ready", snapshot: {} });
    await waiting;
    expect(f.registry.release).toHaveBeenCalledWith("child");
    expect(f.listeners.size).toBe(0);
  });
  it("ends a stalled load with an error and releases its stream", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const waiting = waitForOperationThreadReady("child", {
      isActive: () => true,
      setMessage: vi.fn(),
    });
    const rejected = expect(waiting).rejects.toThrow(
      "loading it took too long",
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(f.registry.release).toHaveBeenCalledWith("child");
  });
  it("releases immediately when waiting is canceled and never navigates", async () => {
    const f = fixture();
    const navigate = vi.fn();
    const completion = runBlockingOperation({
      message: "Creating…",
      run: async () => "child",
      onSuccess: async (id, context) => {
        await waitForOperationThreadReady(id, context);
        if (context.isActive()) navigate(id);
      },
    });
    await Promise.resolve();
    getBlockingOperation()!.cancel();
    await completion;
    await Promise.resolve();
    expect(f.registry.release).toHaveBeenCalledWith("child");
    expect(navigate).not.toHaveBeenCalled();
  });
});
