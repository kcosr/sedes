import { z } from "zod";
import { opaqueIdSchema } from "./domain.js";
import {
  workspaceFilePathSchema,
  workspaceFileRootIdSchema,
} from "./workspace-files.js";
import {
  WORKSPACE_DIFF_DEFAULT_FILE_PAGE_SIZE,
  WORKSPACE_DIFF_DEFAULT_REF_PAGE_SIZE,
  WORKSPACE_DIFF_MAX_CHANGED_FILES,
  WORKSPACE_DIFF_MAX_FILE_PAGE_SIZE,
  WORKSPACE_DIFF_MAX_PATCH_BYTES,
  WORKSPACE_DIFF_MAX_REFS,
  WORKSPACE_DIFF_MAX_REF_LABEL_BYTES,
  WORKSPACE_DIFF_MAX_REVIEW_SELECTION_BYTES,
  WORKSPACE_DIFF_MAX_REVIEW_SELECTION_LINES,
  WORKSPACE_DIFF_MAX_SIDE_BYTES,
} from "../workspace-diff-limits.js";
export * from "../workspace-diff-limits.js";

const hasAtMostBytes = (value: string, maximum: number): boolean =>
  new TextEncoder().encode(value).byteLength <= maximum;

export const workspaceDiffRepositoryIdSchema = opaqueIdSchema.brand<
  "WorkspaceDiffRepositoryId"
>();
export type WorkspaceDiffRepositoryId = z.infer<
  typeof workspaceDiffRepositoryIdSchema
>;

export const workspaceDiffRevisionIdSchema = opaqueIdSchema.brand<
  "WorkspaceDiffRevisionId"
>();
export type WorkspaceDiffRevisionId = z.infer<
  typeof workspaceDiffRevisionIdSchema
>;

export const workspaceDiffComparisonIdSchema = opaqueIdSchema.brand<
  "WorkspaceDiffComparisonId"
>();
export type WorkspaceDiffComparisonId = z.infer<
  typeof workspaceDiffComparisonIdSchema
>;

export const workspaceDiffFileIdSchema = opaqueIdSchema.brand<
  "WorkspaceDiffFileId"
>();
export type WorkspaceDiffFileId = z.infer<typeof workspaceDiffFileIdSchema>;

export const workspaceDiffFingerprintSchema = z
  .string()
  .min(16)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/u)
  .brand<"WorkspaceDiffFingerprint">();
export type WorkspaceDiffFingerprint = z.infer<
  typeof workspaceDiffFingerprintSchema
>;

export const workspaceDiffCommitHashSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);

export const workspaceDiffRepositoryDescriptorSchema = z.strictObject({
  repositoryId: workspaceDiffRepositoryIdSchema,
  rootId: workspaceFileRootIdSchema,
  displayName: z.string().min(1).max(240),
  /** Prefix from the repository worktree to the authorized Files root. */
  pathPrefix: workspaceFilePathSchema.optional(),
  head: z
    .strictObject({
      commitHash: workspaceDiffCommitHashSchema,
      shortHash: z.string().min(7).max(16),
      label: z.string().min(1).max(240).optional(),
    })
    .optional(),
});
export type WorkspaceDiffRepositoryDescriptor = z.infer<
  typeof workspaceDiffRepositoryDescriptorSchema
>;

export const workspaceDiffRepositoriesResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("available"),
      repositories: z.array(workspaceDiffRepositoryDescriptorSchema),
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      diagnosticCode: z.string().min(1).max(120),
    }),
  ],
);
export type WorkspaceDiffRepositoriesResult = z.infer<
  typeof workspaceDiffRepositoriesResultSchema
>;

export const workspaceDiffRefKindSchema = z.enum([
  "local_branch",
  "remote_branch",
  "tag",
  "commit",
]);
export type WorkspaceDiffRefKind = z.infer<typeof workspaceDiffRefKindSchema>;

