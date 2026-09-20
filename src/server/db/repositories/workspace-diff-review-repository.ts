import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

export type WorkspaceDiffEndpointKind = "revision" | "index" | "working_tree";
export type WorkspaceDiffReviewSemantic = "direct" | "merge_base";
export type WorkspaceDiffReviewState = "open" | "archived";
export type WorkspaceDiffCommentState =
  "draft" | "published" | "resolved" | "outdated" | "unplaced";
export type WorkspaceDiffReviewSide = "old" | "new";

export type WorkspaceDiffResolvedReviewIdentity = {
  readonly workspaceId: string;
  readonly rootId: string;
  /** Stable canonical repository identity, never a runtime repository ID. */
  readonly repositoryKey: string;
  readonly semantic: WorkspaceDiffReviewSemantic;
  readonly base: {
    readonly kind: WorkspaceDiffEndpointKind;
    readonly identity: string;
  };
  readonly head: {
    readonly kind: WorkspaceDiffEndpointKind;
    readonly identity: string;
  };
  readonly mergeBaseCommitHash?: string;
  /** Exact complete fingerprint for every mutable endpoint. */
  readonly fingerprint: string;
};

export type WorkspaceDiffReviewRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly workspaceId: string;
  readonly rootId: string;
  readonly id: string;
  readonly comparisonKey: string;
  readonly repositoryKey: string;
  readonly semantic: WorkspaceDiffReviewSemantic;
  readonly baseKind: WorkspaceDiffEndpointKind;
  readonly baseIdentity: string;
  readonly headKind: WorkspaceDiffEndpointKind;
  readonly headIdentity: string;
  readonly mergeBaseCommitHash: string | null;
  readonly fingerprint: string;
  readonly title: string;
  readonly summary: string;
  readonly state: WorkspaceDiffReviewState;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type WorkspaceDiffCommentAnchor = {
  readonly fileIdentity: string;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly side: WorkspaceDiffReviewSide;
  readonly startLine: number;
  readonly endLine: number;
  readonly oldContentId: string | null;
  readonly newContentId: string | null;
  readonly selectedText: string;
  readonly selectedTextDigest: string;
  readonly hunkFingerprint: string;
};

export type WorkspaceDiffReviewCommentRecord = WorkspaceDiffCommentAnchor & {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly reviewId: string;
  readonly id: string;
  readonly body: string;
  readonly state: WorkspaceDiffCommentState;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
};

