import { createHash, randomUUID } from "node:crypto";
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
} from "node:fs/promises";
import path from "node:path";
import type { RequestScope } from "../identity/identity-provider.js";
import {
  MAXIMUM_OUTPUT_IMAGE_BYTES,
  type RetainedOutputImageBlob,
} from "./contracts.js";

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export class OutputArtifactStorageError extends Error {
  constructor(
    readonly code:
      "artifact_too_large" | "artifact_blob_missing" | "artifact_blob_corrupt",
    message: string,
  ) {
    super(message);
    this.name = "OutputArtifactStorageError";
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
  if (!DIGEST_PATTERN.test(digest)) {
    throw new OutputArtifactStorageError(
      "artifact_blob_corrupt",
      "The output artifact digest is invalid.",
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const descriptor = await open(directory, fileConstants.O_RDONLY);
  try {
    await descriptor.sync();
  } finally {
    await descriptor.close();
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new OutputArtifactStorageError(
      "artifact_blob_corrupt",
      "An output artifact storage directory is invalid.",
    );
  }
  await chmod(directory, 0o700);
  // Even an EEXIST observer may have raced the creator before its parent
  // directory fsync. Syncing unconditionally prevents a blob/DB commit from
  // outrunning durability of a newly created scope or digest-prefix entry.
  await syncDirectory(path.dirname(directory));
}

export class OutputArtifactBlobStore {
  readonly #root: string;
  readonly #temporaryRoot: string;
  readonly #blobRoot: string;
  readonly #publications = new Map<string, Promise<void>>();

  constructor(stateDirectory: string) {
    if (!path.isAbsolute(stateDirectory)) {
      throw new Error("output_artifact_state_directory_must_be_absolute");
    }
    this.#root = path.join(path.resolve(stateDirectory), "output-artifacts");
    this.#temporaryRoot = path.join(this.#root, "tmp");
    this.#blobRoot = path.join(this.#root, "blobs");
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.#root);
    await ensurePrivateDirectory(this.#temporaryRoot);
    await ensurePrivateDirectory(this.#blobRoot);
    for (const entry of await readdir(this.#temporaryRoot)) {
      await rm(path.join(this.#temporaryRoot, entry), {
        recursive: true,
        force: true,
      });
    }
  }

  async publish(
    scope: RequestScope,
    digest: string,
    bytes: Uint8Array,
  ): Promise<void> {
    assertDigest(digest);
    if (
      bytes.byteLength <= 0 ||
      bytes.byteLength > MAXIMUM_OUTPUT_IMAGE_BYTES
    ) {
      throw new OutputArtifactStorageError(
        "artifact_too_large",
        "The output image exceeds the supported byte limit.",
      );
    }
    const key = `${scopeKey(scope)}\0${digest}`;
    const active = this.#publications.get(key);
    if (active) return await active;
    const publication = this.#publish(scope, digest, bytes);
    this.#publications.set(key, publication);
    try {
      await publication;
    } finally {
      if (this.#publications.get(key) === publication) {
        this.#publications.delete(key);
      }
    }
  }

  async #publish(
    scope: RequestScope,
    digest: string,
    bytes: Uint8Array,
  ): Promise<void> {
    const blobPath = this.#blobPath(scope, digest);
    try {
      await this.#verify(scope, digest, bytes.byteLength);
      return;
    } catch (error) {
      if (
        !(error instanceof OutputArtifactStorageError) ||
        error.code !== "artifact_blob_missing"
      ) {
        throw error;
      }
    }

    const parent = path.dirname(blobPath);
    await ensurePrivateDirectory(path.dirname(parent));
    await ensurePrivateDirectory(parent);

    const temporaryPath = path.join(
      this.#temporaryRoot,
      `${randomUUID()}.artifact`,
    );
    const descriptor = await open(
      temporaryPath,
      fileConstants.O_CREAT | fileConstants.O_EXCL | fileConstants.O_WRONLY,
      0o600,
    );
    try {
      let offset = 0;
      while (offset < bytes.byteLength) {
        const { bytesWritten } = await descriptor.write(
          bytes,
          offset,
          bytes.byteLength - offset,
          offset,
        );
        if (bytesWritten <= 0) throw new Error("output_artifact_write_stalled");
        offset += bytesWritten;
      }
      await descriptor.sync();
      await descriptor.chmod(0o400);
      try {
        await link(temporaryPath, blobPath);
        await syncDirectory(parent);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.#verify(scope, digest, bytes.byteLength);
      }
    } finally {
      await descriptor.close();
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  async open(scope: RequestScope, digest: string, byteSize: number) {
    assertDigest(digest);
    const handle = await open(
      this.#blobPath(scope, digest),
      fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
    ).catch(() => {
      throw new OutputArtifactStorageError(
        "artifact_blob_missing",
        "The output artifact content is unavailable.",
      );
    });
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== byteSize) {
        throw new OutputArtifactStorageError(
          "artifact_blob_corrupt",
          "The output artifact content failed its integrity check.",
        );
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1_024);
      let offset = 0;
      while (offset < byteSize) {
        const { bytesRead } = await handle.read(
          buffer,
          0,
          Math.min(buffer.byteLength, byteSize - offset),
          offset,
        );
        if (bytesRead <= 0) {
          throw new OutputArtifactStorageError(
            "artifact_blob_corrupt",
            "The output artifact ended during integrity verification.",
          );
        }
        hash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (hash.digest("hex") !== digest) {
        throw new OutputArtifactStorageError(
          "artifact_blob_corrupt",
          "The output artifact digest no longer matches its identity.",
        );
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async remove(scope: RequestScope, digest: string): Promise<void> {
    try {
      await unlink(this.#blobPath(scope, digest));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async reconcile(retained: readonly RetainedOutputImageBlob[]): Promise<void> {
    const expected = new Map(
      retained.map((blob) => [`${scopeKey(blob.scope)}\0${blob.sha256}`, blob]),
    );
    for (const blob of retained) {
      await this.#verify(blob.scope, blob.sha256, blob.byteSize);
    }
    for (const scopeEntry of await readdir(this.#blobRoot, {
      withFileTypes: true,
    })) {
      if (!scopeEntry.isDirectory() || !DIGEST_PATTERN.test(scopeEntry.name)) {
        throw new OutputArtifactStorageError(
          "artifact_blob_corrupt",
          "The output artifact blob directory contains an invalid entry.",
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
          throw new OutputArtifactStorageError(
            "artifact_blob_corrupt",
            "The output artifact blob directory contains an invalid prefix.",
          );
        }
        const prefixDirectory = path.join(scopeDirectory, prefixEntry.name);
        for (const entry of await readdir(prefixDirectory, {
          withFileTypes: true,
        })) {
          if (!entry.isFile() || !DIGEST_PATTERN.test(entry.name)) {
            throw new OutputArtifactStorageError(
              "artifact_blob_corrupt",
              "The output artifact blob directory contains an invalid blob.",
            );
          }
          if (!expected.has(`${scopeEntry.name}\0${entry.name}`)) {
            await unlink(path.join(prefixDirectory, entry.name));
          }
        }
      }
    }
  }

  async #verify(
    scope: RequestScope,
    digest: string,
    byteSize: number,
  ): Promise<void> {
    assertDigest(digest);
    const blobPath = this.#blobPath(scope, digest);
    let descriptor;
    try {
      descriptor = await open(
        blobPath,
        fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW,
      );
    } catch {
      throw new OutputArtifactStorageError(
        "artifact_blob_missing",
        "The output artifact content is unavailable.",
      );
    }
    try {
      const metadata = await descriptor.stat();
      if (!metadata.isFile() || metadata.size !== byteSize) {
        throw new OutputArtifactStorageError(
          "artifact_blob_corrupt",
          "The output artifact content failed its integrity check.",
        );
      }
      const syncHash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1_024);
      let offset = 0;
      while (offset < byteSize) {
        const { bytesRead } = await descriptor.read(
          buffer,
          0,
          Math.min(buffer.byteLength, byteSize - offset),
          offset,
        );
        if (bytesRead <= 0) {
          throw new OutputArtifactStorageError(
            "artifact_blob_corrupt",
            "The output artifact ended during integrity verification.",
          );
        }
        syncHash.update(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
      if (syncHash.digest("hex") !== digest) {
        throw new OutputArtifactStorageError(
          "artifact_blob_corrupt",
          "The output artifact digest no longer matches its identity.",
        );
      }
    } finally {
      await descriptor.close();
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
