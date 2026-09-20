import { describe, expect, it } from "vitest";
import {
  workspaceDiffReviewCommentSchema,
  workspaceDiffReviewCommentCreateRequestSchema,
  workspaceDiffReviewCommentUpdateRequestSchema,
  workspaceDiffReviewOpenRequestSchema,
  workspaceDiffReviewSchema,
  workspaceDiffReviewedFileSetRequestSchema,
} from "../../src/shared/protocol/workspace-diff-reviews.js";

const mutationId = "30000000-0000-4000-8000-000000000001";
const comparison = {
  comparisonId: "comparison-1",
  fingerprint: "fingerprint-0001",
};

describe("workspace diff review protocol", () => {
  it("accepts only opaque live comparison authority when opening a review", () => {
    expect(
      workspaceDiffReviewOpenRequestSchema.parse({
        ...comparison,
        title: "Review",
        mutationId,
      }),
    ).toMatchObject(comparison);
    expect(() =>
      workspaceDiffReviewOpenRequestSchema.parse({
        ...comparison,
        repositoryKey: "browser-must-not-authorize",
        mutationId,
      }),
    ).toThrow();
  });

  it("keeps comment and reviewed-file evidence server-derived", () => {
    const comment = {
      ...comparison,
      fileId: "file-1",
      side: "new",
      startLine: 1,
      endLine: 2,
      body: "Check this",
      expectedReviewRevision: 1,
      mutationId,
    };
    expect(
      workspaceDiffReviewCommentCreateRequestSchema.parse(comment),
    ).toEqual(comment);
    expect(() =>
      workspaceDiffReviewCommentCreateRequestSchema.parse({
        ...comment,
        selectedText: "forged",
      }),
    ).toThrow();

    const reviewed = {
      ...comparison,
      fileId: "file-1",
      reviewed: true,
      expectedReviewRevision: 1,
      expectedFileRevision: null,
      mutationId,
    };
    expect(workspaceDiffReviewedFileSetRequestSchema.parse(reviewed)).toEqual(
      reviewed,
    );
    expect(() =>
      workspaceDiffReviewedFileSetRequestSchema.parse({
        ...reviewed,
        fileIdentity: "forged-file-identity",
      }),
    ).toThrow();
  });

  it("projects reviews without tenant, principal, or repository authority", () => {
    const review = {
      id: "30000000-0000-4000-8000-000000000002",
      workspaceId: "30000000-0000-4000-8000-000000000003",
      rootId: "primary",
      title: "Review",
      summary: "",
      state: "open",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(workspaceDiffReviewSchema.parse(review)).toEqual(review);
    expect(() =>
      workspaceDiffReviewSchema.parse({
        ...review,
        tenantId: "tenant-1",
        repositoryKey: "repository-secret",
      }),
    ).toThrow();
  });

  it("enforces durable text limits in UTF-8 bytes and rejects blank bodies", () => {
    expect(() =>
      workspaceDiffReviewOpenRequestSchema.parse({
        ...comparison,
        title: "😀".repeat(129),
        mutationId,
      }),
    ).toThrow(/UTF-8 bytes/i);
    expect(() =>
      workspaceDiffReviewOpenRequestSchema.parse({
        ...comparison,
        summary: "😀".repeat(2_049),
        mutationId,
      }),
    ).toThrow(/UTF-8 bytes/i);

    const oversizedBody = "😀".repeat(16_385);
    const update = {
      body: oversizedBody,
      state: "published",
      expectedReviewRevision: 1,
      expectedCommentRevision: 1,
      mutationId,
    };
    expect(() =>
      workspaceDiffReviewCommentUpdateRequestSchema.parse(update),
    ).toThrow(/UTF-8 bytes/i);
    expect(() =>
      workspaceDiffReviewCommentCreateRequestSchema.parse({
        ...comparison,
        fileId: "file-1",
        side: "new",
        startLine: 1,
        endLine: 1,
        body: " \n\t ",
        expectedReviewRevision: 1,
        mutationId,
      }),
    ).toThrow(/non-whitespace/i);

    const projectedComment = {
      id: "30000000-0000-4000-8000-000000000004",
      reviewId: "30000000-0000-4000-8000-000000000002",
      fileIdentity: "stable-file-identity",
      oldPath: "src/a.ts",
      newPath: "src/a.ts",
      side: "new",
      startLine: 1,
      endLine: 1,
      selectedText: "😀".repeat(16_385),
      body: "Comment",
      state: "published",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    expect(() =>
      workspaceDiffReviewCommentSchema.parse(projectedComment),
    ).toThrow(/UTF-8 bytes/i);
    expect(
      workspaceDiffReviewCommentSchema.parse({
        ...projectedComment,
        selectedText: "😀".repeat(16_384),
      }).selectedText,
    ).toHaveLength(32_768);
  });
});
