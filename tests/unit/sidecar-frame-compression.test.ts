import { constants, zstdCompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { asyncCodecBudget } from "../../src/internal/compression/async-codec-budget.js";
import { decompressSidecarFrame, tryCompressSidecarFrame } from "../../src/internal/sidecar-protocol/frame-compression.js";

const input = Buffer.from("sidecar λ🙂 data\n".repeat(100_000));
const signal = () => new AbortController().signal;
const encode = (bytes: Uint8Array, extra: Record<number, number> = {}) => zstdCompressSync(bytes, {
  params: { [constants.ZSTD_c_windowLog]: 20, [constants.ZSTD_c_checksumFlag]: 1, ...extra },
});

describe("independent sidecar zstd frames", () => {
  it("loads without zstd exports so unsupported runtimes can reach their version guard", async () => {
    vi.resetModules();
    vi.doMock("node:zlib", async importOriginal => ({
      ...await importOriginal<typeof import("node:zlib")>(),
      zstdCompress: undefined,
      zstdDecompress: undefined,
    }));
    try {
      const codec = await import("../../src/internal/sidecar-protocol/frame-compression.js");
      await expect(codec.tryCompressSidecarFrame(input)).rejects.toThrow("sidecar_node_version_unsupported");
    } finally {
      vi.doUnmock("node:zlib");
      vi.resetModules();
    }
  });

  it("round-trips a multi-block frame and releases the shared codec slot", async () => {
    const encoded = await tryCompressSidecarFrame(input);
    expect(encoded!.length).toBeLessThan(input.length / 10);
    expect(Buffer.from(await decompressSidecarFrame(encoded!, input.length, signal())).equals(input)).toBe(true);
    expect(asyncCodecBudget.activeCount).toBe(0);
  });

  it.each(["truncated block", "truncated checksum", "trailing bytes", "concatenated frames", "missing checksum", "dictionary", "reserved bit"])(
    "rejects %s before native decoding", async kind => {
      const encoded = encode(input);
      let invalid: Buffer;
      if (kind === "truncated block") invalid = encoded.subarray(0, encoded.length - 5);
      else if (kind === "truncated checksum") invalid = encoded.subarray(0, encoded.length - 1);
      else if (kind === "trailing bytes") invalid = Buffer.concat([encoded, Buffer.from([0])]);
      else if (kind === "concatenated frames") invalid = Buffer.concat([encoded, encoded]);
      else if (kind === "missing checksum") invalid = encode(input, { [constants.ZSTD_c_checksumFlag]: 0 });
      else {
        invalid = Buffer.from(encoded);
        invalid[4]! |= kind === "dictionary" ? 1 : 8;
      }
      await expect(decompressSidecarFrame(invalid, input.length, signal())).rejects.toThrow("sidecar_stream_zstd_frame_invalid");
      expect(asyncCodecBudget.activeCount).toBe(0);
    },
  );

  it("rejects checksum corruption and dishonest decoded lengths", async () => {
    const corrupt = encode(input);
    corrupt[corrupt.length - 1]! ^= 1;
    await expect(decompressSidecarFrame(corrupt, input.length, signal())).rejects.toThrow();
    await expect(decompressSidecarFrame(encode(input), input.length - 1, signal())).rejects.toThrow("sidecar_stream_decoded_length_invalid");
    // Without an embedded content size, the native output cap still rejects a bomb.
    const noSize = encode(input, { [constants.ZSTD_c_contentSizeFlag]: 0 });
    await expect(decompressSidecarFrame(noSize, 1024, signal())).rejects.toMatchObject({ code: "ERR_BUFFER_TOO_LARGE" });
    expect(asyncCodecBudget.activeCount).toBe(0);
  });

  it("rejects oversized window claims before allocating a codec", async () => {
    const encoded = encode(input, { [constants.ZSTD_c_contentSizeFlag]: 0 });
    encoded[5] = 88; // Window log 21, with no mantissa: 2 MiB.
    await expect(decompressSidecarFrame(encoded, input.length, signal())).rejects.toThrow("sidecar_stream_zstd_window_invalid");
    expect(asyncCodecBudget.activeCount).toBe(0);
  });

  it("skips busy encoders and cancels a decoder waiting for the shared budget", async () => {
    const first = asyncCodecBudget.tryAcquire()!;
    const second = asyncCodecBudget.tryAcquire()!;
    const abort = new AbortController();
    try {
      await expect(tryCompressSidecarFrame(input)).resolves.toBeUndefined();
      const decoding = decompressSidecarFrame(encode(input), input.length, abort.signal);
      expect(asyncCodecBudget.waitingCount).toBe(1);
      const rejected = expect(decoding).rejects.toThrow("closed while waiting");
      abort.abort(new Error("closed while waiting"));
      await rejected;
      expect(asyncCodecBudget.waitingCount).toBe(0);
    } finally {
      first.release(); second.release();
    }
    expect(asyncCodecBudget.activeCount).toBe(0);
  });
});
