import {
  COMPOSER_ATTACHMENT_LIMITS,
  MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_HEADER_BYTES,
} from "../../shared/index.js";

const MAXIMUM_HEADER_BYTES = MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_HEADER_BYTES;

type RasterDimensions = Readonly<{ width: number; height: number }>;

function uint16BigEndian(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function uint16LittleEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16)
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function pngDimensions(bytes: Uint8Array): RasterDimensions | undefined {
  if (
    bytes.length < 24 ||
    ![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every(
      (value, index) => bytes[index] === value,
    ) ||
    ascii(bytes, 12, 4) !== "IHDR"
  ) {
    return undefined;
  }
  return {
    width:
      ((bytes[16] ?? 0) * 0x1_00_00_00 +
        (bytes[17] ?? 0) * 0x1_00_00 +
        (bytes[18] ?? 0) * 0x100 +
        (bytes[19] ?? 0)) >>>
      0,
    height:
      ((bytes[20] ?? 0) * 0x1_00_00_00 +
        (bytes[21] ?? 0) * 0x1_00_00 +
        (bytes[22] ?? 0) * 0x100 +
        (bytes[23] ?? 0)) >>>
      0,
  };
}

function gifDimensions(bytes: Uint8Array): RasterDimensions | undefined {
  const signature = ascii(bytes, 0, 6);
  if (bytes.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) {
    return undefined;
  }
  return {
    width: uint16LittleEndian(bytes, 6),
    height: uint16LittleEndian(bytes, 8),
  };
}

function jpegDimensions(bytes: Uint8Array): RasterDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] !== 0xff) offset += 1;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    if (offset + 1 >= bytes.length) return undefined;
    const segmentLength = uint16BigEndian(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return undefined;
    }
    if (startOfFrameMarkers.has(marker) && segmentLength >= 7) {
      return {
        width: uint16BigEndian(bytes, offset + 5),
        height: uint16BigEndian(bytes, offset + 3),
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): RasterDimensions | undefined {
  if (
    bytes.length < 20 ||
    ascii(bytes, 0, 4) !== "RIFF" ||
    ascii(bytes, 8, 4) !== "WEBP"
  ) {
    return undefined;
  }
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: uint24LittleEndian(bytes, 24) + 1,
      height: uint24LittleEndian(bytes, 27) + 1,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + (bytes[21]! | ((bytes[22]! & 0x3f) << 8)),
      height:
        1 +
        ((bytes[22]! >> 6) | (bytes[23]! << 2) | ((bytes[24]! & 0x0f) << 10)),
    };
  }
  if (
    chunk === "VP8 " &&
    bytes.length >= 30 &&
    bytes[23] === 0x9d &&
    bytes[24] === 0x01 &&
    bytes[25] === 0x2a
  ) {
    return {
      width: uint16LittleEndian(bytes, 26) & 0x3fff,
      height: uint16LittleEndian(bytes, 28) & 0x3fff,
    };
  }
  return undefined;
}

export function safeRasterDimensions(
  mediaType: string,
  bytes: Uint8Array,
): RasterDimensions | undefined {
  const dimensions =
    mediaType === "image/png"
      ? pngDimensions(bytes)
      : mediaType === "image/jpeg"
        ? jpegDimensions(bytes)
        : mediaType === "image/gif"
          ? gifDimensions(bytes)
          : mediaType === "image/webp"
            ? webpDimensions(bytes)
            : undefined;
  if (
    !dimensions ||
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width > COMPOSER_ATTACHMENT_LIMITS.maximumImageDimension ||
    dimensions.height > COMPOSER_ATTACHMENT_LIMITS.maximumImageDimension ||
    dimensions.width * dimensions.height >
      COMPOSER_ATTACHMENT_LIMITS.maximumImagePixels
  ) {
    return undefined;
  }
  return dimensions;
}

export async function canSafelyPreviewRaster(
  content: Blob,
  mediaType = content.type,
): Promise<boolean> {
  const bytes = new Uint8Array(
    await content.slice(0, MAXIMUM_HEADER_BYTES).arrayBuffer(),
  );
  return safeRasterDimensions(mediaType, bytes) !== undefined;
}
