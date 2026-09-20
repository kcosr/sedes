import { z } from "zod";
import {
  WORKSPACE_FILE_MAX_BASE64_CONTENT_CHARACTERS,
  WORKSPACE_FILE_MAX_CONTENT_BYTES,
  WORKSPACE_FILE_MAX_DOWNLOAD_BYTES,
  WORKSPACE_FILE_MAX_PAGE_SIZE,
  WORKSPACE_FILE_MAX_PATH_BYTES,
  WORKSPACE_FILE_MAX_LINKED_WORKTREES,
} from "../../shared/workspace-file-limits.js";
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
  workspaceDiffReviewAnchorResultSchema,
  workspaceDiffReviewIdentityRequestSchema,
  workspaceDiffReviewIdentityResultSchema,
  workspaceDiffReviewedFileRequestSchema,
  workspaceDiffReviewedFileResultSchema,
  workspaceDiffReviewRepositoryIdentityRequestSchema,
  workspaceDiffReviewRepositoryIdentityResultSchema,
} from "../../shared/protocol/workspace-diffs.js";
import {
  workspaceFileDirectoryEntrySchema,
  workspaceFileDirectoryPathSchema,
  workspaceFileRootIdSchema,
} from "../../shared/protocol/workspace-files.js";
import { WORKSPACE_DIFF_MAX_REVIEW_SELECTION_LINES } from "../../shared/workspace-diff-limits.js";
import {
  SidecarOperationRegistry,
  defineSidecarOperation,
  type SidecarOperationContext,
} from "./operation-registry.js";

export const WORKSPACE_FILES_CAPABILITY_ID = "workspace_files" as const;
export const WORKSPACE_FILES_MAJOR_VERSION = 5 as const;
export const WORKSPACE_FILES_MAX_POLICY_ROOTS = 16 as const;
const rootHandleSchema = z.string().uuid();
const subscriptionHandleSchema = z.string().uuid();
const downloadStreamIdSchema = z.string().uuid();
const revisionSchema = z.string().min(1).max(160);
const relativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= WORKSPACE_FILE_MAX_PATH_BYTES &&
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "sidecar_workspace_file_relative_path_invalid",
  );
const absolutePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= WORKSPACE_FILE_MAX_PATH_BYTES &&
      !/[\u0000-\u001f\u007f\\]/u.test(value) &&
      value.startsWith("/") &&
      (value === "/" ||
        (!value.endsWith("/") &&
          value === value.replace(/\/+/gu, "/") &&
          value
            .slice(1)
            .split("/")
            .every(
              (segment) =>
                segment !== "" && segment !== "." && segment !== "..",
            ))),
    "sidecar_workspace_file_absolute_path_invalid",
  );

const engineContentCommon = {
  path: relativePathSchema,
  sizeBytes: z.number().int().nonnegative(),
  revision: revisionSchema,
} as const;
const truncationSchema = z.strictObject({
  retainedBytes: z.number().int().nonnegative(),
  reason: z.literal("byte_limit"),
});
const textReadResultSchema = z.strictObject({
  ...engineContentCommon,
  contentKind: z.literal("text"),
  content: z
    .string()
    .refine(
      (value) =>
        Buffer.byteLength(value, "utf8") <= WORKSPACE_FILE_MAX_CONTENT_BYTES,
    ),
  editable: z.boolean(),
  truncation: truncationSchema.optional(),
});
const binaryReadResultSchema = z.strictObject({
  ...engineContentCommon,
  contentKind: z.literal("binary"),
  editable: z.literal(false),
  truncation: truncationSchema.optional(),
});
const imageReadResultSchema = z.discriminatedUnion("previewState", [
  z.strictObject({
    ...engineContentCommon,
    contentKind: z.literal("image"),
    previewState: z.literal("available"),
    mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    contentBase64: z
      .string()
      .min(1)
      .max(WORKSPACE_FILE_MAX_BASE64_CONTENT_CHARACTERS),
    editable: z.literal(false),
  }),
  z.strictObject({
    ...engineContentCommon,
    contentKind: z.literal("image"),
    previewState: z.literal("too_large"),
    mediaType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    editable: z.literal(false),
  }),
]);
const readResultSchema = z.union([
  textReadResultSchema,
  binaryReadResultSchema,
  imageReadResultSchema,
]);

