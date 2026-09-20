import { z } from "zod";
import { mutationIdSchema, workspaceIdSchema } from "./domain.js";
import {
  workspaceDiffComparisonIdSchema,
  workspaceDiffFileIdSchema,
  workspaceDiffFileSideSchema,
  workspaceDiffFingerprintSchema,
  workspaceDiffRepositoryIdSchema,
} from "./workspace-diffs.js";
import {
  workspaceFilePathSchema,
  workspaceFileRootIdSchema,
} from "./workspace-files.js";

export const workspaceDiffReviewIdSchema = z.uuid();
export const workspaceDiffReviewCommentIdSchema = z.uuid();
export const workspaceDiffReviewStateSchema = z.enum(["open", "archived"]);
export const workspaceDiffReviewCommentStateSchema = z.enum([
  "draft",
  "published",
  "resolved",
  "outdated",
  "unplaced",
]);
export type WorkspaceDiffReviewCommentState = z.infer<
  typeof workspaceDiffReviewCommentStateSchema
>;

const revisionSchema = z.number().int().positive();
const timestampSchema = z.number().int().nonnegative();
const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).byteLength;
const boundedTextSchema = (maximumBytes: number) =>
  z.string().refine((value) => utf8ByteLength(value) <= maximumBytes, {
    message: `Text must not exceed ${maximumBytes} UTF-8 bytes.`,
  });
const optionalTextSchema = (maximumBytes: number) =>
  boundedTextSchema(maximumBytes);
const commentBodySchema = boundedTextSchema(65_536).refine(
  (value) => value.trim().length > 0,
  { message: "A review comment body must contain non-whitespace text." },
);

