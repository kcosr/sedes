import { describe, expect, it } from "vitest";

import {
  CODEX_GENERATED_IMAGE_MEDIA_TYPE,
  CODEX_MAXIMUM_GENERATED_IMAGE_BYTES,
  decodeCodexGeneratedImage,
  maximumCodexGeneratedImageBase64Characters,
} from "../../src/server/backends/codex/codex-generated-image.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../src/server/provider-protocol/transport/framed-message-limits.js";
import type { CodexThreadItem } from "../../src/server/backends/codex/codex-c1-protocol.js";

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

type ImageGenerationItem = Extract<
  CodexThreadItem,
  { readonly type: "imageGeneration" }
>;

function imageGeneration(
  overrides: Partial<ImageGenerationItem> = {},
): ImageGenerationItem {
  return {
    type: "imageGeneration",
    id: "image-generation-1",
    status: "completed",
    revisedPrompt: "A tiny blue square",
    result: PNG_BYTES.toString("base64"),
    failure: null,
    savedPath: "/provider/private/generated.png",
    ...overrides,
  };
}

describe("Codex generated-image decoding", () => {
  it("decodes the exact standard base64 PNG result without consulting savedPath", () => {
    const decoded = decodeCodexGeneratedImage(imageGeneration(), 1_024);

    expect(decoded).toEqual({
      type: "decoded",
      image: {
        bytes: PNG_BYTES,
        byteSize: PNG_BYTES.byteLength,
        mediaType: CODEX_GENERATED_IMAGE_MEDIA_TYPE,
        sha256:
          "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460",
      },
    });
    expect(JSON.stringify(decoded)).not.toContain("provider/private");
  });

  it.each(["in_progress", "failed", "opaque_unknown"])(
    "does not decode a %s item",
    (status) => {
      expect(
        decodeCodexGeneratedImage(imageGeneration({ status }), 1_024),
      ).toEqual({ type: "unavailable", reason: "not_completed" });
    },
  );

  it("classifies missing, malformed, noncanonical, and non-PNG results without exposing them", () => {
    const cases = [
      ["", "missing_result"],
      ["%%%private%%%", "invalid_base64"],
      ["Zh==", "invalid_base64"],
      [Buffer.from("not a png").toString("base64"), "invalid_png"],
    ] as const;

    for (const [result, reason] of cases) {
      const decoded = decodeCodexGeneratedImage(
        imageGeneration({ result }),
        1_024,
      );
      expect(decoded).toEqual({ type: "unavailable", reason });
      if (result.length > 0) {
        expect(JSON.stringify(decoded)).not.toContain(result);
      }
    }
  });

  it("rejects an encoded result above the byte bound before decoding", () => {
    const oversized = PNG_BYTES.toString("base64") + "AAAA";
    expect(
      decodeCodexGeneratedImage(
        imageGeneration({ result: oversized }),
        PNG_BYTES.byteLength,
      ),
    ).toEqual({ type: "unavailable", reason: "too_large" });
  });

  it("rejects an invalid caller-provided byte limit", () => {
    expect(() => decodeCodexGeneratedImage(imageGeneration(), 7)).toThrow(
      "codex_generated_image_limit_invalid",
    );
  });

  it("proves the maximum generated image wire value fits the shared frame without allocating it", () => {
    const encodedCharacters = maximumCodexGeneratedImageBase64Characters();
    // Leave a deterministic allowance vastly larger than the fixed item and
    // JSON envelope metadata around this one native result string.
    const envelopeAllowance = 1 * 1_024 * 1_024;
    expect(CODEX_MAXIMUM_GENERATED_IMAGE_BYTES).toBe(16 * 1_024 * 1_024);
    expect(encodedCharacters + envelopeAllowance).toBeLessThan(
      MAXIMUM_PROVIDER_FRAME_BYTES,
    );
  });
});
