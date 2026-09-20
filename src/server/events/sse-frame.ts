import { MAXIMUM_SSE_EVENT_BYTES } from "../../shared/protocol/payload.js";

/**
 * Enforces the transport limit against the exact UTF-8 bytes written to the
 * socket, not merely the JSON data field.
 */
export function assertBoundedSseFrame(frame: string): string {
  if (Buffer.byteLength(frame, "utf8") > MAXIMUM_SSE_EVENT_BYTES) {
    throw new Error("sse_event_frame_byte_limit_exceeded");
  }
  return frame;
}
