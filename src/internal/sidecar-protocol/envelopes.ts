import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";

// Wire v9 requires retained Claude failure state and typed send refusals.
// Older persistent services must go through upgrade handling before attachment.
// Managed peers require this exact version; there is no dual parser.
export const SIDECAR_WIRE_VERSION = 11 as const;
export const SIDECAR_JSON_FRAME_TAG = 0x01 as const;
export const SIDECAR_STREAM_DATA_FRAME_TAG = 0x02 as const;
const STREAM_DATA_SESSION_BINDING_BYTES = 16;
const STREAM_DATA_HEADER_BYTES = 45;
const MAXIMUM_STREAM_DATA_BYTES = 1024 * 1024;
const identifierSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z][a-z0-9_.-]*$/u);
const requestIdSchema = z.string().uuid();
const streamIdSchema = z.string().uuid();
const sessionNonceSchema = z.string().min(32).max(160);
export const sidecarRequestNamespaceSchema = z.enum(["sedes", "sidecar"]);

const sidecarRequestDeadlineSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("finite"),
    milliseconds: z.number().int().min(1).max(605_000),
  }),
  z.strictObject({ mode: z.literal("caller_abort") }),
]);

export const sidecarRequestEnvelopeSchema = z.strictObject({
  wireVersion: z.literal(SIDECAR_WIRE_VERSION),
  sessionNonce: sessionNonceSchema,
  type: z.literal("request"),
  requestNamespace: sidecarRequestNamespaceSchema,
  requestId: requestIdSchema,
  capabilityId: identifierSchema,
  majorVersion: z.number().int().min(1).max(65_535),
  operation: identifierSchema,
  deadline: sidecarRequestDeadlineSchema,
  payload: z.unknown(),
});

export const sidecarResponseEnvelopeSchema = z.discriminatedUnion("outcome", [
  z.strictObject({
    wireVersion: z.literal(SIDECAR_WIRE_VERSION),
    sessionNonce: sessionNonceSchema,
    type: z.literal("response"),
    requestNamespace: sidecarRequestNamespaceSchema,
    requestId: requestIdSchema,
    outcome: z.literal("ok"),
    payload: z.unknown(),
  }),
  z.strictObject({
    wireVersion: z.literal(SIDECAR_WIRE_VERSION),
    sessionNonce: sessionNonceSchema,
    type: z.literal("response"),
    requestNamespace: sidecarRequestNamespaceSchema,
    requestId: requestIdSchema,
    outcome: z.literal("error"),
    error: z.strictObject({
      code: identifierSchema,
      retryable: z.boolean(),
    }),
  }),
]);

export const sidecarCancelEnvelopeSchema = z.strictObject({
  wireVersion: z.literal(SIDECAR_WIRE_VERSION),
  sessionNonce: sessionNonceSchema,
  type: z.literal("cancel"),
  requestNamespace: sidecarRequestNamespaceSchema,
  requestId: requestIdSchema,
});

export const sidecarEventEnvelopeSchema = z.strictObject({
  wireVersion: z.literal(SIDECAR_WIRE_VERSION),
  sessionNonce: sessionNonceSchema,
  type: z.literal("event"),
  origin: sidecarRequestNamespaceSchema,
  capabilityId: identifierSchema,
  majorVersion: z.number().int().min(1).max(65_535),
  event: identifierSchema,
  payload: z.unknown(),
});

/** Consumer-to-producer raw-byte receive-window replenishment. */
export const sidecarStreamCreditEnvelopeSchema = z.strictObject({
  wireVersion: z.literal(SIDECAR_WIRE_VERSION),
  sessionNonce: sessionNonceSchema,
  type: z.literal("stream_credit"),
  origin: sidecarRequestNamespaceSchema,
  streamId: streamIdSchema,
  bytes: z
    .number()
    .int()
    .min(1)
    .max(16 * 1024 * 1024),
});

/** Credit-exempt final stream record, ordered after every data record. */
export const sidecarStreamTerminalEnvelopeSchema = z.strictObject({
  wireVersion: z.literal(SIDECAR_WIRE_VERSION),
  sessionNonce: sessionNonceSchema,
  type: z.literal("stream_terminal"),
  origin: sidecarRequestNamespaceSchema,
  streamId: streamIdSchema,
  sequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  capabilityId: identifierSchema,
  majorVersion: z.number().int().min(1).max(65_535),
  payload: z.unknown(),
});

