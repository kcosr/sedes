import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  COMPOSER_ATTACHMENT_CHUNK_BASE64_CHARACTERS,
  composerAttachmentsMaterializationAppendOperation,
  composerAttachmentsMaterializationOpenOperation,
  composerAttachmentsV1Operations,
} from "../../src/internal/sidecar-protocol/index.js";
import { MAXIMUM_COMPOSER_ATTACHMENT_STAGING_CHUNK_BYTES } from "../../src/shared/composer-attachment-staging-limits.js";

describe("composer_attachments@1 sidecar protocol", () => {
  it("exposes only the closed materialization operation set", () => {
    expect(
      composerAttachmentsV1Operations.map(({ operation }) => operation).sort(),
    ).toEqual([
      "materialization.abort",
      "materialization.append",
      "materialization.commit",
      "materialization.open",
      "materialization.release",
    ]);
  });

  it("strictly validates open identity without accepting a destination path", () => {
    const request = {
      admissionId: randomUUID(),
      scopeKey: "a".repeat(64),
      threadId: randomUUID(),
      attachmentId: randomUUID(),
      sha256: "b".repeat(64),
      sizeBytes: 0,
      extension: ".dat",
    };
    expect(
      composerAttachmentsMaterializationOpenOperation.requestSchema.parse(
        request,
      ),
    ).toEqual(request);
    expect(
      composerAttachmentsMaterializationOpenOperation.requestSchema.safeParse({
        ...request,
        destination: "/tmp/forged",
      }).success,
    ).toBe(false);
  });

  it("admits one canonical 256 KiB chunk and rejects noncanonical base64", () => {
    const content = Buffer.alloc(
      MAXIMUM_COMPOSER_ATTACHMENT_STAGING_CHUNK_BYTES,
      0xa5,
    );
    const request = {
      uploadHandle: randomUUID(),
      offset: 0,
      decodedBytes: content.byteLength,
      chunkSha256: "c".repeat(64),
      contentBase64: content.toString("base64"),
    };
    expect(request.contentBase64).toHaveLength(
      COMPOSER_ATTACHMENT_CHUNK_BASE64_CHARACTERS,
    );
    expect(
      composerAttachmentsMaterializationAppendOperation.requestSchema.parse(
        request,
      ),
    ).toEqual(request);
    expect(
      composerAttachmentsMaterializationAppendOperation.requestSchema.safeParse(
        {
          ...request,
          contentBase64: `${request.contentBase64}\n`,
        },
      ).success,
    ).toBe(false);
  });
});
