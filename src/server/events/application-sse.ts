import type { Request, Response } from "express";
import { type ApplicationEventEnvelope } from "../../shared/protocol/application.js";
import { recordVoiceDiagnostic, type VoiceDiagnosticReason } from "../diagnostics/voice-diagnostics.js";
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
  /** Live-only named frames. Never enter the inventory projection or replay cursor. */
  readonly subscribeTransient?: (listener: (frame: string) => void) => () => void;
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
  let transient: string[] = [];
  let transientBytes = 0;
  let removeTransient: (() => void) | undefined;
  let live = false;
  let closed = false;
  let drain:
    | { promise: Promise<boolean>; finish(ok: boolean): void }
    | undefined;
  let subscription: ReturnType<ApplicationEventHub["subscribe"]> | undefined;
  let removeHubClose: (() => void) | undefined;
  let heartbeat: NodeJS.Timeout | undefined;
  const startedAt = performance.now();

  const cleanup = (reason: VoiceDiagnosticReason): void => {
    if (closed) return;
    closed = true;
    recordVoiceDiagnostic("application_stream_closed", {
      reason, live, durationMs: performance.now() - startedAt,
      pendingEventCount: pending.length, pendingBytes,
      transientEventCount: transient.length, transientBytes,
    });
    clearInterval(heartbeat);
    drain?.finish(false);
    subscription?.close();
    removeHubClose?.();
    removeTransient?.();
    pending = [];
    pendingBytes = 0;
    transient = [];
    transientBytes = 0;
    request.removeListener("close", onClientClose);
    response.removeListener("close", onClientClose);
  };
  const onClientClose = (): void => cleanup("client_closed");
  const close = (reason: VoiceDiagnosticReason): void => {
    if (!closed) {
      cleanup(reason);
      response.end();
    }
  };
  // A bounded full replacement supersedes queued deltas and may itself be
  // larger than the incremental pending budget, so only deltas queued behind
  // it count against `pendingByteLimit`.
  const pendingIncrementalBytes = (envelope: ApplicationEventEnvelope): number =>
    envelope.event.type === "snapshot" ? 0 : hub.encoded(envelope).bytes;
  const enqueue = (envelope: ApplicationEventEnvelope): boolean => {
    const bytes = hub.encoded(envelope).bytes;
    if (envelope.event.type === "snapshot") {
      pending = [envelope];
      pendingBytes = 0;
      return true;
    }
    if (
      pending.length + transient.length + 1 > pendingEventLimit ||
      pendingBytes + transientBytes + bytes > pendingByteLimit
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
    const timer = setTimeout(() => close("drain_timeout"), drainTimeoutMilliseconds);
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
      while (!closed && !drain && (pending.length || transient.length)) {
        if (transient.length) {
          const frame = transient.shift()!;
          transientBytes -= Buffer.byteLength(frame, "utf8");
          write(frame);
          continue;
        }
        const envelope = pending.shift()!;
        pendingBytes -= pendingIncrementalBytes(envelope);
        write(hub.encoded(envelope).frame);
      }
    } catch {
      close("stream_error");
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
        if (!enqueue(event)) close("overflow");
      } else write(hub.encoded(event).frame);
    } catch {
      close("stream_error");
    }
  };
  // Subscription and replay selection happen synchronously, before capture or
  // socket waits. All crossing publications are queued until the baseline wins.
  subscription = hub.subscribe(onEvent, canReplay ? replayCursor : undefined);
  removeHubClose = hub.onClose(() => close("hub_closed"));
  heartbeat = setInterval(() => {
    try {
      if (!closed && !drain) write(": heartbeat\n\n");
    } catch {
      close("stream_error");
    }
  }, heartbeatMilliseconds);
  heartbeat.unref();
  request.once("close", onClientClose);
  response.once("close", onClientClose);
  try {
    removeTransient = options.subscribeTransient?.((frame) => {
      try {
        if (closed) return;
        if (live && !drain) { write(frame); return; }
        const bytes = Buffer.byteLength(frame, "utf8");
        if (pending.length + transient.length + 1 > pendingEventLimit ||
          pendingBytes + transientBytes + bytes > pendingByteLimit) { close("transient_overflow"); return; }
        transient.push(frame);
        transientBytes += bytes;
      } catch { close("stream_error"); }
    });
  } catch {
    // The transient lane is optional: a failed subscription leaves inventory
    // live without it. Native treats a stream without policy as unknown.
  }
  if (closed) { removeTransient?.(); return; }

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
    while (pending.length || transient.length || drain) {
      if (drain && !(await drain.promise)) return;
      if (transient.length) {
        const frame = transient.shift()!;
        transientBytes -= Buffer.byteLength(frame, "utf8");
        write(frame);
        continue;
      }
      if (!pending.length) continue;
      const event = pending.shift()!;
      pendingBytes -= pendingIncrementalBytes(event);
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
    close("handshake_error");
  }
}
