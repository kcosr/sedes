import { normalizedAbsolutePath } from "../../shared/absolute-path.js";
import { z } from "zod";
import {
  SidecarOperationRegistry,
  defineSidecarOperation,
  type SidecarOperationContext,
} from "./operation-registry.js";

export const WORKSPACE_TOOLS_CAPABILITY_ID = "workspace_tools" as const;
export const WORKSPACE_TOOLS_MAJOR_VERSION = 2 as const;

export const WORKSPACE_TOOLS_MAXIMUM_PATH_BYTES = 4_096;
export const WORKSPACE_TOOLS_MAXIMUM_TEXT_BYTES = 16 * 1024 * 1024;
export const WORKSPACE_TOOLS_MAXIMUM_READ_BYTES = 50 * 1024;
export const WORKSPACE_TOOLS_MAXIMUM_READ_LINES = 2_000;
export const WORKSPACE_TOOLS_MAXIMUM_IMAGE_BYTES = 10 * 1024 * 1024;
export const WORKSPACE_TOOLS_MAXIMUM_EDITS = 100;
export const WORKSPACE_TOOLS_MAXIMUM_LIST_ENTRIES = 10_000;
export const WORKSPACE_TOOLS_MAXIMUM_FIND_RESULTS = 10_000;
export const WORKSPACE_TOOLS_MAXIMUM_GREP_MATCHES = 10_000;
export const WORKSPACE_TOOLS_MAXIMUM_PATTERN_BYTES = 16 * 1024;
export const WORKSPACE_TOOLS_MAXIMUM_GREP_LINE_CHARACTERS = 500;
export const WORKSPACE_TOOLS_MAXIMUM_SEARCH_OUTPUT_BYTES = 50 * 1024;
export const WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_ENTRIES = 250_000;
export const WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_BYTES = 64 * 1024 * 1024;
export const WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_MILLISECONDS = 30_000;
export const WORKSPACE_TOOLS_V2_LIMITS = Object.freeze({
  maximumPathBytes: WORKSPACE_TOOLS_MAXIMUM_PATH_BYTES,
  maximumTextBytes: WORKSPACE_TOOLS_MAXIMUM_TEXT_BYTES,
  maximumReadBytes: WORKSPACE_TOOLS_MAXIMUM_READ_BYTES,
  maximumReadLines: WORKSPACE_TOOLS_MAXIMUM_READ_LINES,
  maximumImageBytes: WORKSPACE_TOOLS_MAXIMUM_IMAGE_BYTES,
  maximumEdits: WORKSPACE_TOOLS_MAXIMUM_EDITS,
  maximumListEntries: WORKSPACE_TOOLS_MAXIMUM_LIST_ENTRIES,
  maximumFindResults: WORKSPACE_TOOLS_MAXIMUM_FIND_RESULTS,
  maximumGrepMatches: WORKSPACE_TOOLS_MAXIMUM_GREP_MATCHES,
  maximumGrepLineCharacters: WORKSPACE_TOOLS_MAXIMUM_GREP_LINE_CHARACTERS,
  maximumSearchOutputBytes: WORKSPACE_TOOLS_MAXIMUM_SEARCH_OUTPUT_BYTES,
  findScanMaximumEntries: WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_ENTRIES,
  findScanMaximumBytes: WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_BYTES,
  findScanMaximumMilliseconds: WORKSPACE_TOOLS_FIND_SCAN_MAXIMUM_MILLISECONDS,
});

