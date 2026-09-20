import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { MAXIMUM_COMPOSER_ATTACHMENT_STAGING_CHUNK_BYTES } from "../../shared/composer-attachment-staging-limits.js";
import { MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES } from "../../shared/protocol/composer-attachments.js";
import { windowsStagingPrivacy } from "./windows-staging-privacy.js";

export const COMPOSER_ATTACHMENT_CHUNK_BYTES =
  MAXIMUM_COMPOSER_ATTACHMENT_STAGING_CHUNK_BYTES;
const MAXIMUM_ACTIVE_UPLOADS = 16;
const MAXIMUM_INCOMPLETE_BYTES = 128 * 1_024 * 1_024;
const MANIFEST_FILE = "manifest.json";

export interface ExecutionAttachmentStagingIdentity {
  readonly scopeKey: string;
  readonly threadId: string;
  readonly attachmentId: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly extension: string;
}

export type ExecutionAttachmentStagingOpenResult =
  | {
      readonly state: "ready";
      readonly agentPath: string;
      readonly sha256: string;
      readonly sizeBytes: number;
    }
  | {
      readonly state: "upload";
      readonly uploadHandle: string;
      readonly nextOffset: number;
    };

interface ActiveUpload {
  readonly admissionId: string;
  readonly uploadHandle: string;
  readonly identity: ExecutionAttachmentStagingIdentity;
  readonly directory: string;
  readonly contentPath: string;
  readonly file: Awaited<ReturnType<typeof open>>;
  readonly hash: ReturnType<typeof createHash>;
  offset: number;
  closed: boolean;
}

interface StagingManifest extends ExecutionAttachmentStagingIdentity {
  readonly schemaVersion: 1;
}

export class ExecutionAttachmentStagingError extends Error {
  constructor(
    readonly code:
      | "composer_attachment_staging_invalid"
      | "composer_attachment_staging_conflict"
      | "composer_attachment_staging_capacity"
      | "composer_attachment_upload_invalid"
      | "composer_attachment_upload_offset_conflict"
      | "composer_attachment_upload_digest_mismatch"
      | "composer_attachment_upload_size_mismatch",
  ) {
    super(code);
    this.name = "ExecutionAttachmentStagingError";
  }
}

/**
 * Exact-path, non-executable attachment materialization shared by the local
 * provider and the managed sidecar. It accepts no caller-selected directory.
 */
export class ExecutionAttachmentStagingEngine {
  readonly #baseDirectory: string;
  readonly #sessionNonce: string;
  readonly #captureAdmission: () => () => void;
  readonly #uploads = new Map<string, ActiveUpload>();
  readonly #admissions = new Map<string, string>();
  #incompleteBytes = 0;
  #closed = false;

  constructor(input: {
    readonly baseDirectory: string;
    readonly sessionNonce: string;
    readonly captureAdmission?: () => () => void;
  }) {
    if (
      !path.isAbsolute(input.baseDirectory) ||
      input.sessionNonce.length < 32 ||
      input.sessionNonce.length > 160 ||
      !/^[A-Za-z0-9_-]+$/u.test(input.sessionNonce)
    ) {
      throw new Error("composer_attachment_staging_configuration_invalid");
    }
    this.#baseDirectory = path.resolve(input.baseDirectory);
    this.#sessionNonce = input.sessionNonce;
    this.#captureAdmission = input.captureAdmission ?? (() => () => undefined);
  }

