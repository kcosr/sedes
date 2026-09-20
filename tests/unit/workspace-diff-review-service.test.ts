import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { workspaceDiffReviewsMigration } from "../../src/server/db/migrations/053-workspace-diff-reviews.js";
import { WorkspaceDiffReviewRepository } from "../../src/server/db/repositories/workspace-diff-review-repository.js";
import { WorkspaceDiffReviewService } from "../../src/server/domain/workspace-diff-review-service.js";

const scope = {
  tenantId: "019196f7-a0a8-7bc4-a89b-8cf013978403",
  principalId: "019196f7-a0a8-7bc4-a89b-8cf013978404",
} as const;
const identity = {
  workspaceId: "workspace-review",
  rootId: "primary",
  repositoryKey: "canonical-repository-key",
  semantic: "merge_base" as const,
  base: { kind: "revision" as const, identity: "1".repeat(40) },
  head: { kind: "revision" as const, identity: "2".repeat(40) },
  mergeBaseCommitHash: "3".repeat(40),
  fingerprint: "exact-comparison-fingerprint-1",
};
const selectedText = "const answer = 42;";
const anchor = {
  fileIdentity: "stable-file-identity",
  oldPath: "src/example.ts",
  newPath: "src/example.ts",
  side: "new" as const,
  startLine: 12,
  endLine: 12,
  oldContentId: "old-blob-identity",
  newContentId: "new-blob-identity",
  selectedText,
  selectedTextDigest: createHash("sha256").update(selectedText).digest("hex"),
  hunkFingerprint: "exact-hunk-fingerprint",
};

function fixture() {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.exec(`
    CREATE TABLE principals (tenant_id TEXT NOT NULL, id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, id)) STRICT;
    CREATE TABLE workspaces (tenant_id TEXT NOT NULL, owner_principal_id TEXT NOT NULL,
      id TEXT NOT NULL, PRIMARY KEY (tenant_id, id),
      UNIQUE (tenant_id, owner_principal_id, id)) STRICT;
  `);
  database
    .prepare("INSERT INTO principals VALUES (?, ?)")
    .run(scope.tenantId, scope.principalId);
  database
    .prepare("INSERT INTO workspaces VALUES (?, ?, ?)")
    .run(scope.tenantId, scope.principalId, identity.workspaceId);
  database.exec(workspaceDiffReviewsMigration.sql);
  const reviews = new WorkspaceDiffReviewRepository(database);
  let clock = 10;
  const inventory = { getWorkspace: () => ({ id: identity.workspaceId }) };
  const roots = {
    get: () => {
      throw new Error("primary is not supplemental");
    },
  };
  const linkedWorktrees = { find: () => undefined };
  const service = new WorkspaceDiffReviewService(
    inventory as never,
    roots as never,
    linkedWorktrees as never,
    reviews,
    () => clock++,
  );
  return {
    database,
    reviews,
    service,
    inventory,
    roots,
    linkedWorktrees,
    now: () => clock++,
  };
}