export const workspaceToolsV2ErrorCodeSchema = z.enum([
  "workspace_tools_unavailable",
  "workspace_tools_workspace_invalid",
  "workspace_tools_workspace_outside_policy",
  "workspace_tools_workspace_handle_invalid",
  "workspace_tools_workspace_root_replaced",
  "workspace_tools_path_invalid",
  "workspace_tools_path_outside_workspace",
  "workspace_tools_path_not_found",
  "workspace_tools_path_not_file",
  "workspace_tools_path_not_directory",
  "workspace_tools_path_symlink_denied",
  "workspace_tools_path_unstable",
  "workspace_tools_read_failed",
  "workspace_tools_write_failed",
  "workspace_tools_edit_failed",
  "workspace_tools_edit_no_match",
  "workspace_tools_edit_ambiguous_match",
  "workspace_tools_edit_overlap",
  "workspace_tools_search_failed",
  "workspace_tools_search_budget_exceeded",
  "workspace_tools_search_prerequisite_unavailable",
  "workspace_tools_operation_id_reused",
  "workspace_tools_revision_conflict",
  "workspace_tools_outcome_unknown",
  "workspace_tools_cancelled",
]);
export type WorkspaceToolsV2ErrorCode = z.infer<
  typeof workspaceToolsV2ErrorCodeSchema
>;

export const workspaceToolsAbsolutePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= WORKSPACE_TOOLS_MAXIMUM_PATH_BYTES &&
      normalizedAbsolutePath(value),
    "workspace_tools_absolute_path_invalid",
  );

export const workspaceToolsRelativePathSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= WORKSPACE_TOOLS_MAXIMUM_PATH_BYTES &&
      !/[\u0000-\u001f\u007f\\]/u.test(value) &&
      !value.startsWith("/") &&
      value
        .split("/")
        .every(
          (segment) => segment !== "" && segment !== "." && segment !== "..",
        ),
    "workspace_tools_relative_path_invalid",
  );

const uuidSchema = z.string().uuid();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedTextSchema = z
  .string()
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= WORKSPACE_TOOLS_MAXIMUM_TEXT_BYTES,
    "workspace_tools_text_too_large",
  );
const patternSchema = z
  .string()
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= WORKSPACE_TOOLS_MAXIMUM_PATTERN_BYTES,
    "workspace_tools_pattern_too_large",
  );
const searchLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(WORKSPACE_TOOLS_MAXIMUM_FIND_RESULTS);
const outputTruncationSchema = z.strictObject({
  retainedBytes: z
    .number()
    .int()
    .nonnegative()
    .max(WORKSPACE_TOOLS_MAXIMUM_SEARCH_OUTPUT_BYTES),
  omittedItems: z.number().int().positive(),
  reason: z.enum(["byte_limit", "item_limit"]),
});

const definition = <Request, Response>(input: {
  readonly operation: string;
  readonly requestSchema: z.ZodType<Request>;
  readonly responseSchema: z.ZodType<Response>;
  readonly maximumDeadlineMilliseconds?: number;
}) =>
  defineSidecarOperation({
    capabilityId: WORKSPACE_TOOLS_CAPABILITY_ID,
    majorVersion: WORKSPACE_TOOLS_MAJOR_VERSION,
    operation: input.operation,
    lane: "operation" as const,
    maximumDeadlineMilliseconds: input.maximumDeadlineMilliseconds ?? 60_000,
    requestSchema: input.requestSchema,
    responseSchema: input.responseSchema,
  });

export const workspaceToolsWorkspaceOpenOperation = definition({
  operation: "workspace.open",
  requestSchema: z.strictObject({
    admissionId: uuidSchema,
    declaredPath: workspaceToolsAbsolutePathSchema,
    policyRootPath: workspaceToolsAbsolutePathSchema,
  }),
  responseSchema: z.strictObject({ workspaceHandle: uuidSchema }),
});

export const workspaceToolsWorkspaceCloseOperation = definition({
  operation: "workspace.close",
  requestSchema: z.strictObject({ workspaceHandle: uuidSchema }),
  responseSchema: z.strictObject({ closed: z.literal(true) }),
});

const readTruncationSchema = z.strictObject({
  reason: z.enum(["byte_limit", "line_limit", "requested_limit"]),
  nextOffset: z.number().int().positive(),
  firstLineBytes: z.number().int().positive().optional(),
});

