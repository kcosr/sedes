import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_ATTACHMENT_LIMITS } from "../../src/shared/protocol/composer-attachments.js";
import { ComposerAttachmentBlobStore } from "../../src/server/composer-attachments/blob-store.js";
import {
  ComposerAttachmentService,
  sanitizeComposerAttachmentFileName,
} from "../../src/server/composer-attachments/service.js";
import type {
  ComposerAttachmentBlob,
  ComposerAttachmentPersistence,
} from "../../src/server/composer-attachments/contracts.js";
import type { RequestScope } from "../../src/server/identity/identity-provider.js";

const roots: string[] = [];
const scope = { tenantId: "tenant-a", principalId: "principal-a" };

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-attachments-"));
  roots.push(root);
  const store = new ComposerAttachmentBlobStore(root);
  await store.initialize();
  return { root, store };
}

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

async function onlyBlobPath(root: string): Promise<string> {
  const blobRoot = path.join(root, "composer-attachments", "blobs");
  const [scopeEntry] = await readdir(blobRoot);
  const [prefixEntry] = await readdir(path.join(blobRoot, scopeEntry!));
  const [blobEntry] = await readdir(
    path.join(blobRoot, scopeEntry!, prefixEntry!),
  );
  return path.join(blobRoot, scopeEntry!, prefixEntry!, blobEntry!);
}

