import { MAXIMUM_SSE_EVENT_BYTES } from "../../shared/protocol/payload.js";

/**
 * Enforces the transport limit against the exact UTF-8 bytes written to the
 * socket, not merely the JSON data field.
 */
export function assertBoundedSseFrame(frame: string): string {
  assertBoundedSseFrameBytes(Buffer.byteLength(frame, "utf8"));
  return frame;
}

/** The same limit for a frame whose exact UTF-8 size is already known. */
export function assertBoundedSseFrameBytes(bytes: number): void {
  if (bytes > MAXIMUM_SSE_EVENT_BYTES) {
    throw new Error("sse_event_frame_byte_limit_exceeded");
  }
}