const definition = <Request, Response>(input: {
  readonly operation: string;
  readonly requestSchema: z.ZodType<Request>;
  readonly responseSchema: z.ZodType<Response>;
  readonly maximumDeadlineMilliseconds?: number;
}) =>
  defineSidecarOperation({
    capabilityId: WORKSPACE_FILES_CAPABILITY_ID,
    majorVersion: WORKSPACE_FILES_MAJOR_VERSION,
    operation: input.operation,
    lane: "operation" as const,
    maximumDeadlineMilliseconds: input.maximumDeadlineMilliseconds ?? 30_000,
    requestSchema: input.requestSchema,
    responseSchema: input.responseSchema,
  });

export const workspaceFilesRootOpenOperation = definition({
  operation: "root.open",
  requestSchema: z.strictObject({
    admissionId: z.string().uuid(),
    rootId: workspaceFileRootIdSchema,
    rootKind: z.enum([
      "primary",
      "supplemental",
      "linked_worktree",
      "link_only",
    ]),
    declaredPath: absolutePathSchema,
    policyRootPath: absolutePathSchema,
  }),
  responseSchema: z.strictObject({ rootHandle: rootHandleSchema }),
});

export const workspaceFilesRootValidateOperation = definition({
  operation: "root.validate",
  requestSchema: z.strictObject({
    rootKind: z.enum([
      "primary",
      "supplemental",
      "linked_worktree",
      "link_only",
    ]),
    declaredPath: absolutePathSchema,
    policyRootPath: absolutePathSchema,
  }),
  responseSchema: z.strictObject({ validated: z.literal(true) }),
});

export const workspaceFilesRootCloseOperation = definition({
  operation: "root.close",
  requestSchema: z.strictObject({ rootHandle: rootHandleSchema }),
  responseSchema: z.strictObject({ closed: z.literal(true) }),
});

export const workspaceFilesListOperation = definition({
  operation: "files.list",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    cursor: z.string().uuid().optional(),
    pageSize: z.number().int().min(1).max(WORKSPACE_FILE_MAX_PAGE_SIZE),
  }),
  responseSchema: z.strictObject({
    entries: z.array(relativePathSchema).max(WORKSPACE_FILE_MAX_PAGE_SIZE),
    nextCursor: z.string().uuid().optional(),
    scanTruncated: z.boolean(),
  }),
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesListDirectoryOperation = definition({
  operation: "files.list_directory",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    directory: workspaceFileDirectoryPathSchema,
    cursor: z.string().uuid().optional(),
    pageSize: z.number().int().min(1).max(WORKSPACE_FILE_MAX_PAGE_SIZE),
  }),
  responseSchema: z.strictObject({
    directory: workspaceFileDirectoryPathSchema,
    entries: z
      .array(workspaceFileDirectoryEntrySchema)
      .max(WORKSPACE_FILE_MAX_PAGE_SIZE),
    nextCursor: z.string().uuid().optional(),
    scanTruncated: z.boolean(),
  }),
  maximumDeadlineMilliseconds: 30_000,
});

export const workspaceFilesReadOperation = definition({
  operation: "files.read",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    path: relativePathSchema,
  }),
  responseSchema: readResultSchema,
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesDownloadStartOperation = definition({
  operation: "files.download_start",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    path: relativePathSchema,
    expectedRevision: revisionSchema,
    streamId: downloadStreamIdSchema,
    initialCreditBytes: z
      .number()
      .int()
      .min(1)
      .max(16 * 1024 * 1024),
  }),
  responseSchema: z.strictObject({
    path: relativePathSchema,
    fileName: z
      .string()
      .min(1)
      .max(255)
      .refine(
        (value) =>
          !/[\\/\u0000-\u001f\u007f]/u.test(value) &&
          value !== "." &&
          value !== "..",
        "sidecar_workspace_file_download_name_invalid",
      ),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(WORKSPACE_FILE_MAX_DOWNLOAD_BYTES),
    revision: revisionSchema,
  }),
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesDownloadCancelOperation = definition({
  operation: "files.download_cancel",
  requestSchema: z.strictObject({ streamId: downloadStreamIdSchema }),
  responseSchema: z.strictObject({ cancelled: z.literal(true) }),
});

export const workspaceFilesDownloadTerminalSchema = z.discriminatedUnion(
  "outcome",
  [
    z.strictObject({
      outcome: z.literal("complete"),
      sizeBytes: z
        .number()
        .int()
        .nonnegative()
        .max(WORKSPACE_FILE_MAX_DOWNLOAD_BYTES),
      revision: revisionSchema,
    }),
    z.strictObject({
      outcome: z.literal("error"),
      code: z.enum([
        "workspace_file_not_found",
        "workspace_file_revision_conflict",
        "workspace_file_download_too_large",
        "workspace_file_download_failed",
        "workspace_file_download_cancelled",
      ]),
    }),
  ],
);

