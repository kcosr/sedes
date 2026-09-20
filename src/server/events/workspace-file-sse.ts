import type { Request, Response } from "express";
import type { WorkspaceFileWatchSubscription } from "../workspace-files/contracts.js";

export interface WorkspaceFileEventStreamOptions {
  readonly drainTimeoutMilliseconds?: number;
  readonly heartbeatMilliseconds?: number;
}

export const DEFAULT_WORKSPACE_FILE_SSE_DRAIN_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_HEARTBEAT_MILLISECONDS = 20_000;
const INVALIDATION_FRAME = "event: workspace-files-invalidated\ndata: {}\n\n";
const LIVE_FRAME = "event: workspace-files-live\ndata: {}\n\n";

/**
 * An invalidation stream is level-triggered rather than replayed: every new
 * connection begins with one invalidation, which repairs any notification
 * lost before or during reconnect. While backpressured, changes coalesce to
 * at most one path-free frame.
 */
export async function serveWorkspaceFileEventStream(
  request: Request,
  response: Response,
  subscribe: (listener: () => void) => Promise<WorkspaceFileWatchSubscription>,
  options: WorkspaceFileEventStreamOptions = {},
): Promise<void> {
  const drainTimeoutMilliseconds = positiveInteger(
    options.drainTimeoutMilliseconds ??
      DEFAULT_WORKSPACE_FILE_SSE_DRAIN_TIMEOUT_MILLISECONDS,
    "workspace_file_sse_drain_timeout_invalid",
  );
  const heartbeatMilliseconds = positiveInteger(
    options.heartbeatMilliseconds ?? DEFAULT_HEARTBEAT_MILLISECONDS,
    "workspace_file_sse_heartbeat_invalid",
  );

  let closed = false;
  let waitingForDrain = false;
  let drainTimer: NodeJS.Timeout | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const frames = [INVALIDATION_FRAME, LIVE_FRAME];
  let subscription: WorkspaceFileWatchSubscription | undefined;

  const clearDrain = (): void => {
    if (drainTimer) clearTimeout(drainTimer);
    drainTimer = undefined;
  };
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearDrain();
    if (heartbeat) clearInterval(heartbeat);
    request.removeListener("close", cleanup);
    response.removeListener("close", cleanup);
    response.removeListener("drain", flush);
    subscription?.close();
  };
  const close = (): void => {
    if (closed) return;
    cleanup();
    response.end();
  };
  const armDrain = (): void => {
    if (closed || waitingForDrain) return;
    waitingForDrain = true;
    response.once("drain", flush);
    drainTimer = setTimeout(close, drainTimeoutMilliseconds);
    drainTimer.unref();
  };
  function flush(): void {
    if (closed) return;
    waitingForDrain = false;
    clearDrain();
    while (frames.length > 0) {
      const frame = frames.shift()!;
      if (!response.write(frame)) {
        armDrain();
        return;
      }
    }
  }
  const invalidate = (): void => {
    if (closed) return;
    // The initial frame or another queued invalidation already covers this
    // state transition. Callback arguments are intentionally nonexistent.
    if (frames.includes(INVALIDATION_FRAME)) return;
    frames.push(INVALIDATION_FRAME);
    if (!waitingForDrain) flush();
  };

  request.once("close", cleanup);
  response.once("close", cleanup);
  try {
    subscription = await subscribe(invalidate);
  } catch (error) {
    cleanup();
    throw error;
  }
  if (closed) {
    subscription.close();
    return;
  }
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
  heartbeat = setInterval(() => {
    if (!closed && !waitingForDrain && frames.length === 0) {
      if (!response.write(": heartbeat\n\n")) armDrain();
    }
  }, heartbeatMilliseconds);
  heartbeat.unref();
  flush();
}

function positiveInteger(value: number, code: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
  return value;
}
