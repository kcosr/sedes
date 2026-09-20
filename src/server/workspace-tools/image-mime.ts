export type WorkspaceToolImageMediaType =
  "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/bmp";

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** Pinned Pi-compatible magic-byte detection; filenames grant no image type. */
export function detectWorkspaceToolImageMediaType(
  bytes: Uint8Array,
): WorkspaceToolImageMediaType | undefined {
  if (startsWith(bytes, Uint8Array.from([0xff, 0xd8, 0xff]))) {
    return bytes[3] === 0xf7 ? undefined : "image/jpeg";
  }
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return validPng(bytes) && !animatedPng(bytes) ? "image/png" : undefined;
  }
  if (asciiAt(bytes, 0, "GIF")) return "image/gif";
  if (asciiAt(bytes, 0, "RIFF") && asciiAt(bytes, 8, "WEBP")) {
    return "image/webp";
  }
  if (asciiAt(bytes, 0, "BM") && validBmp(bytes)) return "image/bmp";
  return undefined;
}

function validPng(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength >= 16 &&
    readUint32Be(bytes, PNG_SIGNATURE.byteLength) === 13 &&
    asciiAt(bytes, 12, "IHDR")
  );
}

function animatedPng(bytes: Uint8Array): boolean {
  let offset = PNG_SIGNATURE.byteLength;
  while (offset + 8 <= bytes.byteLength) {
    const length = readUint32Be(bytes, offset);
    const typeOffset = offset + 4;
    if (asciiAt(bytes, typeOffset, "acTL")) return true;
    if (asciiAt(bytes, typeOffset, "IDAT")) return false;
    const next = offset + 8 + length + 4;
    if (next <= offset || next > bytes.byteLength) return false;
    offset = next;
  }
  return false;
}

function validBmp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 26) return false;
  const declaredSize = readUint32Le(bytes, 2);
  const pixelOffset = readUint32Le(bytes, 10);
  const headerSize = readUint32Le(bytes, 14);
  if (declaredSize !== 0 && declaredSize < 26) return false;
  if (pixelOffset < 14 + headerSize) return false;
  if (declaredSize !== 0 && pixelOffset >= declaredSize) return false;
  let planes: number;
  let bits: number;
  if (headerSize === 12) {
    planes = readUint16Le(bytes, 22);
    bits = readUint16Le(bytes, 24);
  } else if (headerSize >= 40 && headerSize <= 124 && bytes.byteLength >= 30) {
    planes = readUint16Le(bytes, 26);
    bits = readUint16Le(bytes, 28);
  } else {
    return false;
  }
  return planes === 1 && [1, 4, 8, 16, 24, 32].includes(bits);
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return (
    bytes.byteLength >= prefix.byteLength &&
    prefix.every((value, index) => bytes[index] === value)
  );
}

function asciiAt(bytes: Uint8Array, offset: number, value: string): boolean {
  return (
    bytes.byteLength >= offset + value.length &&
    [...value].every(
      (character, index) => bytes[offset + index] === character.charCodeAt(0),
    )
  );
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) + ((bytes[offset + 1] ?? 0) << 8);
}
function readUint32Be(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) * 0x1000000 +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}
function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    ((bytes[offset + 1] ?? 0) << 8) +
    ((bytes[offset + 2] ?? 0) << 16) +
    (bytes[offset + 3] ?? 0) * 0x1000000
  );
}
