import { maximumBase64Characters } from "../../../shared/output-artifact-limits.js";
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
const MAXIMUM_BASE64_CHARACTERS = maximumBase64Characters(MAXIMUM_OUTPUT_IMAGE_BYTES);
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

/** How long, and for how many images, a reader waits for publication. */
export interface ClaudeViewedImagePublicationBudget {
  readonly maximumImages: number;
  readonly timeoutMs: number;
}

/**
 * A page, a located turn, or an attach waits for at most four of its newest
 * images for at most two seconds, as a Codex page capture does. The rest
 * publish in the background and show on the next fetch or live update.
 */
export const CLAUDE_VIEWED_IMAGE_INLINE_BUDGET: ClaudeViewedImagePublicationBudget =
  Object.freeze({ maximumImages: 4, timeoutMs: 2_000 });
const BACKGROUND_CONCURRENCY = 2;
const MAXIMUM_QUEUED_PUBLICATIONS = 256;

/**
 * Publishes in-band Read images for one application thread. Retained
 * associations are trusted without rereading bytes. A failure is remembered
 * so reprojection never retries publishing it on every message, but it never
 * hides an association another path publishes; a new instance (a reopened
 * handle) retries. Close stops publication between images.
 */
export class ClaudeViewedImagePublications
  implements ClaudeViewedImageAssociations
{
  readonly #outputArtifacts: OutputArtifactPublisher;
  readonly #scope: RequestScope;
  readonly #applicationThreadId: string;
  readonly #onPublished: (publicationKey: string) => void;
  readonly #maximumRemembered: number;
  readonly #controller = new AbortController();
  readonly #verified = new Map<string, OutputImageArtifactDescriptor>();
  readonly #failed = new Set<string>();
  readonly #queued = new Map<string, ClaudeViewedImageCandidate>();
  readonly #inFlight = new Map<string, Promise<boolean>>();
  /** In-flight keys a reader is still waiting for; it reports them itself. */
  readonly #awaited = new Map<string, number>();
  #running = 0;
  #idle: { readonly promise: Promise<void>; readonly resolve: () => void } | undefined;

  constructor(input: {
    readonly outputArtifacts: OutputArtifactPublisher;
    readonly scope: RequestScope;
    readonly applicationThreadId: string;
    /** A background publication finished; its image can now be shown. */
    readonly onPublished?: (publicationKey: string) => void;
    readonly maximumRemembered?: number;
  }) {
    this.#outputArtifacts = input.outputArtifacts;
    this.#scope = { tenantId: input.scope.tenantId, principalId: input.scope.principalId };
    this.#applicationThreadId = input.applicationThreadId;
    this.#onPublished = input.onPublished ?? (() => undefined);
    this.#maximumRemembered = input.maximumRemembered ?? MAXIMUM_REMEMBERED_PUBLICATIONS;
  }

  get closed(): boolean {
    return this.#controller.signal.aborted;
  }

  find(publicationKey: string): OutputImageArtifactDescriptor | undefined {
    const verified = this.#verified.get(publicationKey);
    if (verified) {
      this.#remember(publicationKey, verified);
      return verified;
    }
    // This record is publishing it; that publication settles the lookup, and
    // finds the association if another path published it first.
    if (this.#queued.has(publicationKey) || this.#inFlight.has(publicationKey)) {
      return undefined;
    }
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
    if (retained) this.#remember(publicationKey, retained);
    return retained;
  }

  /**
   * Publishes the newest candidates within the budget, waiting no longer
   * than its time; the rest, including one still running at the deadline,
   * continue in the background. Resolves whether an image was published
   * within the budget. A reader's cancellation only ends its wait.
   */
  async publish(
    candidates: readonly ClaudeViewedImageCandidate[],
    budget: ClaudeViewedImagePublicationBudget = CLAUDE_VIEWED_IMAGE_INLINE_BUDGET,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const publishable = this.#publishable(candidates);
    if (publishable.length === 0 || this.closed || signal?.aborted) {
      this.schedule(publishable);
      return false;
    }
    const inline = publishable.slice(-budget.maximumImages);
    for (const { publicationKey } of inline) {
      this.#awaited.set(publicationKey, (this.#awaited.get(publicationKey) ?? 0) + 1);
    }
    let published = false;
    const attempts = inline.map((candidate) => this.#attempt(candidate).then((success) => {
      if (success && this.#awaited.has(candidate.publicationKey)) published = true;
    }));
    this.schedule(publishable.slice(0, publishable.length - inline.length));
    const stop = new AbortController();
    const stopped = AbortSignal.any([stop.signal, this.#controller.signal, ...(signal ? [signal] : [])]);
    const timer = setTimeout(() => stop.abort(), budget.timeoutMs);
    try {
      await Promise.race([Promise.all(attempts), aborted(stopped)]);
    } finally {
      clearTimeout(timer);
      stop.abort();
      for (const { publicationKey } of inline) {
        const waiting = (this.#awaited.get(publicationKey) ?? 1) - 1;
        if (waiting > 0) this.#awaited.set(publicationKey, waiting);
        else this.#awaited.delete(publicationKey);
      }
    }
    return published && !this.closed;
  }

  /** Publishes candidates in the background, newest first, a few at a time. */
  schedule(candidates: readonly ClaudeViewedImageCandidate[]): void {
    if (this.closed) return;
    for (const candidate of this.#publishable(candidates).reverse()) {
      if (this.#queued.size >= MAXIMUM_QUEUED_PUBLICATIONS) break;
      if (!this.#queued.has(candidate.publicationKey)) this.#queued.set(candidate.publicationKey, candidate);
    }
    this.#pump();
  }

  /** Resolves once nothing is queued or publishing. */
  async idle(): Promise<void> {
    if (this.#queued.size === 0 && this.#inFlight.size === 0) return;
    if (!this.#idle) {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => { resolve = done; });
      this.#idle = { promise, resolve };
    }
    await this.#idle.promise;
  }

  /** Stops publication between images; a running store completes unobserved. */
  close(): void {
    this.#controller.abort();
    this.#queued.clear();
    this.#settleIdle();
  }

  /** Neither published, known to have failed here, nor already publishing. */
  #publishable(
    candidates: readonly ClaudeViewedImageCandidate[],
  ): ClaudeViewedImageCandidate[] {
    const seen = new Set<string>();
    return candidates.filter(({ publicationKey }) => {
      if (seen.has(publicationKey)) return false;
      seen.add(publicationKey);
      return !this.#verified.has(publicationKey) && !this.#failed.has(publicationKey) &&
        !this.#inFlight.has(publicationKey);
    });
  }

  #pump(): void {
    while (!this.closed && this.#running < BACKGROUND_CONCURRENCY && this.#queued.size > 0) {
      const [publicationKey, candidate] = this.#queued.entries().next().value!;
      this.#queued.delete(publicationKey);
      this.#running += 1;
      void this.#attempt(candidate).finally(() => {
        this.#running -= 1;
        this.#pump();
        this.#settleIdle();
      });
    }
    this.#settleIdle();
  }

  #attempt(candidate: ClaudeViewedImageCandidate): Promise<boolean> {
    const { publicationKey } = candidate;
    const running = this.#inFlight.get(publicationKey);
    if (running) return running;
    this.#queued.delete(publicationKey);
    const attempt = this.#store(candidate).then((success) => {
      if (success && !this.closed && !this.#awaited.has(publicationKey)) {
        try {
          this.#onPublished(publicationKey);
        } catch {
          // A presentation failure does not undo the publication.
        }
      }
      return success;
    }).finally(() => {
      this.#inFlight.delete(publicationKey);
      this.#settleIdle();
    });
    this.#inFlight.set(publicationKey, attempt);
    return attempt;
  }

  async #store(candidate: ClaudeViewedImageCandidate): Promise<boolean> {
    // Yield first, so a reader's deadline is armed before any decoding.
    await Promise.resolve();
    if (this.closed) return false;
    const { publicationKey, image } = candidate;
    const bytes = decodeClaudeImageData(image.data);
    if (!bytes) {
      this.#rememberFailure(publicationKey);
      return false;
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
      this.#remember(publicationKey, descriptor);
      return true;
    } catch {
      this.#rememberFailure(publicationKey);
      return false;
    }
  }

  #remember(key: string, value: OutputImageArtifactDescriptor): void {
    this.#verified.delete(key);
    this.#verified.set(key, value);
    if (this.#verified.size > this.#maximumRemembered) {
      this.#verified.delete(this.#verified.keys().next().value!);
    }
  }

  #rememberFailure(key: string): void {
    this.#failed.delete(key);
    this.#failed.add(key);
    if (this.#failed.size > this.#maximumRemembered) {
      this.#failed.delete(this.#failed.values().next().value!);
    }
  }

  #settleIdle(): void {
    if (this.#idle && ((this.#queued.size === 0 && this.#inFlight.size === 0) || this.closed)) {
      this.#idle.resolve();
      this.#idle = undefined;
    }
  }
}

function aborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
