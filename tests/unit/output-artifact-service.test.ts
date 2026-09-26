import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OutputImageArtifactRepository } from "../../src/server/db/repositories/output-image-artifact-repository.js";
import { ConversationBindingRepository } from "../../src/server/db/repositories/conversation-binding-repository.js";
import { InventoryRepository } from "../../src/server/db/repositories/inventory-repository.js";
import { WorkspaceFileRootRepository } from "../../src/server/db/repositories/workspace-file-root-repository.js";
import { WorkspaceFileLinkedWorktreeRepository } from "../../src/server/db/repositories/workspace-file-linked-worktree-repository.js";
import { WorkspaceFileService } from "../../src/server/domain/workspace-file-service.js";
import { LocalExecutionEnvironment } from "../../src/server/execution/local-execution-environment.js";
import { LocalWorkspaceFileProvider } from "../../src/server/workspace-files/local-workspace-file-provider.js";
import { ViewedImageCaptureService } from "../../src/server/output-artifacts/viewed-image-capture.js";
import {
  OutputArtifactBlobStore,
  OutputArtifactStorageError,
} from "../../src/server/output-artifacts/blob-store.js";
import { OutputArtifactService } from "../../src/server/output-artifacts/service.js";
import { savedAgentDatabase } from "../support/saved-agent-fixture.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function png(marker = 0, width = 32, height = 24): Buffer {
  const bytes = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = marker;
  return bytes;
}

async function fixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "sedes-output-artifacts-"),
  );
  roots.push(root);
  const { database, scope } = savedAgentDatabase();
  const inventory = new InventoryRepository(database);
  const environment = inventory.getLocalEnvironment(scope);
  const workspace = inventory.upsertWorkspace(scope, {
    environmentId: environment.id,
    canonicalPath: root,
    displayName: "Output artifacts",
    available: true,
    trustState: "trusted",
    environmentConfigurationRevision: environment.configurationRevision,
    now: 10,
  });
  const profile = database
    .prepare(
      "SELECT id FROM agent_connection_profiles WHERE tenant_id = ? AND owner_principal_id = ? LIMIT 1",
    )
    .get(scope.tenantId, scope.principalId) as { id: string };
  const bindings = new ConversationBindingRepository(database);
  const firstThread = bindings.createUnboundThread(scope, {
    workspaceId: workspace.id,
    connectionProfileId: profile.id,
    title: "First",
    now: 20,
  });
  const secondThread = bindings.createUnboundThread(scope, {
    workspaceId: workspace.id,
    connectionProfileId: profile.id,
    title: "Second",
    now: 30,
  });
  const repository = new OutputImageArtifactRepository(database);
  const store = new OutputArtifactBlobStore(root);
  const service = new OutputArtifactService(store, repository);
  await service.initialize();
  return {
    root,
    database,
    scope,
    firstThreadId: firstThread.id,
    secondThreadId: secondThread.id,
    repository,
    store,
    service,
  };
}

