import {
  COMPOSER_ATTACHMENT_LIMITS,
  MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_BYTES,
  MAXIMUM_COMPOSER_ATTACHMENT_IMAGES,
} from "../../../shared/protocol/composer-attachments.js";
import { MAXIMUM_COMPOSER_INPUT_BYTES } from "../../../shared/protocol/context-excerpts.js";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../provider-protocol/transport/framed-message-limits.js";

const MAXIMUM_JSON_ESCAPED_BYTES_PER_INPUT_BYTE = 6;
const MAXIMUM_ATTACHMENT_ID_BYTES = 36;
const MAXIMUM_ATTACHMENT_DIGEST_BYTES = 64;
const MAXIMUM_AUTHENTICATED_PROMPT_ID_BYTES = 1_024;
const MAXIMUM_SESSION_ID_BYTES = 1_024;

function base64EncodedBytes(bytes: number): number {
  return 4 * Math.ceil(bytes / 3);
}

/**
 * Deterministic upper-bound serialization count for the largest legal
 * normalized image prompt. Descriptor and authenticated-evidence bytes are
 * included even though the ACP image blocks themselves carry only MIME and
 * base64, so future evidence projection cannot silently consume the margin.
 */
export const MAXIMUM_LEGAL_GROK_IMAGE_REQUEST_ENCODED_BYTES = (() => {
  const imageDataBytes =
    MAXIMUM_COMPOSER_ATTACHMENT_IMAGES *
    base64EncodedBytes(MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_BYTES);
  const escapedComposerBytes =
    MAXIMUM_COMPOSER_INPUT_BYTES * MAXIMUM_JSON_ESCAPED_BYTES_PER_INPUT_BYTE;
  const escapedDescriptorBytes =
    MAXIMUM_COMPOSER_ATTACHMENT_IMAGES *
    (MAXIMUM_ATTACHMENT_ID_BYTES +
      COMPOSER_ATTACHMENT_LIMITS.maximumFileNameBytes *
        MAXIMUM_JSON_ESCAPED_BYTES_PER_INPUT_BYTE +
      MAXIMUM_ATTACHMENT_DIGEST_BYTES);
  const escapedAuthenticatedMetadataBytes =
    (MAXIMUM_AUTHENTICATED_PROMPT_ID_BYTES + MAXIMUM_SESSION_ID_BYTES) *
    MAXIMUM_JSON_ESCAPED_BYTES_PER_INPUT_BYTE;
  const structuralBytes = Buffer.byteLength(
    JSON.stringify({
      jsonrpc: "2.0",
      id: Number.MAX_SAFE_INTEGER,
      method: "session/prompt",
      params: {
        sessionId: "",
        prompt: [
          { type: "text", text: "" },
          ...Array.from({ length: MAXIMUM_COMPOSER_ATTACHMENT_IMAGES }, () => ({
            type: "image",
            mimeType: "image/jpeg",
            data: "",
          })),
        ],
        _meta: {
          promptId: "",
          attachmentEvidence: Array.from(
            { length: MAXIMUM_COMPOSER_ATTACHMENT_IMAGES },
            (_, order) => ({
              order,
              id: "",
              fileName: "",
              sha256: "",
              mimeType: "image/jpeg",
              byteSize: MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_BYTES,
            }),
          ),
        },
      },
    }),
    "utf8",
  );
  return (
    imageDataBytes +
    escapedComposerBytes +
    escapedDescriptorBytes +
    escapedAuthenticatedMetadataBytes +
    structuralBytes
  );
})();

if (
  MAXIMUM_LEGAL_GROK_IMAGE_REQUEST_ENCODED_BYTES >= MAXIMUM_PROVIDER_FRAME_BYTES
) {
  throw new Error("grok_maximum_image_request_exceeds_provider_frame");
}
