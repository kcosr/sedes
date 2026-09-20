import { describe, expect, it } from "vitest";
import { MAXIMUM_LEGAL_GROK_IMAGE_REQUEST_ENCODED_BYTES } from "../../src/server/backends/grok/grok-image-request-sizing.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../src/server/provider-protocol/transport/framed-message-limits.js";

describe("Grok maximum image request sizing", () => {
  it("fits the exact normalized product maxima beneath the shared frame", () => {
    expect(MAXIMUM_LEGAL_GROK_IMAGE_REQUEST_ENCODED_BYTES).toBe(91_070_907);
    expect(MAXIMUM_LEGAL_GROK_IMAGE_REQUEST_ENCODED_BYTES).toBeLessThan(
      MAXIMUM_PROVIDER_FRAME_BYTES,
    );
  });
});
