import { createHash } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";
import { Transform, Writable, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  COMPOSER_ATTACHMENT_LIMITS,
  MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_HEADER_BYTES,
  composerAttachmentDescriptorSchema,
  type ComposerAttachmentDescriptor,
} from "../../shared/protocol/composer-attachments.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { inspectSupportedRasterImage } from "../images/raster-image-inspector.js";
import { classifyWorkspaceFileBytes } from "../workspace-files/workspace-file-content-classifier.js";
import type { ComposerAttachmentBlob } from "./contracts.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_PREFIX_BYTES = MAXIMUM_COMPOSER_ATTACHMENT_IMAGE_HEADER_BYTES;
const MAXIMUM_CONCURRENT_UPLOADS_PER_SCOPE = 4;
const MAXIMUM_PROCESS_TEMPORARY_BYTES =
  COMPOSER_ATTACHMENT_LIMITS.maximumFileBytes * 4;

export class ComposerAttachmentStorageError extends Error {
  constructor(
    readonly code:
      | "attachment_too_large"
      | "attachment_upload_aborted"
      | "attachment_upload_busy"
      | "attachment_blob_corrupt"
      | "attachment_blob_missing",
    message: string,
  ) {
    super(message);
    this.name = "ComposerAttachmentStorageError";
  }
}

function scopeKey(scope: RequestScope): string {
  return createHash("sha256")
    .update(scope.tenantId)
    .update("\0")
    .update(scope.principalId)
    .digest("hex");
}

