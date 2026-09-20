import { isDeepStrictEqual } from "node:util";
import type { Request, Response } from "express";
import { ZodError } from "zod";
import {
  threadLoadErrorSchema,
  type ThreadLoadError,
} from "../../shared/protocol/api.js";
import {
  threadEventEnvelopeSchema,
  threadCheckpointSchema,
  type ActivityDetailMode,
  type ThreadEventEnvelope,
  type ThreadCheckpoint,
} from "../../shared/protocol/conversation.js";
import {
  projectThreadEventEnvelopeActivity,
  projectThreadSnapshotActivity,
} from "../conversations/thread-activity-projection.js";
import {
  threadLoadServerDiagnosticSchema,
  threadHandshakeServerDiagnosticSchema,
  threadReplayServerDiagnosticSchema,
  type ThreadLoadServerDiagnostic,
  type ThreadReplayServerDiagnostic,
} from "../../shared/protocol/diagnostics.js";
import type { ThreadEventHub } from "./thread-event-hub.js";
import { ApiError, projectApiError } from "../http/errors.js";
import { assertBoundedSseFrame } from "./sse-frame.js";

export interface ThreadSnapshotCapture {
  /**
   * Publishes a complete replacement through the owning serialization
   * boundary and returns that exact hub envelope.
   */
  publishAuthoritativeReplacement(): Promise<ThreadEventEnvelope>;
}

export interface ThreadEventStreamOptions {
  readonly requestId?: string;
  readonly threadId?: string;
  readonly activityDetail?: ActivityDetailMode;
  readonly explicitReplayCursor?: string;
  readonly pendingEventLimit?: number;
  readonly pendingByteLimit?: number;
  readonly drainTimeoutMilliseconds?: number;
  readonly heartbeatMilliseconds?: number;
  readonly loadDiagnostics?: {
    readonly requestStartedAt: number;
    readonly routeSetupMilliseconds: number;
    readonly runtimeAcquireMilliseconds: number;
  };
}

export const DEFAULT_THREAD_SSE_PENDING_EVENT_LIMIT = 2_048;
export const DEFAULT_THREAD_SSE_PENDING_BYTE_LIMIT = 16 * 1_024 * 1_024;
export const DEFAULT_THREAD_SSE_DRAIN_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_HEARTBEAT_MILLISECONDS = 20_000;
const LIVE_FRAME = "event: thread-live\ndata: {}\n\n";
export const THREAD_SSE_SMALL_REPLAY_BYTES = 64 * 1_024;

type SnapshotHandshake = ThreadLoadServerDiagnostic["handshake"];

function roundedMilliseconds(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(86_400_000, Math.max(0, value)) * 10) / 10;
}

function encodeEnvelope(
  rawEnvelope: unknown,
  activityDetail: ActivityDetailMode,
): string {
  const envelope = projectThreadEventEnvelopeActivity(
    threadEventEnvelopeSchema.parse(rawEnvelope),
    activityDetail,
  );
  return assertBoundedSseFrame(
    [
      `id: ${envelope.eventId}`,
      "event: thread",
      `data: ${JSON.stringify(envelope)}`,
      "",
      "",
    ].join("\n"),
  );
}

function encodeCheckpoint(
  checkpoint: ThreadCheckpoint,
  activityDetail: ActivityDetailMode,
): string {
  const projected = threadCheckpointSchema.parse({
    ...checkpoint,
    snapshot: projectThreadSnapshotActivity(
      checkpoint.snapshot,
      activityDetail,
    ),
  });
  return assertBoundedSseFrame(
    `id: ${projected.eventId}\nevent: thread-checkpoint\ndata: ${JSON.stringify(projected)}\n\n`,
  );
}

function encodeLoadDiagnostic(diagnostic: ThreadLoadServerDiagnostic): string {
  return assertBoundedSseFrame(
    [
      "event: thread-load-diagnostic",
      `data: ${JSON.stringify(threadLoadServerDiagnosticSchema.parse(diagnostic))}`,
      "",
      "",
    ].join("\n"),
  );
}