export const workspaceToolsFileReadOperation = definition({
  operation: "file.read",
  requestSchema: z.strictObject({
    workspaceHandle: uuidSchema,
    path: workspaceToolsRelativePathSchema,
    offset: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(1_000_000).optional(),
  }),
  responseSchema: z.discriminatedUnion("contentKind", [
    z.strictObject({
      path: workspaceToolsRelativePathSchema,
      contentKind: z.literal("text"),
      content: z
        .string()
        .refine(
          (value) =>
            Buffer.byteLength(value, "utf8") <=
            WORKSPACE_TOOLS_MAXIMUM_READ_BYTES,
        ),
      sizeBytes: z.number().int().nonnegative(),
      totalLines: z.number().int().positive(),
      startLine: z.number().int().positive(),
      outputLines: z
        .number()
        .int()
        .nonnegative()
        .max(WORKSPACE_TOOLS_MAXIMUM_READ_LINES),
      truncation: readTruncationSchema.optional(),
    }),
    z.strictObject({
      path: workspaceToolsRelativePathSchema,
      contentKind: z.literal("image"),
      mediaType: z.enum([
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
        "image/bmp",
      ]),
      contentBase64: z
        .string()
        .max(Math.ceil(WORKSPACE_TOOLS_MAXIMUM_IMAGE_BYTES / 3) * 4)
        .regex(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
        ),
      sizeBytes: z
        .number()
        .int()
        .nonnegative()
        .max(WORKSPACE_TOOLS_MAXIMUM_IMAGE_BYTES),
    }),
  ]),
});

const mutationResultSchema = z.strictObject({
  path: workspaceToolsRelativePathSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: sha256Schema,
});

export const workspaceToolsFileWriteOperation = definition({
  operation: "file.write",
  requestSchema: z.strictObject({
    workspaceHandle: uuidSchema,
    operationId: uuidSchema,
    path: workspaceToolsRelativePathSchema,
    content: boundedTextSchema,
  }),
  responseSchema: mutationResultSchema,
});

export const workspaceToolsFileEditOperation = definition({
  operation: "file.edit",
  requestSchema: z.strictObject({
    workspaceHandle: uuidSchema,
    operationId: uuidSchema,
    path: workspaceToolsRelativePathSchema,
    edits: z
      .array(
        z.strictObject({
          oldText: boundedTextSchema,
          newText: boundedTextSchema,
        }),
      )
      .min(1)
      .max(WORKSPACE_TOOLS_MAXIMUM_EDITS),
  }),
  responseSchema: mutationResultSchema.extend({
    replacements: z.number().int().min(1).max(WORKSPACE_TOOLS_MAXIMUM_EDITS),
    diff: z.string().max(2 * 1024 * 1024),
    patch: z.string().max(2 * 1024 * 1024),
    firstChangedLine: z.number().int().positive().optional(),
  }),
});

export const workspaceToolsDirectoryListOperation = definition({
  operation: "directory.list",
  requestSchema: z.strictObject({
    workspaceHandle: uuidSchema,
    path: workspaceToolsRelativePathSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(WORKSPACE_TOOLS_MAXIMUM_LIST_ENTRIES)
      .optional(),
  }),
  responseSchema: z.strictObject({
    entries: z
      .array(
        z.strictObject({
          name: z
            .string()
            .min(1)
            .max(255)
            .refine(
              (value) =>
                Buffer.byteLength(value, "utf8") <= 255 &&
                value !== "." &&
                value !== ".." &&
                !/[\/\\\u0000-\u001f\u007f]/u.test(value),
            ),
          kind: z.enum(["file", "directory", "other"]),
        }),
      )
      .max(WORKSPACE_TOOLS_MAXIMUM_LIST_ENTRIES),
    limitReached: z.boolean(),
    outputTruncation: outputTruncationSchema.optional(),
  }),
});

