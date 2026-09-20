import { describe, expect, it, vi } from "vitest";
import { acquireThreadRuntimeWithDiagnostics } from "../../src/server/normalized-app.js";

describe("thread runtime acquisition deadline", () => {
  it("allows cold acquisition beyond a 60-second provider read without releasing it", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn();
      const acquisition = acquireThreadRuntimeWithDiagnostics(
        () =>
          new Promise<{ release(): void }>((resolve) => {
            setTimeout(() => resolve({ release }), 65_000);
          }),
        {
          requestId: "request-cold",
          threadId: "thread-cold",
          routeSetupMilliseconds: 1,
          runtimeAcquireStartedAt: performance.now(),
        },
      );
      const completed = expect(acquisition).resolves.toEqual({ release });
      await vi.advanceTimersByTimeAsync(65_000);
      await completed;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(release).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the default cold acquisition at 90 seconds and releases late completion", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn();
      let resolve!: (runtime: { release(): void }) => void;
      const acquisition = acquireThreadRuntimeWithDiagnostics(
        () =>
          new Promise<{ release(): void }>((settle) => {
            resolve = settle;
          }),
        {
          requestId: "request-cold-timeout",
          threadId: "thread-cold",
          routeSetupMilliseconds: 1,
          runtimeAcquireStartedAt: performance.now(),
        },
      );
      let settled = false;
      void acquisition.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      const rejected = expect(acquisition).rejects.toMatchObject({
        code: "runtime_unavailable",
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(89_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      resolve({ release });
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns a retryable timeout and releases a late acquisition", async () => {
    vi.useFakeTimers();
    try {
      const release = vi.fn();
      let resolve!: (runtime: { release(): void }) => void;
      const acquisition = acquireThreadRuntimeWithDiagnostics(
        () =>
          new Promise<{ release(): void }>((settle) => {
            resolve = settle;
          }),
        {
          requestId: "request-timeout",
          threadId: "thread-timeout",
          routeSetupMilliseconds: 1,
          runtimeAcquireStartedAt: performance.now(),
          timeoutMilliseconds: 25,
        },
      );
      const rejected = expect(acquisition).rejects.toMatchObject({
        code: "runtime_unavailable",
        message: "The backend timed out while loading this thread.",
        retryable: true,
      });

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
      resolve({ release });
      await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases an acquisition that completes after its stream disconnects", async () => {
    const controller = new AbortController();
    const release = vi.fn();
    let resolve!: (runtime: { release(): void }) => void;
    const acquisition = acquireThreadRuntimeWithDiagnostics(
      () =>
        new Promise<{ release(): void }>((settle) => {
          resolve = settle;
        }),
      {
        requestId: "request-disconnected",
        threadId: "thread-disconnected",
        routeSetupMilliseconds: 1,
        runtimeAcquireStartedAt: performance.now(),
        signal: controller.signal,
      },
    );

    controller.abort(new Error("stream_closed"));
    await expect(acquisition).rejects.toThrow("stream_closed");
    resolve({ release });
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
  });
});
