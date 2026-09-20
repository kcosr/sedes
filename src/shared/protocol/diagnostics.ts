import { z } from "zod";
import { MAXIMUM_SSE_EVENT_BYTES } from "./payload.js";

export const THREAD_LOAD_DIAGNOSTICS_QUERY_VALUE = "thread_load";
export const MAXIMUM_THREAD_REPLAY_DIAGNOSTIC_EVENTS = 4_096;

const diagnosticMillisecondsSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(86_400_000);

export const threadLoadServerDiagnosticSchema = z.strictObject({
  format: z.literal("sedes-thread-load-server-v1"),
  handshake: z.enum([
    "queued_replacement",
    "current_checkpoint",
    "overflow_checkpoint",
  ]),
  routeSetupMilliseconds: diagnosticMillisecondsSchema,
  runtimeAcquireMilliseconds: diagnosticMillisecondsSchema,
  requestToSnapshotWriteMilliseconds: diagnosticMillisecondsSchema,
  snapshotCaptureMilliseconds: diagnosticMillisecondsSchema,
  snapshotEncodeMilliseconds: diagnosticMillisecondsSchema,
  snapshotSummaryMilliseconds: diagnosticMillisecondsSchema,
  snapshotWriteMilliseconds: diagnosticMillisecondsSchema,
  snapshotFrameBytes: z
    .number()
    .int()
    .nonnegative()
    .max(MAXIMUM_SSE_EVENT_BYTES),
  turnCount: z.number().int().nonnegative().max(1_000),
  itemCount: z.number().int().nonnegative().max(10_000),
  largestTurnItemCount: z.number().int().nonnegative().max(1_000),
});

export type ThreadLoadServerDiagnostic = z.infer<
  typeof threadLoadServerDiagnosticSchema
>;

export const threadReplayServerDiagnosticSchema = z.strictObject({
  format: z.literal("sedes-thread-replay-server-v1"),
  cursorSource: z.enum(["last_event_id", "explicit_query"]),
  outcome: z.enum(["caught_up", "replayed", "snapshot_fallback"]),
  replayedEventCount: z
    .number()
    .int()
    .nonnegative()
    .max(MAXIMUM_THREAD_REPLAY_DIAGNOSTIC_EVENTS),
});

export type ThreadReplayServerDiagnostic = z.infer<
  typeof threadReplayServerDiagnosticSchema
>;

/** Content-free server work before SSE headers, for every handshake kind. */
export const threadHandshakeServerDiagnosticSchema = z.strictObject({
  format: z.literal("sedes-thread-handshake-server-v1"),
  requestId: z.uuid().nullable(),
  routeSetupMilliseconds: diagnosticMillisecondsSchema,
  runtimeAcquireMilliseconds: diagnosticMillisecondsSchema,
  requestToHeadersMilliseconds: diagnosticMillisecondsSchema,
});
export type ThreadHandshakeServerDiagnostic = z.infer<
  typeof threadHandshakeServerDiagnosticSchema
>;