function encodeLoadError(error: ThreadLoadError): string {
  return assertBoundedSseFrame(
    [
      "event: thread-load-error",
      `data: ${JSON.stringify(threadLoadErrorSchema.parse(error))}`,
      "",
      "",
    ].join("\n"),
  );
}

function prepareThreadEventStreamResponse(response: Response): void {
  if (response.headersSent) return;
  response.status(200);
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.setHeader("X-Accel-Buffering", "no");
  response.flushHeaders();
}

/**
 * Completes one pre-live thread stream attempt with a bounded classified
 * error. Native EventSource cannot inspect a non-2xx JSON response, so every
 * server-declared bootstrap failure crosses this SSE control boundary.
 */
export function serveThreadLoadError(
  response: Response,
  error: unknown,
  requestId = "unavailable",
): void {
  if (response.destroyed || response.writableEnded) return;
  const projected = projectApiError(error);
  const frame = encodeLoadError({
    format: "sedes-thread-load-error-v1",
    requestId,
    error: projected.body.error,
  });
  try {
    prepareThreadEventStreamResponse(response);
    response.write(frame);
  } finally {
    response.end();
  }
}

function classifyThreadStreamLoadError(error: unknown): unknown {
  if (error instanceof ZodError) {
    return new ApiError(
      409,
      "backend_incompatible_protocol",
      "The backend returned incomplete or invalid thread history.",
      false,
    );
  }
  if (
    error instanceof Error &&
    error.message === "sse_event_frame_byte_limit_exceeded"
  ) {
    return new ApiError(
      413,
      "thread_payload_too_large",
      "This thread is too large to display safely.",
      false,
    );
  }
  return error;
}

function encodeReplayDiagnostic(
  diagnostic: ThreadReplayServerDiagnostic,
): string {
  return assertBoundedSseFrame(
    [
      "event: thread-replay-diagnostic",
      `data: ${JSON.stringify(threadReplayServerDiagnosticSchema.parse(diagnostic))}`,
      "",
      "",
    ].join("\n"),
  );
}

function writeOptionalFrame(response: Response, frame: string): void {
  const frameBytes = Buffer.byteLength(frame, "utf8");
  const bufferedBytes = response.writableLength;
  const highWaterMark = response.writableHighWaterMark;
  if (
    Number.isFinite(bufferedBytes) &&
    Number.isFinite(highWaterMark) &&
    bufferedBytes + frameBytes >= highWaterMark
  ) {
    return;
  }
  try {
    response.write(frame);
  } catch {
    // Optional observability cannot close a valid authoritative stream.
  }
}

function sequenceOf(
  hub: ThreadEventHub,
  envelope: Pick<ThreadEventEnvelope, "eventId">,
): number {
  const sequence = hub.sequenceOf(envelope.eventId);
  if (sequence === undefined) {
    throw new Error("thread_event_envelope_transport_invalid");
  }
  return sequence;
}

function assertPositiveLimit(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(code);
}

/**
 * Serves the end-state normalized thread stream.
 *
 * Attachments use a point-in-time checkpoint of already-published hub state,
 * followed only by newer events. A small retained suffix remains cheaper to
 * replay. Checkpoints neither publish replacements nor disturb other viewers.
 * Only an empty hub requires the source to establish an initial projection.
 */