export const workspaceToolsSearchFindOperation = definition({
  operation: "search.find",
  requestSchema: z.strictObject({
    workspaceHandle: uuidSchema,
    pattern: patternSchema,
    path: workspaceToolsRelativePathSchema.optional(),
    limit: searchLimitSchema.optional(),
  }),
  responseSchema: z.strictObject({
    paths: z
      .array(workspaceToolsRelativePathSchema)
      .max(WORKSPACE_TOOLS_MAXIMUM_FIND_RESULTS),
    limitReached: z.boolean(),
    outputTruncation: outputTruncationSchema.optional(),
  }),
  maximumDeadlineMilliseconds: 35_000,
});

export const workspaceToolsSearchGrepOperation = definition({
  operation: "search.grep",
  requestSchema: z.strictObject({
    workspaceHandle: uuidSchema,
    pattern: patternSchema,
    path: workspaceToolsRelativePathSchema.optional(),
    glob: patternSchema.optional(),
    ignoreCase: z.boolean().optional(),
    literal: z.boolean().optional(),
    context: z.number().int().min(0).max(100).optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(WORKSPACE_TOOLS_MAXIMUM_GREP_MATCHES)
      .optional(),
  }),
  responseSchema: z.strictObject({
    matches: z
      .array(
        z.strictObject({
          path: workspaceToolsRelativePathSchema,
          line: z.number().int().positive(),
          column: z.number().int().positive(),
          lineText: z
            .string()
            .max(WORKSPACE_TOOLS_MAXIMUM_GREP_LINE_CHARACTERS + 16),
          lineTruncated: z.boolean(),
          isMatch: z.boolean(),
        }),
      )
      .max(WORKSPACE_TOOLS_MAXIMUM_GREP_MATCHES),
    matchLimitReached: z.boolean(),
    outputTruncation: outputTruncationSchema.optional(),
  }),
  maximumDeadlineMilliseconds: 35_000,
});

export const workspaceToolsMutationListOperation = definition({
  operation: "mutation.list",
  requestSchema: z.strictObject({}),
  responseSchema: z.strictObject({
    operationIds: z.array(z.string().uuid()).max(1024),
  }),
});
export const workspaceToolsMutationInspectOperation = definition({
  operation: "mutation.inspect",
  requestSchema: z.strictObject({ operationId: uuidSchema }),
  responseSchema: z.discriminatedUnion("state", [
    z.strictObject({ state: z.literal("unknown"), settled: z.boolean() }),
    z.strictObject({ state: z.literal("pending") }),
    z.strictObject({
      state: z.literal("failed"),
      code: z.string().min(1).max(120),
    }),
    z.strictObject({
      state: z.literal("succeeded"),
      result: z.union([
        workspaceToolsFileWriteOperation.responseSchema,
        workspaceToolsFileEditOperation.responseSchema,
        z.strictObject({ streamId: uuidSchema, admitted: z.literal(true) }),
      ]),
    }),
  ]),
});
export const workspaceToolsMutationAcknowledgeOperation = definition({
  operation: "mutation.acknowledge",
  requestSchema: z.strictObject({ operationId: uuidSchema }),
  responseSchema: z.strictObject({ acknowledged: z.boolean() }),
});

