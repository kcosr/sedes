import { describe, expect, it } from "vitest";
import {
  AGENT_TOOL_CLI_MAXIMUM_FRAME_BYTES,
  AgentToolCliFrameDecoder,
  encodeAgentToolCliFrame,
} from "../../src/internal/agent-tool-cli-protocol/index.js";

describe("agent_tools_cli@3 framing", () => {
  it("decodes one fragmented length-prefixed JSON frame", () => {
    const frame = encodeAgentToolCliFrame({ operation: "list", revision: 1 });
    const decoder = new AgentToolCliFrameDecoder();

    expect(decoder.push(frame.subarray(0, 2))).toBeUndefined();
    expect(decoder.push(frame.subarray(2, 7))).toBeUndefined();
    expect(decoder.push(frame.subarray(7))).toEqual({
      operation: "list",
      revision: 1,
    });
    expect(() => decoder.finishRequest()).not.toThrow();
  });

  it("rejects zero, oversized, trailing, malformed, and incomplete frames", () => {
    const zero = Buffer.alloc(4);
    expect(() => new AgentToolCliFrameDecoder().push(zero)).toThrow(
      "agent_tool_cli_frame_size_invalid",
    );

    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(AGENT_TOOL_CLI_MAXIMUM_FRAME_BYTES + 1);
    expect(() => new AgentToolCliFrameDecoder().push(oversized)).toThrow(
      "agent_tool_cli_frame_size_invalid",
    );

    const trailing = Buffer.concat([
      Buffer.from(encodeAgentToolCliFrame({ ok: true })),
      Buffer.from([1]),
    ]);
    expect(() => new AgentToolCliFrameDecoder().push(trailing)).toThrow(
      "agent_tool_cli_frame_trailing_bytes",
    );

    const invalidJson = Buffer.from([0, 0, 0, 1, 0xff]);
    expect(() => new AgentToolCliFrameDecoder().push(invalidJson)).toThrow(
      "agent_tool_cli_frame_json_invalid",
    );

    expect(() => new AgentToolCliFrameDecoder().finishRequest()).toThrow(
      "agent_tool_cli_frame_incomplete",
    );
  });
});
