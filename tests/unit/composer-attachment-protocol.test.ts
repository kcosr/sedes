import { describe, expect, it } from "vitest";
import {
  COMPOSER_ATTACHMENT_POLICY,
  SEDES_CLIENT_PROTOCOL_VERSION,
  MAXIMUM_COMPOSER_ATTACHMENT_AGGREGATE_BYTES,
  MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES,
  MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_BYTES,
  MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_DIMENSION,
  MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_PIXELS,
  MAXIMUM_COMPOSER_ATTACHMENT_IMAGES,
  MAXIMUM_COMPOSER_ATTACHMENTS,
  backendCapabilityDocumentSchema,
  backendItemSchema,
  composerAttachmentArraySchema,
  composerAttachmentCapabilitySchema,
  composerAttachmentDescriptorSchema,
  composerAttachmentRouteParametersSchema,
  hasDeliverableComposerInput,
  messageContentPartSchema,
  normalizedDraftSchema,
  putComposerAttachmentQuerySchema,
  putComposerAttachmentResultSchema,
  saveDraftRequestSchema,
} from "../../src/shared/index.js";
import { stagedComposerAttachmentSchema } from "../../src/server/backends/contracts.js";

const fileAttachment = {
  id: "10000000-0000-4000-8000-000000000001",
  kind: "file" as const,
  fileName: "archive.zip",
  mediaType: "application/octet-stream" as const,
  byteSize: 0,
};

const imageAttachment = {
  id: "10000000-0000-4000-8000-000000000002",
  kind: "image" as const,
  fileName: "diagram.png",
  mediaType: "image/png" as const,
  byteSize: 0,
};

