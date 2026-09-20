import { normalizedAbsolutePath } from "../absolute-path.js";
import { z } from "zod";
import { boundedDisplayTextSchema } from "./payload.js";
import {
  mutationIdSchema,
  opaqueIdSchema,
  threadIdSchema,
  workspaceIdSchema,
} from "./domain.js";
import {
  WORKSPACE_FILE_DEFAULT_PAGE_SIZE,
  WORKSPACE_FILE_MAX_BASE64_CONTENT_CHARACTERS,
  WORKSPACE_FILE_MAX_CONTENT_BYTES,
  WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES,
  WORKSPACE_FILE_MAX_LINKED_WORKTREES,
  WORKSPACE_FILE_MAX_PAGE_SIZE,
  WORKSPACE_FILE_MAX_PATH_BYTES,
  WORKSPACE_FILE_MAX_SUPPLEMENTAL_ROOTS,
  WORKSPACE_FILE_PRIMARY_ROOT_ID,
  WORKSPACE_FILE_WRITE_JSON_LIMIT_BYTES,
} from "../workspace-file-limits.js";
export * from "../workspace-file-limits.js";

const hasAtMostPathBytes = (value: string): boolean =>
  new TextEncoder().encode(value).byteLength <= WORKSPACE_FILE_MAX_PATH_BYTES;

export const workspaceFilePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      hasAtMostPathBytes(value) &&
      !value.includes("\0") &&
      !value.includes("\\") &&
      !value.startsWith("/") &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    { message: "Workspace file paths must be normalized relative paths." },
  );
export type WorkspaceFilePath = z.infer<typeof workspaceFilePathSchema>;

export const workspaceFileAbsolutePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) => hasAtMostPathBytes(value) && normalizedAbsolutePath(value),
    {
      message:
        "Workspace file absolute paths must be normalized POSIX or Windows paths.",
    },
  );
export type WorkspaceFileAbsolutePath = z.infer<
  typeof workspaceFileAbsolutePathSchema
>;

const workspaceFileOpaqueRootIdSchema = opaqueIdSchema.refine(
  (rootId) => rootId !== WORKSPACE_FILE_PRIMARY_ROOT_ID,
  { message: "Workspace file root IDs must be opaque." },
);

export const workspaceFileSupplementalRootIdSchema =
  workspaceFileOpaqueRootIdSchema.brand<"WorkspaceFileSupplementalRootId">();
export type WorkspaceFileSupplementalRootId = z.infer<
  typeof workspaceFileSupplementalRootIdSchema
>;

export const workspaceFileLinkedWorktreeRootIdSchema =
  workspaceFileOpaqueRootIdSchema.brand<"WorkspaceFileLinkedWorktreeRootId">();
export type WorkspaceFileLinkedWorktreeRootId = z.infer<
  typeof workspaceFileLinkedWorktreeRootIdSchema
>;

export const workspaceFileRootIdSchema = z.union([
  z.literal(WORKSPACE_FILE_PRIMARY_ROOT_ID),
  workspaceFileOpaqueRootIdSchema,
]);
export type WorkspaceFileRootId = z.infer<typeof workspaceFileRootIdSchema>;

export const workspaceFileRootDisplayLabelSchema = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (label) =>
      label !== "." &&
      label !== ".." &&
      !label.includes("/") &&
      !label.includes("\\") &&
      !/[\u0000-\u001f\u007f]/u.test(label),
    { message: "Workspace file root labels contain unsupported characters." },
  );
export type WorkspaceFileRootDisplayLabel = z.infer<
  typeof workspaceFileRootDisplayLabelSchema
>;

export const workspaceFileRootDescriptorDisplayLabelSchema = z
  .string()
  .min(1)
  .max(240)
  .refine((label) => !/[\u0000-\u001f\u007f]/u.test(label), {
    message:
      "Workspace file root descriptor labels contain control characters.",
  });
export type WorkspaceFileRootDescriptorDisplayLabel = z.infer<
  typeof workspaceFileRootDescriptorDisplayLabelSchema
>;

const workspaceFileRootDescriptorFields = {
  rootId: workspaceFileRootIdSchema,
  displayLabel: workspaceFileRootDescriptorDisplayLabelSchema,
  displayPath: boundedDisplayTextSchema,
  sortOrder: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
} as const;

