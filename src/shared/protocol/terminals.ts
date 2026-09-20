import { z } from "zod";
import {
  environmentIdSchema,
  mutationIdSchema,
  threadIdSchema,
  workspaceIdSchema,
} from "./domain.js";

export const TERMINAL_WEBSOCKET_PATH = "/api/terminal" as const;
export const TERMINAL_WEBSOCKET_PROTOCOL = "sedes.terminal.v2" as const;
export const TERMINAL_PROTOCOL_VERSION = 2 as const;

export const terminalIdSchema = z.string().uuid();
export const terminalIncarnationIdSchema = z.string().uuid();
export const terminalAttachmentIdSchema = z.string().uuid();
export const terminalProducerIdSchema = z.string().uuid();
export const terminalLifecycleSchema = z.enum([
  "reserved",
  "starting",
  "running",
  "stopping",
  "exited",
  "failed",
  "interrupted",
]);
export const terminalTerminationEffectSchema = z.enum([
  "end_process",
  "disconnect_transport",
]);
export const terminalRoleSchema = z.enum(["controller", "observer"]);
export const terminalColumnsSchema = z.number().int().min(2).max(512);
export const terminalRowsSchema = z.number().int().min(1).max(256);
export const terminalSequenceSchema = z.number().int().nonnegative().safe();
export const terminalRevisionSchema = z.number().int().positive().safe();

export const terminalResourceSchema = z.strictObject({
  terminalId: terminalIdSchema,
  threadId: threadIdSchema,
  workspaceId: workspaceIdSchema,
  environmentId: environmentIdSchema,
  environmentLabel: z.string().min(1).max(160),
  incarnationId: terminalIncarnationIdSchema.nullable(),
  displayName: z.string().min(1).max(120),
  shellProfile: z.string().min(1).max(80).nullable(),
  initialCwd: z.string().min(1).max(4096),
  terminationEffect: terminalTerminationEffectSchema,
  lifecycle: terminalLifecycleSchema,
  lifecycleRevision: terminalRevisionSchema,
  rows: terminalRowsSchema,
  columns: terminalColumnsSchema,
  initialRows: terminalRowsSchema,
  initialColumns: terminalColumnsSchema,
  historyFloorSeq: terminalSequenceSchema,
  headSeq: terminalSequenceSchema,
  exitCode: z.number().int().nullable(),
  exitSignal: z.string().min(1).max(80).nullable(),
  publicReason: z.string().min(1).max(240).nullable(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  exitedAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type TerminalResource = z.infer<typeof terminalResourceSchema>;

export const terminalListResultSchema = z.strictObject({
  terminals: z.array(terminalResourceSchema).max(256),
});
export type TerminalListResult = z.infer<typeof terminalListResultSchema>;

export const createTerminalRequestSchema = z.strictObject({
  mutationId: mutationIdSchema,
  displayName: z.string().trim().min(1).max(120),
  shellProfile: z.string().trim().min(1).max(80).optional(),
  rows: terminalRowsSchema,
  columns: terminalColumnsSchema,
});
export type CreateTerminalRequest = z.infer<typeof createTerminalRequestSchema>;

export const terminalRouteParametersSchema = z.strictObject({
  terminalId: terminalIdSchema,
});

export const terminalMutationRequestSchema = z.strictObject({
  mutationId: mutationIdSchema,
  expectedRevision: terminalRevisionSchema,
});
export const renameTerminalRequestSchema = terminalMutationRequestSchema.extend({
  displayName: z.string().trim().min(1).max(120),
});
export type TerminalMutationRequest = z.infer<
  typeof terminalMutationRequestSchema
>;
export type RenameTerminalRequest = z.infer<typeof renameTerminalRequestSchema>;
export const terminalMutationResultSchema = z.strictObject({
  terminal: terminalResourceSchema.nullable(),
});

export const createTerminalAdmissionRequestSchema = z.strictObject({
  producerId: terminalProducerIdSchema,
  requestedRole: terminalRoleSchema,
  emulator: z.strictObject({
    family: z.literal("ghostty-web"),
    version: z.literal("0.4.0"),
    unicodeVersion: z.literal("11"),
    restoreFormat: z.literal("ansi-checkpoint-v1"),
  }),
  restore: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("checkpoint") }),
    z.strictObject({
      kind: z.literal("resume"),
      appliedSeq: terminalSequenceSchema,
    }),
  ]),
});
export type CreateTerminalAdmissionRequest = z.infer<
  typeof createTerminalAdmissionRequestSchema
