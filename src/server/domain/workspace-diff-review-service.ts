import { createHash } from "node:crypto";
import type {
  WorkspaceDiffResolvedReviewIdentity as EngineResolvedReviewIdentity,
  WorkspaceDiffValidatedReviewAnchor,
} from "../../shared/protocol/workspace-diffs.js";
import type { InventoryRepository } from "../db/repositories/inventory-repository.js";
import type {
  WorkspaceDiffCommentAnchor,
  WorkspaceDiffCommentState,
  WorkspaceDiffResolvedReviewIdentity,
  WorkspaceDiffReviewedFileRecord,
  WorkspaceDiffReviewCommentRecord,
  WorkspaceDiffReviewMutationResult,
  WorkspaceDiffReviewRecord,
  WorkspaceDiffReviewRepository,
  WorkspaceDiffReviewState,
} from "../db/repositories/workspace-diff-review-repository.js";
import type { WorkspaceFileRootRepository } from "../db/repositories/workspace-file-root-repository.js";
import type { WorkspaceFileLinkedWorktreeRepository } from "../db/repositories/workspace-file-linked-worktree-repository.js";
import type { RequestScope } from "../identity/identity-provider.js";
import { DomainError } from "./errors.js";

const PRIMARY_ROOT_ID = "primary";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const OPAQUE_FINGERPRINT = /^[A-Za-z0-9_-]+$/u;
const GIT_HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

/** Persistence boundary used only after the Files engine resolves live IDs. */
export class WorkspaceDiffReviewService {
  constructor(
    readonly inventory: Pick<InventoryRepository, "getWorkspace">,
    readonly roots: Pick<WorkspaceFileRootRepository, "get">,
    readonly linkedWorktrees: Pick<
      WorkspaceFileLinkedWorktreeRepository,
      "find"
    >,
    readonly reviews: WorkspaceDiffReviewRepository,
    readonly now: () => number = Date.now,
  ) {}

  listReviews(
    scope: RequestScope,
    input: {
      readonly workspaceId: string;
      readonly rootId: string;
      readonly repositoryKey?: string;
    },
  ): readonly WorkspaceDiffReviewRecord[] {
    this.#authorize(scope, input.workspaceId, input.rootId);
    bounded(input.workspaceId, 128, "workspace ID");
    bounded(input.rootId, 128, "root ID");
    if (input.repositoryKey !== undefined)
      bounded(input.repositoryKey, 256, "repository key");
    return this.reviews.listReviews(scope, input);
  }

  getReview(scope: RequestScope, reviewId: string): WorkspaceDiffReviewRecord {
    id(reviewId, "review ID");
    return this.reviews.getReview(scope, reviewId);
  }