export const workspaceDiffRevisionDescriptorSchema = z.strictObject({
  revisionId: workspaceDiffRevisionIdSchema,
  kind: workspaceDiffRefKindSchema,
  label: z
    .string()
    .min(1)
    .refine((value) =>
      hasAtMostBytes(value, WORKSPACE_DIFF_MAX_REF_LABEL_BYTES),
    ),
  commitHash: workspaceDiffCommitHashSchema,
  shortHash: z.string().min(7).max(16),
  summary: z.string().max(500).optional(),
  committedAt: z.string().datetime().optional(),
});
export type WorkspaceDiffRevisionDescriptor = z.infer<
  typeof workspaceDiffRevisionDescriptorSchema
>;

export const workspaceDiffRefCatalogQuerySchema = z.strictObject({
  repositoryId: workspaceDiffRepositoryIdSchema,
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(WORKSPACE_DIFF_MAX_REFS)
    .default(WORKSPACE_DIFF_DEFAULT_REF_PAGE_SIZE),
});
export type WorkspaceDiffRefCatalogQuery = z.infer<
  typeof workspaceDiffRefCatalogQuerySchema
>;

export const workspaceDiffRefCatalogResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("available"),
      repositoryId: workspaceDiffRepositoryIdSchema,
      revisions: z
        .array(workspaceDiffRevisionDescriptorSchema)
        .max(WORKSPACE_DIFF_MAX_REFS),
      truncated: z.boolean(),
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      diagnosticCode: z.string().min(1).max(120),
    }),
  ],
);
export type WorkspaceDiffRefCatalogResult = z.infer<
  typeof workspaceDiffRefCatalogResultSchema
>;

export const workspaceDiffRevisionSelectionSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("revision"),
      revisionId: workspaceDiffRevisionIdSchema,
    }),
    z.strictObject({ kind: z.literal("index") }),
    z.strictObject({ kind: z.literal("working_tree") }),
  ],
);
export type WorkspaceDiffRevisionSelection = z.infer<
  typeof workspaceDiffRevisionSelectionSchema
>;

export const workspaceDiffComparisonModeSchema = z.enum([
  "direct",
  "merge_base",
]);
export type WorkspaceDiffComparisonMode = z.infer<
  typeof workspaceDiffComparisonModeSchema
>;

export const workspaceDiffComparisonCreateRequestSchema = z.strictObject({
  repositoryId: workspaceDiffRepositoryIdSchema,
  mode: workspaceDiffComparisonModeSchema,
  base: workspaceDiffRevisionSelectionSchema,
  head: workspaceDiffRevisionSelectionSchema,
});
export type WorkspaceDiffComparisonCreateRequest = z.infer<
  typeof workspaceDiffComparisonCreateRequestSchema
>;

export const workspaceDiffResolvedEndpointSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("revision"),
      revisionId: workspaceDiffRevisionIdSchema,
      commitHash: workspaceDiffCommitHashSchema,
      label: z.string().min(1).max(1_024),
    }),
    z.strictObject({
      kind: z.literal("index"),
      treeHash: workspaceDiffCommitHashSchema,
    }),
    z.strictObject({ kind: z.literal("working_tree") }),
  ],
);
export type WorkspaceDiffResolvedEndpoint = z.infer<
  typeof workspaceDiffResolvedEndpointSchema
>;

export const workspaceDiffComparisonDescriptorSchema = z.strictObject({
  comparisonId: workspaceDiffComparisonIdSchema,
  repositoryId: workspaceDiffRepositoryIdSchema,
  mode: workspaceDiffComparisonModeSchema,
  base: workspaceDiffResolvedEndpointSchema,
  head: workspaceDiffResolvedEndpointSchema,
  /** Present when merge-base mode resolved a different effective base. */
  mergeBaseCommitHash: workspaceDiffCommitHashSchema.optional(),
  fingerprint: workspaceDiffFingerprintSchema,
});
export type WorkspaceDiffComparisonDescriptor = z.infer<
  typeof workspaceDiffComparisonDescriptorSchema
>;

export const workspaceDiffComparisonCreateResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("available"),
      comparison: workspaceDiffComparisonDescriptorSchema,
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      diagnosticCode: z.string().min(1).max(120),
    }),
  ],
);
export type WorkspaceDiffComparisonCreateResult = z.infer<
  typeof workspaceDiffComparisonCreateResultSchema
>;

export const workspaceDiffChangeKindSchema = z.enum([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "type_changed",
  "unmerged",
]);
export type WorkspaceDiffChangeKind = z.infer<
  typeof workspaceDiffChangeKindSchema
>;

export const workspaceDiffChangedFileSummarySchema = z.strictObject({
  fileId: workspaceDiffFileIdSchema,
  changeKind: workspaceDiffChangeKindSchema,
  oldPath: workspaceFilePathSchema.optional(),
  newPath: workspaceFilePathSchema.optional(),
  oldMode: z.string().regex(/^[0-7]{6}$/u).optional(),
  newMode: z.string().regex(/^[0-7]{6}$/u).optional(),
  additions: z.number().int().nonnegative().optional(),
  deletions: z.number().int().nonnegative().optional(),
  binary: z.boolean(),
}).refine((file) => file.oldPath !== undefined || file.newPath !== undefined, {
  message: "A changed file must expose at least one safe path.",
});
export type WorkspaceDiffChangedFileSummary = z.infer<
  typeof workspaceDiffChangedFileSummarySchema
>;

export const workspaceDiffChangedFilesQuerySchema = z.strictObject({
  comparisonId: workspaceDiffComparisonIdSchema,
  fingerprint: workspaceDiffFingerprintSchema,
  after: workspaceDiffFileIdSchema.optional(),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(WORKSPACE_DIFF_MAX_FILE_PAGE_SIZE)
    .default(WORKSPACE_DIFF_DEFAULT_FILE_PAGE_SIZE),
});
export type WorkspaceDiffChangedFilesQuery = z.infer<
  typeof workspaceDiffChangedFilesQuerySchema
>;

const staleResultSchema = z.strictObject({
  status: z.literal("stale"),
  currentFingerprint: workspaceDiffFingerprintSchema,
});
const unavailableResultSchema = z.strictObject({
  status: z.literal("unavailable"),
  diagnosticCode: z.string().min(1).max(120),
});

export const workspaceDiffChangedFilesResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("available"),
      comparisonId: workspaceDiffComparisonIdSchema,
      fingerprint: workspaceDiffFingerprintSchema,
      files: z
        .array(workspaceDiffChangedFileSummarySchema)
        .max(WORKSPACE_DIFF_MAX_FILE_PAGE_SIZE),
      nextCursor: workspaceDiffFileIdSchema.optional(),
      totalFiles: z.number().int().nonnegative().max(WORKSPACE_DIFF_MAX_CHANGED_FILES),
      truncated: z.boolean(),
    }),
    staleResultSchema,
    unavailableResultSchema,
  ],
);
export type WorkspaceDiffChangedFilesResult = z.infer<
  typeof workspaceDiffChangedFilesResultSchema
>;

export const workspaceDiffFileRequestSchema = z.strictObject({
  comparisonId: workspaceDiffComparisonIdSchema,
  fingerprint: workspaceDiffFingerprintSchema,
  fileId: workspaceDiffFileIdSchema,
});
export type WorkspaceDiffFileRequest = z.infer<
  typeof workspaceDiffFileRequestSchema
>;

export const workspaceDiffPatchResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("available"),
    comparisonId: workspaceDiffComparisonIdSchema,
    fingerprint: workspaceDiffFingerprintSchema,
    fileId: workspaceDiffFileIdSchema,
    patch: z.string().refine((value) =>
      hasAtMostBytes(value, WORKSPACE_DIFF_MAX_PATCH_BYTES),
    ),
  }),
  z.strictObject({ status: z.literal("binary") }),
  z.strictObject({
    status: z.literal("too_large"),
    maximumBytes: z.literal(WORKSPACE_DIFF_MAX_PATCH_BYTES),
  }),
  staleResultSchema,
  unavailableResultSchema,
]);
export type WorkspaceDiffPatchResult = z.infer<
  typeof workspaceDiffPatchResultSchema
