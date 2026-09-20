import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import { BackendError } from "../../src/server/backends/contracts.js";
import { ComposerAttachmentDeliveryService } from "../../src/server/composer-attachments/composer-attachment-delivery-service.js";
import type { ComposerAttachmentService } from "../../src/server/composer-attachments/service.js";
import type { ExecutionAttachmentStager } from "../../src/server/composer-attachments/execution-attachment-stager.js";
import type { ComposerAttachmentMaterializationPersistence } from "../../src/server/db/repositories/composer-attachment-repository.js";

const scope = { tenantId: "tenant", principalId: "principal" } as const;
const lease = {
  scope,
  environment: {
    id: "environment",
    label: "Local",
    availability: "available",
    diagnosticCode: null,
    revision: 1,
  },
  workspace: {
    summary: {
      id: "workspace",
      environmentId: "environment",
      displayName: "Workspace",
      displayPath: "/workspace",
      availability: "available",
      trustState: "trusted",
      revision: 1,
    },
    canonicalPath: "/workspace",
    authorityRevision: 1,
  },
  release: vi.fn(),
} as const;

const descriptor = {
  id: "attachment-1",
  kind: "file",
  fileName: "archive.TAR.GZ",
  mediaType: "application/octet-stream",
  byteSize: 3,
} as const;
const sha256 = createHash("sha256").update("abc").digest("hex");