  openReview(
    scope: RequestScope,
    identity: WorkspaceDiffResolvedReviewIdentity,
    input: {
      readonly title?: string;
      readonly summary?: string;
      readonly mutationId: string;
    },
  ): WorkspaceDiffReviewRecord {
    this.#authorize(scope, identity.workspaceId, identity.rootId);
    validateIdentity(identity);
    bounded(input.title ?? "", 512, "review title", true);
    bounded(input.summary ?? "", 8_192, "review summary", true);
    mutation(input.mutationId);
    return this.reviews.openReview(scope, identity, {
      title: input.title ?? "",
      summary: input.summary ?? "",
      mutationId: input.mutationId,
      now: this.now(),
    });
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
    },
  ): WorkspaceDiffReviewRecord {
    id(reviewId, "review ID");
    bounded(input.title, 512, "review title", true);
    bounded(input.summary, 8_192, "review summary", true);
    if (input.state !== "open" && input.state !== "archived")
      invalid("review state");
    revision(input.expectedRevision);
    mutation(input.mutationId);
    return this.reviews.updateReview(scope, reviewId, {
      ...input,
      now: this.now(),
    });
  }

  listComments(
    scope: RequestScope,
    reviewId: string,
  ): readonly WorkspaceDiffReviewCommentRecord[] {
    id(reviewId, "review ID");
    return this.reviews.listComments(scope, reviewId);
  }

  createComment(
    scope: RequestScope,
    reviewId: string,
    input: WorkspaceDiffCommentAnchor & {
      readonly body: string;
      readonly state?: "draft" | "published";
      readonly expectedReviewRevision: number;
      readonly mutationId: string;
    },
  ): WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewCommentRecord> {
    id(reviewId, "review ID");
    validateAnchor(input);
    body(input.body);
    revision(input.expectedReviewRevision);
    mutation(input.mutationId);
    const selectedTextDigest = createHash("sha256")
      .update(input.selectedText)
      .digest("hex");
    if (input.selectedTextDigest !== selectedTextDigest)
      invalid("selected-text digest");
    return this.reviews.createComment(scope, reviewId, {
      ...input,
      state: input.state ?? "draft",
      now: this.now(),
    });
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
    },
  ): WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewCommentRecord> {
    id(reviewId, "review ID");
    id(commentId, "comment ID");
    body(input.body);
    if (
      !(
        ["draft", "published", "resolved", "outdated", "unplaced"] as const
      ).includes(input.state)
    ) {
      invalid("comment state");
    }
    revision(input.expectedReviewRevision);
    revision(input.expectedCommentRevision);
    mutation(input.mutationId);
    return this.reviews.updateComment(scope, reviewId, commentId, {
      ...input,
      now: this.now(),
    });
  }

  deleteComment(
    scope: RequestScope,
    reviewId: string,
    commentId: string,
    input: {
      readonly expectedReviewRevision: number;
      readonly expectedCommentRevision: number;
      readonly mutationId: string;
    },
  ): WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewCommentRecord> {
    id(reviewId, "review ID");
    id(commentId, "comment ID");
    revision(input.expectedReviewRevision);
    revision(input.expectedCommentRevision);
    mutation(input.mutationId);
    return this.reviews.deleteComment(scope, reviewId, commentId, {
      ...input,
      now: this.now(),
    });
  }

  listReviewedFiles(
    scope: RequestScope,
    reviewId: string,
  ): readonly WorkspaceDiffReviewedFileRecord[] {
    id(reviewId, "review ID");
    return this.reviews.listReviewedFiles(scope, reviewId);
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
    },
  ): WorkspaceDiffReviewMutationResult<WorkspaceDiffReviewedFileRecord> {
    id(reviewId, "review ID");
    bounded(input.fileIdentity, 256, "file identity");
    path(input.filePath);
    bounded(input.contentFingerprint, 256, "content fingerprint");
    if (Buffer.byteLength(input.contentFingerprint) < 16)
      invalid("content fingerprint");
    if (typeof input.reviewed !== "boolean") invalid("reviewed state");
    revision(input.expectedReviewRevision);
    if (input.expectedFileRevision !== null)
      revision(input.expectedFileRevision);
    mutation(input.mutationId);
    return this.reviews.setReviewedFile(scope, reviewId, {
      ...input,
      now: this.now(),
    });
  }

  #authorize(scope: RequestScope, workspaceId: string, rootId: string): void {
    this.inventory.getWorkspace(scope, workspaceId);
    const linked = this.linkedWorktrees.find(scope, workspaceId, rootId);
    if (rootId !== PRIMARY_ROOT_ID && linked?.availability !== "available") {
      this.roots.get(scope, workspaceId, rootId);
    }
  }
}

function validateIdentity(value: WorkspaceDiffResolvedReviewIdentity): void {
  bounded(value.workspaceId, 128, "workspace ID");
  bounded(value.rootId, 128, "root ID");
  bounded(value.repositoryKey, 256, "repository key");
  if (
    Buffer.byteLength(value.repositoryKey) < 16 ||
    !OPAQUE_FINGERPRINT.test(value.repositoryKey)
  )
    invalid("repository key");
  if (value.semantic !== "direct" && value.semantic !== "merge_base")
    invalid("comparison semantic");
  for (const endpoint of [value.base, value.head]) {
    if (
      !(["revision", "index", "working_tree"] as const).includes(endpoint.kind)
    )
      invalid("endpoint kind");
    bounded(endpoint.identity, 256, "endpoint identity");
    if (
      (endpoint.kind === "revision" || endpoint.kind === "index") &&
      !GIT_HASH.test(endpoint.identity)
    )
      invalid("endpoint identity");
  }
  bounded(value.fingerprint, 128, "comparison fingerprint");
  if (Buffer.byteLength(value.fingerprint) < 16)
    invalid("comparison fingerprint");
  if (!OPAQUE_FINGERPRINT.test(value.fingerprint))
    invalid("comparison fingerprint");
  if (value.semantic === "merge_base") {
    if (
      value.mergeBaseCommitHash === undefined ||
      !GIT_HASH.test(value.mergeBaseCommitHash)
    )
      invalid("merge-base identity");
  } else if (value.mergeBaseCommitHash !== undefined) {
    invalid("merge-base identity");
  }
}

