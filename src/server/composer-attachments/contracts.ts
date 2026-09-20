import type { FileHandle } from "node:fs/promises";
import type { Readable } from "node:stream";
import type { ComposerAttachmentDescriptor } from "../../shared/protocol/composer-attachments.js";
import type { RequestScope } from "../identity/identity-provider.js";

export type ComposerAttachmentBlob = Readonly<{
  digest: string;
  byteSize: number;
  descriptor: ComposerAttachmentDescriptor;
  imageWidth?: number;
  imageHeight?: number;
}>;

export type ComposerAttachmentStoredRecord = Readonly<{
  threadId: string;
  attachmentId: string;
  digest: string;
  descriptor: ComposerAttachmentDescriptor;
}>;

/**
 * Persistence authority for uploaded attachment identities and live owner
 * references. Implementations derive scope from the authenticated request and
 * enforce the principal quota while recording an upload.
 */
export interface ComposerAttachmentPersistence {
  recordUpload(
    scope: RequestScope,
    threadId: string,
    attachmentId: string,
    blob: ComposerAttachmentBlob,
    now: number,
  ): ComposerAttachmentStoredRecord;

  /** Returns only an attachment referenced by a live draft/stash/queue/message. */
  findLiveOwner(
    scope: RequestScope,
    threadId: string,
    attachmentId: string,
  ): ComposerAttachmentStoredRecord | undefined;

  /** Complete canonical blob set after persistence has removed expired uploads. */
  listRetainedBlobs(): readonly Readonly<{
    scope: RequestScope;
    digest: string;
    byteSize: number;
  }>[];

  /** Removes expired unowned uploads and returns blobs that lost their last row. */
  collectGarbage(now: number): readonly Readonly<{
    scope: RequestScope;
    digest: string;
  }>[];
}

export interface ComposerAttachmentUploadInput {
  readonly scope: RequestScope;
  readonly threadId: string;
  readonly attachmentId: string;
  readonly fileName: string;
  readonly body: Readable;
  readonly contentLength?: number;
  readonly now?: number;
}

export interface OpenComposerAttachmentContent {
  readonly descriptor: ComposerAttachmentDescriptor;
  readonly handle: FileHandle;
}

export interface ResolvedComposerAttachment {
  readonly descriptor: ComposerAttachmentDescriptor;
  readonly sha256: string;
  readonly open: () => Promise<FileHandle>;
}