export type WorkspaceFilesDownloadTerminal = z.infer<
  typeof workspaceFilesDownloadTerminalSchema
>;

export const workspaceFilesWriteOperation = definition({
  operation: "files.write",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    path: relativePathSchema,
    content: z
      .string()
      .refine(
        (value) =>
          Buffer.byteLength(value, "utf8") <= WORKSPACE_FILE_MAX_CONTENT_BYTES,
      ),
    expectedRevision: revisionSchema,
  }),
  responseSchema: z.strictObject({
    path: relativePathSchema,
    sizeBytes: z.number().int().nonnegative(),
    revision: revisionSchema,
  }),
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesStatusOperation = definition({
  operation: "files.status",
  requestSchema: z.strictObject({ rootHandle: rootHandleSchema }),
  responseSchema: z.strictObject({
    isGitRepository: z.boolean(),
    entries: z
      .array(
        z.strictObject({
          path: relativePathSchema,
          status: z.enum([
            "modified",
            "added",
            "deleted",
            "renamed",
            "untracked",
            "conflicted",
          ]),
        }),
      )
      .max(WORKSPACE_FILE_MAX_PAGE_SIZE),
    truncated: z.boolean(),
  }),
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesResolveLinkOperation = definition({
  operation: "files.resolve_link",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    reference: z.discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("absolute"), path: absolutePathSchema }),
      z.strictObject({
        kind: z.literal("workspace_relative"),
        path: relativePathSchema,
      }),
    ]),
  }),
  responseSchema: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("resolved"), path: relativePathSchema }),
    z.strictObject({ status: z.literal("not_found") }),
  ]),
});

export const workspaceFilesDiscoverLinkRootOperation = definition({
  operation: "files.discover_link_root",
  requestSchema: z.strictObject({
    absolutePath: absolutePathSchema,
    policyRootPath: absolutePathSchema,
  }),
  responseSchema: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("discovered"),
      declaredRootPath: absolutePathSchema,
      relativePath: relativePathSchema,
    }),
    z.strictObject({ status: z.literal("not_found") }),
  ]),
});

export const workspaceFilesDiscoverLinkedWorktreesOperation = definition({
  operation: "worktrees.discover",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    policyRootPaths: z
      .array(absolutePathSchema)
      .min(1)
      .max(WORKSPACE_FILES_MAX_POLICY_ROOTS),
  }),
  responseSchema: z.strictObject({
    worktrees: z
      .array(
        z.strictObject({
          canonicalPath: absolutePathSchema,
          canonicalGitDir: absolutePathSchema,
          identityToken: z.string().regex(/^[0-9a-f]{64}$/u),
          displayLabel: z
            .string()
            .min(1)
            .max(240)
            .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
          branchRef: z
            .string()
            .min(1)
            .max(1024)
            .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value))
            .nullable(),
          headOid: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u),
        }),
      )
      .max(WORKSPACE_FILE_MAX_LINKED_WORKTREES),
    truncated: z.boolean(),
  }),
  maximumDeadlineMilliseconds: 30_000,
});

export const workspaceFilesWatchOpenOperation = definition({
  operation: "files.watch_open",
  requestSchema: z.strictObject({ rootHandle: rootHandleSchema }),
  responseSchema: z.strictObject({
    subscriptionHandle: subscriptionHandleSchema,
  }),
});

export const workspaceFilesWatchCloseOperation = definition({
  operation: "files.watch_close",
  requestSchema: z.strictObject({
    subscriptionHandle: subscriptionHandleSchema,
  }),
  responseSchema: z.strictObject({ closed: z.literal(true) }),
});

export const workspaceFilesInvalidatedEventSchema = z.strictObject({
  subscriptionHandle: subscriptionHandleSchema,
});

/** Path-free terminal notice: this handle will emit no further invalidations. */
export const workspaceFilesWatchFailedEventSchema = z.strictObject({
  subscriptionHandle: subscriptionHandleSchema,
});