  async open(
    admissionId: string,
    identity: ExecutionAttachmentStagingIdentity,
  ): Promise<ExecutionAttachmentStagingOpenResult> {
    const assertAdmission = this.#captureAdmission();
    assertAdmission();
    this.#assertOpen();
    validateAdmissionId(admissionId);
    validateIdentity(identity);
    await this.#ensureRoot(assertAdmission);
    // Validate every derived parent before looking through it. In particular,
    // never follow a caller-created symlink while reconciling an old result.
    await this.#ensureDirectory(this.#attachmentParent(identity), assertAdmission);

    const ready = await this.#ready(identity, true, assertAdmission);
    if (ready) return ready;

    const existingHandle = this.#admissions.get(admissionId);
    if (existingHandle) {
      const existing = this.#uploads.get(existingHandle);
      if (!existing || !sameIdentity(existing.identity, identity)) {
        throw new ExecutionAttachmentStagingError(
          "composer_attachment_staging_conflict",
        );
      }
      if (!existing.closed) {
        return {
          state: "upload",
          uploadHandle: existing.uploadHandle,
          nextOffset: existing.offset,
        };
      }
      // A revoked commit may have prepared private files without publishing.
      // Reopening the same admission restarts only that unpublished upload.
      await this.#abort(existing.uploadHandle, assertAdmission);
    }
    if (
      this.#uploads.size >= MAXIMUM_ACTIVE_UPLOADS ||
      this.#incompleteBytes + identity.sizeBytes > MAXIMUM_INCOMPLETE_BYTES
    ) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_capacity",
      );
    }

    const incoming = await this.#ensureDirectory(
      path.join(this.#baseDirectory, "v1", "incoming", this.#sessionNonce),
      assertAdmission,
    );
    assertAdmission();
    const uploadHandle = randomUUID();
    const directory = path.join(incoming, uploadHandle);
    const contentPath = path.join(directory, "content.part");
    let file: Awaited<ReturnType<typeof open>>;
    try {
      if (process.platform === "win32") {
        await ensurePrivateDirectory(directory, undefined, assertAdmission);
      } else {
        await mkdir(directory, { mode: 0o700 });
        await assertPrivateDirectory(directory);
      }
      assertAdmission();
      file = await open(
        contentPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        assertAdmission();
      } catch (error) {
        await file.close();
        throw error;
      }
    } catch (error) {
      // Preparation belongs to this request until the upload is registered.
      // Cleanup must remain possible after its controller loses authority.
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    const upload: ActiveUpload = {
      admissionId,
      uploadHandle,
      identity: Object.freeze({ ...identity }),
      directory,
      contentPath,
      file,
      hash: createHash("sha256"),
      offset: 0,
      closed: false,
    };
    this.#uploads.set(uploadHandle, upload);
    this.#admissions.set(admissionId, uploadHandle);
    this.#incompleteBytes += identity.sizeBytes;
    return { state: "upload", uploadHandle, nextOffset: 0 };
  }

  async append(input: {
    readonly uploadHandle: string;
    readonly offset: number;
    readonly content: Uint8Array;
    readonly chunkSha256: string;
  }): Promise<{ readonly nextOffset: number }> {
    const assertAdmission = this.#captureAdmission();
    assertAdmission();
    this.#assertOpen();
    const upload = this.#upload(input.uploadHandle);
    if (
      !Number.isSafeInteger(input.offset) ||
      input.offset < 0 ||
      input.offset !== upload.offset
    ) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_upload_offset_conflict",
      );
    }
    if (
      input.content.byteLength === 0 ||
      input.content.byteLength > COMPOSER_ATTACHMENT_CHUNK_BYTES ||
      upload.offset + input.content.byteLength > upload.identity.sizeBytes ||
      !isSha256(input.chunkSha256)
    ) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_upload_invalid",
      );
    }
    const digest = createHash("sha256").update(input.content).digest("hex");
    if (digest !== input.chunkSha256) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_upload_digest_mismatch",
      );
    }
    assertAdmission();
    const result = await upload.file.write(
      input.content,
      0,
      input.content.byteLength,
      upload.offset,
    );
    if (result.bytesWritten !== input.content.byteLength) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_upload_size_mismatch",
      );
    }
    upload.hash.update(input.content);
    upload.offset += input.content.byteLength;
    return { nextOffset: upload.offset };
  }

  async commit(uploadHandle: string): Promise<{
    readonly agentPath: string;
    readonly sha256: string;
    readonly sizeBytes: number;
  }> {
    const assertAdmission = this.#captureAdmission();
    assertAdmission();
    this.#assertOpen();
    const upload = this.#upload(uploadHandle);
    if (upload.offset !== upload.identity.sizeBytes) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_upload_size_mismatch",
      );
    }
    if (upload.hash.copy().digest("hex") !== upload.identity.sha256) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_upload_digest_mismatch",
      );
    }
    assertAdmission();
    await upload.file.sync();
    await upload.file.close();
    upload.closed = true;
    const stagedContentPath = path.join(
      upload.directory,
      `${upload.identity.attachmentId}${upload.identity.extension}`,
    );
    assertAdmission();
    await rename(upload.contentPath, stagedContentPath);
    assertAdmission();
    await sealFile(stagedContentPath);
    const manifest: StagingManifest = {
      schemaVersion: 1,
      ...upload.identity,
    };
    const manifestPath = path.join(upload.directory, MANIFEST_FILE);
    assertAdmission();
    const manifestFile = await open(
      manifestPath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      assertAdmission();
      await manifestFile.writeFile(`${JSON.stringify(manifest)}\n`, "utf8");
      assertAdmission();
      await manifestFile.sync();
    } finally {
      await manifestFile.close();
    }
    assertAdmission();
    await sealFile(manifestPath);
    await syncDirectory(upload.directory);

    const finalParent = await this.#ensureDirectory(
      this.#attachmentParent(upload.identity),
      assertAdmission,
    );
    const finalDirectory = path.join(finalParent, upload.identity.attachmentId);
    try {
      assertAdmission();
      await rename(upload.directory, finalDirectory);
      await syncDirectory(finalParent);
    } catch (error) {
      if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOTEMPTY")) {
        throw error;
      }
      const ready = await this.#ready(upload.identity);
      if (!ready) {
        throw new ExecutionAttachmentStagingError(
          "composer_attachment_staging_conflict",
        );
      }
      await rm(upload.directory, { recursive: true, force: true });
    }
    this.#forget(upload);
    const ready = await this.#ready(upload.identity);
    if (!ready) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_invalid",
      );
    }
    return {
      agentPath: ready.agentPath,
      sha256: ready.sha256,
      sizeBytes: ready.sizeBytes,
    };
  }

  async abort(uploadHandle: string): Promise<{ readonly aborted: true }> {
    const assertAdmission = this.#captureAdmission();
    assertAdmission();
    return this.#abort(uploadHandle, assertAdmission);
  }

  async #abort(
    uploadHandle: string,
    assertAdmission: () => void = () => undefined,
  ): Promise<{ readonly aborted: true }> {
    const upload = this.#uploads.get(uploadHandle);
    if (!upload) return { aborted: true };
    if (!upload.closed) {
      await upload.file.close().catch(() => undefined);
      upload.closed = true;
    }
    assertAdmission();
    await rm(upload.directory, { recursive: true, force: true });
    this.#forget(upload);
    return { aborted: true };
  }

  async release(
    identity: Pick<
      ExecutionAttachmentStagingIdentity,
      "scopeKey" | "threadId" | "attachmentId" | "sha256"
    >,
  ): Promise<{ readonly released: true }> {
    const assertAdmission = this.#captureAdmission();
    assertAdmission();
    this.#assertOpen();
    validateReleaseIdentity(identity);
    await this.#ensureRoot(assertAdmission);
    const finalDirectory = path.join(
      this.#baseDirectory,
      "v1",
      "principals",
      identity.scopeKey,
      "threads",
      identity.threadId,
      "attachments",
      identity.attachmentId,
    );
    const manifest = await readManifest(finalDirectory);
    if (!manifest) return { released: true };
    if (manifest.sha256 !== identity.sha256) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_conflict",
      );
    }
    assertAdmission();
    await rm(finalDirectory, { recursive: true, force: true });
    return { released: true };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.all(
      [...this.#uploads.keys()].map((handle) => this.#abort(handle)),
    );
    const sessionDirectory = path.join(
      this.#baseDirectory,
      "v1",
      "incoming",
      this.#sessionNonce,
    );
    await rm(sessionDirectory, { recursive: true, force: true });
  }

  async #ready(
    identity: ExecutionAttachmentStagingIdentity,
    repairCorruptPayload = false,
    assertAdmission: () => void = () => undefined,
  ): Promise<
    | Extract<ExecutionAttachmentStagingOpenResult, { state: "ready" }>
    | undefined
  > {
    const directory = path.join(
      this.#attachmentParent(identity),
      identity.attachmentId,
    );
    const manifest = await readManifest(directory);
    if (!manifest) return undefined;
    if (!sameIdentity(manifest, identity)) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_conflict",
      );
    }
    const agentPath = path.join(
      directory,
      `${identity.attachmentId}${identity.extension}`,
    );
    const content = await lstat(agentPath).catch(() => undefined);
    const payloadIsValid =
      content !== undefined &&
      content.isFile() &&
      !content.isSymbolicLink() &&
      content.size === identity.sizeBytes &&
      (await isPrivateReadonlyFile(agentPath, content.mode)) &&
      (await hashFile(agentPath)) === identity.sha256;
    if (!payloadIsValid) {
      if (repairCorruptPayload) {
        await this.#quarantineCorruptPayload(directory, identity, assertAdmission);
        return undefined;
      }
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_conflict",
      );
    }
    return {
      state: "ready",
      agentPath,
      sha256: identity.sha256,
      sizeBytes: identity.sizeBytes,
    };
  }

  async #quarantineCorruptPayload(
    directory: string,
    identity: ExecutionAttachmentStagingIdentity,
    assertAdmission: () => void,
  ): Promise<void> {
    const parent = path.dirname(directory);
    const quarantine = path.join(
      parent,
      `.corrupt-${identity.attachmentId}-${randomUUID()}`,
    );
    try {
      // Renaming the exact derived directory is atomic and moves a raced-in
      // symlink itself; it never follows that symlink to delete its target.
      assertAdmission();
      await rename(directory, quarantine);
    } catch (error) {
      if (hasCode(error, "ENOENT")) return;
      throw error;
    }

    try {
      const quarantinedManifest = await readManifest(quarantine);
      if (
        !quarantinedManifest ||
        !sameIdentity(quarantinedManifest, identity)
      ) {
        throw new ExecutionAttachmentStagingError(
          "composer_attachment_staging_conflict",
        );
      }
      assertAdmission();
    } catch (error) {
      // A same-uid process may have raced the initial verification. Preserve
      // anything whose identity is no longer the exact one authorized here.
      await rename(quarantine, directory).catch(() => undefined);
      throw error;
    }
    await rm(quarantine, { recursive: true, force: true });
    await syncDirectory(parent);
  }

  #attachmentParent(identity: ExecutionAttachmentStagingIdentity): string {
    return path.join(
      this.#baseDirectory,
      "v1",
      "principals",
      identity.scopeKey,
      "threads",
      identity.threadId,
      "attachments",
    );
  }

  async #ensureRoot(assertAdmission: () => void): Promise<void> {
    assertAdmission();
    if (process.platform === "win32") {
      await ensurePrivateDirectory(this.#baseDirectory, undefined, assertAdmission);
    } else {
      await mkdir(this.#baseDirectory, { recursive: true, mode: 0o700 });
    }
    const canonical = await realpath(this.#baseDirectory);
    if (canonical !== this.#baseDirectory) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_invalid",
      );
    }
    if (process.platform !== "win32") {
      await ensurePrivateDirectory(this.#baseDirectory, undefined, assertAdmission);
    }
  }

  async #ensureDirectory(
    directory: string,
    assertAdmission: () => void,
  ): Promise<string> {
    assertAdmission();
    if (!isWithin(this.#baseDirectory, directory)) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_invalid",
      );
    }
    if (process.platform === "win32") {
      // One native operation checks and protects the complete derived chain.
      await ensurePrivateDirectory(directory, this.#baseDirectory, assertAdmission);
      return directory;
    }
    let current = this.#baseDirectory;
    for (const segment of path
      .relative(this.#baseDirectory, directory)
      .split(path.sep)) {
      if (!segment) continue;
      current = path.join(current, segment);
      let metadata = await lstat(current).catch((error) => {
        if (hasCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (!metadata) {
        await ensurePrivateDirectory(current, undefined, assertAdmission).catch((error) => {
          if (!hasCode(error, "EEXIST")) throw error;
        });
        metadata = await lstat(current);
      }
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (typeof process.geteuid === "function" &&
          metadata.uid !== process.geteuid())
      ) {
        throw new ExecutionAttachmentStagingError(
          "composer_attachment_staging_invalid",
        );
      }
      await ensurePrivateDirectory(current, undefined, assertAdmission);
    }
    return directory;
  }

  #upload(uploadHandle: string): ActiveUpload {
    const upload = this.#uploads.get(uploadHandle);
    if (!upload) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_upload_invalid",
      );
    }
    return upload;
  }

  #forget(upload: ActiveUpload): void {
    this.#uploads.delete(upload.uploadHandle);
    this.#admissions.delete(upload.admissionId);
    this.#incompleteBytes -= upload.identity.sizeBytes;
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_invalid",
      );
    }
  }
}

