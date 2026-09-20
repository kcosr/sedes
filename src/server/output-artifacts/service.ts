import { createHash, randomUUID, subtle } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { inspectSupportedRasterImage } from "../images/raster-image-inspector.js";
import { OutputArtifactBlobStore } from "./blob-store.js";
import {
  MAXIMUM_OUTPUT_ARTIFACT_PUBLICATION_KEY_BYTES,
  MAXIMUM_OUTPUT_IMAGE_BYTES,
  OUTPUT_IMAGE_MEDIA_TYPES,
  type OpenOutputImageContent,
  type OutputArtifactPersistence,
  type OutputArtifactPublisher,
  type OutputImageArtifactDescriptor,
  type OutputImageMediaType,
  type PublishOutputImageInput,
} from "./contracts.js";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const utf8Encoder = new TextEncoder();

function publicationKeyHash(publicationKey: string): string {
  const bytes = utf8Encoder.encode(publicationKey);
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > MAXIMUM_OUTPUT_ARTIFACT_PUBLICATION_KEY_BYTES ||
    publicationKey.includes("\0")
  ) {
    throw new DomainError(
      "invalid_transition",
      "The output artifact publication identity is invalid.",
    );
  }
  return createHash("sha256").update(bytes).digest("hex");
}

function assertDescriptorMatches(
  descriptor: OutputImageArtifactDescriptor,
  expected: Readonly<{
    mediaType: OutputImageMediaType;
    byteSize: number;
    sha256: string;
  }>,
): void {
  if (
    descriptor.mediaType !== expected.mediaType ||
    descriptor.byteSize !== expected.byteSize ||
    descriptor.sha256 !== expected.sha256
  ) {
    throw new DomainError(
      "conflict",
      "The output artifact identity was reused with different content.",
    );
  }
}

export class OutputArtifactService implements OutputArtifactPublisher {
  readonly #publications = new Map<
    string,
    Promise<OutputImageArtifactDescriptor>
  >();
  readonly #blobOperations = new Map<string, Promise<void>>();

  constructor(
    readonly store: OutputArtifactBlobStore,
    readonly persistence: OutputArtifactPersistence,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
    for (const garbage of this.persistence.collectUnreferencedBlobs()) {
      await this.store.remove(garbage.scope, garbage.sha256);
    }
    await this.store.reconcile(this.persistence.listRetainedBlobs());
  }

  findImage(
    scope: RequestScope,
    threadId: string,
    publicationKey: string,
  ): OutputImageArtifactDescriptor | undefined {
    return this.persistence.findByPublicationKeyHash(
      scope,
      threadId,
      publicationKeyHash(publicationKey),
    );
  }