>;

export const terminalAdmissionSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: z.string().datetime(),
  terminalId: terminalIdSchema,
  incarnationId: terminalIncarnationIdSchema,
  attachmentId: terminalAttachmentIdSchema,
});
export type TerminalAdmission = z.infer<typeof terminalAdmissionSchema>;

export const terminalInputOutcomeSchema = z.enum([
  "accepted",
  "duplicate",
  "not_sent",
  "sent_outcome_unknown",
  "rejected",
]);

const terminalFrameBaseSchema = z.strictObject({
  v: z.literal(TERMINAL_PROTOCOL_VERSION),
  terminalId: terminalIdSchema,
  incarnationId: terminalIncarnationIdSchema,
});

export const terminalClientFrameSchema = z.discriminatedUnion("type", [
  terminalFrameBaseSchema.extend({
    type: z.literal("ack_output"),
    appliedSeq: terminalSequenceSchema,
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("ack_snapshot"),
    checkpointSeq: terminalSequenceSchema,
    chunkIndex: z.number().int().nonnegative().max(1_024),
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("input"),
    controllerEpoch: terminalSequenceSchema,
    producerId: terminalProducerIdSchema,
    inputSeq: z.number().int().positive().safe(),
    data: z.string().regex(/^[A-Za-z0-9_-]+$/).max(90_000),
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("resize"),
    controllerEpoch: terminalSequenceSchema,
    rows: terminalRowsSchema,
    columns: terminalColumnsSchema,
  }),
  terminalFrameBaseSchema.extend({ type: z.literal("claim_control") }),
  terminalFrameBaseSchema.extend({ type: z.literal("release_control") }),
]);
export type TerminalClientFrame = z.infer<typeof terminalClientFrameSchema>;

export const terminalServerFrameSchema = z.discriminatedUnion("type", [
  terminalFrameBaseSchema.extend({
    type: z.literal("attached"),
    attachmentId: terminalAttachmentIdSchema,
    role: terminalRoleSchema,
    controllerEpoch: terminalSequenceSchema,
    lastAcceptedInputSeq: terminalSequenceSchema,
    lifecycle: terminalLifecycleSchema,
    lifecycleRevision: terminalRevisionSchema,
    rows: terminalRowsSchema,
    columns: terminalColumnsSchema,
    historyFloorSeq: terminalSequenceSchema,
    headSeq: terminalSequenceSchema,
    restoreKind: z.enum(["checkpoint", "resume"]),
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("snapshot_begin"),
    checkpointSeq: terminalSequenceSchema,
    rows: terminalRowsSchema,
    columns: terminalColumnsSchema,
    format: z.literal("ansi-checkpoint-v1"),
    byteLength: z.number().int().nonnegative().max(8 * 1024 * 1024),
    chunkCount: z.number().int().nonnegative().max(1_024),
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("snapshot_chunk"),
    checkpointSeq: terminalSequenceSchema,
    chunkIndex: z.number().int().nonnegative().max(1_024),
    data: z.string().regex(/^[A-Za-z0-9_-]+$/).max(65_536),
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("snapshot_end"),
    checkpointSeq: terminalSequenceSchema,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("output"),
    seq: terminalSequenceSchema,
    data: z.string().regex(/^[A-Za-z0-9_-]+$/).max(2_000_000),
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("resize_committed"),
    seq: terminalSequenceSchema,
    rows: terminalRowsSchema,
    columns: terminalColumnsSchema,
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("caught_up"),
    headSeq: terminalSequenceSchema,
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("input_result"),
    inputSeq: z.number().int().positive().safe(),
    outcome: terminalInputOutcomeSchema,
    lastAcceptedInputSeq: terminalSequenceSchema,
    message: z.string().min(1).max(240).optional(),
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("control_changed"),
    role: terminalRoleSchema,
    controllerEpoch: terminalSequenceSchema,
    lastAcceptedInputSeq: terminalSequenceSchema,
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("terminal_status"),
    seq: terminalSequenceSchema,
    lifecycle: terminalLifecycleSchema,
    lifecycleRevision: terminalRevisionSchema,
    exitCode: z.number().int().nullable(),
    exitSignal: z.string().min(1).max(80).nullable(),
    publicReason: z.string().min(1).max(240).nullable(),
  }),
  // Lifecycle can advance even when the raw journal is unavailable. This
  // unsequenced state revision never claims a durable history position; a
  // client applies it immediately and separately from appliedSeq.
  terminalFrameBaseSchema.extend({
    type: z.literal("lifecycle_state"),
    lifecycle: terminalLifecycleSchema,
    lifecycleRevision: terminalRevisionSchema,
    headSeq: terminalSequenceSchema,
    exitCode: z.number().int().nullable(),
    exitSignal: z.string().min(1).max(80).nullable(),
    publicReason: z.string().min(1).max(240).nullable(),
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("resync_required"),
    historyFloorSeq: terminalSequenceSchema,
  }),
  // Sent only after an explicit End has confirmed process cleanup and the
  // terminal resource plus retained history have been removed. This is
  // distinct from an unexpected disconnect or process-originated exit.
  terminalFrameBaseSchema.extend({
    type: z.literal("terminal_removed"),
  }),
  terminalFrameBaseSchema.extend({
    type: z.literal("error"),
    code: z.enum([
      "admission_invalid",
      "protocol_error",
      "stale_incarnation",
      "stale_controller",
      "input_gap",
      "viewer_too_slow",
      "terminal_unavailable",
    ]),
    message: z.string().min(1).max(240),
    retryable: z.boolean(),
  }),
]);
export type TerminalServerFrame = z.infer<typeof terminalServerFrameSchema>;