export const workspaceDiffReviewSchema = z.strictObject({
  id: workspaceDiffReviewIdSchema,
  workspaceId: workspaceIdSchema,
  rootId: workspaceFileRootIdSchema,
  title: optionalTextSchema(512),
  summary: optionalTextSchema(8_192),
  state: workspaceDiffReviewStateSchema,
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type WorkspaceDiffReview = z.infer<typeof workspaceDiffReviewSchema>;

export const workspaceDiffReviewCommentSchema = z.strictObject({
  id: workspaceDiffReviewCommentIdSchema,
  reviewId: workspaceDiffReviewIdSchema,
  fileIdentity: z.string().min(16).max(256),
  oldPath: workspaceFilePathSchema.nullable(),
  newPath: workspaceFilePathSchema.nullable(),
  side: workspaceDiffFileSideSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  selectedText: boundedTextSchema(65_536),
  body: commentBodySchema,
  state: workspaceDiffReviewCommentStateSchema,
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type WorkspaceDiffReviewComment = z.infer<
  typeof workspaceDiffReviewCommentSchema
>;

export const workspaceDiffReviewListQuerySchema = z.strictObject({
  comparisonId: workspaceDiffComparisonIdSchema,
  fingerprint: workspaceDiffFingerprintSchema,
});
export type WorkspaceDiffReviewListQuery = z.infer<
  typeof workspaceDiffReviewListQuerySchema
>;

export const workspaceDiffReviewListResultSchema = z.strictObject({
  reviews: z.array(workspaceDiffReviewSchema),
});
export type WorkspaceDiffReviewListResult = z.infer<
  typeof workspaceDiffReviewListResultSchema
>;

export const workspaceDiffReviewRepositoryListQuerySchema = z.strictObject({
  repositoryId: workspaceDiffRepositoryIdSchema,
});
export type WorkspaceDiffReviewRepositoryListQuery = z.infer<
  typeof workspaceDiffReviewRepositoryListQuerySchema
>;

export const workspaceDiffReviewOpenRequestSchema = z.strictObject({
  ...workspaceDiffReviewListQuerySchema.shape,
  title: optionalTextSchema(512).optional(),
  summary: optionalTextSchema(8_192).optional(),
  mutationId: mutationIdSchema,
});
export type WorkspaceDiffReviewOpenRequest = z.infer<
  typeof workspaceDiffReviewOpenRequestSchema
>;

export const workspaceDiffReviewUpdateRequestSchema = z.strictObject({
  title: optionalTextSchema(512),
  summary: optionalTextSchema(8_192),
  state: workspaceDiffReviewStateSchema,
  expectedRevision: revisionSchema,
  mutationId: mutationIdSchema,
});
export type WorkspaceDiffReviewUpdateRequest = z.infer<
  typeof workspaceDiffReviewUpdateRequestSchema
>;

export const workspaceDiffReviewCommentsResultSchema = z.strictObject({
  comments: z.array(workspaceDiffReviewCommentSchema),
});
export type WorkspaceDiffReviewCommentsResult = z.infer<
  typeof workspaceDiffReviewCommentsResultSchema
>;

export const workspaceDiffReviewCommentCreateRequestSchema = z
  .strictObject({
    comparisonId: workspaceDiffComparisonIdSchema,
    fingerprint: workspaceDiffFingerprintSchema,
    fileId: workspaceDiffFileIdSchema,
    side: workspaceDiffFileSideSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    body: commentBodySchema,
    state: z.enum(["draft", "published"]).optional(),
    expectedReviewRevision: revisionSchema,
    mutationId: mutationIdSchema,
  })
  .refine((value) => value.startLine <= value.endLine, {
    path: ["endLine"],
    message: "The comment end line must not precede its start line.",
  });
export type WorkspaceDiffReviewCommentCreateRequest = z.infer<
  typeof workspaceDiffReviewCommentCreateRequestSchema
>;

export const workspaceDiffReviewCommentUpdateRequestSchema = z.strictObject({
  body: commentBodySchema,
  state: workspaceDiffReviewCommentStateSchema,
  expectedReviewRevision: revisionSchema,
  expectedCommentRevision: revisionSchema,
  mutationId: mutationIdSchema,
});
export type WorkspaceDiffReviewCommentUpdateRequest = z.infer<
  typeof workspaceDiffReviewCommentUpdateRequestSchema
>;

export const workspaceDiffReviewCommentDeleteRequestSchema = z.strictObject({
  expectedReviewRevision: revisionSchema,
  expectedCommentRevision: revisionSchema,
  mutationId: mutationIdSchema,
});
export type WorkspaceDiffReviewCommentDeleteRequest = z.infer<
  typeof workspaceDiffReviewCommentDeleteRequestSchema
>;

export const workspaceDiffReviewMutationResultSchema = z.strictObject({
  review: workspaceDiffReviewSchema,
  comment: workspaceDiffReviewCommentSchema,
});
export type WorkspaceDiffReviewMutationResult = z.infer<
  typeof workspaceDiffReviewMutationResultSchema
>;

export const workspaceDiffReviewedFileSchema = z.strictObject({
  reviewId: workspaceDiffReviewIdSchema,
  fileIdentity: z.string().min(16).max(256),
  filePath: workspaceFilePathSchema,
  contentFingerprint: z.string().min(16).max(256),
  reviewed: z.boolean(),
  revision: revisionSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type WorkspaceDiffReviewedFile = z.infer<
  typeof workspaceDiffReviewedFileSchema
>;

export const workspaceDiffReviewedFilesResultSchema = z.strictObject({
  files: z.array(workspaceDiffReviewedFileSchema),
});
export type WorkspaceDiffReviewedFilesResult = z.infer<
  typeof workspaceDiffReviewedFilesResultSchema
>;

export const workspaceDiffReviewedFileSetRequestSchema = z.strictObject({
  comparisonId: workspaceDiffComparisonIdSchema,
  fingerprint: workspaceDiffFingerprintSchema,
  fileId: workspaceDiffFileIdSchema,
  reviewed: z.boolean(),
  expectedReviewRevision: revisionSchema,
  expectedFileRevision: revisionSchema.nullable(),
  mutationId: mutationIdSchema,
});
export type WorkspaceDiffReviewedFileSetRequest = z.infer<
  typeof workspaceDiffReviewedFileSetRequestSchema
>;

export const workspaceDiffReviewedFileMutationResultSchema = z.strictObject({
  review: workspaceDiffReviewSchema,
  file: workspaceDiffReviewedFileSchema,
});
export type WorkspaceDiffReviewedFileMutationResult = z.infer<
  typeof workspaceDiffReviewedFileMutationResultSchema
>;