const workspaceFileAvailableRootFields = {
  ...workspaceFileRootDescriptorFields,
  availability: z.literal("available"),
  watchable: z.boolean(),
} as const;
const workspaceFileUnavailableRootFields = {
  ...workspaceFileRootDescriptorFields,
  availability: z.literal("unavailable"),
  watchable: z.literal(false),
  diagnosticCode: z.string().min(1).max(120),
} as const;
const linkedWorktreeDescriptorFields = {
  branch: z.string().min(1).max(1_024).nullable(),
  head: z.string().regex(/^[0-9a-f]{40,64}$/u),
  provenance: z.strictObject({
    kind: z.enum(["same", "contained", "unmerged", "unknown"]),
    ahead: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    behind: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
  }),
  removal: z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("allowed"),
      displayPath: boundedDisplayTextSchema,
    }),
    z.strictObject({ status: z.literal("forget") }),
    z.strictObject({ status: z.literal("unavailable") }),
  ]),
} as const;

export const workspaceFileRootDescriptorSchema = z
  .union([
    z.strictObject({
      kind: z.literal("primary"),
      ...workspaceFileAvailableRootFields,
    }),
    z.strictObject({
      kind: z.literal("primary"),
      ...workspaceFileUnavailableRootFields,
    }),
    z.strictObject({
      kind: z.literal("supplemental"),
      ...workspaceFileAvailableRootFields,
    }),
    z.strictObject({
      kind: z.literal("supplemental"),
      ...workspaceFileUnavailableRootFields,
    }),
    z.strictObject({
      kind: z.literal("linked_worktree"),
      ...linkedWorktreeDescriptorFields,
      ...workspaceFileAvailableRootFields,
    }),
    z.strictObject({
      kind: z.literal("linked_worktree"),
      ...linkedWorktreeDescriptorFields,
      ...workspaceFileUnavailableRootFields,
    }),
  ])
  .superRefine((root, context) => {
    const primary = root.rootId === WORKSPACE_FILE_PRIMARY_ROOT_ID;
    if (primary !== (root.kind === "primary")) {
      context.addIssue({
        code: "custom",
        message:
          "Only the primary workspace file root may use the primary root ID.",
      });
    }
    if (primary && (root.sortOrder !== 0 || root.revision !== 0)) {
      context.addIssue({
        code: "custom",
        message:
          "The projected primary workspace file root must use revision and sort order zero.",
      });
    }
  });
export type WorkspaceFileRootDescriptor = z.infer<
  typeof workspaceFileRootDescriptorSchema
>;

export const workspaceFileRootsResultSchema = z
  .strictObject({
    roots: z
      .array(workspaceFileRootDescriptorSchema)
      .min(1)
      .max(
        WORKSPACE_FILE_MAX_SUPPLEMENTAL_ROOTS +
          WORKSPACE_FILE_MAX_LINKED_WORKTREES +
          1,
      ),
  })
  .superRefine(({ roots }, context) => {
    if (roots[0]?.rootId !== WORKSPACE_FILE_PRIMARY_ROOT_ID) {
      context.addIssue({
        code: "custom",
        path: ["roots", 0, "rootId"],
        message: "The primary workspace file root must be first.",
      });
    }
    if (new Set(roots.map((root) => root.rootId)).size !== roots.length) {
      context.addIssue({
        code: "custom",
        path: ["roots"],
        message: "Workspace file root IDs must be unique.",
      });
    }
  });
export type WorkspaceFileRootsResult = z.infer<
  typeof workspaceFileRootsResultSchema
>;

export const workspaceFileRootCreateRequestSchema = z.strictObject({
  mutationId: mutationIdSchema,
  path: workspaceFileAbsolutePathSchema,
  displayLabel: workspaceFileRootDisplayLabelSchema.optional(),
});
export type WorkspaceFileRootCreateRequest = z.infer<
  typeof workspaceFileRootCreateRequestSchema
>;

export const workspaceFileRootCreateResultSchema = z
  .strictObject({
    root: workspaceFileRootDescriptorSchema,
  })
  .refine((result) => result.root.kind === "supplemental", {
    message: "A created workspace file root must be supplemental.",
    path: ["root", "kind"],
  });
export type WorkspaceFileRootCreateResult = z.infer<
  typeof workspaceFileRootCreateResultSchema
>;

export const workspaceFileRootDeleteRouteParametersSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
  rootId: workspaceFileSupplementalRootIdSchema,
});

export const workspaceFileRootDeleteRequestSchema = z.strictObject({
  mutationId: mutationIdSchema,
  expectedRevision: z.number().int().nonnegative(),
});
export type WorkspaceFileRootDeleteRequest = z.infer<
  typeof workspaceFileRootDeleteRequestSchema
>;

export const workspaceFileRootDeleteResultSchema = z.strictObject({
  rootId: workspaceFileSupplementalRootIdSchema,
});
export type WorkspaceFileRootDeleteResult = z.infer<
  typeof workspaceFileRootDeleteResultSchema
