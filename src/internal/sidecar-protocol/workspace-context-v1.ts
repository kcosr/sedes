import { z } from "zod";
import {
  SidecarOperationRegistry,
  defineSidecarOperation,
  type SidecarOperationContext,
} from "./operation-registry.js";
import {
  workspaceToolsAbsolutePathSchema,
  workspaceToolsRelativePathSchema,
} from "./workspace-tools-v2.js";

export const WORKSPACE_CONTEXT_CAPABILITY_ID = "workspace_context" as const;
export const WORKSPACE_CONTEXT_MAJOR_VERSION = 1 as const;
export const WORKSPACE_CONTEXT_MAXIMUM_FILE_BYTES = 64 * 1024;
export const WORKSPACE_CONTEXT_MAXIMUM_AGGREGATE_BYTES = 256 * 1024;
export const WORKSPACE_CONTEXT_MAXIMUM_FILES = 64;
export const WORKSPACE_CONTEXT_MAXIMUM_DEPTH = 64;
export const WORKSPACE_CONTEXT_FILENAMES = Object.freeze([
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const);
export const WORKSPACE_CONTEXT_V1_LIMITS = Object.freeze({
  maximumFileBytes: WORKSPACE_CONTEXT_MAXIMUM_FILE_BYTES,
  maximumAggregateBytes: WORKSPACE_CONTEXT_MAXIMUM_AGGREGATE_BYTES,
  maximumFiles: WORKSPACE_CONTEXT_MAXIMUM_FILES,
  maximumDepth: WORKSPACE_CONTEXT_MAXIMUM_DEPTH,
});

export const workspaceContextV1ErrorCodeSchema = z.enum([
  "workspace_context_unavailable",
  "workspace_context_workspace_invalid",
  "workspace_context_workspace_outside_policy",
  "workspace_context_path_unstable",
  "workspace_context_limit_exceeded",
  "workspace_context_read_failed",
  "workspace_context_cancelled",
]);
export type WorkspaceContextV1ErrorCode = z.infer<
  typeof workspaceContextV1ErrorCodeSchema
>;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

export const workspaceContextReadOperation = defineSidecarOperation({
  capabilityId: WORKSPACE_CONTEXT_CAPABILITY_ID,
  majorVersion: WORKSPACE_CONTEXT_MAJOR_VERSION,
  operation: "context.read",
  lane: "operation",
  maximumDeadlineMilliseconds: 30_000,
  requestSchema: z.strictObject({
    admissionId: z.string().uuid(),
    declaredPath: workspaceToolsAbsolutePathSchema,
    policyRootPath: workspaceToolsAbsolutePathSchema,
  }),
  responseSchema: z.strictObject({
    files: z
      .array(
        z
          .strictObject({
            policyRelativePath: workspaceToolsRelativePathSchema,
            content: z
              .string()
              .refine(
                (value) =>
                  Buffer.byteLength(value, "utf8") <=
                  WORKSPACE_CONTEXT_MAXIMUM_FILE_BYTES,
              ),
            sizeBytes: z
              .number()
              .int()
              .nonnegative()
              .max(WORKSPACE_CONTEXT_MAXIMUM_FILE_BYTES),
            sha256: sha256Schema,
          })
          .refine(
            (file) =>
              Buffer.byteLength(file.content, "utf8") === file.sizeBytes,
            "workspace_context_size_mismatch",
          ),
      )
      .max(WORKSPACE_CONTEXT_MAXIMUM_FILES)
      .superRefine((files, context) => {
        const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
        if (total > WORKSPACE_CONTEXT_MAXIMUM_AGGREGATE_BYTES) {
          context.addIssue({
            code: "custom",
            message: "workspace_context_aggregate_too_large",
          });
        }
      }),
    fingerprint: sha256Schema,
  }),
});

export const workspaceContextV1Operations = Object.freeze([
  workspaceContextReadOperation,
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

export interface WorkspaceContextV1Handlers {
  readonly readContext: HandlerFor<typeof workspaceContextReadOperation>;
}

export type WorkspaceContextReadRequest = z.infer<
  typeof workspaceContextReadOperation.requestSchema
>;
export type WorkspaceContextReadResponse = z.infer<
  typeof workspaceContextReadOperation.responseSchema
>;

export function registerWorkspaceContextV1Operations(
  registry: SidecarOperationRegistry,
  handlers: WorkspaceContextV1Handlers,
): void {
  registry.register(workspaceContextReadOperation, handlers.readContext);
}