function validateIdentity(identity: ExecutionAttachmentStagingIdentity): void {
  if (
    !isSha256(identity.scopeKey) ||
    !isUuid(identity.threadId) ||
    !isUuid(identity.attachmentId) ||
    !isSha256(identity.sha256) ||
    !Number.isSafeInteger(identity.sizeBytes) ||
    identity.sizeBytes < 0 ||
    identity.sizeBytes > MAXIMUM_COMPOSER_ATTACHMENT_FILE_BYTES ||
    !/^(?:|\.[a-z0-9]{1,12})$/u.test(identity.extension)
  ) {
    throw new ExecutionAttachmentStagingError(
      "composer_attachment_staging_invalid",
    );
  }
}

function validateReleaseIdentity(
  identity: Pick<
    ExecutionAttachmentStagingIdentity,
    "scopeKey" | "threadId" | "attachmentId" | "sha256"
  >,
): void {
  if (
    !isSha256(identity.scopeKey) ||
    !isUuid(identity.threadId) ||
    !isUuid(identity.attachmentId) ||
    !isSha256(identity.sha256)
  ) {
    throw new ExecutionAttachmentStagingError(
      "composer_attachment_staging_invalid",
    );
  }
}

function validateAdmissionId(value: string): void {
  if (!isUuid(value)) {
    throw new ExecutionAttachmentStagingError(
      "composer_attachment_staging_invalid",
    );
  }
}