export type TerminalBinaryFrameKind = "output" | "input";
const TERMINAL_BINARY_MAGIC = new Uint8Array([0x53, 0x54, 0x30, 0x31]);
const TERMINAL_BINARY_FIXED_BYTES = 9;

/** Raw-byte carrier for PTY output and controller input. */
export function encodeTerminalBinaryFrame(
  kind: TerminalBinaryFrameKind,
  header: Readonly<Record<string, unknown>>,
  payload: Uint8Array,
): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const frame = new Uint8Array(
    TERMINAL_BINARY_FIXED_BYTES + headerBytes.byteLength + payload.byteLength,
  );
  frame.set(TERMINAL_BINARY_MAGIC, 0);
  frame[4] = kind === "output" ? 1 : 2;
  new DataView(frame.buffer).setUint32(5, headerBytes.byteLength, false);
  frame.set(headerBytes, TERMINAL_BINARY_FIXED_BYTES);
  frame.set(payload, TERMINAL_BINARY_FIXED_BYTES + headerBytes.byteLength);
  return frame;
}

export function decodeTerminalBinaryFrame(
  frame: Uint8Array,
): {
  readonly kind: TerminalBinaryFrameKind;
  readonly header: unknown;
  readonly payload: Uint8Array;
} {
  if (
    frame.byteLength < TERMINAL_BINARY_FIXED_BYTES ||
    TERMINAL_BINARY_MAGIC.some((value, index) => frame[index] !== value)
  ) {
    throw new Error("terminal_binary_frame_invalid");
  }
  const discriminator = frame[4];
  if (discriminator !== 1 && discriminator !== 2) {
    throw new Error("terminal_binary_frame_kind_invalid");
  }
  const headerLength = new DataView(
    frame.buffer,
    frame.byteOffset,
    frame.byteLength,
  ).getUint32(5, false);
  const payloadOffset = TERMINAL_BINARY_FIXED_BYTES + headerLength;
  if (payloadOffset > frame.byteLength || headerLength > 16 * 1024) {
    throw new Error("terminal_binary_frame_header_invalid");
  }
  const headerText = new TextDecoder("utf-8", { fatal: true }).decode(
    frame.subarray(TERMINAL_BINARY_FIXED_BYTES, payloadOffset),
  );
  return {
    kind: discriminator === 1 ? "output" : "input",
    header: JSON.parse(headerText) as unknown,
    payload: frame.slice(payloadOffset),
  };
}