export async function serveThreadEventStream(
  request: Request,
  response: Response,
  hub: ThreadEventHub,
  source: ThreadSnapshotCapture,
  options: ThreadEventStreamOptions = {},
): Promise<void> {
  const activityDetail = options.activityDetail ?? "full";
  const encode = (rawEnvelope: unknown): string =>
    encodeEnvelope(rawEnvelope, activityDetail);
  const checkpointFrames = new WeakMap<
    ThreadCheckpoint,
    { readonly frame: string; readonly encodeMilliseconds: number }
  >();
  const encodeCurrent = (checkpoint: ThreadCheckpoint) => {
    let encoded = checkpointFrames.get(checkpoint);
    if (encoded === undefined) {
      const startedAt = performance.now();
      const frame = encodeCheckpoint(checkpoint, activityDetail);
      encoded = { frame, encodeMilliseconds: performance.now() - startedAt };
      checkpointFrames.set(checkpoint, encoded);
    }
    return encoded;
  };
  const pendingEventLimit =
    options.pendingEventLimit ?? DEFAULT_THREAD_SSE_PENDING_EVENT_LIMIT;
  const pendingByteLimit =
    options.pendingByteLimit ?? DEFAULT_THREAD_SSE_PENDING_BYTE_LIMIT;
  const drainTimeoutMilliseconds =
    options.drainTimeoutMilliseconds ??
    DEFAULT_THREAD_SSE_DRAIN_TIMEOUT_MILLISECONDS;
  const heartbeatMilliseconds =
    options.heartbeatMilliseconds ?? DEFAULT_HEARTBEAT_MILLISECONDS;
  assertPositiveLimit(pendingEventLimit, "thread_sse_event_limit_invalid");
  assertPositiveLimit(pendingByteLimit, "thread_sse_byte_limit_invalid");
  assertPositiveLimit(
    drainTimeoutMilliseconds,
    "thread_sse_drain_timeout_invalid",
  );
  assertPositiveLimit(
    heartbeatMilliseconds,
    "thread_sse_heartbeat_interval_invalid",
  );

  prepareThreadEventStreamResponse(response);
  if (options.loadDiagnostics) {
    try {
      const requestId =
        threadHandshakeServerDiagnosticSchema.shape.requestId.safeParse(
          options.requestId ?? null,
        );
      const diagnostic = threadHandshakeServerDiagnosticSchema.parse({
        format: "sedes-thread-handshake-server-v1",
        requestId: requestId.success ? requestId.data : null,
        routeSetupMilliseconds: roundedMilliseconds(
          options.loadDiagnostics.routeSetupMilliseconds,
        ),
        runtimeAcquireMilliseconds: roundedMilliseconds(
          options.loadDiagnostics.runtimeAcquireMilliseconds,
        ),
        requestToHeadersMilliseconds: roundedMilliseconds(
          performance.now() - options.loadDiagnostics.requestStartedAt,
        ),
      });
      writeOptionalFrame(
        response,
        assertBoundedSseFrame(
          `event: thread-handshake-diagnostic\ndata: ${JSON.stringify(diagnostic)}\n\n`,
        ),
      );
      if (process.env.SEDES_DEBUG_DELIVERY) {
        console.error(
          `[delivery-thread-handshake] ${JSON.stringify(diagnostic)}`,
        );
      }
    } catch {
      // Optional diagnostics must not change stream delivery or recovery.
    }
  }

  // TEMPORARY DIAGNOSTIC (SEDES_DEBUG_DELIVERY): stream lifecycle.
  const streamStartedAt = Date.now();
  const debugStream = process.env.SEDES_DEBUG_DELIVERY
    ? (detail: string) =>
        console.error(
          `[delivery-stream] thread=${options.threadId ?? "unknown"} ${detail}`,
        )
    : undefined;

  let pending: ThreadEventEnvelope[] = [];
  let pendingBytes = 0;
  let overflowed = false;
  let live = false;
  let lastSnapshotFrameBytes = 0;
  let lastSnapshotHandshake: SnapshotHandshake | undefined;
  let closed = false;
  let waitingForDrain = false;
  let drainTimer: NodeJS.Timeout | undefined;
  let finishInitialDrain: ((drained: boolean) => void) | undefined;
  let flushIndex = 0;
  let recoveringOverflow = false;
  let overflowCheckpointAttempted = false;
  let recoverPendingOverflow: (() => Promise<boolean>) | undefined;
  const recoverySnapshots = new Map<string, ThreadEventEnvelope>();
  let subscription: ReturnType<ThreadEventHub["subscribe"]> | undefined;
  let heartbeat!: NodeJS.Timeout;

  const clearDrainTimer = (): void => {
    if (!drainTimer) return;
    clearTimeout(drainTimer);
    drainTimer = undefined;
  };

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearDrainTimer();
    finishInitialDrain?.(false);
    response.removeListener("drain", flushAfterDrain);
    subscription?.close();
  };

  const logClose = (reason: string): void => {
    debugStream?.(
      `close reason=${reason} live=${live ? 1 : 0} pendingEvents=${pending.length} pendingBytes=${pendingBytes}`,
    );
  };

  const close = (reason: string): void => {
    if (closed) return;
    logClose(reason);
    cleanup();
    response.end();
  };

  const armDrain = (): void => {
    if (closed || waitingForDrain) return;
    debugStream?.(
      `drain_wait pendingEvents=${pending.length} pendingBytes=${pendingBytes}`,
    );
    waitingForDrain = true;
    response.once("drain", flushAfterDrain);
    drainTimer = setTimeout(
      () => close("drain_timeout"),
      drainTimeoutMilliseconds,
    );
    drainTimer.unref();
  };

  const write = (rawEnvelope: unknown): boolean => {
    if (closed) return false;
    return response.write(encode(rawEnvelope));
  };

  const resetPendingAtReplacement = (envelope: ThreadEventEnvelope): void => {
    const encoded = encode(envelope);
    pending = [envelope];
    pendingBytes = Buffer.byteLength(encoded, "utf8");
    // A replacement supersedes the entire pending array. The prior flush
    // index belongs to that discarded array and must never skip the new
    // authoritative anchor after backpressure drains.
    flushIndex = 0;
    // A complete replacement is independently bounded by the normalized
    // snapshot and full SSE-frame limits. It may exceed the much smaller
    // incremental handshake buffer, but only one replacement is retained.
    overflowed = pending.length > pendingEventLimit;
  };

  const queue = (rawEnvelope: unknown): void => {
    const envelope = threadEventEnvelopeSchema.parse(rawEnvelope);
    if (envelope.event.type === "snapshot") {
      // A replacement is authoritative over everything before it, including
      // any events already discarded by an overflow.
      resetPendingAtReplacement(envelope);
      return;
    }
    if (overflowed) return;
    const bytes = Buffer.byteLength(encode(envelope), "utf8");
    if (
      pending.length + 1 > pendingEventLimit ||
      pendingBytes + bytes > pendingByteLimit
    ) {
      overflowed = true;
      debugStream?.(
        `overflow pendingEvents=${pending.length} pendingBytes=${pendingBytes}`,
      );
      return;
    }
    pending.push(envelope);
    pendingBytes += bytes;
  };

  function flushAfterDrain(): void {
    if (closed) return;
    waitingForDrain = false;
    clearDrainTimer();
    if (overflowed) {
      live = false;
      void recoverPendingOverflow?.().catch(() =>
        close("overflow_recovery_error"),
      );
      return;
    }
    while (flushIndex < pending.length) {
      const envelope = pending[flushIndex]!;
      flushIndex += 1;
      if (!write(envelope)) {
        armDrain();
        return;
      }
    }
    pending = [];
    pendingBytes = 0;
    flushIndex = 0;
  }

  const waitForInitialDrain = (): Promise<boolean> =>
    new Promise((resolve) => {
      if (closed) {
        resolve(false);
        return;
      }
      let timer: NodeJS.Timeout | undefined;
      const onDrain = (): void => finish(true);
      const finish = (drained: boolean): void => {
        if (finishInitialDrain !== finish) return;
        finishInitialDrain = undefined;
        response.removeListener("drain", onDrain);
        if (timer) clearTimeout(timer);
        resolve(drained);
      };
      finishInitialDrain = finish;
      response.once("drain", onDrain);
      timer = setTimeout(() => {
        finish(false);
        close("initial_drain_timeout");
      }, drainTimeoutMilliseconds);
      timer.unref();
    });

  const writeInitial = async (
    envelope: ThreadEventEnvelope | ThreadCheckpoint,
    handshake: SnapshotHandshake = "queued_replacement",
    snapshotCaptureMilliseconds = 0,
  ): Promise<boolean> => {
    const encodeStartedAt = performance.now();
    const encodedCheckpoint =
      "event" in envelope ? undefined : encodeCurrent(envelope);
    const frame = encodedCheckpoint?.frame ?? encode(envelope);
    const snapshot =
      "event" in envelope
        ? envelope.event.type === "snapshot"
          ? envelope.event.snapshot
          : undefined
        : envelope.snapshot;
    if (snapshot) {
      lastSnapshotFrameBytes = Buffer.byteLength(frame, "utf8");
      lastSnapshotHandshake = handshake;
    }
    // Adaptive selection may have encoded this checkpoint before writeInitial.
    // Attribute the actual encoding work, not just the later cache lookup.
    const snapshotEncodeMilliseconds =
      encodedCheckpoint?.encodeMilliseconds ??
      performance.now() - encodeStartedAt;
    const writeStartedAt = performance.now();
    const snapshotWritten =
      response.write(frame) || (await waitForInitialDrain());
    const snapshotWriteMilliseconds = performance.now() - writeStartedAt;
    if (!snapshotWritten || !snapshot) {
      return snapshotWritten;
    }
    const loadDiagnostics = options.loadDiagnostics;
    if (!loadDiagnostics) return true;
    let diagnosticFrame: string;
    try {
      const summaryStartedAt = performance.now();
      const itemCount = Object.keys(snapshot.itemsById).length;
      const largestTurnItemCount = snapshot.orderedTurnIds.reduce(
        (largest, turnId) =>
          Math.max(
            largest,
            snapshot.turnsById[turnId]?.orderedItemIds.length ?? 0,
          ),
        0,
      );
      const snapshotSummaryMilliseconds = performance.now() - summaryStartedAt;
      const diagnostic = threadLoadServerDiagnosticSchema.parse({
        format: "sedes-thread-load-server-v1",
        handshake,
        routeSetupMilliseconds: roundedMilliseconds(
          loadDiagnostics.routeSetupMilliseconds,
        ),
        runtimeAcquireMilliseconds: roundedMilliseconds(
          loadDiagnostics.runtimeAcquireMilliseconds,
        ),
        requestToSnapshotWriteMilliseconds: roundedMilliseconds(
          performance.now() - loadDiagnostics.requestStartedAt,
        ),
        snapshotCaptureMilliseconds: roundedMilliseconds(
          snapshotCaptureMilliseconds,
        ),
        snapshotEncodeMilliseconds: roundedMilliseconds(
          snapshotEncodeMilliseconds,
        ),
        snapshotSummaryMilliseconds: roundedMilliseconds(
          snapshotSummaryMilliseconds,
        ),
        snapshotWriteMilliseconds: roundedMilliseconds(
          snapshotWriteMilliseconds,
        ),
        snapshotFrameBytes: Buffer.byteLength(frame, "utf8"),
        turnCount: snapshot.orderedTurnIds.length,
        itemCount,
        largestTurnItemCount,
      });
      diagnosticFrame = encodeLoadDiagnostic(diagnostic);
    } catch {
      // Optional observability must never invalidate an otherwise valid
      // authoritative stream.
      return true;
    }
    writeOptionalFrame(response, diagnosticFrame);
    return true;
  };

  const headerReplayCursor = request.header("Last-Event-ID");
  const replayCursor =
    headerReplayCursor !== undefined
      ? headerReplayCursor
      : options.explicitReplayCursor;
  const replayCursorSource =
    headerReplayCursor !== undefined
      ? ("last_event_id" as const)
      : options.explicitReplayCursor !== undefined
        ? ("explicit_query" as const)
        : undefined;
  const canReplay = replayCursor !== undefined && hub.canReplay(replayCursor);
  let replayDiagnosticOutcome:
    ThreadReplayServerDiagnostic["outcome"] | undefined = replayCursorSource
    ? canReplay
      ? "caught_up"
      : "snapshot_fallback"
    : undefined;
  let replayedEventCount = 0;
  let replayDiagnosticWritten = false;
  const writeReplayDiagnostic = (): void => {
    if (
      replayDiagnosticWritten ||
      !options.loadDiagnostics ||
      !replayCursorSource ||
      !replayDiagnosticOutcome
    ) {
      return;
    }
    replayDiagnosticWritten = true;
    try {
      writeOptionalFrame(
        response,
        encodeReplayDiagnostic({
          format: "sedes-thread-replay-server-v1",
          cursorSource: replayCursorSource,
          outcome: replayDiagnosticOutcome,
          replayedEventCount,
        }),
      );
    } catch {
      // Optional observability cannot close a valid authoritative stream.
    }
  };
  const receive = (rawEnvelope: unknown): void => {
    if (closed) return;
    try {
      const envelope = threadEventEnvelopeSchema.parse(rawEnvelope);
      if (recoveringOverflow && envelope.event.type === "snapshot") {
        recoverySnapshots.set(envelope.eventId, envelope);
      }
      if (!live || waitingForDrain) {
        queue(envelope);
        return;
      }
      if (!write(envelope)) {
        pending = [];
        pendingBytes = 0;
        flushIndex = 0;
        armDrain();
      }
    } catch (error) {
      close(
        error instanceof Error &&
          error.message === "sse_event_frame_byte_limit_exceeded"
          ? "frame_byte_limit_exceeded"
          : "stream_error",
      );
    }
  };
  let initialCheckpoint: ThreadCheckpoint | undefined;
  let initialCheckpointCaptureMilliseconds = 0;
  const captureInitialCheckpoint = (): ThreadCheckpoint | undefined => {
    const startedAt = performance.now();
    const checkpoint = hub.currentCheckpoint();
    initialCheckpointCaptureMilliseconds += performance.now() - startedAt;
    return checkpoint;
  };
  let useReplay = canReplay;
  try {
    let candidate: ThreadCheckpoint | undefined;
    const replayBytes = hub.replayBytesAfter(replayCursor);
    if (
      canReplay &&
      replayBytes !== undefined &&
      replayBytes > THREAD_SSE_SMALL_REPLAY_BYTES
    ) {
      candidate = captureInitialCheckpoint();
      if (candidate) {
        const checkpointBytes = Buffer.byteLength(
          encodeCurrent(candidate).frame,
          "utf8",
        );
        // Raw tool/reasoning updates can shrink substantially in summary mode.
        // Stop costing as soon as the actual projected suffix exceeds a checkpoint.
        useReplay =
          hub.replayCostExceeds(replayCursor!, checkpointBytes, (event) =>
            Buffer.byteLength(encode(event), "utf8"),
          ) !== true;
      }
    }
    if (useReplay) {
      subscription = hub.subscribe(receive, replayCursor);
      replayedEventCount = subscription.replay.length;
      replayDiagnosticOutcome =
        replayedEventCount === 0 ? "caught_up" : "replayed";
    } else {
      // Measure capture separately from subscriber callbacks. No asynchronous
      // work intervenes, so the atomic subscription reuses this cached capture.
      if (!candidate) captureInitialCheckpoint();
      const initial = hub.subscribeFromCurrentSnapshot(receive);
      subscription = initial;
      initialCheckpoint = initial.checkpoint;
      if (replayCursorSource) replayDiagnosticOutcome = "snapshot_fallback";
    }
  } catch (error) {
    cleanup();
    serveThreadLoadError(
      response,
      classifyThreadStreamLoadError(error),
      options.requestId,
    );
    return;
  }
  if (closed) {
    subscription.close();
    return;
  }

  heartbeat = setInterval(() => {
    if (
      live &&
      !closed &&
      !waitingForDrain &&
      !response.write(": heartbeat\n\n")
    ) {
      armDrain();
    }
  }, heartbeatMilliseconds);
  heartbeat.unref();
  request.once("close", () => {
    if (!closed) logClose("client_closed");
    cleanup();
  });

  try {
    const recoverFromOverflow = async (isOverflow = true): Promise<boolean> => {
      if (isOverflow && overflowCheckpointAttempted) {
        close("overflow");
        return false;
      }
      if (isOverflow) overflowCheckpointAttempted = true;
      if (replayCursorSource) {
        replayDiagnosticOutcome = "snapshot_fallback";
        replayedEventCount = 0;
      }
      pending = [];
      pendingBytes = 0;
      flushIndex = 0;
      overflowed = false;
      const captureStartedAt = performance.now();
      if (!hub.snapshot) {
        recoveringOverflow = true;
        recoverySnapshots.clear();
        const replacement = threadEventEnvelopeSchema.parse(
          await source.publishAuthoritativeReplacement(),
        );
        const observedReplacement = recoverySnapshots.get(replacement.eventId);
        if (
          replacement.event.type !== "snapshot" ||
          !observedReplacement ||
          !isDeepStrictEqual(observedReplacement, replacement)
        ) {
          throw new Error("thread_sse_replacement_not_published");
        }
        recoveringOverflow = false;
      }
      const baseline = hub.currentCheckpoint();
      if (!baseline) throw new Error("thread_sse_checkpoint_unavailable");
      const snapshotCaptureMilliseconds = performance.now() - captureStartedAt;
      const baselineSequence = sequenceOf(hub, baseline);
      // Every pending event through this exact checkpoint is represented by it.
      pending = [];
      pendingBytes = 0;
      flushIndex = 0;
      overflowed = false;
      if (
        closed ||
        !(await writeInitial(
          baseline,
          isOverflow ? "overflow_checkpoint" : "current_checkpoint",
          snapshotCaptureMilliseconds,
        ))
      ) {
        return false;
      }
      pending = pending.filter(
        (envelope) => sequenceOf(hub, envelope) > baselineSequence,
      );
      pendingBytes = pending.reduce(
        (total, envelope) =>
          total + Buffer.byteLength(encode(envelope), "utf8"),
        0,
      );
      return drainPending(baselineSequence);
    };

    const drainPending = async (
      minimumExclusive?: number,
    ): Promise<boolean> => {
      if (overflowed) return recoverFromOverflow();
      while (pending.length > 0) {
        const envelope = pending.shift()!;
        pendingBytes -= Buffer.byteLength(encode(envelope), "utf8");
        if (
          minimumExclusive !== undefined &&
          sequenceOf(hub, envelope) <= minimumExclusive
        ) {
          continue;
        }
        if (closed || !(await writeInitial(envelope))) return false;
        if (overflowed) return recoverFromOverflow();
      }
      if (overflowed) return recoverFromOverflow();
      flushIndex = 0;
      live = true;
      const openHandshake =
        lastSnapshotHandshake ??
        (replayedEventCount > 0 ? "replayed" : "caught_up");
      debugStream?.(
        `open handshake=${openHandshake} ms=${Date.now() - streamStartedAt} snapshotBytes=${lastSnapshotFrameBytes}`,
      );
      writeReplayDiagnostic();
      if (!response.write(LIVE_FRAME)) armDrain();
      return true;
    };
    recoverPendingOverflow = () => recoverFromOverflow();

    if (useReplay) {
      for (const envelope of subscription.replay) {
        if (closed || !(await writeInitial(envelope))) return;
      }
      if (!(await drainPending(subscription.watermark))) return;
      return;
    } else if (initialCheckpoint) {
      if (
        closed ||
        !(await writeInitial(
          initialCheckpoint,
          "current_checkpoint",
          initialCheckpointCaptureMilliseconds,
        ))
      ) {
        return;
      }
      if (!(await drainPending(subscription.watermark))) return;
      return;
    } else {
      // A new, empty hub still needs one real source-owned initialization.
      await recoverFromOverflow(false);
      return;
    }
  } catch (error) {
    if (!live && !closed) {
      try {
        serveThreadLoadError(
          response,
          classifyThreadStreamLoadError(error),
          options.requestId,
        );
      } finally {
        if (!closed) logClose("load_error");
        cleanup();
      }
      return;
    }
    close("unexpected_error");
  }
}
