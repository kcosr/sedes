import { describe, expect, it } from "vitest";
import {
  canSafelyPreviewRaster,
  safeRasterDimensions,
} from "./safeRasterPreview.js";

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function jpegWithLateStartOfFrame(): Uint8Array {
  const startOfFrameOffset = 65_539;
  const bytes = new Uint8Array(startOfFrameOffset + 13);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff], 0);
  bytes.set(
    [0xff, 0xc0, 0x00, 0x0b, 8, 0x01, 0xe0, 0x02, 0x80, 3, 1, 0x11, 0],
    startOfFrameOffset,
  );
  return bytes;
}

describe("safe raster preview headers", () => {
  it.each([
    ["image/png", png(640, 480), { width: 640, height: 480 }],
    [
      "image/jpeg",
      new Uint8Array([
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x0b, 8,
        0x01, 0xe0, 0x02, 0x80, 3, 1, 0x11, 0, 2, 0x11,
      ]),
      { width: 640, height: 480 },
    ],
    [
      "image/gif",
      new Uint8Array([
        0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x80, 0x02, 0xe0, 0x01,
      ]),
      { width: 640, height: 480 },
    ],
    [
      "image/webp",
      new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50,
        0x38, 0x58, 0, 0, 0, 0, 0, 0, 0, 0, 0x7f, 0x02, 0, 0xdf, 0x01, 0,
      ]),
      { width: 640, height: 480 },
    ],
  ])("accepts bounded %s dimensions", (mediaType, bytes, expected) => {
    expect(safeRasterDimensions(mediaType, bytes)).toEqual(expected);
  });

  it("rejects an image whose header exceeds the dimension policy", () => {
    expect(safeRasterDimensions("image/png", png(16_385, 1))).toBeUndefined();
  });

  it("uses the server classification window for a JPEG with a late SOF marker", async () => {
    const bytes = jpegWithLateStartOfFrame();
    const content = new Blob([bytes.buffer as ArrayBuffer], {
      type: "image/jpeg",
    });

    await expect(canSafelyPreviewRaster(content)).resolves.toBe(true);
  });
});
