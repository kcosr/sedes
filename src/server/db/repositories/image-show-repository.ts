import type Database from "better-sqlite3";
import { applicationPublicationAnchorSchema, type ApplicationPublicationAnchor } from "../../../shared/protocol/application-publications.js";
import { MAXIMUM_NORMALIZED_TIMELINE_ITEMS } from "../../../shared/protocol/conversation.js";
import { normalizedImageSchema, type NormalizedImage } from "../../../shared/protocol/output-artifacts.js";
import type { ImagePublication } from "../../conversations/application-publication-projection.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import { nextApplicationPublicationTime } from "./application-publication-clock.js";
import { ImageShowError } from "../../output-artifacts/image-show-error.js";

export type ShownImage = Extract<NormalizedImage, { representation: "artifact" }>;
interface Row { image_json: string; input_sha256: string; binding_sha256: string; invocation_id: string; anchor_json: string; created_at: number; }
export interface ImageShowReceipt extends ImagePublication { readonly image: ShownImage; readonly inputSha256: string; readonly bindingSha256: string; }

function receipt(row: Row): ImageShowReceipt {
  const image = normalizedImageSchema.parse(JSON.parse(row.image_json));
  if (image.representation !== "artifact") throw new Error("shown_image_artifact_required");
  return { image, inputSha256: row.input_sha256, bindingSha256: row.binding_sha256, invocationId: row.invocation_id,
    anchor: applicationPublicationAnchorSchema.parse(JSON.parse(row.anchor_json)), createdAt: new Date(row.created_at).toISOString() };
}

/** Immutable conversation associations, never a catalog or a source-path store. */
export class ImageShowRepository {
  constructor(readonly database: Database.Database) {}

  find(scope: RequestScope, threadId: string, invocationId: string): ImageShowReceipt | undefined {
    const row = this.database.prepare(`SELECT image_json,input_sha256,binding_sha256,invocation_id,anchor_json,created_at FROM shown_images
      WHERE tenant_id=? AND owner_principal_id=? AND thread_id=? AND invocation_id=?`)
      .get(scope.tenantId, scope.principalId, threadId, invocationId) as Row | undefined;
    return row ? receipt(row) : undefined;
  }

  publications(scope: RequestScope, threadId: string, turnIds?: readonly string[]): readonly ImagePublication[] {
    if (!this.database.prepare(`SELECT 1 FROM application_threads WHERE tenant_id=? AND owner_principal_id=? AND id=?`)
      .get(scope.tenantId, scope.principalId, threadId)) throw new DomainError("not_found", "The thread was not found.");
    if (turnIds?.length === 0) return [];
    const filter = turnIds ? ` AND anchor_turn_id IN (${turnIds.map(() => "?").join(",")})` : "";
    return (this.database.prepare(`SELECT image_json,input_sha256,binding_sha256,invocation_id,anchor_json,created_at FROM shown_images
      WHERE tenant_id=? AND owner_principal_id=? AND thread_id=?${filter} ORDER BY created_at,invocation_id LIMIT ${MAXIMUM_NORMALIZED_TIMELINE_ITEMS}`)
      .all(scope.tenantId, scope.principalId, threadId, ...(turnIds ?? [])) as Row[]).map(receipt);
  }

  record(scope: RequestScope, threadId: string, input: { readonly invocationId: string; readonly inputSha256: string; readonly bindingSha256: string;
    readonly image: ShownImage; readonly anchor: ApplicationPublicationAnchor; readonly assertCurrent: () => void }, now = Date.now()): ImageShowReceipt {
    return this.database.transaction(() => {
      input.assertCurrent();
      const existing = this.find(scope, threadId, input.invocationId);
      if (existing) {
        if (existing.inputSha256 !== input.inputSha256 || existing.bindingSha256 !== input.bindingSha256) throw new DomainError("conflict", "The image request ID was already used with different input or a different binding.");
        return existing;
      }
      const anchor = applicationPublicationAnchorSchema.parse(input.anchor);
      const image = normalizedImageSchema.parse(input.image);
      if (image.representation !== "artifact") throw new Error("shown_image_artifact_required");
      const artifact = this.database.prepare(`SELECT 1 FROM output_image_artifacts
        WHERE tenant_id=? AND owner_principal_id=? AND application_thread_id=? AND id=? AND media_type=? AND byte_length=? AND blob_sha256=?`)
        .get(scope.tenantId, scope.principalId, threadId, image.artifactId, image.mimeType, image.byteSize, image.sha256);
      if (!artifact) throw new DomainError("not_found", "The retained image was not found in the source thread.");
      const count = this.database.prepare(`SELECT COUNT(*) AS count FROM shown_images
        WHERE tenant_id=? AND owner_principal_id=? AND thread_id=? AND anchor_turn_id=?`)
        .get(scope.tenantId, scope.principalId, threadId, anchor.turnId) as { count: number };
      if (count.count >= 1000) throw new ImageShowError("turn_limit");
      now = nextApplicationPublicationTime(this.database, scope, threadId, now);
      this.database.prepare(`INSERT INTO shown_images(tenant_id,owner_principal_id,thread_id,invocation_id,input_sha256,binding_sha256,artifact_id,image_json,anchor_turn_id,anchor_json,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(scope.tenantId, scope.principalId, threadId, input.invocationId, input.inputSha256, input.bindingSha256,
        image.artifactId, JSON.stringify(image), anchor.turnId, JSON.stringify(anchor), now);
      return this.find(scope, threadId, input.invocationId)!;
    })();
  }
}
