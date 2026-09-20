import { createHash } from "node:crypto";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  COMPOSER_ATTACHMENT_IMAGE_MEDIA_TYPES,
  MAXIMUM_COMPOSER_ATTACHMENT_IMAGES,
} from "../../../shared/protocol/composer-attachments.js";
import { MAXIMUM_COMPOSER_INPUT_BYTES } from "../../../shared/protocol/context-excerpts.js";
import { inspectSupportedRasterImage } from "../../images/raster-image-inspector.js";
import {
  BackendError,
  type CanonicalComposerAttachmentEvidence,
  type SubmitTurnInput,
} from "../contracts.js";

const MEBIBYTE = 1_024 * 1_024;

/** Claude's first-party image limit applies to the encoded base64 payload. */
export const CLAUDE_MAXIMUM_BASE64_IMAGE_BYTES = 10 * MEBIBYTE;
export const CLAUDE_MAXIMUM_IMAGE_DIMENSION = 8_000;
const CLAUDE_CODE_MAXIMUM_STREAM_INPUT_BYTES = 30 * MEBIBYTE;
/**
 * Safe serialized SDK-user-message budget beneath Claude Code's 30 MiB input
 * ceiling. One full shared composer-input allowance remains as headroom for
 * SDK control framing and future authenticated-envelope metadata; the actual
 * current text and its JSON escaping are also counted exactly below.
 */
export const CLAUDE_MAXIMUM_STREAM_INPUT_BYTES =
  CLAUDE_CODE_MAXIMUM_STREAM_INPUT_BYTES - MAXIMUM_COMPOSER_INPUT_BYTES;

// Provider session ids are normally UUIDs. Reserving the SDK's bounded native
// id width keeps the calculation safe if a future provider identity is longer.
const CLAUDE_MAXIMUM_NATIVE_ID_BYTES = 1_024;

type ClaudeUserContent = SDKUserMessage["message"]["content"];
type ClaudeImageMediaType =
  (typeof COMPOSER_ATTACHMENT_IMAGE_MEDIA_TYPES)[number];

/**
 * Resolves application-owned attachment evidence and bytes before the SDK
 * input queue is crossed. The authenticated text envelope remains the first
 * block so native history can restore attachment identities after restart.
 */
export async function claudeSubmissionContent(
  input: SubmitTurnInput,
  authenticatedText: string,
): Promise<ClaudeUserContent> {
  const evidence = resolveCanonicalEvidence(input);
  const imageCount = evidence.filter(
    (attachment) => attachment.kind === "image",
  ).length;
  if (imageCount === 0) return authenticatedText;
  if (imageCount > MAXIMUM_COMPOSER_ATTACHMENT_IMAGES) {
    throw imageError(
      "rejected",
      "The Claude submission contains too many images.",
      "claude_image_count_exceeded",
    );
  }
  if (!input.attachmentBytes) {
    throw imageError(
      "invalid_state",
      "Claude attachment delivery is missing canonical byte authority.",
      "claude_attachment_byte_authority_missing",
    );
  }

  const content: Exclude<ClaudeUserContent, string>[number][] = [
    { type: "text", text: authenticatedText },
  ];
  const aggregateBudget = claudeBase64ImageAggregateBudget(
    authenticatedText,
    evidence.flatMap((attachment) =>
      attachment.kind === "image"
        ? [attachment.mediaType as ClaudeImageMediaType]
        : [],
    ),
  );
  let aggregateEncodedBytes = 0;
  for (let index = 0; index < evidence.length; index += 1) {
    const canonical = evidence[index]!;
    if (canonical.kind !== "image") continue;
    const staged = input.attachments[index]!;
    let bytes: Buffer;
    try {
      bytes = await input.attachmentBytes.read(staged);
    } catch (error) {
      if (error instanceof BackendError) throw error;
      throw new BackendError(
        {
          category: "unavailable",
          retryable: true,
          crossedSubmissionBoundary: false,
          safeMessage: "The attachment content could not be read safely.",
          backendCode: "claude_attachment_read_failed",
        },
        { cause: error },
      );
    }
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.byteLength !== canonical.byteSize ||
      createHash("sha256").update(bytes).digest("hex") !== canonical.sha256
    ) {
      throw imageError(
        "invalid_state",
        "A referenced attachment failed its integrity check.",
        "claude_attachment_integrity_mismatch",
      );
    }
    const inspection = inspectSupportedRasterImage(bytes);
    if (
      !inspection ||
      inspection.mediaType !== canonical.mediaType ||
      inspection.width > CLAUDE_MAXIMUM_IMAGE_DIMENSION ||
      inspection.height > CLAUDE_MAXIMUM_IMAGE_DIMENSION
    ) {
      throw imageError(
        "rejected",
        "A referenced image is not supported by Claude.",
        "claude_image_unsupported",
      );
    }
    const encodedBytes = base64EncodedBytes(bytes.byteLength);
    aggregateEncodedBytes += encodedBytes;
    if (encodedBytes > CLAUDE_MAXIMUM_BASE64_IMAGE_BYTES) {
      throw imageError(
        "rejected",
        "A referenced image exceeds Claude's encoded image limit.",
        "claude_image_encoded_size_exceeded",
      );
    }
    if (aggregateEncodedBytes > aggregateBudget) {
      throw imageError(
        "rejected",
        "The Claude submission exceeds the safe stream-input request limit.",
        "claude_image_request_size_exceeded",
      );
    }
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: canonical.mediaType as ClaudeImageMediaType,
        data: bytes.toString("base64"),
      },
    });
  }
  return content;
}