  async publishImage(
    input: PublishOutputImageInput,
  ): Promise<OutputImageArtifactDescriptor> {
    const keyHash = publicationKeyHash(input.publicationKey);
    if (!OUTPUT_IMAGE_MEDIA_TYPES.includes(input.mediaType)) {
      throw new DomainError(
        "invalid_transition",
        "The output image MIME type is unsupported.",
      );
    }
    if (
      input.bytes.byteLength < 1 ||
      input.bytes.byteLength > MAXIMUM_OUTPUT_IMAGE_BYTES
    ) {
      throw new DomainError(
        "invalid_transition",
        "The output image exceeds the supported byte limit.",
      );
    }
    if (
      input.expectedByteSize !== undefined &&
      input.expectedByteSize !== input.bytes.byteLength
    ) {
      throw new DomainError(
        "invalid_transition",
        "The output image size did not match its declared size.",
      );
    }
    const sha256 = Buffer.from(
      await subtle.digest(
        "SHA-256",
        input.bytes as Uint8Array<ArrayBuffer>,
      ),
    ).toString("hex");
    if (
      input.expectedSha256 !== undefined &&
      (!SHA256_PATTERN.test(input.expectedSha256) ||
        input.expectedSha256 !== sha256)
    ) {
      throw new DomainError(
        "invalid_transition",
        "The output image digest did not match its declared digest.",
      );
    }
    if (
      inspectSupportedRasterImage(input.bytes)?.mediaType !== input.mediaType
    ) {
      throw new DomainError(
        "invalid_transition",
        "The output image bytes did not match the declared MIME type.",
      );
    }

    const identity = {
      mediaType: input.mediaType,
      byteSize: input.bytes.byteLength,
      sha256,
    } as const;
    const existing = this.persistence.findByPublicationKeyHash(
      input.scope,
      input.threadId,
      keyHash,
    );
    if (existing) {
      assertDescriptorMatches(existing, identity);
      return existing;
    }

    const publicationIdentity = `${input.scope.tenantId}\0${input.scope.principalId}\0${input.threadId}\0${keyHash}`;
    const active = this.#publications.get(publicationIdentity);
    if (active) {
      const descriptor = await active;
      assertDescriptorMatches(descriptor, identity);
      return descriptor;
    }
    const publication = this.#publishImage(input, keyHash, identity);
    this.#publications.set(publicationIdentity, publication);
    try {
      const descriptor = await publication;
      assertDescriptorMatches(descriptor, identity);
      return descriptor;
    } finally {
      if (this.#publications.get(publicationIdentity) === publication) {
        this.#publications.delete(publicationIdentity);
      }
    }
  }

  async #publishImage(
    input: PublishOutputImageInput,
    keyHash: string,
    identity: Readonly<{
      mediaType: OutputImageMediaType;
      byteSize: number;
      sha256: string;
    }>,
  ): Promise<OutputImageArtifactDescriptor> {
    const blobIdentity = `${input.scope.tenantId}\0${input.scope.principalId}\0${identity.sha256}`;
    return await this.#withBlobOperation(blobIdentity, async () => {
      const existing = this.persistence.findByPublicationKeyHash(
        input.scope,
        input.threadId,
        keyHash,
      );
      if (existing) {
        assertDescriptorMatches(existing, identity);
        return existing;
      }

      await this.store.publish(input.scope, identity.sha256, input.bytes);
      let recorded: OutputImageArtifactDescriptor;
      try {
        recorded = this.persistence.recordImage({
          scope: input.scope,
          threadId: input.threadId,
          artifactId: randomUUID(),
          publicationKeyHash: keyHash,
          ...identity,
          now: input.now ?? Date.now(),
        });
      } catch (error) {
        if (!this.persistence.isBlobReferenced(input.scope, identity.sha256)) {
          await this.store.remove(input.scope, identity.sha256);
        }
        throw error;
      }
      assertDescriptorMatches(recorded, identity);
      return recorded;
    });
  }

  async #withBlobOperation<Result>(
    identity: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const prior = this.#blobOperations.get(identity) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prior.catch(() => undefined).then(() => gate);
    this.#blobOperations.set(identity, tail);
    await prior.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#blobOperations.get(identity) === tail) {
        this.#blobOperations.delete(identity);
      }
    }
  }

  async openImage(
    scope: RequestScope,
    threadId: string,
    artifactId: string,
  ): Promise<OpenOutputImageContent> {
    const descriptor = this.persistence.findById(scope, threadId, artifactId);
    if (!descriptor) {
      throw new DomainError("not_found", "The output artifact was not found.");
    }
    return {
      descriptor,
      handle: await this.store.open(
        scope,
        descriptor.sha256,
        descriptor.byteSize,
      ),
    };
  }

  async collectGarbage(): Promise<void> {
    for (const garbage of this.persistence.collectUnreferencedBlobs()) {
      const identity = `${garbage.scope.tenantId}\0${garbage.scope.principalId}\0${garbage.sha256}`;
      await this.#withBlobOperation(identity, async () => {
        if (!this.persistence.isBlobReferenced(garbage.scope, garbage.sha256)) {
          await this.store.remove(garbage.scope, garbage.sha256);
        }
      });
    }
  }
}