>;

export const workspaceDiffFileSideSchema = z.enum(["old", "new"]);
export type WorkspaceDiffFileSide = z.infer<typeof workspaceDiffFileSideSchema>;

export const workspaceDiffFileContentRequestSchema = z.strictObject({
  ...workspaceDiffFileRequestSchema.shape,
  side: workspaceDiffFileSideSchema,
});
export type WorkspaceDiffFileContentRequest = z.infer<
  typeof workspaceDiffFileContentRequestSchema
>;

export const workspaceDiffFileContentResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("available"),
      comparisonId: workspaceDiffComparisonIdSchema,
      fingerprint: workspaceDiffFingerprintSchema,
      fileId: workspaceDiffFileIdSchema,
      side: workspaceDiffFileSideSchema,
      path: workspaceFilePathSchema,
      content: z.string().refine((value) =>
        hasAtMostBytes(value, WORKSPACE_DIFF_MAX_SIDE_BYTES),
      ),
      revision: z.string().min(1).max(128),
    }),
    z.strictObject({ status: z.literal("binary") }),
    z.strictObject({ status: z.literal("absent") }),
    z.strictObject({
      status: z.literal("too_large"),
      sizeBytes: z.number().int().nonnegative(),
      maximumBytes: z.literal(WORKSPACE_DIFF_MAX_SIDE_BYTES),
    }),
    staleResultSchema,
    unavailableResultSchema,
  ],
);
export type WorkspaceDiffFileContentResult = z.infer<
  typeof workspaceDiffFileContentResultSchema
>;

export const workspaceDiffResolvedReviewEndpointSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("revision"),
      commitHash: workspaceDiffCommitHashSchema,
    }),
    z.strictObject({
      kind: z.literal("index"),
      treeHash: workspaceDiffCommitHashSchema,
    }),
    z.strictObject({
      kind: z.literal("working_tree"),
      stateFingerprint: workspaceDiffFingerprintSchema,
    }),
  ],
);

export const workspaceDiffResolvedReviewIdentitySchema = z.strictObject({
  /** Stable non-path repository identity, scoped by the execution environment. */
  repositoryKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  mode: workspaceDiffComparisonModeSchema,
  base: workspaceDiffResolvedReviewEndpointSchema,
  head: workspaceDiffResolvedReviewEndpointSchema,
  mergeBaseCommitHash: workspaceDiffCommitHashSchema.optional(),
  fingerprint: workspaceDiffFingerprintSchema,
});
export type WorkspaceDiffResolvedReviewIdentity = z.infer<
  typeof workspaceDiffResolvedReviewIdentitySchema
>;

export const workspaceDiffReviewIdentityRequestSchema = z.strictObject({
  comparisonId: workspaceDiffComparisonIdSchema,
  fingerprint: workspaceDiffFingerprintSchema,
});
export type WorkspaceDiffReviewIdentityRequest = z.infer<
  typeof workspaceDiffReviewIdentityRequestSchema
>;

export const workspaceDiffReviewIdentityResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("available"),
      identity: workspaceDiffResolvedReviewIdentitySchema,
    }),
    staleResultSchema,
    unavailableResultSchema,
  ],
);
export type WorkspaceDiffReviewIdentityResult = z.infer<
  typeof workspaceDiffReviewIdentityResultSchema
>;

