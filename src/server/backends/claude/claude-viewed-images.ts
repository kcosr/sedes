import { pathForRemoteRoot } from "../../execution/remote-path.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import {
  MAXIMUM_OUTPUT_IMAGE_BYTES,
  OUTPUT_IMAGE_MEDIA_TYPES,
  type OutputArtifactPublisher,
  type OutputImageArtifactDescriptor,
  type OutputImageMediaType,
} from "../../output-artifacts/contracts.js";

/** Claude Code's Read returns an image block for exactly these extensions. */
const CLAUDE_IMAGE_READ_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
]);
const MAXIMUM_BASE64_CHARACTERS = Math.ceil(MAXIMUM_OUTPUT_IMAGE_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
const MAXIMUM_REMEMBERED_PUBLICATIONS = 4_096;

/** Claude Code's own test: the path's extension, case-insensitively. */
export function isClaudeImageReadPath(filePath: string): boolean {
  const extension = pathForRemoteRoot(filePath).extname(filePath);
  return CLAUDE_IMAGE_READ_EXTENSIONS.has(extension.toLowerCase().slice(1));
}

/** The in-band image Claude Code sent the model as a Read result. */
export interface ClaudeReadResultImage {
  readonly mediaType: OutputImageMediaType;
  /** Base64 exactly as Claude sent it; only an async publisher decodes it. */
  readonly data: string;
}

/**
 * The single base64 image block of a successful Read result. Only its shape,
 * declared media type, and encoded length are checked here; nothing decodes.
 */
export function claudeReadResultImage(
  content: unknown,
): ClaudeReadResultImage | undefined {
  if (!Array.isArray(content)) return undefined;
  const images = content.filter(
    (block) => isPlainRecord(block) && block.type === "image",
  );
  if (images.length !== 1) return undefined;
  const source = (images[0] as Record<string, unknown>).source;
  if (
    !isPlainRecord(source) ||
    source.type !== "base64" ||
    typeof source.data !== "string" ||
    typeof source.media_type !== "string"
  ) {
    return undefined;
  }
  const mediaType = OUTPUT_IMAGE_MEDIA_TYPES.find(
    (candidate) => candidate === source.media_type,
  );
  return mediaType !== undefined &&
    source.data.length > 0 &&
    source.data.length <= MAXIMUM_BASE64_CHARACTERS
    ? { mediaType, data: source.data }
    : undefined;
}

/** A completed image Read whose image has no retained association yet. */
export interface ClaudeViewedImageCandidate {
  readonly viewedBackendItemId: string;
  /** The image item, in the reserved slot after its read. */
  readonly identity: {
    readonly backendItemId: string;
    readonly backendTurnId: string;
    readonly sourceOrder: number;
  };
  readonly publicationKey: string;
  readonly image: ClaudeReadResultImage;
}

/** Synchronous lookup of retained associations; it never decodes or publishes. */
export interface ClaudeViewedImageAssociations {
  find(publicationKey: string): OutputImageArtifactDescriptor | undefined;
}

/**
 * Derived from the image item identity, which hashes the native session,
 * message, block, and kind. A fork or import is a new session, so it gets new
 * keys and publishes its own copy.
 */
export function claudeViewedImagePublicationKey(
  imageBackendItemId: string,
): string {
  return `claude-viewed-image:${imageBackendItemId}`;
}

/**
 * Publishes in-band Read images for one application thread. Retained
 * associations are trusted without rereading bytes. Successes and failures
 * are both remembered, so reprojection neither re-decodes nor retries a
 * failure on every message; a new instance (a reopened handle) retries.
 */
export class ClaudeViewedImagePublications
  implements ClaudeViewedImageAssociations
{
  readonly #outputArtifacts: OutputArtifactPublisher;
  readonly #scope: RequestScope;
  readonly #applicationThreadId: string;
  readonly #verified = new Map<string, OutputImageArtifactDescriptor>();
  readonly #failed = new Set<string>();

  constructor(input: {
    readonly outputArtifacts: OutputArtifactPublisher;
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
  }) {
    this.#outputArtifacts = input.outputArtifacts;
    this.#scope = { tenantId: input.scope.tenantId, principalId: input.scope.principalId };
    this.#applicationThreadId = input.applicationThreadId;
  }

  find(publicationKey: string): OutputImageArtifactDescriptor | undefined {
    const verified = this.#verified.get(publicationKey);
    if (verified || this.#failed.has(publicationKey)) return verified;
    let retained: OutputImageArtifactDescriptor | undefined;
    try {
      retained = this.#outputArtifacts.findImage(
        this.#scope,
        this.#applicationThreadId,
        publicationKey,
      );
    } catch {
      return undefined;
    }
    if (retained) remember(this.#verified, publicationKey, retained);
    return retained;
  }

  /** Candidates this instance has neither published nor seen fail. */
  publishable(
    candidates: readonly ClaudeViewedImageCandidate[],
  ): ClaudeViewedImageCandidate[] {
    return candidates.filter(
      ({ publicationKey }) =>
        !this.#verified.has(publicationKey) && !this.#failed.has(publicationKey),
    );
  }

  /** Returns whether any image gained an association. Never throws for an image. */
  async publish(
    candidates: readonly ClaudeViewedImageCandidate[],
    signal?: AbortSignal,
  ): Promise<boolean> {
    let published = false;
    for (const candidate of this.publishable(candidates)) {
      signal?.throwIfAborted();
      const { publicationKey, image } = candidate;
      const bytes = decodeClaudeImageData(image.data);
      if (!bytes) {
        rememberFailure(this.#failed, publicationKey);
        continue;
      }
      try {
        const descriptor = await this.#outputArtifacts.publishImage({
          scope: this.#scope,
          threadId: this.#applicationThreadId,
          publicationKey,
          mediaType: image.mediaType,
          bytes,
          expectedByteSize: bytes.byteLength,
        });
        if (
          descriptor.mediaType !== image.mediaType ||
          descriptor.byteSize !== bytes.byteLength
        ) {
          throw new Error("claude_viewed_image_descriptor_mismatch");
        }
        this.#failed.delete(publicationKey);
        remember(this.#verified, publicationKey, descriptor);
        published = true;
      } catch {
        rememberFailure(this.#failed, publicationKey);
      }
    }
    return published;
  }
}

/** Strict canonical base64 within the output ceiling, or nothing. */
function decodeClaudeImageData(data: string): Uint8Array | undefined {
  if (
    data.length === 0 ||
    data.length > MAXIMUM_BASE64_CHARACTERS ||
    data.length % 4 !== 0 ||
    !BASE64.test(data)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(data, "base64");
  return bytes.byteLength > 0 && bytes.byteLength <= MAXIMUM_OUTPUT_IMAGE_BYTES
    ? bytes
    : undefined;
}

function remember(
  map: Map<string, OutputImageArtifactDescriptor>,
  key: string,
  value: OutputImageArtifactDescriptor,
): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAXIMUM_REMEMBERED_PUBLICATIONS) {
    map.delete(map.keys().next().value!);
  }
}

function rememberFailure(set: Set<string>, key: string): void {
  set.add(key);
  if (set.size > MAXIMUM_REMEMBERED_PUBLICATIONS) {
    set.delete(set.values().next().value!);
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
