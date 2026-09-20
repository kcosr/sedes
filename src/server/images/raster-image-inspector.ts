import {
  MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_DIMENSION,
  MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_PIXELS,
  COMPOSER_ATTACHMENT_IMAGE_MEDIA_TYPES,
} from "../../shared/protocol/composer-attachments.js";

export type SupportedRasterImageMediaType =
  (typeof COMPOSER_ATTACHMENT_IMAGE_MEDIA_TYPES)[number];

export type RasterImageInspection = Readonly<{
  mediaType: SupportedRasterImageMediaType;
  width: number;
  height: number;
}>;

function startsWithAt(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
): boolean {
  return (
    bytes.byteLength >= offset + signature.length &&
    signature.every((value, index) => bytes[offset + index] === value)
  );
}

function uint24LittleEndian(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
}

function dimensionsAreSafe(width: number, height: number): boolean {
  return (
    Number.isSafeInteger(width) &&
    Number.isSafeInteger(height) &&
    width > 0 &&
    height > 0 &&
    width <= MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_DIMENSION &&
    height <= MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_DIMENSION &&
    width * height <= MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_PIXELS
  );
}

/**
 * Parses the bounded structural header needed to identify a supported raster
 * and reject malformed dimensions. It does not fully decode image content.
 */
export function inspectSupportedRasterImage(
  bytes: Uint8Array,
): RasterImageInspection | undefined {
  let mediaType: SupportedRasterImageMediaType;
  let width: number;
  let height: number;

  if (startsWithAt(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (
      bytes.byteLength < 24 ||
      !startsWithAt(bytes, [0x00, 0x00, 0x00, 0x0d], 8) ||
      !startsWithAt(bytes, [0x49, 0x48, 0x44, 0x52], 12)
    ) {
      return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    mediaType = "image/png";
    width = view.getUint32(16);
    height = view.getUint32(20);
  } else if (
    startsWithAt(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) ||
    startsWithAt(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
  ) {
    if (bytes.byteLength < 10) return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    mediaType = "image/gif";
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
  } else if (startsWithAt(bytes, [0xff, 0xd8, 0xff])) {
    mediaType = "image/jpeg";
    let offset = 2;
    let found: Readonly<{ width: number; height: number }> | undefined;
    while (offset + 4 <= bytes.byteLength) {
      if (bytes[offset] !== 0xff) return undefined;
      while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.byteLength) return undefined;
      const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
      if (length < 2 || offset + length > bytes.byteLength) return undefined;
      const isStartOfFrame =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        ![0xc4, 0xc8, 0xcc].includes(marker);
      if (isStartOfFrame) {
        if (length < 7) return undefined;
        found = {
          height: (bytes[offset + 3]! << 8) | bytes[offset + 4]!,
          width: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        };
        break;
      }
      offset += length;
    }
    if (!found) return undefined;
    width = found.width;
    height = found.height;
  } else if (
    startsWithAt(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWithAt(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  ) {
    if (bytes.byteLength < 16) return undefined;
    mediaType = "image/webp";
    const chunk = String.fromCharCode(...bytes.subarray(12, 16));
    if (chunk === "VP8X") {
      if (bytes.byteLength < 30) return undefined;
      width = uint24LittleEndian(bytes, 24) + 1;
      height = uint24LittleEndian(bytes, 27) + 1;
    } else if (chunk === "VP8L") {
      if (bytes.byteLength < 25 || bytes[20] !== 0x2f) return undefined;
      const bits =
        bytes[21]! |
        (bytes[22]! << 8) |
        (bytes[23]! << 16) |
        (bytes[24]! << 24);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    } else if (chunk === "VP8 ") {
      if (
        bytes.byteLength < 30 ||
        bytes[23] !== 0x9d ||
        bytes[24] !== 0x01 ||
        bytes[25] !== 0x2a
      ) {
        return undefined;
      }
      width = (bytes[26]! | (bytes[27]! << 8)) & 0x3fff;
      height = (bytes[28]! | (bytes[29]! << 8)) & 0x3fff;
    } else {
      return undefined;
    }
  } else {
    return undefined;
  }

  if (!dimensionsAreSafe(width, height)) return undefined;
  return { mediaType, width, height };
}