export const workspaceDiffReviewAnchorRequestSchema = z
  .strictObject({
    ...workspaceDiffFileContentRequestSchema.shape,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((anchor) => anchor.startLine <= anchor.endLine, {
    path: ["endLine"],
    message: "The review anchor end line must not precede its start line.",
  })
  .refine(
    (anchor) =>
      anchor.endLine - anchor.startLine + 1 <=
      WORKSPACE_DIFF_MAX_REVIEW_SELECTION_LINES,
    {
      path: ["endLine"],
      message: "The review anchor selected too many lines.",
    },
  );
export type WorkspaceDiffReviewAnchorRequest = z.infer<
  typeof workspaceDiffReviewAnchorRequestSchema
>;

export const workspaceDiffValidatedReviewAnchorSchema = z.strictObject({
  repositoryKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  comparisonFingerprint: workspaceDiffFingerprintSchema,
  /** Stable within this immutable comparison, never command authority. */
  reviewFileIdentity: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  side: workspaceDiffFileSideSchema,
  oldPath: workspaceFilePathSchema.optional(),
  newPath: workspaceFilePathSchema.optional(),
  oldContentId: z.string().min(1).max(128).nullable(),
  newContentId: z.string().min(1).max(128).nullable(),
  selectedText: z.string().refine((value) =>
    hasAtMostBytes(value, WORKSPACE_DIFF_MAX_REVIEW_SELECTION_BYTES),
  ),
  selectedTextSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  hunkFingerprint: workspaceDiffFingerprintSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
}).superRefine((anchor, context) => {
  if (anchor.oldPath === undefined && anchor.newPath === undefined) {
    context.addIssue({ code: "custom", message: "A review anchor must retain at least one canonical display path." });
  }
  if ((anchor.side === "old" ? anchor.oldContentId : anchor.newContentId) === null) {
    context.addIssue({ code: "custom", message: "The selected review side must have exact content identity." });
  }
});
export type WorkspaceDiffValidatedReviewAnchor = z.infer<
  typeof workspaceDiffValidatedReviewAnchorSchema
>;

export const workspaceDiffReviewAnchorResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("available"),
      anchor: workspaceDiffValidatedReviewAnchorSchema,
    }),
    z.strictObject({ status: z.literal("binary") }),
    z.strictObject({ status: z.literal("absent") }),
    z.strictObject({ status: z.literal("line_unavailable") }),
    z.strictObject({
      status: z.literal("too_large"),
      sizeBytes: z.number().int().nonnegative(),
      maximumBytes: z.literal(WORKSPACE_DIFF_MAX_SIDE_BYTES),
    }),
    staleResultSchema,
    unavailableResultSchema,
  ],
);
export type WorkspaceDiffReviewAnchorResult = z.infer<
  typeof workspaceDiffReviewAnchorResultSchema
>;

export const workspaceDiffReviewedFileRequestSchema = workspaceDiffFileRequestSchema;
export type WorkspaceDiffReviewedFileRequest = z.infer<
  typeof workspaceDiffReviewedFileRequestSchema
>;

export const workspaceDiffValidatedReviewedFileSchema = z.strictObject({
  repositoryKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  comparisonFingerprint: workspaceDiffFingerprintSchema,
  reviewFileIdentity: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u),
  path: workspaceFilePathSchema,
  contentFingerprint: workspaceDiffFingerprintSchema,
  binary: z.boolean(),
  eligible: z.literal(true),
});
export type WorkspaceDiffValidatedReviewedFile = z.infer<
  typeof workspaceDiffValidatedReviewedFileSchema
>;

export const workspaceDiffReviewedFileResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("available"),
      file: workspaceDiffValidatedReviewedFileSchema,
    }),
    staleResultSchema,
    unavailableResultSchema,
  ],
);
export type WorkspaceDiffReviewedFileResult = z.infer<
  typeof workspaceDiffReviewedFileResultSchema
>;

export const workspaceDiffReviewRepositoryIdentityRequestSchema = z.strictObject({
  repositoryId: workspaceDiffRepositoryIdSchema,
});
export type WorkspaceDiffReviewRepositoryIdentityRequest = z.infer<
  typeof workspaceDiffReviewRepositoryIdentityRequestSchema
>;

export const workspaceDiffReviewRepositoryIdentityResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("available"),
      repositoryKey: z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/u),
    }),
    unavailableResultSchema,
  ],
);
export type WorkspaceDiffReviewRepositoryIdentityResult = z.infer<
  typeof workspaceDiffReviewRepositoryIdentityResultSchema
>;