function sameIdentity(
  left: ExecutionAttachmentStagingIdentity,
  right: ExecutionAttachmentStagingIdentity,
): boolean {
  return (
    left.scopeKey === right.scopeKey &&
    left.threadId === right.threadId &&
    left.attachmentId === right.attachmentId &&
    left.sha256 === right.sha256 &&
    left.sizeBytes === right.sizeBytes &&
    left.extension === right.extension
  );
}

async function readManifest(
  directory: string,
): Promise<StagingManifest | undefined> {
  const directoryStat = await lstat(directory).catch(() => undefined);
  if (!directoryStat) return undefined;
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new ExecutionAttachmentStagingError(
      "composer_attachment_staging_conflict",
    );
  }
  await assertPrivateDirectory(directory);
  const manifestPath = path.join(directory, MANIFEST_FILE);
  const metadata = await lstat(manifestPath).catch(() => undefined);
  if (
    !metadata ||
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 2_048 ||
    !(await isPrivateReadonlyFile(manifestPath, metadata.mode))
  ) {
    throw new ExecutionAttachmentStagingError(
      "composer_attachment_staging_conflict",
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    throw new ExecutionAttachmentStagingError(
      "composer_attachment_staging_conflict",
    );
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "attachmentId,extension,schemaVersion,scopeKey,sha256,sizeBytes,threadId"
  ) {
    throw new ExecutionAttachmentStagingError(
      "composer_attachment_staging_conflict",
    );
  }
  const manifest = value as StagingManifest;
  if (manifest.schemaVersion !== 1) {
    throw new ExecutionAttachmentStagingError(
      "composer_attachment_staging_conflict",
    );
  }
  validateIdentity(manifest);
  return manifest;
}

