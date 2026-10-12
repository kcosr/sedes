import { deflateSync } from "node:zlib";
import { AGENT_TOOL_MODEL_IMAGE_MAXIMUM_BYTES } from "../../src/internal/agent-tool-cli-protocol/model-content.js";

function chunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let index = 0; index < 8; index++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4), checksum = Buffer.alloc(4);
  header.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, body, checksum]);
}

/** A valid 1px PNG padded with a text chunk to the exact decoded image limit. */
export function maximumPreviewPng(extraBytes = 0): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 2;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = chunk("IHDR", header), data = chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))), end = chunk("IEND", Buffer.alloc(0));
  const padding = Buffer.alloc(AGENT_TOOL_MODEL_IMAGE_MAXIMUM_BYTES + extraBytes - signature.length - ihdr.length - data.length - end.length - 12, 65);
  Buffer.from("Comment\0").copy(padding);
  return Buffer.concat([signature, ihdr, chunk("tEXt", padding), data, end]);
}

/** Production console limits, using JSON's worst six-byte character escaping. */
export function maximumPreviewResult() {
  const png = maximumPreviewPng();
  return {
    invocationId: "maximum-preview",
    state: "completed" as const,
    output: {
      width: 4096, height: 8192, contentWidth: 1_000_000, contentHeight: 1_000_000,
      console: Array.from({ length: 100 }, () => ({ level: "log", text: "\u0000".repeat(2000) })),
      screenshot: { mimeType: "image/png" as const, width: 1, height: 1, byteSize: png.length },
    },
    modelContent: [{ type: "image" as const, mimeType: "image/png" as const, data: png.toString("base64") }],
  };
}