export const workspaceToolsV2Operations = Object.freeze([
  workspaceToolsMutationListOperation,
  workspaceToolsMutationInspectOperation,
  workspaceToolsMutationAcknowledgeOperation,
  workspaceToolsWorkspaceOpenOperation,
  workspaceToolsWorkspaceCloseOperation,
  workspaceToolsFileReadOperation,
  workspaceToolsFileWriteOperation,
  workspaceToolsFileEditOperation,
  workspaceToolsDirectoryListOperation,
  workspaceToolsSearchFindOperation,
  workspaceToolsSearchGrepOperation,
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

export interface WorkspaceToolsV2Handlers {
  readonly mutationList: HandlerFor<typeof workspaceToolsMutationListOperation>;
  readonly mutationInspect: HandlerFor<
    typeof workspaceToolsMutationInspectOperation
  >;
  readonly mutationAcknowledge: HandlerFor<
    typeof workspaceToolsMutationAcknowledgeOperation
  >;
  readonly openWorkspace: HandlerFor<
    typeof workspaceToolsWorkspaceOpenOperation
  >;
  readonly closeWorkspace: HandlerFor<
    typeof workspaceToolsWorkspaceCloseOperation
  >;
  readonly readFile: HandlerFor<typeof workspaceToolsFileReadOperation>;
  readonly writeFile: HandlerFor<typeof workspaceToolsFileWriteOperation>;
  readonly editFile: HandlerFor<typeof workspaceToolsFileEditOperation>;
  readonly listDirectory: HandlerFor<
    typeof workspaceToolsDirectoryListOperation
  >;
  readonly findFiles: HandlerFor<typeof workspaceToolsSearchFindOperation>;
  readonly grepFiles: HandlerFor<typeof workspaceToolsSearchGrepOperation>;
}

export type WorkspaceToolsWorkspaceOpenRequest = z.infer<
  typeof workspaceToolsWorkspaceOpenOperation.requestSchema
>;
export type WorkspaceToolsWorkspaceOpenResponse = z.infer<
  typeof workspaceToolsWorkspaceOpenOperation.responseSchema
>;
export type WorkspaceToolsFileReadRequest = z.infer<
  typeof workspaceToolsFileReadOperation.requestSchema
>;
export type WorkspaceToolsFileReadResponse = z.infer<
  typeof workspaceToolsFileReadOperation.responseSchema
>;
export type WorkspaceToolsFileWriteRequest = z.infer<
  typeof workspaceToolsFileWriteOperation.requestSchema
>;
export type WorkspaceToolsFileWriteResponse = z.infer<
  typeof workspaceToolsFileWriteOperation.responseSchema
>;
export type WorkspaceToolsFileEditRequest = z.infer<
  typeof workspaceToolsFileEditOperation.requestSchema
>;
export type WorkspaceToolsFileEditResponse = z.infer<
  typeof workspaceToolsFileEditOperation.responseSchema
>;
export type WorkspaceToolsDirectoryListRequest = z.infer<
  typeof workspaceToolsDirectoryListOperation.requestSchema
>;
export type WorkspaceToolsDirectoryListResponse = z.infer<
  typeof workspaceToolsDirectoryListOperation.responseSchema
>;
export type WorkspaceToolsSearchFindRequest = z.infer<
  typeof workspaceToolsSearchFindOperation.requestSchema
>;
export type WorkspaceToolsSearchFindResponse = z.infer<
  typeof workspaceToolsSearchFindOperation.responseSchema
>;
export type WorkspaceToolsSearchGrepRequest = z.infer<
  typeof workspaceToolsSearchGrepOperation.requestSchema
>;
export type WorkspaceToolsSearchGrepResponse = z.infer<
  typeof workspaceToolsSearchGrepOperation.responseSchema
>;
export type WorkspaceToolsGrepMatch =
  WorkspaceToolsSearchGrepResponse["matches"][number];

export function registerWorkspaceToolsV2Operations(
  registry: SidecarOperationRegistry,
  handlers: WorkspaceToolsV2Handlers,
): void {
  registry.register(
    workspaceToolsWorkspaceOpenOperation,
    handlers.openWorkspace,
  );
  registry.register(
    workspaceToolsWorkspaceCloseOperation,
    handlers.closeWorkspace,
  );
  registry.register(workspaceToolsMutationListOperation, handlers.mutationList);
  registry.register(
    workspaceToolsMutationInspectOperation,
    handlers.mutationInspect,
  );
  registry.register(
    workspaceToolsMutationAcknowledgeOperation,
    handlers.mutationAcknowledge,
  );
  registry.register(workspaceToolsFileReadOperation, handlers.readFile);
  registry.register(workspaceToolsFileWriteOperation, handlers.writeFile);
  registry.register(workspaceToolsFileEditOperation, handlers.editFile);
  registry.register(
    workspaceToolsDirectoryListOperation,
    handlers.listDirectory,
  );
  registry.register(workspaceToolsSearchFindOperation, handlers.findFiles);
  registry.register(workspaceToolsSearchGrepOperation, handlers.grepFiles);
}
