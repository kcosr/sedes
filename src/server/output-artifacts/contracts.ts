import type { FileHandle } from "node:fs/promises";
import { MAXIMUM_OUTPUT_IMAGE_BYTES } from "../../shared/output-artifact-limits.js";
import type { RequestScope } from "../identity/identity-provider.js";

export { MAXIMUM_OUTPUT_IMAGE_BYTES };

export const OUTPUT_IMAGE_MEDIA_TYPES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
] as const;

export type OutputImageMediaType = (typeof OUTPUT_IMAGE_MEDIA_TYPES)[number];

export const MAXIMUM_OUTPUT_ARTIFACT_PUBLICATION_KEY_BYTES = 512;

export type OutputImageArtifactDescriptor = Readonly<{
  artifactId: string;
  mediaType: OutputImageMediaType;
  byteSize: number;
  sha256: string;
}>;

export type PublishOutputImageInput = Readonly<{
  scope: RequestScope;
  threadId: string;
  /** Stable backend item identity. It is hashed before persistence. */
  publicationKey: string;
  mediaType: OutputImageMediaType;
  bytes: Uint8Array;
  expectedByteSize?: number;
  expectedSha256?: string;
  now?: number;
}>;

/** Narrow durable publication seam used by backend history projectors. */
export interface OutputArtifactPublisher {
  findImage(
    scope: RequestScope,
    threadId: string,
    publicationKey: string,
  ): OutputImageArtifactDescriptor | undefined;

  publishImage(
    input: PublishOutputImageInput,
  ): Promise<OutputImageArtifactDescriptor>;
}

export type OpenOutputImageContent = Readonly<{
  descriptor: OutputImageArtifactDescriptor;
  handle: FileHandle;
}>;

export type RetainedOutputImageBlob = Readonly<{
  scope: RequestScope;
  sha256: string;
  byteSize: number;
}>;

export interface OutputArtifactPersistence {
  findByPublicationKeyHash(
    scope: RequestScope,
    threadId: string,
    publicationKeyHash: string,
  ): OutputImageArtifactDescriptor | undefined;

  findById(
    scope: RequestScope,
    threadId: string,
    artifactId: string,
  ): OutputImageArtifactDescriptor | undefined;

  recordImage(
    input: Readonly<{
      scope: RequestScope;
      threadId: string;
      artifactId: string;
      publicationKeyHash: string;
      mediaType: OutputImageMediaType;
      byteSize: number;
      sha256: string;
      now: number;
    }>,
  ): OutputImageArtifactDescriptor;

  listRetainedBlobs(): readonly RetainedOutputImageBlob[];

  isBlobReferenced(scope: RequestScope, sha256: string): boolean;

  /** Deletes unreferenced blob rows and returns their canonical blob identities. */
  collectUnreferencedBlobs(): readonly RetainedOutputImageBlob[];
}