export const sidecarEnvelopeSchema = z.discriminatedUnion("type", [
  sidecarRequestEnvelopeSchema,
  sidecarResponseEnvelopeSchema,
  sidecarCancelEnvelopeSchema,
  sidecarEventEnvelopeSchema,
  sidecarStreamCreditEnvelopeSchema,
  sidecarStreamTerminalEnvelopeSchema,
]);

export type SidecarRequestEnvelope = z.infer<
  typeof sidecarRequestEnvelopeSchema
>;
export type SidecarResponseEnvelope = z.infer<
  typeof sidecarResponseEnvelopeSchema
>;
export type SidecarCancelEnvelope = z.infer<typeof sidecarCancelEnvelopeSchema>;
export type SidecarEventEnvelope = z.infer<typeof sidecarEventEnvelopeSchema>;
export type SidecarStreamChannel = "stdout" | "stderr" | "data";
export interface SidecarStreamDataFrame {
  readonly sessionNonce: string;
  readonly origin: SidecarRequestNamespace;
  readonly streamId: string;
  readonly sequence: number;
  readonly channel: SidecarStreamChannel;
  readonly bytes: Uint8Array;
}
export type SidecarStreamCreditEnvelope = z.infer<
  typeof sidecarStreamCreditEnvelopeSchema
>;
export type SidecarStreamTerminalEnvelope = z.infer<
  typeof sidecarStreamTerminalEnvelopeSchema
>;
export type SidecarEnvelope = z.infer<typeof sidecarEnvelopeSchema>;
export type SidecarRequestNamespace = z.infer<
  typeof sidecarRequestNamespaceSchema
>;

export type DecodedSidecarFrame =
  | { readonly kind: "control"; readonly envelope: SidecarEnvelope }
  | { readonly kind: "stream_data"; readonly frame: SidecarStreamDataFrame };

export function encodeSidecarEnvelope(envelope: SidecarEnvelope): Uint8Array {
  const parsed = sidecarEnvelopeSchema.parse(envelope);
  return Buffer.concat([
    Buffer.from([SIDECAR_JSON_FRAME_TAG]),
    Buffer.from(JSON.stringify(parsed), "utf8"),
  ]);
}

