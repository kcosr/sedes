import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  CanonicalComposerAttachmentEvidence,
  StagedComposerAttachment,
  SubmitTurnInput,
} from "../../src/server/backends/contracts.js";
import {
  CLAUDE_MAXIMUM_BASE64_IMAGE_BYTES,
  CLAUDE_MAXIMUM_STREAM_INPUT_BYTES,
  claudeBase64ImageAggregateBudget,
  claudeStreamInputSerializedBytes,
  claudeSubmissionContent,
} from "../../src/server/backends/claude/claude-native-images.js";

const IMAGE_ID = "11111111-1111-4111-8111-111111111111";

function png(width = 1, height = 1, byteLength = 24): Buffer {
  const bytes = Buffer.alloc(byteLength);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function fixture(bytes: Buffer): {
  readonly input: SubmitTurnInput;
  readonly attachment: StagedComposerAttachment;
  readonly evidence: CanonicalComposerAttachmentEvidence;
  readonly read: ReturnType<typeof vi.fn>;
} {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const attachment = {
    id: IMAGE_ID,
    kind: "image" as const,
    fileName: "diagram.png",
    mediaType: "image/png" as const,
    byteSize: bytes.byteLength,
    sha256: digest,
    agentPath: "/workspace/.sedes-attachments/diagram.png",
  } satisfies StagedComposerAttachment;
  const evidence = {
    id: attachment.id,
    kind: attachment.kind,
    fileName: attachment.fileName,
    mediaType: attachment.mediaType,
    byteSize: attachment.byteSize,
    sha256: attachment.sha256,
  } satisfies CanonicalComposerAttachmentEvidence;
  const read = vi.fn(async () => bytes);
  return {
    attachment,
    evidence,
    read,
    input: {
      applicationOperationId: "22222222-2222-4222-8222-222222222222",
      mutationId: "mutation-a",
      source: { kind: "user" },
      reconciliationToken: "reconcile-a",
      text: "Inspect this image.",
      contextExcerpts: [],
      taskContexts: [],
      attachments: [attachment],
      attachmentBytes: { read },
      attachmentEvidence: { resolve: () => [evidence] },
    },
  };
}

describe("Claude native image input", () => {
  it("keeps authenticated recovery text first and appends canonical image bytes", async () => {
    const bytes = png(640, 480);
    const { input, read } = fixture(bytes);

    await expect(
      claudeSubmissionContent(input, "<authenticated-envelope>"),
    ).resolves.toEqual([
      { type: "text", text: "<authenticated-envelope>" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: bytes.toString("base64"),
        },
      },
    ]);
    expect(read).toHaveBeenCalledWith(input.attachments[0]);
  });

  it("leaves text-only and staged-file submissions unchanged", async () => {
    const textOnly = fixture(png()).input;
    await expect(
      claudeSubmissionContent(
        {
          ...textOnly,
          attachments: [],
          attachmentBytes: undefined,
          attachmentEvidence: undefined,
        },
        "plain text",
      ),
    ).resolves.toBe("plain text");

    const file = {
      id: IMAGE_ID,
      kind: "file" as const,
      fileName: "notes.txt",
      mediaType: "application/octet-stream" as const,
      byteSize: 3,
      sha256: "a".repeat(64),
      agentPath: "/workspace/.sedes-attachments/notes.txt",
    } satisfies StagedComposerAttachment;
    await expect(
      claudeSubmissionContent(
        {
          ...textOnly,
          attachments: [file],
          attachmentBytes: undefined,
          attachmentEvidence: {
            resolve: () => [
              {
                id: file.id,
                kind: file.kind,
                fileName: file.fileName,
                mediaType: file.mediaType,
                byteSize: file.byteSize,
                sha256: file.sha256,
              },
            ],
          },
        },
        "file manifest",
      ),
    ).resolves.toBe("file manifest");
  });

  it("rejects changed evidence before reading or sending", async () => {
    const fixtureValue = fixture(png());
    await expect(
      claudeSubmissionContent(
        {
          ...fixtureValue.input,
          attachmentEvidence: {
            resolve: () => [
              { ...fixtureValue.evidence, sha256: "f".repeat(64) },
            ],
          },
        },
        "envelope",
      ),
    ).rejects.toMatchObject({
      backendCode: "claude_attachment_evidence_mismatch",
      crossedSubmissionBoundary: false,
    });
    expect(fixtureValue.read).not.toHaveBeenCalled();
  });

  it("rejects canonical byte and media mismatches", async () => {
    const fixtureValue = fixture(png());
    fixtureValue.read.mockResolvedValueOnce(Buffer.from("changed"));
    await expect(
      claudeSubmissionContent(fixtureValue.input, "envelope"),
    ).rejects.toMatchObject({
      backendCode: "claude_attachment_integrity_mismatch",
      crossedSubmissionBoundary: false,
    });

    const jpegClaim = fixture(png());
    const evidence = { ...jpegClaim.evidence, mediaType: "image/jpeg" };
    await expect(
      claudeSubmissionContent(
        {
          ...jpegClaim.input,
          attachments: [
            {
              ...jpegClaim.attachment,
              kind: "image" as const,
              mediaType: "image/jpeg" as const,
            },
          ],
          attachmentEvidence: { resolve: () => [evidence] },
        },
        "envelope",
      ),
    ).rejects.toMatchObject({ backendCode: "claude_image_unsupported" });
  });

  it("enforces Claude's dimensions and base64 payload bound", async () => {
    await expect(
      claudeSubmissionContent(fixture(png(8_001, 1)).input, "envelope"),
    ).rejects.toMatchObject({ backendCode: "claude_image_unsupported" });

    const maximumRawBytes =
      Math.floor(CLAUDE_MAXIMUM_BASE64_IMAGE_BYTES / 4) * 3;
    const oversized = fixture(png(1, 1, maximumRawBytes + 1));
    await expect(
      claudeSubmissionContent(oversized.input, "envelope"),
    ).rejects.toMatchObject({
      backendCode: "claude_image_encoded_size_exceeded",
      crossedSubmissionBoundary: false,
    });
  });

  it("derives an exact whole-message aggregate boundary with text and JSON headroom", () => {
    const authenticatedText =
      '<sedes-staged-attachments version="1">\n' +
      'A prompt containing JSON escapes: \\ " \n\t';
    const mediaTypes = [
      "image/png" as const,
      "image/jpeg" as const,
      "image/webp" as const,
    ];
    const budget = claudeBase64ImageAggregateBudget(
      authenticatedText,
      mediaTypes,
    );

    expect(budget).toBeGreaterThan(2 * CLAUDE_MAXIMUM_BASE64_IMAGE_BYTES);
    expect(budget).toBeLessThan(3 * CLAUDE_MAXIMUM_BASE64_IMAGE_BYTES);
    expect(budget % 4).toBe(0);
    expect(
      claudeStreamInputSerializedBytes(authenticatedText, mediaTypes, budget),
    ).toBeLessThanOrEqual(CLAUDE_MAXIMUM_STREAM_INPUT_BYTES);
    expect(
      claudeStreamInputSerializedBytes(
        authenticatedText,
        mediaTypes,
        budget + 4,
      ),
    ).toBeGreaterThan(CLAUDE_MAXIMUM_STREAM_INPUT_BYTES);
  });
});
