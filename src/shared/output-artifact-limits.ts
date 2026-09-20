export const MAXIMUM_OUTPUT_IMAGE_BYTES = 16 * 1_024 * 1_024;

export function maximumBase64Characters(byteSize: number): number {
  if (!Number.isSafeInteger(byteSize) || byteSize < 0) {
    throw new Error("base64_byte_size_invalid");
  }
  return Math.ceil(byteSize / 3) * 4;
}