describe("composer attachment protocol", () => {
  it("accepts empty immutable files and the reviewed raster media types", () => {
    expect(composerAttachmentDescriptorSchema.parse(fileAttachment)).toEqual(
      fileAttachment,
    );
    expect(composerAttachmentDescriptorSchema.parse(imageAttachment)).toEqual(
      imageAttachment,
    );
    expect(() =>
      composerAttachmentDescriptorSchema.parse({
        ...imageAttachment,
        mediaType: "image/svg+xml",
      }),
    ).toThrow();
    expect(() =>
      composerAttachmentDescriptorSchema.parse({
        ...fileAttachment,
        mediaType: "text/plain",
      }),
    ).toThrow();
  });

  it("rejects C0 and C1 controls in attachment file names", () => {
    for (const fileName of ["tab\tname.bin", "next\u0085name.bin"]) {
      expect(() =>
        composerAttachmentDescriptorSchema.parse({
          ...fileAttachment,
          fileName,
        }),
      ).toThrow("Attachment file names must not contain control characters.");
    }
  });

  it("enforces count, per-kind byte, aggregate byte, and identity bounds", () => {
    expect(MAXIMUM_COMPOSER_ATTACHMENTS).toBe(8);
    expect(MAXIMUM_COMPOSER_ATTACHMENT_IMAGES).toBe(4);
    expect(MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES).toBe(25 * 1_024 * 1_024);
    expect(MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_BYTES).toBe(16 * 1_024 * 1_024);
    expect(MAXIMUM_COMPOSER_ATTACHMENT_AGGREGATE_BYTES).toBe(
      64 * 1_024 * 1_024,
    );
    expect(MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_PIXELS).toBe(40_000_000);
    expect(MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_DIMENSION).toBe(16_384);

    expect(() =>
      composerAttachmentArraySchema.parse([
        fileAttachment,
        { ...fileAttachment },
      ]),
    ).toThrow();
    expect(() =>
      composerAttachmentArraySchema.parse(
        Array.from({ length: 9 }, (_, index) => ({
          ...fileAttachment,
          id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        })),
      ),
    ).toThrow();
    expect(() =>
      composerAttachmentArraySchema.parse(
        Array.from({ length: 5 }, (_, index) => ({
          ...imageAttachment,
          id: `40000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        })),
      ),
    ).toThrow();
    expect(
      composerAttachmentArraySchema.parse(
        Array.from({ length: 4 }, (_, index) => ({
          ...imageAttachment,
          id: `50000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        })),
      ),
    ).toHaveLength(4);
    expect(() =>
      composerAttachmentArraySchema.parse(
        Array.from({ length: 3 }, (_, index) => ({
          ...fileAttachment,
          id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          byteSize: MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES,
        })),
      ),
    ).toThrow();
  });

  it("keeps native paths, digests, and bytes out of browser descriptors", () => {
    for (const unsafe of [
      { agentPath: "/private/staging/archive.zip" },
      { digest: "a".repeat(64) },
      { dataBase64: "AA==" },
    ]) {
      expect(() =>
        composerAttachmentDescriptorSchema.parse({
          ...fileAttachment,
          ...unsafe,
        }),
      ).toThrow();
    }
  });

  it("bounds server-private staged paths and exact byte digests", () => {
    expect(
      stagedComposerAttachmentSchema.parse({
        ...fileAttachment,
        sha256: "a".repeat(64),
        agentPath: "/managed/staging/archive.zip",
      }),
    ).toMatchObject({
      sha256: "a".repeat(64),
      agentPath: "/managed/staging/archive.zip",
    });
    expect(() =>
      stagedComposerAttachmentSchema.parse({
        ...fileAttachment,
        sha256: "A".repeat(64),
        agentPath: "/managed/staging/archive.zip",
      }),
    ).toThrow();
    expect(() =>
      stagedComposerAttachmentSchema.parse({
        ...fileAttachment,
        sha256: "a".repeat(64),
        agentPath: "bad\0path",
      }),
    ).toThrow();
  });

  it("makes attachment-only drafts deliverable and links by ordered IDs", () => {
    expect(
      hasDeliverableComposerInput({ text: "", attachments: [fileAttachment] }),
    ).toBe(true);
    expect(
      normalizedDraftSchema.parse({
        text: "",
        contextExcerpts: [],
        attachments: [fileAttachment],
        taskReferences: [],
        revision: 1,
      }).attachments,
    ).toEqual([fileAttachment]);
    expect(
      saveDraftRequestSchema.parse({
        text: "",
        contextExcerpts: [],
        attachmentIds: [imageAttachment.id, fileAttachment.id],
        taskReferenceIds: [],
        expectedRevision: 1,
      }).attachmentIds,
    ).toEqual([imageAttachment.id, fileAttachment.id]);
    expect(() =>
      saveDraftRequestSchema.parse({
        text: "",
        contextExcerpts: [],
        attachmentIds: [fileAttachment.id, fileAttachment.id],
        taskReferenceIds: [],
        expectedRevision: 1,
      }),
    ).toThrow();
  });

  it("keeps raw upload creation separate from draft mutation", () => {
    expect(
      putComposerAttachmentQuerySchema.parse({
        fileName: "raw.bin",
        declaredMediaType: "application/x-example",
      }),
    ).toEqual({
      fileName: "raw.bin",
      declaredMediaType: "application/x-example",
    });
    expect(
      composerAttachmentRouteParametersSchema.parse({
        threadId: "30000000-0000-4000-8000-000000000001",
        attachmentId: fileAttachment.id,
      }),
    ).toEqual({
      threadId: "30000000-0000-4000-8000-000000000001",
      attachmentId: fileAttachment.id,
    });
    expect(
      putComposerAttachmentResultSchema.parse({ attachment: fileAttachment }),
    ).toEqual({ attachment: fileAttachment });
    expect(() =>
      putComposerAttachmentResultSchema.parse({
        attachment: fileAttachment,
        draft: { revision: 2 },
      }),
    ).toThrow();
  });

  it("requires authenticated operation correlation for transcript attachments", () => {
    expect(
      messageContentPartSchema.parse({
        kind: "attachment",
        attachment: imageAttachment,
      }),
    ).toEqual({ kind: "attachment", attachment: imageAttachment });

    const backendMessage = {
      backendItemId: "item-1",
      backendTurnId: "turn-1",
      semanticKind: "user_message" as const,
      deliveryOperationId: "operation-1",
      status: "completed" as const,
      sourceOrder: 0,
      content: [{ kind: "attachment" as const, attachment: imageAttachment }],
    };
    expect(backendItemSchema.parse(backendMessage)).toEqual(backendMessage);
    const { deliveryOperationId: _operationId, ...uncorrelated } =
      backendMessage;
    expect(() => backendItemSchema.parse(uncorrelated)).toThrow();
  });

  it("separates staged file and native image capability", () => {
    expect(
      composerAttachmentCapabilitySchema.parse({
        fileStaging: { availability: "available" },
        nativeImage: {
          availability: "unavailable",
          reason: { text: "The selected model accepts text only." },
        },
        policy: COMPOSER_ATTACHMENT_POLICY,
      }),
    ).toMatchObject({
      fileStaging: { availability: "available" },
      nativeImage: { availability: "unavailable" },
    });
    expect(() =>
      composerAttachmentCapabilitySchema.parse({
        fileStaging: {
          availability: "unavailable",
          reason: { text: "No reviewed transfer channel." },
        },
        nativeImage: { availability: "available" },
        policy: COMPOSER_ATTACHMENT_POLICY,
      }),
    ).toThrow();

    const capabilities = {
      revision: "backend-1",
      actions: [],
      deliveryModes: ["submit" as const],
      steerTarget: null,
      composerAttachments: { fileStaging: true, nativeImage: false },
      nonblockingQuestions: false,
      providerOutputArtifacts: { nativeImage: false },
      supportsHistory: true,
      branching: {
        availability: "unavailable" as const,
        reason: { text: "Unavailable." },
      },
      interactionKinds: [],
      usageAccounting: "supported" as const, usageSections: [],
      effectiveSettings: {},
    };
    expect(backendCapabilityDocumentSchema.parse(capabilities)).toEqual(
      capabilities,
    );
    const {
      providerOutputArtifacts: _providerOutputArtifacts,
      ...missingOutputArtifacts
    } = capabilities;
    expect(
      backendCapabilityDocumentSchema.safeParse(missingOutputArtifacts).success,
    ).toBe(false);
  });

  it("advances the strict client protocol", () => {
    expect(SEDES_CLIENT_PROTOCOL_VERSION).toBe(118);
  });
});
