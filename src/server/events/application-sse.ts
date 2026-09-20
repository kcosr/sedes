import type { Request, Response } from "express";
import { type ApplicationEventEnvelope } from "../../shared/protocol/application.js";
import type { ApplicationEventHub } from "./application-event-hub.js";

export interface ApplicationEventStreamOptions {
  /**
   * Browser-supplied resume cursor for a newly-created EventSource. Native
   * clients cannot set Last-Event-ID themselves, so the normalized route
   * validates and forwards the equivalent query value explicitly. A later
   * automatic retry's Last-Event-ID header takes precedence over this anchor.
   */
  readonly explicitReplayCursor?: string;
  /** Explicit client recovery bypasses the current checkpoint. */
  readonly initialHandshake?: "authoritative_replacement";
  readonly onReplay?: () => void;
  readonly pendingEventLimit?: number;
  readonly pendingByteLimit?: number;
  readonly drainTimeoutMilliseconds?: number;
  readonly heartbeatMilliseconds?: number;
}

export const DEFAULT_APPLICATION_SSE_PENDING_EVENT_LIMIT = 2_048;
export const DEFAULT_APPLICATION_SSE_PENDING_BYTE_LIMIT = 16 * 1_024 * 1_024;
export const DEFAULT_APPLICATION_SSE_DRAIN_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_HEARTBEAT_MILLISECONDS = 20_000;
const LIVE_FRAME = "event: application-live\ndata: {}\n\n";

function positiveSafeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
}

/**
 * Serves the normalized application stream with a subscribe-before-capture
 * handshake. A client that falls outside bounded buffering is disconnected;
 * reconnect either replays the retained suffix or receives one authoritative
 * snapshot when its cursor is absent or no longer replayable.
 */
