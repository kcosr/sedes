import { EventEmitter } from "node:events";
import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKSPACE_FILE_SSE_DRAIN_TIMEOUT_MILLISECONDS,
  serveWorkspaceFileEventStream,
} from "../../src/server/events/workspace-file-sse.js";
import type { WorkspaceFileWatchSubscription } from "../../src/server/workspace-files/contracts.js";

const neverFails = () => new Promise<void>(() => undefined);

class FakeRequest extends EventEmitter {}

class FakeResponse extends EventEmitter {
  readonly writes: string[] = [];
  readonly end = vi.fn();
  readonly setHeader = vi.fn();
  readonly flushHeaders = vi.fn();
  readonly status = vi.fn(() => this);
  writeResult: (value: string) => boolean = () => true;
  write(value: string): boolean {
    this.writes.push(value);
    return this.writeResult(value);
  }
}

describe("serveWorkspaceFileEventStream", () => {
  it("allows a slow client 30 seconds to drain", () => {
    expect(DEFAULT_WORKSPACE_FILE_SSE_DRAIN_TIMEOUT_MILLISECONDS).toBe(30_000);
  });

  it("closes a subscription that resolves after the request disconnects", async () => {
    const request = new FakeRequest();
    const response = new FakeResponse();
    const close = vi.fn();
    let finish: ((value: WorkspaceFileWatchSubscription) => void) | undefined;
    const stream = serveWorkspaceFileEventStream(
      request as unknown as Request,
      response as unknown as Response,
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );

    request.emit("close");
    finish?.({ failed: neverFails(), close });
    await stream;

    expect(close).toHaveBeenCalledOnce();
    expect(response.writes).toEqual([]);
  });

  it("cleans up when watcher subscription fails", async () => {
    const request = new FakeRequest();
    const response = new FakeResponse();
    await expect(
      serveWorkspaceFileEventStream(
        request as unknown as Request,
        response as unknown as Response,
        async () => {
          throw new Error("watch failed");
        },
      ),
    ).rejects.toThrow("watch failed");

    expect(request.listenerCount("close")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("starts with a path-free invalidation and closes its watcher", async () => {
    const request = new FakeRequest();
    const response = new FakeResponse();
    const close = vi.fn();
    let invalidate: () => void = () => undefined;
    await serveWorkspaceFileEventStream(
      request as unknown as Request,
      response as unknown as Response,
      async (listener) => {
        invalidate = listener;
        return { failed: neverFails(), close };
      },
    );

    expect(response.writes.slice(0, 2)).toEqual([
      "event: workspace-files-invalidated\ndata: {}\n\n",
      "event: workspace-files-live\ndata: {}\n\n",
    ]);
    expect(response.writes.join("")).not.toContain("path");
    invalidate();
    expect(response.writes.at(-1)).toBe(
      "event: workspace-files-invalidated\ndata: {}\n\n",
    );
    request.emit("close");
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps at most one invalidation pending while backpressured", async () => {
    const request = new FakeRequest();
    const response = new FakeResponse();
    let invalidate: () => void = () => undefined;
    await serveWorkspaceFileEventStream(
      request as unknown as Request,
      response as unknown as Response,
      async (listener) => {
        invalidate = listener;
        return { failed: neverFails(), close: () => undefined };
      },
    );
    response.writeResult = () => false;
    invalidate();
    for (let index = 0; index < 100; index += 1) invalidate();
    expect(response.listenerCount("drain")).toBe(1);

    response.writeResult = () => true;
    response.emit("drain");
    const invalidations = response.writes.filter((frame) =>
      frame.startsWith("event: workspace-files-invalidated"),
    );
    // Initial, one accepted by the response buffer, one pending in process.
    expect(invalidations).toHaveLength(3);
    request.emit("close");
  });

  it("emits heartbeats only after the initial handshake", async () => {
    vi.useFakeTimers();
    try {
      const request = new FakeRequest();
      const response = new FakeResponse();
      await serveWorkspaceFileEventStream(
        request as unknown as Request,
        response as unknown as Response,
        async () => ({ failed: neverFails(), close: () => undefined }),
        { heartbeatMilliseconds: 10 },
      );
      await vi.advanceTimersByTimeAsync(10);
      expect(response.writes.at(-1)).toBe(": heartbeat\n\n");
      request.emit("close");
    } finally {
      vi.useRealTimers();
    }
  });
});