export const workspaceFilesDiffRepositoriesOperation = definition({
  operation: "diff.repositories",
  requestSchema: z.strictObject({ rootHandle: rootHandleSchema }),
  responseSchema: workspaceDiffRepositoriesResultSchema,
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesDiffRefCatalogOperation = definition({
  operation: "diff.refs",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    ...workspaceDiffRefCatalogQuerySchema.shape,
  }),
  responseSchema: workspaceDiffRefCatalogResultSchema,
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesDiffCreateComparisonOperation = definition({
  operation: "diff.create",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    ...workspaceDiffComparisonCreateRequestSchema.shape,
  }),
  responseSchema: workspaceDiffComparisonCreateResultSchema,
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesDiffChangedFilesOperation = definition({
  operation: "diff.files",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    ...workspaceDiffChangedFilesQuerySchema.shape,
  }),
  responseSchema: workspaceDiffChangedFilesResultSchema,
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesDiffPatchOperation = definition({
  operation: "diff.patch",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    ...workspaceDiffFileRequestSchema.shape,
  }),
  responseSchema: workspaceDiffPatchResultSchema,
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesDiffFileContentOperation = definition({
  operation: "diff.file_content",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    ...workspaceDiffFileContentRequestSchema.shape,
  }),
  responseSchema: workspaceDiffFileContentResultSchema,
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesDiffReviewIdentityOperation = definition({
  operation: "diff.review_identity",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    ...workspaceDiffReviewIdentityRequestSchema.shape,
  }),
  responseSchema: workspaceDiffReviewIdentityResultSchema,
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesDiffValidateReviewAnchorOperation = definition({
  operation: "diff.validate_review_anchor",
  requestSchema: z
    .strictObject({
      rootHandle: rootHandleSchema,
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
    ),
  responseSchema: workspaceDiffReviewAnchorResultSchema,
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesDiffValidateReviewedFileOperation = definition({
  operation: "diff.validate_reviewed_file",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    ...workspaceDiffReviewedFileRequestSchema.shape,
  }),
  responseSchema: workspaceDiffReviewedFileResultSchema,
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesDiffReviewRepositoryIdentityOperation = definition({
  operation: "diff.review_repository_identity",
  requestSchema: z.strictObject({
    rootHandle: rootHandleSchema,
    ...workspaceDiffReviewRepositoryIdentityRequestSchema.shape,
  }),
  responseSchema: workspaceDiffReviewRepositoryIdentityResultSchema,
  maximumDeadlineMilliseconds: 60_000,
});

export const workspaceFilesV5Operations = Object.freeze([
  workspaceFilesRootOpenOperation,
  workspaceFilesRootValidateOperation,
  workspaceFilesRootCloseOperation,
  workspaceFilesListOperation,
  workspaceFilesListDirectoryOperation,
  workspaceFilesReadOperation,
  workspaceFilesDownloadStartOperation,
  workspaceFilesDownloadCancelOperation,
  workspaceFilesWriteOperation,
  workspaceFilesStatusOperation,
  workspaceFilesResolveLinkOperation,
  workspaceFilesDiscoverLinkRootOperation,
  workspaceFilesDiscoverLinkedWorktreesOperation,
  workspaceFilesWatchOpenOperation,
  workspaceFilesWatchCloseOperation,
  workspaceFilesDiffRepositoriesOperation,
  workspaceFilesDiffRefCatalogOperation,
  workspaceFilesDiffCreateComparisonOperation,
  workspaceFilesDiffChangedFilesOperation,
  workspaceFilesDiffPatchOperation,
  workspaceFilesDiffFileContentOperation,
  workspaceFilesDiffReviewIdentityOperation,
  workspaceFilesDiffValidateReviewAnchorOperation,
  workspaceFilesDiffValidateReviewedFileOperation,
  workspaceFilesDiffReviewRepositoryIdentityOperation,
]);

type HandlerFor<Definition> = Definition extends {
  requestSchema: z.ZodType<infer Request>;
  responseSchema: z.ZodType<infer Response>;
}
  ? (
      request: Request,
      context: SidecarOperationContext,
    ) => Promise<Response> | Response
  : never;

export interface WorkspaceFilesV5Handlers {
  readonly rootValidate: HandlerFor<typeof workspaceFilesRootValidateOperation>;
  readonly rootOpen: HandlerFor<typeof workspaceFilesRootOpenOperation>;
  readonly rootClose: HandlerFor<typeof workspaceFilesRootCloseOperation>;
  readonly list: HandlerFor<typeof workspaceFilesListOperation>;
  readonly listDirectory: HandlerFor<
    typeof workspaceFilesListDirectoryOperation
  >;
  readonly read: HandlerFor<typeof workspaceFilesReadOperation>;
  readonly downloadStart: HandlerFor<
    typeof workspaceFilesDownloadStartOperation
  >;
  readonly downloadCancel: HandlerFor<
    typeof workspaceFilesDownloadCancelOperation
  >;
  readonly write: HandlerFor<typeof workspaceFilesWriteOperation>;
  readonly status: HandlerFor<typeof workspaceFilesStatusOperation>;
  readonly resolveLink: HandlerFor<typeof workspaceFilesResolveLinkOperation>;
  readonly discoverLinkRoot: HandlerFor<
    typeof workspaceFilesDiscoverLinkRootOperation
  >;
  readonly discoverLinkedWorktrees: HandlerFor<
    typeof workspaceFilesDiscoverLinkedWorktreesOperation
  >;
  readonly watchOpen: HandlerFor<typeof workspaceFilesWatchOpenOperation>;
  readonly watchClose: HandlerFor<typeof workspaceFilesWatchCloseOperation>;
  readonly diffRepositories: HandlerFor<
    typeof workspaceFilesDiffRepositoriesOperation
  >;
  readonly diffRefCatalog: HandlerFor<
    typeof workspaceFilesDiffRefCatalogOperation
  >;
  readonly diffCreateComparison: HandlerFor<
    typeof workspaceFilesDiffCreateComparisonOperation
  >;
  readonly diffChangedFiles: HandlerFor<
    typeof workspaceFilesDiffChangedFilesOperation
  >;
  readonly diffPatch: HandlerFor<typeof workspaceFilesDiffPatchOperation>;
  readonly diffFileContent: HandlerFor<
    typeof workspaceFilesDiffFileContentOperation
  >;
  readonly diffReviewIdentity: HandlerFor<
    typeof workspaceFilesDiffReviewIdentityOperation
  >;
  readonly diffValidateReviewAnchor: HandlerFor<
    typeof workspaceFilesDiffValidateReviewAnchorOperation
  >;
  readonly diffValidateReviewedFile: HandlerFor<
    typeof workspaceFilesDiffValidateReviewedFileOperation
  >;
  readonly diffReviewRepositoryIdentity: HandlerFor<
    typeof workspaceFilesDiffReviewRepositoryIdentityOperation
  >;
}

export function registerWorkspaceFilesV5Operations(
  registry: SidecarOperationRegistry,
  handlers: WorkspaceFilesV5Handlers,
): void {
  registry.register(workspaceFilesRootValidateOperation, handlers.rootValidate);
  registry.register(workspaceFilesRootOpenOperation, handlers.rootOpen);
  registry.register(workspaceFilesRootCloseOperation, handlers.rootClose);
  registry.register(workspaceFilesListOperation, handlers.list);
  registry.register(
    workspaceFilesListDirectoryOperation,
    handlers.listDirectory,
  );
  registry.register(workspaceFilesReadOperation, handlers.read);
  registry.register(
    workspaceFilesDownloadStartOperation,
    handlers.downloadStart,
  );
  registry.register(
    workspaceFilesDownloadCancelOperation,
    handlers.downloadCancel,
  );
  registry.register(workspaceFilesWriteOperation, handlers.write);
  registry.register(workspaceFilesStatusOperation, handlers.status);
  registry.register(workspaceFilesResolveLinkOperation, handlers.resolveLink);
  registry.register(
    workspaceFilesDiscoverLinkRootOperation,
    handlers.discoverLinkRoot,
  );
  registry.register(
    workspaceFilesDiscoverLinkedWorktreesOperation,
    handlers.discoverLinkedWorktrees,
  );
  registry.register(workspaceFilesWatchOpenOperation, handlers.watchOpen);
  registry.register(workspaceFilesWatchCloseOperation, handlers.watchClose);
  registry.register(
    workspaceFilesDiffRepositoriesOperation,
    handlers.diffRepositories,
  );
  registry.register(
    workspaceFilesDiffRefCatalogOperation,
    handlers.diffRefCatalog,
  );
  registry.register(
    workspaceFilesDiffCreateComparisonOperation,
    handlers.diffCreateComparison,
  );
  registry.register(
    workspaceFilesDiffChangedFilesOperation,
    handlers.diffChangedFiles,
  );
  registry.register(workspaceFilesDiffPatchOperation, handlers.diffPatch);
  registry.register(
    workspaceFilesDiffFileContentOperation,
    handlers.diffFileContent,
  );
  registry.register(
    workspaceFilesDiffReviewIdentityOperation,
    handlers.diffReviewIdentity,
  );
  registry.register(
    workspaceFilesDiffValidateReviewAnchorOperation,
    handlers.diffValidateReviewAnchor,
  );
  registry.register(
    workspaceFilesDiffValidateReviewedFileOperation,
    handlers.diffValidateReviewedFile,
  );
  registry.register(
    workspaceFilesDiffReviewRepositoryIdentityOperation,
    handlers.diffReviewRepositoryIdentity,
  );
}