>;

export const threadPreferredWorktreeUpdateRequestSchema = z.strictObject({
  rootId: workspaceFileLinkedWorktreeRootIdSchema.nullable(),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  mutationId: mutationIdSchema,
});
export type ThreadPreferredWorktreeUpdateRequest = z.infer<
  typeof threadPreferredWorktreeUpdateRequestSchema
>;

export const threadPreferredWorktreePreferenceSchema = z.strictObject({
  rootId: workspaceFileLinkedWorktreeRootIdSchema.nullable(),
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type ThreadPreferredWorktreePreference = z.infer<
  typeof threadPreferredWorktreePreferenceSchema
>;

export const threadPreferredWorktreeUpdateResultSchema = z.strictObject({
  preference: threadPreferredWorktreePreferenceSchema,
});
export type ThreadPreferredWorktreeUpdateResult = z.infer<
  typeof threadPreferredWorktreeUpdateResultSchema
>;

export const workspaceLinkedWorktreeDeleteRouteParametersSchema =
  z.strictObject({
    workspaceId: workspaceIdSchema,
    rootId: workspaceFileLinkedWorktreeRootIdSchema,
  });

export const workspaceLinkedWorktreeDeleteRequestSchema = z.strictObject({
  mutationId: mutationIdSchema,
  expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  confirmation: z.literal(true),
});
export type WorkspaceLinkedWorktreeDeleteRequest = z.infer<
  typeof workspaceLinkedWorktreeDeleteRequestSchema
>;

export const workspaceLinkedWorktreeDeleteResultSchema = z.strictObject({
  rootId: workspaceFileLinkedWorktreeRootIdSchema,
  outcome: z.enum(["removed", "forgotten"]),
  clearedThreadIds: z.array(threadIdSchema).max(10_000),
});
export type WorkspaceLinkedWorktreeDeleteResult = z.infer<
  typeof workspaceLinkedWorktreeDeleteResultSchema
>;

export const workspaceFileRouteParametersSchema = z.strictObject({
  workspaceId: workspaceIdSchema,
});

export const workspaceFileListQuerySchema = z.strictObject({
  rootId: workspaceFileRootIdSchema,
  cursor: opaqueIdSchema.optional(),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(WORKSPACE_FILE_MAX_PAGE_SIZE)
    .default(WORKSPACE_FILE_DEFAULT_PAGE_SIZE),
});
export type WorkspaceFileListQuery = z.infer<
  typeof workspaceFileListQuerySchema
>;

export const workspaceFileDirectoryPathSchema = z.union([
  z.literal(""),
  workspaceFilePathSchema,
]);
export type WorkspaceFileDirectoryPath = z.infer<
  typeof workspaceFileDirectoryPathSchema
>;

export const workspaceFileDirectoryQuerySchema = z.strictObject({
  rootId: workspaceFileRootIdSchema,
  directory: workspaceFileDirectoryPathSchema.default(""),
  cursor: opaqueIdSchema.optional(),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(WORKSPACE_FILE_MAX_PAGE_SIZE)
    .default(WORKSPACE_FILE_DEFAULT_PAGE_SIZE),
});
export type WorkspaceFileDirectoryQuery = z.infer<
  typeof workspaceFileDirectoryQuerySchema
>;

export const workspaceFileDirectoryEntrySchema = z.strictObject({
  path: workspaceFilePathSchema,
  kind: z.enum(["directory", "file"]),
});
export type WorkspaceFileDirectoryEntry = z.infer<
  typeof workspaceFileDirectoryEntrySchema
>;

export const workspaceFileContentQuerySchema = z.strictObject({
  rootId: workspaceFileRootIdSchema,
  path: workspaceFilePathSchema,
});

export const workspaceFileDownloadQuerySchema = z.strictObject({
  rootId: workspaceFileRootIdSchema,
  path: workspaceFilePathSchema,
  expectedRevision: z.string().min(1).max(160),
});
export type WorkspaceFileDownloadQuery = z.infer<
  typeof workspaceFileDownloadQuerySchema
>;

export const workspaceFileUnavailableSchema = z.strictObject({
  availability: z.literal("unavailable"),
  rootId: workspaceFileRootIdSchema,
  diagnosticCode: z.string().min(1).max(120),
});

export const workspaceFileListResultSchema = z.discriminatedUnion(
  "availability",
  [
    z.strictObject({
      availability: z.literal("available"),
      rootId: workspaceFileRootIdSchema,
      entries: z
        .array(workspaceFilePathSchema)
        .max(WORKSPACE_FILE_MAX_PAGE_SIZE),
      nextCursor: opaqueIdSchema.optional(),
      scanTruncated: z.boolean(),
    }),
    workspaceFileUnavailableSchema,
  ],
);
export type WorkspaceFileListResult = z.infer<
  typeof workspaceFileListResultSchema
>;

export const workspaceFileDirectoryResultSchema = z.discriminatedUnion(
  "availability",
  [
    z.strictObject({
      availability: z.literal("available"),
      rootId: workspaceFileRootIdSchema,
      directory: workspaceFileDirectoryPathSchema,
      entries: z
        .array(workspaceFileDirectoryEntrySchema)
        .max(WORKSPACE_FILE_MAX_PAGE_SIZE),
      nextCursor: opaqueIdSchema.optional(),
      scanTruncated: z.boolean(),
    }),
    workspaceFileUnavailableSchema,
  ],
);
export type WorkspaceFileDirectoryResult = z.infer<
  typeof workspaceFileDirectoryResultSchema
>;

const workspaceFileContentCommonFields = {
  availability: z.literal("available"),
  rootId: workspaceFileRootIdSchema,
  path: workspaceFilePathSchema,
  sizeBytes: z.number().int().nonnegative(),
  revision: z.string().min(1).max(160),
} as const;

const workspaceFileTruncationSchema = z.strictObject({
  truncated: z.literal(true),
  retainedBytes: z.number().int().nonnegative(),
  reason: z.literal("byte_limit"),
});

export const workspaceFileImageMediaTypeSchema = z.enum([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
export type WorkspaceFileImageMediaType = z.infer<
  typeof workspaceFileImageMediaTypeSchema
>;

function isBase64Character(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f
  );
}

function isCanonicalPaddedBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const contentLength = value.length - padding;
  for (let index = 0; index < contentLength; index += 1) {
    if (!isBase64Character(value.charCodeAt(index))) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 0x3d) return false;
  }
  return true;
}

const canonicalBase64Schema = z
  .string()
  .min(1)
  .max(WORKSPACE_FILE_MAX_BASE64_CONTENT_CHARACTERS)
  .refine(isCanonicalPaddedBase64, {
    message: "Workspace image content must use canonical padded base64.",
  });

function canonicalBase64DecodedBytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

const workspaceFileTextContentResultSchema = z.strictObject({
  ...workspaceFileContentCommonFields,
  contentKind: z.literal("text"),
  content: z.string(),
  editable: z.boolean(),
  truncation: workspaceFileTruncationSchema.optional(),
});

const workspaceFileBinaryContentResultSchema = z.strictObject({
  ...workspaceFileContentCommonFields,
  contentKind: z.literal("binary"),
  content: z.literal(""),
  editable: z.literal(false),
  truncation: workspaceFileTruncationSchema.optional(),
});

const workspaceFileAvailableImageContentResultSchema = z
  .strictObject({
    ...workspaceFileContentCommonFields,
    contentKind: z.literal("image"),
    previewState: z.literal("available"),
    mediaType: workspaceFileImageMediaTypeSchema,
    contentEncoding: z.literal("base64"),
    content: canonicalBase64Schema,
    editable: z.literal(false),
  })
  .superRefine((image, context) => {
    const decodedBytes = canonicalBase64DecodedBytes(image.content);
    if (
      decodedBytes > WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES ||
      decodedBytes !== image.sizeBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message:
          "Workspace image content must contain the complete bounded file.",
      });
    }
  });