describe("OutputArtifactService", () => {
  it("captures through real local Files and reattaches to retained bytes after the source disappears", async () => {
    const current = await fixture();
    const inventory = new InventoryRepository(current.database);
    const bindings = new ConversationBindingRepository(current.database);
    const environment = inventory.getLocalEnvironment(current.scope);
    const nativeBinding = bindings.bindDiscoveredConversation(current.scope, current.firstThreadId, {
      backendConversationId: "native-image-thread", now: 40,
    });
    const execution = new LocalExecutionEnvironment({ scope: current.scope, environmentId: environment.id,
      allowedRoots: [current.root], configurationRevision: environment.configurationRevision,
      activeConfigurationRevision: () => inventory.getEnvironment(current.scope, environment.id).configurationRevision });
    const provider = new LocalWorkspaceFileProvider({ scope: current.scope, environmentId: environment.id });
    const files = new WorkspaceFileService(inventory, new WorkspaceFileRootRepository(current.database),
      new WorkspaceFileLinkedWorktreeRepository(current.database), execution, provider,
      { publishApplicationThreadChanges: () => undefined });
    const capture = new ViewedImageCaptureService({ artifacts: current.service, files, inventory, bindings });
    const source = path.join(current.root, "viewed.png");
    try {
      await writeFile(source, png());
      const request = { scope: current.scope, binding: { ...nativeBinding, createdAt: new Date(nativeBinding.createdAt).toISOString() },
        publicationKey: "viewed-image", absolutePath: source };
      const retained = await capture.capture(request);
      expect(retained).toMatchObject({ mediaType: "image/png", byteSize: png().length });
      if (!retained) throw new Error("expected retained image");
      await capture.close();
      await rm(source);
      const reread = vi.spyOn(files, "readAbsoluteImage");
      const reattached = new ViewedImageCaptureService({ artifacts: current.service, files, inventory, bindings });
      expect(await reattached.capture(request)).toEqual(retained);
      expect(reread).not.toHaveBeenCalled();
      const opened = await current.service.openImage(current.scope, current.firstThreadId, retained.artifactId);
      expect(await opened.handle.readFile()).toEqual(png());
      await opened.handle.close();
      await reattached.close();
    } finally {
      await capture.close();
      await files.close();
      current.database.close();
    }
  });

  it("rechecks capture authority inside the database transaction after blob publication", async () => {
    const current = await fixture();
    try {
      let allowed = true;
      let checks = 0;
      const original = current.store.publish.bind(current.store);
      vi.spyOn(current.store, "publish").mockImplementation(async (...args) => {
        await original(...args);
        allowed = false;
      });
      await expect(current.service.publishCapturedImage({
        scope: current.scope,
        threadId: current.firstThreadId,
        publicationKey: "captured-item",
        mediaType: "image/png",
        bytes: png(),
      }, () => {
        checks += 1;
        if (checks === 2) expect(current.database.inTransaction).toBe(true);
        if (!allowed) throw new Error("capture_authority_revoked");
      })).rejects.toThrow("capture_authority_revoked");
      expect(checks).toBe(2);
      expect(current.repository.listRetainedBlobs()).toEqual([]);
      expect(current.service.findImage(current.scope, current.firstThreadId, "captured-item")).toBeUndefined();
      await expect(current.store.open(current.scope, createHash("sha256").update(png()).digest("hex"), png().length)).rejects.toThrow();
    } finally {
      current.database.close();
    }
  });

  it("preserves a shared blob when a captured association loses authority", async () => {
    const current = await fixture();
    try {
      const retained = await current.service.publishImage({ scope: current.scope,
        threadId: current.firstThreadId, publicationKey: "existing", mediaType: "image/png", bytes: png() });
      let checks = 0;
      await expect(current.service.publishCapturedImage({ scope: current.scope,
        threadId: current.secondThreadId, publicationKey: "capture", mediaType: "image/png", bytes: png() }, () => {
        if (++checks > 1) throw new Error("capture_authority_revoked");
      })).rejects.toThrow("capture_authority_revoked");
      const opened = await current.service.openImage(current.scope, current.firstThreadId, retained.artifactId);
      await opened.handle.close();
      expect(current.service.findImage(current.scope, current.secondThreadId, "capture")).toBeUndefined();
      expect(current.repository.listRetainedBlobs()).toHaveLength(1);
    } finally {
      current.database.close();
    }
  });

  it("publishes exact immutable bytes and returns path-free metadata", async () => {
    const current = await fixture();
    try {
      const bytes = png();
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const descriptor = await current.service.publishImage({
        scope: current.scope,
        threadId: current.firstThreadId,
        publicationKey: "codex-item-1",
        mediaType: "image/png",
        bytes,
        expectedByteSize: bytes.byteLength,
        expectedSha256: sha256,
        now: 40,
      });

      expect(descriptor).toEqual({
        artifactId: expect.any(String),
        mediaType: "image/png",
        byteSize: bytes.byteLength,
        sha256,
      });
      expect(Object.keys(descriptor).sort()).toEqual([
        "artifactId",
        "byteSize",
        "mediaType",
        "sha256",
      ]);
      const opened = await current.service.openImage(
        current.scope,
        current.firstThreadId,
        descriptor.artifactId,
      );
      try {
        expect(await readFile(opened.handle)).toEqual(bytes);
      } finally {
        await opened.handle.close();
      }
      const stored = current.database
        .prepare("SELECT * FROM output_image_artifacts")
        .get() as Record<string, unknown>;
      expect(JSON.stringify(stored)).not.toContain(bytes.toString("base64"));
      expect(Object.keys(stored)).not.toContain("path");
    } finally {
      current.database.close();
    }
  });

  it("is idempotent per backend item and deduplicates exact blobs", async () => {
    const current = await fixture();
    try {
      const bytes = png();
      const input = {
        scope: current.scope,
        threadId: current.firstThreadId,
        publicationKey: "stable-item",
        mediaType: "image/png" as const,
        bytes,
        now: 50,
      };
      const first = await current.service.publishImage(input);
      expect(
        current.service.findImage(
          current.scope,
          current.firstThreadId,
          "stable-item",
        ),
      ).toEqual(first);
      await expect(current.service.publishImage(input)).resolves.toEqual(first);
      const second = await current.service.publishImage({
        ...input,
        publicationKey: "another-item",
      });
      const otherThread = await current.service.publishImage({
        ...input,
        threadId: current.secondThreadId,
        publicationKey: "forked-item",
      });

      expect(second.artifactId).not.toBe(first.artifactId);
      expect(otherThread.artifactId).not.toBe(first.artifactId);
      expect(second.sha256).toBe(first.sha256);
      expect(otherThread.sha256).toBe(first.sha256);
      expect(
        current.database
          .prepare("SELECT count(*) AS count FROM output_image_blobs")
          .get(),
      ).toEqual({ count: 1 });
      expect(
        current.database
          .prepare("SELECT count(*) AS count FROM output_image_artifacts")
          .get(),
      ).toEqual({ count: 3 });
      await expect(
        current.service.publishImage({ ...input, bytes: png(1) }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      current.database.close();
    }
  });

  it("keeps the event loop live and single-flights concurrent publication identity", async () => {
    const current = await fixture();
    try {
      const originalPublish = current.store.publish.bind(current.store);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const publish = vi
        .spyOn(current.store, "publish")
        .mockImplementation(async (...input) => {
          entered();
          await gate;
          await originalPublish(...input);
        });
      const input = {
        scope: current.scope,
        threadId: current.firstThreadId,
        publicationKey: "concurrent-item",
        mediaType: "image/png" as const,
        bytes: png(),
      };
      const first = current.service.publishImage(input);
      await started;
      const second = current.service.publishImage(input);
      let immediateRan = false;
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          immediateRan = true;
          resolve();
        });
      });
      expect(immediateRan).toBe(true);
      expect(publish).toHaveBeenCalledTimes(1);
      release();
      const [firstDescriptor, secondDescriptor] = await Promise.all([
        first,
        second,
      ]);
      expect(secondDescriptor).toEqual(firstDescriptor);
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      current.database.close();
    }
  });

  it("enforces tenant, principal, and thread association", async () => {
    const current = await fixture();
    try {
      const descriptor = await current.service.publishImage({
        scope: current.scope,
        threadId: current.firstThreadId,
        publicationKey: "scoped-item",
        mediaType: "image/png",
        bytes: png(),
      });
      expect(
        current.service.findImage(
          current.scope,
          current.secondThreadId,
          "scoped-item",
        ),
      ).toBeUndefined();
      await expect(
        current.service.openImage(
          current.scope,
          current.secondThreadId,
          descriptor.artifactId,
        ),
      ).rejects.toMatchObject({ code: "not_found" });
      await expect(
        current.service.openImage(
          { ...current.scope, principalId: "another-principal" },
          current.firstThreadId,
          descriptor.artifactId,
        ),
      ).rejects.toMatchObject({ code: "not_found" });
    } finally {
      current.database.close();
    }
  });

  it("rejects MIME, size, digest, and publication identity failures before persistence", async () => {
    const current = await fixture();
    try {
      const base = {
        scope: current.scope,
        threadId: current.firstThreadId,
        publicationKey: "invalid-item",
        mediaType: "image/png" as const,
        bytes: png(),
      };
      await expect(
        current.service.publishImage({ ...base, mediaType: "image/jpeg" }),
      ).rejects.toThrow("declared MIME type");
      await expect(
        current.service.publishImage({ ...base, expectedByteSize: 100 }),
      ).rejects.toThrow("declared size");
      await expect(
        current.service.publishImage({
          ...base,
          expectedSha256: "0".repeat(64),
        }),
      ).rejects.toThrow("declared digest");
      await expect(
        current.service.publishImage({ ...base, publicationKey: "" }),
      ).rejects.toThrow("publication identity");
      await expect(
        current.service.publishImage({
          ...base,
          publicationKey: "truncated",
          bytes: png().subarray(0, 20),
        }),
      ).rejects.toThrow("declared MIME type");
      const malformedHeader = png();
      malformedHeader.writeUInt32BE(12, 8);
      await expect(
        current.service.publishImage({
          ...base,
          publicationKey: "malformed-header",
          bytes: malformedHeader,
        }),
      ).rejects.toThrow("declared MIME type");
      await expect(
        current.service.publishImage({
          ...base,
          publicationKey: "dimension-bomb",
          bytes: png(0, 16_000, 16_000),
        }),
      ).rejects.toThrow("declared MIME type");
      expect(
        current.database
          .prepare("SELECT count(*) AS count FROM output_image_artifacts")
          .get(),
      ).toEqual({ count: 0 });
    } finally {
      current.database.close();
    }
  });

  it("retains shared bytes until the final thread association is removed", async () => {
    const current = await fixture();
    try {
      const descriptor = await current.service.publishImage({
        scope: current.scope,
        threadId: current.firstThreadId,
        publicationKey: "deleted-item",
        mediaType: "image/png",
        bytes: png(),
      });
      const otherThread = await current.service.publishImage({
        scope: current.scope,
        threadId: current.secondThreadId,
        publicationKey: "forked-deleted-item",
        mediaType: "image/png",
        bytes: png(),
      });
      expect(
        current.database
          .prepare("PRAGMA foreign_key_list(output_image_artifacts)")
          .all(),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            table: "application_threads",
            on_delete: "CASCADE",
          }),
        ]),
      );
      current.database
        .prepare(
          "DELETE FROM output_image_artifacts WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?",
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.firstThreadId,
        );
      await current.service.collectGarbage();
      expect(current.repository.listRetainedBlobs()).toHaveLength(1);
      const retained = await current.service.openImage(
        current.scope,
        current.secondThreadId,
        otherThread.artifactId,
      );
      await retained.handle.close();

      current.database
        .prepare(
          "DELETE FROM output_image_artifacts WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?",
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.secondThreadId,
        );
      await current.service.collectGarbage();
      expect(current.repository.listRetainedBlobs()).toEqual([]);
      await expect(
        current.store.open(
          current.scope,
          descriptor.sha256,
          descriptor.byteSize,
        ),
      ).rejects.toBeInstanceOf(OutputArtifactStorageError);
    } finally {
      current.database.close();
    }
  });

  it("does not let garbage collection remove a concurrently republished digest", async () => {
    const current = await fixture();
    try {
      const bytes = png();
      const original = await current.service.publishImage({
        scope: current.scope,
        threadId: current.firstThreadId,
        publicationKey: "old-association",
        mediaType: "image/png",
        bytes,
      });
      current.database
        .prepare(
          "DELETE FROM output_image_artifacts WHERE tenant_id = ? AND owner_principal_id = ? AND application_thread_id = ?",
        )
        .run(
          current.scope.tenantId,
          current.scope.principalId,
          current.firstThreadId,
        );

      const originalPublish = current.store.publish.bind(current.store);
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      vi.spyOn(current.store, "publish").mockImplementation(
        async (...input) => {
          entered();
          await gate;
          await originalPublish(...input);
        },
      );
      const republished = current.service.publishImage({
        scope: current.scope,
        threadId: current.secondThreadId,
        publicationKey: "new-association",
        mediaType: "image/png",
        bytes,
      });
      await started;
      const collection = current.service.collectGarbage();
      release();
      const descriptor = await republished;
      await collection;
      expect(descriptor.sha256).toBe(original.sha256);
      const opened = await current.service.openImage(
        current.scope,
        current.secondThreadId,
        descriptor.artifactId,
      );
      await opened.handle.close();
    } finally {
      current.database.close();
    }
  });

  it("rejects an artifact bound to a nonexistent thread", async () => {
    const current = await fixture();
    try {
      const bytes = png();
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      await expect(
        current.service.publishImage({
          scope: current.scope,
          threadId: randomUUID(),
          publicationKey: "orphan-item",
          mediaType: "image/png",
          bytes,
        }),
      ).rejects.toThrow();
      expect(current.repository.listRetainedBlobs()).toEqual([]);
      await expect(
        current.store.open(current.scope, sha256, bytes.byteLength),
      ).rejects.toMatchObject({ code: "artifact_blob_missing" });

      const retained = await current.service.publishImage({
        scope: current.scope,
        threadId: current.firstThreadId,
        publicationKey: "retained-item",
        mediaType: "image/png",
        bytes,
      });
      await expect(
        current.service.publishImage({
          scope: current.scope,
          threadId: randomUUID(),
          publicationKey: "failed-shared-item",
          mediaType: "image/png",
          bytes,
        }),
      ).rejects.toThrow();
      const opened = await current.service.openImage(
        current.scope,
        current.firstThreadId,
        retained.artifactId,
      );
      await opened.handle.close();
    } finally {
      current.database.close();
    }
  });

  it("fails closed when retained canonical bytes no longer match their digest", async () => {
    const current = await fixture();
    try {
      const descriptor = await current.service.publishImage({
        scope: current.scope,
        threadId: current.firstThreadId,
        publicationKey: "corrupt-item",
        mediaType: "image/png",
        bytes: png(),
      });
      const scopeKey = createHash("sha256")
        .update(current.scope.tenantId)
        .update("\0")
        .update(current.scope.principalId)
        .digest("hex");
      const blobPath = path.join(
        current.root,
        "output-artifacts",
        "blobs",
        scopeKey,
        descriptor.sha256.slice(0, 2),
        descriptor.sha256,
      );
      await chmod(blobPath, 0o600);
      await writeFile(blobPath, png(1));

      await expect(
        current.service.openImage(
          current.scope,
          current.firstThreadId,
          descriptor.artifactId,
        ),
      ).rejects.toMatchObject({ code: "artifact_blob_corrupt" });
    } finally {
      current.database.close();
    }
  });
});