function validateAnchor(value: WorkspaceDiffCommentAnchor): void {
  bounded(value.fileIdentity, 256, "file identity");
  if (value.oldPath === null && value.newPath === null) invalid("file paths");
  if (value.oldPath !== null) path(value.oldPath);
  if (value.newPath !== null) path(value.newPath);
  if (value.side !== "old" && value.side !== "new") invalid("side");
  if (value.side === "old" && value.oldContentId === null)
    invalid("old content identity");
  if (value.side === "new" && value.newContentId === null)
    invalid("new content identity");
  if (value.oldContentId !== null)
    bounded(value.oldContentId, 256, "old content identity");
  if (value.newContentId !== null)
    bounded(value.newContentId, 256, "new content identity");
  if (
    !Number.isSafeInteger(value.startLine) ||
    value.startLine < 1 ||
    !Number.isSafeInteger(value.endLine) ||
    value.endLine < value.startLine ||
    value.endLine > 2_147_483_647
  )
    invalid("line range");
  bounded(value.selectedText, 65_536, "selected text", true);
  if (!/^[0-9a-f]{64}$/u.test(value.selectedTextDigest))
    invalid("selected-text digest");
  bounded(value.hunkFingerprint, 256, "hunk fingerprint");
}

function body(value: string): void {
  bounded(value, 65_536, "comment body");
  if (!value.trim()) invalid("comment body");
}
function path(value: string): void {
  bounded(value, 4_096, "file path");
  if (value.includes("\0")) invalid("file path");
}
function mutation(value: string): void {
  bounded(value, 128, "mutation ID");
}
function id(value: string, label: string): void {
  if (!UUID.test(value)) invalid(label);
}
function revision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) invalid("revision");
}
function bounded(
  value: string,
  maximum: number,
  label: string,
  empty = false,
): void {
  if (
    typeof value !== "string" ||
    (!empty && !value) ||
    Buffer.byteLength(value) > maximum
  )
    invalid(label);
}
function invalid(label: string): never {
  throw new DomainError(
    "invalid_transition",
    `The workspace diff review ${label} is invalid.`,
  );
}

/** Exact adapter from the trusted Files-engine result; never call on browser data. */
export function resolvedWorkspaceDiffReviewIdentity(
  workspaceId: string,
  rootId: string,
  identity: EngineResolvedReviewIdentity,
): WorkspaceDiffResolvedReviewIdentity {
  const endpoint = (
    value: EngineResolvedReviewIdentity["base"],
  ): WorkspaceDiffResolvedReviewIdentity["base"] => ({
    kind: value.kind,
    identity:
      value.kind === "revision"
        ? value.commitHash
        : value.kind === "index"
          ? value.treeHash
          : value.stateFingerprint,
  });
  return {
    workspaceId,
    rootId,
    repositoryKey: identity.repositoryKey,
    semantic: identity.mode,
    base: endpoint(identity.base),
    head: endpoint(identity.head),
    ...(identity.mergeBaseCommitHash === undefined
      ? {}
      : { mergeBaseCommitHash: identity.mergeBaseCommitHash }),
    fingerprint: identity.fingerprint,
  };
}

/** Exact adapter from a successfully engine-validated line-range anchor. */
export function validatedWorkspaceDiffCommentAnchor(
  anchor: WorkspaceDiffValidatedReviewAnchor,
): WorkspaceDiffCommentAnchor {
  return {
    fileIdentity: anchor.reviewFileIdentity,
    oldPath: anchor.oldPath ?? null,
    newPath: anchor.newPath ?? null,
    side: anchor.side,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    oldContentId: anchor.oldContentId,
    newContentId: anchor.newContentId,
    selectedText: anchor.selectedText,
    selectedTextDigest: anchor.selectedTextSha256,
    hunkFingerprint: anchor.hunkFingerprint,
  };
}