describe("ComposerAttachmentDeliveryService", () => {
  it("streams authorized immutable bytes into the actor-owned lease", async () => {
    const close = vi.fn(async () => undefined);
    const open = vi.fn(
      async () =>
        ({
          createReadStream: () => Readable.from([Buffer.from("abc")]),
          readFile: async () => Buffer.from("abc"),
          close,
        }) as unknown as FileHandle,
    );
    const resolveForDelivery = vi.fn(() => [{ descriptor, sha256, open }]);
    const materialize = vi.fn(async (_scope, request) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of request.content()) chunks.push(chunk);
      expect(Buffer.concat(chunks).toString("utf8")).toBe("abc");
      expect(request.lease).toBe(lease);
      expect(request.safeExtension).toBe(".gz");
      return { agentPath: "/staged/attachment-1.gz", sha256, sizeBytes: 3 };
    });
    const recordReadyMaterialization = vi.fn(() => ({}));
    const service = new ComposerAttachmentDeliveryService(
      { resolveForDelivery } as unknown as ComposerAttachmentService,
      {
        supports: () => true,
        materialize,
        release: vi.fn(),
        close: vi.fn(),
      } as unknown as ExecutionAttachmentStager,
      {
        findMaterialization: vi.fn(() => undefined),
        recordReadyMaterialization,
      } as unknown as ComposerAttachmentMaterializationPersistence,
      () => 123,
    );

    const delivered = await service.materialize(scope, "thread", lease, [
      descriptor,
    ]);
    expect(delivered.attachments).toEqual([
      {
        ...descriptor,
        sha256,
        agentPath: "/staged/attachment-1.gz",
      },
    ]);
    expect(delivered.canonicalEvidence.resolve()).toEqual([
      { ...descriptor, sha256 },
    ]);
    expect(Object.isFrozen(delivered.canonicalEvidence.resolve()[0])).toBe(
      true,
    );
    expect(JSON.stringify(delivered.canonicalEvidence.resolve())).not.toContain(
      "/staged/",
    );
    await expect(
      delivered.canonicalBytes.read(delivered.attachments[0]!),
    ).resolves.toEqual(Buffer.from("abc"));
    expect(resolveForDelivery).toHaveBeenCalledWith(scope, "thread", [
      "attachment-1",
    ]);
    expect(resolveForDelivery).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(recordReadyMaterialization).toHaveBeenCalledWith(
      scope,
      {
        executionEnvironmentId: "environment",
        workspaceId: "workspace",
        environmentAuthorityRevision: 1,
        applicationThreadId: "thread",
        attachmentId: "attachment-1",
        blobSha256: sha256,
      },
      {
        agentPath: "/staged/attachment-1.gz",
        byteLength: 3,
        verifiedAt: 123,
      },
    );
  });

  it("fails before the provider boundary when staging is unavailable", async () => {
    const service = new ComposerAttachmentDeliveryService(
      {} as ComposerAttachmentService,
      {
        supports: () => false,
      } as unknown as ExecutionAttachmentStager,
      {} as ComposerAttachmentMaterializationPersistence,
    );

    const error = await service
      .materialize(scope, "thread", lease, [descriptor])
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(BackendError);
    expect(error).toMatchObject({
      category: "unavailable",
      retryable: true,
      crossedSubmissionBoundary: false,
    });
  });

  it("marks stale ready evidence missing before recording verified evidence", async () => {
    const markMaterializationMissing = vi.fn(() => true);
    const recordReadyMaterialization = vi.fn(() => ({}));
    const service = new ComposerAttachmentDeliveryService(
      {
        resolveForDelivery: () => [
          {
            descriptor,
            sha256,
            open: vi.fn(),
          },
        ],
      } as unknown as ComposerAttachmentService,
      {
        supports: () => true,
        materialize: vi.fn(async () => ({
          agentPath: "/staged/current.gz",
          sha256,
          sizeBytes: 3,
        })),
      } as unknown as ExecutionAttachmentStager,
      {
        findMaterialization: vi.fn(() => ({
          state: "ready",
          agentPath: "/staged/stale.gz",
          byteLength: 3,
        })),
        markMaterializationMissing,
        recordReadyMaterialization,
      } as unknown as ComposerAttachmentMaterializationPersistence,
      () => 456,
    );

    await service.materialize(scope, "thread", lease, [descriptor]);
    expect(markMaterializationMissing).toHaveBeenCalledOnce();
    expect(markMaterializationMissing.mock.invocationCallOrder[0]).toBeLessThan(
      recordReadyMaterialization.mock.invocationCallOrder[0]!,
    );
  });

  it("reads canonical bytes without interpreting a remote agent path locally", async () => {
    const bytes = Buffer.from("abc");
    const close = vi.fn(async () => undefined);
    const open = vi.fn(
      async () =>
        ({
          createReadStream: () => Readable.from([bytes]),
          readFile: async () => bytes,
          close,
        }) as unknown as FileHandle,
    );
    const service = new ComposerAttachmentDeliveryService(
      {
        resolveForDelivery: vi.fn(() => [{ descriptor, sha256, open }]),
      } as unknown as ComposerAttachmentService,
      {
        supports: () => true,
        materialize: vi.fn(async (_scope, request) => {
          for await (const _chunk of request.content()) {
            // Consume the canonical stream as a remote stager would.
          }
          return {
            agentPath: "/remote/ssh/.sedes-attachments/attachment-1.gz",
            sha256,
            sizeBytes: bytes.byteLength,
          };
        }),
      } as unknown as ExecutionAttachmentStager,
      {
        findMaterialization: vi.fn(() => undefined),
        recordReadyMaterialization: vi.fn(() => ({})),
      } as unknown as ComposerAttachmentMaterializationPersistence,
    );

    const delivered = await service.materialize(scope, "thread", lease, [
      descriptor,
    ]);
    expect(delivered.attachments[0]?.agentPath).toContain("/remote/ssh/");
    await expect(
      delivered.canonicalBytes.read(delivered.attachments[0]!),
    ).resolves.toEqual(bytes);
    expect(open).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["size", Buffer.from("ab")],
    ["digest", Buffer.from("abd")],
  ])(
    "fails canonical %s corruption before provider delivery",
    async (_kind, bytes) => {
      const close = vi.fn(async () => undefined);
      const open = vi
        .fn()
        .mockResolvedValueOnce({
          createReadStream: () => Readable.from([Buffer.from("abc")]),
          close,
        } as unknown as FileHandle)
        .mockResolvedValueOnce({
          readFile: async () => bytes,
          close,
        } as unknown as FileHandle);
      const service = new ComposerAttachmentDeliveryService(
        {
          resolveForDelivery: vi.fn(() => [
            {
              descriptor,
              sha256,
              open,
            },
          ]),
        } as unknown as ComposerAttachmentService,
        {
          supports: () => true,
          materialize: vi.fn(async (_scope, request) => {
            for await (const _chunk of request.content()) {
              // Consume the canonical staging stream.
            }
            return {
              agentPath: "/remote/attachment-1.gz",
              sha256,
              sizeBytes: 3,
            };
          }),
        } as unknown as ExecutionAttachmentStager,
        {
          findMaterialization: vi.fn(() => undefined),
          recordReadyMaterialization: vi.fn(() => ({})),
        } as unknown as ComposerAttachmentMaterializationPersistence,
      );
      const delivery = await service.materialize(scope, "thread", lease, [
        descriptor,
      ]);
      const failure = await delivery.canonicalBytes
        .read(delivery.attachments[0]!)
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({
        category: "unavailable",
        crossedSubmissionBoundary: false,
      });
      expect(close).toHaveBeenCalledTimes(2);
    },
  );

  it("rechecks scoped live ownership before reading canonical bytes", async () => {
    const close = vi.fn(async () => undefined);
    const resolveForDelivery = vi
      .fn()
      .mockReturnValueOnce([
        {
          descriptor,
          sha256,
          open: async () =>
            ({
              createReadStream: () => Readable.from([Buffer.from("abc")]),
              close,
            }) as unknown as FileHandle,
        },
      ])
      .mockImplementationOnce(() => {
        throw new Error("wrong_scope_or_owner_missing");
      });
    const service = new ComposerAttachmentDeliveryService(
      { resolveForDelivery } as unknown as ComposerAttachmentService,
      {
        supports: () => true,
        materialize: vi.fn(async (_scope, request) => {
          for await (const _chunk of request.content()) {
            // Consume the authorized canonical stream.
          }
          return {
            agentPath: "/remote/attachment-1.gz",
            sha256,
            sizeBytes: 3,
          };
        }),
      } as unknown as ExecutionAttachmentStager,
      {
        findMaterialization: vi.fn(() => undefined),
        recordReadyMaterialization: vi.fn(() => ({})),
      } as unknown as ComposerAttachmentMaterializationPersistence,
    );
    const delivery = await service.materialize(scope, "thread", lease, [
      descriptor,
    ]);

    await expect(
      delivery.canonicalBytes.read(delivery.attachments[0]!),
    ).rejects.toMatchObject({
      category: "invalid_state",
      retryable: false,
      crossedSubmissionBoundary: false,
    });
    expect(resolveForDelivery).toHaveBeenLastCalledWith(scope, "thread", [
      descriptor.id,
    ]);
  });
});
