import { createHash } from "node:crypto";

import { maximumBase64Characters } from "../../../shared/output-artifact-limits.js";
import { MAXIMUM_OUTPUT_IMAGE_BYTES } from "../../output-artifacts/contracts.js";
import type { CodexThreadItem } from "./codex-c1-protocol.js";

export const CODEX_GENERATED_IMAGE_MEDIA_TYPE = "image/png" as const;
export const CODEX_MAXIMUM_GENERATED_IMAGE_BYTES = MAXIMUM_OUTPUT_IMAGE_BYTES;

export function maximumCodexGeneratedImageBase64Characters(
  maximumBytes = CODEX_MAXIMUM_GENERATED_IMAGE_BYTES,
): number {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("codex_generated_image_limit_invalid");
  }
  return maximumBase64Characters(maximumBytes);
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

type CodexImageGenerationItem = Extract<
  CodexThreadItem,
  { readonly type: "imageGeneration" }
>;

export interface DecodedCodexGeneratedImage {
  readonly bytes: Buffer;
  readonly byteSize: number;
  readonly mediaType: typeof CODEX_GENERATED_IMAGE_MEDIA_TYPE;
  readonly sha256: string;
}

export type CodexGeneratedImageDecodeResult =
  | {
      readonly type: "decoded";
      readonly image: DecodedCodexGeneratedImage;
    }
  | {
      readonly type: "unavailable";
      readonly reason:
        | "not_completed"
        | "missing_result"
        | "invalid_base64"
        | "too_large"
        | "invalid_png";
    };

/**
 * Decodes the provider-private `ImageGenerationItem.result` contract.
 *
 * Codex 0.153.0's image-generation extension returns standard, padded base64
 * PNG bytes in `result`. `savedPath` is only a provider-local convenience copy
 * and is deliberately not consulted here.
 */
export function decodeCodexGeneratedImage(
  item: CodexImageGenerationItem,
  maximumBytes: number,
): CodexGeneratedImageDecodeResult {
  if (item.status !== "completed") {
    return { type: "unavailable", reason: "not_completed" };
  }
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < PNG_SIGNATURE.length
  ) {
    throw new Error("codex_generated_image_limit_invalid");
  }

  const encoded = item.result.trim();
  if (encoded.length === 0) {
    return { type: "unavailable", reason: "missing_result" };
  }

  // Reject before allocating decoded bytes. Standard padded base64 uses four
  // characters for every (partial) three-byte group.
  if (
    encoded.length > maximumCodexGeneratedImageBase64Characters(maximumBytes)
  ) {
    return { type: "unavailable", reason: "too_large" };
  }
  if (
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      encoded,
    )
  ) {
    return { type: "unavailable", reason: "invalid_base64" };
  }

  const bytes = Buffer.from(encoded, "base64");
  // Buffer's decoder is intentionally forgiving. Re-encoding ensures the
  // native value used the exact standard canonical representation reviewed in
  // Codex source instead of an alternative or ambiguous spelling.
  if (bytes.toString("base64") !== encoded) {
    return { type: "unavailable", reason: "invalid_base64" };
  }
  if (bytes.byteLength > maximumBytes) {
    return { type: "unavailable", reason: "too_large" };
  }
  if (
    bytes.byteLength < PNG_SIGNATURE.length ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return { type: "unavailable", reason: "invalid_png" };
  }

  return {
    type: "decoded",
    image: {
      bytes,
      byteSize: bytes.byteLength,
      mediaType: CODEX_GENERATED_IMAGE_MEDIA_TYPE,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  };
}