export type WorkspaceDiffReviewedFileRecord = {
  readonly tenantId: string;
  readonly ownerPrincipalId: string;
  readonly reviewId: string;
  readonly fileIdentity: string;
  readonly filePath: string;
  readonly contentFingerprint: string;
  readonly reviewed: boolean;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type WorkspaceDiffReviewMutationResult<T> = {
  readonly review: WorkspaceDiffReviewRecord;
  readonly value: T;
};

type ReviewedFileRow = Omit<WorkspaceDiffReviewedFileRecord, "reviewed"> & {
  readonly reviewed: 0 | 1;
};
type Receipt = {
  readonly operationKind: string;
  readonly requestFingerprint: string;
  readonly resultJson: string;
};

const reviewColumns = `tenant_id AS tenantId, owner_principal_id AS ownerPrincipalId,
  workspace_id AS workspaceId, root_id AS rootId, id,
  comparison_key AS comparisonKey, repository_key AS repositoryKey, semantic,
  base_kind AS baseKind, base_identity AS baseIdentity,
  head_kind AS headKind, head_identity AS headIdentity,
  merge_base_commit_hash AS mergeBaseCommitHash, fingerprint,
  title, summary, state, revision, created_at AS createdAt, updated_at AS updatedAt`;
const commentColumns = `tenant_id AS tenantId, owner_principal_id AS ownerPrincipalId,
  review_id AS reviewId, id, file_identity AS fileIdentity,
  old_path AS oldPath, new_path AS newPath, side,
  start_line AS startLine, end_line AS endLine,
  old_content_id AS oldContentId, new_content_id AS newContentId,
  selected_text AS selectedText, selected_text_digest AS selectedTextDigest,
  hunk_fingerprint AS hunkFingerprint, body, state, revision,
  created_at AS createdAt, updated_at AS updatedAt, deleted_at AS deletedAt`;
const reviewedColumns = `tenant_id AS tenantId, owner_principal_id AS ownerPrincipalId,
  review_id AS reviewId, file_identity AS fileIdentity, file_path AS filePath,
  content_fingerprint AS contentFingerprint, reviewed, revision,
  created_at AS createdAt, updated_at AS updatedAt`;

export function workspaceDiffComparisonKey(
  identity: WorkspaceDiffResolvedReviewIdentity,
): string {
  return fingerprint("workspace_diff_review_identity", [
    identity.rootId,
    identity.repositoryKey,
    identity.semantic,
    identity.base.kind,
    identity.base.identity,
    identity.head.kind,
    identity.head.identity,
    identity.mergeBaseCommitHash ?? null,
    identity.fingerprint,
  ]);
}

export class WorkspaceDiffReviewRepository {
  static readonly maximumReviewsPerWorkspace = 1_000;
  static readonly maximumCommentsPerReview = 5_000;
  static readonly maximumReviewedFilesPerReview = 10_000;

  constructor(readonly database: Database.Database) {}

  listReviews(
    scope: RequestScope,
    input: {
      readonly workspaceId: string;
      readonly rootId: string;
      readonly repositoryKey?: string;
    },
  ): readonly WorkspaceDiffReviewRecord[] {
    const repositoryClause =
      input.repositoryKey === undefined ? "" : " AND repository_key = ?";
    return this.database
      .prepare(
        `SELECT ${reviewColumns} FROM workspace_diff_reviews
      WHERE tenant_id = ? AND owner_principal_id = ? AND workspace_id = ? AND root_id = ?
      ${repositoryClause} ORDER BY updated_at DESC, id ASC`,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        input.workspaceId,
        input.rootId,
        ...(input.repositoryKey === undefined ? [] : [input.repositoryKey]),
      ) as WorkspaceDiffReviewRecord[];
  }

  getReview(scope: RequestScope, reviewId: string): WorkspaceDiffReviewRecord {
    const review = this.database
      .prepare(
        `SELECT ${reviewColumns} FROM workspace_diff_reviews
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ?`,
      )
      .get(scope.tenantId, scope.principalId, reviewId) as
      WorkspaceDiffReviewRecord | undefined;
    if (!review)
      throw new DomainError(
        "not_found",
        "The workspace diff review was not found.",
      );
    return review;
  }

  openReview(
    scope: RequestScope,
    identity: WorkspaceDiffResolvedReviewIdentity,
    input: {
      readonly title: string;
      readonly summary: string;
      readonly mutationId: string;
      readonly now: number;
    },
  ): WorkspaceDiffReviewRecord {
    const comparisonKey = workspaceDiffComparisonKey(identity);
    const requestFingerprint = fingerprint("open_workspace_diff_review", [
      identity,
      input.title,
      input.summary,
    ]);
    return this.database
      .transaction(() => {
        const replay = this.#replay<WorkspaceDiffReviewRecord>(
          scope,
          input.mutationId,
          "open_workspace_diff_review",
          requestFingerprint,
        );
        if (replay) return replay;
        const existing = this.database
          .prepare(
            `SELECT ${reviewColumns} FROM workspace_diff_reviews
        WHERE tenant_id = ? AND owner_principal_id = ? AND workspace_id = ? AND comparison_key = ?`,
          )
          .get(
            scope.tenantId,
            scope.principalId,
            identity.workspaceId,
            comparisonKey,
          ) as WorkspaceDiffReviewRecord | undefined;
        if (existing) {
          this.#receipt(
            scope,
            input.mutationId,
            "open_workspace_diff_review",
            requestFingerprint,
            existing,
            input.now,
          );
          return existing;
        }
        const reviewCount = this.database
          .prepare(
            `SELECT count(*) AS count
        FROM workspace_diff_reviews WHERE tenant_id = ? AND owner_principal_id = ?
          AND workspace_id = ?`,
          )
          .get(scope.tenantId, scope.principalId, identity.workspaceId) as {
          readonly count: number;
        };
        if (
          reviewCount.count >=
          WorkspaceDiffReviewRepository.maximumReviewsPerWorkspace
        ) {
          throw new DomainError(
            "conflict",
            "The workspace has reached its diff-review limit.",
          );
        }
        const id = randomUUID();
        this.database
          .prepare(
            `INSERT INTO workspace_diff_reviews(
        tenant_id, owner_principal_id, workspace_id, root_id, id, comparison_key,
        repository_key, semantic, base_kind, base_identity, head_kind, head_identity,
        merge_base_commit_hash, fingerprint, title, summary, state, revision,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?, ?)`,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            identity.workspaceId,
            identity.rootId,
            id,
            comparisonKey,
            identity.repositoryKey,
            identity.semantic,
            identity.base.kind,
            identity.base.identity,
            identity.head.kind,
            identity.head.identity,
            identity.mergeBaseCommitHash ?? null,
            identity.fingerprint,
            input.title,
            input.summary,
            input.now,
            input.now,
          );
        const review = this.getReview(scope, id);
        this.#receipt(
          scope,
          input.mutationId,
          "open_workspace_diff_review",
          requestFingerprint,
          review,
          input.now,
        );
        return review;
      })
      .immediate();
  }

  updateReview(
    scope: RequestScope,
    reviewId: string,
    input: {
      readonly title: string;
      readonly summary: string;
      readonly state: WorkspaceDiffReviewState;
      readonly expectedRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): WorkspaceDiffReviewRecord {
    const requestFingerprint = fingerprint("update_workspace_diff_review", [
      reviewId,
      input.title,
      input.summary,
      input.state,
      input.expectedRevision,
    ]);
    return this.database
      .transaction(() => {
        const replay = this.#replay<WorkspaceDiffReviewRecord>(
          scope,
          input.mutationId,
          "update_workspace_diff_review",
          requestFingerprint,
        );
        if (replay) return replay;
        this.getReview(scope, reviewId);
        const changed = this.database
          .prepare(
            `UPDATE workspace_diff_reviews
        SET title = ?, summary = ?, state = ?, revision = revision + 1, updated_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND id = ? AND revision = ?`,
          )
          .run(
            input.title,
            input.summary,
            input.state,
            input.now,
            scope.tenantId,
            scope.principalId,
            reviewId,
            input.expectedRevision,
          );
        if (changed.changes !== 1) throw revisionConflict();
        const review = this.getReview(scope, reviewId);
        this.#receipt(
          scope,
          input.mutationId,
          "update_workspace_diff_review",
          requestFingerprint,
          review,
          input.now,
        );
        return review;
      })
      .immediate();
  }

  listComments(
    scope: RequestScope,
    reviewId: string,
  ): readonly WorkspaceDiffReviewCommentRecord[] {
    this.getReview(scope, reviewId);
    return this.database
      .prepare(
        `SELECT ${commentColumns} FROM workspace_diff_review_comments
      WHERE tenant_id = ? AND owner_principal_id = ? AND review_id = ? AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC`,
      )
      .all(
        scope.tenantId,
        scope.principalId,
        reviewId,
      ) as WorkspaceDiffReviewCommentRecord[];
  }

  createComment(
    scope: RequestScope,
    reviewId: string,
    input: WorkspaceDiffCommentAnchor & {
      readonly body: string;
      readonly state: WorkspaceDiffCommentState;
      readonly expectedReviewRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewCommentRecord> {
    const requestFingerprint = fingerprint("create_workspace_diff_comment", [
      reviewId,
      input.fileIdentity,
      input.oldPath,
      input.newPath,
      input.side,
      input.startLine,
      input.endLine,
      input.oldContentId,
      input.newContentId,
      input.selectedText,
      input.selectedTextDigest,
      input.hunkFingerprint,
      input.body,
      input.state,
      input.expectedReviewRevision,
    ]);
    return this.database
      .transaction(() => {
        const replay = this.#replay<
          WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewCommentRecord>
        >(
          scope,
          input.mutationId,
          "create_workspace_diff_comment",
          requestFingerprint,
        );
        if (replay) return replay;
        const review = this.#bumpReview(
          scope,
          reviewId,
          input.expectedReviewRevision,
          input.now,
        );
        const commentCount = this.database
          .prepare(
            `SELECT count(*) AS count
        FROM workspace_diff_review_comments WHERE tenant_id = ? AND owner_principal_id = ?
          AND review_id = ? AND deleted_at IS NULL`,
          )
          .get(scope.tenantId, scope.principalId, reviewId) as {
          readonly count: number;
        };
        if (
          commentCount.count >=
          WorkspaceDiffReviewRepository.maximumCommentsPerReview
        ) {
          throw new DomainError(
            "conflict",
            "The diff review has reached its comment limit.",
          );
        }
        const id = randomUUID();
        this.database
          .prepare(
            `INSERT INTO workspace_diff_review_comments(
        tenant_id, owner_principal_id, review_id, id, file_identity, old_path, new_path,
        side, start_line, end_line, old_content_id, new_content_id, selected_text,
        selected_text_digest, hunk_fingerprint, body, state, revision,
        created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)`,
          )
          .run(
            scope.tenantId,
            scope.principalId,
            reviewId,
            id,
            input.fileIdentity,
            input.oldPath,
            input.newPath,
            input.side,
            input.startLine,
            input.endLine,
            input.oldContentId,
            input.newContentId,
            input.selectedText,
            input.selectedTextDigest,
            input.hunkFingerprint,
            input.body,
            input.state,
            input.now,
            input.now,
          );
        const value = this.#getComment(scope, reviewId, id);
        const result = { review, value };
        this.#receipt(
          scope,
          input.mutationId,
          "create_workspace_diff_comment",
          requestFingerprint,
          result,
          input.now,
        );
        return result;
      })
      .immediate();
  }

  updateComment(
    scope: RequestScope,
    reviewId: string,
    commentId: string,
    input: {
      readonly body: string;
      readonly state: WorkspaceDiffCommentState;
      readonly expectedReviewRevision: number;
      readonly expectedCommentRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewCommentRecord> {
    const requestFingerprint = fingerprint("update_workspace_diff_comment", [
      reviewId,
      commentId,
      input.body,
      input.state,
      input.expectedReviewRevision,
      input.expectedCommentRevision,
    ]);
    return this.database
      .transaction(() => {
        const replay = this.#replay<
          WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewCommentRecord>
        >(
          scope,
          input.mutationId,
          "update_workspace_diff_comment",
          requestFingerprint,
        );
        if (replay) return replay;
        this.#getComment(scope, reviewId, commentId);
        const review = this.#bumpReview(
          scope,
          reviewId,
          input.expectedReviewRevision,
          input.now,
        );
        const changed = this.database
          .prepare(
            `UPDATE workspace_diff_review_comments
        SET body = ?, state = ?, revision = revision + 1, updated_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND review_id = ? AND id = ?
          AND revision = ? AND deleted_at IS NULL`,
          )
          .run(
            input.body,
            input.state,
            input.now,
            scope.tenantId,
            scope.principalId,
            reviewId,
            commentId,
            input.expectedCommentRevision,
          );
        if (changed.changes !== 1) throw revisionConflict();
        const value = this.#getComment(scope, reviewId, commentId);
        const result = { review, value };
        this.#receipt(
          scope,
          input.mutationId,
          "update_workspace_diff_comment",
          requestFingerprint,
          result,
          input.now,
        );
        return result;
      })
      .immediate();
  }

  deleteComment(
    scope: RequestScope,
    reviewId: string,
    commentId: string,
    input: {
      readonly expectedReviewRevision: number;
      readonly expectedCommentRevision: number;
      readonly mutationId: string;
      readonly now: number;
    },
  ): WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewCommentRecord> {
    const requestFingerprint = fingerprint("delete_workspace_diff_comment", [
      reviewId,
      commentId,
      input.expectedReviewRevision,
      input.expectedCommentRevision,
    ]);
    return this.database
      .transaction(() => {
        const replay = this.#replay<
          WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewCommentRecord>
        >(
          scope,
          input.mutationId,
          "delete_workspace_diff_comment",
          requestFingerprint,
        );
        if (replay) return replay;
        this.#getComment(scope, reviewId, commentId);
        const review = this.#bumpReview(
          scope,
          reviewId,
          input.expectedReviewRevision,
          input.now,
        );
        const changed = this.database
          .prepare(
            `UPDATE workspace_diff_review_comments
        SET revision = revision + 1, updated_at = ?, deleted_at = ?
        WHERE tenant_id = ? AND owner_principal_id = ? AND review_id = ? AND id = ?
          AND revision = ? AND deleted_at IS NULL`,
          )
          .run(
            input.now,
            input.now,
            scope.tenantId,
            scope.principalId,
            reviewId,
            commentId,
            input.expectedCommentRevision,
          );
        if (changed.changes !== 1) throw revisionConflict();
        const value = this.#getComment(scope, reviewId, commentId, true);
        const result = { review, value };
        this.#receipt(
          scope,
          input.mutationId,
          "delete_workspace_diff_comment",
          requestFingerprint,
          result,
          input.now,
        );
        return result;
      })
      .immediate();
  }

  listReviewedFiles(
    scope: RequestScope,
    reviewId: string,
  ): readonly WorkspaceDiffReviewedFileRecord[] {
    this.getReview(scope, reviewId);
    const rows = this.database
      .prepare(
        `SELECT ${reviewedColumns} FROM workspace_diff_reviewed_files
      WHERE tenant_id = ? AND owner_principal_id = ? AND review_id = ?
      ORDER BY file_path ASC, file_identity ASC`,
      )
      .all(scope.tenantId, scope.principalId, reviewId) as ReviewedFileRow[];
    return rows.map(({ reviewed, ...row }) => ({
      ...row,
      reviewed: reviewed === 1,
    }));
  }

  setReviewedFile(
    scope: RequestScope,
    reviewId: string,
    input: {
      readonly fileIdentity: string;
      readonly filePath: string;
      readonly contentFingerprint: string;
      readonly reviewed: boolean;
      readonly expectedReviewRevision: number;
      readonly expectedFileRevision: number | null;
      readonly mutationId: string;
      readonly now: number;
    },
  ): WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewedFileRecord> {
    const requestFingerprint = fingerprint("set_workspace_diff_reviewed_file", [
      reviewId,
      input.fileIdentity,
      input.filePath,
      input.contentFingerprint,
      input.reviewed,
      input.expectedReviewRevision,
      input.expectedFileRevision,
    ]);
    return this.database
      .transaction(() => {
        const replay = this.#replay<
          WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewedFileRecord>
        >(
          scope,
          input.mutationId,
          "set_workspace_diff_reviewed_file",
          requestFingerprint,
        );
        if (replay) return replay;
        const existing = this.#findReviewed(
          scope,
          reviewId,
          input.fileIdentity,
        );
        if ((existing?.revision ?? null) !== input.expectedFileRevision)
          throw revisionConflict();
        if (
          existing &&
          existing.filePath === input.filePath &&
          existing.contentFingerprint === input.contentFingerprint &&
          existing.reviewed === input.reviewed
        ) {
          const review = this.getReview(scope, reviewId);
          if (review.revision !== input.expectedReviewRevision)
            throw revisionConflict();
          const result = { review, value: existing };
          this.#receipt(
            scope,
            input.mutationId,
            "set_workspace_diff_reviewed_file",
            requestFingerprint,
            result,
            input.now,
          );
          return result;
        }
        const review = this.#bumpReview(
          scope,
          reviewId,
          input.expectedReviewRevision,
          input.now,
        );
        if (!existing) {
          const fileCount = this.database
            .prepare(
              `SELECT count(*) AS count
          FROM workspace_diff_reviewed_files WHERE tenant_id = ? AND owner_principal_id = ?
            AND review_id = ?`,
            )
            .get(scope.tenantId, scope.principalId, reviewId) as {
            readonly count: number;
          };
          if (
            fileCount.count >=
            WorkspaceDiffReviewRepository.maximumReviewedFilesPerReview
          ) {
            throw new DomainError(
              "conflict",
              "The diff review has reached its reviewed-file limit.",
            );
          }
          this.database
            .prepare(
              `INSERT INTO workspace_diff_reviewed_files(
          tenant_id, owner_principal_id, review_id, file_identity, file_path,
          content_fingerprint, reviewed, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
            )
            .run(
              scope.tenantId,
              scope.principalId,
              reviewId,
              input.fileIdentity,
              input.filePath,
              input.contentFingerprint,
              input.reviewed ? 1 : 0,
              input.now,
              input.now,
            );
        } else {
          this.database
            .prepare(
              `UPDATE workspace_diff_reviewed_files SET file_path = ?,
          content_fingerprint = ?, reviewed = ?, revision = revision + 1, updated_at = ?
          WHERE tenant_id = ? AND owner_principal_id = ? AND review_id = ?
            AND file_identity = ? AND revision = ?`,
            )
            .run(
              input.filePath,
              input.contentFingerprint,
              input.reviewed ? 1 : 0,
              input.now,
              scope.tenantId,
              scope.principalId,
              reviewId,
              input.fileIdentity,
              input.expectedFileRevision,
            );
        }
        const value = this.#findReviewed(scope, reviewId, input.fileIdentity)!;
        const result = { review, value };
        this.#receipt(
          scope,
          input.mutationId,
          "set_workspace_diff_reviewed_file",
          requestFingerprint,
          result,
          input.now,
        );
        return result;
      })
      .immediate();
  }

  #getComment(
    scope: RequestScope,
    reviewId: string,
    commentId: string,
    includeDeleted = false,
  ): WorkspaceDiffReviewCommentRecord {
    const comment = this.database
      .prepare(
        `SELECT ${commentColumns} FROM workspace_diff_review_comments
      WHERE tenant_id = ? AND owner_principal_id = ? AND review_id = ? AND id = ?
      ${includeDeleted ? "" : "AND deleted_at IS NULL"}`,
      )
      .get(scope.tenantId, scope.principalId, reviewId, commentId) as
      WorkspaceDiffReviewCommentRecord | undefined;
    if (!comment)
      throw new DomainError(
        "not_found",
        "The diff review comment was not found.",
      );
    return comment;
  }

  #findReviewed(
    scope: RequestScope,
    reviewId: string,
    fileIdentity: string,
  ): WorkspaceDiffReviewedFileRecord | undefined {
    const row = this.database
      .prepare(
        `SELECT ${reviewedColumns} FROM workspace_diff_reviewed_files
      WHERE tenant_id = ? AND owner_principal_id = ? AND review_id = ? AND file_identity = ?`,
      )
      .get(scope.tenantId, scope.principalId, reviewId, fileIdentity) as
      ReviewedFileRow | undefined;
    if (!row) return undefined;
    const { reviewed, ...record } = row;
    return { ...record, reviewed: reviewed === 1 };
  }

  #bumpReview(
    scope: RequestScope,
    reviewId: string,
    expectedRevision: number,
    now: number,
  ): WorkspaceDiffReviewRecord {
    const changed = this.database
      .prepare(
        `UPDATE workspace_diff_reviews
      SET revision = revision + 1, updated_at = ?
      WHERE tenant_id = ? AND owner_principal_id = ? AND id = ? AND revision = ?`,
      )
      .run(now, scope.tenantId, scope.principalId, reviewId, expectedRevision);
    if (changed.changes !== 1) {
      this.getReview(scope, reviewId);
      throw revisionConflict();
    }
    return this.getReview(scope, reviewId);
  }

  #replay<T>(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
  ): T | undefined {
    const receipt = this.database
      .prepare(
        `SELECT operation_kind AS operationKind,
      request_fingerprint AS requestFingerprint, result_json AS resultJson
      FROM workspace_diff_review_mutation_receipts
      WHERE tenant_id = ? AND principal_id = ? AND mutation_id = ?`,
      )
      .get(scope.tenantId, scope.principalId, mutationId) as
      Receipt | undefined;
    if (!receipt) return undefined;
    if (
      receipt.operationKind !== operationKind ||
      receipt.requestFingerprint !== requestFingerprint
    ) {
      throw new DomainError(
        "conflict",
        "The mutation ID was reused for a different diff-review operation.",
      );
    }
    return (JSON.parse(receipt.resultJson) as { readonly result: T }).result;
  }

  #receipt(
    scope: RequestScope,
    mutationId: string,
    operationKind: string,
    requestFingerprint: string,
    result: unknown,
    now: number,
  ): void {
    this.database
      .prepare(
        `INSERT INTO workspace_diff_review_mutation_receipts(
      tenant_id, principal_id, mutation_id, operation_kind, request_fingerprint,
      result_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        scope.tenantId,
        scope.principalId,
        mutationId,
        operationKind,
        requestFingerprint,
        JSON.stringify({ version: 1, result }),
        now,
      );
  }
}

function fingerprint(operation: string, parts: readonly unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify([operation, ...parts]))
    .digest("hex");
}

function revisionConflict(): DomainError {
  return new DomainError(
    "conflict",
    "The workspace diff review changed in another client.",
  );
}
