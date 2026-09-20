import { describe, expect, it } from "vitest";
import { assertBoundedSseFrame } from "../../src/server/events/sse-frame.js";
import { MAXIMUM_SSE_EVENT_BYTES } from "../../src/shared/protocol/payload.js";

describe("SSE frame aggregate boundary", () => {
  it("measures the fully framed value in UTF-8 bytes", () => {
    const exact = "é".repeat(MAXIMUM_SSE_EVENT_BYTES / 2);
    expect(assertBoundedSseFrame(exact)).toBe(exact);
    expect(() => assertBoundedSseFrame(`${exact}é`)).toThrow(
      "sse_event_frame_byte_limit_exceeded",
    );
  });
});