export function decodeSidecarEnvelope(bytes: Uint8Array): SidecarEnvelope {
  if (bytes[0] !== SIDECAR_JSON_FRAME_TAG) {
    throw new Error("sidecar_protocol_frame_tag_invalid");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(1));
  } catch (error) {
    throw new Error("sidecar_protocol_frame_invalid_utf8", { cause: error });
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error("sidecar_protocol_frame_invalid_json", { cause: error });
  }
  const parsed = sidecarEnvelopeSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error("sidecar_protocol_envelope_invalid", {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/**
 * Wire-v5 stream-data layout, all integers big-endian:
 * tag:u8, wireVersion:u16, sessionBinding:sha256(nonce)[0..15], origin:u8,
 * channel:u8, streamId:uuid[16], sequence:u64, bytes:raw[1..1MiB].
 *
 * Binary records remain bound to the same independently authenticated
 * carrier/session generation as JSON controls without repeating the variable
 * length nonce or encoding file bytes as JSON.
 */
export function encodeSidecarStreamDataFrame(
  frame: SidecarStreamDataFrame,
): Uint8Array {
  const streamId = encodeUuid(frame.streamId);
  const sessionBinding = sessionBindingFor(frame.sessionNonce);
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence < 0) {
    throw new Error("sidecar_protocol_stream_sequence_invalid");
  }
  if (
    frame.bytes.byteLength === 0 ||
    frame.bytes.byteLength > MAXIMUM_STREAM_DATA_BYTES
  ) {
    throw new Error("sidecar_stream_chunk_size_invalid");
  }
  const encoded = Buffer.allocUnsafe(
    STREAM_DATA_HEADER_BYTES + frame.bytes.byteLength,
  );
  encoded[0] = SIDECAR_STREAM_DATA_FRAME_TAG;
  encoded.writeUInt16BE(SIDECAR_WIRE_VERSION, 1);
  sessionBinding.copy(encoded, 3);
  encoded[19] = encodeOrigin(frame.origin);
  encoded[20] = encodeChannel(frame.channel);
  streamId.copy(encoded, 21);
  encoded.writeBigUInt64BE(BigInt(frame.sequence), 37);
  encoded.set(frame.bytes, STREAM_DATA_HEADER_BYTES);
  return encoded;
}

export function decodeSidecarFrame(
  bytes: Uint8Array,
  expectedSessionNonce: string,
): DecodedSidecarFrame {
  if (bytes[0] === SIDECAR_JSON_FRAME_TAG) {
    return { kind: "control", envelope: decodeSidecarEnvelope(bytes) };
  }
  if (bytes[0] !== SIDECAR_STREAM_DATA_FRAME_TAG) {
    throw new Error("sidecar_protocol_frame_tag_invalid");
  }
  if (bytes.byteLength <= STREAM_DATA_HEADER_BYTES) {
    throw new Error("sidecar_protocol_stream_data_invalid");
  }
  const encoded = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (encoded.readUInt16BE(1) !== SIDECAR_WIRE_VERSION) {
    throw new Error("sidecar_protocol_stream_wire_version_invalid");
  }
  if (bytes.byteLength - STREAM_DATA_HEADER_BYTES > MAXIMUM_STREAM_DATA_BYTES) {
    throw new Error("sidecar_protocol_stream_data_invalid");
  }
  const expectedBinding = sessionBindingFor(expectedSessionNonce);
  if (
    !timingSafeEqual(
      encoded.subarray(3, 3 + STREAM_DATA_SESSION_BINDING_BYTES),
      expectedBinding,
    )
  ) {
    throw new Error("sidecar_protocol_session_nonce_mismatch");
  }
  const sequence = encoded.readBigUInt64BE(37);
  if (sequence > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("sidecar_protocol_stream_sequence_invalid");
  }
  return {
    kind: "stream_data",
    frame: {
      sessionNonce: expectedSessionNonce,
      origin: decodeOrigin(encoded[19]),
      channel: decodeChannel(encoded[20]),
      streamId: decodeUuid(encoded.subarray(21, 37)),
      sequence: Number(sequence),
      bytes: Uint8Array.from(encoded.subarray(STREAM_DATA_HEADER_BYTES)),
    },
  };
}

function sessionBindingFor(sessionNonce: string): Buffer {
  const parsed = sessionNonceSchema.safeParse(sessionNonce);
  if (!parsed.success) throw new Error("sidecar_session_nonce_invalid");
  return createHash("sha256")
    .update(parsed.data, "utf8")
    .digest()
    .subarray(0, STREAM_DATA_SESSION_BINDING_BYTES);
}

function encodeOrigin(origin: SidecarRequestNamespace): number {
  return origin === "sedes" ? 0 : 1;
}

function decodeOrigin(origin: number | undefined): SidecarRequestNamespace {
  if (origin === 0) return "sedes";
  if (origin === 1) return "sidecar";
  throw new Error("sidecar_protocol_stream_origin_invalid");
}

function encodeChannel(channel: SidecarStreamChannel): number {
  if (channel === "stdout") return 0;
  if (channel === "stderr") return 1;
  if (channel === "data") return 2;
  throw new Error("sidecar_protocol_stream_channel_invalid");
}

function decodeChannel(channel: number | undefined): SidecarStreamChannel {
  if (channel === 0) return "stdout";
  if (channel === 1) return "stderr";
  if (channel === 2) return "data";
  throw new Error("sidecar_protocol_stream_channel_invalid");
}

function encodeUuid(value: string): Buffer {
  if (!streamIdSchema.safeParse(value).success) {
    throw new Error("sidecar_stream_id_invalid");
  }
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function decodeUuid(value: Uint8Array): string {
  const hex = Buffer.from(value).toString("hex");
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!streamIdSchema.safeParse(uuid).success) {
    throw new Error("sidecar_stream_id_invalid");
  }
  return uuid;
}
