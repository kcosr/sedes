import type Database from "better-sqlite3";
import type {
  OutputArtifactPersistence,
  OutputImageArtifactDescriptor,
  OutputImageMediaType,
  RetainedOutputImageBlob,
} from "../../output-artifacts/contracts.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

type ArtifactRow = {
  readonly artifactId: string;
  readonly mediaType: OutputImageMediaType;
  readonly byteSize: number;
  readonly sha256: string;
};

type BlobRow = {
  readonly tenantId: string;
  readonly principalId: string;
  readonly sha256: string;
  readonly byteSize: number;
};

const artifactColumns = `
  id AS artifactId,
  media_type AS mediaType,
  byte_length AS byteSize,
  blob_sha256 AS sha256
`;

function descriptor(row: ArtifactRow): OutputImageArtifactDescriptor {
  return Object.freeze({
    artifactId: row.artifactId,
    mediaType: row.mediaType,
    byteSize: row.byteSize,
    sha256: row.sha256,
  });
}

function sameDescriptor(
  artifact: OutputImageArtifactDescriptor,
  expected: Readonly<{
    mediaType: OutputImageMediaType;
    byteSize: number;
    sha256: string;
  }>,
): boolean {
  return (
    artifact.mediaType === expected.mediaType &&
    artifact.byteSize === expected.byteSize &&
    artifact.sha256 === expected.sha256
  );
}

export class OutputImageArtifactRepository implements OutputArtifactPersistence {
  constructor(readonly database: Database.Database) {}

  findByPublicationKeyHash(
    scope: RequestScope,
    threadId: string,
    publicationKeyHash: string,
  ): OutputImageArtifactDescriptor | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${artifactColumns}
          FROM output_image_artifacts
          WHERE tenant_id = ?
            AND owner_principal_id = ?
            AND application_thread_id = ?
            AND publication_key_hash = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId, publicationKeyHash) as
      ArtifactRow | undefined;
    return row ? descriptor(row) : undefined;
  }

  findById(
    scope: RequestScope,
    threadId: string,
    artifactId: string,
  ): OutputImageArtifactDescriptor | undefined {
    const row = this.database
      .prepare(
        `
          SELECT ${artifactColumns}
          FROM output_image_artifacts
          WHERE tenant_id = ?
            AND owner_principal_id = ?
            AND application_thread_id = ?
            AND id = ?
        `,
      )
      .get(scope.tenantId, scope.principalId, threadId, artifactId) as
      ArtifactRow | undefined;
    return row ? descriptor(row) : undefined;
  }

  recordImage(
    input: Readonly<{
      scope: RequestScope;
      threadId: string;
      artifactId: string;
      publicationKeyHash: string;
      mediaType: OutputImageMediaType;
      byteSize: number;
      sha256: string;
      now: number;
    }>,
  ): OutputImageArtifactDescriptor {
    return this.database.transaction(() => {
      this.database
        .prepare(
          `
            INSERT INTO output_image_blobs(
              tenant_id, owner_principal_id, sha256, byte_length, created_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(tenant_id, owner_principal_id, sha256) DO NOTHING
          `,
        )
        .run(
          input.scope.tenantId,
          input.scope.principalId,
          input.sha256,
          input.byteSize,
          input.now,
        );
      const blob = this.database
        .prepare(
          `
            SELECT byte_length AS byteSize
            FROM output_image_blobs
            WHERE tenant_id = ? AND owner_principal_id = ? AND sha256 = ?
          `,
        )
        .get(input.scope.tenantId, input.scope.principalId, input.sha256) as
        { byteSize: number } | undefined;
      if (!blob || blob.byteSize !== input.byteSize) {
        throw new DomainError(
          "conflict",
          "The output artifact blob identity conflicts with stored metadata.",
        );
      }

      this.database
        .prepare(
          `
            INSERT INTO output_image_artifacts(
              tenant_id, owner_principal_id, application_thread_id, id,
              publication_key_hash, media_type, byte_length, blob_sha256,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING
          `,
        )
        .run(
          input.scope.tenantId,
          input.scope.principalId,
          input.threadId,
          input.artifactId,
          input.publicationKeyHash,
          input.mediaType,
          input.byteSize,
          input.sha256,
          input.now,
        );
      const stored = this.findByPublicationKeyHash(
        input.scope,
        input.threadId,
        input.publicationKeyHash,
      );
      if (!stored || !sameDescriptor(stored, input)) {
        throw new DomainError(
          "conflict",
          "The output artifact publication identity is already in use.",
        );
      }
      return stored;
    })();
  }

  listRetainedBlobs(): readonly RetainedOutputImageBlob[] {
    return (
      this.database
        .prepare(
          `
            SELECT tenant_id AS tenantId, owner_principal_id AS principalId,
              sha256, byte_length AS byteSize
            FROM output_image_blobs
            ORDER BY tenant_id, owner_principal_id, sha256
          `,
        )
        .all() as BlobRow[]
    ).map((row) => ({
      scope: { tenantId: row.tenantId, principalId: row.principalId },
      sha256: row.sha256,
      byteSize: row.byteSize,
    }));
  }

  isBlobReferenced(scope: RequestScope, sha256: string): boolean {
    return Boolean(
      this.database
        .prepare(
          `
            SELECT 1
            FROM output_image_artifacts
            WHERE tenant_id = ?
              AND owner_principal_id = ?
              AND blob_sha256 = ?
            LIMIT 1
          `,
        )
        .get(scope.tenantId, scope.principalId, sha256),
    );
  }

  collectUnreferencedBlobs(): readonly RetainedOutputImageBlob[] {
    return this.database.transaction(() => {
      const rows = this.database
        .prepare(
          `
            SELECT blob.tenant_id AS tenantId,
              blob.owner_principal_id AS principalId,
              blob.sha256, blob.byte_length AS byteSize
            FROM output_image_blobs blob
            WHERE NOT EXISTS (
              SELECT 1 FROM output_image_artifacts artifact
              WHERE artifact.tenant_id = blob.tenant_id
                AND artifact.owner_principal_id = blob.owner_principal_id
                AND artifact.blob_sha256 = blob.sha256
            )
            ORDER BY blob.tenant_id, blob.owner_principal_id, blob.sha256
          `,
        )
        .all() as BlobRow[];
      const remove = this.database.prepare(
        `
          DELETE FROM output_image_blobs
          WHERE tenant_id = ? AND owner_principal_id = ? AND sha256 = ?
        `,
      );
      for (const row of rows) {
        remove.run(row.tenantId, row.principalId, row.sha256);
      }
      return rows.map((row) => ({
        scope: { tenantId: row.tenantId, principalId: row.principalId },
        sha256: row.sha256,
        byteSize: row.byteSize,
      }));
    })();
  }
}
