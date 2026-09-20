import path from "node:path";
import type { WorkspaceFileImageMediaType } from "../../shared/protocol/workspace-files.js";

export type WorkspaceFileByteClassification =
  | {
      readonly kind: "image";
      readonly mediaType: WorkspaceFileImageMediaType;
    }
  | {
      readonly kind: "text";
      readonly content: string;
      readonly retainedBytes: number;
    }
  | { readonly kind: "binary" };

const SUPPORTED_EXTENSION_MEDIA_TYPES = new Map<
  string,
  WorkspaceFileImageMediaType
>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export function workspaceFileImageMediaTypeForPath(
  relativePath: string,
): WorkspaceFileImageMediaType | undefined {
  return SUPPORTED_EXTENSION_MEDIA_TYPES.get(
    path.posix.extname(relativePath).toLowerCase(),
  );
}

const PNG_SIGNATURE = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_SIGNATURE = Uint8Array.from([0xff, 0xd8, 0xff]);
const GIF87A_SIGNATURE = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]);
const GIF89A_SIGNATURE = Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const RIFF_SIGNATURE = Uint8Array.from([0x52, 0x49, 0x46, 0x46]);
const WEBP_SIGNATURE = Uint8Array.from([0x57, 0x45, 0x42, 0x50]);

function startsWithAt(
  bytes: Uint8Array,
  signature: Uint8Array,
  offset = 0,
): boolean {
  if (bytes.byteLength < offset + signature.byteLength) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function detectedImageMediaType(
  bytes: Uint8Array,
): WorkspaceFileImageMediaType | undefined {
  if (startsWithAt(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWithAt(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  if (
    startsWithAt(bytes, GIF87A_SIGNATURE) ||
    startsWithAt(bytes, GIF89A_SIGNATURE)
  ) {
    return "image/gif";
  }
  if (
    bytes.byteLength >= 12 &&
    startsWithAt(bytes, RIFF_SIGNATURE) &&
    startsWithAt(bytes, WEBP_SIGNATURE, 8)
  ) {
    return "image/webp";
  }
  return undefined;
}

/**
 * Classifies one bounded descriptor read. Image-like names and signatures are
 * resolved before text decoding so a supported image, spoof, mismatch, or SVG
 * can never enter the editable-text path.
 */
export function classifyWorkspaceFileBytes(input: {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}): WorkspaceFileByteClassification {
  const extension = path.posix.extname(input.relativePath).toLowerCase();
  const extensionMediaType = workspaceFileImageMediaTypeForPath(
    input.relativePath,
  );
  const detectedMediaType = detectedImageMediaType(input.bytes);

  if (
    detectedMediaType !== undefined &&
    extensionMediaType === detectedMediaType
  ) {
    return { kind: "image", mediaType: detectedMediaType };
  }
  if (
    detectedMediaType !== undefined ||
    extensionMediaType !== undefined ||
    extension === ".svg"
  ) {
    return { kind: "binary" };
  }
  if (input.bytes.includes(0)) return { kind: "binary" };

  let retained = input.bytes;
  const maximumBoundaryBytes = input.truncated ? 3 : 0;
  for (let stripped = 0; stripped <= maximumBoundaryBytes; stripped += 1) {
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(retained);
      return {
        kind: "text",
        content,
        retainedBytes: new TextEncoder().encode(content).byteLength,
      };
    } catch {
      if (stripped === maximumBoundaryBytes || retained.byteLength === 0) {
        return { kind: "binary" };
      }
      retained = retained.subarray(0, retained.byteLength - 1);
    }
  }
  return { kind: "binary" };
}
