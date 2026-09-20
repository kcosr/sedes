import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  COMPOSER_ATTACHMENT_LIMITS,
  composerAttachmentDescriptorSchema,
  composerAttachmentIdSchema,
  type ComposerAttachmentDescriptor,
} from "../../../shared/protocol/composer-attachments.js";
import type {
  ComposerAttachmentBlob,
  ComposerAttachmentPersistence,
  ComposerAttachmentStoredRecord,
} from "../../composer-attachments/contracts.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export const MAXIMUM_COMPOSER_ATTACHMENTS =
  COMPOSER_ATTACHMENT_LIMITS.maximumAttachments;
const UNOWNED_UPLOAD_RETENTION_MILLISECONDS = 24 * 60 * 60 * 1_000;
const MAXIMUM_PRINCIPAL_BLOB_BYTES = 1_024 * 1_024 * 1_024;

export type AttachmentBlobRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly sha256: string;
  readonly byteLength: number;
  readonly storageKey: string;
  readonly createdAt: number;
};

export type ComposerAttachmentRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly id: string;
  readonly originThreadId: string;
  readonly blobSha256: string;
  readonly byteLength: number;
  readonly storageKey: string;
  readonly displayName: string;
  readonly mediaType: string;
  readonly kind: "file" | "image";
  readonly imageWidth: number | null;
  readonly imageHeight: number | null;
  readonly createdAt: number;
  readonly unownedExpiresAt: number;
};

export type AttachmentMaterializationKey = {
  readonly executionEnvironmentId: string;
  readonly workspaceId: string;
  readonly environmentAuthorityRevision: number;
  readonly applicationThreadId: string;
  readonly attachmentId: string;
  readonly blobSha256: string;
};

export type AttachmentMaterializationRecord = AttachmentMaterializationKey & {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly materializationIdentity: string;
  readonly byteLength: number;
  readonly agentPath: string;
  readonly state: "ready" | "missing" | "abandoned" | "released";
  readonly verifiedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export interface ComposerAttachmentMaterializationPersistence {
  findMaterialization(
    scope: RequestScope,
    key: AttachmentMaterializationKey,
  ): AttachmentMaterializationRecord | undefined;
  recordReadyMaterialization(
    scope: RequestScope,
    key: AttachmentMaterializationKey,
    evidence: {
      readonly agentPath: string;
      readonly byteLength: number;
      readonly verifiedAt: number;
    },
  ): AttachmentMaterializationRecord;
  markMaterializationMissing(
    scope: RequestScope,
    key: AttachmentMaterializationKey,
    now: number,
  ): boolean;
  abandonMaterialization(
    scope: RequestScope,
    key: AttachmentMaterializationKey,
    now: number,
  ): boolean;
  releaseMaterialization(
    scope: RequestScope,
    key: AttachmentMaterializationKey,
    now: number,
  ): boolean;
}

const attachmentColumns = `
  attachment.tenant_id AS tenantId,
  attachment.owner_principal_id AS ownerPrincipalId,
  attachment.id,
  attachment.origin_thread_id AS originThreadId,
  attachment.blob_sha256 AS blobSha256,
  blob.byte_length AS byteLength,
  blob.storage_key AS storageKey,
  attachment.display_name AS displayName,
  attachment.media_type AS mediaType,
  attachment.kind,
  attachment.image_width AS imageWidth,
  attachment.image_height AS imageHeight,
  attachment.created_at AS createdAt,
  attachment.unowned_expires_at AS unownedExpiresAt
`;

function assertOrderedIds(ids: readonly string[]): void {
  if (
    ids.length > MAXIMUM_COMPOSER_ATTACHMENTS ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !composerAttachmentIdSchema.safeParse(id).success)
  ) {
    throw new DomainError(
      "invalid_transition",
      `Composer attachments must contain at most ${MAXIMUM_COMPOSER_ATTACHMENTS} unique items.`,
    );
  }
}