const workspaceFileOversizedImageContentResultSchema = z
  .strictObject({
    ...workspaceFileContentCommonFields,
    contentKind: z.literal("image"),
    previewState: z.literal("too_large"),
    mediaType: workspaceFileImageMediaTypeSchema,
    editable: z.literal(false),
  })
  .refine((image) => image.sizeBytes > WORKSPACE_FILE_MAX_IMAGE_CONTENT_BYTES, {
    path: ["sizeBytes"],
    message: "A too-large workspace image must exceed the preview limit.",
  });

export const workspaceFileContentResultSchema = z.union([
  workspaceFileTextContentResultSchema,
  workspaceFileAvailableImageContentResultSchema,
  workspaceFileOversizedImageContentResultSchema,
  workspaceFileBinaryContentResultSchema,
  workspaceFileUnavailableSchema,
]);
export type WorkspaceFileContentResult = z.infer<
  typeof workspaceFileContentResultSchema
>;

export const workspaceFileWriteRequestSchema = z.strictObject({
  rootId: workspaceFileRootIdSchema,
  path: workspaceFilePathSchema,
  content: z
    .string()
    .refine(
      (value) =>
        new TextEncoder().encode(value).byteLength <=
        WORKSPACE_FILE_MAX_CONTENT_BYTES,
      { message: "Workspace file content exceeded the allowed byte size." },
    ),
  expectedRevision: z.string().min(1).max(160),
});
export type WorkspaceFileWriteRequest = z.infer<
  typeof workspaceFileWriteRequestSchema
