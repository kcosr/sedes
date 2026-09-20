import { describe, expect, it } from "vitest";
import {
  decodeTerminalBinaryFrame,
  encodeTerminalBinaryFrame,
  terminalClientFrameSchema,
} from "../../src/shared/protocol/terminals.js";

describe("terminal binary protocol", () => {
  it("round-trips raw bytes without base64 expansion", () => {
    const header = {
      v: 2,
      type: "input",
      terminalId: "11111111-1111-4111-8111-111111111111",
      incarnationId: "22222222-2222-4222-8222-222222222222",
      controllerEpoch: 3,
      producerId: "33333333-3333-4333-8333-333333333333",
      inputSeq: 4,
    };
    const payload = Uint8Array.from([0, 1, 2, 255]);
    const decoded = decodeTerminalBinaryFrame(
      encodeTerminalBinaryFrame("input", header, payload),
    );
    expect(decoded).toEqual({ kind: "input", header, payload });
    expect(
      terminalClientFrameSchema.parse({
        ...(decoded.header as object),
        data: Buffer.from(decoded.payload).toString("base64url"),
      }),
    ).toMatchObject({ type: "input", inputSeq: 4 });
  });

  it("rejects unknown magic and kinds", () => {
    expect(() => decodeTerminalBinaryFrame(new Uint8Array(9))).toThrow(
      "terminal_binary_frame_invalid",
    );
    const frame = encodeTerminalBinaryFrame("output", {}, new Uint8Array());
    frame[4] = 9;
    expect(() => decodeTerminalBinaryFrame(frame)).toThrow(
      "terminal_binary_frame_kind_invalid",
    );
  });
});

