import type { JsonResponseSender } from "./response-compression.js";
import type { Request, RequestHandler } from "express";
import { z } from "zod";
import {
  workspaceDiffChangedFilesQuerySchema,
  workspaceDiffChangedFilesResultSchema,
  workspaceDiffComparisonCreateRequestSchema,
  workspaceDiffComparisonCreateResultSchema,
  workspaceDiffFileContentRequestSchema,
  workspaceDiffFileContentResultSchema,
  workspaceDiffFileRequestSchema,
  workspaceDiffPatchResultSchema,
  workspaceDiffRefCatalogQuerySchema,
  workspaceDiffRefCatalogResultSchema,
  workspaceDiffRepositoriesResultSchema,
} from "../../shared/protocol/workspace-diffs.js";
import {
  workspaceDiffReviewCommentCreateRequestSchema,
  workspaceDiffReviewCommentDeleteRequestSchema,
  workspaceDiffReviewCommentUpdateRequestSchema,
  workspaceDiffReviewCommentsResultSchema,
  workspaceDiffReviewIdSchema,
  workspaceDiffReviewListQuerySchema,
  workspaceDiffReviewListResultSchema,
  workspaceDiffReviewMutationResultSchema,
  workspaceDiffReviewOpenRequestSchema,
  workspaceDiffReviewRepositoryListQuerySchema,
  workspaceDiffReviewSchema,
  workspaceDiffReviewUpdateRequestSchema,
  workspaceDiffReviewedFileMutationResultSchema,
  workspaceDiffReviewedFileSetRequestSchema,
  workspaceDiffReviewedFilesResultSchema,
} from "../../shared/protocol/workspace-diff-reviews.js";
import { workspaceFileRootIdSchema } from "../../shared/protocol/workspace-files.js";
import type {
  WorkspaceDiffResolvedReviewIdentity as PersistedWorkspaceDiffReviewIdentity,
  WorkspaceDiffReviewCommentRecord,
  WorkspaceDiffReviewRecord,
  WorkspaceDiffReviewedFileRecord,
} from "../db/repositories/workspace-diff-review-repository.js";
import { DomainError } from "../domain/errors.js";
import {
  resolvedWorkspaceDiffReviewIdentity,
  validatedWorkspaceDiffCommentAnchor,
  type WorkspaceDiffReviewService,
} from "../domain/workspace-diff-review-service.js";
import type { WorkspaceFileService } from "../domain/workspace-file-service.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { workspaceFileRequestSignal } from "./request-signal.js";

interface WorkspaceDiffRoutes {
  get(path: string, ...handlers: RequestHandler[]): void;
  post(path: string, ...handlers: RequestHandler[]): void;
  put(path: string, ...handlers: RequestHandler[]): void;
  patch(path: string, ...handlers: RequestHandler[]): void;
  delete(path: string, ...handlers: RequestHandler[]): void;
}

const workspaceDiffRouteParametersSchema = z.strictObject({
  workspaceId: z.uuid(),
  rootId: workspaceFileRootIdSchema,
});
const workspaceDiffReviewRouteParametersSchema = z.strictObject({
  reviewId: workspaceDiffReviewIdSchema,
});
const workspaceDiffReviewCommentRouteParametersSchema = z.strictObject({
  reviewId: workspaceDiffReviewIdSchema,
  commentId: z.uuid(),
});