describe("WorkspaceDiffReviewService", () => {
  it("reopens stable resolved reviews after repository reconstruction", () => {
    const current = fixture();
    try {
      const opened = current.service.openReview(scope, identity, {
        title: "Peer review",
        mutationId: "open-review-1",
      });
      expect(opened).toMatchObject({
        workspaceId: identity.workspaceId,
        repositoryKey: identity.repositoryKey,
        semantic: identity.semantic,
        baseIdentity: identity.base.identity,
        headIdentity: identity.head.identity,
        mergeBaseCommitHash: identity.mergeBaseCommitHash,
        fingerprint: identity.fingerprint,
        revision: 1,
      });
      expect(opened.comparisonKey).toMatch(/^[0-9a-f]{64}$/u);
      expect(
        current.service.openReview(scope, identity, {
          title: "Peer review",
          mutationId: "open-review-1",
        }),
      ).toEqual(opened);

      const restarted = new WorkspaceDiffReviewService(
        current.inventory as never,
        current.roots as never,
        current.linkedWorktrees as never,
        new WorkspaceDiffReviewRepository(current.database),
        current.now,
      );
      expect(
        restarted.listReviews(scope, {
          workspaceId: identity.workspaceId,
          rootId: identity.rootId,
          repositoryKey: identity.repositoryKey,
        }),
      ).toEqual([opened]);
      expect(
        current.reviews.listReviews(
          { ...scope, principalId: "different-principal" },
          { workspaceId: identity.workspaceId, rootId: identity.rootId },
        ),
      ).toEqual([]);
    } finally {
      current.database.close();
    }
  });

  it("uses review and comment CAS while preserving immutable exact anchors", () => {
    const current = fixture();
    try {
      const review = current.service.openReview(scope, identity, {
        mutationId: "open-for-comments",
      });
      const created = current.service.createComment(scope, review.id, {
        ...anchor,
        body: "Please explain this constant.",
        expectedReviewRevision: 1,
        mutationId: "create-comment-1",
      });
      expect(created.review.revision).toBe(2);
      expect(created.value).toMatchObject({
        ...anchor,
        state: "draft",
        revision: 1,
      });
      expect(
        current.service.createComment(scope, review.id, {
          ...anchor,
          body: "Please explain this constant.",
          expectedReviewRevision: 1,
          mutationId: "create-comment-1",
        }),
      ).toEqual(created);

      const outdated = current.service.updateComment(
        scope,
        review.id,
        created.value.id,
        {
          body: "This anchor is no longer in the current snapshot.",
          state: "outdated",
          expectedReviewRevision: 2,
          expectedCommentRevision: 1,
          mutationId: "outdate-comment-1",
        },
      );
      expect(outdated.review.revision).toBe(3);
      expect(outdated.value).toMatchObject({
        ...anchor,
        state: "outdated",
        revision: 2,
      });
      expect(() =>
        current.service.updateComment(scope, review.id, created.value.id, {
          body: "stale edit",
          state: "published",
          expectedReviewRevision: 2,
          expectedCommentRevision: 1,
          mutationId: "stale-comment-edit",
        }),
      ).toThrow(/changed in another client/i);
      expect(() =>
        current.database
          .prepare(
            "UPDATE workspace_diff_review_comments SET start_line = 13 WHERE id = ?",
          )
          .run(created.value.id),
      ).toThrow(/anchors are immutable/i);
    } finally {
      current.database.close();
    }
  });

  it("keeps a deletion tombstone, replays it, and fences reviewed files", () => {
    const current = fixture();
    try {
      const review = current.service.openReview(scope, identity, {
        mutationId: "open-delete",
      });
      const created = current.service.createComment(scope, review.id, {
        ...anchor,
        body: "temporary",
        expectedReviewRevision: 1,
        mutationId: "create-delete",
      });
      const deleted = current.service.deleteComment(
        scope,
        review.id,
        created.value.id,
        {
          expectedReviewRevision: 2,
          expectedCommentRevision: 1,
          mutationId: "delete-comment",
        },
      );
      expect(deleted.review.revision).toBe(3);
      expect(deleted.value.deletedAt).not.toBeNull();
      expect(
        current.service.deleteComment(scope, review.id, created.value.id, {
          expectedReviewRevision: 2,
          expectedCommentRevision: 1,
          mutationId: "delete-comment",
        }),
      ).toEqual(deleted);
      expect(current.service.listComments(scope, review.id)).toEqual([]);

      const reviewed = current.service.setReviewedFile(scope, review.id, {
        fileIdentity: anchor.fileIdentity,
        filePath: anchor.newPath!,
        contentFingerprint: "complete-patch-fingerprint",
        reviewed: true,
        expectedReviewRevision: 3,
        expectedFileRevision: null,
        mutationId: "review-file",
      });
      expect(reviewed.review.revision).toBe(4);
      expect(reviewed.value).toMatchObject({ reviewed: true, revision: 1 });
      expect(
        current.service.setReviewedFile(scope, review.id, {
          fileIdentity: anchor.fileIdentity,
          filePath: anchor.newPath!,
          contentFingerprint: "complete-patch-fingerprint",
          reviewed: true,
          expectedReviewRevision: 3,
          expectedFileRevision: null,
          mutationId: "review-file",
        }),
      ).toEqual(reviewed);
      const identicalPut = current.service.setReviewedFile(scope, review.id, {
        fileIdentity: anchor.fileIdentity,
        filePath: anchor.newPath!,
        contentFingerprint: "complete-patch-fingerprint",
        reviewed: true,
        expectedReviewRevision: 4,
        expectedFileRevision: 1,
        mutationId: "review-file-identical-put",
      });
      expect(identicalPut).toEqual(reviewed);
      expect(
        current.service.setReviewedFile(scope, review.id, {
          fileIdentity: anchor.fileIdentity,
          filePath: anchor.newPath!,
          contentFingerprint: "complete-patch-fingerprint",
          reviewed: true,
          expectedReviewRevision: 4,
          expectedFileRevision: 1,
          mutationId: "review-file-identical-put",
        }),
      ).toEqual(reviewed);
      expect(current.service.getReview(scope, review.id).revision).toBe(4);
      expect(current.service.listReviewedFiles(scope, review.id)).toEqual([
        reviewed.value,
      ]);
      expect(() =>
        current.service.setReviewedFile(scope, review.id, {
          fileIdentity: anchor.fileIdentity,
          filePath: anchor.newPath!,
          contentFingerprint: "different-patch-fingerprint",
          reviewed: true,
          expectedReviewRevision: 3,
          expectedFileRevision: 1,
          mutationId: "stale-file-review",
        }),
      ).toThrow(/changed in another client/i);
    } finally {
      current.database.close();
    }
  });

  it("rejects forged selected-text evidence before persistence", () => {
    const current = fixture();
    try {
      const review = current.service.openReview(scope, identity, {
        mutationId: "open-forged",
      });
      expect(() =>
        current.service.createComment(scope, review.id, {
          ...anchor,
          selectedTextDigest: "0".repeat(64),
          body: "forged",
          expectedReviewRevision: 1,
          mutationId: "forged-comment",
        }),
      ).toThrow(/selected-text digest/i);
    } finally {
      current.database.close();
    }
  });

  it("does not let deleted tombstones consume the live-comment capacity", () => {
    const current = fixture();
    try {
      const review = current.service.openReview(scope, identity, {
        mutationId: "open-comment-capacity",
      });
      const insert = current.database
        .prepare(`INSERT INTO workspace_diff_review_comments(
        tenant_id, owner_principal_id, review_id, id, file_identity, old_path,
        new_path, side, start_line, end_line, old_content_id, new_content_id,
        selected_text, selected_text_digest, hunk_fingerprint, body, state,
        revision, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resolved',
        2, 1, 1, 1)`);
      current.database.transaction(() => {
        for (let index = 0; index < 5_000; index += 1) {
          insert.run(
            scope.tenantId,
            scope.principalId,
            review.id,
            `40000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
            anchor.fileIdentity,
            anchor.oldPath,
            anchor.newPath,
            anchor.side,
            anchor.startLine,
            anchor.endLine,
            anchor.oldContentId,
            anchor.newContentId,
            anchor.selectedText,
            anchor.selectedTextDigest,
            anchor.hunkFingerprint,
            "deleted",
          );
        }
      })();

      const created = current.service.createComment(scope, review.id, {
        ...anchor,
        body: "This live comment still fits.",
        expectedReviewRevision: 1,
        mutationId: "live-after-tombstones",
      });
      expect(created.review.revision).toBe(2);
      expect(current.service.listComments(scope, review.id)).toEqual([
        created.value,
      ]);
    } finally {
      current.database.close();
    }
  });
});
