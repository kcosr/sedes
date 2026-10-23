import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { asyncCodecBudget } from "../compression/async-codec-budget.js";

export type SidecarFrameCompression = "none" | "zstd";

export const SIDECAR_COMPRESSION_MINIMUM_BYTES = 1024;
const MAXIMUM_WINDOW_BYTES = 1024 * 1024;
let codec: ReturnType<typeof createCodec> | undefined;

// Resolve zstd only after the CLI's Node version guard has had a chance to run.
// Older runtimes must be able to load the bundle and report that explicit error.
function createCodec() {
  if (typeof zlib.zstdCompress !== "function" || typeof zlib.zstdDecompress !== "function") {
    throw new Error("sidecar_node_version_unsupported");
  }
  return { compress: promisify(zlib.zstdCompress), decompress: promisify(zlib.zstdDecompress) };
}

/** An encoder never waits for a codec slot while holding up control traffic. */
export async function tryCompressSidecarFrame(bytes: Uint8Array): Promise<Buffer | undefined> {
  const lease = asyncCodecBudget.tryAcquire();
  if (!lease) return undefined;
  try {
    return await (codec ??= createCodec()).compress(bytes, {
      params: {
        [zlib.constants.ZSTD_c_compressionLevel]: 1,
        [zlib.constants.ZSTD_c_windowLog]: 20,
        [zlib.constants.ZSTD_c_checksumFlag]: 1,
      },
    });
  } finally {
    lease.release();
  }
}

export async function decompressSidecarFrame(
  bytes: Uint8Array,
  decodedLength: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  validateZstdFrame(bytes, decodedLength);
  const lease = await asyncCodecBudget.acquire(signal);
  try {
    signal.throwIfAborted();
    const decoded = await (codec ??= createCodec()).decompress(bytes, {
      maxOutputLength: decodedLength,
      params: { [zlib.constants.ZSTD_d_windowLogMax]: 20 },
    });
    signal.throwIfAborted();
    if (decoded.byteLength !== decodedLength) {
      throw new Error("sidecar_stream_decoded_length_invalid");
    }
    return decoded;
  } finally {
    lease.release();
  }
}

/**
 * Native Node zstd can accept unfinished input and ignore trailing bytes.
 * Validate one complete checksummed RFC 8878 frame before invoking the codec;
 * the native decoder remains responsible for compressed content and checksum.
 */
function validateZstdFrame(bytes: Uint8Array, decodedLength: number): void {
  const frame = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => new Error("sidecar_stream_zstd_frame_invalid");
  if (frame.byteLength < 6 || frame.readUInt32LE(0) !== 0xfd2fb528) throw invalid();
  const descriptor = frame[4]!;
  // The checksum is mandatory; dictionaries, reserved and unused bits are not supported.
  if ((descriptor & 0x1f) !== 0x04) throw invalid();
  const singleSegment = (descriptor & 0x20) !== 0;
  const contentSizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >>> 6]!;
  let offset = 5;
  let windowBytes: number;
  if (singleSegment) {
    windowBytes = decodedLength;
  } else {
    const windowDescriptor = frame[offset++]!;
    const windowBase = 2 ** (10 + (windowDescriptor >>> 3));
    windowBytes = windowBase + (windowBase / 8) * (windowDescriptor & 7);
  }
  if (windowBytes > MAXIMUM_WINDOW_BYTES) throw new Error("sidecar_stream_zstd_window_invalid");
  if (offset + contentSizeBytes > frame.byteLength) throw invalid();
  if (contentSizeBytes !== 0) {
    const contentSize = contentSizeBytes === 8
      ? frame.readBigUInt64LE(offset)
      : BigInt(frame.readUIntLE(offset, contentSizeBytes) + (contentSizeBytes === 2 ? 256 : 0));
    if (contentSize !== BigInt(decodedLength)) throw new Error("sidecar_stream_decoded_length_invalid");
  }
  offset += contentSizeBytes;
  const maximumBlockBytes = Math.min(windowBytes, 128 * 1024);
  for (;;) {
    if (offset + 3 > frame.byteLength) throw invalid();
    const header = frame.readUIntLE(offset, 3);
    offset += 3;
    const blockType = (header >>> 1) & 3;
    const blockBytes = header >>> 3;
    if (blockType === 3 || blockBytes > maximumBlockBytes) throw invalid();
    offset += blockType === 1 ? 1 : blockBytes;
    if (offset > frame.byteLength) throw invalid();
    if ((header & 1) !== 0) break;
  }
  if (offset + 4 !== frame.byteLength) throw invalid();
}