>;

export const workspaceFileWriteResultSchema = z.discriminatedUnion(
  "availability",
  [
    z.strictObject({
      availability: z.literal("available"),
      rootId: workspaceFileRootIdSchema,
      path: workspaceFilePathSchema,
      sizeBytes: z.number().int().nonnegative(),
      revision: z.string().min(1).max(160),
    }),
    workspaceFileUnavailableSchema,
  ],
);
export type WorkspaceFileWriteResult = z.infer<
  typeof workspaceFileWriteResultSchema
>;

export const workspaceFileGitStatusKindSchema = z.enum([
  "modified",
  "added",
  "deleted",
  "renamed",
  "untracked",
  "conflicted",
]);
export type WorkspaceFileGitStatusKind = z.infer<
  typeof workspaceFileGitStatusKindSchema
>;

export const workspaceFileRootStatusSchema = z
  .discriminatedUnion("availability", [
    z.strictObject({
      availability: z.literal("available"),
      rootId: workspaceFileRootIdSchema,
      isGitRepository: z.boolean(),
      entries: z
        .array(
          z.strictObject({
            rootId: workspaceFileRootIdSchema,
            path: workspaceFilePathSchema,
            status: workspaceFileGitStatusKindSchema,
          }),
        )
        .max(WORKSPACE_FILE_MAX_PAGE_SIZE),
      truncated: z.boolean(),
    }),
    workspaceFileUnavailableSchema,
  ])
  .superRefine((root, context) => {
    if (
      root.availability === "available" &&
      root.entries.some((entry) => entry.rootId !== root.rootId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Workspace file status entries must match their root.",
      });
    }
  });
export type WorkspaceFileRootStatus = z.infer<
  typeof workspaceFileRootStatusSchema
>;

export const workspaceFileStatusResultSchema = z
  .strictObject({
    roots: z
      .array(workspaceFileRootStatusSchema)
      .min(1)
      .max(
        WORKSPACE_FILE_MAX_SUPPLEMENTAL_ROOTS +
          WORKSPACE_FILE_MAX_LINKED_WORKTREES +
          1,
      ),
  })
  .superRefine(({ roots }, context) => {
    if (roots[0]?.rootId !== WORKSPACE_FILE_PRIMARY_ROOT_ID) {
      context.addIssue({
        code: "custom",
        path: ["roots", 0, "rootId"],
        message: "The primary workspace file root status must be first.",
      });
    }
    if (new Set(roots.map((root) => root.rootId)).size !== roots.length) {
      context.addIssue({
        code: "custom",
        path: ["roots"],
        message: "Workspace file root status IDs must be unique.",
      });
    }
  });
export type WorkspaceFileStatusResult = z.infer<
  typeof workspaceFileStatusResultSchema
>;

export const workspaceFileLinkReferenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("absolute"),
    path: workspaceFileAbsolutePathSchema,
  }),
  z.strictObject({
    kind: z.literal("workspace_relative"),
    path: workspaceFilePathSchema,
  }),
  z.strictObject({
    kind: z.literal("root_relative"),
    rootId: workspaceFileRootIdSchema,
    path: workspaceFilePathSchema,
  }),
]);
export type WorkspaceFileLinkReference = z.infer<
  typeof workspaceFileLinkReferenceSchema
>;

export const workspaceFileLinkResolveRequestSchema = z.strictObject({
  reference: workspaceFileLinkReferenceSchema,
});
export type WorkspaceFileLinkResolveRequest = z.infer<
  typeof workspaceFileLinkResolveRequestSchema
>;

export const workspaceFileRootVisibilitySchema = z.enum([
  "listed",
  "link_only",
]);
export type WorkspaceFileRootVisibility = z.infer<
  typeof workspaceFileRootVisibilitySchema
>;

export const workspaceFileLinkResolveResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("resolved"),
      rootId: workspaceFileRootIdSchema,
      path: workspaceFilePathSchema,
      rootVisibility: workspaceFileRootVisibilitySchema,
    }),
    z.strictObject({ status: z.literal("not_found") }),
  ],
);
export type WorkspaceFileLinkResolveResult = z.infer<
  typeof workspaceFileLinkResolveResultSchema
>;