export async function serveApplicationEventStream(
  request: Request,
  response: Response,
  hub: ApplicationEventHub,
  checkpoint: (force: boolean) => Promise<{
    readonly envelope: ApplicationEventEnvelope;
  }>,
  options: ApplicationEventStreamOptions = {},
): Promise<void> {
  const pendingEventLimit =
    options.pendingEventLimit ?? DEFAULT_APPLICATION_SSE_PENDING_EVENT_LIMIT;
  const pendingByteLimit =
    options.pendingByteLimit ?? DEFAULT_APPLICATION_SSE_PENDING_BYTE_LIMIT;
  const drainTimeoutMilliseconds =
    options.drainTimeoutMilliseconds ??
    DEFAULT_APPLICATION_SSE_DRAIN_TIMEOUT_MILLISECONDS;
  const heartbeatMilliseconds =
    options.heartbeatMilliseconds ?? DEFAULT_HEARTBEAT_MILLISECONDS;
  positiveSafeInteger(pendingEventLimit, "application_sse_event_limit_invalid");
  positiveSafeInteger(pendingByteLimit, "application_sse_byte_limit_invalid");
  positiveSafeInteger(
    drainTimeoutMilliseconds,
    "application_sse_drain_timeout_invalid",
  );
  positiveSafeInteger(
    heartbeatMilliseconds,
    "application_sse_heartbeat_invalid",
  );

  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();

  let pending: ApplicationEventEnvelope[] = [];
  let pendingBytes = 0;
  let live = false;
  let closed = false;
  let drain:
    | { promise: Promise<boolean>; finish(ok: boolean): void }
    | undefined;
  let subscription: ReturnType<ApplicationEventHub["subscribe"]> | undefined;
  let removeHubClose: (() => void) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    drain?.finish(false);
    subscription?.close();
    removeHubClose?.();
    pending = [];
    pendingBytes = 0;
    request.removeListener("close", cleanup);
    response.removeListener("close", cleanup);
  };
  const close = (): void => {
    if (!closed) {
      cleanup();
      response.end();
    }
  };
  const enqueue = (envelope: ApplicationEventEnvelope): boolean => {
    const bytes = hub.encoded(envelope).bytes;
    // A bounded full replacement supersedes queued deltas, and may itself be
    // larger than the incremental pending budget.
    if (envelope.event.type === "snapshot") {
      pending = [envelope];
      pendingBytes = bytes;
      return true;
    }
    if (
      pending.length + 1 > pendingEventLimit ||
      pendingBytes + bytes > pendingByteLimit
    )
      return false;
    pending.push(envelope);
    pendingBytes += bytes;
    return true;
  };
  const armDrain = (): void => {
    if (closed || drain) return;
    let resolve!: (ok: boolean) => void;
    const promise = new Promise<boolean>((accept) => {
      resolve = accept;
    });
    const onDrain = (): void => {
      finish(true);
      if (live) flush();
    };
    const timer = setTimeout(close, drainTimeoutMilliseconds);
    timer.unref();
    const finish = (ok: boolean): void => {
      if (drain?.promise !== promise) return;
      drain = undefined;
      clearTimeout(timer);
      response.removeListener("drain", onDrain);
      resolve(ok);
    };
    drain = { promise, finish };
    response.once("drain", onDrain);
  };
  const write = (frame: string): void => {
    if (!response.write(frame)) armDrain();
  };
  function flush(): void {
    try {
      while (!closed && !drain && pending.length) {
        const envelope = pending.shift()!;
        const encoded = hub.encoded(envelope);
        pendingBytes -= encoded.bytes;
        write(encoded.frame);
      }
    } catch {
      close();
    }
  }
  const writeInitial = async (
    event: ApplicationEventEnvelope,
  ): Promise<boolean> => {
    if (drain && !(await drain.promise)) return false;
    if (closed) return false;
    write(hub.encoded(event).frame);
    return drain ? drain.promise : !closed;
  };

  const headerReplayCursor = request.header("Last-Event-ID");
  const replayCursor = headerReplayCursor ?? options.explicitReplayCursor;
  const force =
    headerReplayCursor === undefined &&
    options.initialHandshake === "authoritative_replacement";
  const canReplay = !force && hub.canReplay(replayCursor);
  const onEvent = (event: ApplicationEventEnvelope): void => {
    try {
      if (closed) return;
      if (!live || drain) {
        if (!enqueue(event)) close();
      } else write(hub.encoded(event).frame);
    } catch {
      close();
    }
  };
  // Subscription and replay selection happen synchronously, before capture or
  // socket waits. All crossing publications are queued until the baseline wins.
  subscription = hub.subscribe(onEvent, canReplay ? replayCursor : undefined);
  removeHubClose = hub.onClose(close);
  heartbeat = setInterval(() => {
    try {
      if (!closed && !drain) write(": heartbeat\n\n");
    } catch {
      close();
    }
  }, heartbeatMilliseconds);
  heartbeat.unref();
  request.once("close", cleanup);
  response.once("close", cleanup);

  try {
    let throughSequence = subscription.watermark;
    if (canReplay) {
      options.onReplay?.();
      for (const event of subscription.replay)
        if (!(await writeInitial(event))) return;
    } else {
      const baseline = (await checkpoint(force)).envelope;
      if (closed) return;
      const sequence = hub.sequenceOf(baseline.eventId);
      if (sequence === undefined || baseline.event.type !== "snapshot")
        throw new Error("application_sse_handshake_snapshot_invalid");
      if (!(await writeInitial(baseline))) return;
      throughSequence = sequence;
    }
    while (pending.length || drain) {
      if (drain && !(await drain.promise)) return;
      if (!pending.length) continue;
      const event = pending.shift()!;
      pendingBytes -= hub.encoded(event).bytes;
      const sequence = hub.sequenceOf(event.eventId);
      if (sequence === undefined)
        throw new Error("application_sse_event_generation_invalid");
      if (sequence <= throughSequence) continue;
      if (!(await writeInitial(event))) return;
      throughSequence = sequence;
    }
    if (closed) return;
    live = true;
    write(LIVE_FRAME);
  } catch {
    close();
  }
}