function assertMaterializationKey(key: AttachmentMaterializationKey): void {
  if (
    !Number.isSafeInteger(key.environmentAuthorityRevision) ||
    key.environmentAuthorityRevision < 0 ||
    key.executionEnvironmentId.length === 0 ||
    key.workspaceId.length === 0 ||
    key.applicationThreadId.length === 0 ||
    !composerAttachmentIdSchema.safeParse(key.attachmentId).success ||
    !/^[0-9a-f]{64}$/u.test(key.blobSha256)
  ) {
    throw new DomainError(
      "invalid_transition",
      "The attachment materialization identity is invalid.",
    );
  }
}

function materializationIdentity(
  scope: RequestScope,
  key: AttachmentMaterializationKey,
): string {
  assertMaterializationKey(key);
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        scope.tenantId,
        scope.principalId,
        key.executionEnvironmentId,
        key.workspaceId,
        key.environmentAuthorityRevision,
        key.applicationThreadId,
        key.attachmentId,
        key.blobSha256,
      ]),
      "utf8",
    )
    .digest("hex");
  return `mat_${digest}`;
}

const materializationColumns = `
  tenant_id AS tenantId,
  owner_principal_id AS ownerPrincipalId,
  materialization_identity AS materializationIdentity,
  execution_environment_id AS executionEnvironmentId,
  workspace_id AS workspaceId,
  environment_authority_revision AS environmentAuthorityRevision,
  application_thread_id AS applicationThreadId,
  attachment_id AS attachmentId,
  blob_sha256 AS blobSha256,
  byte_length AS byteLength,
  agent_path AS agentPath,
  state,
  verified_at AS verifiedAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

type LinkOwner =
  | { readonly kind: "draft"; readonly threadId: string }
  | {
      readonly kind: "stash";
      readonly threadId: string;
      readonly stashId: string;
    }
  | {
      readonly kind: "queue";
      readonly threadId: string;
      readonly queuedInputId: string;
    }
  | {
      readonly kind: "creation";
      readonly threadId: string;
      readonly attemptId: string;
    }
  | {
      readonly kind: "operation";
      readonly threadId: string;
      readonly mutationId: string;
    }
  | {
      readonly kind: "submitted";
      readonly threadId: string;
      readonly operationId: string;
    };

function ownerSql(owner: LinkOwner): {
  readonly table: string;
  readonly principalColumn: "principal_id" | "owner_principal_id";
  readonly parentPredicate: string;
  readonly parentValues: readonly string[];
} {
  switch (owner.kind) {
    case "draft":
      return {
        table: "draft_composer_attachments",
        principalColumn: "principal_id",
        parentPredicate: "thread_id = ?",
        parentValues: [owner.threadId],
      };
    case "stash":
      return {
        table: "stash_composer_attachments",
        principalColumn: "principal_id",
        parentPredicate: "thread_id = ? AND stash_id = ?",
        parentValues: [owner.threadId, owner.stashId],
      };
    case "queue":
      return {
        table: "queued_input_composer_attachments",
        principalColumn: "owner_principal_id",
        parentPredicate: "application_thread_id = ? AND queued_input_id = ?",
        parentValues: [owner.threadId, owner.queuedInputId],
      };
    case "creation":
      return {
        table: "creation_attempt_composer_attachments",
        principalColumn: "owner_principal_id",
        parentPredicate: "application_thread_id = ? AND attempt_id = ?",
        parentValues: [owner.threadId, owner.attemptId],
      };
    case "operation":
      return {
        table: "conversation_operation_composer_attachments",
        principalColumn: "principal_id",
        parentPredicate: "thread_id = ? AND mutation_id = ?",
        parentValues: [owner.threadId, owner.mutationId],
      };
    case "submitted":
      return {
        table: "submitted_operation_composer_attachments",
        principalColumn: "owner_principal_id",
        parentPredicate: "application_thread_id = ? AND operation_id = ?",
        parentValues: [owner.threadId, owner.operationId],
      };
  }
}

export class ComposerAttachmentRepository
  implements
    ComposerAttachmentPersistence,
    ComposerAttachmentMaterializationPersistence
{
  constructor(readonly database: Database.Database) {}

  upsertBlob(
    scope: RequestScope,
    input: {
      readonly sha256: string;
      readonly byteLength: number;
      readonly storageKey: string;
      readonly now: number;
    },
  ): AttachmentBlobRecord {
    return this.database.transaction(() => {
      const existing = this.findBlob(scope, input.sha256);
      if (existing) {
        if (
          existing.byteLength !== input.byteLength ||
          existing.storageKey !== input.storageKey
        ) {
          throw new DomainError(
            "conflict",
            "The attachment digest is already registered with different bytes.",
          );
        }
        return existing;
      }
      this.database
        .prepare(
          `INSERT INTO attachment_blobs(
             tenant_id, owner_principal_id, sha256, byte_length,
             storage_key, created_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          input.sha256,
          input.byteLength,
          input.storageKey,
          input.now,
        );
      return this.getBlob(scope, input.sha256);
    })();
  }

  findBlob(
    scope: RequestScope,
    sha256: string,
  ): AttachmentBlobRecord | undefined {
    return this.database
      .prepare(
        `SELECT tenant_id AS tenantId,
           owner_principal_id AS ownerPrincipalId, sha256,
           byte_length AS byteLength, storage_key AS storageKey,
           created_at AS createdAt
         FROM attachment_blobs
         WHERE tenant_id = ? AND owner_principal_id = ? AND sha256 = ?`,
      )
      .get(scope.tenantId, scope.principalId, sha256) as
      AttachmentBlobRecord | undefined;
  }

  getBlob(scope: RequestScope, sha256: string): AttachmentBlobRecord {
    const record = this.findBlob(scope, sha256);
    if (!record) {
      throw new DomainError("not_found", "The attachment blob was not found.");
    }
    return record;
  }

  createAttachment(
    scope: RequestScope,
    input: {
      readonly id: string;
      readonly originThreadId: string;
      readonly blobSha256: string;
      readonly displayName: string;
      readonly mediaType: string;
      readonly kind: "file" | "image";
      readonly imageWidth?: number;
      readonly imageHeight?: number;
      readonly now: number;
    },
  ): ComposerAttachmentRecord {
    return this.database.transaction(() => {
      composerAttachmentIdSchema.parse(input.id);
      const thread = this.database
        .prepare(
          `SELECT 1 FROM application_threads
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .get(scope.tenantId, scope.principalId, input.originThreadId);
      if (!thread) {
        throw new DomainError(
          "not_found",
          "The attachment thread was not found.",
        );
      }
      this.getBlob(scope, input.blobSha256);
      const existing = this.find(scope, input.id);
      if (existing) {
        if (
          existing.blobSha256 !== input.blobSha256 ||
          existing.originThreadId !== input.originThreadId ||
          existing.displayName !== input.displayName ||
          existing.mediaType !== input.mediaType ||
          existing.kind !== input.kind ||
          existing.imageWidth !== (input.imageWidth ?? null) ||
          existing.imageHeight !== (input.imageHeight ?? null)
        ) {
          throw new DomainError(
            "conflict",
            "The attachment ID is already used by different content.",
          );
        }
        return existing;
      }
      this.database
        .prepare(
          `INSERT INTO composer_attachments(
             tenant_id, owner_principal_id, id, origin_thread_id, blob_sha256,
             display_name, media_type, kind, image_width, image_height,
             created_at, unowned_expires_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          input.id,
          input.originThreadId,
          input.blobSha256,
          input.displayName,
          input.mediaType,
          input.kind,
          input.imageWidth ?? null,
          input.imageHeight ?? null,
          input.now,
          input.now + UNOWNED_UPLOAD_RETENTION_MILLISECONDS,
        );
      return this.get(scope, input.id);
    })();
  }

  find(
    scope: RequestScope,
    attachmentId: string,
  ): ComposerAttachmentRecord | undefined {
    return this.database
      .prepare(
        `SELECT ${attachmentColumns}
         FROM composer_attachments AS attachment
         JOIN attachment_blobs AS blob
           ON blob.tenant_id = attachment.tenant_id
          AND blob.owner_principal_id = attachment.owner_principal_id
          AND blob.sha256 = attachment.blob_sha256
         WHERE attachment.tenant_id = ?
           AND attachment.owner_principal_id = ? AND attachment.id = ?`,
      )
      .get(scope.tenantId, scope.principalId, attachmentId) as
      ComposerAttachmentRecord | undefined;
  }

  get(scope: RequestScope, attachmentId: string): ComposerAttachmentRecord {
    const record = this.find(scope, attachmentId);
    if (!record) {
      throw new DomainError("not_found", "The attachment was not found.");
    }
    return record;
  }

  listByIds(
    scope: RequestScope,
    attachmentIds: readonly string[],
    originThreadId?: string,
  ): ComposerAttachmentRecord[] {
    assertOrderedIds(attachmentIds);
    const attachments = attachmentIds.map((id) => this.get(scope, id));
    if (
      originThreadId !== undefined &&
      attachments.some(
        (attachment) => attachment.originThreadId !== originThreadId,
      )
    ) {
      throw new DomainError(
        "not_found",
        "An attachment does not belong to this thread.",
      );
    }
    const aggregateBytes = attachments.reduce(
      (total, attachment) => total + attachment.byteLength,
      0,
    );
    if (aggregateBytes > COMPOSER_ATTACHMENT_LIMITS.maximumAggregateBytes) {
      throw new DomainError(
        "invalid_transition",
        "Composer attachments exceed the aggregate byte limit.",
      );
    }
    if (
      attachments.filter(({ kind }) => kind === "image").length >
      COMPOSER_ATTACHMENT_LIMITS.maximumImages
    ) {
      throw new DomainError(
        "invalid_transition",
        "Composer attachments exceed the previewable image limit.",
      );
    }
    return attachments;
  }

  listForOwner(
    scope: RequestScope,
    owner: LinkOwner,
  ): ComposerAttachmentRecord[] {
    const sql = ownerSql(owner);
    // Start from the exact owner's at-most-eight ordered links. Ordinary joins
    // can make SQLite scan every principal attachment for each queued input,
    // even when that input has no attachments.
    return this.database
      .prepare(
        `SELECT ${attachmentColumns}
         FROM ${sql.table} AS link
         CROSS JOIN composer_attachments AS attachment
           ON attachment.tenant_id = link.tenant_id
          AND attachment.owner_principal_id = link.${sql.principalColumn}
          AND attachment.id = link.attachment_id
         CROSS JOIN attachment_blobs AS blob
           ON blob.tenant_id = attachment.tenant_id
          AND blob.owner_principal_id = attachment.owner_principal_id
          AND blob.sha256 = attachment.blob_sha256
         WHERE link.tenant_id = ? AND link.${sql.principalColumn} = ?
           AND ${sql.parentPredicate}
         ORDER BY link.ordinal`,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        ...sql.parentValues,
      ) as ComposerAttachmentRecord[];
  }

  descriptorsForOwner(
    scope: RequestScope,
    owner: LinkOwner,
  ): ComposerAttachmentDescriptor[] {
    return this.listForOwner(scope, owner).map((attachment) =>
      this.#descriptor(attachment),
    );
  }

  replaceOwnerLinks(
    scope: RequestScope,
    owner: LinkOwner,
    attachmentIds: readonly string[],
  ): void {
    this.listByIds(scope, attachmentIds, owner.threadId);
    const sql = ownerSql(owner);
    this.database
      .prepare(
        `DELETE FROM ${sql.table}
         WHERE tenant_id = ? AND ${sql.principalColumn} = ?
           AND ${sql.parentPredicate}`,
      )
      .run(scope.tenantId, scope.principalId, ...sql.parentValues);
    for (const [ordinal, attachmentId] of attachmentIds.entries()) {
      const columns =
        owner.kind === "draft"
          ? "tenant_id, principal_id, thread_id, ordinal, attachment_id"
          : owner.kind === "stash"
            ? "tenant_id, principal_id, thread_id, stash_id, ordinal, attachment_id"
            : owner.kind === "queue"
              ? "tenant_id, owner_principal_id, application_thread_id, queued_input_id, ordinal, attachment_id"
              : owner.kind === "creation"
                ? "tenant_id, owner_principal_id, application_thread_id, attempt_id, ordinal, attachment_id"
                : owner.kind === "operation"
                  ? "tenant_id, principal_id, thread_id, mutation_id, ordinal, attachment_id"
                  : "tenant_id, owner_principal_id, application_thread_id, operation_id, ordinal, attachment_id";
      this.database
        .prepare(
          `INSERT INTO ${sql.table}(${columns})
           VALUES (${[scope.tenantId, scope.principalId, ...sql.parentValues, ordinal, attachmentId].map(() => "?").join(", ")})`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          ...sql.parentValues,
          ordinal,
          attachmentId,
        );
    }
  }

  copyOwnerLinks(
    scope: RequestScope,
    source: LinkOwner,
    destination: LinkOwner,
  ): ComposerAttachmentRecord[] {
    const attachments = this.listForOwner(scope, source);
    this.replaceOwnerLinks(
      scope,
      destination,
      attachments.map(({ id }) => id),
    );
    return attachments;
  }

  findMaterialization(
    scope: RequestScope,
    key: AttachmentMaterializationKey,
  ): AttachmentMaterializationRecord | undefined {
    const identity = materializationIdentity(scope, key);
    return this.database
      .prepare(
        `SELECT ${materializationColumns}
         FROM attachment_materializations
         WHERE tenant_id = ? AND owner_principal_id = ?
           AND materialization_identity = ?`,
      )
      .get(scope.tenantId, scope.principalId, identity) as
      AttachmentMaterializationRecord | undefined;
  }

  recordReadyMaterialization(
    scope: RequestScope,
    key: AttachmentMaterializationKey,
    evidence: {
      readonly agentPath: string;
      readonly byteLength: number;
      readonly verifiedAt: number;
    },
  ): AttachmentMaterializationRecord {
    const identity = materializationIdentity(scope, key);
    if (
      !Number.isSafeInteger(evidence.byteLength) ||
      evidence.byteLength < 0 ||
      evidence.byteLength > COMPOSER_ATTACHMENT_LIMITS.maximumFileBytes ||
      !Number.isSafeInteger(evidence.verifiedAt) ||
      evidence.verifiedAt < 0 ||
      evidence.agentPath.length === 0 ||
      evidence.agentPath.includes("\0")
    ) {
      throw new DomainError(
        "invalid_transition",
        "The attachment materialization evidence is invalid.",
      );
    }
    const attachment = this.get(scope, key.attachmentId);
    if (
      attachment.originThreadId !== key.applicationThreadId ||
      attachment.blobSha256 !== key.blobSha256 ||
      attachment.byteLength !== evidence.byteLength
    ) {
      throw new DomainError(
        "conflict",
        "The attachment materialization evidence does not match its content.",
      );
    }
    try {
      this.database
        .prepare(
          `INSERT INTO attachment_materializations(
             tenant_id, owner_principal_id, materialization_identity,
             execution_environment_id, workspace_id,
             environment_authority_revision, application_thread_id,
             attachment_id, blob_sha256, byte_length, agent_path, state,
             verified_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)
           ON CONFLICT(
             tenant_id, owner_principal_id, materialization_identity
           ) DO UPDATE SET
             byte_length = excluded.byte_length,
             agent_path = excluded.agent_path,
             state = 'ready',
             verified_at = excluded.verified_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          identity,
          key.executionEnvironmentId,
          key.workspaceId,
          key.environmentAuthorityRevision,
          key.applicationThreadId,
          key.attachmentId,
          key.blobSha256,
          evidence.byteLength,
          evidence.agentPath,
          evidence.verifiedAt,
          evidence.verifiedAt,
          evidence.verifiedAt,
        );
    } catch (error) {
      throw new DomainError(
        "conflict",
        "The attachment materialization scope is no longer valid.",
        false,
        { cause: error },
      );
    }
    return this.findMaterialization(scope, key)!;
  }

  markMaterializationMissing(
    scope: RequestScope,
    key: AttachmentMaterializationKey,
    now: number,
  ): boolean {
    return this.#markMaterialization(scope, key, "missing", now);
  }

  abandonMaterialization(
    scope: RequestScope,
    key: AttachmentMaterializationKey,
    now: number,
  ): boolean {
    return this.#markMaterialization(scope, key, "abandoned", now);
  }

  releaseMaterialization(
    scope: RequestScope,
    key: AttachmentMaterializationKey,
    now: number,
  ): boolean {
    return this.#markMaterialization(scope, key, "released", now);
  }

  isReferenced(scope: RequestScope, attachmentId: string): boolean {
    this.get(scope, attachmentId);
    const checks = [
      ["draft_composer_attachments", "principal_id"],
      ["stash_composer_attachments", "principal_id"],
      ["queued_input_composer_attachments", "owner_principal_id"],
      ["creation_attempt_composer_attachments", "owner_principal_id"],
      ["conversation_operation_composer_attachments", "principal_id"],
      ["submitted_operation_composer_attachments", "owner_principal_id"],
    ] as const;
    return checks.some(([table, principalColumn]) =>
      Boolean(
        this.database
          .prepare(
            `SELECT 1 FROM ${table}
             WHERE tenant_id = ? AND ${principalColumn} = ?
               AND attachment_id = ? LIMIT 1`,
          )
          .get(scope.tenantId, scope.principalId, attachmentId),
      ),
    );
  }

  deleteUnreferenced(scope: RequestScope, attachmentId: string): boolean {
    return this.database.transaction(() => {
      const attachment = this.get(scope, attachmentId);
      if (this.isReferenced(scope, attachmentId)) return false;
      const removed = this.database
        .prepare(
          `DELETE FROM composer_attachments
           WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
        )
        .run(scope.tenantId, scope.principalId, attachmentId);
      if (removed.changes !== 1) return false;
      this.database
        .prepare(
          `DELETE FROM attachment_blobs
           WHERE tenant_id = ? AND owner_principal_id = ? AND sha256 = ?
             AND NOT EXISTS (
               SELECT 1 FROM composer_attachments
               WHERE tenant_id = ? AND owner_principal_id = ?
                 AND blob_sha256 = ?
             )`,
        )
        .run(
          scope.tenantId,
          scope.principalId,
          attachment.blobSha256,
          scope.tenantId,
          scope.principalId,
          attachment.blobSha256,
        );
      return true;
    })();
  }

  principalBlobBytes(scope: RequestScope): number {
    return (
      this.database
        .prepare(
          `SELECT coalesce(sum(byte_length), 0) AS bytes
           FROM attachment_blobs
           WHERE tenant_id = ? AND owner_principal_id = ?`,
        )
        .get(scope.tenantId, scope.principalId) as { readonly bytes: number }
    ).bytes;
  }

  recordUpload(
    scope: RequestScope,
    threadId: string,
    attachmentId: string,
    blob: ComposerAttachmentBlob,
    now: number,
  ): ComposerAttachmentStoredRecord {
    const descriptor = composerAttachmentDescriptorSchema.parse({
      ...blob.descriptor,
      id: attachmentId,
    });
    return this.database.transaction(() => {
      const existingBlob = this.findBlob(scope, blob.digest);
      if (
        !existingBlob &&
        this.principalBlobBytes(scope) + blob.byteSize >
          MAXIMUM_PRINCIPAL_BLOB_BYTES
      ) {
        throw new DomainError(
          "attachment_quota_exceeded",
          "The attachment storage quota has been reached.",
        );
      }
      this.upsertBlob(scope, {
        sha256: blob.digest,
        byteLength: blob.byteSize,
        storageKey: blob.digest,
        now,
      });
      const attachment = this.createAttachment(scope, {
        id: attachmentId,
        originThreadId: threadId,
        blobSha256: blob.digest,
        displayName: descriptor.fileName,
        mediaType: descriptor.mediaType,
        kind: descriptor.kind,
        ...(blob.imageWidth === undefined
          ? {}
          : { imageWidth: blob.imageWidth }),
        ...(blob.imageHeight === undefined
          ? {}
          : { imageHeight: blob.imageHeight }),
        now,
      });
      return this.#storedRecord(attachment);
    })();
  }

  findLiveOwner(
    scope: RequestScope,
    threadId: string,
    attachmentId: string,
  ): ComposerAttachmentStoredRecord | undefined {
    const attachment = this.find(scope, attachmentId);
    if (
      !attachment ||
      attachment.originThreadId !== threadId ||
      !this.isReferenced(scope, attachmentId)
    ) {
      return undefined;
    }
    return this.#storedRecord(attachment);
  }

  listRetainedBlobs(): readonly Readonly<{
    scope: RequestScope;
    digest: string;
    byteSize: number;
  }>[] {
    const rows = this.database
      .prepare(
        `SELECT tenant_id AS tenantId,
           owner_principal_id AS principalId,
           sha256 AS digest, byte_length AS byteSize
         FROM attachment_blobs
         ORDER BY tenant_id, owner_principal_id, sha256`,
      )
      .all() as Array<{
      readonly tenantId: string;
      readonly principalId: string;
      readonly digest: string;
      readonly byteSize: number;
    }>;
    return rows.map(({ tenantId, principalId, digest, byteSize }) => ({
      scope: { tenantId, principalId },
      digest,
      byteSize,
    }));
  }

  collectGarbage(now: number): readonly Readonly<{
    scope: RequestScope;
    digest: string;
  }>[] {
    return this.database.transaction(() => {
      const candidates = this.database
        .prepare(
          `SELECT tenant_id AS tenantId,
             owner_principal_id AS principalId, id
           FROM composer_attachments
           WHERE unowned_expires_at <= ?
           ORDER BY tenant_id, owner_principal_id, id`,
        )
        .all(now) as Array<{
        readonly tenantId: string;
        readonly principalId: string;
        readonly id: string;
      }>;
      for (const candidate of candidates) {
        const candidateScope = {
          tenantId: candidate.tenantId,
          principalId: candidate.principalId,
        };
        if (!this.isReferenced(candidateScope, candidate.id)) {
          this.database
            .prepare(
              `DELETE FROM composer_attachments
               WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
            )
            .run(candidate.tenantId, candidate.principalId, candidate.id);
        }
      }
      const garbage = this.database
        .prepare(
          `SELECT blob.tenant_id AS tenantId,
             blob.owner_principal_id AS principalId, blob.sha256 AS digest
           FROM attachment_blobs AS blob
           WHERE NOT EXISTS (
             SELECT 1 FROM composer_attachments AS attachment
             WHERE attachment.tenant_id = blob.tenant_id
               AND attachment.owner_principal_id = blob.owner_principal_id
               AND attachment.blob_sha256 = blob.sha256
           )
           ORDER BY blob.tenant_id, blob.owner_principal_id, blob.sha256`,
        )
        .all() as Array<{
        readonly tenantId: string;
        readonly principalId: string;
        readonly digest: string;
      }>;
      const remove = this.database.prepare(
        `DELETE FROM attachment_blobs
         WHERE tenant_id = ? AND owner_principal_id = ? AND sha256 = ?`,
      );
      for (const blob of garbage) {
        remove.run(blob.tenantId, blob.principalId, blob.digest);
      }
      return garbage.map(({ tenantId, principalId, digest }) => ({
        scope: { tenantId, principalId },
        digest,
      }));
    })();
  }

  #storedRecord(
    attachment: ComposerAttachmentRecord,
  ): ComposerAttachmentStoredRecord {
    return {
      threadId: attachment.originThreadId,
      attachmentId: attachment.id,
      digest: attachment.blobSha256,
      descriptor: this.#descriptor(attachment),
    };
  }

  #descriptor(
    attachment: ComposerAttachmentRecord,
  ): ComposerAttachmentDescriptor {
    return composerAttachmentDescriptorSchema.parse({
      id: attachment.id,
      kind: attachment.kind,
      fileName: attachment.displayName,
      mediaType: attachment.mediaType,
      byteSize: attachment.byteLength,
    });
  }

  #markMaterialization(
    scope: RequestScope,
    key: AttachmentMaterializationKey,
    state: "missing" | "abandoned" | "released",
    now: number,
  ): boolean {
    const identity = materializationIdentity(scope, key);
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new DomainError(
        "invalid_transition",
        "The attachment materialization timestamp is invalid.",
      );
    }
    return (
      this.database
        .prepare(
          `UPDATE attachment_materializations
           SET state = ?, updated_at = ?
           WHERE tenant_id = ? AND owner_principal_id = ?
             AND materialization_identity = ?`,
        )
        .run(state, now, scope.tenantId, scope.principalId, identity)
        .changes === 1
    );
  }
}