function workspaceDiffReview(record: WorkspaceDiffReviewRecord) {
  return workspaceDiffReviewSchema.parse({
    id: record.id,
    workspaceId: record.workspaceId,
    rootId: record.rootId,
    title: record.title,
    summary: record.summary,
    state: record.state,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function workspaceDiffReviewComment(record: WorkspaceDiffReviewCommentRecord) {
  return {
    id: record.id,
    reviewId: record.reviewId,
    fileIdentity: record.fileIdentity,
    oldPath: record.oldPath,
    newPath: record.newPath,
    side: record.side,
    startLine: record.startLine,
    endLine: record.endLine,
    selectedText: record.selectedText,
    body: record.body,
    state: record.state,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function workspaceDiffReviewedFile(record: WorkspaceDiffReviewedFileRecord) {
  return {
    reviewId: record.reviewId,
    fileIdentity: record.fileIdentity,
    filePath: record.filePath,
    contentFingerprint: record.contentFingerprint,
    reviewed: record.reviewed,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function sameWorkspaceDiffReviewIdentity(
  record: WorkspaceDiffReviewRecord,
  identity: PersistedWorkspaceDiffReviewIdentity,
): boolean {
  return (
    record.repositoryKey === identity.repositoryKey &&
    record.semantic === identity.semantic &&
    record.baseKind === identity.base.kind &&
    record.baseIdentity === identity.base.identity &&
    record.headKind === identity.head.kind &&
    record.headIdentity === identity.head.identity &&
    record.mergeBaseCommitHash === (identity.mergeBaseCommitHash ?? null) &&
    record.fingerprint === identity.fingerprint
  );
}

function workspaceDiffResolutionError(status: string): DomainError {
  if (status === "stale") {
    return new DomainError(
      "conflict",
      "The workspace comparison changed. Refresh it before continuing.",
    );
  }
  if (status === "unavailable") {
    return new DomainError(
      "runtime_unavailable",
      "The workspace comparison is unavailable.",
      true,
    );
  }
  return new DomainError(
    "invalid_transition",
    "The selected workspace diff lines cannot be reviewed.",
  );
}

/** Workspace comparison and diff-review routes behind the request scope. */
export function registerWorkspaceDiffRoutes(
  routes: WorkspaceDiffRoutes,
  scope: (request: Request) => Promise<RequestScope>,
  dependencies: {
    readonly workspaceFiles: WorkspaceFileService;
    readonly workspaceDiffReviews: WorkspaceDiffReviewService;
  },
  sendJson: JsonResponseSender,
): void {
  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/repositories",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      await sendJson(request, response,
        workspaceDiffRepositoriesResultSchema.parse(
          await dependencies.workspaceFiles.diffRepositories(
            requestScope,
            workspaceId,
            rootId,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/refs",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const query = workspaceDiffRefCatalogQuerySchema.parse(request.query);
      await sendJson(request, response,
        workspaceDiffRefCatalogResultSchema.parse(
          await dependencies.workspaceFiles.diffRefCatalog(
            requestScope,
            workspaceId,
            rootId,
            query,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.post(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/comparisons",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceDiffComparisonCreateRequestSchema.parse(
        request.body,
      );
      response
        .status(201)
        .json(
          workspaceDiffComparisonCreateResultSchema.parse(
            await dependencies.workspaceFiles.diffCreateComparison(
              requestScope,
              workspaceId,
              rootId,
              input,
              workspaceFileRequestSignal(request, response),
            ),
          ),
        );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/files",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const query = workspaceDiffChangedFilesQuerySchema.parse(request.query);
      await sendJson(request, response,
        workspaceDiffChangedFilesResultSchema.parse(
          await dependencies.workspaceFiles.diffChangedFiles(
            requestScope,
            workspaceId,
            rootId,
            query,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/patch",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceDiffFileRequestSchema.parse(request.query);
      await sendJson(request, response,
        workspaceDiffPatchResultSchema.parse(
          await dependencies.workspaceFiles.diffPatch(
            requestScope,
            workspaceId,
            rootId,
            input,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/content",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceDiffFileContentRequestSchema.parse(request.query);
      await sendJson(request, response,
        workspaceDiffFileContentResultSchema.parse(
          await dependencies.workspaceFiles.diffFileContent(
            requestScope,
            workspaceId,
            rootId,
            input,
            workspaceFileRequestSignal(request, response),
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/review-history",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const query = workspaceDiffReviewRepositoryListQuerySchema.parse(
        request.query,
      );
      const resolved =
        await dependencies.workspaceFiles.diffReviewRepositoryIdentity(
          requestScope,
          workspaceId,
          rootId,
          query,
          workspaceFileRequestSignal(request, response),
        );
      if (resolved.status !== "available") {
        throw workspaceDiffResolutionError(resolved.status);
      }
      await sendJson(request, response,
        workspaceDiffReviewListResultSchema.parse({
          reviews: dependencies.workspaceDiffReviews
            .listReviews(requestScope, {
              workspaceId,
              rootId,
              repositoryKey: resolved.repositoryKey,
            })
            .map(workspaceDiffReview),
        }),
      );
    },
  );

  routes.get(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/reviews",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const query = workspaceDiffReviewListQuerySchema.parse(request.query);
      const resolved = await dependencies.workspaceFiles.diffReviewIdentity(
        requestScope,
        workspaceId,
        rootId,
        query,
        workspaceFileRequestSignal(request, response),
      );
      if (resolved.status !== "available") {
        throw workspaceDiffResolutionError(resolved.status);
      }
      const identity = resolvedWorkspaceDiffReviewIdentity(
        workspaceId,
        rootId,
        resolved.identity,
      );
      await sendJson(request, response,
        workspaceDiffReviewListResultSchema.parse({
          reviews: dependencies.workspaceDiffReviews
            .listReviews(requestScope, {
              workspaceId,
              rootId,
              repositoryKey: identity.repositoryKey,
            })
            .filter((review) =>
              sameWorkspaceDiffReviewIdentity(review, identity),
            )
            .map(workspaceDiffReview),
        }),
      );
    },
  );

  routes.post(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/reviews",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId } = workspaceDiffRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceDiffReviewOpenRequestSchema.parse(request.body);
      const resolved = await dependencies.workspaceFiles.diffReviewIdentity(
        requestScope,
        workspaceId,
        rootId,
        input,
        workspaceFileRequestSignal(request, response),
      );
      if (resolved.status !== "available") {
        throw workspaceDiffResolutionError(resolved.status);
      }
      response.status(201).json(
        workspaceDiffReview(
          dependencies.workspaceDiffReviews.openReview(
            requestScope,
            resolvedWorkspaceDiffReviewIdentity(
              workspaceId,
              rootId,
              resolved.identity,
            ),
            {
              ...(input.title === undefined ? {} : { title: input.title }),
              ...(input.summary === undefined
                ? {}
                : { summary: input.summary }),
              mutationId: input.mutationId,
            },
          ),
        ),
      );
    },
  );

  routes.patch(
    "/api/workspace-diff-reviews/:reviewId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { reviewId } = workspaceDiffReviewRouteParametersSchema.parse(
        request.params,
      );
      const input = workspaceDiffReviewUpdateRequestSchema.parse(request.body);
      response.json(
        workspaceDiffReview(
          dependencies.workspaceDiffReviews.updateReview(
            requestScope,
            reviewId,
            input,
          ),
        ),
      );
    },
  );

  routes.get(
    "/api/workspace-diff-reviews/:reviewId/comments",
    async (request, response) => {
      const requestScope = await scope(request);
      const { reviewId } = workspaceDiffReviewRouteParametersSchema.parse(
        request.params,
      );
      await sendJson(request, response,
        workspaceDiffReviewCommentsResultSchema.parse({
          comments: dependencies.workspaceDiffReviews
            .listComments(requestScope, reviewId)
            .map(workspaceDiffReviewComment),
        }),
      );
    },
  );

  routes.post(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/reviews/:reviewId/comments",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId, reviewId } =
        workspaceDiffRouteParametersSchema
          .extend({ reviewId: workspaceDiffReviewIdSchema })
          .parse(request.params);
      const input = workspaceDiffReviewCommentCreateRequestSchema.parse(
        request.body,
      );
      const review = dependencies.workspaceDiffReviews.getReview(
        requestScope,
        reviewId,
      );
      if (review.workspaceId !== workspaceId || review.rootId !== rootId) {
        throw new DomainError(
          "not_found",
          "The workspace diff review was not found.",
        );
      }
      const validated =
        await dependencies.workspaceFiles.diffValidateReviewAnchor(
          requestScope,
          workspaceId,
          rootId,
          input,
          workspaceFileRequestSignal(request, response),
        );
      if (validated.status !== "available") {
        throw workspaceDiffResolutionError(validated.status);
      }
      if (
        validated.anchor.repositoryKey !== review.repositoryKey ||
        validated.anchor.comparisonFingerprint !== review.fingerprint
      ) {
        throw new DomainError(
          "conflict",
          "The workspace comparison no longer matches this review.",
        );
      }
      const result = dependencies.workspaceDiffReviews.createComment(
        requestScope,
        reviewId,
        {
          ...validatedWorkspaceDiffCommentAnchor(validated.anchor),
          body: input.body,
          ...(input.state === undefined ? {} : { state: input.state }),
          expectedReviewRevision: input.expectedReviewRevision,
          mutationId: input.mutationId,
        },
      );
      response.status(201).json(
        workspaceDiffReviewMutationResultSchema.parse({
          review: workspaceDiffReview(result.review),
          comment: workspaceDiffReviewComment(result.value),
        }),
      );
    },
  );

  routes.patch(
    "/api/workspace-diff-reviews/:reviewId/comments/:commentId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { reviewId, commentId } =
        workspaceDiffReviewCommentRouteParametersSchema.parse(request.params);
      const input = workspaceDiffReviewCommentUpdateRequestSchema.parse(
        request.body,
      );
      const result = dependencies.workspaceDiffReviews.updateComment(
        requestScope,
        reviewId,
        commentId,
        input,
      );
      response.json(
        workspaceDiffReviewMutationResultSchema.parse({
          review: workspaceDiffReview(result.review),
          comment: workspaceDiffReviewComment(result.value),
        }),
      );
    },
  );

  routes.delete(
    "/api/workspace-diff-reviews/:reviewId/comments/:commentId",
    async (request, response) => {
      const requestScope = await scope(request);
      const { reviewId, commentId } =
        workspaceDiffReviewCommentRouteParametersSchema.parse(request.params);
      const input = workspaceDiffReviewCommentDeleteRequestSchema.parse(
        request.body,
      );
      const result = dependencies.workspaceDiffReviews.deleteComment(
        requestScope,
        reviewId,
        commentId,
        input,
      );
      response.json(
        workspaceDiffReviewMutationResultSchema.parse({
          review: workspaceDiffReview(result.review),
          comment: workspaceDiffReviewComment(result.value),
        }),
      );
    },
  );

  routes.get(
    "/api/workspace-diff-reviews/:reviewId/reviewed-files",
    async (request, response) => {
      const requestScope = await scope(request);
      const { reviewId } = workspaceDiffReviewRouteParametersSchema.parse(
        request.params,
      );
      await sendJson(request, response,
        workspaceDiffReviewedFilesResultSchema.parse({
          files: dependencies.workspaceDiffReviews
            .listReviewedFiles(requestScope, reviewId)
            .map(workspaceDiffReviewedFile),
        }),
      );
    },
  );

  routes.put(
    "/api/workspaces/:workspaceId/file-roots/:rootId/diff/reviews/:reviewId/reviewed-files",
    async (request, response) => {
      const requestScope = await scope(request);
      const { workspaceId, rootId, reviewId } =
        workspaceDiffRouteParametersSchema
          .extend({ reviewId: workspaceDiffReviewIdSchema })
          .parse(request.params);
      const input = workspaceDiffReviewedFileSetRequestSchema.parse(
        request.body,
      );
      const review = dependencies.workspaceDiffReviews.getReview(
        requestScope,
        reviewId,
      );
      if (review.workspaceId !== workspaceId || review.rootId !== rootId) {
        throw new DomainError(
          "not_found",
          "The workspace diff review was not found.",
        );
      }
      const validated =
        await dependencies.workspaceFiles.diffValidateReviewedFile(
          requestScope,
          workspaceId,
          rootId,
          input,
          workspaceFileRequestSignal(request, response),
        );
      if (validated.status !== "available") {
        throw workspaceDiffResolutionError(validated.status);
      }
      if (
        validated.file.repositoryKey !== review.repositoryKey ||
        validated.file.comparisonFingerprint !== review.fingerprint
      ) {
        throw new DomainError(
          "conflict",
          "The workspace comparison no longer matches this review.",
        );
      }
      const result = dependencies.workspaceDiffReviews.setReviewedFile(
        requestScope,
        reviewId,
        {
          fileIdentity: validated.file.reviewFileIdentity,
          filePath: validated.file.path,
          contentFingerprint: validated.file.contentFingerprint,
          reviewed: input.reviewed,
          expectedReviewRevision: input.expectedReviewRevision,
          expectedFileRevision: input.expectedFileRevision,
          mutationId: input.mutationId,
        },
      );
      response.json(
        workspaceDiffReviewedFileMutationResultSchema.parse({
          review: workspaceDiffReview(result.review),
          file: workspaceDiffReviewedFile(result.value),
        }),
      );
    },
  );
}
