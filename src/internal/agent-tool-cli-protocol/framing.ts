import { deterministicJson } from "../../server/canonical-json.js";
import { AGENT_TOOL_MAXIMUM_RESPONSE_BYTES } from "../../server/agent-tools/contracts/agent-tool-transport-limits.js";

export const AGENT_TOOL_CLI_MAXIMUM_FRAME_BYTES =
  AGENT_TOOL_MAXIMUM_RESPONSE_BYTES + 64 * 1_024;

export function encodeAgentToolCliFrame(value: unknown): Uint8Array {
  const payload = Buffer.from(deterministicJson(value), "utf8");
  if (
    payload.byteLength === 0 ||
    payload.byteLength > AGENT_TOOL_CLI_MAXIMUM_FRAME_BYTES
  ) {
    throw new Error("agent_tool_cli_frame_size_invalid");
  }
  const frame = Buffer.allocUnsafe(4 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class AgentToolCliFrameDecoder {
  #buffer = Buffer.alloc(0);
  #expectedBytes: number | undefined;
  #complete = false;

  push(chunk: Uint8Array): unknown | undefined {
    if (this.#complete || chunk.byteLength === 0) {
      if (this.#complete && chunk.byteLength > 0) {
        throw new Error("agent_tool_cli_frame_trailing_bytes");
      }
      return undefined;
    }
    if (
      this.#buffer.byteLength + chunk.byteLength >
      AGENT_TOOL_CLI_MAXIMUM_FRAME_BYTES + 4
    ) {
      throw new Error("agent_tool_cli_frame_too_large");
    }
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    if (this.#expectedBytes === undefined && this.#buffer.byteLength >= 4) {
      this.#expectedBytes = this.#buffer.readUInt32BE(0);
      if (
        this.#expectedBytes === 0 ||
        this.#expectedBytes > AGENT_TOOL_CLI_MAXIMUM_FRAME_BYTES
      ) {
        throw new Error("agent_tool_cli_frame_size_invalid");
      }
    }
    if (this.#expectedBytes === undefined) return undefined;
    const frameBytes = 4 + this.#expectedBytes;
    if (this.#buffer.byteLength < frameBytes) return undefined;
    if (this.#buffer.byteLength > frameBytes) {
      throw new Error("agent_tool_cli_frame_trailing_bytes");
    }
    this.#complete = true;
    const payload = this.#buffer.subarray(4);
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(payload),
      );
    } catch {
      throw new Error("agent_tool_cli_frame_json_invalid");
    }
  }

  finish(): void {
    if (!this.#complete) throw new Error("agent_tool_cli_frame_incomplete");
  }

  finishRequest(): void {
    this.finish();
  }
}