async function hashFile(filename: string): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(COMPOSER_ATTACHMENT_CHUNK_BYTES);
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        buffer.byteLength,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await file.close();
  }
}

async function sealFile(filename: string): Promise<void> {
  if (process.platform === "win32") {
    try {
      await windowsStagingPrivacy(filename, "seal-file");
    } catch {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_invalid",
      );
    }
  } else {
    await chmod(filename, 0o400);
  }
}

async function isPrivateReadonlyFile(
  filename: string,
  mode: number,
): Promise<boolean> {
  if (process.platform !== "win32") return (mode & 0o777) === 0o400;
  try {
    await windowsStagingPrivacy(filename, "assert-readonly-file");
    return true;
  } catch {
    return false;
  }
}

async function ensurePrivateDirectory(
  directory: string,
  rootDirectory?: string,
  assertAdmission: () => void = () => undefined,
): Promise<void> {
  assertAdmission();
  if (process.platform === "win32") {
    try {
      await windowsStagingPrivacy(directory, "ensure-directory", { rootDirectory });
    } catch {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_invalid",
      );
    }
    return;
  }
  await mkdir(directory, { mode: 0o700 }).catch((error) => {
    if (!hasCode(error, "EEXIST")) throw error;
  });
  // Reject links and foreign ownership before chmod can follow the path.
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (typeof process.geteuid === "function" && metadata.uid !== process.geteuid())
  ) {
    throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_invalid",
      );
  }
  assertAdmission();
  await chmod(directory, 0o700);
  await assertPrivateDirectory(directory);
}

async function assertPrivateDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") {
    try {
      await windowsStagingPrivacy(directory, "assert-directory");
    } catch {
      throw new ExecutionAttachmentStagingError(
        "composer_attachment_staging_invalid",
      );
    }
    return;
  }
  const metadata = await lstat(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o700 ||
    (typeof process.geteuid === "function" &&
      metadata.uid !== process.geteuid())
  ) {
    throw new ExecutionAttachmentStagingError(
      "composer_attachment_staging_invalid",
    );
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(
    directory,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