/**
 * Exact base64-data allowance after serializing the authenticated text and
 * every image block inside a worst-case SDK user-message wrapper. The text is
 * already produced from the shared composer/context/task/attachment bounds,
 * so measuring it here also accounts for JSON escaping and envelope overhead
 * without duplicating those contracts.
 */
export function claudeBase64ImageAggregateBudget(
  authenticatedText: string,
  mediaTypes: readonly ClaudeImageMediaType[],
): number {
  const emptyDataMessageBytes = claudeStreamInputSerializedBytes(
    authenticatedText,
    mediaTypes,
    0,
  );
  const available = CLAUDE_MAXIMUM_STREAM_INPUT_BYTES - emptyDataMessageBytes;
  // Every actual base64 encoding is four-byte aligned. Returning the largest
  // aligned allowance gives callers an exact pass/fail boundary.
  return Math.max(0, Math.floor(available / 4) * 4);
}

/** Deterministic serialized size used by the stream-input budget invariant. */
export function claudeStreamInputSerializedBytes(
  authenticatedText: string,
  mediaTypes: readonly ClaudeImageMediaType[],
  aggregateBase64Bytes: number,
): number {
  if (!Number.isSafeInteger(aggregateBase64Bytes) || aggregateBase64Bytes < 0) {
    throw new Error("claude_image_aggregate_base64_bytes_invalid");
  }
  return (
    Buffer.byteLength(
      JSON.stringify({
        type: "user",
        session_id: "s".repeat(CLAUDE_MAXIMUM_NATIVE_ID_BYTES),
        parent_tool_use_id: null,
        uuid: "u".repeat(CLAUDE_MAXIMUM_NATIVE_ID_BYTES),
        message: {
          role: "user",
          content: [
            { type: "text", text: authenticatedText },
            ...mediaTypes.map((mediaType) => ({
              type: "image",
              source: { type: "base64", media_type: mediaType, data: "" },
            })),
          ],
        },
        origin: { kind: "human" },
      }),
      "utf8",
    ) + aggregateBase64Bytes
  );
}

function resolveCanonicalEvidence(
  input: SubmitTurnInput,
): readonly CanonicalComposerAttachmentEvidence[] {
  let evidence: readonly CanonicalComposerAttachmentEvidence[];
  try {
    evidence = input.attachmentEvidence?.resolve() ?? [];
  } catch (error) {
    if (error instanceof BackendError) throw error;
    throw new BackendError(
      {
        category: "invalid_state",
        retryable: false,
        crossedSubmissionBoundary: false,
        safeMessage: "A referenced attachment is no longer available.",
        backendCode: "claude_attachment_evidence_unavailable",
      },
      { cause: error },
    );
  }
  if (evidence.length !== input.attachments.length) evidenceMismatch();
  for (let index = 0; index < evidence.length; index += 1) {
    const staged = input.attachments[index];
    const canonical = evidence[index];
    if (
      !staged ||
      !canonical ||
      staged.id !== canonical.id ||
      staged.kind !== canonical.kind ||
      staged.fileName !== canonical.fileName ||
      staged.mediaType !== canonical.mediaType ||
      staged.byteSize !== canonical.byteSize ||
      staged.sha256 !== canonical.sha256 ||
      !/^[0-9a-f]{64}$/u.test(canonical.sha256) ||
      (canonical.kind === "image" &&
        !COMPOSER_ATTACHMENT_IMAGE_MEDIA_TYPES.includes(
          canonical.mediaType as ClaudeImageMediaType,
        ))
    ) {
      evidenceMismatch();
    }
  }
  return evidence;
}

function evidenceMismatch(): never {
  throw imageError(
    "invalid_state",
    "A referenced attachment changed before Claude delivery.",
    "claude_attachment_evidence_mismatch",
  );
}

function imageError(
  category: ConstructorParameters<typeof BackendError>[0]["category"],
  safeMessage: string,
  backendCode: string,
): BackendError {
  return new BackendError({
    category,
    retryable: false,
    crossedSubmissionBoundary: false,
    safeMessage,
    backendCode,
  });
}

function base64EncodedBytes(byteLength: number): number {
  return 4 * Math.ceil(byteLength / 3);
}
