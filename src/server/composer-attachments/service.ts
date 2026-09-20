import type { Readable } from "node:stream";
import {
  COMPOSER_ATTACHMENT_LIMITS,
  composerAttachmentDescriptorSchema,
  composerAttachmentFileNameSchema,
} from "../../shared/protocol/composer-attachments.js";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { ComposerAttachmentBlobStore } from "./blob-store.js";
import type {
  ComposerAttachmentPersistence,
  ComposerAttachmentUploadInput,
  OpenComposerAttachmentContent,
  ResolvedComposerAttachment,
} from "./contracts.js";

const FILE_NAME_CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

/** Browser names are presentation hints, never filesystem paths. */
export function sanitizeComposerAttachmentFileName(value: string): string {
  const normalized = value.normalize("NFC");
  const pieces = normalized.split(/[\\/]/u);
  const basename = pieces.at(-1) ?? "";
  const sanitized = Array.from(
    basename.replace(FILE_NAME_CONTROL_CHARACTERS, ""),
  )
    .filter((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 0xd800 || codePoint > 0xdfff;
    })
    .join("")
    .normalize("NFC");
  if (
    sanitized.trim().length === 0 ||
    sanitized === "." ||
    sanitized === ".."
  ) {
    throw new DomainError(
      "invalid_transition",
      "The attachment file name has no safe basename.",
    );
  }
  try {
    return composerAttachmentFileNameSchema.parse(sanitized);
  } catch (error) {
    throw new DomainError(
      "invalid_transition",
      "The attachment file name exceeds the supported basename limit.",
      false,
      { cause: error },
    );
  }
}

export class ComposerAttachmentService {
  constructor(
    readonly store: ComposerAttachmentBlobStore,
    readonly persistence: ComposerAttachmentPersistence,
  ) {}

  async initialize(now = Date.now()): Promise<void> {
    await this.store.initialize();
    for (const garbage of this.persistence.collectGarbage(now)) {
      await this.store.remove(garbage.scope, garbage.digest);
    }
    await this.store.reconcile(this.persistence.listRetainedBlobs());
  }

  async upload(input: ComposerAttachmentUploadInput) {
    const fileName = sanitizeComposerAttachmentFileName(input.fileName);
    await this.collectGarbage(input.now ?? Date.now());
    if (
      input.contentLength !== undefined &&
      (!Number.isSafeInteger(input.contentLength) || input.contentLength < 0)
    ) {
      throw new DomainError(
        "invalid_transition",
        "The attachment length is invalid.",
      );
    }
    const blob = await this.store.receive({
      scope: input.scope,
      attachmentId: input.attachmentId,
      fileName,
      body: input.body,
      ...(input.contentLength === undefined
        ? {}
        : { contentLength: input.contentLength }),
    });
    try {
      const stored = this.persistence.recordUpload(
        input.scope,
        input.threadId,
        input.attachmentId,
        blob,
        input.now ?? Date.now(),
      );
      return composerAttachmentDescriptorSchema.parse(stored.descriptor);
    } catch (error) {
      // Publication precedes SQLite so a crash or failed transaction creates
      // only an orphan. The next exclusive startup reconciliation removes it.
      throw error;
    }
  }

  async openContent(
    scope: RequestScope,
    threadId: string,
    attachmentId: string,
  ): Promise<OpenComposerAttachmentContent> {
    const stored = this.persistence.findLiveOwner(
      scope,
      threadId,
      attachmentId,
    );
    if (!stored)
      throw new DomainError("not_found", "The attachment was not found.");
    const descriptor = composerAttachmentDescriptorSchema.parse(
      stored.descriptor,
    );
    return {
      descriptor,
      handle: await this.store.open(scope, stored.digest, descriptor.byteSize),
    };
  }

  resolveForDelivery(
    scope: RequestScope,
    threadId: string,
    attachmentIds: readonly string[],
  ): readonly ResolvedComposerAttachment[] {
    return attachmentIds.map((attachmentId) => {
      const stored = this.persistence.findLiveOwner(
        scope,
        threadId,
        attachmentId,
      );
      if (!stored) {
        throw new DomainError(
          "not_found",
          "A referenced attachment is no longer available.",
        );
      }
      const descriptor = composerAttachmentDescriptorSchema.parse(
        stored.descriptor,
      );
      return {
        descriptor,
        sha256: stored.digest,
        open: () => this.store.open(scope, stored.digest, descriptor.byteSize),
      };
    });
  }

  async collectGarbage(now = Date.now()): Promise<void> {
    for (const garbage of this.persistence.collectGarbage(now)) {
      await this.store.remove(garbage.scope, garbage.digest);
    }
  }
}