function assertDigest(digest: string): void {
  if (!DIGEST_PATTERN.test(digest))
    throw new Error("attachment_digest_invalid");
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, fileConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ComposerAttachmentBlobStore {
  readonly #root: string;
  readonly #temporaryRoot: string;
  readonly #blobRoot: string;
  readonly #activeByScope = new Map<string, number>();
  #temporaryBytes = 0;

  constructor(stateDirectory: string) {
    if (!path.isAbsolute(stateDirectory)) {
      throw new Error("attachment_state_directory_must_be_absolute");
    }
    this.#root = path.join(
      path.resolve(stateDirectory),
      "composer-attachments",
    );
    this.#temporaryRoot = path.join(this.#root, "tmp");
    this.#blobRoot = path.join(this.#root, "blobs");
  }

  async initialize(): Promise<void> {
    await mkdir(this.#temporaryRoot, { recursive: true, mode: 0o700 });
    await mkdir(this.#blobRoot, { recursive: true, mode: 0o700 });
    for (const directory of [this.#root, this.#temporaryRoot, this.#blobRoot]) {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new ComposerAttachmentStorageError(
          "attachment_blob_corrupt",
          "An attachment storage directory is not a private directory.",
        );
      }
      await chmod(directory, 0o700);
    }
    for (const entry of await readdir(this.#temporaryRoot)) {
      await rm(path.join(this.#temporaryRoot, entry), {
        recursive: true,
        force: true,
      });
    }
  }

  async receive(input: {
    scope: RequestScope;
    attachmentId: string;
    fileName: string;
    body: Readable;
    contentLength?: number;
  }): Promise<ComposerAttachmentBlob> {
    const key = scopeKey(input.scope);
    const active = this.#activeByScope.get(key) ?? 0;
    if (active >= MAXIMUM_CONCURRENT_UPLOADS_PER_SCOPE) {
      throw new ComposerAttachmentStorageError(
        "attachment_upload_busy",
        "Too many attachment uploads are already in progress.",
      );
    }
    if (
      input.contentLength !== undefined &&
      input.contentLength > COMPOSER_ATTACHMENT_LIMITS.maximumFileBytes
    ) {
      throw new ComposerAttachmentStorageError(
        "attachment_too_large",
        "The attachment exceeded the file size limit.",
      );
    }
    this.#activeByScope.set(key, active + 1);
    const temporaryPath = path.join(
      this.#temporaryRoot,
      `${input.attachmentId}.${crypto.randomUUID()}.upload`,
    );
    const handle = await open(
      temporaryPath,
      fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY,
      0o600,
    );
    const hash = createHash("sha256");
    const prefix: Buffer[] = [];
    let prefixBytes = 0;
    let byteSize = 0;
    let accountedBytes = 0;
    let writeOffset = 0;
    const meter = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        byteSize += chunk.byteLength;
        accountedBytes += chunk.byteLength;
        this.#temporaryBytes += chunk.byteLength;
        if (
          byteSize > COMPOSER_ATTACHMENT_LIMITS.maximumFileBytes ||
          this.#temporaryBytes > MAXIMUM_PROCESS_TEMPORARY_BYTES
        ) {
          callback(
            new ComposerAttachmentStorageError(
              "attachment_too_large",
              "The attachment exceeded the upload limit.",
            ),
          );
          return;
        }
        hash.update(chunk);
        if (prefixBytes < MAXIMUM_PREFIX_BYTES) {
          const retained = chunk.subarray(
            0,
            Math.min(chunk.byteLength, MAXIMUM_PREFIX_BYTES - prefixBytes),
          );
          prefix.push(Buffer.from(retained));
          prefixBytes += retained.byteLength;
        }
        callback(null, chunk);
      },
    });
    const destination = new Writable({
      write: (chunk: Buffer, _encoding, callback) => {
        const writeRemaining = async (): Promise<void> => {
          let offset = 0;
          while (offset < chunk.byteLength) {
            const { bytesWritten } = await handle.write(
              chunk,
              offset,
              chunk.byteLength - offset,
              writeOffset + offset,
            );
            if (bytesWritten <= 0) throw new Error("attachment_write_stalled");
            offset += bytesWritten;
          }
          writeOffset += chunk.byteLength;
        };
        void writeRemaining().then(() => callback(), callback);
      },
    });
    try {
      await pipeline(input.body, meter, destination);
      if (
        input.contentLength !== undefined &&
        byteSize !== input.contentLength
      ) {
        throw new ComposerAttachmentStorageError(
          "attachment_upload_aborted",
          "The attachment body ended before its declared length.",
        );
      }
      await handle.sync();
      await handle.chmod(0o400);
      const digest = hash.digest("hex");
      const classified = this.#descriptor(
        input.attachmentId,
        input.fileName,
        Buffer.concat(prefix, prefixBytes),
        byteSize,
      );
      const descriptor = composerAttachmentDescriptorSchema.parse(
        classified.descriptor,
      );
      await this.#publish(input.scope, digest, byteSize, temporaryPath);
      return { digest, byteSize, descriptor, ...classified.dimensions };
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      if (error instanceof ComposerAttachmentStorageError) throw error;
      const streamCode = (error as NodeJS.ErrnoException | undefined)?.code;
      if (
        input.body.readableAborted ||
        (error instanceof Error && error.name === "AbortError") ||
        streamCode === "ECONNRESET" ||
        streamCode === "EPIPE"
      ) {
        throw new ComposerAttachmentStorageError(
          "attachment_upload_aborted",
          "The attachment upload was interrupted.",
        );
      }
      throw error;
    } finally {
      await handle.close().catch(() => undefined);
      this.#temporaryBytes -= accountedBytes;
      if (active === 0) this.#activeByScope.delete(key);
      else this.#activeByScope.set(key, active);
    }
  }

  async open(
    scope: RequestScope,
    digest: string,
    expectedBytes: number,
  ): Promise<FileHandle> {
    const blobPath = this.#blobPath(scope, digest);
    const handle = await open(
      blobPath,
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    ).catch(() => {
      throw new ComposerAttachmentStorageError(
        "attachment_blob_missing",
        "The attachment content is unavailable.",
      );
    });
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== expectedBytes) {
        throw new ComposerAttachmentStorageError(
          "attachment_blob_corrupt",
          "The attachment content failed its integrity check.",
        );
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1_024);
      let offset = 0;
      while (offset < expectedBytes) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, expectedBytes - offset),
          offset,
        );
        if (bytesRead <= 0) {
          throw new ComposerAttachmentStorageError(
            "attachment_blob_corrupt",
            "The attachment content ended during integrity verification.",
          );
        }
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (hash.digest("hex") !== digest) {
        throw new ComposerAttachmentStorageError(
          "attachment_blob_corrupt",
          "The attachment content digest no longer matches its identity.",
        );
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async remove(scope: RequestScope, digest: string): Promise<void> {
    const blobPath = this.#blobPath(scope, digest);
    await unlink(blobPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async reconcile(
    retained: readonly Readonly<{
      scope: RequestScope;
      digest: string;
      byteSize: number;
    }>[],
  ): Promise<void> {
    const expected = new Map(
      retained.map((blob) => [`${scopeKey(blob.scope)}\0${blob.digest}`, blob]),
    );
    for (const blob of retained) {
      const metadata = await lstat(
        this.#blobPath(blob.scope, blob.digest),
      ).catch(() => undefined);
      if (
        !metadata?.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size !== blob.byteSize
      ) {
        throw new ComposerAttachmentStorageError(
          "attachment_blob_corrupt",
          "A retained attachment blob failed startup verification.",
        );
      }
      const handle = await this.open(blob.scope, blob.digest, blob.byteSize);
      await handle.close();
    }
    for (const scopeEntry of await readdir(this.#blobRoot, {
      withFileTypes: true,
    })) {
      if (!scopeEntry.isDirectory() || !DIGEST_PATTERN.test(scopeEntry.name)) {
        throw new ComposerAttachmentStorageError(
          "attachment_blob_corrupt",
          "The attachment blob directory contains an invalid entry.",
        );
      }
      const scopeDirectory = path.join(this.#blobRoot, scopeEntry.name);
      for (const prefixEntry of await readdir(scopeDirectory, {
        withFileTypes: true,
      })) {
        if (
          !prefixEntry.isDirectory() ||
          !/^[0-9a-f]{2}$/u.test(prefixEntry.name)
        ) {
          throw new ComposerAttachmentStorageError(
            "attachment_blob_corrupt",
            "The attachment blob directory contains an invalid prefix.",
          );
        }
        const prefixDirectory = path.join(scopeDirectory, prefixEntry.name);
        for (const entry of await readdir(prefixDirectory, {
          withFileTypes: true,
        })) {
          if (!entry.isFile() || !DIGEST_PATTERN.test(entry.name)) {
            throw new ComposerAttachmentStorageError(
              "attachment_blob_corrupt",
              "The attachment blob directory contains an invalid blob.",
            );
          }
          if (!expected.has(`${scopeEntry.name}\0${entry.name}`)) {
            await unlink(path.join(prefixDirectory, entry.name));
          }
        }
      }
    }
  }

  #descriptor(
    attachmentId: string,
    fileName: string,
    prefix: Uint8Array,
    byteSize: number,
  ): Readonly<{
    descriptor: ComposerAttachmentDescriptor;
    dimensions?: Readonly<{ imageWidth: number; imageHeight: number }>;
  }> {
    const classification = classifyWorkspaceFileBytes({
      relativePath: fileName.replaceAll("\\", "/"),
      bytes: prefix,
      truncated: byteSize > prefix.byteLength,
    });
    const inspection = inspectSupportedRasterImage(prefix);
    if (
      classification.kind === "image" &&
      inspection?.mediaType === classification.mediaType &&
      byteSize <= COMPOSER_ATTACHMENT_LIMITS.maximumImageBytes
    ) {
      return {
        descriptor: {
          id: attachmentId,
          fileName,
          kind: "image",
          mediaType: classification.mediaType,
          byteSize,
        },
        dimensions: {
          imageWidth: inspection.width,
          imageHeight: inspection.height,
        },
      };
    }
    return {
      descriptor: {
        id: attachmentId,
        fileName,
        kind: "file",
        mediaType: "application/octet-stream",
        byteSize,
      },
    };
  }

  async #publish(
    scope: RequestScope,
    digest: string,
    byteSize: number,
    temporaryPath: string,
  ): Promise<void> {
    const blobPath = this.#blobPath(scope, digest);
    const parent = path.dirname(blobPath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    for (const directory of [path.dirname(parent), parent]) {
      const metadata = await lstat(directory);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new ComposerAttachmentStorageError(
          "attachment_blob_corrupt",
          "An attachment blob path escaped its canonical directory.",
        );
      }
      await chmod(directory, 0o700);
    }
    try {
      await link(temporaryPath, blobPath);
      await syncDirectory(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const metadata = await lstat(blobPath);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size !== byteSize
      ) {
        throw new ComposerAttachmentStorageError(
          "attachment_blob_corrupt",
          "A canonical attachment blob conflicts with the uploaded content.",
        );
      }
      const existing = await this.open(scope, digest, byteSize);
      await existing.close();
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  #blobPath(scope: RequestScope, digest: string): string {
    assertDigest(digest);
    return path.join(
      this.#blobRoot,
      scopeKey(scope),
      digest.slice(0, 2),
      digest,
    );
  }
}