describe("ComposerAttachmentBlobStore", () => {
  it("reduces untrusted display paths to one normalized safe basename", () => {
    expect(
      sanitizeComposerAttachmentFileName(
        `../../ignored\\e\u0301v\u0007i\u202Edence.PNG`,
      ),
    ).toBe("évidence.PNG");
    expect(sanitizeComposerAttachmentFileName("folder/ordinary.txt")).toBe(
      "ordinary.txt",
    );
    expect(sanitizeComposerAttachmentFileName("bad\ud800-name.txt")).toBe(
      "bad-name.txt",
    );
    expect(sanitizeComposerAttachmentFileName("📎.txt")).toBe("📎.txt");
    expect(() => sanitizeComposerAttachmentFileName("folder/")).toThrow(
      "safe basename",
    );
    expect(() => sanitizeComposerAttachmentFileName("../..")).toThrow(
      "safe basename",
    );
    expect(() => sanitizeComposerAttachmentFileName("\u0001\u007f")).toThrow(
      "safe basename",
    );
  });

  it("classifies and persists only the sanitized immutable basename", async () => {
    const { store } = await fixture();
    const recordUpload = vi.fn(
      (
        _currentScope: RequestScope,
        threadId: string,
        attachmentId: string,
        blob: ComposerAttachmentBlob,
        _now: number,
      ) => ({
        threadId,
        attachmentId,
        digest: blob.digest,
        descriptor: blob.descriptor,
      }),
    );
    const persistence: ComposerAttachmentPersistence = {
      recordUpload,
      findLiveOwner: () => undefined,
      listRetainedBlobs: () => [],
      collectGarbage: () => [],
    };
    const service = new ComposerAttachmentService(store, persistence);
    const attachmentId = crypto.randomUUID();
    const descriptor = await service.upload({
      scope,
      threadId: crypto.randomUUID(),
      attachmentId,
      fileName: `C:\\discarded\\e\u0301v\u0007idence.png`,
      body: Readable.from(png(32, 24)),
    });

    expect(descriptor).toMatchObject({
      id: attachmentId,
      fileName: "évidence.png",
      kind: "image",
      mediaType: "image/png",
    });
    expect(recordUpload).toHaveBeenCalledOnce();
    expect(recordUpload.mock.calls[0]![3]).toMatchObject({
      descriptor: { fileName: "évidence.png", kind: "image" },
      imageWidth: 32,
      imageHeight: 24,
    });
  });

  it("streams, hashes, privately publishes, and deduplicates exact bytes", async () => {
    const { root, store } = await fixture();
    const bytes = Buffer.from("opaque binary\0payload");
    const first = await store.receive({
      scope,
      attachmentId: crypto.randomUUID(),
      fileName: "payload.bin",
      body: Readable.from([bytes.subarray(0, 4), bytes.subarray(4)]),
      contentLength: bytes.byteLength,
    });
    const second = await store.receive({
      scope,
      attachmentId: crypto.randomUUID(),
      fileName: "copy.bin",
      body: Readable.from(bytes),
      contentLength: bytes.byteLength,
    });

    expect(first.digest).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(second.digest).toBe(first.digest);
    expect(first.descriptor).toMatchObject({
      kind: "file",
      mediaType: "application/octet-stream",
      byteSize: bytes.byteLength,
    });
    const blobPath = await onlyBlobPath(root);
    expect(await readFile(blobPath)).toEqual(bytes);
    expect((await lstat(blobPath)).mode & 0o777).toBe(0o400);
    expect(
      await readdir(path.join(root, "composer-attachments", "tmp")),
    ).toEqual([]);
  });

  it("classifies only extension-and-signature images with safe dimensions", async () => {
    const { store } = await fixture();
    const image = await store.receive({
      scope,
      attachmentId: crypto.randomUUID(),
      fileName: "preview.PNG",
      body: Readable.from(png(320, 200)),
    });
    const spoof = await store.receive({
      scope,
      attachmentId: crypto.randomUUID(),
      fileName: "spoof.png",
      body: Readable.from(Buffer.from("not a png")),
    });
    const dangerousDimensions = await store.receive({
      scope,
      attachmentId: crypto.randomUUID(),
      fileName: "large.png",
      body: Readable.from(png(16_000, 16_000)),
    });

    expect(image.descriptor).toMatchObject({
      kind: "image",
      mediaType: "image/png",
      byteSize: 24,
    });
    expect(spoof.descriptor.kind).toBe("file");
    expect(dangerousDimensions.descriptor.kind).toBe("file");
  });

  it("rejects a declared oversize body before retaining temporary content", async () => {
    const { root, store } = await fixture();
    await expect(
      store.receive({
        scope,
        attachmentId: crypto.randomUUID(),
        fileName: "large.bin",
        body: Readable.from(Buffer.from("unused")),
        contentLength: COMPOSER_ATTACHMENT_LIMITS.maximumFileBytes + 1,
      }),
    ).rejects.toMatchObject({
      code: "attachment_too_large",
    });
    expect(
      await readdir(path.join(root, "composer-attachments", "tmp")),
    ).toEqual([]);
  });

  it("requires regular no-follow content with the persisted exact length", async () => {
    const { root, store } = await fixture();
    const bytes = Buffer.from("content");
    const blob = await store.receive({
      scope,
      attachmentId: crypto.randomUUID(),
      fileName: "content.bin",
      body: Readable.from(bytes),
    });
    const blobPath = await onlyBlobPath(root);
    await expect(
      store.open(scope, blob.digest, bytes.byteLength + 1),
    ).rejects.toMatchObject({ code: "attachment_blob_corrupt" });
    await chmod(blobPath, 0o600);
    await writeFile(blobPath, Buffer.from("changed"));
    await expect(
      store.open(scope, blob.digest, bytes.byteLength),
    ).rejects.toMatchObject({ code: "attachment_blob_corrupt" });
    await rm(blobPath);
    await symlink("/etc/passwd", blobPath);
    await expect(
      store.open(scope, blob.digest, bytes.byteLength),
    ).rejects.toMatchObject({ code: "attachment_blob_missing" });
  });

  it("clears interrupted temporary files and removes unretained canonical blobs", async () => {
    const { root, store } = await fixture();
    const blob = await store.receive({
      scope,
      attachmentId: crypto.randomUUID(),
      fileName: "orphan.bin",
      body: Readable.from(Buffer.from("orphan")),
    });
    await store.reconcile([]);
    await expect(
      store.open(scope, blob.digest, blob.byteSize),
    ).rejects.toMatchObject({ code: "attachment_blob_missing" });

    const tmp = path.join(root, "composer-attachments", "tmp", "partial");
    await writeFile(tmp, "x");
    await store.initialize();
    expect(await readdir(path.dirname(tmp))).toEqual([]);
  });
});
